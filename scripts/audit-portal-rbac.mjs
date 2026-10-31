#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildScopedView, buildPortalSummary } from '../src/services/access-service.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, 'data');
const portalPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(dataDir, 'portal.json');
const statePath = process.argv[3] ? path.resolve(process.argv[3]) : path.join(dataDir, 'state.json');
const portal = JSON.parse(fs.readFileSync(portalPath, 'utf8'));
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const errors = [];
const warnings = [];

const users = Array.isArray(portal.users) ? portal.users : [];
const departments = Array.isArray(portal.departments) ? portal.departments : [];
const channels = Array.isArray(portal.channels) ? portal.channels : [];
const bindings = portal.threadBindings && typeof portal.threadBindings === 'object' ? portal.threadBindings : {};
const usersById = new Map(users.flatMap((user) => [[String(user.id || ''), user], [String(user.username || ''), user]].filter(([id]) => id)));
const departmentsById = new Map(departments.map((department) => [String(department.id || department.code || ''), department]));
const channelsById = new Map(channels.flatMap((channel) => [[String(channel.id || ''), channel], [String(channel.code || ''), channel]].filter(([id]) => id)));
const validRoles = new Set(['admin', 'manager', 'staff']);

function rolesOf(user) {
  return Array.isArray(user?.roles) ? user.roles.map(String) : [];
}

function permissionsOf(user) {
  return Array.isArray(user?.permissions) ? user.permissions.map(String) : [];
}

function isAdmin(user) {
  return rolesOf(user).includes('admin') || permissionsOf(user).includes('*');
}

function departmentIdsOf(user) {
  return Array.isArray(user?.departmentIds) ? user.departmentIds.map(String) : [];
}

function memberIdOf(member) {
  if (member && typeof member === 'object') return String(member.userId || member.id || member.username || '');
  return String(member || '');
}

function hasCredentialSecret(channel) {
  const credentials = channel?.credentials || {};
  return ['token', 'cookie', 'apiKey', 'secret', 'password'].some((key) => Boolean(credentials[key]));
}

function stringify(value) {
  return JSON.stringify(value || {});
}

function routeBlock(source, routePath) {
  const marker = `url.pathname === '${routePath}'`;
  const index = source.indexOf(marker);
  if (index < 0) return '';
  return source.slice(Math.max(0, index - 180), index + 1400);
}

const serverPath = path.join(rootDir, 'src', 'server.js');
if (fs.existsSync(serverPath)) {
  const serverSource = fs.readFileSync(serverPath, 'utf8');
  const publicBypassLine = serverSource.split(/\r?\n/).find((line) => line.includes("url.pathname.startsWith('/api/')") && line.includes('.includes(url.pathname)')) || '';
  for (const sensitivePath of ['/api/docs/compat', '/api/portal/sso/mock-login']) {
    if (publicBypassLine.includes(sensitivePath)) errors.push(`${sensitivePath}: sensitive endpoint is public auth-bypass`);
    if (!routeBlock(serverSource, sensitivePath).includes('requireAdminAccess')) errors.push(`${sensitivePath}: sensitive endpoint must require admin access`);
  }
  if (!routeBlock(serverSource, '/api/portal/db/status').includes('requireAdminAccess')) errors.push('/api/portal/db/status: technical status must require admin access');
  if (!routeBlock(serverSource, '/api/portal/settings').includes('requireAdminAccess')) errors.push('/api/portal/settings: global settings must require admin access');
  for (const assignmentPath of ['/api/portal/threads/bind', '/api/portal/conversations/assign']) {
    if (!routeBlock(serverSource, assignmentPath).includes('assertAssignablePortalUser')) errors.push(`${assignmentPath}: assignment must validate staff department/channel scope`);
  }
  if (serverSource.includes('portal: next')) errors.push('portal write responses must not return raw portal state');
  if (!serverSource.includes('writeUnhandledError(res, error)')) errors.push('server missing top-level HTTP error wrapper for 401/403');
}

const portalRendererPath = path.join(rootDir, 'public', 'portal', 'modules', 'renderers.js');
const portalApiPath = path.join(rootDir, 'public', 'portal', 'modules', 'api.js');
const portalIndexPath = path.join(rootDir, 'public', 'portal', 'index.html');
const portalFormsPath = path.join(rootDir, 'public', 'portal', 'modules', 'forms.js');
if (fs.existsSync(portalRendererPath)) {
  const rendererSource = fs.readFileSync(portalRendererPath, 'utf8');
  if (!rendererSource.includes('displayThreadRef') || !rendererSource.includes('workspaceLink')) errors.push('portal UI missing non-admin technical-id masking helpers');
  if (rendererSource.includes('href="https://zl.tehui.io.vn/?threadId=${encodeURIComponent(item.threadId')) errors.push('portal UI directly embeds threadId in workspace links');
}
if (fs.existsSync(portalApiPath)) {
  const apiSource = fs.readFileSync(portalApiPath, 'utf8');
  if (!apiSource.includes('getOptionalJson') || !apiSource.includes("'/api/portal/db/status'")) errors.push('portal UI must tolerate admin-only db status for manager/staff');
}
if (fs.existsSync(portalIndexPath) && fs.existsSync(portalFormsPath)) {
  const indexSource = fs.readFileSync(portalIndexPath, 'utf8');
  const formsSource = fs.readFileSync(portalFormsPath, 'utf8');
  if (!indexSource.includes('id="db-health-card"')) errors.push('portal DB/runtime health card must be targetable for role hiding');
  if (!indexSource.includes('id="admin-tools-section"') || !indexSource.includes('id="thread-ownership-section"')) errors.push('portal role-gated sections must have stable ids');
  if (!formsSource.includes("setCardVisibleById('db-health-card', admin)")) errors.push('portal DB/runtime health card must be admin-only in UI');
  if (!formsSource.includes('syncRoleSections')) errors.push('portal UI must hide empty role-gated sections');
}

for (const user of users) {
  const id = String(user.id || user.username || '');
  if (!id) errors.push('portal user with empty id/username');
  for (const role of rolesOf(user)) {
    if (!validRoles.has(role)) errors.push(`${id}: unknown role ${role}`);
  }
  if (rolesOf(user).includes('staff') && rolesOf(user).some((role) => role !== 'staff')) {
    warnings.push(`${id}: user mixes staff with another role`);
  }
  if (isAdmin(user) && !rolesOf(user).includes('admin')) errors.push(`${id}: wildcard permission without admin role`);
  if (!isAdmin(user) && permissionsOf(user).length) errors.push(`${id}: non-admin should not store direct technical permissions`);
  if ((rolesOf(user).includes('manager') || rolesOf(user).includes('staff')) && !departmentIdsOf(user).length) {
    errors.push(`${id}: ${rolesOf(user).join('/')} missing departmentIds`);
  }
  for (const departmentId of departmentIdsOf(user)) {
    if (!departmentsById.has(String(departmentId))) errors.push(`${id}: references missing department ${departmentId}`);
  }
}

for (const channel of channels) {
  const channelId = String(channel.id || channel.code || '');
  if (!channelId) errors.push('channel with empty id/code');
  if (channel.departmentId && !departmentsById.has(String(channel.departmentId))) errors.push(`${channelId}: missing department ${channel.departmentId}`);
  const memberIds = new Set();
  for (const member of Array.isArray(channel.members) ? channel.members : []) {
    const memberId = memberIdOf(member);
    if (!memberId) continue;
    memberIds.add(memberId);
    const user = usersById.get(memberId);
    if (!user) {
      errors.push(`${channelId}: member ${memberId} does not exist`);
      continue;
    }
    if (!rolesOf(user).includes('staff')) errors.push(`${channelId}: member ${memberId} is not staff`);
    if (channel.departmentId && !departmentIdsOf(user).includes(String(channel.departmentId))) {
      errors.push(`${channelId}: member ${memberId} is outside department ${channel.departmentId}`);
    }
  }
  if (memberIds.size !== (Array.isArray(channel.members) ? channel.members.map(memberIdOf).filter(Boolean).length : 0)) {
    warnings.push(`${channelId}: duplicate channel members`);
  }
}

for (const [threadId, binding] of Object.entries(bindings)) {
  const departmentId = String(binding.departmentId || '');
  const channelId = String(binding.channelId || '');
  const assignedUserId = String(binding.assignedUserId || '');
  if (departmentId && !departmentsById.has(departmentId)) errors.push(`${threadId}: binding references missing department ${departmentId}`);
  const channel = channelId ? channelsById.get(channelId) : null;
  if (channelId && !channel) errors.push(`${threadId}: binding references missing channel ${channelId}`);
  if (channel && departmentId && String(channel.departmentId || '') !== departmentId) {
    errors.push(`${threadId}: channel ${channelId} department ${channel.departmentId || '[none]'} != binding department ${departmentId}`);
  }
  if (assignedUserId) {
    const user = usersById.get(assignedUserId);
    if (!user) {
      errors.push(`${threadId}: assigned user ${assignedUserId} does not exist`);
    } else {
      if (!rolesOf(user).includes('staff')) errors.push(`${threadId}: assigned user ${assignedUserId} is not staff`);
      if (departmentId && !departmentIdsOf(user).includes(departmentId)) errors.push(`${threadId}: assigned user ${assignedUserId} outside department ${departmentId}`);
      const memberIds = new Set((Array.isArray(channel?.members) ? channel.members : []).map(memberIdOf).filter(Boolean));
      if (memberIds.size && !memberIds.has(String(user.id)) && !memberIds.has(String(user.username || ''))) {
        errors.push(`${threadId}: assigned user ${assignedUserId} outside channel ${channelId} members`);
      }
    }
  }
  if (String(binding.queueStatus || '') === 'open' && !assignedUserId) errors.push(`${threadId}: open binding without assignedUserId`);
  if (String(binding.queueStatus || '') === 'pending' && assignedUserId) warnings.push(`${threadId}: pending binding has assignedUserId`);
}

for (const department of departments) {
  const departmentId = String(department.id || department.code || '');
  const managerPrincipal = {
    userId: `audit-manager-${departmentId}`,
    username: `audit-manager-${departmentId}`,
    displayName: `audit manager ${departmentId}`,
    roles: ['manager'],
    departmentIds: [departmentId],
    permissions: ['portal.users.write', 'channels.manage']
  };
  const managerSummary = buildPortalSummary(managerPrincipal, portal);
  if ((managerSummary.me?.permissions || []).length) errors.push(`${departmentId}: manager summary leaks direct permissions`);
  if ((managerSummary.departments || []).some((item) => String(item.id || item.code || '') !== departmentId)) {
    errors.push(`${departmentId}: manager summary leaks other departments`);
  }
  for (const channel of managerSummary.channels || []) {
    if (String(channel.departmentId || '') !== departmentId) errors.push(`${departmentId}: manager summary leaks channel ${channel.id}`);
    if (hasCredentialSecret(channel) || stringify(channel).includes('secret-value-for-audit')) errors.push(`${departmentId}: manager summary leaks channel credentials`);
  }
  const managerView = buildScopedView(state, managerPrincipal, portal);
  for (const thread of managerView.threads || []) {
    const binding = resolveBinding(bindings, thread.id, thread.accountId) || {};
    const scopedDepartmentId = String(thread.departmentId || binding.departmentId || resolveChannelDepartmentId(channels, thread.accountId) || '').trim();
    if (scopedDepartmentId !== departmentId) errors.push(`${departmentId}: manager scoped view leaks thread ${thread.id}`);
  }
}

for (const staff of users.filter((user) => rolesOf(user).includes('staff') && !isAdmin(user))) {
  const principal = {
    userId: staff.id,
    username: staff.username,
    displayName: staff.displayName,
    roles: ['staff'],
    departmentIds: departmentIdsOf(staff),
    permissions: ['conversations.reply']
  };
  const staffSummary = buildPortalSummary(principal, portal);
  if ((staffSummary.me?.permissions || []).length) errors.push(`${staff.id}: staff summary leaks direct permissions`);
  const staffView = buildScopedView(state, principal, portal);
  for (const thread of staffView.threads || []) {
    const binding = resolveBinding(bindings, thread.id, thread.accountId) || {};
    if (String(binding.assignedUserId || '') !== String(staff.id) && String(binding.assignedUserId || '') !== String(staff.username || '')) {
      errors.push(`${staff.id}: staff scoped view leaks unassigned thread ${thread.id}`);
    }
  }
}

function resolveBinding(bindings, threadId, accountId = null) {
  const normalizedThreadId = String(threadId || '').trim();
  const normalizedAccountId = String(accountId || '').trim();
  if (normalizedAccountId) {
    const scopedKey = `${normalizedAccountId}:${normalizedThreadId}`;
    if (bindings[scopedKey]) return bindings[scopedKey];
  }
  return bindings[normalizedThreadId] || null;
}

function resolveChannelDepartmentId(channels, accountId = null) {
  const normalizedAccountId = String(accountId || '').trim();
  if (!normalizedAccountId) return null;
  const channel = (channels || []).find((item) => [item?.accountId, item?.code, item?.id].map((value) => String(value || '').trim()).includes(normalizedAccountId));
  return channel?.departmentId || null;
}

const report = {
  ok: errors.length === 0,
  portalPath,
  statePath,
  totals: {
    users: users.length,
    departments: departments.length,
    channels: channels.length,
    threadBindings: Object.keys(bindings).length
  },
  warnings,
  errors
};

console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exit(1);
