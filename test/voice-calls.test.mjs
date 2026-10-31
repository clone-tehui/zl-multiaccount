import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { ZaloVoiceCalls, attachVoiceCallApi } from '../src/services/zalo-voice-calls.js';
import { installVoiceCallGateway } from '../src/services/voice-call-gateway.js';
import { authorizeVoiceThread } from '../src/services/voice-call-access.js';

function fixture() {
  const sessions = [];
  const calls = new ZaloVoiceCalls(() => {}, () => {
    const session = new EventEmitter();
    session.startOutgoingCall = async (threadId) => { session.threadId = threadId; session.emit('state', 'ringing'); };
    session.endCall = async () => { session.closed = true; };
    session.frames = [];
    session.sendAudioFrame = async (frame) => session.frames.push(Buffer.from(frame));
    sessions.push(session);
    return session;
  });
  for (const accountId of ['A', 'B']) calls.register(accountId, { listener: new EventEmitter() });
  return { calls, sessions };
}

test('Voice adapter reuses an official API context and creates no additional login or socket', async () => {
  const { createContext } = await import(new URL('../node_modules/zca-js/dist/context.js', import.meta.url));
  const { API } = await import(new URL('../node_modules/zca-js/dist/apis.js', import.meta.url));
  const { CookieJar } = await import('tough-cookie');
  const context = { ...createContext(), uid: 'synthetic-self', imei: 'synthetic-device', secretKey: 'synthetic-key', userAgent: 'Synthetic regression', cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } } };
  const services = new Proxy({}, { get: () => ['https://synthetic.invalid'] });
  const api = new API(context, services, ['wss://synthetic.invalid']);
  const originalListener = api.listener;
  const originalSend = api.sendMessage;
  const callApi = attachVoiceCallApi(api);
  assert.ok(callApi);
  assert.notEqual(api.listener, originalListener);
  assert.equal(api.listener, callApi.listener);
  assert.equal(api.listener.ws, null);
  assert.equal(originalListener.ws, null);
  assert.equal(api.sendMessage, originalSend);
  assert.equal(callApi.getContext().cookie, context.cookie);
  assert.equal(context.options.requestTimeout, undefined);
  assert.equal(callApi.getContext().options.requestTimeout, 15000);
  assert.equal(typeof callApi.call.requestVoiceCall, 'function');
  assert.equal(typeof callApi.call.createRtcSession, 'function');
});

test('Calls reserve each account separately even with identical conversation IDs', async () => {
  const { calls, sessions } = fixture();
  const send = () => {};
  const first = await calls.open({ accountId: 'A', threadId: 'shared', ownerId: 'staff-A', send });
  await assert.rejects(calls.open({ accountId: 'A', threadId: 'shared', ownerId: 'other', send }), /cuộc gọi khác/);
  const second = await calls.open({ accountId: 'B', threadId: 'shared', ownerId: 'staff-B', send });
  await calls.disconnect('A');
  assert.equal(sessions[0].closed, true);
  assert.equal(second.ended, false);
  assert.equal(calls.active.get('B'), second);
  await calls.close(second);
  assert.equal(calls.active.size, 0);
  assert.equal(first.ended, true);
});

test('Media authorization uses only the requested bucket and current assignment', () => {
  const state = { accounts: { A: { id: 'A' }, B: { id: 'B' } }, accountStateById: { A: { threads: { shared: { type: 'direct' } } }, B: { threads: { shared: { type: 'direct' } } } } };
  const portal = { channels: [{ accountId: 'A', departmentId: 'dept', members: ['staff'] }], threadBindings: { 'A:shared': { accountId: 'A', threadId: 'shared', departmentId: 'dept', assignedUserId: 'staff' } } };
  const principal = { userId: 'staff', username: 'staff', roles: ['staff'], departmentIds: ['dept'] };
  assert.deepEqual(authorizeVoiceThread(principal, 'A', 'shared', state, portal), { accountId: 'A', threadId: 'shared' });
  assert.throws(() => authorizeVoiceThread(principal, 'B', 'shared', state, portal), { statusCode: 403 });
  portal.threadBindings['A:shared'].assignedUserId = 'someone-else';
  assert.throws(() => authorizeVoiceThread(principal, 'A', 'shared', state, portal), { statusCode: 403 });
  assert.throws(() => authorizeVoiceThread({ roles: ['admin'] }, 'A', 'missing', state, portal), { statusCode: 403 });
});

test('Hanging up while allocation is pending keeps the account reserved until cleanup', async () => {
  const { calls } = fixture();
  let finish;
  const allocation = new Promise((resolve) => { finish = resolve; });
  const create = calls.createSession;
  calls.createSession = (api) => { const session = create(api); session.startOutgoingCall = () => allocation; return session; };
  const opening = calls.open({ accountId: 'A', threadId: 'shared', ownerId: 'staff', send: () => {} });
  await delay(0);
  const closing = calls.close(calls.active.get('A'));
  await assert.rejects(calls.open({ accountId: 'A', threadId: 'other', ownerId: 'other', send: () => {} }), /cuộc gọi khác/);
  finish();
  await opening;
  await closing;
  assert.equal(calls.active.size, 0);
});

test('WebSocket media enforces origin, membership and revoked access; no media crosses accounts', async () => {
  const { calls, sessions } = fixture();
  const server = http.createServer();
  const revoked = new Set();
  const gateway = installVoiceCallGateway(server, {
    calls,
    authorize(req, query) {
      const ownerId = req.headers.cookie;
      const accountId = query.get('accountId');
      if (!['A', 'B'].includes(ownerId) || ownerId !== accountId || revoked.has(ownerId)) throw new Error('Forbidden');
      if (query.get('threadId') !== 'shared') throw new Error('Forbidden');
      return { accountId, threadId: 'shared', ownerId };
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`;
  const sockets = [];
  const connect = (identity, accountId = identity, origin = `http://${host}`) => {
    const socket = new WebSocket(`ws://${host}/api/calls/media?accountId=${accountId}&threadId=shared`, { headers: { cookie: identity, origin } });
    socket.on('error', () => {});
    sockets.push(socket);
    return socket;
  };
  try {
    for (const [identity, accountId, origin] of [['A', 'B'], ['outsider', 'A'], ['A', 'A', 'https://untrusted.example']]) {
      const socket = connect(identity, accountId, origin);
      const [, response] = await once(socket, 'unexpected-response');
      assert.equal(response.statusCode, 403);
      socket.terminate();
    }
    const received = { A: [], B: [] };
    const socketA = connect('A');
    const socketB = connect('B');
    socketA.on('message', (message, binary) => { if (binary) received.A.push(message.toString()); });
    socketB.on('message', (message, binary) => { if (binary) received.B.push(message.toString()); });
    await Promise.all([once(socketA, 'open'), once(socketB, 'open')]);
    socketA.send(JSON.stringify({ type: 'start' }));
    socketB.send(JSON.stringify({ type: 'start' }));
    for (let attempt = 0; calls.active.size < 2 && attempt < 30; attempt += 1) await delay(5);
    assert.equal(calls.active.size, 2);
    const sessionA = calls.active.get('A').session;
    const sessionB = calls.active.get('B').session;
    socketA.send(Buffer.from('OPUS-A'));
    socketB.send(Buffer.from('OPUS-B'));
    sessionA.emit('audio_frame', { payload: Buffer.from('REMOTE-A') });
    sessionB.emit('audio_frame', { payload: Buffer.from('REMOTE-B') });
    await delay(30);
    assert.deepEqual(sessionA.frames.filter((frame) => !frame.equals(Buffer.from([0xf8, 0xff, 0xfe]))).map((frame) => frame.toString()), ['OPUS-A']);
    assert.deepEqual(sessionB.frames.filter((frame) => !frame.equals(Buffer.from([0xf8, 0xff, 0xfe]))).map((frame) => frame.toString()), ['OPUS-B']);
    assert.deepEqual(received, { A: ['REMOTE-A'], B: ['REMOTE-B'] });
    revoked.add('A');
    const closed = once(socketA, 'close');
    socketA.send(Buffer.from('DENIED'));
    await closed;
    await delay(5);
    assert.equal(sessionA.closed, true);
    assert.equal(sessionB.closed, undefined);
    assert.deepEqual(sessionA.frames.filter((frame) => !frame.equals(Buffer.from([0xf8, 0xff, 0xfe]))).map((frame) => frame.toString()), ['OPUS-A']);
    socketB.close();
    await once(socketB, 'close');
    await delay(5);
    assert.equal(calls.active.size, 0);
    assert.equal(sessions.length, 2);
  } finally {
    for (const socket of sockets) socket.terminate();
    gateway.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Incoming ringing is acknowledged once; remote cancellation matches call ID and unregister detaches listener', async () => {
  const events = [], history = [], ring = [];
  const calls = new ZaloVoiceCalls((...args) => events.push(args), undefined, { record: (row) => history.push(row) });
  const api = { getContext: () => ({ uid: 'self' }), listener: new EventEmitter(), call: { ringRingVoiceCall: async (...args) => ring.push(args) } };
  const request = { act: 'request', type: 'request', data: { callId: 42, callerId: 'peer', fromId: 'peer' } };
  // Parser uses the companion's actual request format.
  request.data.params = JSON.stringify({ id: 42, uid: 'peer', uidN: 'peer' });
  calls.register('A', api);
  api.listener.emit('call_event', request);
  api.listener.emit('call_event', request);
  await delay(0);
  assert.equal(calls.pending.size, 1);
  assert.equal(ring.length, 1);
  assert.equal(events.filter(([type]) => type === 'call.incoming').length, 1);
  api.listener.emit('call_event', { act: 'end', type: 'end', data: { callId: 999 } });
  assert.equal(calls.pending.size, 1);
  api.listener.emit('call_event', { act: 'endcall', type: 'end', data: { callId: 42 } });
  assert.equal(calls.pending.size, 0);
  assert.equal(history.length, 1);
  assert.equal(history[0].reason, 'missed');
  assert.equal(events.at(-1)[0], 'call.ended');
  calls.register('A', api);
  assert.equal(api.listener.listenerCount('call_event'), 1);
  await calls.disconnect('A');
  assert.equal(api.listener.listenerCount('call_event'), 0);
});

test('Incoming timeout dismisses only its account, produces one missed history entry', async () => {
  const history = [], events = [];
  const calls = new ZaloVoiceCalls((...args) => events.push(args), undefined, { record: (call) => history.push(call), incomingTimeoutMs: 15 });
  const api = { getContext: () => ({ uid: 'self' }), listener: new EventEmitter(), call: { ringRingVoiceCall: async () => {} } };
  calls.register('A', api);
  api.listener.emit('call_event', { act: 'request', data: { params: JSON.stringify({ id: 12, uidN: 'peer' }) } });
  await delay(30);
  assert.equal(calls.pending.size, 0);
  assert.equal(history.length, 1);
  assert.equal(history[0].accountId, 'A');
  assert.equal(history[0].reason, 'missed');
  assert.equal(events.at(-1)[0], 'call.ended');
  await calls.disconnect('A');
});

test('Allocation failure settles lease without deadlock and sanitized diagnostics exclude upstream secrets', async () => {
  const diagnostics = [], history = [];
  const calls = new ZaloVoiceCalls(() => {}, (api) => {
    const session = new EventEmitter();
    session.startOutgoingCall = async () => api.call.requestVoiceCall('peer');
    session.endCall = async () => {};
    session.sendAudioFrame = async () => {};
    return session;
  }, { diagnose: (event, fields) => diagnostics.push({ event, fields }), record: (row) => history.push(row) });
  calls.register('A', { listener: new EventEmitter(), call: { requestVoiceCall: async () => { throw Object.assign(new Error('SECRET cookie/token'), { code: 112 }); } } });
  await assert.rejects(calls.open({ accountId: 'A', threadId: 'peer', send: () => {} }), /SECRET/);
  assert.equal(calls.active.size, 0);
  assert.equal(history.length, 1);
  assert.ok(diagnostics.some((row) => row.event === 'signal.error' && row.fields.code === 112));
  assert.equal(JSON.stringify(diagnostics).includes('SECRET'), false);
});

test('Setup timeout frees media and account reservation; old binary protocol stays raw', async () => {
  const sent = [];
  const { calls } = fixture();
  calls.setupTimeoutMs = 15;
  const lease = await calls.open({ accountId: 'A', threadId: 'shared', send: (message) => sent.push(message) });
  lease.session.emit('audio_frame', { payload: Buffer.from('OPUS'), sequenceNumber: 7, timestamp: 320 });
  assert.equal(sent.find(Buffer.isBuffer).toString(), 'OPUS');
  await delay(30);
  assert.equal(lease.ended, true);
  assert.equal(calls.active.size, 0);
  assert.ok(sent.some((message) => message.type === 'error'));
  assert.ok(sent.some((message) => message.status === 'ended'));
});

test('Version 2 carries RTP sequence without relay keys; independent keepalive cannot double-send', async () => {
  const { calls } = fixture();
  const sent = [];
  const lease = await calls.open({ accountId: 'A', threadId: 'shared', mediaVersion: 2, send: (message) => sent.push(message) });
  lease.session.emit('audio_frame', { payload: Buffer.from('OPUS'), sequenceNumber: 65535, timestamp: 0xffffffff, secretKey: 'SECRET' });
  const frame = sent.find(Buffer.isBuffer);
  assert.equal(frame.readUInt16BE(0), 0x5a43);
  assert.equal(frame.readUInt16BE(2), 65535);
  assert.equal(frame.readUInt32BE(4), 0xffffffff);
  assert.equal(frame.subarray(8).toString(), 'OPUS');
  await lease.session.sendAudioFrame(Buffer.from('DUPLICATE'), { isKeepalive: true });
  assert.equal(lease.session.frames.length, 0);
  await calls.close(lease);
});

test('Local call history is idempotent and account scoped, without message-created/webhook events', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { JsonStore, updateAccountScopedState } = await import('../src/lib/store.js');
  const { ZaloWebProvider } = await import('../src/providers/zalo-web-provider.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlsever-call-history-'));
  try {
    const store = new JsonStore(dir);
    store.update((state) => {
      state.accounts = { A: { id: 'A' }, B: { id: 'B' } };
      for (const accountId of ['A', 'B']) updateAccountScopedState(state, accountId, (bucket) => ({ ...bucket, threads: { peer: { id: 'peer', type: 'direct' } }, messages: {} }));
      return state;
    });
    const events = [];
    const provider = new ZaloWebProvider(store, (type, payload) => events.push({ type, accountId: payload.accountId }));
    const call = { accountId: 'A', threadId: 'peer', trace: 'synthetic-call', createdAt: Date.now(), direction: 'outgoing', reason: 'local_end', connected: true, durationSeconds: 7 };
    provider.calls.record(call);
    provider.calls.record(call);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(disk.accountStateById.A.messages.peer.length, 1);
    assert.match(disk.accountStateById.A.messages.peer[0].text, /Cuộc gọi đi\nThời lượng: 00:07/);
    assert.equal(disk.accountStateById.A.messages.peer[0].isOutgoing, true);
    assert.equal(disk.accountStateById.B.messages.peer, undefined);
    assert.ok(events.every((event) => event.type === 'thread.meta_updated' && event.accountId === 'A'));
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('Accept and reject produce one history entry and keep other accounts pending', async () => {
  const history = [], events = [];
  const calls = new ZaloVoiceCalls((...args) => events.push(args), () => {
    const session = new EventEmitter();
    session.sendAudioFrame = async () => {};
    session.acceptIncomingCall = async () => session.emit('state', 'active');
    session.rejectIncomingCall = async () => {};
    session.endCall = async () => {};
    return session;
  }, { record: (call) => history.push(call) });
  const apis = ['A', 'B'].map(() => ({ listener: new EventEmitter(), getContext: () => ({ uid: 'self' }), call: { ringRingVoiceCall: async () => {} } }));
  for (const [i, accountId] of ['A', 'B'].entries()) {
    calls.register(accountId, apis[i]);
    apis[i].listener.emit('call_event', { act: 'request', data: { params: JSON.stringify({ id: 123, uidN: 'peer' }) } });
  }
  const lease = await calls.open({ accountId: 'A', threadId: 'peer', incoming: true, send: () => {} });
  assert.ok(lease.activeAt);
  assert.equal(calls.pending.size, 1);
  await calls.reject({ accountId: 'B', threadId: 'peer' });
  assert.equal(history[0].reason, 'rejected');
  assert.equal(history[0].accountId, 'B');
  await calls.close(lease); await calls.close(lease);
  assert.equal(history.length, 2);
  assert.equal(history[1].accountId, 'A');
  assert.equal(history[1].connected, true);
  await calls.disconnect('A'); await calls.disconnect('B');
});
