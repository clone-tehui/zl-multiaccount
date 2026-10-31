#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPortalSessionToken, PORTAL_COOKIE_NAME } from '../src/auth/session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
loadEnvFile(path.join(rootDir, '.env'));

const baseUrl = String(process.env.PORTAL_SMOKE_BASE_URL || 'http://127.0.0.1:4310').replace(/\/+$/, '');
const jwtSecret = process.env.PORTAL_SMOKE_JWT_SECRET || process.env.PORTAL_JWT_SECRET || process.env.SESSION_SECRET || 'change-me';
const staffId = process.env.PORTAL_SMOKE_STAFF_ID || 'staff-b';
const staffDepartmentId = process.env.PORTAL_SMOKE_STAFF_DEPARTMENT_ID || 'sale';
const crossDepartmentStaffId = process.env.PORTAL_SMOKE_CROSS_DEPT_STAFF_ID || 'staff-a';
const managerId = process.env.PORTAL_SMOKE_MANAGER_ID || `manager-${staffDepartmentId}`;
const adminId = process.env.PORTAL_SMOKE_ADMIN_ID || 'admin';
const errors = [];
const checks = [];

function tokenFor(user) {
  return createPortalSessionToken(user, { jwtSecret });
}

const principals = {
  admin: {
    id: adminId,
    username: adminId,
    displayName: adminId,
    roles: ['admin'],
    departmentIds: [],
    permissions: ['*']
  },
  manager: {
    id: managerId,
    username: managerId,
    displayName: managerId,
    roles: ['manager'],
    departmentIds: [staffDepartmentId],
    permissions: []
  },
  staff: {
    id: staffId,
    username: staffId,
    displayName: staffId,
    roles: ['staff'],
    departmentIds: [staffDepartmentId],
    permissions: []
  }
};

const tokens = Object.fromEntries(Object.entries(principals).map(([key, principal]) => [key, tokenFor(principal)]));

function record(name, ok, details = {}) {
  const skipped = details.skipped === true;
  checks.push({ name, ok, ...details });
  if (!ok && !skipped) errors.push(`${name}${details.reason ? `: ${details.reason}` : ''}`);
}

async function request(path, { method = 'GET', role = null, body = null } = {}) {
  const headers = { accept: 'application/json' };
  if (role) headers.cookie = `${PORTAL_COOKIE_NAME}=${tokens[role]}`;
  if (body !== null) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    return { status: 0, ok: false, json: null, text: '', error: error.message || String(error) };
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text for diagnostics
  }
  return { status: response.status, ok: response.ok, json, text };
}

function containsSecret(value) {
  const serialized = JSON.stringify(value || {});
  return serialized.includes('secret-value-for-audit') || serialized.includes('apiKey') || serialized.includes('passwordHash');
}

function hasRawPortalState(value) {
  const portal = value?.portal;
  return Boolean(portal && (Array.isArray(portal.users) || portal.threadBindings || Array.isArray(portal.recentActivity)));
}

async function expectStatus(name, path, expectedStatus, options = {}) {
  const result = await request(path, options);
  record(name, result.status === expectedStatus, { status: result.status, expectedStatus, reason: result.error || result.json?.error || result.text?.slice(0, 120) || null });
  record(`${name} returns-json`, result.status === expectedStatus && Boolean(result.json), { status: result.status, reason: result.text?.slice(0, 120) || null });
  return result;
}

const health = await request('/api/health');
record('health', health.status === 200 && health.json?.ok === true, { status: health.status, reason: health.status === 200 && health.json?.ok === true ? null : (health.error || health.text) });

const staffState = await expectStatus('staff state', '/api/state', 200, { role: 'staff' });
const staffThreads = Array.isArray(staffState.json?.threads) ? staffState.json.threads : [];
const staffCatalog = await request('/api/portal/catalog', { role: 'staff' });
const staffCatalogUsers = Array.isArray(staffCatalog.json?.users) ? staffCatalog.json.users : [];
const staffFixtureExists = staffCatalogUsers.some((user) => String(user.id || user.username || '') === String(staffId));
record('staff fixture exists', staffFixtureExists, { skipped: !staffFixtureExists, reason: staffFixtureExists ? null : `portal user ${staffId} not provisioned in current environment` });
record('staff sees assigned threads only', staffFixtureExists ? staffThreads.every((thread) => String(thread.assignedUserId || '') === staffId) : true, {
  skipped: !staffFixtureExists,
  count: staffThreads.length,
  reason: staffFixtureExists ? staffThreads.map((thread) => `${thread.id}:${thread.assignedUserId || '[none]'}`).join(',') : `portal user ${staffId} not provisioned in current environment`
});
record('staff state hides secrets', !containsSecret(staffState.json), { reason: containsSecret(staffState.json) ? 'secret marker found' : null });
record('staff portal summary not raw state', !hasRawPortalState(staffState.json), { reason: hasRawPortalState(staffState.json) ? 'raw portal fields found' : null });
record('staff portal me hides direct permissions', (staffState.json?.portal?.me?.permissions || []).length === 0, { reason: JSON.stringify(staffState.json?.portal?.me?.permissions || []) });

const visibleThreadId = process.env.PORTAL_SMOKE_THREAD_ID || staffThreads[0]?.id;
record('smoke thread available', Boolean(visibleThreadId), { skipped: !visibleThreadId, reason: visibleThreadId ? null : 'no visible staff thread in current environment' });

await expectStatus('staff denied compat docs', '/api/docs/compat', 403, { role: 'staff' });
await expectStatus('staff denied db status', '/api/portal/db/status', 403, { role: 'staff' });
await expectStatus('staff denied portal settings read', '/api/portal/settings', 403, { role: 'staff' });
await expectStatus('staff denied portal settings write', '/api/portal/settings', 403, { role: 'staff', method: 'POST', body: { routingMode: 'manual' } });
await expectStatus('staff denied mock login', '/api/portal/sso/mock-login', 403, { role: 'staff', method: 'POST', body: {} });
await expectStatus('staff denied account select', '/api/accounts/select', 403, { role: 'staff', method: 'POST', body: { accountId: '2145171284698835898' } });
await expectStatus('admin can read compat docs', '/api/docs/compat', 200, { role: 'admin' });

if (visibleThreadId) {
  await expectStatus('manager denied cross-department assignment', '/api/portal/conversations/assign', 403, {
    role: 'manager',
    method: 'POST',
    body: { threadId: visibleThreadId, assignedUserId: crossDepartmentStaffId }
  });
}

await expectStatus('manager denied direct technical permission grant', '/api/portal/users', 403, {
  role: 'manager',
  method: 'POST',
  body: {
    id: 'rbac-smoke-permission-user',
    username: 'rbac-smoke-permission-user',
    displayName: 'RBAC Smoke Permission User',
    roles: ['staff'],
    departmentIds: [staffDepartmentId],
    permissions: ['portal.users.write'],
    status: 'online'
  }
});

await expectStatus('manager denied wrong-department channel', '/api/portal/channels', 403, {
  role: 'manager',
  method: 'POST',
  body: {
    id: 'rbac-smoke-wrong-dept-channel',
    code: 'rbac-smoke-wrong-dept-channel',
    name: 'RBAC Smoke Wrong Dept Channel',
    departmentId: 'default',
    channelType: 'zalo_oa',
    credentials: { token: 'secret-value-for-audit' }
  }
});

let staffPresence = { json: null };
if (staffFixtureExists) {
  staffPresence = await expectStatus('staff self presence update', '/api/portal/presence', 200, {
    role: 'staff',
    method: 'POST',
    body: { status: 'online' }
  });
} else {
  record('staff self presence update', true, { skipped: true, reason: `portal user ${staffId} not provisioned in current environment` });
  record('staff self presence update returns-json', true, { skipped: true, reason: `portal user ${staffId} not provisioned in current environment` });
}
record('presence response hides raw portal', !hasRawPortalState(staffPresence.json), { skipped: !staffFixtureExists, reason: hasRawPortalState(staffPresence.json) ? 'raw portal fields found' : (!staffFixtureExists ? `portal user ${staffId} not provisioned in current environment` : null) });
record('presence response hides secrets', !containsSecret(staffPresence.json), { skipped: !staffFixtureExists, reason: containsSecret(staffPresence.json) ? 'secret marker found' : (!staffFixtureExists ? `portal user ${staffId} not provisioned in current environment` : null) });

const report = {
  ok: errors.length === 0,
  baseUrl,
  staffId,
  staffDepartmentId,
  visibleThreadId: visibleThreadId || null,
  checks,
  errors
};

console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exit(1);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !Object.prototype.hasOwnProperty.call(process.env, key)) process.env[key] = value;
  }
}
