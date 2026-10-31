import crypto from 'node:crypto';
import { appendMessage, upsertContact, upsertThread } from '../lib/store.js';

export class MockProvider {
  constructor(store, emit) {
    this.store = store;
    this.emit = emit;
    this.timer = null;
  }

  hydrateInitialState() {
    this.store.update((state) => {
      state.labels = {
        items: [
          { id: 1, text: 'Khách mới', conversations: ['ut_direct_guest'], color: '#d91b1b', offset: 1, emoji: '', textKey: '', createTime: Date.now() },
          { id: 2, text: 'Bảo hành', conversations: [], color: '#0068ff', offset: 2, emoji: '', textKey: '', createTime: Date.now() }
        ],
        version: 1,
        lastUpdateTime: Date.now()
      };

      if (Object.keys(state.threads).length > 0) return state;

      upsertContact(state, {
        id: 'u_me',
        displayName: 'Tehui Support',
        avatarUrl: '',
        isSelf: true,
        kind: 'self'
      });

      upsertContact(state, {
        id: 'u_anhkhoa',
        displayName: 'Anh Khoa',
        avatarUrl: '',
        kind: 'friend'
      });

      upsertContact(state, {
        id: 'u_guest_001',
        displayName: 'Khách lạ 0909***321',
        avatarUrl: '',
        kind: 'stranger'
      });

      upsertContact(state, {
        id: 'g_sales',
        displayName: 'Nhóm Sale',
        avatarUrl: '',
        kind: 'group'
      });

      upsertThread(state, {
        id: 't_direct_anhkhoa',
        title: 'Anh Khoa',
        type: 'direct',
        participantIds: ['u_anhkhoa']
      });

      upsertThread(state, {
        id: 't_direct_guest',
        title: 'Khách lạ 0909***321',
        type: 'direct',
        participantIds: ['u_guest_001'],
        tags: ['Khách mới']
      });

      upsertThread(state, {
        id: 't_group_sales',
        title: 'Nhóm Sale',
        type: 'group',
        participantIds: ['u_anhkhoa', 'u_guest_001']
      });

      appendMessage(state, createMessage({
        threadId: 't_direct_anhkhoa',
        senderId: 'u_anhkhoa',
        text: 'Chào anh, bên mình còn máy này không?',
        isOutgoing: false
      }));

      appendMessage(state, createMessage({
        threadId: 't_direct_guest',
        senderId: 'u_guest_001',
        text: 'Cho em xin giá thay pin nhé',
        isOutgoing: false
      }));

      appendMessage(state, createMessage({
        threadId: 't_group_sales',
        senderId: 'u_anhkhoa',
        text: 'Nhóm test đồng bộ realtime',
        isOutgoing: false
      }));

      state.session.status = 'logged_out';
      state.session.provider = 'mock';
      state.session.updatedAt = new Date().toISOString();
      state.session.syncInfo = {
        lastSyncAt: new Date().toISOString(),
        directHistorySupported: true,
        note: 'Mock mode'
      };
      return state;
    });
  }

  startQrLogin() {
    const qrCode = `mock-qr-${crypto.randomUUID()}`;
    const next = this.store.update((state) => {
      state.session.status = 'awaiting_qr_scan';
      state.session.qrCode = qrCode;
      state.session.updatedAt = new Date().toISOString();
      return state;
    });
    this.emit('session.updated', next.session);
    return next.session;
  }

  confirmQrLogin() {
    const next = this.store.update((state) => {
      state.session.status = 'connected';
      state.session.qrCode = null;
      state.session.account = {
        id: 'zalo_mock_001',
        displayName: 'Tehui Zalo Demo',
        avatarUrl: ''
      };
      state.session.updatedAt = new Date().toISOString();
      return state;
    });
    this.emit('session.updated', next.session);
    this.attachRealtime();
    return next.session;
  }

  sendMessage({ threadId, text }) {
    const message = createMessage({
      threadId,
      senderId: 'u_me',
      text,
      isOutgoing: true
    });

    const next = this.store.update((state) => {
      appendMessage(state, message);
      const thread = state.threads[threadId];
      if (thread) thread.unreadCount = 0;
      return state;
    });

    this.emit('message.created', { threadId, message, view: next });

    setTimeout(() => {
      const reply = createMessage({
        threadId,
        senderId: pickReplySender(next.threads[threadId]),
        text: `Đã nhận: ${text}`,
        isOutgoing: false
      });
      const echoed = this.store.update((state) => {
        appendMessage(state, reply);
        return state;
      });
      this.emit('message.created', { threadId, message: reply, view: echoed });
    }, 900);

    return message;
  }

  markThreadRead(threadId) {
    this.store.update((state) => {
      if (state.threads[threadId]) {
        state.threads[threadId].unreadCount = 0;
      }
      return state;
    });
    return { ok: true };
  }

  async bootstrapSync() {
    return { ok: true, mode: 'mock' };
  }

  async updateThreadTags(threadId, requestedTags) {
    this.store.update((state) => {
      if (state.threads[threadId]) state.threads[threadId].tags = [...requestedTags];
      return state;
    });
    return { ok: true };
  }

  attachRealtime() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const state = this.store.read();
      if (state.session.status !== 'connected') return;
      const threadIds = Object.keys(state.threads);
      if (threadIds.length === 0) return;
      const threadId = threadIds[Math.floor(Math.random() * threadIds.length)];
      const senderId = pickReplySender(state.threads[threadId]);
      const samples = [
        'Bên mình còn hàng không ạ?',
        'Cho em xin địa chỉ cửa hàng với',
        'Tối nay qua lấy được không?',
        'Nhờ kiểm tra tin nhắn giúp em'
      ];
      const reply = createMessage({
        threadId,
        senderId,
        text: samples[Math.floor(Math.random() * samples.length)],
        isOutgoing: false
      });
      const next = this.store.update((draft) => {
        appendMessage(draft, reply);
        return draft;
      });
      this.emit('message.created', { threadId, message: reply, view: next });
    }, 25000);
  }
}

function createMessage({ threadId, senderId, text, isOutgoing }) {
  return {
    id: crypto.randomUUID(),
    threadId,
    senderId,
    text,
    type: 'text',
    isOutgoing,
    createdAt: new Date().toISOString()
  };
}

function pickReplySender(thread) {
  return thread?.participantIds?.[0] || 'u_guest_001';
}
