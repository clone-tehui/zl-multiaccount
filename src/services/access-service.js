import { buildView, getStateRevision } from '../lib/store.js';
import { getPortalStateRevision } from '../lib/portal-store.js';

const scopedViewCache = new Map();
const SCOPED_VIEW_CACHE_LIMIT = 64;

export function enrichPrincipal(principal, portalState) {
  if (!principal) return null;
  const users = Array.isArray(portalState?.users) ? portalState.users : [];
  const matched = users.find((item) => String(item.username) === String(principal.username) || String(item.id) === String(principal.userId));
  if (!matched) return principal;
  return {
    ...principal,
    userId: matched.id || principal.userId,
    username: matched.username || principal.username,
    displayName: matched.displayName || principal.displayName,
    roles: Array.isArray(matched.roles) ? matched.roles : principal.roles,
    departmentIds: Array.isArray(matched.departmentIds) ? matched.departmentIds : principal.departmentIds,
    permissions: Array.isArray(matched.permissions) ? matched.permissions : principal.permissions,
    status: matched.status || principal.status || 'offline',
    maxOpenConversations: matched.maxOpenConversations || 20,
    portalUser: matched
  };
}

export function buildScopedView(state, principal, portalState) {
  const cacheKey = buildScopedViewCacheKey(state, principal, portalState);
  if (cacheKey && scopedViewCache.has(cacheKey)) return scopedViewCache.get(cacheKey);
  const base = buildView(state);
  const activeAccountId = String(base.activeAccountId || '');
  if (!principal || hasWildAccess(principal)) {
    const result = {
      ...base,
      threads: base.threads.map((thread) => decorateThread(thread, portalState, activeAccountId)),
      searchableThreads: (base.searchableThreads || []).map((thread) => decorateThread(thread, portalState, activeAccountId)),
      portal: buildPortalSummary(principal, portalState)
    };
    cacheScopedView(cacheKey, result);
    return result;
  }

  const visibleAccountIds = new Set(resolveVisibleAccountIds(base.accounts || [], principal, portalState));
  const accountScopeEnabled = visibleAccountIds.size > 0;
  const accounts = accountScopeEnabled
    ? (base.accounts || []).filter((item) => visibleAccountIds.has(String(item.id || item.userId || '')))
    : (base.accounts || []);
  if (accountScopeEnabled && activeAccountId && !visibleAccountIds.has(activeAccountId)) {
    const result = {
      ...base,
      accounts,
      threads: [],
      contacts: [],
      stats: { threadCount: 0, unreadThreads: 0, unreadMessages: 0 },
      portal: buildPortalSummary(principal, portalState)
    };
    cacheScopedView(cacheKey, result);
    return result;
  }

  const isManager = (principal?.roles || []).includes('manager');
  const threadUniverse = [...(base.threads || []), ...(base.searchableThreads || [])];
  const visibleThreadIds = isManager ? null : new Set(resolveVisibleThreadIds(threadUniverse, principal, portalState));
  const threads = (isManager ? base.threads : base.threads.filter((thread) => visibleThreadIds.has(String(thread.id))))
    .map((thread) => decorateThread(thread, portalState, activeAccountId));
  const searchableThreads = (isManager ? (base.searchableThreads || []) : (base.searchableThreads || []).filter((thread) => visibleThreadIds.has(String(thread.id))))
    .map((thread) => decorateThread(thread, portalState, activeAccountId));
  const contactIds = new Set(threads.flatMap((thread) => (thread.participants || []).map((item) => String(item.id))));
  const contacts = (base.contacts || []).filter((item) => contactIds.has(String(item.id)));
  const result = {
    ...base,
    accounts,
    threads,
    searchableThreads,
    contacts,
    stats: {
      threadCount: threads.length,
      unreadThreads: threads.filter((thread) => (thread.unreadCount || 0) > 0).length,
      unreadMessages: threads.reduce((sum, thread) => sum + (thread.unreadCount || 0), 0)
    },
    portal: buildPortalSummary(principal, portalState)
  };
  cacheScopedView(cacheKey, result);
  return result;
}

function buildScopedViewCacheKey(state, principal, portalState) {
  const stateRevision = getStateRevision(state);
  const portalRevision = getPortalStateRevision(portalState);
  if (!stateRevision && !portalRevision) return '';
  const roles = (principal?.roles || []).map(String).sort().join(',');
  const permissions = (principal?.permissions || []).map(String).sort().join(',');
  const departments = (principal?.departmentIds || []).map(String).sort().join(',');
  const identity = [String(principal?.userId || ''), String(principal?.username || ''), roles, permissions, departments].join('|');
  return `${stateRevision}:${portalRevision}:${identity}`;
}

function cacheScopedView(key, value) {
  if (!key) return value;
  if (scopedViewCache.has(key)) scopedViewCache.delete(key);
  scopedViewCache.set(key, value);
  while (scopedViewCache.size > SCOPED_VIEW_CACHE_LIMIT) {
    const oldestKey = scopedViewCache.keys().next().value;
    if (!oldestKey) break;
    scopedViewCache.delete(oldestKey);
  }
  return value;
}

export function buildPortalSummary(principal, portalState) {
  const departments = Array.isArray(portalState?.departments) ? portalState.departments : [];
  const channels = Array.isArray(portalState?.channels) ? portalState.channels : [];
  return {
    me: principal ? {
      userId: principal.userId,
      username: principal.username,
      displayName: principal.displayName,
      roles: principal.roles || [],
      departmentIds: principal.departmentIds || [],
      permissions: hasWildAccess(principal) ? (principal.permissions || []) : [],
      status: principal.status || null
    } : null,
    departments: hasWildAccess(principal)
      ? departments
      : departments.filter((item) => (principal?.departmentIds || []).map(String).includes(String(item.id))),
    channels: hasWildAccess(principal)
      ? channels.map(maskChannelSecrets)
      : channels.filter((item) => (principal?.departmentIds || []).map(String).includes(String(item.departmentId))).map(maskChannelSecrets)
  };
}

export function resolveVisibleThreadIds(threads, principal, portalState) {
  if (hasWildAccess(principal)) return threads.map((thread) => String(thread.id));
  const bindings = portalState?.threadBindings || {};
  const allowedDepartments = new Set((principal?.departmentIds || []).map(String));
  const activeUserIds = new Set([String(principal?.userId || ''), String(principal?.username || '')].filter(Boolean));
  const isManager = (principal?.roles || []).includes('manager');
  const isStaff = (principal?.roles || []).includes('staff');

  return threads.filter((thread) => {
    const binding = bindings[String(thread.id)] || {};
    const departmentId = String(binding.departmentId || '');
    if (!departmentId || !allowedDepartments.has(departmentId)) return false;
    if (isManager) return true;
    if (isStaff) return activeUserIds.has(String(binding.assignedUserId || ''));
    return false;
  }).map((thread) => String(thread.id));
}

export function resolveVisibleAccountIds(accounts, principal, portalState) {
  if (hasWildAccess(principal)) return (accounts || []).map((item) => String(item.id || item.userId || ''));
  const allowedDepartments = new Set((principal?.departmentIds || []).map(String));
  const allowedUserIds = new Set([String(principal?.userId || ''), String(principal?.username || '')].filter(Boolean));
  const isManager = (principal?.roles || []).includes('manager');
  const isStaff = (principal?.roles || []).includes('staff');
  const channels = Array.isArray(portalState?.channels) ? portalState.channels : [];
  const channelsByAccountId = new Map();
  for (const channel of channels) {
    const accountId = String(channel?.accountId || channel?.credentials?.accountId || channel?.code || '').trim();
    if (accountId) channelsByAccountId.set(accountId, channel);
  }
  const visible = new Set();
  for (const channel of channels) {
    if (channel?.active === false) continue;
    const accountId = String(channel?.accountId || channel?.credentials?.accountId || channel?.code || '').trim();
    if (!accountId) continue;
    if (!allowedDepartments.has(String(channel?.departmentId || ''))) continue;
    if (isManager) {
      visible.add(accountId);
      continue;
    }
    const members = Array.isArray(channel?.members) ? channel.members : [];
    const memberIds = new Set(members.map((item) => typeof item === 'object' && item ? String(item.userId || item.id || item.username || '') : String(item || '')).filter(Boolean));
    if (memberIds.size && ![...allowedUserIds].some((id) => memberIds.has(id))) continue;
    visible.add(accountId);
  }
  if (isManager && !isStaff) {
    for (const account of accounts || []) {
      const accountId = String(account?.id || account?.userId || '').trim();
      if (!accountId || channelsByAccountId.has(accountId)) continue;
      visible.add(accountId);
    }
  }
  return [...visible];
}

export function decorateThread(thread, portalState, accountId = null) {
  const resolvedAccountId = String(thread?.accountId || accountId || '').trim() || null;
  const binding = resolveThreadBinding(portalState, thread.id, resolvedAccountId) || {};
  const accountChannel = resolvedAccountId ? findChannelByAccountId(portalState, resolvedAccountId) : null;
  return {
    ...thread,
    accountId: resolvedAccountId,
    departmentId: binding.departmentId || accountChannel?.departmentId || null,
    channelId: binding.channelId || accountChannel?.id || accountChannel?.code || accountChannel?.accountId || null,
    assignedUserId: binding.assignedUserId || null,
    queueStatus: binding.queueStatus || null
  };
}

function resolveThreadBinding(portalState, threadId, accountId = null) {
  const bindings = portalState?.threadBindings || {};
  const scopedKey = accountId ? `${String(accountId)}:${String(threadId)}` : '';
  return (scopedKey && bindings[scopedKey]) || bindings[String(threadId)] || null;
}

function findChannelByAccountId(portalState, accountId) {
  const targetId = String(accountId || '').trim();
  if (!targetId) return null;
  return (portalState?.channels || []).find((item) => [item?.accountId, item?.code, item?.id].map((value) => String(value || '').trim()).includes(targetId)) || null;
}

export function maskChannelSecrets(channel) {
  const next = { ...channel };
  if (next.credentials) {
    next.credentials = {
      ...next.credentials,
      token: next.credentials.token ? '••••••' : undefined,
      cookie: next.credentials.cookie ? '••••••' : undefined,
      apiKey: next.credentials.apiKey ? '••••••' : undefined
    };
  }
  return next;
}

function hasWildAccess(principal) {
  return Boolean(principal && (((principal.permissions || []).includes('*')) || ((principal.roles || []).includes('admin'))));
}
