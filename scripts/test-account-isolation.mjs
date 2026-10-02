import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { JsonStore, updateAccountScopedState, switchActiveAccountState } from '../src/lib/store.js';
import { PortalStore } from '../src/lib/portal-store.js';
import { runWithAccount } from '../src/services/request-account-context.js';
import { ZaloWebProvider } from '../src/providers/zalo-web-provider.js';
import { createPortalSessionToken, PORTAL_COOKIE_NAME } from '../src/auth/session.js';
import { createPortalReadService } from '../src/services/portal-read-service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zl-isolation-test-'));
const secret = 'synthetic-account-test-only';
const port = 26000 + Math.floor(Math.random() * 2000);
const checks = [];
let child;
const streams = [];
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function seed(dataDir) {
  const store = new JsonStore(dataDir);
  store.update((state) => {
    state.accounts = { A: { id: 'A' }, B: { id: 'B' } };
    for (const accountId of ['A', 'B']) {
      updateAccountScopedState(state, accountId, (bucket) => ({
        ...bucket,
        session: { account: { id: accountId }, status: 'connected' },
        contacts: { peer: { id: 'peer', displayName: `CONTACT-${accountId}` } },
        threads: { shared: { id: 'shared', type: 'group', title: `THREAD-${accountId}`, lastMessageAt: new Date().toISOString(), participantIds: ['peer'], unreadCount: 7 } },
        messages: { shared: [{ id: `initial-${accountId}`, threadId: 'shared', senderId: 'peer', text: `ONLY-${accountId}`, createdAt: new Date().toISOString() }] }
      }));
    }
    switchActiveAccountState(state, 'B');
    state.aiAutomationLogs = [{ accountId: 'B', textPreview: 'PRIVATE-GLOBAL-LOG' }];
    return state;
  });
  const portal = new PortalStore(dataDir);
  portal.update((state) => {
    state.users = [
      ...['A', 'B'].map((accountId) => ({ id: `staff-${accountId}`, username: `staff-${accountId}`, roles: ['staff'], departmentIds: [accountId], active: true })),
      { id: 'admin', username: 'admin', roles: ['admin'], departmentIds: [], active: true },
      { id: 'empty', username: 'empty', roles: ['staff'], departmentIds: ['A'], active: true }
    ];
    state.channels = ['A', 'B'].map((accountId) => ({ id: accountId, accountId, departmentId: accountId, members: [`staff-${accountId}`], active: true }));
    state.threadBindings = Object.fromEntries(['A', 'B'].map((accountId) => [`${accountId}:shared`, { accountId, threadId: 'shared', departmentId: accountId, assignedUserId: `staff-${accountId}` }]));
    return state;
  });
  return { store, portal };
}

function cookie(identity) {
  return `${PORTAL_COOKIE_NAME}=${createPortalSessionToken({ id: identity, username: identity, roles: identity === 'admin' ? ['admin'] : ['staff'], departmentIds: identity.startsWith('staff-') ? [identity.slice(-1)] : ['A'] }, { jwtSecret: secret })}`;
}

async function request(identity, route, body, accountId) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: cookie(identity), 'content-type': 'application/json', ...(accountId ? { 'x-zalo-account-id': accountId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

async function openStream(identity, accountId) {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/events?accountId=${accountId}`, { headers: { cookie: cookie(identity) }, signal: controller.signal });
  assert.equal(response.status, 200);
  const output = { text: '', controller };
  streams.push(output);
  output.task = (async () => {
    try { for await (const chunk of response.body) output.text += Buffer.from(chunk).toString(); } catch {}
  })();
  return output;
}

try {
  const portalFixture = {
    departments: [{ id: 'shared-department' }],
    channels: ['A', 'B'].map((accountId) => ({ id: accountId, accountId, departmentId: 'shared-department', members: [`staff-${accountId}`] })),
    users: [],
    threadBindings: Object.fromEntries(['A', 'B'].map((accountId) => [`${accountId}:shared`, { accountId, threadId: 'shared', departmentId: 'shared-department', assignedUserId: 'staff-A', queueStatus: 'pending' }])),
    recentActivity: ['A', 'B'].map((accountId) => ({ accountId, departmentId: 'shared-department', action: 'message', payload: { text: `PRIVATE-${accountId}` } }))
  };
  const portalReader = createPortalReadService({ db: { enabled: true, query: () => { throw new Error('Unscoped DB fallback must not run'); } }, portalStore: { read: () => portalFixture } });
  const staffPrincipal = { userId: 'staff-A', roles: ['staff'], departmentIds: ['shared-department'] };
  const catalog = await portalReader.readCatalog(staffPrincipal);
  assert.deepEqual(catalog.portal.channels.map((channel) => channel.accountId), ['A']);
  assert.deepEqual(Object.keys(catalog.threadBindings), ['A:shared']);
  assert.equal((await portalReader.readOpsOverview(staffPrincipal)).queue.length, 1);
  const activity = await portalReader.readActivity(staffPrincipal);
  assert.equal(activity.items.length, 1);
  assert.equal(activity.items[0].accountId, 'A');
  assert.equal(JSON.stringify(activity).includes('PRIVATE-'), false);
  checks.push('Same-department portal catalog, queue and activity exclude foreign accounts and private payloads');
  const { store } = seed(path.join(directory, 'unit'));
  const providerEvents = [];
  const calls = [];
  const provider = new ZaloWebProvider(store, (type, payload) => providerEvents.push({ type, accountId: payload.accountId }));
  for (const accountId of ['A', 'B']) {
    const listener = new EventEmitter();
    listener.start = () => {};
    const api = {
      listener,
      getGroupInfo: async () => ({ gridInfoMap: { shared: { name: `GROUP-${accountId}`, currentMems: [] } } }),
      sendMessage: async () => { await delay(accountId === 'A' ? 25 : 5); calls.push(accountId); },
      setPinnedConversations: async () => { await delay(accountId === 'A' ? 20 : 5); }
    };
    provider.accountClients.set(accountId, { api });
    provider.attachRealtime(accountId, api);
  }
  await Promise.all(['A', 'B'].map((accountId) => runWithAccount(accountId, async () => {
    await provider.sendMessage({ threadId: 'shared', text: 'synthetic' });
    await provider.setConversationPinned('shared', accountId === 'A');
    store.update((state) => { state.threads.shared.notes = `NOTE-${accountId}`; return state; });
  })));
  assert.deepEqual(calls.sort(), ['A', 'B']);
  assert.equal(store.readGlobal().activeAccountId, 'B');
  for (const accountId of ['A', 'B']) {
    assert.equal(store.readGlobal().accountStateById[accountId].threads.shared.notes, `NOTE-${accountId}`);
    assert.equal(store.readGlobal().accountStateById[accountId].threads.shared.pinned, accountId === 'A');
  }
  await runWithAccount('missing', async () => {
    assert.equal(provider.api, null);
    assert.deepEqual(store.read().threads, {});
    await assert.rejects(provider.sendMessage({ threadId: 'shared', text: 'must-not-send' }));
  });
  checks.push('Concurrent provider API selection and scoped read/write, no global fallback');
  provider.accountClients.get('A').api.listener.emit('message', { type: 1, threadId: 'shared', data: { uidFrom: 'peer', msgId: 'background-A', content: 'BACKGROUND-A', ts: Date.now(), msgType: 'webchat' } });
  await delay(100);
  assert.ok(store.readGlobal().accountStateById.A.messages.shared.some((message) => message.id === 'background-A'));
  assert.ok(!store.readGlobal().accountStateById.B.messages.shared.some((message) => message.id === 'background-A'));
  assert.ok(providerEvents.some((event) => event.type === 'message.created' && event.accountId === 'A'));
  const reopened = new JsonStore(path.join(directory, 'unit'));
  assert.ok(reopened.readGlobal().accountStateById.A.messages.shared.some((message) => message.id === 'background-A'));
  checks.push('Unselected account listener persists and emits to routing/AI/SSE');

  const dataDir = path.join(directory, 'http');
  const { portal } = seed(dataDir);
  child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, DATA_DIR: dataDir, PROVIDER: 'mock', PORT: String(port), PORTAL_JWT_SECRET: secret, SESSION_SECRET: secret, DATABASE_URL: '', OPENROUTER_API_KEY: '', TELEGRAM_ALERT_BOT_TOKEN: '', TELEGRAM_ALERT_CHAT_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let startup = '';
  child.stderr.on('data', (buffer) => { startup += buffer.toString(); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server failed: ${startup}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch {}
    await delay(50);
  }
  assert.ok(ready, startup);
  for (let iteration = 0; iteration < 4; iteration += 1) {
    await Promise.all(['A', 'B'].map(async (accountId) => {
      const result = await request(`staff-${accountId}`, '/api/state');
      assert.equal(result.status, 200);
      assert.equal(result.body.activeAccountId, accountId);
      assert.equal(result.body.threads.length, 1);
      assert.ok(JSON.stringify(result.body).includes(`ONLY-${accountId}`));
      assert.ok(!JSON.stringify(result.body).includes(`ONLY-${accountId === 'A' ? 'B' : 'A'}`));
      assert.ok(!JSON.stringify(result.body).includes('PRIVATE-GLOBAL-LOG'));
    }));
  }
  checks.push('Repeated concurrent staff reads with shared thread ID and no cross-account logs');
  for (const accountId of ['A', 'B', 'A', 'B']) {
    assert.equal((await request('admin', '/api/accounts/select', { accountId })).status, 200);
    assert.equal((await request('admin', '/api/state', undefined, accountId)).body.threads[0].title, `THREAD-${accountId}`);
    assert.equal((await request('staff-A', '/api/state')).body.activeAccountId, 'A');
  }
  checks.push('Admin switching/cache cannot change another staff session');
  const denied = [
    ['/api/state?accountId=B'], ['/api/threads/messages?threadId=shared&accountId=B'],
    ['/api/threads/profile?threadId=shared&accountId=B'], ['/api/friends/search?q=test&accountId=B'],
    ['/api/accounts/select', { accountId: 'B' }], ['/api/messages/send', { accountId: 'B', threadId: 'shared', text: 'DENIED' }],
    ['/api/threads/read', { accountId: 'B', threadId: 'shared' }], ['/api/messages/send', { credential_id: 'B', threadId: 'shared', text: 'DENIED' }],
    ['/api/threads/read', { accountId: 'A', credentialId: 'B', threadId: 'shared' }]
  ];
  for (const [route, body] of denied) assert.equal((await request('staff-A', route, body)).status, 403, route);
  assert.equal((await request('staff-A', '/api/state', undefined, 'B')).status, 403);
  assert.equal((await request('empty', '/api/state')).body.threads.length, 0);
  checks.push('Foreign account read/search/profile/send/mutations/aliases/header denied; empty scope closed');
  const streamA = await openStream('staff-A', 'A');
  const streamB = await openStream('staff-B', 'B');
  await delay(50);
  assert.ok(!streamA.text.includes('ONLY-B'));
  assert.ok(!streamB.text.includes('ONLY-A'));
  await Promise.all(['A', 'B'].map((accountId) => request(`staff-${accountId}`, '/api/messages/send', { threadId: 'shared', text: `HTTP-SEND-${accountId}` })));
  await delay(1200);
  assert.ok(streamA.text.includes('HTTP-SEND-A'));
  assert.ok(!streamA.text.includes('HTTP-SEND-B'));
  assert.ok(streamB.text.includes('HTTP-SEND-B'));
  assert.ok(!streamB.text.includes('HTTP-SEND-A'));
  const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  for (const accountId of ['A', 'B']) {
    const content = JSON.stringify(disk.accountStateById[accountId].messages);
    assert.ok(content.includes(`HTTP-SEND-${accountId}`));
    assert.ok(!content.includes(`HTTP-SEND-${accountId === 'A' ? 'B' : 'A'}`));
  }
  checks.push('Actual HTTP concurrent writes, delayed background echoes, SSE and on-disk isolation');
  portal.update((state) => { state.users.find((user) => user.id === 'staff-A').active = false; return state; });
  assert.equal((await request('staff-A', '/api/state')).status, 401);
  await request('staff-B', '/api/threads/read', { threadId: 'shared' });
  await Promise.race([streamA.task, delay(1000).then(() => { throw new Error('Revoked SSE stayed open'); })]);
  checks.push('Revoked operator denied on HTTP and disconnected from SSE');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  for (const stream of streams) stream.controller.abort();
  if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
  fs.rmSync(directory, { recursive: true, force: true });
}
