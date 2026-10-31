import { randomUUID } from 'node:crypto';
import { VoiceFramePacer } from './voice-call-media.js';
import { ZaloRtcSession, CallType, parseIncomingCallEvent } from '@softtynet/zca-js';

const { API: CallAPI } = await import(new URL('./apis.js', import.meta.resolve('@softtynet/zca-js')));

export function attachVoiceCallApi(api) {
  if (!api?.getContext || !api.zpwServiceMap?.voice_call?.length || !api.listener?.urls?.length) return null;
  try {
    const context = api.getContext();
    const callApi = new CallAPI({ ...context, options: { ...context.options, requestTimeout: 15000 } }, api.zpwServiceMap, api.listener.urls);
    api.listener = callApi.listener;
    return callApi;
  } catch {
    console.warn('[zalo-user-server] Voice call engine unavailable for this connection');
    return null;
  }
}

// Signaling stays in the pinned companion; the app owns leases, diagnostics and pacing.
export class ZaloVoiceCalls {
  constructor(notify, createSession = (api) => new ZaloRtcSession(api, { autoAttachListener: true, ringingTimeoutMs: 45000 }), options = {}) {
    this.notify = notify;
    this.createSession = createSession;
    this.diagnose = options.diagnose || (() => {});
    this.record = options.record || (() => {});
    this.incomingTimeoutMs = options.incomingTimeoutMs ?? 45000;
    this.setupTimeoutMs = options.setupTimeoutMs ?? 60000;
    this.accounts = new Map();
    this.listeners = new Map();
    this.active = new Map();
    this.pending = new Map();
  }

  trace(event, call, extra = {}) {
    this.diagnose(event, { accountId: call.accountId, threadId: call.threadId, callId: call.callId || call.session?.callId, trace: call.trace, ...extra });
  }

  instrument(api, call) {
    const wrapped = Object.create(api);
    wrapped.call = { ...api.call };
    for (const stage of ['requestVoiceCall', 'sendRequestVoiceCall', 'ringRingVoiceCall', 'answerVoiceCall']) {
      if (typeof api.call?.[stage] !== 'function') continue;
      wrapped.call[stage] = async (...args) => {
        const start = Date.now();
        this.trace('signal.start', call, { stage });
        try {
          const result = await api.call[stage](...args);
          this.trace('signal.ok', call, { stage, elapsedMs: Date.now() - start });
          return result;
        } catch (error) {
          this.trace('signal.error', call, { stage, code: Number(error?.code) || 0, elapsedMs: Date.now() - start });
          throw error;
        }
      };
    }
    return wrapped;
  }

  register(accountId, api) {
    const key = String(accountId);
    const old = this.listeners.get(key);
    if (old) old.api.listener.off('call_event', old.handler);
    this.finishPending(key, 'disconnected');
    void this.close(this.active.get(key), 'disconnected');
    this.accounts.set(key, api);
    const handler = (event) => {
      if (this.accounts.get(key) !== api) return;
      const act = event.type || event.act;
      let info;
      try { info = parseIncomingCallEvent(event, api.getContext().uid); }
      catch { this.diagnose('signal.invalid', { accountId: key }); return; }
      this.diagnose('signal.received', { accountId: key, callId: info.callId, stage: ['request', 'ringring', 'answer', 'answer_ack', 'cancel', 'end'].includes(act) ? act : 'other' });
      const pending = this.pending.get(key);
      if (['end', 'cancel'].includes(act)) {
        if (pending && info.callId && pending.callId === String(info.callId)) this.finishPending(key, 'missed');
        return;
      }
      if (act !== 'request' || info.isGroupCall || info.isVideo || !info.callerId || !info.callId) return;
      if (pending?.callId === String(info.callId) || this.active.has(key)) return;
      if (pending) this.finishPending(key, 'missed');
      const incoming = { event, accountId: key, threadId: String(info.callerId), callId: String(info.callId), trace: randomUUID(), createdAt: Date.now(), direction: 'incoming' };
      this.pending.set(key, incoming);
      incoming.timer = setTimeout(() => this.finishPending(key, 'missed'), this.incomingTimeoutMs);
      incoming.timer.unref?.();
      this.trace('incoming.received', incoming);
      // Receipt acknowledgement only; never auto-answer or open media/microphone.
      void this.instrument(api, incoming).call.ringRingVoiceCall(String(info.callerId), info.callId).catch(() => {});
      this.notify('call.incoming', { accountId: key, threadId: incoming.threadId, callId: incoming.trace });
    };
    this.listeners.set(key, { api, handler });
    api.listener.on('call_event', handler);
  }

  finishPending(key, reason) {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    this.completePending(pending, reason);
  }

  completePending(pending, reason) {
    if (pending.finalized) return;
    pending.finalized = true;
    const key = pending.accountId;
    clearTimeout(pending.timer);
    this.trace('incoming.ended', pending, { reason });
    this.notify('call.ended', { accountId: key, threadId: pending.threadId, callId: pending.trace });
    this.record({ accountId: pending.accountId, threadId: pending.threadId, trace: pending.trace, createdAt: pending.createdAt, direction: pending.direction, reason, connected: false, durationSeconds: 0 });
  }

  available(accountId) { return this.accounts.has(String(accountId)); }

  async open({ accountId, threadId, ownerId, incoming = false, send, onLease, mediaVersion = 1 }) {
    const key = String(accountId);
    const api = this.accounts.get(key);
    if (!api) throw new Error('Account chưa kết nối hoặc chưa hỗ trợ gọi thoại.');
    if (this.active.has(key)) throw new Error('Account đang có cuộc gọi khác.');
    const pending = this.pending.get(key);
    if (incoming && (!pending || pending.rejecting || pending.threadId !== String(threadId))) throw new Error('Cuộc gọi đến đã kết thúc.');
    if (!incoming && pending) throw new Error('Account đang có cuộc gọi đến.');
    const lease = { accountId: key, threadId: String(threadId), ownerId, trace: incoming ? pending.trace : randomUUID(), createdAt: incoming ? pending.createdAt : Date.now(), direction: incoming ? 'incoming' : 'outgoing', send, ended: false };
    const session = this.createSession(this.instrument(api, lease));
    lease.session = session;
    // Keep RTCP/UDP keepalive in the library. Suppress only its independent audio timer.
    const sendFrame = session.sendAudioFrame.bind(session);
    session.sendAudioFrame = (frame, options = {}) => options.isKeepalive ? Promise.resolve() : sendFrame(frame, options);
    lease.pacer = new VoiceFramePacer((frame) => sendFrame(frame));
    lease.sendAudioFrame = (frame) => lease.pacer.push(frame);
    this.active.set(key, lease);
    this.trace('call.open', lease, { direction: lease.direction });
    lease.setupTimer = setTimeout(() => {
      if (lease.activeAt || lease.ended) return;
      send({ type: 'error', message: 'Hết thời gian chờ kết nối. Chưa xác nhận người nhận đã đổ chuông; hãy kiểm tra quyền gọi trên Zalo và thử lại.' });
      void this.close(lease, 'setup_timeout');
    }, this.setupTimeoutMs);
    lease.setupTimer.unref?.();
    session.on('error', () => {
      this.trace('call.error', lease);
      send({ type: 'error', message: 'Kết nối cuộc gọi gặp lỗi. Hãy kết thúc và thử lại.' });
      void this.close(lease, 'error');
    });
    session.on('state', (status) => {
      if (lease.ended) return;
      this.trace('call.state', lease, { status });
      if (status === 'active' && !lease.activeAt) { lease.activeAt = Date.now(); clearTimeout(lease.setupTimer); }
      send({ type: 'state', status });
      if (status === 'ended' || status === 'error') void this.close(lease, status === 'error' ? 'error' : 'remote_end');
    });
    session.on('audio_frame', (frame) => {
      if (lease.ended || !frame.payload?.length || frame.payload.length > 4096) return;
      if (mediaVersion === 2 && Number.isInteger(frame.sequenceNumber)) {
        const header = Buffer.alloc(8);
        header.writeUInt16BE(0x5a43, 0);
        header.writeUInt16BE(frame.sequenceNumber & 0xffff, 2);
        header.writeUInt32BE(frame.timestamp >>> 0, 4);
        send(Buffer.concat([header, frame.payload]));
      } else send(frame.payload);
    });
    lease.ready = Promise.resolve().then(async () => {
      if (lease.ended) return;
      if (incoming) {
        this.pending.delete(key);
        clearTimeout(pending.timer);
        // Dismiss the ringing panel on other clients of this account.
        this.notify('call.ended', { accountId: key, threadId: pending.threadId, callId: pending.trace });
        await session.acceptIncomingCall(pending.event, { allowVideoUpgrade: false });
      } else {
        await session.startOutgoingCall(String(threadId), { callType: CallType.Audio, allowVideoUpgrade: false });
      }
      if (lease.ended) await session.endCall('user_hangup');
      else lease.pacer.start(() => { void this.close(lease, 'media_error'); });
    });
    onLease?.(lease);
    try { await lease.ready; return lease; }
    catch (error) { await this.close(lease, 'error'); throw error; }
  }

  async close(lease, reason = 'local_end') {
    if (!lease) return;
    if (lease.ended) return lease.closing;
    lease.ended = true;
    lease.endedAt = Date.now();
    lease.send?.({ type: 'state', status: 'ended' });
    clearTimeout(lease.setupTimer);
    lease.pacer.close();
    // Schedule after ready's rejection is observed; never await ready inside its catch.
    lease.closing = Promise.resolve().then(async () => {
      try {
        await lease.session.endCall('user_hangup');
        // Keep the lease until allocation has settled, preventing an old call racing a new one.
        await lease.ready?.catch(() => {});
        await lease.session.endCall('user_hangup');
      } catch {} finally {
        if (this.active.get(lease.accountId) === lease) this.active.delete(lease.accountId);
        lease.session.removeAllListeners();
        const durationSeconds = lease.activeAt ? Math.floor((lease.endedAt - lease.activeAt) / 1000) : 0;
        this.trace('call.ended', lease, { reason, durationSeconds, dropped: lease.pacer.dropped });
        this.record({ accountId: lease.accountId, threadId: lease.threadId, trace: lease.trace, createdAt: lease.createdAt, direction: lease.direction, reason, connected: Boolean(lease.activeAt), durationSeconds });
        sendEnded();
      }
    });
    const sendEnded = () => this.notify('call.ended', { accountId: lease.accountId, threadId: lease.threadId, callId: lease.trace });
    return lease.closing;
  }

  async disconnect(accountId) {
    const key = String(accountId);
    const registration = this.listeners.get(key);
    if (registration) registration.api.listener.off('call_event', registration.handler);
    this.listeners.delete(key);
    this.accounts.delete(key);
    this.finishPending(key, 'disconnected');
    await this.close(this.active.get(key), 'disconnected');
  }

  async reject({ accountId, threadId }) {
    const key = String(accountId);
    const pending = this.pending.get(key);
    const api = this.accounts.get(key);
    if (!pending || pending.threadId !== String(threadId) || !api) return;
    if (pending.rejecting) return;
    pending.rejecting = true;
    const session = this.createSession(this.instrument(api, pending));
    try { await session.rejectIncomingCall(pending.event); } finally {
      await session.endCall('rejected').catch(() => {});
      session.removeAllListeners();
      if (this.pending.get(key) === pending) this.pending.delete(key);
      this.completePending(pending, 'rejected');
    }
  }
}
