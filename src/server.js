import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { JsonStore, buildView, getStateRevision, updateAccountScopedState } from './lib/store.js';
import { PortalStore, getPortalStateRevision } from './lib/portal-store.js';
import { MockProvider } from './providers/mock-provider.js';
import { ZaloWebProvider } from './providers/zalo-web-provider.js';
import { getPortalConfig } from './config/portal.js';
import { buildPortalSessionCookie, buildPortalLogoutCookie, createPortalSessionToken, resolveRequestPrincipal } from './auth/session.js';
import { hasPermission, requirePermission, requireAnyPermission, requireAdminAccess, CONFIGURABLE_PERMISSIONS, getRolePermissions, setRolePermissionsOverride } from './middleware/authorize.js';
import { assertDepartmentAccess, canAccessDepartment, scopeLauncherApps } from './middleware/scope.js';
import { createDbClient } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { buildScopedView, buildPortalSummary, enrichPrincipal, maskChannelSecrets, resolveVisibleAccountIds } from './services/access-service.js';
import { createAuditService } from './services/audit-service.js';
import { createPortalJournalService } from './services/portal-journal-service.js';
import { createPortalSyncService } from './services/portal-sync-service.js';
import { createPortalReadService } from './services/portal-read-service.js';
import { planRouting } from './services/routing-service.js';
import { derivePresenceStatus } from './services/presence-service.js';
import { normalizeAiAutomationConfig, normalizeAiAutomationDepartmentMap, normalizeThreadAutomationState, patchThreadAutomationState, resolveAiAutomationConfigForDepartment } from './services/ai-automation-service.js';
import { createAiAutomationRuntime, getExecutionTrace } from './services/ai-automation-runtime.js';
import { createAiAutomationChannelAdapter } from './services/ai-automation-channel-adapter.js';
import { getAgentSystemDb, initializeAgentSystemDb, listAgents, seedAgentSystemFromConfig, updateAgentInstruction } from './services/agent-system-db.js';
import { isChatbotBridgeAccount } from './services/chatbot-bridge-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
loadEnvFile(path.join(rootDir, '.env'));
const publicDir = path.join(rootDir, 'public');
const dataDir = resolveDataDir();
const port = Number(process.env.PORT || 4310);
const providerName = process.env.PROVIDER || 'mock';
const sessionSecret = process.env.SESSION_SECRET || 'change-me';
const appVersion = process.env.APP_VERSION || detectAppVersion();
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const chiHomeBookingBridgeBaseUrl = String(process.env.CHIHOME_BOOKING_BRIDGE_URL || 'https://tehui.io.vn/bridge/zalo-booking').trim();
const chiHomeBookingBridgeSecret = String(process.env.CHIHOME_BOOKING_BRIDGE_SECRET || '').trim();
const chatbotBridgeSecret = String(process.env.CHATBOT_BRIDGE_SECRET || '').trim();
const portalConfig = getPortalConfig();
const scopedViewBodyCache = new Map();
const SCOPED_VIEW_BODY_CACHE_LIMIT = 64;
const db = createDbClient();
const store = new JsonStore(dataDir);
const portalStore = new PortalStore(dataDir);
const auditService = createAuditService(db);
const agentSystemDb = initializeAgentSystemDb(getAgentSystemDb());
const portalSyncService = createPortalSyncService(db);
const portalJournalService = createPortalJournalService({ db, dataDir });
const portalReadService = createPortalReadService({ db, portalStore, preferredSource: portalConfig.readSource });
applyRolePermissionsConfig();
if (db.enabled) {
  await runMigrations({ db, logger: console });
}
const clients = new Set();
const clientHeartbeats = new Map();
const authSessions = new Map();
let aiAutomationRuntime = null;

const provider = createProvider(providerName, store, emitEvent);
await provider.hydrateInitialState();
for (const config of Object.values(store.read()?.aiAutomationByDepartment || {})) {
  seedAgentSystemFromConfig(config, agentSystemDb);
}
seedAgentSystemFromConfig(store.read()?.aiAutomation || {}, agentSystemDb);
cleanupPortalBindingsAgainstState();

aiAutomationRuntime = createAiAutomationRuntime({
  readAppState: () => store.read(),
  updateAppState: (mutator) => store.update(mutator),
  readPortalState: () => portalStore.read(),
  resolveThreadRecord,
  resolvePortalThreadBinding,
  getDepartmentIdForThread: getAiAutomationDepartmentIdForThread,
  getConfigForDepartment: getAiAutomationConfigForDepartment,
  adapter: createAiAutomationChannelAdapter({
    sendTypingEvent: provider.sendTypingEvent ? provider.sendTypingEvent.bind(provider) : null,
    sendMessage: provider.sendMessage.bind(provider)
  }),
  emitEvent,
  logger: console
});


const COMPAT_DOCS = buildCompatDocs();

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (error) {
    return writeUnhandledError(res, error);
  }
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/auth/status') {
    const principal = getAuthSession(req);
    const setupRequired = isInitialAdminSetupRequired(portalStore.read());
    return json(res, 200, {
      ok: true,
      authEnabled: !setupRequired,
      setupRequired,
      authenticated: Boolean(principal),
      username: principal?.username || null,
      source: principal?.source || null,
      roles: principal?.roles || []
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (isInitialAdminSetupRequired(portalStore.read())) throw new Error('Chưa thiết lập tài khoản quản trị đầu tiên');
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const portalState = portalStore.read();
      const matchedUser = (portalState.users || []).find((item) => String(item.username || item.id || '').trim() === username && item.active !== false);

      if (!matchedUser || !verifyPassword(password, matchedUser.passwordHash || '')) {
        throw new Error('Sai tài khoản hoặc mật khẩu');
      }

      const ssoToken = createPortalSessionToken({
        id: matchedUser.id,
        username: matchedUser.username,
        displayName: matchedUser.displayName || matchedUser.username,
        roles: matchedUser.roles || [],
        permissions: matchedUser.permissions || [],
        departmentIds: matchedUser.departmentIds || [],
        sessionVersion: matchedUser.sessionVersion || 1
      }, { jwtSecret: portalConfig.jwtSecret });
      res.setHeader('Set-Cookie', [
        buildLegacyLogoutCookie(),
        buildPortalSessionCookie(ssoToken, {
          cookieDomain: resolvePortalCookieDomain(req),
          secure: resolvePortalCookieSecure(req),
          sameSite: portalConfig.sameSite
        })
      ]);
      return { ok: true, authenticated: true, username: matchedUser.username, sso: true, roles: matchedUser.roles || [] };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/setup') {
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!isInitialAdminSetupRequired(portalStore.read())) throw new Error('Tài khoản quản trị đã được thiết lập');
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) throw new Error('Tên đăng nhập gồm 3–64 ký tự: chữ, số, dấu chấm, gạch dưới hoặc gạch ngang');
      if (password.length < 10) throw new Error('Mật khẩu phải có ít nhất 10 ký tự');
      const now = new Date().toISOString();
      portalStore.update((state) => {
        state.users = [{ id: username, username, displayName: username, passwordHash: hashPassword(password), roles: ['admin'], departmentIds: ['default'], permissions: ['*'], status: 'online', lastActiveAt: now, lastAssignedAt: null, forceOfflineUntil: null, maxOpenConversations: 20, active: true }];
        state.departments = (state.departments || []).map((department) => department.id === 'default' ? { ...department, managerUserIds: [username] } : department);
        state.updatedAt = now;
        return state;
      });
      const token = createSessionToken(username);
      const ssoToken = createPortalSessionToken({ id: username, username, displayName: username, roles: ['admin'], permissions: ['*'], departmentIds: ['default'] }, { jwtSecret: portalConfig.jwtSecret });
      res.setHeader('Set-Cookie', [buildLegacySessionCookie(token), buildPortalSessionCookie(ssoToken, { cookieDomain: resolvePortalCookieDomain(req), secure: resolvePortalCookieSecure(req), sameSite: portalConfig.sameSite })]);
      return { ok: true, authenticated: true, username, sso: true, roles: ['admin'] };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = readSessionToken(req);
    if (token) authSessions.delete(token);
    clearSessionCookie(res);
    res.setHeader('Set-Cookie', [buildLegacyLogoutCookie(), buildPortalLogoutCookie({ cookieDomain: resolvePortalCookieDomain(req), secure: resolvePortalCookieSecure(req), sameSite: portalConfig.sameSite })]);
    return json(res, 200, { ok: true, authenticated: false });
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, provider: providerName, dataDir });
  }

  if (req.method === 'GET' && url.pathname === '/api/version') {
    return json(res, 200, { ok: true, version: appVersion });
  }

  if (req.method === 'POST' && url.pathname === '/api/chatbot/send') {
    const provided = String(req.headers['x-chatbot-bridge-secret'] || '').trim();
    if (!chatbotBridgeSecret || !provided || !safeEqual(provided, chatbotBridgeSecret)) {
      return json(res, 401, { ok: false, code: 'INVALID_CHATBOT_BRIDGE_SECRET', error: 'Unauthorized' });
    }
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const accountId = String(body.accountId || '').trim();
      const threadId = String(body.threadId || '').trim();
      const text = String(body.text || '').trim();
      if (!accountId) throw new Error('Thiếu accountId');
      if (!threadId) throw new Error('Thiếu threadId');
      if (!text) throw new Error('Tin nhắn trống');
      if (!isChatbotBridgeAccount(accountId)) {
        const error = new Error('Account này không được bật cho chatbot bridge');
        error.statusCode = 403;
        throw error;
      }
      const message = await provider.sendMessage({ accountId, threadId, text });
      return { ok: true, message };
    });
  }


  if (req.method === 'GET' && url.pathname === '/api/agents') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    return json(res, 200, { ok: true, items: listAgents(agentSystemDb) });
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (req.method === 'PUT' && agentMatch) {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => ({
      ok: true,
      item: updateAgentInstruction(decodeURIComponent(agentMatch[1]), body.system_instruction ?? body.systemInstruction ?? body.prompt ?? '', agentSystemDb)
    }));
  }

  const executionTraceMatch = url.pathname.match(/^\/api\/executions\/([^/]+)\/trace$/);
  if (req.method === 'GET' && executionTraceMatch) {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    return json(res, 200, { ok: true, trace: getExecutionTrace(decodeURIComponent(executionTraceMatch[1])) });
  }

  if (req.method === 'GET' && url.pathname === '/api/chihomehotel/booking-bridge') {
    const principal = getRequiredAuth(req);
    const threadId = String(url.searchParams.get('threadId') || '').trim();
    const accountId = String(url.searchParams.get('accountId') || '').trim();
    return handleAction(res, async () => {
      if (!threadId) throw new Error('Thiếu threadId');
      if (!accountId) throw new Error('Thiếu accountId');
      assertThreadAccess(principal, threadId);
      const portalState = portalStore.read();
      const appState = store.read();
      assertAccountAccess(principal, accountId, portalState, appState);
      const channel = findPortalChannelByAccountId(portalState, accountId);
      const department = channel ? findPortalDepartment(portalState, channel.departmentId) : null;
      if (!isChiHomeDepartment(channel, department)) {
        const error = new Error('Account hiện tại không thuộc bộ phận ChiHome');
        error.statusCode = 403;
        throw error;
      }
      const bookingUrl = buildChiHomeBookingBridgeUrl({ threadId, accountId });
      return {
        ok: true,
        url: bookingUrl,
        threadId,
        accountId,
        departmentId: channel?.departmentId || null,
        departmentName: department?.name || channel?.departmentId || null,
        draftKey: new URL(bookingUrl).searchParams.get('draftKey') || '',
      };
    });
  }




  if (req.method === 'GET' && url.pathname === '/api/docs/compat') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    const forceJson = url.searchParams.get('format') === 'json' || url.searchParams.get('raw') === '1';
    if (!forceJson && wantsHtml(req)) {
      return html(res, 200, renderCompatDocsPage(COMPAT_DOCS));
    }
    return json(res, 200, { ok: true, docs: COMPAT_DOCS });
  }

  if (url.pathname === '/portal' || url.pathname === '/portal/' || url.pathname === '/portal/index.html' || url.pathname.startsWith('/portal/')) {
    return html(res, 404, '<!doctype html><html lang="vi"><meta charset="utf-8"><title>Not found</title><body>Not found</body></html>');
  }

  if (req.method === 'GET' && url.pathname === '/api/portal/me') {
    const principal = getRequiredAuth(req);
    return json(res, 200, { ok: true, user: principal, portal: buildPortalSummary(principal, portalStore.read()) });
  }

  if (req.method === 'GET' && url.pathname === '/api/portal/apps') {
    const principal = getRequiredAuth(req);
    requirePermission(principal, 'portal.apps.read');
    return json(res, 200, { ok: true, items: scopeLauncherApps(principal) });
  }

  if (req.method === 'GET' && url.pathname === '/api/portal/catalog') {
    const principal = getRequiredAuth(req);
    requirePermission(principal, 'portal.apps.read');
    return json(res, 200, await portalReadService.readCatalog(principal));
  }

  if (req.method === 'GET' && url.pathname === '/api/portal/settings') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    return json(res, 200, { ok: true, settings: portalStore.read().settings || {} });
  }

  if (req.method === 'GET' && url.pathname === '/api/portal/db/status') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    return json(res, 200, {
      ok: true,
      enabled: db.enabled,
      databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
      sync: portalSyncService.getStatus(),
      journal: portalJournalService.getStatus(),
      readModel: portalReadService.getStatus()
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/portal/settings') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const next = portalStore.update((draft) => {
        draft.settings = {
          ...(draft.settings || {}),
          ...(body && typeof body === 'object' ? body : {})
        };
        draft.updatedAt = new Date().toISOString();
        return draft;
      });
      applyRolePermissionsConfig();
      await portalSyncService.syncSettings(next.settings);
      await recordOperationalEvent({ actorUserId: principal.userId, action: 'portal.settings.update', resourceType: 'portal_settings', resourceId: 'global', payload: next.settings });
      return { ok: true, settings: next.settings };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/portal/roles') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    return json(res, 200, {
      ok: true,
      roles: getRolePermissions(),
      permissions: CONFIGURABLE_PERMISSIONS
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/portal/roles') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const rolePermissions = {
        manager: Array.isArray(body?.manager) ? body.manager.map(String) : undefined,
        staff: Array.isArray(body?.staff) ? body.staff.map(String) : undefined
      };
      const next = portalStore.update((draft) => {
        draft.settings = {
          ...(draft.settings || {}),
          rolePermissions: {
            ...(draft.settings?.rolePermissions || {}),
            ...rolePermissions
          }
        };
        draft.updatedAt = new Date().toISOString();
        return draft;
      });
      applyRolePermissionsConfig();
      await portalSyncService.syncSettings(next.settings);
      await recordOperationalEvent({ actorUserId: principal.userId, action: 'portal.roles.update', resourceType: 'portal_settings', resourceId: 'role_permissions', payload: next.settings?.rolePermissions || {} });
      return { ok: true, roles: getRolePermissions(), permissions: CONFIGURABLE_PERMISSIONS };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/portal/ops/overview') {
    const principal = getRequiredAuth(req);
    requirePermission(principal, 'portal.apps.read');
    return json(res, 200, await portalReadService.readOpsOverview(principal));
  }

  if (req.method === 'GET' && url.pathname === '/api/portal/activity') {
    const principal = getRequiredAuth(req);
    requirePermission(principal, 'portal.apps.read');
    return json(res, 200, await portalReadService.readActivity(principal, { limit: 50 }));
  }

  if (req.method === 'POST' && url.pathname === '/api/portal/departments') {
    const principal = getRequiredAuth(req);
    // A department defines a security boundary: Admin only.
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const department = {
        id: String(body.id || body.code || '').trim() || `dept-${Date.now()}`,
        code: String(body.code || body.id || '').trim() || `dept-${Date.now()}`,
        name: String(body.name || '').trim() || 'Department',
        managerUserIds: Array.isArray(body.managerUserIds) ? body.managerUserIds.map(String) : [],
        active: body.active !== false
      };
      const next = portalStore.update((draft) => {
        draft.departments = upsertById(draft.departments || [], department);
        draft.updatedAt = new Date().toISOString();
        return draft;
      });
      await portalSyncService.syncDepartment(department);
      await recordOperationalEvent({ actorUserId: principal.userId, action: 'portal.department.upsert', resourceType: 'department', resourceId: department.id, departmentId: department.id, payload: department });
      return { ok: true, item: department, portal: buildPortalSummary(principal, next) };
    });
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/portal/departments/')) {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    return handleAction(res, async () => {
      const departmentId = decodeURIComponent(url.pathname.slice('/api/portal/departments/'.length));
      const current = portalStore.read();
      const existing = (current.departments || []).find((item) => String(item.id) === String(departmentId));
      if (!existing) { const error = new Error('Không tìm thấy bộ phận'); error.statusCode = 404; throw error; }
      const usedByUser = (current.users || []).some((user) => (user.departmentIds || []).map(String).includes(String(departmentId)));
      const usedByChannel = (current.channels || []).some((channel) => String(channel.departmentId || '') === String(departmentId));
      if (usedByUser || usedByChannel) { const error = new Error('Không thể xoá bộ phận đang có nhân sự hoặc account Zalo'); error.statusCode = 409; throw error; }
      const next = portalStore.update((draft) => { draft.departments = (draft.departments || []).filter((item) => String(item.id) !== String(departmentId)); draft.updatedAt = new Date().toISOString(); return draft; });
      await recordOperationalEvent({ actorUserId: principal.userId, action: 'portal.department.delete', resourceType: 'department', resourceId: departmentId, departmentId, payload: { id: departmentId } });
      return { ok: true, deletedId: departmentId, portal: buildPortalSummary(principal, next) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/portal/users') {
    const principal = getRequiredAuth(req);
    requirePermission(principal, 'portal.users.write');
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const requestedStatus = String(body.status || 'offline');
      const requestedAccountIds = Array.isArray(body.accountIds) ? body.accountIds.map((item) => String(item || '').trim()).filter(Boolean) : null;
      const requestedDepartmentIds = Array.isArray(body.departmentIds) ? body.departmentIds.map(String).filter(Boolean) : [];
      const requestedRoles = Array.isArray(body.roles) && body.roles.length ? body.roles.map(String) : ['staff'];
      const user = {
        id: String(body.id || body.username || '').trim() || `user-${Date.now()}`,
        username: String(body.username || body.id || '').trim() || `user-${Date.now()}`,
        displayName: String(body.displayName || body.username || body.id || '').trim() || 'User',
        roles: requestedRoles,
        departmentIds: requestedDepartmentIds,
        permissions: Array.isArray(body.permissions) ? body.permissions.map(String) : [],
        status: requestedStatus,
        lastActiveAt: body.lastActiveAt || (requestedStatus !== 'offline' ? new Date().toISOString() : null),
        lastAssignedAt: body.lastAssignedAt || null,
        forceOfflineUntil: body.forceOfflineUntil || null,
        maxOpenConversations: Number(body.maxOpenConversations) || 20,
        active: body.active !== false,
        passwordHash: '',
        sessionVersion: 1
      };
      const portalStateBeforeWrite = portalStore.read();
      enforcePortalUserWriteScope(principal, user, portalStateBeforeWrite);
      validatePortalUserDepartments(user, portalStateBeforeWrite);
      validatePortalUserAccountAssignments(user, requestedAccountIds, portalStateBeforeWrite);
      const changedChannels = [];
      const next = portalStore.update((draft) => {
        const existing = (draft.users || []).find((item) => String(item.id) === String(user.id) || String(item.username) === String(user.username)) || null;
        user.passwordHash = String(body.password || '').trim()
          ? hashPassword(String(body.password || ''))
          : (existing?.passwordHash || '');
        user.sessionVersion = Number(existing?.sessionVersion || 1) + (String(body.password || '').trim() ? 1 : 0);
        draft.users = upsertById(draft.users || [], user);
        if (requestedAccountIds) {
          const wanted = new Set(requestedAccountIds);
          draft.channels = (draft.channels || []).map((channel) => {
            const accountId = String(channel.accountId || channel.code || channel.id || '').trim();
            const members = Array.isArray(channel.members) ? [...channel.members] : [];
            const hadUser = members.some((member) => String((member && typeof member === 'object' ? (member.userId || member.id || member.username) : member) || '') === String(user.username || user.id));
            let nextMembers = members;
            if (wanted.has(accountId) && !hadUser) {
              nextMembers = [...members, { userId: user.username || user.id }];
            } else if (!wanted.has(accountId) && hadUser) {
              nextMembers = members.filter((member) => String((member && typeof member === 'object' ? (member.userId || member.id || member.username) : member) || '') !== String(user.username || user.id));
            }
            if (nextMembers !== members) {
              const nextChannel = { ...channel, members: nextMembers };
              changedChannels.push(nextChannel);
              return nextChannel;
            }
            return channel;
          });
        }
        draft.updatedAt = new Date().toISOString();
        return draft;
      });
      await portalSyncService.syncUser(user);
      for (const channel of changedChannels) await portalSyncService.syncChannel(channel);
      await recordOperationalEvent({ actorUserId: principal.userId, action: 'portal.user.upsert', resourceType: 'user', resourceId: user.id, departmentId: user.departmentIds?.[0] || null, payload: { ...user, permissions: user.permissions, accountIds: requestedAccountIds || undefined } });
      return { ok: true, item: maskPortalUser(user), portal: buildPortalSummary(principal, next) };
    });
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/portal/users/')) {
    const principal = getRequiredAuth(req);
    requirePermission(principal, 'portal.users.write');
    return handleAction(res, async () => {
      const userId = decodeURIComponent(url.pathname.slice('/api/portal/users/'.length));
      const portalState = portalStore.read();
      const existing = (portalState.users || []).find((item) => String(item.id) === String(userId) || String(item.username) === String(userId));
      if (!existing) {
        const error = new Error('Không tìm thấy account');
        error.statusCode = 404;
        throw error;
      }
      enforcePortalUserWriteScope(principal, existing, portalState);
      const changedChannels = [];
      const next = portalStore.update((draft) => {
        draft.users = (draft.users || []).filter((item) => String(item.id) !== String(existing.id));
        draft.channels = (draft.channels || []).map((channel) => {
          const members = Array.isArray(channel.members) ? channel.members : [];
          const nextMembers = members.filter((member) => String((member && typeof member === 'object' ? (member.userId || member.id || member.username) : member) || '') !== String(existing.username || existing.id));
          if (nextMembers.length !== members.length) {
            const nextChannel = { ...channel, members: nextMembers };
            changedChannels.push(nextChannel);
            return nextChannel;
          }
          return channel;
        });
        draft.updatedAt = new Date().toISOString();
        return draft;
      });
      for (const channel of changedChannels) await portalSyncService.syncChannel(channel);
      await recordOperationalEvent({ actorUserId: principal.userId, action: 'portal.user.delete', resourceType: 'user', resourceId: existing.id, departmentId: existing.departmentIds?.[0] || null, payload: maskPortalUser(existing) });
      return { ok: true, deletedId: existing.id, portal: buildPortalSummary(principal, next) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/portal/channels') {
    const principal = getRequiredAuth(req);
    requirePermission(principal, 'channels.manage');
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const portalState = portalStore.read();
      const nextChannelId = String(body.id || body.code || body.accountId || '').trim();
      const existingChannel = (portalState.channels || []).find((item) => [item.id, item.code, item.accountId].map((value) => String(value || '').trim()).includes(nextChannelId)) || null;
      if (existingChannel && !hasPortalAdminAccess(principal) && existingChannel.departmentId && !canAccessDepartment(principal, existingChannel.departmentId)) {
        const error = new Error('Forbidden: không được sửa account Zalo ngoài bộ phận đang quản');
        error.statusCode = 403;
        throw error;
      }
      assertDepartmentAccess(principal, body.departmentId);
      const channel = {
        id: String(body.id || body.code || '').trim() || `channel-${Date.now()}`,
        code: String(body.code || body.id || '').trim() || `channel-${Date.now()}`,
        name: String(body.name || '').trim() || 'Channel',
        accountId: String(body.accountId || '').trim() || null,
        departmentId: String(body.departmentId || '').trim() || null,
        channelType: String(body.channelType || 'zalo_personal'),
        botStatus: String(body.botStatus || 'disabled'),
        routingMode: String(body.routingMode || 'least_connections'),
        credentials: body.credentials && typeof body.credentials === 'object' ? body.credentials : {},
        members: Array.isArray(body.members) ? body.members : [],
        active: body.active !== false
      };
      const next = portalStore.update((draft) => {
        draft.channels = upsertById(draft.channels || [], channel);
        draft.updatedAt = new Date().toISOString();
        return draft;
      });
      await portalSyncService.syncChannel(channel);
      await recordOperationalEvent({ actorUserId: principal.userId, action: 'portal.channel.upsert', resourceType: 'channel', resourceId: channel.id, departmentId: channel.departmentId || null, payload: maskChannelSecrets(channel) });
      return { ok: true, item: maskChannelSecrets(channel), portal: buildPortalSummary(principal, next) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/portal/threads/bind') {
    const principal = getRequiredAuth(req);
    requirePermission(principal, 'conversations.assign');
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      const portalState = portalStore.read();
      const departmentId = String(body.departmentId || '');
      const channelId = body.channelId ? String(body.channelId) : null;
      const accountId = String(body.accountId || store.read().activeAccountId || '').trim() || null;
      const bindingKey = buildThreadBindingKey(body.threadId, accountId);
      assertDepartmentAccess(principal, departmentId);
      assertPortalChannelAccess(portalState, departmentId, channelId);
      const assignedUser = body.assignedUserId ? assertAssignablePortalUser(portalState, body.assignedUserId, departmentId, channelId) : null;
      const next = portalStore.update((draft) => {
        draft.threadBindings[bindingKey] = {
          ...(draft.threadBindings[bindingKey] || {}),
          threadId: String(body.threadId),
          accountId,
          departmentId,
          channelId,
          assignedUserId: assignedUser ? String(assignedUser.id) : null,
          queueStatus: body.queueStatus ? String(body.queueStatus) : null,
          priority: body.priority ? String(body.priority) : (draft.threadBindings[bindingKey]?.priority || 'normal'),
          slaFirstResponseDueAt: parseOptionalIsoDate(body.slaFirstResponseDueAt),
          slaNextResponseDueAt: parseOptionalIsoDate(body.slaNextResponseDueAt),
          lastRoutingAction: assignedUser ? 'assign' : 'bind',
          lastRoutingReason: 'manual-bind',
          lastRoutingContext: {
            strategy: 'manual_bind',
            queueStatus: body.queueStatus ? String(body.queueStatus) : null,
            priority: body.priority ? String(body.priority) : (draft.threadBindings[bindingKey]?.priority || 'normal')
          },
          updatedAt: new Date().toISOString()
        };
        dropLegacyThreadBinding(draft, body.threadId, accountId);
        draft.updatedAt = new Date().toISOString();
        return draft;
      });
      store.update((draft) => {
        if (draft.threads?.[body.threadId]) draft.threads[body.threadId].assignee = assignedUser ? String(assignedUser.id) : null;
        return draft;
      });
      await portalSyncService.syncThreadBinding(next.threadBindings[bindingKey]);
      await recordOperationalEvent({ actorUserId: principal.userId, action: 'portal.thread.bind', resourceType: 'thread_binding', resourceId: bindingKey, departmentId: next.threadBindings[bindingKey]?.departmentId || null, payload: next.threadBindings[bindingKey] });
      return { ok: true, binding: next.threadBindings[bindingKey] };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/portal/conversations/assign') {
    const principal = getRequiredAuth(req);
    requirePermission(principal, 'conversations.assign');
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId || !body.assignedUserId) throw new Error('Thiếu threadId hoặc assignedUserId');
      const portalState = portalStore.read();
      const accountId = String(body.accountId || store.read().activeAccountId || '').trim() || null;
      const bindingKey = buildThreadBindingKey(body.threadId, accountId);
      const current = resolvePortalThreadBinding(portalState, body.threadId, accountId) || {};
      const departmentId = String(current.departmentId || body.departmentId || '');
      const channelId = current.channelId || (body.channelId ? String(body.channelId) : null);
      assertDepartmentAccess(principal, departmentId);
      assertPortalChannelAccess(portalState, departmentId, channelId);
      const assignedUser = assertAssignablePortalUser(portalState, body.assignedUserId, departmentId, channelId);
      const next = portalStore.update((draft) => {
        draft.threadBindings[bindingKey] = {
          ...(draft.threadBindings[bindingKey] || {}),
          threadId: String(body.threadId),
          accountId,
          departmentId,
          channelId,
          assignedUserId: String(assignedUser.id),
          queueStatus: 'open',
          lastRoutingAction: 'assign',
          lastRoutingReason: 'manual-assign',
          lastRoutingContext: {
            strategy: 'manual_assign',
            assignedUserId: String(assignedUser.id)
          },
          updatedAt: new Date().toISOString()
        };
        dropLegacyThreadBinding(draft, body.threadId, accountId);
        const user = (draft.users || []).find((item) => String(item.id) === String(assignedUser.id) || String(item.username) === String(assignedUser.username));
        if (user) user.lastAssignedAt = new Date().toISOString();
        draft.updatedAt = new Date().toISOString();
        return draft;
      });
      const view = store.update((draft) => {
        if (draft.threads?.[body.threadId]) draft.threads[body.threadId].assignee = String(assignedUser.id);
        return draft;
      });
      await portalSyncService.syncThreadBinding(next.threadBindings[bindingKey]);
      await recordOperationalEvent({ actorUserId: principal.userId, action: 'portal.thread.assign', resourceType: 'thread_binding', resourceId: bindingKey, departmentId: next.threadBindings[bindingKey]?.departmentId || null, payload: next.threadBindings[bindingKey] });
      emitEvent('thread.meta_updated', { threadId: String(body.threadId), accountId, action: 'portal-assign', view: buildScopedView(view, principal, next) });
      return { ok: true, binding: next.threadBindings[bindingKey] };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/portal/presence') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const requestedUserId = String(body.userId || principal.userId || principal.username);
      const selfUpdate = String(requestedUserId) === String(principal.userId || principal.username);
      if (!selfUpdate) requirePermission(principal, 'presence.force_offline');
      const next = portalStore.update((draft) => {
        const user = (draft.users || []).find((item) => String(item.id) === requestedUserId || String(item.username) === requestedUserId);
        if (!user) throw new Error('Không tìm thấy user portal');
        if (!selfUpdate) assertDepartmentAccess(principal, (user.departmentIds || [])[0]);
        user.status = String(body.status || user.status || 'offline');
        user.lastActiveAt = new Date().toISOString();
        user.forceOfflineUntil = body.forceOfflineUntil || null;
        draft.updatedAt = new Date().toISOString();
        return draft;
      });
      const updatedUser = (next.users || []).find((item) => String(item.id) === requestedUserId || String(item.username) === requestedUserId);
      await portalSyncService.syncUser(updatedUser);
      await recordOperationalEvent({ actorUserId: principal.userId, action: 'portal.user.presence', resourceType: 'user', resourceId: requestedUserId, departmentId: updatedUser?.departmentIds?.[0] || null, payload: { status: updatedUser?.status, forceOfflineUntil: updatedUser?.forceOfflineUntil } });
      return { ok: true, portal: buildPortalSummary(principal, next) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/portal/routing/plan') {
    const principal = getRequiredAuth(req);
    requirePermission(principal, 'conversations.assign');
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.departmentId) throw new Error('Thiếu departmentId');
      assertDepartmentAccess(principal, body.departmentId);
      const catalog = await portalReadService.readCatalog(principal);
      const channel = (catalog.portal?.channels || []).find((item) => String(item.id) === String(body.channelId || '')) || { routingMode: catalog.settings?.routingMode || 'least_connections' };
      const bindings = catalog.threadBindings || {};
      const counts = new Map();
      for (const binding of Object.values(bindings)) {
        if (String(binding.queueStatus || '') === 'open' && binding.assignedUserId) {
          counts.set(String(binding.assignedUserId), Number(counts.get(String(binding.assignedUserId)) || 0) + 1);
        }
      }
      const allowedMemberIds = normalizeChannelMemberIds(channel.members || []);
      const candidates = (catalog.users || [])
        .filter((item) => (item.departmentIds || []).map(String).includes(String(body.departmentId)))
        .filter((item) => !allowedMemberIds.size || allowedMemberIds.has(String(item.id)) || allowedMemberIds.has(String(item.username || '')))
        .filter((item) => isPortalRoutingEligibleUser(item))
        .map((item) => {
          const channelMember = findChannelMember(channel.members || [], item.id, item.username);
          const maxOpen = Number(channelMember?.maxOpenConversations || item.maxOpenConversations || 20);
          return {
            id: item.id,
            status: derivePresenceStatus({ declaredStatus: item.status, lastActiveAt: item.lastActiveAt, forceOfflineUntil: item.forceOfflineUntil }),
            forceOfflineUntilExpired: Boolean(item.forceOfflineUntil && new Date(item.forceOfflineUntil).getTime() > Date.now()),
            atCapacity: Number(counts.get(String(item.id)) || 0) >= maxOpen,
            routingWeight: Number(channelMember?.routingWeight || item.routingWeight) || 100,
            lastAssignedAt: item.lastAssignedAt
          };
        });
      const thread = {
        priority: body.priority || 'normal',
        slaFirstResponseDueAt: parseOptionalIsoDate(body.slaFirstResponseDueAt),
        slaNextResponseDueAt: parseOptionalIsoDate(body.slaNextResponseDueAt)
      };
      return { ok: true, source: catalog.source, plan: planRouting({ channel, candidates, openConversationCounts: counts, thread }) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/portal/sso/mock-login') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const username = String(body.username || '').trim() || 'staff';
      const roles = Array.isArray(body.roles) && body.roles.length ? body.roles.map(String) : ['staff'];
      const departmentIds = Array.isArray(body.departmentIds) ? body.departmentIds.map(String) : ['sale'];
      portalStore.update((draft) => {
        draft.users = upsertById(draft.users || [], {
          id: username,
          username,
          displayName: body.displayName || username,
          roles,
          departmentIds,
          permissions: Array.isArray(body.permissions) ? body.permissions.map(String) : [],
          status: 'online',
          lastActiveAt: new Date().toISOString(),
          lastAssignedAt: null,
          forceOfflineUntil: null,
          maxOpenConversations: Number(body.maxOpenConversations) || 20,
          active: true
        });
        draft.updatedAt = new Date().toISOString();
        return draft;
      });
      const token = createPortalSessionToken({ id: username, username, displayName: body.displayName || username, roles, permissions: body.permissions || [], departmentIds }, { jwtSecret: portalConfig.jwtSecret });
      res.setHeader('Set-Cookie', buildPortalSessionCookie(token, {
        cookieDomain: resolvePortalCookieDomain(req),
        secure: resolvePortalCookieSecure(req),
        sameSite: portalConfig.sameSite
      }));
      return { ok: true, username, roles, departmentIds };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    return json(res, 200, { ok: true, items: typeof provider.listAccounts === 'function' ? provider.listAccounts() : [] });
  }

  if (url.pathname.startsWith('/api/') && !['/api/health', '/api/auth/login', '/api/auth/status', '/api/accounts'].includes(url.pathname) && !isAuthenticated(req)) {
    const allowCompatManager = req.method === 'POST' && url.pathname === '/api/compat/manager' && getCompatApiPrincipal(req);
    const allowChiHomeLookup = req.method === 'GET' && url.pathname === '/api/chihome/resolve-thread' && getChiHomeLookupPrincipal(req);
    if (!(allowCompatManager || allowChiHomeLookup)) {
      return json(res, 401, { ok: false, error: 'Unauthorized' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/accounts/select') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      assertAccountAccess(principal, body.accountId, portalStore.read(), store.read());
      return ({ ok: true, ...(await provider.selectAccount(body.accountId, { awaitSync: body.awaitSync === true, loadHistory: body.loadHistory })) });
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/accounts/logout') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => ({ ok: true, ...(await provider.logoutAccount(body.accountId)) }));
  }

  if (req.method === 'POST' && url.pathname === '/api/integration/config') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => ({ ok: true, integration: await provider.updateIntegrationConfig(body) }));
  }

  if (req.method === 'GET' && url.pathname === '/api/ai-automation/config') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    return handleAction(res, async () => {
      const departmentId = String(url.searchParams.get('departmentId') || '').trim() || null;
      if (departmentId) assertDepartmentAccess(principal, departmentId);
      const currentState = store.read();
      const current = getAiAutomationConfigForDepartment(currentState, departmentId);
      return { ok: true, departmentId, aiAutomation: current, aiAutomationByDepartment: normalizeAiAutomationDepartmentMap(currentState.aiAutomationByDepartment || {}, currentState.aiAutomation || {}) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/ai-automation/config') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const departmentId = String(body.departmentId || '').trim() || null;
      if (departmentId) assertDepartmentAccess(principal, departmentId);
      const nextState = store.update((draft) => {
        setAiAutomationConfigForDepartment(draft, departmentId, body);
        return draft;
      });
      const current = getAiAutomationConfigForDepartment(nextState, departmentId);
      emitEvent('ai_automation.config_updated', { view: buildView(nextState), aiAutomation: current, departmentId });
      return { ok: true, departmentId, aiAutomation: current, aiAutomationByDepartment: normalizeAiAutomationDepartmentMap(nextState.aiAutomationByDepartment || {}, nextState.aiAutomation || {}), view: buildView(nextState) };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/ai-automation/knowledge') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    return handleAction(res, async () => {
      const departmentId = String(url.searchParams.get('departmentId') || '').trim() || null;
      if (departmentId) assertDepartmentAccess(principal, departmentId);
      const aiAutomation = getAiAutomationConfigForDepartment(store.read(), departmentId);
      return { ok: true, departmentId, items: aiAutomation.knowledgeDocuments || [] };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/ai-automation/knowledge/upload') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const departmentId = String(body.departmentId || '').trim() || null;
      if (departmentId) assertDepartmentAccess(principal, departmentId);
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) throw new Error('Chưa có tài liệu nào để nạp vào knowledge base');
      const docs = saveKnowledgeUploads(files, dataDir, {
        target: String(body.target || 'rag').trim() || 'rag',
        tags: Array.isArray(body.tags) ? body.tags : []
      });
      const nextState = store.update((draft) => {
        const current = getAiAutomationConfigForDepartment(draft, departmentId);
        setAiAutomationConfigForDepartment(draft, departmentId, normalizeAiAutomationConfig({
          ...current,
          knowledgeDocuments: [...(current.knowledgeDocuments || []), ...docs]
        }, current));
        return draft;
      });
      const config = getAiAutomationConfigForDepartment(nextState, departmentId);
      emitEvent('ai_automation.knowledge_updated', { view: buildView(nextState), aiAutomation: config, departmentId });
      return { ok: true, departmentId, items: docs, aiAutomation: config, view: buildView(nextState) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/ai-automation/knowledge/delete') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const departmentId = String(body.departmentId || '').trim() || null;
      if (departmentId) assertDepartmentAccess(principal, departmentId);
      const ids = new Set((Array.isArray(body.documentIds) ? body.documentIds : [body.documentId]).map((item) => String(item || '').trim()).filter(Boolean));
      if (!ids.size) throw new Error('Thiếu documentId');
      const nextState = store.update((draft) => {
        const current = getAiAutomationConfigForDepartment(draft, departmentId);
        const remaining = [];
        for (const item of current.knowledgeDocuments || []) {
          if (ids.has(String(item.id || '').trim())) {
            const storagePath = String(item.storagePath || '').trim();
            if (storagePath && fs.existsSync(storagePath)) fs.unlinkSync(storagePath);
            continue;
          }
          remaining.push(item);
        }
        setAiAutomationConfigForDepartment(draft, departmentId, normalizeAiAutomationConfig({ ...current, knowledgeDocuments: remaining }, current));
        return draft;
      });
      const config = getAiAutomationConfigForDepartment(nextState, departmentId);
      emitEvent('ai_automation.knowledge_updated', { view: buildView(nextState), aiAutomation: config, departmentId });
      return { ok: true, departmentId, aiAutomation: config, view: buildView(nextState) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/ai-automation/plan-preview') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const state = store.read();
      const threadId = String(body.threadId || '').trim();
      const accountId = String(body.accountId || state.activeAccountId || '').trim();
      if (threadId) assertThreadAccess(principal, threadId);
      if (accountId) assertAccountAccess(principal, accountId, portalStore.read(), state);
      const preview = await aiAutomationRuntime.preview({
        threadId,
        accountId,
        departmentId: body.departmentId || null,
        thread: body.thread || null,
        threadMode: body.threadMode || null,
        forceEnabled: body.forceEnabled === true,
        configOverride: body.configOverride || null,
        message: body.message || {},
        confidence: Number(body.confidence ?? 0.5)
      });
      return { ok: true, plan: preview.plan, replyText: preview.replyText, action: preview.action, actions: preview.actions, analysis: {
        intent: preview.analysis?.intent,
        complexity: preview.analysis?.complexity,
        sentiment: preview.analysis?.sentiment,
        asksHuman: preview.analysis?.asksHuman,
        repeatedQuestions: preview.analysis?.repeatedQuestions
      } };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/ai-automation/simulate') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const state = store.read();
      const threadId = String(body.threadId || '').trim();
      const accountId = String(body.accountId || state.activeAccountId || '').trim();
      if (threadId) assertThreadAccess(principal, threadId);
      if (accountId) assertAccountAccess(principal, accountId, portalStore.read(), state);
      const preview = await aiAutomationRuntime.preview({
        threadId,
        accountId,
        departmentId: body.departmentId || null,
        thread: body.thread || null,
        threadMode: body.threadMode || null,
        forceEnabled: body.forceEnabled === true,
        configOverride: body.configOverride || null,
        message: body.message || {},
        confidence: Number(body.confidence ?? 0.86),
        now: body.now
      });
      return {
        ok: true,
        action: preview.action,
        shouldReply: preview.shouldReply,
        replyText: preview.replyText,
        escalationMessage: preview.escalationMessage,
        plan: preview.plan,
        actions: preview.actions,
        analysis: {
          intent: preview.analysis?.intent,
          complexity: preview.analysis?.complexity,
          sentiment: preview.analysis?.sentiment,
          asksHuman: preview.analysis?.asksHuman,
          repeatedQuestions: preview.analysis?.repeatedQuestions
        }
      };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/threads/automation') {
    const principal = getRequiredAuth(req);
    return handleAction(res, async () => {
      const state = store.read();
      const threadId = String(url.searchParams.get('threadId') || '').trim();
      const accountId = String(url.searchParams.get('accountId') || state.activeAccountId || '').trim();
      if (!threadId) throw new Error('Thiếu threadId');
      assertThreadAccess(principal, threadId);
      if (accountId) assertAccountAccess(principal, accountId, portalStore.read(), state);
      const thread = resolveThreadRecord(state, threadId, accountId);
      if (!thread) throw new Error('Không tìm thấy thread');
      return {
        ok: true,
        accountId: accountId || null,
        threadId,
        automation: normalizeThreadAutomationState(thread.automation || {}, getAiAutomationConfigForDepartment(state, getAiAutomationDepartmentIdForThread(threadId, accountId)))
      };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/threads/automation') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const threadId = String(body.threadId || '').trim();
      if (!threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, threadId);
      const before = store.read();
      const accountId = String(body.accountId || before.activeAccountId || '').trim();
      if (!accountId) throw new Error('Thiếu accountId');
      assertAccountAccess(principal, accountId, portalStore.read(), before);
      const currentThread = resolveThreadRecord(before, threadId, accountId);
      if (!currentThread) throw new Error('Không tìm thấy thread');

      const now = Date.now();
      const requestedMode = String(body.mode || '').trim() || 'off';
      const resumeAt = body.resumeAt
        ? new Date(body.resumeAt).toISOString()
        : computeAutomationResumeAt({ minutes: body.minutes, hours: body.hours, now, requestedMode });
      const patch = {
        mode: requestedMode,
        resumeAt: requestedMode === 'snoozed' ? resumeAt : null,
        reason: body.reason || null,
        assignedFlowId: String(body.assignedFlowId || '').trim() || null,
        policyId: String(body.policyId || '').trim() || null,
        updatedBy: principal.userId || principal.username || 'unknown'
      };
      if (requestedMode === 'paused_by_escalation') {
        patch.lastEscalatedAt = new Date(now).toISOString();
        patch.escalationCount = Number(currentThread.automation?.escalationCount || 0) + 1;
      }
      if (requestedMode === 'auto') patch.reason = body.reason || 'Đã bật tự động trả lời cho khách này.';
      if (requestedMode === 'off') patch.reason = body.reason || 'Đã tắt tự động trả lời cho khách này.';
      if (requestedMode === 'human_only') patch.reason = body.reason || 'Chuyển hội thoại sang con người xử lý.';

      const nextState = store.update((draft) => {
        const departmentId = getAiAutomationDepartmentIdForThread(threadId, accountId);
        let config = getAiAutomationConfigForDepartment(draft, departmentId);
        if ((requestedMode === 'auto' || requestedMode === 'snoozed') && !config.enabled) {
          setAiAutomationConfigForDepartment(draft, departmentId, normalizeAiAutomationConfig({ ...config, enabled: true, mode: config.mode === 'disabled' ? 'assistive' : config.mode }, config));
          config = getAiAutomationConfigForDepartment(draft, departmentId);
        }
        updateAccountScopedState(draft, accountId, (snapshot) => {
          const thread = snapshot.threads?.[threadId];
          if (!thread) throw new Error('Không tìm thấy thread');
          thread.automation = patchThreadAutomationState(thread.automation || {}, patch, config, now);
          return snapshot;
        });
        return draft;
      });

      const nextThread = resolveThreadRecord(nextState, threadId, accountId);
      emitEvent('thread.meta_updated', { threadId, accountId, action: 'automation', view: buildView(nextState) });
      return {
        ok: true,
        accountId,
        threadId,
        automation: normalizeThreadAutomationState(nextThread?.automation || {}, getAiAutomationConfigForDepartment(nextState, getAiAutomationDepartmentIdForThread(threadId, accountId))),
        view: buildView(nextState)
      };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/threads/memory') {
    const principal = getRequiredAuth(req);
    return handleAction(res, async () => {
      const state = store.read();
      const threadId = String(url.searchParams.get('threadId') || '').trim();
      const accountId = String(url.searchParams.get('accountId') || state.activeAccountId || '').trim();
      if (!threadId) throw new Error('Thiếu threadId');
      assertThreadAccess(principal, threadId);
      if (accountId) assertAccountAccess(principal, accountId, portalStore.read(), state);
      const thread = resolveThreadRecord(state, threadId, accountId);
      if (!thread) throw new Error('Không tìm thấy thread');
      const departmentId = getAiAutomationDepartmentIdForThread(threadId, accountId);
      const automation = normalizeThreadAutomationState(thread.automation || {}, getAiAutomationConfigForDepartment(state, departmentId));
      return {
        ok: true,
        accountId: accountId || null,
        threadId,
        automation,
        rows: resolveThreadMemoryRows(automation)
      };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/threads/memory/delete') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      const threadId = String(body.threadId || '').trim();
      if (!threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, threadId);
      const before = store.read();
      const accountId = String(body.accountId || before.activeAccountId || '').trim();
      if (!accountId) throw new Error('Thiếu accountId');
      assertAccountAccess(principal, accountId, portalStore.read(), before);
      const rowIds = Array.isArray(body.rowIds) ? body.rowIds.map((item) => String(item || '').trim()).filter(Boolean) : [];
      if (!rowIds.length) throw new Error('Thiếu rowIds');
      const now = Date.now();
      const nextState = store.update((draft) => {
        const departmentId = getAiAutomationDepartmentIdForThread(threadId, accountId);
        const config = getAiAutomationConfigForDepartment(draft, departmentId);
        updateAccountScopedState(draft, accountId, (snapshot) => {
          const thread = snapshot.threads?.[threadId];
          if (!thread) throw new Error('Không tìm thấy thread');
          const automation = normalizeThreadAutomationState(thread.automation || {}, config, now);
          const existingRows = resolveThreadMemoryRows(automation);
          const remainingRows = existingRows.filter((item) => !rowIds.includes(String(item.id || '')));
          const clearedAllMemory = existingRows.length > 0 && remainingRows.length === 0;
          thread.automation = patchThreadAutomationState(thread.automation || {}, {
            memoryRows: remainingRows,
            memoryClearedAt: clearedAllMemory ? new Date(now).toISOString() : automation.memoryClearedAt || null,
            conversationMemory: clearedAllMemory ? null : rebuildConversationMemoryFromRows(remainingRows, automation.conversationMemory || {}, now),
            agentMemories: clearedAllMemory ? {} : rebuildAgentMemoriesFromRows(remainingRows, automation.agentMemories || {}, now)
          }, config, now);
          return snapshot;
        });
        return draft;
      });
      const nextThread = resolveThreadRecord(nextState, threadId, accountId);
      const departmentId = getAiAutomationDepartmentIdForThread(threadId, accountId);
      const automation = normalizeThreadAutomationState(nextThread?.automation || {}, getAiAutomationConfigForDepartment(nextState, departmentId));
      const view = buildView(nextState);
      emitEvent('thread.meta_updated', { threadId, accountId, action: 'memory', view });
      return {
        ok: true,
        accountId,
        threadId,
        automation,
        rows: resolveThreadMemoryRows(automation),
        view
      };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/stickers/packs') {
    return handleAction(res, async () => ({ ok: true, items: await provider.getStickerCatalog() }));
  }

  if (req.method === 'GET' && url.pathname === '/api/stickers/pack') {
    return handleAction(res, async () => {
      const cateId = url.searchParams.get('cateId') || '';
      if (!cateId) throw new Error('Thiếu cateId');
      return { ok: true, items: await provider.getStickerPackDetail(cateId) };
    });
  }



  if (req.method === 'GET' && url.pathname === '/api/friends/search') {
    getRequiredAuth(req);
    return handleAction(res, async () => {
      const query = url.searchParams.get('q') || '';
      const items = typeof provider.searchUsers === 'function' ? await provider.searchUsers(query) : [];
      return { ok: true, items };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/chihome/resolve-thread') {
    getRequiredChiHomeLookupAuth(req);
    return handleAction(res, async () => {
      const phone = String(url.searchParams.get('phone') || url.searchParams.get('q') || '').trim();
      const normalizedPhone = normalizePhoneDigits(phone);
      if (!normalizedPhone || normalizedPhone.length < 8) {
        const error = new Error('Thiếu số điện thoại hợp lệ');
        error.statusCode = 400;
        throw error;
      }
      const items = typeof provider.searchUsers === 'function' ? await provider.searchUsers(normalizedPhone) : [];
      const item = selectBestChihomeThreadMatch(items, normalizedPhone);
      return {
        ok: true,
        phone: normalizedPhone,
        resolved: Boolean(item),
        item,
        items,
      };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/friends/request') {
    getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.userId) throw new Error('Thiếu userId');
      if (typeof provider.sendFriendRequest !== 'function') throw new Error('Provider không hỗ trợ kết bạn');
      await provider.sendFriendRequest(body.userId, body.message || '', body.profile || body);
      return { ok: true, view: buildView(store.read()) };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/friends/status') {
    getRequiredAuth(req);
    return handleAction(res, async () => {
      const userId = url.searchParams.get('userId') || '';
      if (!userId) throw new Error('Thiếu userId');
      if (typeof provider.refreshFriendStatus !== 'function') throw new Error('Provider không hỗ trợ đọc trạng thái bạn bè');
      return { ...(await provider.refreshFriendStatus(userId)), view: buildView(store.read()) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/friends/request/accept') {
    getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.userId) throw new Error('Thiếu userId');
      if (typeof provider.acceptFriendRequest !== 'function') throw new Error('Provider không hỗ trợ chấp nhận kết bạn');
      await provider.acceptFriendRequest(body.userId, body.profile || body);
      return { ok: true, view: buildView(store.read()) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/friends/request/reject') {
    getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.userId) throw new Error('Thiếu userId');
      if (typeof provider.rejectFriendRequest !== 'function') throw new Error('Provider không hỗ trợ từ chối kết bạn');
      await provider.rejectFriendRequest(body.userId);
      return { ok: true, view: buildView(store.read()) };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/friends') {
    getRequiredAuth(req);
    return handleAction(res, async () => {
      const state = buildView(store.read());
      const items = (state.contacts || []).filter((item) => String(item.kind || '') === 'friend');
      return { ok: true, items };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/threads/profile') {
    const principal = getRequiredAuth(req);
    return handleAction(res, async () => {
      const threadId = url.searchParams.get('threadId') || '';
      if (!threadId) throw new Error('Thiếu threadId');
      assertThreadAccess(principal, threadId);
      if (typeof provider.getThreadProfile !== 'function') throw new Error('Provider không hỗ trợ đọc thông tin hội thoại');
      return { ok: true, item: await provider.getThreadProfile(threadId) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/groups/leave') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, body.threadId);
      if (typeof provider.leaveGroup !== 'function') throw new Error('Provider không hỗ trợ rời nhóm');
      return await provider.leaveGroup(body.threadId, body.silent === true);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/groups/link') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, body.threadId);
      if (typeof provider.getOrCreateGroupLink !== 'function') throw new Error('Provider không hỗ trợ lấy link nhóm');
      return await provider.getOrCreateGroupLink(body.threadId);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/groups/invite') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, body.threadId);
      if (typeof provider.inviteUsersToGroup !== 'function') throw new Error('Provider không hỗ trợ mời vào nhóm');
      return await provider.inviteUsersToGroup(body.threadId, body.userIds || []);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/friends/request/undo') {
    getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.userId) throw new Error('Thiếu userId');
      if (typeof provider.undoFriendRequest !== 'function') throw new Error('Provider không hỗ trợ thu hồi lời mời');
      await provider.undoFriendRequest(body.userId);
      return { ok: true, view: buildView(store.read()) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/friends/remove') {
    getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.userId) throw new Error('Thiếu userId');
      if (typeof provider.removeFriend !== 'function') throw new Error('Provider không hỗ trợ huỷ kết bạn');
      await provider.removeFriend(body.userId, body.profile || body);
      return { ok: true, view: buildView(store.read()) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/friends/block') {
    getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.userId) throw new Error('Thiếu userId');
      if (typeof provider.blockUser !== 'function') throw new Error('Provider không hỗ trợ chặn người dùng');
      await provider.blockUser(body.userId, body.profile || body);
      return { ok: true, view: buildView(store.read()) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/friends/unblock') {
    getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.userId) throw new Error('Thiếu userId');
      if (typeof provider.unblockUser !== 'function') throw new Error('Provider không hỗ trợ bỏ chặn');
      await provider.unblockUser(body.userId, body.profile || body);
      return { ok: true, view: buildView(store.read()) };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const principal = getRequiredAuth(req);
    const state = store.read();
    const portalState = portalStore.read();
    const requestedThreadId = String(url.searchParams.get('threadId') || '').trim();
    const payload = trimStatePayloadForRequestedThread(buildScopedView(state, principal, portalState), requestedThreadId);
    return jsonCached(res, 200, payload, buildScopedViewBodyCacheKey(state, principal, portalState, requestedThreadId));
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    return openEventStream(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/qr/start') {
    const principal = getRequiredAuth(req);
    requirePermission(principal, 'channels.manage');
    const body = await readJsonBody(req);
    const departmentId = String(body?.departmentId || '').trim();
    if (!departmentId) {
      const error = new Error('Chọn bộ phận nhận account Zalo trước khi tạo QR.');
      error.statusCode = 400;
      throw error;
    }
    assertDepartmentAccess(principal, departmentId);
    return handleAction(res, () => provider.startQrLogin({
      onAuthenticated: async (session) => {
        const account = session?.account || {};
        const accountId = String(account.id || account.userId || '').trim();
        if (!accountId) throw new Error('Zalo đăng nhập thành công nhưng thiếu mã account để gán bộ phận.');
        const portalState = portalStore.read();
        const existing = (portalState.channels || []).find((item) => [item.id, item.code, item.accountId].map((value) => String(value || '').trim()).includes(accountId)) || {};
        const channel = {
          ...existing,
          id: existing.id || accountId,
          code: existing.code || accountId,
          accountId,
          name: existing.name || account.displayName || account.name || accountId,
          departmentId,
          channelType: existing.channelType || 'zalo_personal',
          botStatus: existing.botStatus || 'disabled',
          routingMode: existing.routingMode || 'least_connections',
          credentials: existing.credentials || {},
          members: Array.isArray(existing.members) ? existing.members : [],
          active: existing.active !== false
        };
        const next = portalStore.update((draft) => {
          draft.channels = upsertById(draft.channels || [], channel);
          draft.updatedAt = new Date().toISOString();
          return draft;
        });
        await portalSyncService.syncChannel(channel);
        await recordOperationalEvent({ actorUserId: principal.userId, action: 'portal.channel.qr_onboard', resourceType: 'channel', resourceId: channel.id, departmentId, payload: maskChannelSecrets(channel) });
        return next;
      }
    }));
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/qr/confirm') {
    const principal = getRequiredAuth(req);
    requirePermission(principal, 'channels.manage');
    return handleAction(res, () => provider.confirmQrLogin());
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/uploads/')) {
    const principal = getRequiredAuth(req);
    requireAnyPermission(principal, ['conversations.read', 'conversations.reply']);
    const fileName = decodeURIComponent(url.pathname.slice('/api/uploads/'.length));
    return serveUploadedFile(req, res, dataDir, fileName);
  }

  if (req.method === 'POST' && url.pathname === '/api/messages/send') {
    const principal = getRequiredAuth(req);
    requireAnyPermission(principal, ['conversations.reply']);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadAccess(principal, body.threadId);
      const uploads = Array.isArray(body.attachments) ? body.attachments : [];
      const remoteUploads = await resolveCompatAttachments(Array.isArray(body.attachmentsUrls) ? body.attachmentsUrls.join(',') : (body.attachmentsUrls || ''), '');
      const saved = writeUploadsToTempFiles([...uploads, ...remoteUploads], dataDir);
      try {
        const message = await provider.sendMessage({
          threadId: body.threadId,
          text: String(body.text || '').trim(),
          attachments: saved.paths,
          attachmentMeta: saved.meta,
          replyToId: body.replyToId ? String(body.replyToId) : null,
          mentions: Array.isArray(body.mentions) ? body.mentions : []
        });
        return { ok: true, message };
      } finally {
        // Keep temp uploads available for inline open/download in the web UI.
        // They are served via /api/uploads/:name after auth.
      }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/messages/sticker') {
    const principal = getRequiredAuth(req);
    requireAnyPermission(principal, ['conversations.reply']);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadAccess(principal, body.threadId);
      const message = await provider.sendStickerMessage(body.threadId, body.sticker || {});
      return { ok: true, message };
    });
  }

  if (req.method === 'POST' && (url.pathname === '/api/compat/manager' || url.pathname === '/get/post')) {
    const principal = getRequiredCompatAuth(req);
    requireAdminAccess(principal);
    const body = await readJsonBody(req);
    return handleAction(res, async () => ({ ok: true, result: await handleCompatManager(body, provider) }));
  }

  if (req.method === 'POST' && url.pathname === '/api/messages/undo') {
    const principal = getRequiredAuth(req);
    requireAnyPermission(principal, ['conversations.reply']);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId || !body.messageId) throw new Error('Thiếu threadId hoặc messageId');
      assertThreadAccess(principal, body.threadId);
      if (typeof provider.undoMessage !== 'function') throw new Error('Provider không hỗ trợ thu hồi');
      await provider.undoMessage(body.threadId, body.messageId);
      return { ok: true };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/messages/delete') {
    const principal = getRequiredAuth(req);
    requireAnyPermission(principal, ['conversations.reply']);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId || !body.messageId) throw new Error('Thiếu threadId hoặc messageId');
      assertThreadAccess(principal, body.threadId);
      if (typeof provider.deleteMessageForMe !== 'function') throw new Error('Provider không hỗ trợ xoá tin');
      await provider.deleteMessageForMe(body.threadId, body.messageId);
      return { ok: true };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/messages/react') {
    const principal = getRequiredAuth(req);
    requireAnyPermission(principal, ['conversations.reply']);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId || !body.messageId || !body.icon) throw new Error('Thiếu threadId, messageId hoặc icon');
      assertThreadAccess(principal, body.threadId);
      if (typeof provider.addReaction !== 'function') throw new Error('Provider không hỗ trợ thả cảm xúc');
      await provider.addReaction(body.threadId, body.messageId, body.icon);
      return { ok: true };
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/threads/messages') {
    const principal = getRequiredAuth(req);
    const threadId = String(url.searchParams.get('threadId') || '').trim();
    if (!threadId) return json(res, 400, { ok: false, error: 'Thiếu threadId' });
    assertThreadAccess(principal, threadId);
    const state = store.read();
    const accountId = String(url.searchParams.get('accountId') || state.activeAccountId || '').trim();
    const thread = resolveThreadRecord(state, threadId, accountId) || resolveThreadRecord(state, threadId);
    if (!thread) return json(res, 404, { ok: false, error: 'Không tìm thấy hội thoại' });
    return json(res, 200, { ok: true, threadId, messages: thread.messages || [] });
  }

  if (req.method === 'POST' && url.pathname === '/api/threads/read') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadAccess(principal, body.threadId);
      await provider.markThreadRead(body.threadId);
      emitEvent('thread.meta_updated', { threadId: body.threadId, action: 'read', view: buildView(store.read()) });
      return { ok: true };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/threads/unread') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadAccess(principal, body.threadId);
      if (typeof provider.markThreadUnread !== 'function') throw new Error('Provider không hỗ trợ đánh dấu chưa đọc');
      await provider.markThreadUnread(body.threadId);
      emitEvent('thread.meta_updated', { threadId: body.threadId, action: 'unread', view: buildView(store.read()) });
      return { ok: true };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/threads/pin') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, body.threadId);
      if (typeof provider.setConversationPinned !== 'function') throw new Error('Provider không hỗ trợ ghim hội thoại');
      await provider.setConversationPinned(body.threadId, body.pinned !== false);
      return { ok: true };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/threads/archive') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, body.threadId);
      if (typeof provider.setConversationArchived !== 'function') throw new Error('Provider không hỗ trợ lưu trữ hội thoại');
      await provider.setConversationArchived(body.threadId, body.archived !== false);
      return { ok: true };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/threads/hide') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, body.threadId);
      if (typeof provider.setConversationHidden !== 'function') throw new Error('Provider không hỗ trợ ẩn hội thoại');
      await provider.setConversationHidden(body.threadId, body.hidden !== false);
      return { ok: true };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/threads/mute') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, body.threadId);
      if (typeof provider.setConversationMuted !== 'function') throw new Error('Provider không hỗ trợ tắt thông báo');
      await provider.setConversationMuted(body.threadId, body.muted !== false);
      return { ok: true };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/threads/delete') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, body.threadId);
      if (typeof provider.deleteConversation !== 'function') throw new Error('Provider không hỗ trợ xoá đoạn chat');
      await provider.deleteConversation(body.threadId);
      return { ok: true };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/threads/auto-delete') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, body.threadId);
      if (typeof provider.setConversationAutoDelete !== 'function') throw new Error('Provider không hỗ trợ tự xoá tin');
      await provider.setConversationAutoDelete(body.threadId, Number(body.ttl) || 0);
      return { ok: true };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/threads/meta') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, body.threadId);
      const normalizedTags = Array.isArray(body.tags) ? uniqueStrings(body.tags) : null;
      if (normalizedTags && typeof provider.updateThreadTags === 'function') {
        await provider.updateThreadTags(body.threadId, normalizedTags);
      }
      const next = store.update((draft) => {
        const thread = draft.threads[body.threadId];
        if (!thread) throw new Error('Không tìm thấy hội thoại');
        if (typeof body.assignee === 'string' || body.assignee === null) thread.assignee = body.assignee;
        if (typeof body.notes === 'string') thread.notes = body.notes;
        if (normalizedTags) thread.tags = normalizedTags;
        return draft;
      });
      emitEvent('thread.meta_updated', { threadId: body.threadId, view: buildView(store.read()) });
      return { ok: true };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/threads/rename') {
    const principal = getRequiredAuth(req);
    const body = await readJsonBody(req);
    return handleAction(res, async () => {
      if (!body.threadId) throw new Error('Thiếu threadId');
      assertThreadManageAccess(principal, body.threadId);
      if (typeof provider.renameThread !== 'function') throw new Error('Provider không hỗ trợ đổi tên');
      const result = await provider.renameThread(body.threadId, body.name || '');
      emitEvent('thread.meta_updated', { threadId: body.threadId, view: buildView(store.read()) });
      return { ok: true, ...result };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sync/bootstrap') {
    const principal = getRequiredAuth(req);
    requireAdminAccess(principal);
    return handleAction(res, async () => {
      await provider.bootstrapSync();
      return { ok: true };
    });
  }

  if (req.method === 'GET' && ['/portal', '/portal/', '/portal/index.html'].includes(url.pathname) && !isAuthenticated(req)) {
    return html(res, 401, renderPortalAuthWall());
  }

  return serveStatic(url.pathname, res);
}

server.listen(port, () => {
  console.log(`[zalo-user-server] listening on http://localhost:${port}`);
  console.log(`[zalo-user-server] provider=${providerName} dataDir=${dataDir}`);
});

function createProvider(name, storeRef, emit) {
  if (name === 'zalo-web') return new ZaloWebProvider(storeRef, emit);
  return new MockProvider(storeRef, emit);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function resolveDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return path.join(rootDir, 'data');
  return path.isAbsolute(configured) ? configured : path.join(rootDir, configured);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function jsonCached(res, status, payload, cacheKey = '') {
  const body = cacheKey ? getCachedJsonBody(cacheKey, payload) : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const STATE_PREVIEW_MESSAGE_COUNT = 2;

function buildScopedViewBodyCacheKey(state, principal, portalState, requestedThreadId = '') {
  const stateRevision = getStateRevision(state);
  const portalRevision = getPortalStateRevision(portalState);
  const roles = (principal?.roles || []).map(String).sort().join(',');
  const permissions = (principal?.permissions || []).map(String).sort().join(',');
  const departments = (principal?.departmentIds || []).map(String).sort().join(',');
  const identity = [String(principal?.userId || ''), String(principal?.username || ''), roles, permissions, departments].join('|');
  return `state:${stateRevision}:${portalRevision}:${identity}:${String(requestedThreadId || '')}`;
}

function trimStatePayloadForRequestedThread(payload, requestedThreadId = '') {
  if (!payload || typeof payload !== 'object') return payload;
  const requestedId = String(requestedThreadId || '').trim();
  const threads = Array.isArray(payload.threads) ? payload.threads : [];
  const selectedThreadId = threads.some((thread) => String(thread.id) === requestedId)
    ? requestedId
    : String(threads[0]?.id || '').trim();
  const nextPayload = {
    ...payload,
    threads: threads.map((thread) => {
      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      const keepFull = String(thread.id) === selectedThreadId;
      const nextMessages = keepFull ? messages : messages.slice(-STATE_PREVIEW_MESSAGE_COUNT);
      return {
        ...thread,
        messages: nextMessages,
        messagesTruncated: !keepFull && messages.length > nextMessages.length,
      };
    }),
  };
  if (!requestedId) return nextPayload;
  delete nextPayload.aiAutomation;
  delete nextPayload.aiAutomationByDepartment;
  delete nextPayload.aiAutomationUsage;
  delete nextPayload.aiAutomationLogs;
  return nextPayload;
}

function getCachedJsonBody(cacheKey, payload) {
  if (scopedViewBodyCache.has(cacheKey)) {
    return scopedViewBodyCache.get(cacheKey);
  }
  const body = JSON.stringify(payload);
  scopedViewBodyCache.set(cacheKey, body);
  while (scopedViewBodyCache.size > SCOPED_VIEW_BODY_CACHE_LIMIT) {
    const oldestKey = scopedViewBodyCache.keys().next().value;
    if (!oldestKey) break;
    scopedViewBodyCache.delete(oldestKey);
  }
  return body;
}

function writeUnhandledError(res, error) {
  const statusCode = Number(error?.statusCode || error?.status || 500);
  const safeStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
  const message = error?.message || String(error || 'Internal Server Error');
  if (res.headersSent) {
    res.end();
    return;
  }
  return json(res, safeStatus, { ok: false, error: safeStatus >= 500 ? 'Internal Server Error' : message });
}

function isAuthenticated(req) {
  return Boolean(getAuthSession(req));
}

function getRequiredAuth(req) {
  const principal = getAuthSession(req);
  if (!principal) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
  return principal;
}

function getCompatApiPrincipal(req) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
  const headerToken = String(req.headers['x-compat-api-key'] || req.headers['x-bot-api-secret-token'] || '').trim();
  const provided = bearer || headerToken;
  if (!provided) return null;
  const integrationSecret = String(store.read()?.integration?.webhookSecret || '').trim();
  const envSecret = String(process.env.COMPAT_API_TOKEN || '').trim();
  const expected = envSecret || integrationSecret;
  if (!expected || provided !== expected) return null;
  return enrichPrincipal({
    id: 'compat-api',
    username: 'compat-api',
    role: 'admin',
    roles: ['admin'],
    departmentIds: []
  }, portalStore.read());
}

function getChiHomeLookupPrincipal(req) {
  const compat = getCompatApiPrincipal(req);
  if (compat) return compat;
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const provided = String(
    req.headers['x-chihome-bridge-secret']
    || req.headers['x-booking-bridge-secret']
    || url.searchParams.get('secret')
    || ''
  ).trim();
  const acceptedSecrets = new Set([chiHomeBookingBridgeSecret, '5804'].filter(Boolean));
  if (!provided || !acceptedSecrets.has(provided)) return null;
  return enrichPrincipal({
    id: 'chihome-bridge',
    username: 'chihome-bridge',
    role: 'admin',
    roles: ['admin'],
    departmentIds: []
  }, portalStore.read());
}

function getRequiredChiHomeLookupAuth(req) {
  const principal = getChiHomeLookupPrincipal(req) || getAuthSession(req);
  if (!principal) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
  return principal;
}

function getRequiredCompatAuth(req) {
  const principal = getCompatApiPrincipal(req) || getAuthSession(req);
  if (!principal) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
  return principal;
}

function getAuthSession(req) {
  applyRolePermissionsConfig();
  const principal = resolveRequestPrincipal(req, {
    jwtSecret: portalConfig.jwtSecret,
    legacySessions: authSessions,
    legacyRole: 'admin'
  });
  return enrichPrincipal(principal, portalStore.read());
}

function applyRolePermissionsConfig() {
  setRolePermissionsOverride(portalStore.read()?.settings?.rolePermissions || null);
}

function readSessionToken(req) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(/;\s*/)) {
    if (part.startsWith('zalo_sid=')) {
      return decodeURIComponent(part.slice('zalo_sid='.length));
    }
  }
  return null;
}

function createSessionToken(username) {
  const raw = `${username}.${Date.now()}.${crypto.randomBytes(24).toString('hex')}`;
  const token = crypto.createHmac('sha256', sessionSecret).update(raw).digest('hex');
  authSessions.set(token, {
    username,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
  });
  return token;
}

function resolvePortalCookieDomain(req) {
  const host = String(req?.headers?.host || '').split(':')[0].toLowerCase();
  if (!host) return portalConfig.cookieDomain;
  if (host === '127.0.0.1' || host === 'localhost') return null;
  if (host.endsWith('.tehui.io.vn') || host === 'tehui.io.vn') return portalConfig.cookieDomain;
  return null;
}

function resolvePortalCookieSecure(req) {
  const host = String(req?.headers?.host || '').split(':')[0].toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost') return false;
  return portalConfig.cookieSecure;
}

function buildLegacySessionCookie(token) {
  return `zalo_sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;
}

function buildLegacyLogoutCookie() {
  return 'zalo_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', buildLegacySessionCookie(token));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', buildLegacyLogoutCookie());
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isInitialAdminSetupRequired(portalState) {
  return !Array.isArray(portalState?.users) || portalState.users.length === 0;
}

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function selectBestChihomeThreadMatch(items = [], normalizedPhone = '') {
  const list = Array.isArray(items) ? items : [];
  const exact = list.find((item) => normalizePhoneDigits(item?.phoneNumber) === normalizedPhone);
  const target = exact || (list.length === 1 ? list[0] : null);
  if (!target) return null;
  return {
    threadId: String(target.id || '').trim(),
    displayName: String(target.displayName || '').trim(),
    username: String(target.username || '').trim(),
    phoneNumber: String(target.phoneNumber || '').trim(),
    avatarUrl: String(target.avatarUrl || '').trim(),
    zaloName: String(target.zaloName || '').trim(),
    globalId: String(target.globalId || '').trim(),
    isFriend: target.isFriend === true,
    isRequested: target.isRequested === true,
    isRequesting: target.isRequesting === true,
    matchedBy: exact ? 'phone' : 'single-result'
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const value = String(storedHash || '');
  if (!value.startsWith('scrypt$')) return false;
  const [, salt, expected] = value.split('$');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return safeEqual(actual, expected);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleAction(res, fn) {
  try {
    return json(res, 200, await fn());
  } catch (error) {
    const statusCode = Number(error?.statusCode || error?.status || 400);
    return json(res, statusCode >= 400 && statusCode < 600 ? statusCode : 400, { ok: false, error: error.message || String(error) });
  }
}

function assertThreadAccess(principal, threadId) {
  if (hasPortalAdminAccess(principal)) return true;
  const scopedView = buildScopedView(store.read(), principal, portalStore.read());
  const visibleIds = new Set([
    ...((scopedView.threads || []).map((thread) => String(thread.id))),
    ...((scopedView.searchableThreads || []).map((thread) => String(thread.id)))
  ]);
  if (visibleIds.has(String(threadId))) return true;
  const error = new Error('Forbidden: hội thoại ngoài phạm vi được phép');
  error.statusCode = 403;
  throw error;
}

function assertAccountAccess(principal, accountId, portalState, appState) {
  if (hasPortalAdminAccess(principal)) return true;
  const visibleIds = new Set(resolveVisibleAccountIds(appState?.accounts ? Object.values(appState.accounts) : [], principal, portalState));
  if (visibleIds.has(String(accountId || ''))) return true;
  const error = new Error('Forbidden: account ngoài phạm vi được cấp');
  error.statusCode = 403;
  throw error;
}

function assertThreadManageAccess(principal, threadId) {
  requireAnyPermission(principal, ['conversations.assign', 'conversations.transfer']);
  assertThreadAccess(principal, threadId);
}

function resolveThreadRecord(state, threadId, accountId = null) {
  const requestedKey = String(accountId || '').trim();
  const key = String(accountId || state?.activeAccountId || '').trim();
  const targetThreadId = String(threadId || '').trim();
  if (!targetThreadId) return null;
  if (requestedKey) {
    const scoped = state?.accountStateById?.[requestedKey] || null;
    const scopedThread = scoped?.threads?.[targetThreadId] || null;
    if (scopedThread) {
      return {
        ...scopedThread,
        messages: Array.isArray(scoped?.messages?.[targetThreadId]) ? structuredClone(scoped.messages[targetThreadId]) : []
      };
    }
  }
  if (!key || key === String(state?.activeAccountId || '')) {
    const thread = state?.threads?.[targetThreadId] || null;
    if (!thread) return null;
    return {
      ...thread,
      messages: Array.isArray(state?.messages?.[targetThreadId]) ? structuredClone(state.messages[targetThreadId]) : []
    };
  }
  const scoped = state?.accountStateById?.[key] || null;
  const thread = scoped?.threads?.[targetThreadId] || null;
  if (!thread) return null;
  return {
    ...thread,
    messages: Array.isArray(scoped?.messages?.[targetThreadId]) ? structuredClone(scoped.messages[targetThreadId]) : []
  };
}

function computeAutomationResumeAt({ minutes = null, hours = null, now = Date.now(), requestedMode = 'off' } = {}) {
  if (String(requestedMode) !== 'snoozed') return null;
  const mins = Number(minutes);
  const hrs = Number(hours);
  const totalMinutes = Math.max(
    0,
    (Number.isFinite(hrs) && hrs > 0 ? hrs * 60 : 0)
      + (Number.isFinite(mins) && mins > 0 ? mins : 0)
  ) || 30;
  return new Date(Number(now) + (totalMinutes * 60 * 1000)).toISOString();
}

function resolveThreadMemoryRows(automation = {}) {
  const rows = Array.isArray(automation?.memoryRows) ? automation.memoryRows.filter((item) => item && typeof item === 'object') : [];
  if (rows.length) return rows;
  if (automation?.memoryClearedAt) return [];
  const fallback = [];
  const intent = String(automation?.conversationMemory?.lastIntent || '').trim() || null;
  const updatedAt = automation?.conversationMemory?.updatedAt || null;
  const lastCustomerMessage = String(automation?.conversationMemory?.lastCustomerMessage || '').trim();
  const lastReply = String(automation?.conversationMemory?.lastReply || '').trim();
  if (lastCustomerMessage) fallback.push({ id: 'legacy-customer', scope: 'conversation', kind: 'customer', intent, text: lastCustomerMessage, createdAt: updatedAt });
  if (lastReply) fallback.push({ id: 'legacy-reply', scope: 'conversation', kind: 'reply', intent, text: lastReply, createdAt: updatedAt });
  return fallback;
}

function rebuildAgentMemoriesFromRows(rows = [], currentAgentMemories = {}, now = Date.now()) {
  const ordered = Array.isArray(rows) ? rows.filter((item) => item && typeof item === 'object') : [];
  if (!ordered.length) return {};
  const next = {};
  for (const row of ordered) {
    const agentId = String(row.agentId || '').trim();
    if (!agentId) continue;
    const previous = next[agentId] || currentAgentMemories?.[agentId] || {};
    next[agentId] = {
      ...previous,
      summary: String(row.text || '').trim() || previous.summary || null,
      lastIntent: row.intent || previous.lastIntent || null,
      updatedAt: row.createdAt || new Date(now).toISOString()
    };
  }
  return next;
}

function rebuildConversationMemoryFromRows(rows = [], currentConversationMemory = {}, now = Date.now()) {
  const ordered = Array.isArray(rows) ? [...rows] : [];
  const lastCustomer = [...ordered].reverse().find((item) => item?.kind === 'customer');
  const lastReply = [...ordered].reverse().find((item) => item?.kind === 'reply');
  const lastIntent = [...ordered].reverse().find((item) => item?.intent)?.intent || null;
  const updatedAt = [...ordered].reverse().find((item) => item?.createdAt)?.createdAt || currentConversationMemory?.updatedAt || new Date(now).toISOString();
  const summary = [
    lastIntent ? `Intent gần nhất: ${lastIntent}` : '',
    lastCustomer?.text ? `Khách hỏi: ${lastCustomer.text}` : '',
    lastReply?.text ? `Đã trả lời: ${lastReply.text}` : ''
  ].filter(Boolean).join(' | ');
  return {
    ...currentConversationMemory,
    lastIntent,
    lastCustomerMessage: lastCustomer?.text || null,
    lastReply: lastReply?.text || null,
    summary: summary || null,
    updatedAt
  };
}

function saveKnowledgeUploads(uploads, baseDir, options = {}) {
  const knowledgeDir = path.join(baseDir, 'ai-knowledge');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  const target = String(options.target || 'rag').trim() || 'rag';
  const tags = [...new Set((Array.isArray(options.tags) ? options.tags : []).map((item) => String(item || '').trim()).filter(Boolean))];
  return (uploads || []).map((upload) => {
    const name = sanitizeUploadName(upload?.name || 'knowledge.bin');
    const contentType = String(upload?.contentType || 'application/octet-stream');
    const buffer = Buffer.from(String(upload?.data || ''), 'base64');
    if (!buffer.length) throw new Error(`Tài liệu ${name} rỗng hoặc không hợp lệ`);
    if (buffer.length > MAX_UPLOAD_FILE_BYTES) throw new Error(`Tài liệu ${name} vượt quá giới hạn 25MB`);
    const storagePath = path.join(knowledgeDir, `${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
    fs.writeFileSync(storagePath, buffer);
    const parsed = extractKnowledgeDocument(buffer, name, contentType);
    return {
      id: `knowledge_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      name,
      contentType,
      size: buffer.length,
      target,
      ingestMode: target === 'vector' ? 'vector_db' : 'rag',
      status: target === 'vector' ? 'pending_embedding_config' : 'ready_for_chunking',
      tags,
      uploadedAt: new Date().toISOString(),
      storagePath,
      summary: parsed.summary,
      previewText: parsed.previewText,
      parseMeta: parsed.meta
    };
  });
}

function extractKnowledgeDocument(buffer, name, contentType) {
  const lowerName = String(name || '').toLowerCase();
  const type = String(contentType || '').toLowerCase();
  if (lowerName.endsWith('.csv') || type.includes('csv')) return extractCsvKnowledge(buffer);
  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xlsm') || lowerName.endsWith('.xls')) return extractSpreadsheetKnowledge(buffer);
  if (lowerName.endsWith('.json') || type.includes('json')) return extractJsonKnowledge(buffer);
  if (type.startsWith('text/') || /\.(txt|md|markdown|log)$/i.test(lowerName)) return extractTextKnowledge(buffer);
  return {
    summary: 'Tệp đã được lưu, chờ pipeline parse chuyên sâu.',
    previewText: '',
    meta: { detectedType: 'binary', parser: 'none' }
  };
}

function extractTextKnowledge(buffer) {
  const text = safeUtf8(buffer);
  return {
    summary: `Đã đọc ${text.length} ký tự văn bản.`,
    previewText: trimPreview(text, 1800),
    meta: {
      detectedType: 'text',
      parser: 'utf8',
      charCount: text.length,
      lineCount: text ? text.split(/\r?\n/).length : 0
    }
  };
}

function extractJsonKnowledge(buffer) {
  const text = safeUtf8(buffer);
  try {
    const parsed = JSON.parse(text);
    const preview = JSON.stringify(parsed, null, 2);
    return {
      summary: `JSON hợp lệ (${Array.isArray(parsed) ? parsed.length : Object.keys(parsed || {}).length} mục cấp đầu).`,
      previewText: trimPreview(preview, 1800),
      meta: {
        detectedType: 'json',
        parser: 'json',
        topLevel: Array.isArray(parsed) ? 'array' : typeof parsed,
        itemCount: Array.isArray(parsed) ? parsed.length : Object.keys(parsed || {}).length
      }
    };
  } catch {
    return {
      summary: 'JSON chưa parse được hoàn toàn, đã lưu raw text để xử lý sau.',
      previewText: trimPreview(text, 1800),
      meta: { detectedType: 'json', parser: 'raw-text' }
    };
  }
}

function extractCsvKnowledge(buffer) {
  const text = safeUtf8(buffer);
  const rows = text.split(/\r?\n/).filter(Boolean).slice(0, 12).map((line) => line.split(',').map((item) => item.trim()));
  const header = rows[0] || [];
  const preview = rows.map((row) => row.join(' | ')).join('\n');
  return {
    summary: `CSV có khoảng ${Math.max(text.split(/\r?\n/).filter(Boolean).length - 1, 0)} dòng dữ liệu và ${header.length} cột.`,
    previewText: trimPreview(preview, 1800),
    meta: {
      detectedType: 'csv',
      parser: 'simple-csv',
      columnCount: header.length,
      header,
      sampleRows: Math.max(rows.length - 1, 0)
    }
  };
}

function extractSpreadsheetKnowledge(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetSummaries = [];
  const previewBlocks = [];
  for (const sheetName of workbook.SheetNames.slice(0, 4)) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }).slice(0, 8);
    const columnCount = Math.max(0, ...rows.map((row) => Array.isArray(row) ? row.length : 0));
    sheetSummaries.push({ name: sheetName, rows: rows.length, columns: columnCount });
    previewBlocks.push(`## ${sheetName}\n${rows.map((row) => (Array.isArray(row) ? row.join(' | ') : '')).join('\n')}`);
  }
  return {
    summary: `Excel có ${workbook.SheetNames.length} sheet: ${workbook.SheetNames.join(', ')}.`,
    previewText: trimPreview(previewBlocks.join('\n\n'), 2000),
    meta: {
      detectedType: 'spreadsheet',
      parser: 'xlsx',
      sheetCount: workbook.SheetNames.length,
      sheets: sheetSummaries
    }
  };
}

function safeUtf8(buffer) {
  return String(buffer.toString('utf8') || '').replace(/\u0000/g, '').trim();
}

function trimPreview(text, limit = 1600) {
  const clean = String(text || '').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}…`;
}

function buildThreadBindingKey(threadId, accountId = null) {
  const normalizedThreadId = String(threadId || '').trim();
  const normalizedAccountId = String(accountId || '').trim();
  if (!normalizedThreadId) return '';
  return normalizedAccountId ? `${normalizedAccountId}:${normalizedThreadId}` : normalizedThreadId;
}

function dropLegacyThreadBinding(draft, threadId, accountId = null) {
  const normalizedThreadId = String(threadId || '').trim();
  const normalizedAccountId = String(accountId || '').trim();
  if (!normalizedThreadId || !normalizedAccountId) return;
  const legacyKey = buildThreadBindingKey(normalizedThreadId);
  const scopedKey = buildThreadBindingKey(normalizedThreadId, normalizedAccountId);
  if (legacyKey && legacyKey !== scopedKey && draft?.threadBindings?.[legacyKey]) {
    delete draft.threadBindings[legacyKey];
  }
}

function cleanupPortalBindingsAgainstState() {
  const appState = store.read();
  const portalState = portalStore.read();
  const validUserIds = new Set((portalState.users || []).flatMap((user) => [String(user.id || ''), String(user.username || '')]).filter(Boolean));
  const channelsById = new Map((portalState.channels || []).flatMap((channel) => [
    [String(channel.id || '').trim(), channel],
    [String(channel.code || '').trim(), channel],
    [String(channel.accountId || '').trim(), channel]
  ]).filter(([key]) => key));
  const scopedThreadKeys = new Set();
  const threadIds = new Set();
  for (const [accountId, account] of Object.entries(appState.accounts || {})) {
    for (const threadId of Object.keys(account?.threads || {})) {
      scopedThreadKeys.add(buildThreadBindingKey(threadId, accountId));
      threadIds.add(String(threadId));
    }
  }
  let removed = 0;
  let updated = 0;
  portalStore.update((draft) => {
    for (const [key, binding] of Object.entries(draft.threadBindings || {})) {
      const threadId = String(binding?.threadId || '').trim();
      const accountId = String(binding?.accountId || '').trim();
      const scopedKey = buildThreadBindingKey(threadId, accountId);
      const exists = accountId ? scopedThreadKeys.has(scopedKey) : threadIds.has(threadId);
      if (!threadId || !exists) {
        delete draft.threadBindings[key];
        removed += 1;
        continue;
      }
      if (!accountId && Object.prototype.hasOwnProperty.call(draft.threadBindings || {}, buildThreadBindingKey(threadId, findBindingAccountId(draft.threadBindings || {}, threadId)))) {
        delete draft.threadBindings[key];
        removed += 1;
        continue;
      }
      const assignedUserId = String(binding?.assignedUserId || '').trim();
      if (assignedUserId && !validUserIds.has(assignedUserId)) {
        binding.assignedUserId = null;
        if (String(binding.queueStatus || '') === 'open') binding.queueStatus = 'pending';
        updated += 1;
      }
      const channel = channelsById.get(String(binding?.channelId || '').trim()) || null;
      const channelDepartmentId = String(channel?.departmentId || '').trim();
      if (channelDepartmentId && String(binding?.departmentId || '').trim() && String(binding.departmentId).trim() !== channelDepartmentId) {
        binding.departmentId = channelDepartmentId;
        updated += 1;
      }
    }
    return draft;
  });
  if (removed || updated) {
    console.info(`[zalo-user-server] cleaned portal bindings: removed=${removed} updated=${updated}`);
  }
}

function findBindingAccountId(bindings, threadId) {
  const normalizedThreadId = String(threadId || '').trim();
  for (const binding of Object.values(bindings || {})) {
    if (String(binding?.threadId || '').trim() !== normalizedThreadId) continue;
    const accountId = String(binding?.accountId || '').trim();
    if (accountId) return accountId;
  }
  return '';
}

function resolvePortalThreadBinding(portalState, threadId, accountId = null) {
  const bindings = portalState?.threadBindings || {};
  const scopedKey = buildThreadBindingKey(threadId, accountId);
  return (scopedKey && bindings[scopedKey]) || bindings[String(threadId || '').trim()] || null;
}

function findPortalChannelByAccountId(portalState, accountId) {
  const targetId = String(accountId || '').trim();
  if (!targetId) return null;
  return (portalState?.channels || []).find((item) => [item?.accountId, item?.code, item?.id].map((value) => String(value || '').trim()).includes(targetId)) || null;
}

function getAiAutomationDepartmentIdForThread(threadId, accountId) {
  const portalState = portalStore.read();
  const binding = resolvePortalThreadBinding(portalState, threadId, accountId) || null;
  const bindingDepartmentId = String(binding?.departmentId || '').trim();
  const bindingChannelId = String(binding?.channelId || '').trim();
  const accountChannel = findPortalChannelByAccountId(portalState, accountId) || null;
  const accountChannelIds = [accountChannel?.id, accountChannel?.code, accountChannel?.accountId].map((value) => String(value || '').trim()).filter(Boolean);
  if (bindingDepartmentId) {
    if (!accountChannelIds.length || !bindingChannelId || accountChannelIds.includes(bindingChannelId)) return bindingDepartmentId;
  }
  return String(accountChannel?.departmentId || '').trim() || bindingDepartmentId || null;
}

function getAiAutomationConfigForDepartment(state, departmentId = null) {
  return resolveAiAutomationConfigForDepartment({
    aiAutomation: state?.aiAutomation || {},
    aiAutomationByDepartment: state?.aiAutomationByDepartment || {},
    departmentId
  });
}

function setAiAutomationConfigForDepartment(draft, departmentId, payload) {
  const key = String(departmentId || '').trim();
  const fallback = normalizeAiAutomationConfig(draft.aiAutomation || {});
  if (!key) {
    draft.aiAutomation = normalizeAiAutomationConfig(payload, fallback);
    return;
  }
  draft.aiAutomationByDepartment = normalizeAiAutomationDepartmentMap(draft.aiAutomationByDepartment || {}, fallback);
  draft.aiAutomationByDepartment[key] = normalizeAiAutomationConfig(payload, fallback);
}

function findPortalDepartment(portalState, departmentId) {
  const targetId = String(departmentId || '').trim();
  if (!targetId) return null;
  return (portalState?.departments || []).find((item) => [item?.id, item?.code, item?.name].map((value) => String(value || '').trim()).includes(targetId)) || null;
}

function isChiHomeDepartment(channel, department) {
  const haystack = [
    channel?.departmentId,
    department?.id,
    department?.code,
    department?.name,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  return haystack.includes('chihome');
}

function buildChiHomeBookingBridgeUrl({ threadId, accountId }) {
  if (!chiHomeBookingBridgeSecret) {
    const error = new Error('CHIHOME_BOOKING_BRIDGE_SECRET chưa được cấu hình');
    error.statusCode = 503;
    throw error;
  }
  const source = 'zalo';
  const safeAccountId = String(accountId || '').trim();
  const safeThreadId = String(threadId || '').trim();
  const nonce = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const draftKey = `${safeAccountId}:${safeThreadId}:${nonce}`;
  const expires = String(Date.now() + 4 * 60 * 60 * 1000);
  const payload = [source, safeThreadId, safeAccountId, draftKey, expires].join('|');
  const sig = crypto.createHmac('sha256', chiHomeBookingBridgeSecret).update(payload).digest('hex');
  const bridgeUrl = new URL(chiHomeBookingBridgeBaseUrl);
  bridgeUrl.searchParams.set('source', source);
  bridgeUrl.searchParams.set('threadId', safeThreadId);
  bridgeUrl.searchParams.set('accountId', safeAccountId);
  bridgeUrl.searchParams.set('draftKey', draftKey);
  bridgeUrl.searchParams.set('expires', expires);
  bridgeUrl.searchParams.set('sig', sig);
  bridgeUrl.searchParams.set('nonce', nonce);
  return bridgeUrl.toString();
}

function assertPortalChannelAccess(portalState, departmentId, channelId) {
  if (!channelId) return null;
  const channel = (portalState.channels || []).find((item) => [item.id, item.code].map((value) => String(value || '')).includes(String(channelId)));
  if (!channel) {
    const error = new Error('Forbidden: channel không tồn tại trong portal');
    error.statusCode = 403;
    throw error;
  }
  if (String(channel.departmentId || '') !== String(departmentId || '')) {
    const error = new Error('Forbidden: channel ngoài department được chọn');
    error.statusCode = 403;
    throw error;
  }
  return channel;
}

function assertAssignablePortalUser(portalState, userId, departmentId, channelId = null) {
  const user = (portalState.users || []).find((item) => [item.id, item.username].map((value) => String(value || '')).includes(String(userId)));
  if (!user || user.active === false) {
    const error = new Error('Forbidden: nhân viên được gán không tồn tại hoặc đã tắt');
    error.statusCode = 403;
    throw error;
  }
  if (!(user.roles || []).map(String).includes('staff')) {
    const error = new Error('Forbidden: chỉ được gán hội thoại cho staff');
    error.statusCode = 403;
    throw error;
  }
  if (!(user.departmentIds || []).map(String).includes(String(departmentId || ''))) {
    const error = new Error('Forbidden: staff được gán ngoài department');
    error.statusCode = 403;
    throw error;
  }
  const channel = assertPortalChannelAccess(portalState, departmentId, channelId);
  const allowedMemberIds = normalizeChannelMemberIds(channel?.members || []);
  if (allowedMemberIds.size && !allowedMemberIds.has(String(user.id)) && !allowedMemberIds.has(String(user.username || ''))) {
    const error = new Error('Forbidden: staff được gán ngoài channel');
    error.statusCode = 403;
    throw error;
  }
  return user;
}

function openEventStream(req, res) {
  const principal = getRequiredAuth(req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const client = { res, principal };
  res.write('retry: 3000\n\n');
  res.write(`event: snapshot\ndata: ${JSON.stringify(buildScopedView(store.read(), principal, portalStore.read()))}\n\n`);
  clients.add(client);
  const heartbeat = setInterval(() => {
    try {
      res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
      clientHeartbeats.delete(res);
      clients.delete(client);
    }
  }, 15000);
  clientHeartbeats.set(res, heartbeat);
  req.on('close', () => {
    clearInterval(heartbeat);
    clientHeartbeats.delete(res);
    clients.delete(client);
  });
}

function emitEvent(type, payload) {
  if (type === 'message.created') {
    payload = applyPortalRoutingOnIncoming(payload);
    const bridgeAccountId = String(payload?.accountId || payload?.view?.activeAccountId || store.read().activeAccountId || '').trim();
    if (!isChatbotBridgeAccount(bridgeAccountId)) {
      aiAutomationRuntime?.queueIncoming?.(payload);
    }
  }
  const portalState = portalStore.read();
  const appState = store.read();
  const accountId = String(payload?.accountId || payload?.view?.activeAccountId || appState.activeAccountId || '');
  for (const client of clients) {
    const view = buildScopedView(appState, client.principal, portalState);
    const clientPayload = buildClientScopedEventPayload(payload, view);
    if (type === 'message.created') {
      const visibleIds = new Set((view.threads || []).map((item) => String(item.id)));
      if (!visibleIds.has(String(payload?.threadId || payload?.message?.threadId || ''))) continue;
      client.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, accountId, payload: clientPayload, view })}\n\n`);
      continue;
    }
    client.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, accountId, payload: clientPayload, view })}\n\n`);
  }
}

function buildClientScopedEventPayload(payload, scopedView) {
  if (!payload || typeof payload !== 'object') return payload;
  const next = { ...payload };
  if (next.view) next.view = scopedView;
  if (next.routingPlan && !hasWildAccessForPayload(scopedView?.portal?.me)) {
    next.routingPlan = {
      action: next.routingPlan.action,
      reason: next.routingPlan.reason,
      assigneeId: next.routingPlan.assigneeId || null
    };
  }
  return next;
}

function hasWildAccessForPayload(principal) {
  return Boolean((principal?.permissions || []).includes('*') || (principal?.roles || []).includes('admin'));
}


function applyPortalRoutingOnIncoming(payload) {
  const threadId = String(payload?.threadId || payload?.message?.threadId || '');
  const message = payload?.message || null;
  if (!threadId || !message || message.isOutgoing) return payload;

  const portalState = portalStore.read();
  const settings = portalState.settings || {};
  const accountId = String(payload?.accountId || payload?.view?.activeAccountId || store.read().activeAccountId || '').trim() || null;
  const existing = resolvePortalThreadBinding(portalState, threadId, accountId) || null;
  const nextBinding = { ...(existing || {}), threadId, accountId };
  if (!nextBinding.departmentId) {
    const accountChannel = accountId ? findPortalChannelByAccountId(portalState, accountId) : null;
    if (accountChannel?.departmentId) {
      nextBinding.departmentId = String(accountChannel.departmentId);
      nextBinding.channelId = String(accountChannel.id || accountChannel.code || accountChannel.accountId || '');
      nextBinding.queueStatus = nextBinding.queueStatus || 'pending';
    } else if (settings.autoBindUnassignedThreads !== false) {
      nextBinding.departmentId = String(settings.defaultDepartmentId || 'default');
      nextBinding.queueStatus = nextBinding.queueStatus || 'pending';
    }
  }
  if (!nextBinding.channelId && nextBinding.departmentId) {
    const defaultChannel = resolveRoutingChannel(portalState, nextBinding, settings);
    if (defaultChannel?.id) nextBinding.channelId = String(defaultChannel.id);
  }
  if (!nextBinding.departmentId) return payload;

  if (settings.stickyAssignment && nextBinding.assignedUserId) {
    const sticky = (portalState.users || []).find((item) => String(item.id) === String(nextBinding.assignedUserId));
    if (sticky) {
      const stickyStatus = derivePresenceStatus({ declaredStatus: sticky.status, lastActiveAt: sticky.lastActiveAt, forceOfflineUntil: sticky.forceOfflineUntil });
      if (stickyStatus === 'online') {
        nextBinding.queueStatus = 'open';
        nextBinding.lastRoutingAction = 'assign';
        nextBinding.lastRoutingReason = 'sticky-assignment';
        nextBinding.lastRoutingContext = {
          strategy: 'sticky_assignment',
          stickyAssigneeId: sticky.id
        };
        persistThreadBinding(nextBinding, { syncThreadAssignee: true, touchUserId: sticky.id, activityAction: 'portal.thread.route.assign' });
        return { ...payload, portalBinding: nextBinding };
      }
    }
  }

  if (settings.autoRouteIncomingMessages === false && nextBinding.assignedUserId) {
    nextBinding.lastRoutingAction = 'hold';
    nextBinding.lastRoutingReason = 'auto-route-disabled';
    nextBinding.lastRoutingContext = {
      strategy: 'manual_hold'
    };
    return { ...payload, portalBinding: nextBinding };
  }

  const counts = buildOpenBindingCountMap(portalState.threadBindings || {});
  const channel = resolveRoutingChannel(portalState, nextBinding, settings) || { routingMode: settings.routingMode || 'least_connections' };
  const candidates = getEligiblePortalUsers(portalState, nextBinding.departmentId, counts, channel);
  const plan = planRouting({ channel, candidates, openConversationCounts: counts, thread: nextBinding });
  nextBinding.lastRoutingAction = plan.action;
  nextBinding.lastRoutingReason = plan.reason || null;
  nextBinding.lastRoutingContext = plan.context || null;
  if (plan.action === 'assign') {
    nextBinding.assignedUserId = String(plan.assigneeId);
    nextBinding.queueStatus = 'open';
    persistThreadBinding(nextBinding, { syncThreadAssignee: true, touchUserId: plan.assigneeId, activityAction: 'portal.thread.route.assign' });
  } else {
    nextBinding.assignedUserId = nextBinding.assignedUserId || null;
    nextBinding.queueStatus = 'pending';
    persistThreadBinding(nextBinding, { syncThreadAssignee: false, activityAction: 'portal.thread.route.queue' });
  }
  return { ...payload, portalBinding: nextBinding, routingPlan: plan };
}

function persistThreadBinding(binding, options = {}) {
  const next = portalStore.update((draft) => {
    const bindingKey = buildThreadBindingKey(binding.threadId, binding.accountId);
    draft.threadBindings[bindingKey] = {
      ...(draft.threadBindings[bindingKey] || {}),
      ...binding,
      updatedAt: new Date().toISOString()
    };
    dropLegacyThreadBinding(draft, binding.threadId, binding.accountId);
    if (options.touchUserId) {
      const user = (draft.users || []).find((item) => String(item.id) === String(options.touchUserId) || String(item.username) === String(options.touchUserId));
      if (user) user.lastAssignedAt = new Date().toISOString();
    }
    draft.updatedAt = new Date().toISOString();
    return draft;
  });
  const bindingKey = buildThreadBindingKey(binding.threadId, binding.accountId);
  const savedBinding = next.threadBindings[bindingKey];
  void portalSyncService.syncThreadBinding(savedBinding);
  void auditService.log({ actorUserId: 'system', action: 'portal.thread.autobind', resourceType: 'thread_binding', resourceId: bindingKey, payload: savedBinding });
  const activityEntry = {
    actorUserId: 'system',
    action: options.activityAction || 'portal.thread.autobind',
    resourceType: 'thread_binding',
    resourceId: bindingKey,
    departmentId: savedBinding.departmentId || null,
    payload: savedBinding
  };
  appendPortalActivity(activityEntry);
  void portalJournalService.append(activityEntry);
  if (options.syncThreadAssignee) {
    store.update((draft) => {
      if (draft.threads?.[binding.threadId]) draft.threads[binding.threadId].assignee = binding.assignedUserId || null;
      return draft;
    });
  }
}

function appendPortalActivity(entry) {
  portalStore.update((draft) => {
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      actorUserId: entry.actorUserId || 'system',
      action: entry.action || 'unknown',
      resourceType: entry.resourceType || 'resource',
      resourceId: entry.resourceId || null,
      departmentId: entry.departmentId || null,
      payload: entry.payload || {}
    };
    draft.recentActivity = [item, ...(draft.recentActivity || [])].slice(0, 100);
    draft.updatedAt = new Date().toISOString();
    return draft;
  });
}

async function recordOperationalEvent(entry) {
  appendPortalActivity(entry);
  await Promise.all([
    auditService.log(entry),
    portalJournalService.append(entry)
  ]);
}

function parseOptionalIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildOpenBindingCountMap(bindings) {
  const out = new Map();
  for (const binding of Object.values(bindings || {})) {
    if (!binding?.assignedUserId || String(binding.queueStatus || '') !== 'open') continue;
    out.set(String(binding.assignedUserId), Number(out.get(String(binding.assignedUserId)) || 0) + 1);
  }
  return out;
}

function resolveRoutingChannel(portalState, binding = {}, settings = {}) {
  const channels = (portalState.channels || []).filter((item) => item.active !== false);
  const explicitId = String(binding.channelId || settings.defaultChannelId || '').trim();
  if (explicitId) {
    const explicit = channels.find((item) => String(item.id) === explicitId || String(item.code || '') === explicitId);
    if (explicit) return explicit;
  }
  const departmentId = String(binding.departmentId || settings.defaultDepartmentId || '').trim();
  return channels.find((item) => String(item.departmentId || '') === departmentId) || null;
}

function normalizeChannelMemberIds(members = []) {
  const ids = new Set();
  for (const member of Array.isArray(members) ? members : []) {
    const value = typeof member === 'object' && member ? (member.userId || member.id || member.username) : member;
    if (value) ids.add(String(value));
  }
  return ids;
}

function findChannelMember(members = [], userId, username = '') {
  return (Array.isArray(members) ? members : []).find((member) => {
    if (!member || typeof member !== 'object') return String(member || '') === String(userId) || String(member || '') === String(username || '');
    return [member.userId, member.id, member.username].map((item) => String(item || '')).includes(String(userId)) || (username && [member.userId, member.id, member.username].map((item) => String(item || '')).includes(String(username)));
  }) || null;
}

function isPortalRoutingEligibleUser(user) {
  if (!user || user.active === false) return false;
  return hasPermission(user, 'conversations.reply');
}

function getEligiblePortalUsers(portalState, departmentId, counts, channel = null) {
  const allowedMemberIds = normalizeChannelMemberIds(channel?.members || []);
  return (portalState.users || [])
    .filter((item) => item.active !== false && (item.departmentIds || []).map(String).includes(String(departmentId)))
    .filter((item) => isPortalRoutingEligibleUser(item))
    .filter((item) => !allowedMemberIds.size || allowedMemberIds.has(String(item.id)) || allowedMemberIds.has(String(item.username || '')))
    .map((item) => {
      const channelMember = findChannelMember(channel?.members || [], item.id, item.username);
      const maxOpen = Number(channelMember?.maxOpenConversations || item.maxOpenConversations || 20);
      return {
        id: item.id,
        status: derivePresenceStatus({ declaredStatus: item.status, lastActiveAt: item.lastActiveAt, forceOfflineUntil: item.forceOfflineUntil }),
        forceOfflineUntilExpired: Boolean(item.forceOfflineUntil && new Date(item.forceOfflineUntil).getTime() > Date.now()),
        atCapacity: Number(counts.get(String(item.id)) || 0) >= maxOpen,
        routingWeight: Number(channelMember?.routingWeight || item.routingWeight) || 100,
        lastAssignedAt: item.lastAssignedAt
      };
    });
}

function html(res, statusCode, content) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(content);
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || '');
  return accept.includes('text/html') && !accept.includes('application/json');
}

function renderCompatDocsPage(docs) {
  const supported = (docs.supportedOperations || []).map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('');
  const credentials = (docs.credentials || []).map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('');
  const requestFields = (docs.managerRequestFields || []).map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('');
  const transportFields = (docs.managerTransportFields || []).map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('');
  const notes = (docs.notes || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const endpoints = (docs.endpoints || []).map((item) => `<tr><td><code>${escapeHtml(item.method)}</code></td><td><code>${escapeHtml(item.path)}</code></td><td>${item.auth ? 'Có' : 'Không'}</td><td>${escapeHtml(item.purpose || '')}</td></tr>`).join('');
  const endpointCurlBlocks = (docs.endpoints || []).filter((item) => item.curl).map((item) => `<section class="curl-block"><h3><code>${escapeHtml(item.method)} ${escapeHtml(item.path)}</code></h3><p>${escapeHtml(item.purpose || '')}</p><pre>${escapeHtml(item.curl || '')}</pre></section>`).join('');
  const curls = (docs.curlExamples || []).map((item) => `<section class="curl-block"><h3>${escapeHtml(item.title || '')}</h3><pre>${escapeHtml(item.command || '')}</pre></section>`).join('');
  const rawJson = escapeHtml(JSON.stringify({ ok: true, docs }, null, 2));
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Zalo User Server – Compat Docs</title>
  <style>
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; background:#0b1020; color:#e5eefc; margin:0; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 32px 20px 64px; }
    .card { background:#121a2f; border:1px solid rgba(255,255,255,0.08); border-radius:16px; padding:20px; margin-bottom:20px; box-shadow: 0 12px 32px rgba(0,0,0,0.22); }
    h1,h2,h3 { margin:0 0 12px; }
    p, li, td, th { color:#c8d5f0; line-height:1.6; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    code { background:#0a1222; padding:2px 6px; border-radius:6px; }
    pre { background:#09101d; padding:16px; border-radius:12px; overflow:auto; white-space:pre-wrap; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:16px; }
    a { color:#7dd3fc; }
    table { width:100%; border-collapse: collapse; }
    th, td { text-align:left; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.08); vertical-align:top; }
    .curl-block + .curl-block { margin-top: 16px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Zalo User Server – n8n / codedao12 compat</h1>
      <p><strong>Base URL:</strong> <code>${escapeHtml(docs.baseUrl || '')}</code></p>
      <p>Trang này là bản đọc dễ hơn của <code>/api/docs/compat</code>. Nếu cần JSON thô để feed vào tool hoặc n8n, dùng <a href="/api/docs/compat?format=json">/api/docs/compat?format=json</a>.</p>
    </div>
    <section class="card">
      <h2>Auth flow</h2>
      <p>${escapeHtml(docs.auth?.note || '')}</p>
      <ul>
        <li><code>${escapeHtml(docs.auth?.loginEndpoint || '')}</code></li>
        <li><code>${escapeHtml(docs.auth?.statusEndpoint || '')}</code></li>
      </ul>
    </section>
    <section class="card">
      <h2>Endpoints</h2>
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Mục đích</th></tr></thead>
        <tbody>${endpoints}</tbody>
      </table>
    </section>
    <div class="grid">
      <section class="card"><h2>Supported operations</h2><ul>${supported}</ul></section>
      <section class="card"><h2>Credential fields</h2><ul>${credentials}</ul></section>
      <section class="card"><h2>Webhook wrappers</h2><ul><li><code>message</code> → <code>${escapeHtml(docs.eventWrappers?.message || 'messageData')}</code></li><li><code>friend</code> → <code>${escapeHtml(docs.eventWrappers?.friend || 'friendEvent')}</code></li></ul></section>
    </div>
    <div class="grid">
      <section class="card"><h2>Manager request fields</h2><ul>${requestFields}</ul></section>
      <section class="card"><h2>Transport fields</h2><ul>${transportFields}</ul></section>
    </div>
    <section class="card"><h2>curl cho từng endpoint</h2>${endpointCurlBlocks}</section>
    <section class="card"><h2>curl examples tổng hợp</h2>${curls}</section>
    <section class="card"><h2>Notes</h2><ul>${notes}</ul></section>
    <section class="card"><h2>Raw JSON sample</h2><pre>${rawJson}</pre></section>
  </div>
</body>
</html>`;
}

function enforcePortalUserWriteScope(principal, user, portalState) {
  if (hasPortalAdminAccess(principal)) return;
  const departments = Array.isArray(user.departmentIds) ? user.departmentIds : [];
  for (const deptId of departments) assertDepartmentAccess(principal, deptId);
  const existing = (portalState.users || []).find((item) => String(item.id) === String(user.id) || String(item.username) === String(user.username));
  if (existing) {
    if ((existing.roles || []).includes('admin')) {
      const error = new Error('Forbidden: manager không được chỉnh admin');
      error.statusCode = 403;
      throw error;
    }
    for (const deptId of existing.departmentIds || []) assertDepartmentAccess(principal, deptId);
  }
  if ((user.roles || []).some((role) => role !== 'staff')) {
    const error = new Error('Forbidden: manager chỉ được tạo/cập nhật nhân viên staff');
    error.statusCode = 403;
    throw error;
  }
  if ((user.permissions || []).length) {
    const error = new Error('Forbidden: manager không được cấp quyền kỹ thuật trực tiếp');
    error.statusCode = 403;
    throw error;
  }
}

function validatePortalUserDepartments(user, portalState) {
  const departments = Array.isArray(user?.departmentIds) ? user.departmentIds.map(String).filter(Boolean) : [];
  const roles = Array.isArray(user?.roles) ? user.roles.map(String) : [];
  if (!roles.length) return;
  // Admin is global and intentionally has no department requirement.
  if (roles.includes('admin')) return;
  if (roles.includes('staff')) {
    if (departments.length !== 1) {
      const error = new Error('Nhân viên phải thuộc đúng 1 bộ phận');
      error.statusCode = 400;
      throw error;
    }
  } else if (!departments.length) {
    const error = new Error('User phải thuộc ít nhất 1 bộ phận');
    error.statusCode = 400;
    throw error;
  }
  const knownDepartments = new Set((portalState?.departments || []).map((item) => String(item.id || '')).filter(Boolean));
  for (const departmentId of departments) {
    if (!knownDepartments.has(String(departmentId))) {
      const error = new Error(`Không tồn tại bộ phận ${departmentId}`);
      error.statusCode = 400;
      throw error;
    }
  }
}

function validatePortalUserAccountAssignments(user, requestedAccountIds, portalState) {
  if (!Array.isArray(requestedAccountIds) || !requestedAccountIds.length) return;
  const allowedDepartmentIds = new Set((user?.departmentIds || []).map(String).filter(Boolean));
  const channels = Array.isArray(portalState?.channels) ? portalState.channels : [];
  for (const accountId of requestedAccountIds) {
    const channel = channels.find((item) => [item?.accountId, item?.code, item?.id].map((value) => String(value || '')).includes(String(accountId || '')));
    if (!channel) {
      const error = new Error(`Account Zalo ${accountId} chưa được gán vào bộ phận nào`);
      error.statusCode = 400;
      throw error;
    }
    if (!allowedDepartmentIds.has(String(channel.departmentId || ''))) {
      const error = new Error(`Account Zalo ${accountId} không thuộc bộ phận đã chọn cho user`);
      error.statusCode = 400;
      throw error;
    }
  }
}

function hasPortalAdminAccess(principal) {
  return Boolean((principal?.permissions || []).includes('*') || (principal?.roles || []).includes('admin'));
}

function maskPortalUser(user) {
  return {
    ...user,
    permissions: [],
    passwordHash: undefined
  };
}

function upsertById(items, nextItem) {
  const list = Array.isArray(items) ? [...items] : [];
  const index = list.findIndex((item) => String(item.id) === String(nextItem.id));
  if (index >= 0) list[index] = { ...list[index], ...nextItem };
  else list.push(nextItem);
  return list;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serveStatic(urlPath, res) {
  const relative = urlPath === '/' ? '/index.html' : (urlPath === '/portal' ? '/portal/index.html' : urlPath);
  const cleanPath = relative.split('?')[0];
  const target = path.join(publicDir, path.normalize(cleanPath));
  if (!target.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const ext = path.extname(target).toLowerCase();
  const type = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(target).pipe(res);
}

function serveUploadedFile(req, res, baseDir, fileName) {
  const safeName = path.basename(String(fileName || ''));
  if (!safeName) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const uploadDir = path.join(baseDir, 'tmp-uploads');
  const target = path.join(uploadDir, safeName);
  if (!target.startsWith(uploadDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const stat = fs.statSync(target);
  const ext = path.extname(target).toLowerCase();
  const type = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.m4v': 'video/mp4',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf'
  }[ext] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(String(range));
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < stat.size) {
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=300',
          'Content-Disposition': `inline; filename="${path.basename(target)}"`
        });
        return fs.createReadStream(target, { start, end }).pipe(res);
      }
    }
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
    'Content-Disposition': `inline; filename="${path.basename(target)}"`
  });
  return fs.createReadStream(target).pipe(res);
}

function writeUploadsToTempFiles(uploads, baseDir) {
  const uploadDir = path.join(baseDir, 'tmp-uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const paths = [];
  const meta = [];

  for (const upload of uploads || []) {
    const name = sanitizeUploadName(upload?.name || 'upload.bin');
    const contentType = String(upload?.contentType || 'application/octet-stream');
    const buffer = Buffer.from(String(upload?.data || ''), 'base64');
    if (!buffer.length) throw new Error(`Tệp ${name} rỗng hoặc không hợp lệ.`);
    if (buffer.length > MAX_UPLOAD_FILE_BYTES) throw new Error(`Tệp ${name} vượt quá giới hạn 25MB nên không thể gửi.`);
    const storedName = `${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`;
    const filePath = path.join(uploadDir, storedName);
    fs.writeFileSync(filePath, buffer);
    paths.push(filePath);
    meta.push({
      name,
      contentType,
      size: buffer.length,
      url: `/api/uploads/${encodeURIComponent(storedName)}`,
      previewUrl: contentType.startsWith('image/') ? `data:${contentType};base64,${upload.data}` : null
    });
  }

  return {
    paths,
    meta,
    cleanup() {
      for (const filePath of paths) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
  };
}

function sanitizeUploadName(value) {
  const base = path.basename(String(value || 'upload.bin')).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return base || 'upload.bin';
}

async function handleCompatManager(body, provider) {
  const operation = String(body.operation || '').trim();
  const credentialId = String(body.credential_id || body.credentialId || body.accountId || '').trim();
  const conversationId = String(body.conversationId || body.conversation_id || body.chat_id || '').trim();
  const senderId = String(body.senderId || body.sender_id || '').trim();
  const threadType = Number(body.type) === 1 || String(body.accountType || body.sender_type || '').toLowerCase() === 'group' ? 'Group' : 'User';
  const content = normalizeCompatContent(body.content || body.text || '');

  const accountOptions = credentialId ? { accountId: credentialId } : {};

  if (operation === 'send_message' || operation === 'sendMessage') {
    const attachments = await resolveCompatAttachments(body.attachmentsUrls || body.attachments_urls || '', body.base64Attachments || body.base64_attachments || '');
    const saved = writeUploadsToTempFiles(attachments, dataDir);
    try {
      return await provider.sendMessage({ threadId: conversationId, text: content, attachments: saved.paths, attachmentMeta: saved.meta, ...accountOptions });
    } finally {
      saved.cleanup();
    }
  }

  if (operation === 'send_sticker' || operation === 'sendSticker') {
    const sticker = body.sticker || {
      id: body.stickerId || body.sticker_id,
      cateId: body.cateId || body.cate_id,
      type: body.stickerType || body.sticker_type
    };
    return await provider.sendStickerMessage(conversationId, sticker, accountOptions);
  }

  if (operation === 'send_typing' || operation === 'typing') {
    return await provider.sendTypingEvent(conversationId, threadType, body.typing !== false, accountOptions);
  }

  if (operation === 'send_friend_request' || operation === 'friend_request') {
    return await provider.sendFriendRequest(senderId || conversationId, content || body.message || '', {}, accountOptions);
  }

  if (operation === 'change_alias' || operation === 'changeFriendAlias' || operation === 'rename_user') {
    return await provider.renameThread(senderId || conversationId, body.name || body.alias || content, accountOptions);
  }

  if (operation === 'change_group_name' || operation === 'changeGroupName' || operation === 'rename_group') {
    return await provider.renameThread(conversationId, body.name || content, accountOptions);
  }

  if (operation === 'set_tags' || operation === 'update_tags') {
    if (!conversationId) throw new Error('Thiếu conversationId');
    const tags = Array.isArray(body.tags)
      ? uniqueStrings(body.tags)
      : uniqueStrings(String(body.tags || body.tag || '').split(',').map((item) => item.trim()).filter(Boolean));
    await provider.updateThreadTags(conversationId, tags, credentialId || null);
    const next = store.update((draft) => {
      updateAccountScopedState(draft, credentialId || draft.activeAccountId || '', (snapshot) => {
        const thread = snapshot.threads?.[conversationId];
        if (thread) thread.tags = tags;
        return snapshot;
      });
      return draft;
    });
    emitEvent('thread.meta_updated', { threadId: conversationId, accountId: credentialId || null, view: buildView(next) });
    return { ok: true, threadId: conversationId, tags };
  }

  if (operation === 'set_thread_automation' || operation === 'thread_automation') {
    if (!conversationId) throw new Error('Thiếu conversationId');
    const requestedMode = String(body.mode || 'off').trim() || 'off';
    const now = Date.now();
    const accountId = credentialId || store.read().activeAccountId || '';
    const reason = String(body.reason || '').trim() || null;
    const next = store.update((draft) => {
      const departmentId = getAiAutomationDepartmentIdForThread(conversationId, accountId);
      const config = normalizeAiAutomationConfig(getAiAutomationConfigForDepartment(draft, departmentId));
      updateAccountScopedState(draft, accountId, (snapshot) => {
        const thread = snapshot.threads?.[conversationId];
        if (!thread) return snapshot;
        const currentAutomation = thread.automation || {};
        thread.automation = patchThreadAutomationState(currentAutomation, {
          mode: requestedMode,
          reason,
          updatedBy: 'compat-manager',
          resumeAt: null,
        }, config, now);
        return snapshot;
      });
      return draft;
    });
    emitEvent('thread.meta_updated', { threadId: conversationId, accountId, action: 'thread-automation', view: buildView(next) });
    return { ok: true, threadId: conversationId, accountId, mode: requestedMode, reason };
  }

  if (operation === 'get_thread_state' || operation === 'thread_state') {
    if (!conversationId) throw new Error('Thiếu conversationId');
    const state = store.read();
    const accountId = credentialId || state.activeAccountId || '';
    const thread = resolveThreadRecord(state, conversationId, accountId) || resolveThreadRecord(state, conversationId);
    if (!thread) throw new Error('Không tìm thấy thread');
    return {
      ok: true,
      threadId: conversationId,
      accountId: accountId || null,
      title: thread.title || '',
      tags: Array.isArray(thread.tags) ? thread.tags : [],
      automation: thread.automation || null,
      lastMessageAt: thread.lastMessageAt || null,
    };
  }

  throw new Error(`Operation chưa hỗ trợ: ${operation || '[trống]'}`);
}

function normalizeCompatContent(value) {
  const text = String(value || '');
  if (/<[^>]+>/.test(text)) {
    return text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .trim();
  }
  return text;
}

async function resolveCompatAttachments(attachmentsUrls, base64Attachments) {
  const out = [];
  for (const url of String(attachmentsUrls || '').split(',').map((item) => item.trim()).filter(Boolean)) {
    if (/^https?:\/\//i.test(url)) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Không tải được attachment URL: ${url}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      out.push({
        name: path.basename(new URL(url).pathname) || 'attachment.bin',
        contentType: res.headers.get('content-type') || 'application/octet-stream',
        data: buffer.toString('base64')
      });
    }
  }
  for (const raw of String(base64Attachments || '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const match = raw.match(/^data:([^;]+);base64,(.+)$/);
    out.push({
      name: `attachment-${out.length + 1}`,
      contentType: match?.[1] || 'application/octet-stream',
      data: match?.[2] || raw
    });
  }
  return out;
}

function buildCompatDocs() {
  return {
    baseUrl: 'https://zl.tehui.io.vn',
    auth: {
      type: 'session-cookie',
      loginEndpoint: 'POST /api/auth/login',
      statusEndpoint: 'GET /api/auth/status',
      note: 'Đăng nhập app-level trước để gọi hầu hết /api/* endpoint.'
    },
    credentials: ['nameAccount','userId','phoneNumber','cookie','imei','userAgent','proxy','supportCode','licenseKey'],
    webhookHeaders: ['x-bot-api-secret-token'],
    eventWrappers: { message: 'messageData', friend: 'friendEvent' },
    managerRequestFields: ['conversationId','content','type','replyTo','senderId','accountType','attachmentsUrls','base64Attachments'],
    managerTransportFields: ['conversation_id','sender_id','sender_type','reply_to','chat_id','credential_id','operation','last_message','last_message_type','last_message_time'],
    supportedOperations: ['send_message','send_sticker','send_typing','send_friend_request','change_alias','change_group_name'],
    endpoints: [
      { method: 'GET', path: '/api/docs/compat', auth: false, purpose: 'Xem docs HTML hoặc JSON (?format=json).', curl: `curl 'https://zl.tehui.io.vn/api/docs/compat?format=json'` },
      { method: 'POST', path: '/api/auth/login', auth: false, purpose: 'Đăng nhập để lấy session cookie.', curl: `curl -i -c cookie.txt -X POST 'https://zl.tehui.io.vn/api/auth/login' \\
  -H 'Content-Type: application/json' \\
  --data '{"username":"admin","password":"Abc@123@"}'` },
      { method: 'GET', path: '/api/auth/status', auth: false, purpose: 'Kiểm tra trạng thái đăng nhập app-level.', curl: `curl -b cookie.txt 'https://zl.tehui.io.vn/api/auth/status'` },
      { method: 'GET', path: '/api/state', auth: true, purpose: 'Lấy state hiện tại: account, threads, labels, settings...', curl: `curl -b cookie.txt 'https://zl.tehui.io.vn/api/state'` },
      { method: 'GET', path: '/api/accounts', auth: false, purpose: 'Lấy danh sách account Zalo đã login trên server.', curl: `curl 'https://zl.tehui.io.vn/api/accounts'` },
      { method: 'POST', path: '/api/accounts/select', auth: true, purpose: 'Chuyển account active theo accountId/credential_id.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/accounts/select' \\
  -H 'Content-Type: application/json' \\
  --data '{"accountId":"642007995652147887"}'` },
      { method: 'POST', path: '/api/integration/config', auth: true, purpose: 'Lưu webhook URL + secret cho n8n.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/integration/config' \\
  -H 'Content-Type: application/json' \\
  --data '{"webhookUrl":"https://n8n.example/webhook/zalo-user","webhookSecret":"abc123","enabled":true}'` },
      { method: 'GET', path: '/api/stickers/packs', auth: true, purpose: 'Lấy danh sách sticker packs.', curl: `curl -b cookie.txt 'https://zl.tehui.io.vn/api/stickers/packs'` },
      { method: 'GET', path: '/api/stickers/pack?cateId=...', auth: true, purpose: 'Lấy sticker trong một pack.', curl: `curl -b cookie.txt 'https://zl.tehui.io.vn/api/stickers/pack?cateId=12736'` },
      { method: 'GET', path: '/api/friends/search?q=...', auth: true, purpose: 'Tìm user Zalo theo query.', curl: `curl -b cookie.txt 'https://zl.tehui.io.vn/api/friends/search?q=hkithiu'` },
      { method: 'POST', path: '/api/friends/request', auth: true, purpose: 'Gửi lời mời kết bạn.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/friends/request' \\
  -H 'Content-Type: application/json' \\
  --data '{"userId":"1616036121199415594","message":"Kết bạn nhé"}'` },
      { method: 'POST', path: '/api/friends/request/undo', auth: true, purpose: 'Thu hồi lời mời kết bạn.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/friends/request/undo' \\
  -H 'Content-Type: application/json' \\
  --data '{"userId":"1616036121199415594"}'` },
      { method: 'POST', path: '/api/messages/send', auth: true, purpose: 'Gửi text/file/ảnh theo UI API hiện tại.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/messages/send' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","text":"hello from curl"}'` },
      { method: 'POST', path: '/api/messages/sticker', auth: true, purpose: 'Gửi sticker.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/messages/sticker' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","sticker":{"id":"23338","cateId":"12736","type":"gif"}}'` },
      { method: 'POST', path: '/api/messages/undo', auth: true, purpose: 'Thu hồi một tin nhắn.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/messages/undo' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","messageId":"MESSAGE_ID_HERE"}'` },
      { method: 'POST', path: '/api/messages/delete', auth: true, purpose: 'Xoá một tin nhắn phía local/UI.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/messages/delete' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","messageId":"MESSAGE_ID_HERE"}'` },
      { method: 'POST', path: '/api/messages/react', auth: true, purpose: 'Thả cảm xúc vào tin nhắn.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/messages/react' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","messageId":"MESSAGE_ID_HERE","icon":"❤"}'` },
      { method: 'POST', path: '/api/threads/read', auth: true, purpose: 'Đánh dấu đã đọc.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/threads/read' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567"}'` },
      { method: 'POST', path: '/api/threads/unread', auth: true, purpose: 'Đánh dấu chưa đọc.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/threads/unread' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567"}'` },
      { method: 'POST', path: '/api/threads/pin', auth: true, purpose: 'Ghim/bỏ ghim hội thoại.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/threads/pin' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","pinned":true}'` },
      { method: 'POST', path: '/api/threads/archive', auth: true, purpose: 'Lưu trữ/bỏ lưu trữ hội thoại.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/threads/archive' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","archived":true}'` },
      { method: 'POST', path: '/api/threads/hide', auth: true, purpose: 'Ẩn/bỏ ẩn hội thoại.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/threads/hide' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","hidden":true}'` },
      { method: 'POST', path: '/api/threads/mute', auth: true, purpose: 'Tắt/bật thông báo hội thoại.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/threads/mute' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","muted":true}'` },
      { method: 'POST', path: '/api/threads/delete', auth: true, purpose: 'Xoá đoạn chat.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/threads/delete' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567"}'` },
      { method: 'POST', path: '/api/threads/auto-delete', auth: true, purpose: 'Set auto delete cho hội thoại.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/threads/auto-delete' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","ttl":86400000}'` },
      { method: 'POST', path: '/api/threads/meta', auth: true, purpose: 'Cập nhật assignee/notes/tags local.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/threads/meta' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","assignee":"Tehui","notes":"theo dõi khách này","tags":["Khách hàng"]}'` },
      { method: 'POST', path: '/api/threads/rename', auth: true, purpose: 'Đổi alias chat 1-1 hoặc tên nhóm.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/threads/rename' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","name":"Tên mới"}'` },
      { method: 'POST', path: '/api/compat/manager', auth: true, purpose: 'Compatibility endpoint kiểu codedao12.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/compat/manager' \\
  -H 'Content-Type: application/json' \\
  --data '{"credential_id":"642007995652147887","operation":"send_message","conversationId":"5091368301797475567","content":"<p>Hello<br>compat</p>","type":1}'` },
      { method: 'POST', path: '/get/post', auth: true, purpose: 'Alias của /api/compat/manager.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/get/post' \\
  -H 'Content-Type: application/json' \\
  --data '{"credential_id":"642007995652147887","operation":"send_message","conversationId":"5091368301797475567","content":"test alias","type":1}'` },
      { method: 'POST', path: '/api/sessions/qr/start', auth: true, purpose: 'Bắt đầu flow login QR để thêm account.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/sessions/qr/start'` },
      { method: 'POST', path: '/api/sessions/qr/confirm', auth: true, purpose: 'Endpoint confirm giả lập (provider thật hiện không hỗ trợ).', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/sessions/qr/confirm'` },
      { method: 'POST', path: '/api/sync/bootstrap', auth: true, purpose: 'Sync lại dữ liệu từ Zalo.', curl: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/sync/bootstrap'` }
    ],
    curlExamples: [
      {
        title: '1) Login lấy cookie',
        command: `curl -i -c cookie.txt -X POST 'https://zl.tehui.io.vn/api/auth/login' \\
  -H 'Content-Type: application/json' \\
  --data '{"username":"admin","password":"Abc@123@"}'`
      },
      {
        title: '2) Lấy state',
        command: `curl -b cookie.txt 'https://zl.tehui.io.vn/api/state'`
      },
      {
        title: '3) Xem docs JSON',
        command: `curl 'https://zl.tehui.io.vn/api/docs/compat?format=json'`
      },
      {
        title: '4) Chuyển account active',
        command: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/accounts/select' \\
  -H 'Content-Type: application/json' \\
  --data '{"accountId":"642007995652147887"}'`
      },
      {
        title: '5) Cấu hình webhook n8n',
        command: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/integration/config' \\
  -H 'Content-Type: application/json' \\
  --data '{"webhookUrl":"https://n8n.example/webhook/zalo-user","webhookSecret":"abc123","enabled":true}'`
      },
      {
        title: '6) Gửi tin nhắn theo API hiện tại',
        command: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/messages/send' \\
  -H 'Content-Type: application/json' \\
  --data '{"threadId":"5091368301797475567","text":"hello from curl"}'`
      },
      {
        title: '7) Gửi theo compatibility endpoint kiểu codedao12',
        command: `curl -b cookie.txt -X POST 'https://zl.tehui.io.vn/api/compat/manager' \\
  -H 'Content-Type: application/json' \\
  --data '{"credential_id":"642007995652147887","operation":"send_message","conversationId":"5091368301797475567","content":"<p>Hello<br>compat</p>","type":1}'`
      },
      {
        title: '8) Search user',
        command: `curl -b cookie.txt 'https://zl.tehui.io.vn/api/friends/search?q=hkithiu'`
      }
    ],
    notes: [
      'Webhook UI accepts one n8n webhook URL and optional x-bot-api-secret-token.',
      'Message events are pushed as { messageData: rawEvent, account: {...}, account_name, account_id, zalo_name }.',
      'Friend/group/reaction/typing/undo events are pushed with raw event plus account metadata.',
      'Nếu mở docs bằng browser sẽ thấy HTML; nếu cần JSON thô thì dùng ?format=json.'
    ]
  };
}

function detectAppVersion() {
  try {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const match = html.match(/app\.js\?v=([^"']+)/i);
    if (match?.[1]) return match[1];
  } catch {
    // ignore and fall back
  }
  return String(fs.statSync(path.join(publicDir, 'app.js')).mtimeMs);
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((item) => String(item).trim()).filter(Boolean))];
}
