import fs from 'node:fs';
import path from 'node:path';
import { Zalo, ThreadType, AvatarSize, LoginQRCallbackEventType } from 'zca-js';
import { appendMessage, getAccountScopedState, replaceThreadMessages, resetChatState, switchActiveAccountState, updateAccountScopedState, upsertContact, upsertThread } from '../lib/store.js';

const LABEL_COLORS = ['#d91b1b', '#f31bc8', '#ff6905', '#fac000', '#4bc377', '#0068ff', '#7c3aed', '#0891b2'];
const GROUP_HISTORY_SYNC_COUNT = Math.max(30, Math.min(200, Number(process.env.ZALO_GROUP_HISTORY_SYNC_COUNT || 100)));
const GROUP_HISTORY_SYNC_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.ZALO_GROUP_HISTORY_SYNC_CONCURRENCY || 4)));
const GROUP_MEMBER_SYNC_BATCH_SIZE = Math.max(20, Math.min(200, Number(process.env.ZALO_GROUP_MEMBER_SYNC_BATCH_SIZE || 100)));
const GROUP_MEMBER_SYNC_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.ZALO_GROUP_MEMBER_SYNC_CONCURRENCY || 3)));
const MESSAGE_SYNC_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
const KEEPALIVE_FAIL_THRESHOLD = Math.max(1, Math.min(10, Number(process.env.ZALO_KEEPALIVE_FAIL_THRESHOLD || 3)));

const ZALO_CLIENT_OPTIONS = {
  selfListen: true,
  checkUpdate: true,
  logging: true,
  imageMetadataGetter: getImageMetadata
};

export class ZaloWebProvider {
  constructor(store, emit) {
    this.store = store;
    this.emit = emit;
    this.activeApi = null;
    this.api = null;
    this.loginPromise = null;
    this.zalo = null;
    this.credentialsPath = path.join(store.baseDir, 'credentials.json');
    this.credentialsDir = path.join(store.baseDir, 'accounts');
    this.accountClients = new Map();
    this.keepAliveTimers = new Map();
    this.realtimeAttached = new Set();
    this.pendingAlbumWebhooks = new Map();
    this.pendingQrCredentials = null;
    this.accountSyncPromises = new Map();
    this.keepAliveFailures = new Map();
  }

  get api() {
    const activeKey = String(this.store?.read?.().activeAccountId || '').trim();
    return (activeKey ? this.accountClients?.get(activeKey)?.api : null) || this.activeApi || null;
  }

  set api(value) {
    this.activeApi = value || null;
  }

  isActiveAccount(accountId) {
    return String(this.store.read().activeAccountId || '') === String(accountId || '');
  }

  getAccountApi(accountId = null) {
    const key = String(accountId || '').trim();
    if (key) return this.accountClients.get(key)?.api || null;
    const activeKey = String(this.store.read().activeAccountId || '').trim();
    return (activeKey ? this.accountClients.get(activeKey)?.api : null) || this.api;
  }

  updateAccountState(accountId, mutator) {
    let nextSnapshot = null;
    const key = String(accountId || this.store.read().activeAccountId || '');
    const nextState = this.store.update((state) => {
      nextSnapshot = updateAccountScopedState(state, key, mutator);
      return state;
    });
    return { nextState, nextSnapshot, isActive: this.isActiveAccount(key) };
  }

  queueAccountSync(accountId, options = {}) {
    const key = String(accountId || '').trim();
    if (!key) return Promise.resolve(null);
    const existing = this.accountSyncPromises.get(key);
    if (existing) return existing;
    const task = this.syncAllData({ ...options, accountId: key })
      .catch((error) => {
        console.error('[zalo-user-server] background sync failed', key, error?.message || error);
        this.store.update((state) => {
          if (state.accounts[key]) {
            state.accounts[key].status = this.accountClients.get(key)?.api ? 'connected' : 'sync_failed';
            state.accounts[key].error = error?.message || String(error) || 'Sync dữ liệu thất bại';
            state.accounts[key].updatedAt = new Date().toISOString();
          }
          if (String(state.activeAccountId || '') === key && this.accountClients.get(key)?.api) {
            state.session.status = 'connected';
            state.session.error = error?.message || String(error) || 'Sync dữ liệu thất bại';
            state.session.updatedAt = new Date().toISOString();
          }
          return state;
        });
        this.emit('session.updated', this.store.read().session);
        throw error;
      })
      .finally(() => {
        if (this.accountSyncPromises.get(key) === task) this.accountSyncPromises.delete(key);
      });
    this.accountSyncPromises.set(key, task);
    return task;
  }

  handleConnectionLoss(error, status = 'reconnect_failed', accountId = null) {
    const targetAccountId = accountId || this.store.read().activeAccountId || null;
    if (targetAccountId) {
      const client = this.accountClients.get(targetAccountId);
      if (client) client.api = null;
      this.keepAliveFailures.delete(targetAccountId);
      const timer = this.keepAliveTimers.get(targetAccountId);
      if (timer) {
        clearInterval(timer);
        this.keepAliveTimers.delete(targetAccountId);
      }
      this.realtimeAttached.delete(targetAccountId);
      this.store.update((state) => {
        if (state.accounts[targetAccountId]) {
          state.accounts[targetAccountId].status = status;
          state.accounts[targetAccountId].error = error?.message || String(error) || 'Mất kết nối Zalo';
          state.accounts[targetAccountId].updatedAt = new Date().toISOString();
        }
        if (String(state.activeAccountId || '') === String(targetAccountId)) {
          state.session.status = status;
          state.session.error = error?.message || String(error) || 'Mất kết nối Zalo';
          state.session.updatedAt = new Date().toISOString();
        }
        return state;
      });
    } else {
      this.store.update((state) => {
        state.session.status = status;
        state.session.error = error?.message || String(error) || 'Mất kết nối Zalo';
        state.session.updatedAt = new Date().toISOString();
        return state;
      });
    }
    this.emit('session.updated', this.store.read().session);
  }

  async hydrateInitialState() {
    fs.mkdirSync(this.credentialsDir, { recursive: true });
    if (fs.existsSync(this.credentialsPath)) {
      const legacyDir = path.join(this.credentialsDir, 'legacy');
      const legacyPath = path.join(legacyDir, 'credentials.json');
      if (!fs.existsSync(legacyPath)) {
        fs.mkdirSync(legacyDir, { recursive: true });
        fs.copyFileSync(this.credentialsPath, legacyPath);
      }
    }

    const entries = this.listCredentialEntries();
    this.store.update((state) => {
      if (!entries.length) {
        resetChatState(state);
        state.accounts = {};
        state.accountStateById = {};
        state.activeAccountId = null;
      }
      state.session.provider = 'zalo-web';
      state.session.qrCode = null;
      state.session.qrImage = null;
      state.session.error = null;
      state.session.status = entries.length ? state.session.status : 'logged_out';
      state.session.updatedAt = new Date().toISOString();
      return state;
    });

    if (!entries.length) return;

    const credentialIds = new Set(entries.map((entry) => String(entry.accountId)));
    let desiredActive = String(this.store.read().activeAccountId || entries[0].accountId);
    if (!credentialIds.has(desiredActive)) desiredActive = String(entries[0].accountId);
    for (const entry of entries) {
      try {
        const credentials = JSON.parse(fs.readFileSync(entry.filePath, 'utf8'));
        const syncUi = String(entry.accountId) === String(desiredActive);
        const hasStoredHistory = hasPersistedAccountHistory(this.store.read(), entry.accountId);
        await this.restoreLogin(credentials, entry.accountId, { syncUi, loadHistory: !hasStoredHistory });
      } catch (error) {
        this.handleConnectionLoss(error, 'reconnect_failed', entry.accountId);
      }
    }

    const current = this.store.read();
    const activeReady = current.activeAccountId && this.accountClients.get(String(current.activeAccountId))?.api;
    if (!activeReady) {
      const firstReady = entries.find((entry) => this.accountClients.get(String(entry.accountId))?.api)?.accountId || null;
      const firstKnown = firstReady || Object.keys(current.accounts || {}).find((id) => this.accountClients.get(String(id))?.api) || null;
      if (firstKnown) await this.selectAccount(firstKnown, { loadHistory: false }).catch(() => null);
    }
  }

  startQrLogin(options = {}) {
    if (this.loginPromise) {
      const current = this.store.read().session || {};
      const retryable = ['qr_declined', 'qr_expired'].includes(current.status);
      if (!retryable) return current;
      // zca-js resolves its callback flow with `undefined` after a declined QR.
      // Clear the settled/stale promise so this click starts a genuinely new QR.
      this.loginPromise = null;
    }

    this.pendingQrCredentials = null;
    this.zalo = new Zalo(ZALO_CLIENT_OPTIONS);
    this.store.update((state) => {
      state.session.provider = 'zalo-web';
      state.session.status = 'starting_qr';
      state.session.error = null;
      state.session.updatedAt = new Date().toISOString();
      return state;
    });
    this.emit('session.updated', this.store.read().session);

    this.loginPromise = this.zalo
      .loginQR({}, (event) => this.onLoginEvent(event))
      .then(async (api) => {
        this.api = api;
        const accountId = await this.afterLogin(api, null, { syncUi: true, credentials: this.pendingQrCredentials, loadHistory: true });
        const session = this.store.read().session;
        const account = this.store.read().accounts?.[accountId] || {};
        // The caller can atomically attach the newly authenticated account to its
        // authorized portal department before the QR flow is considered complete.
        if (typeof options.onAuthenticated === 'function') await options.onAuthenticated({
          ...session,
          account: { ...account, id: accountId, userId: accountId }
        });
        return session;
      })
      .catch((error) => {
        this.handleConnectionLoss(error, 'login_error');
        throw error;
      })
      .finally(() => {
        this.loginPromise = null;
        this.pendingQrCredentials = null;
      });

    return this.store.read().session;
  }

  confirmQrLogin() {
    throw new Error('Provider thật không hỗ trợ xác nhận giả lập. Hãy quét mã bằng app Zalo.');
  }


  async searchUsers(query) {
    const accountId = String(this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    const keyword = String(query || '').trim();
    if (!keyword) return [];

    const attempts = [];
    if (/^\+?\d{8,15}$/.test(keyword.replace(/\s+/g, ''))) {
      attempts.push(() => api.findUser(keyword.replace(/\s+/g, ''), AvatarSize.Small));
    }
    attempts.push(() => api.findUserByUsername(keyword, AvatarSize.Small));

    const results = [];
    const seen = new Set();
    for (const run of attempts) {
      try {
        const user = await run();
        const normalized = normalizeFoundUser(user);
        if (normalized && !seen.has(normalized.id)) {
          const relation = await api.getFriendRequestStatus(normalized.id).catch(() => null);
          seen.add(normalized.id);
          results.push({
            ...normalized,
            isFriend: relation?.is_friend === 1,
            isRequested: relation?.is_requested === 1,
            isRequesting: relation?.is_requesting === 1
          });
        }
      } catch {
        // ignore individual lookup errors
      }
    }
    return results;
  }

  async refreshFriendStatus(userId, options = {}) {
    const accountId = String(options.accountId || this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    const targetId = String(userId || '').trim();
    if (!targetId) throw new Error('Thiếu userId');

    const [relation, profileInfo] = await Promise.all([
      api.getFriendRequestStatus(targetId).catch(() => null),
      api.getUserInfo(targetId, AvatarSize.Small).catch(() => null)
    ]);
    const profile = profileInfo?.changed_profiles?.[targetId] || null;
    const normalized = profile ? normalizeUser(profile, profile.isFr ? 'friend' : 'stranger', targetId) : null;
    const nextRelation = relation?.is_friend === 1
      ? 'friend'
      : relation?.is_requesting === 1
        ? 'incoming_request'
        : relation?.is_requested === 1
          ? 'outgoing_request'
          : 'stranger';

    this.updateAccountState(accountId, (draft) => {
      const existing = draft.contacts[targetId] || {};
      const removeUserFromSocialLists = () => {
        draft.zalo.incomingRequests = (draft.zalo.incomingRequests || []).filter((item) => String(item.id) !== targetId);
        draft.zalo.sentRequests = (draft.zalo.sentRequests || []).filter((item) => String(item.id) !== targetId);
        draft.zalo.recommendations = (draft.zalo.recommendations || []).filter((item) => String(item.id) !== targetId);
      };

      if (nextRelation === 'friend') {
        removeUserFromSocialLists();
        draft.zalo.blockedUsers = (draft.zalo.blockedUsers || []).filter((item) => String(item.id) !== targetId);
      } else if (nextRelation === 'incoming_request') {
        const incoming = buildSocialUserRecord(targetId, normalized || existing, '');
        draft.zalo.incomingRequests = [incoming, ...(draft.zalo.incomingRequests || []).filter((item) => String(item.id) !== targetId)];
        draft.zalo.sentRequests = (draft.zalo.sentRequests || []).filter((item) => String(item.id) !== targetId);
      } else if (nextRelation === 'outgoing_request') {
        const sent = buildSocialUserRecord(targetId, normalized || existing, '');
        draft.zalo.sentRequests = [sent, ...(draft.zalo.sentRequests || []).filter((item) => String(item.id) !== targetId)];
        draft.zalo.incomingRequests = (draft.zalo.incomingRequests || []).filter((item) => String(item.id) !== targetId);
      } else {
        removeUserFromSocialLists();
      }

      upsertContact(draft, {
        ...existing,
        ...(normalized || {}),
        id: targetId,
        kind: nextRelation === 'friend' ? 'friend' : existing.kind === 'blocked' ? 'blocked' : 'stranger'
      });
      if (draft.threads[targetId]) {
        draft.threads[targetId].source = nextRelation === 'friend' ? 'friend' : nextRelation === 'incoming_request' ? 'incoming_request' : nextRelation === 'outgoing_request' ? 'outgoing_request' : 'stranger';
      }
      return draft;
    });

    return { ok: true, relation: nextRelation };
  }

  async sendFriendRequest(userId, message = '', profile = {}, options = {}) {
    const accountId = String(options.accountId || this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    await api.sendFriendRequest(message || 'Xin chào, mình muốn kết bạn qua Zalo.', String(userId));
    this.updateAccountState(accountId, (draft) => {
      const nextItem = {
        id: String(userId),
        displayName: profile.displayName || profile.zaloName || profile.username || String(userId),
        avatarUrl: profile.avatarUrl || profile.avatar || '',
        message: message || 'Xin chào, mình muốn kết bạn qua Zalo.',
        time: Date.now()
      };
      const rest = (draft.zalo.sentRequests || []).filter((item) => String(item.id) !== String(userId));
      draft.zalo.sentRequests = [nextItem, ...rest];
      draft.zalo.recommendations = (draft.zalo.recommendations || []).filter((item) => String(item.id) !== String(userId));
      return draft;
    });
    return { ok: true };
  }

  async acceptFriendRequest(userId, profile = {}) {
    const accountId = String(this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    await api.acceptFriendRequest(String(userId));
    this.updateAccountState(accountId, (draft) => {
      const incoming = (draft.zalo.incomingRequests || []).find((item) => String(item.id) === String(userId)) || {};
      draft.zalo.incomingRequests = (draft.zalo.incomingRequests || []).filter((item) => String(item.id) !== String(userId));
      draft.zalo.blockedUsers = (draft.zalo.blockedUsers || []).filter((item) => String(item.id) !== String(userId));
      upsertContact(draft, {
        ...(draft.contacts[String(userId)] || {}),
        id: String(userId),
        displayName: profile.displayName || incoming.displayName || draft.contacts[String(userId)]?.displayName || String(userId),
        avatarUrl: profile.avatarUrl || profile.avatar || incoming.avatarUrl || draft.contacts[String(userId)]?.avatarUrl || '',
        phoneNumber: profile.phoneNumber || incoming.phoneNumber || draft.contacts[String(userId)]?.phoneNumber || '',
        kind: 'friend'
      });
      if (draft.threads[String(userId)]) draft.threads[String(userId)].source = 'friend';
      return draft;
    });
    return { ok: true };
  }

  async rejectFriendRequest(userId) {
    const accountId = String(this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    await api.rejectFriendRequest(String(userId));
    this.updateAccountState(accountId, (draft) => {
      draft.zalo.incomingRequests = (draft.zalo.incomingRequests || []).filter((item) => String(item.id) !== String(userId));
      const contact = draft.contacts[String(userId)];
      if (contact && contact.kind !== 'friend' && contact.kind !== 'blocked') contact.kind = 'stranger';
      return draft;
    });
    return { ok: true };
  }

  async getThreadProfile(threadId) {
    const { api, accountState, thread } = this.getActiveThreadContext(threadId);

    if (thread.type === 'group') {
      const info = await api.getGroupInfo(threadId).catch(() => ({ gridInfoMap: {} }));
      const group = info?.gridInfoMap?.[threadId] || null;
      const memberIds = extractGroupMemberIds(group, thread.participantIds || []);
      const memberProfiles = memberIds.length
        ? await api.getGroupMembersInfo(memberIds).catch(() => ({ profiles: {} }))
        : { profiles: {} };
      return {
        type: 'group',
        threadId,
        title: group?.name || thread.title,
        subtitle: `${group?.totalMember || memberIds.length || thread.participantIds?.length || 0} thành viên`,
        avatarUrl: group?.fullAvt || group?.avt || thread.avatarUrl || '',
        coverUrl: group?.fullAvt || group?.avt || thread.avatarUrl || '',
        description: group?.desc || '',
        createdTime: group?.createdTime || null,
        totalMember: group?.totalMember || memberIds.length || thread.participantIds?.length || 0,
        members: memberIds.map((id) => normalizeGroupMemberProfile(memberProfiles?.profiles?.[id] || {}, group?.currentMems?.find((item) => String(item.id) === String(id)) || {}, accountState.contacts?.[id] || {})),
        capabilities: {
          call: false,
          videoCall: false,
          leaveGroup: true,
          silentLeave: true,
          inviteMember: typeof api.addUserToGroup === 'function' || typeof api.inviteUserToGroups === 'function',
          shareGroupLink: typeof api.enableGroupLink === 'function'
        }
      };
    }

    const profileRes = await api.getUserInfo(threadId, AvatarSize.Large).catch(() => ({ changed_profiles: {} }));
    const profile = profileRes?.changed_profiles?.[threadId] || {};
    const contact = accountState.contacts?.[threadId] || {};
    return {
      type: 'direct',
      threadId,
      title: profile.displayName || profile.zaloName || contact.displayName || thread?.title || threadId,
      subtitle: profile.status || contact.status || 'Zalo user',
      avatarUrl: profile.avatar || contact.avatarUrl || thread?.avatarUrl || '',
      coverUrl: profile.cover || profile.bgavatar || '',
      phoneNumber: profile.phoneNumber || contact.phoneNumber || '',
      username: profile.username || contact.username || '',
      status: profile.status || contact.status || '',
      gender: profile.gender ?? null,
      dob: profile.sdob || profile.dob || null,
      zaloName: profile.zaloName || contact.zaloName || '',
      globalId: profile.globalId || contact.globalId || '',
      capabilities: {
        call: false,
        videoCall: false,
        leaveGroup: false,
        silentLeave: false,
        inviteMember: false,
        shareGroupLink: false
      }
    };
  }

  async sendMessage({ threadId, text = '', attachments = [], attachmentMeta = [], replyToId = null, mentions = [], accountId: requestedAccountId = null }) {
    const accountId = String(requestedAccountId || this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    let accountState = getAccountScopedState(this.store.read(), accountId);
    let thread = accountState?.threads?.[threadId];
    if (!thread) {
      await this.ensureDirectThreadMetadata(threadId, accountId);
      accountState = getAccountScopedState(this.store.read(), accountId);
      thread = accountState?.threads?.[threadId];
    }
    if (!thread) throw new Error('Không tìm thấy hội thoại');

    const threadType = thread.type === 'group' ? ThreadType.Group : ThreadType.User;
    const messageText = String(text || '');
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!messageText.trim() && !hasAttachments) {
      throw new Error('Tin nhắn trống');
    }

    const quoteSource = replyToId ? this.findMessage(threadId, String(replyToId), accountState) : null;
    const quote = buildSendMessageQuote(quoteSource);
    const normalizedMentions = normalizeOutgoingMentions(mentions, messageText, threadType);
    try {
      await api.sendMessage(
        {
          msg: messageText,
          ...(hasAttachments ? { attachments } : {}),
          ...(quote ? { quote } : {}),
          ...(normalizedMentions.length ? { mentions: normalizedMentions } : {})
        },
        threadId,
        threadType
      );
    } catch (error) {
      throw error;
    }

    return {
      ok: true,
      threadId,
      text: summarizeOutgoingMessageText(messageText, attachmentMeta),
      hasAttachments,
      sentAt: new Date().toISOString(),
    };
  }

  async sendStickerMessage(threadId, sticker, options = {}) {
    // Sticker is still a special-case path: we keep a local append + emit here
    // because sticker round-trips can feel laggy. If duplicate regressions return,
    // inspect this branch first before touching the generic send/search paths.
    const accountId = String(options.accountId || this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    const accountState = getAccountScopedState(this.store.read(), accountId);
    const thread = accountState?.threads?.[threadId];
    if (!thread) throw new Error('Không tìm thấy hội thoại');

    const stickerPayload = {
      id: Number(sticker?.id),
      cateId: Number(sticker?.cateId),
      type: Number(sticker?.type)
    };
    if (!stickerPayload.id || Number.isNaN(stickerPayload.cateId) || !stickerPayload.type) {
      throw new Error('Thiếu dữ liệu sticker hợp lệ');
    }

    await api.sendSticker(stickerPayload, threadId, thread.type === 'group' ? ThreadType.Group : ThreadType.User);

    const selfId = accountState?.session?.account?.id || accountId || 'self';
    const message = {
      id: `local-sticker-${Date.now()}`,
      threadId,
      senderId: selfId,
      text: String(sticker?.stickerWebpUrl || sticker?.stickerUrl || ''),
      type: 'chat.sticker',
      sticker: normalizeStickerDetail(sticker),
      isOutgoing: true,
      createdAt: new Date().toISOString()
    };

    const { nextState, isActive } = this.updateAccountState(accountId, (draft) => {
      appendMessage(draft, message);
      if (draft.threads[threadId]) draft.threads[threadId].unreadCount = 0;
      return draft;
    });
    if (isActive) this.emit('message.created', { accountId, threadId, message, view: nextState });
    return message;
  }

  async getStickerCatalog() {
    const response = await fetch('https://stickers.zaloapp.com/sticker', {
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Không tải được danh mục sticker từ Zalo');
    const data = await response.json();
    return normalizeStickerCatalog(data?.value || {});
  }

  listAccounts() {
    return Object.values(this.store.read().accounts || {});
  }

  getActiveThreadContext(threadId, { requireApi = true, accountId: requestedAccountId = null } = {}) {
    const accountId = String(requestedAccountId || this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (requireApi && !api) throw new Error('Chưa kết nối Zalo');
    const accountState = getAccountScopedState(this.store.read(), accountId);
    const thread = accountState?.threads?.[threadId];
    if (!thread) throw new Error('Không tìm thấy hội thoại');
    return { accountId, api, accountState, thread };
  }

  async sendTypingEvent(threadId, threadType = 'User', typing = true, options = {}) {
    const { api, thread } = this.getActiveThreadContext(threadId, { accountId: options.accountId || null });
    if (!typing) return { ok: true, skipped: true, reason: 'zca-js không có API stop typing riêng' };
    const normalizedType = thread?.type === 'group' || String(threadType || '').toLowerCase() === 'group' ? ThreadType.Group : ThreadType.User;
    await api.sendTypingEvent(String(threadId), normalizedType);
    return { ok: true };
  }

  async getStickerPackDetail(cateId) {
    const accountId = String(this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    const numericCateId = Number(cateId);
    if (!numericCateId) throw new Error('cateId không hợp lệ');
    const stickers = await api.getStickerCategoryDetail(numericCateId);
    return (stickers || []).map((item) => normalizeStickerDetail(item));
  }

  async markThreadRead(threadId) {
    const { accountId, api, thread } = this.getActiveThreadContext(threadId, { requireApi: false });
    if (api) {
      const threadType = thread.type === 'group' ? ThreadType.Group : ThreadType.User;
      await api.removeUnreadMark(threadId, threadType).catch(() => null);
    }
    this.updateAccountState(accountId, (draft) => {
      if (draft.threads[threadId]) draft.threads[threadId].unreadCount = 0;
      return draft;
    });
    return { ok: true };
  }

  async markThreadUnread(threadId) {
    const { accountId, api, thread } = this.getActiveThreadContext(threadId);
    await api.addUnreadMark(threadId, this.getThreadType(thread));
    this.updateAccountState(accountId, (draft) => {
      if (draft.threads[threadId]) draft.threads[threadId].unreadCount = Math.max(1, draft.threads[threadId].unreadCount || 0);
      return draft;
    });
    return { ok: true };
  }

  async leaveGroup(threadId, silent = false) {
    const { api, thread } = this.getActiveThreadContext(threadId);
    if (thread.type !== 'group') throw new Error('Đây không phải nhóm');
    await api.leaveGroup(threadId, Boolean(silent));
    return { ok: true };
  }

  async getOrCreateGroupLink(threadId) {
    const { api, thread } = this.getActiveThreadContext(threadId);
    if (thread.type !== 'group') throw new Error('Đây không phải nhóm');
    const result = await api.enableGroupLink(threadId);
    return { ok: true, ...(result || {}) };
  }

  async inviteUsersToGroup(threadId, userIds = []) {
    const { api, thread } = this.getActiveThreadContext(threadId);
    if (thread.type !== 'group') throw new Error('Đây không phải nhóm');
    const ids = uniqueStrings(userIds);
    if (!ids.length) throw new Error('Thiếu userId');
    if (typeof api.addUserToGroup === 'function') {
      await api.addUserToGroup(ids, threadId);
    } else if (typeof api.inviteUserToGroups === 'function') {
      for (const id of ids) await api.inviteUserToGroups(id, threadId);
    } else {
      throw new Error('API hiện tại chưa hỗ trợ mời thành viên vào nhóm');
    }
    return { ok: true };
  }

  async setConversationPinned(threadId, pinned) {
    const { accountId, api, thread } = this.getActiveThreadContext(threadId);
    await api.setPinnedConversations(Boolean(pinned), threadId, this.getThreadType(thread));
    this.updateAccountState(accountId, (draft) => {
      if (draft.threads[threadId]) draft.threads[threadId].pinned = Boolean(pinned);
      return draft;
    });
    return { ok: true, pinned: Boolean(pinned) };
  }

  async setConversationArchived(threadId, archived) {
    const { accountId, api, thread } = this.getActiveThreadContext(threadId);
    await api.updateArchivedChatList(Boolean(archived), { id: threadId, type: this.getThreadType(thread) });
    this.updateAccountState(accountId, (draft) => {
      if (draft.threads[threadId]) draft.threads[threadId].archived = Boolean(archived);
      return draft;
    });
    return { ok: true, archived: Boolean(archived) };
  }

  async setConversationHidden(threadId, hidden) {
    const { accountId, api, thread } = this.getActiveThreadContext(threadId);
    await api.setHiddenConversations(Boolean(hidden), threadId, this.getThreadType(thread));
    this.updateAccountState(accountId, (draft) => {
      if (draft.threads[threadId]) draft.threads[threadId].hidden = Boolean(hidden);
      return draft;
    });
    return { ok: true, hidden: Boolean(hidden) };
  }

  async setConversationMuted(threadId, muted) {
    const { accountId, api, thread } = this.getActiveThreadContext(threadId);
    await api.setMute(muted ? { duration: -1, action: 1 } : { action: 3 }, threadId, this.getThreadType(thread));
    this.updateAccountState(accountId, (draft) => {
      if (draft.threads[threadId]) draft.threads[threadId].muted = Boolean(muted);
      return draft;
    });
    return { ok: true, muted: Boolean(muted) };
  }

  async setConversationAutoDelete(threadId, ttl) {
    const { accountId, api, thread } = this.getActiveThreadContext(threadId);
    await api.updateAutoDeleteChat(Number(ttl) || 0, threadId, this.getThreadType(thread));
    this.updateAccountState(accountId, (draft) => {
      if (draft.threads[threadId]) {
        draft.threads[threadId].autoDelete = Number(ttl) > 0;
        draft.threads[threadId].autoDeleteTtl = Number(ttl) || 0;
      }
      return draft;
    });
    return { ok: true, ttl: Number(ttl) || 0 };
  }

  async addReaction(threadId, messageId, icon) {
    const { api, accountState, thread } = this.getActiveThreadContext(threadId);
    const message = this.findMessage(threadId, messageId, accountState);
    if (!message?.raw?.msgId || !message?.raw?.cliMsgId) throw new Error('Tin nhắn này chưa đủ dữ liệu để thả cảm xúc');
    await api.addReaction(icon, {
      data: { msgId: String(message.raw.msgId), cliMsgId: String(message.raw.cliMsgId) },
      threadId,
      type: this.getThreadType(thread)
    });
    return { ok: true };
  }

  async undoFriendRequest(userId) {
    const accountId = String(this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    await api.undoFriendRequest(String(userId));
    this.updateAccountState(accountId, (draft) => {
      draft.zalo.sentRequests = (draft.zalo.sentRequests || []).filter((item) => String(item.id) !== String(userId));
      return draft;
    });
    return { ok: true };
  }

  async removeFriend(userId, profile = {}) {
    const accountId = String(this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    await api.removeFriend(String(userId));
    this.updateAccountState(accountId, (draft) => {
      const existing = draft.contacts[String(userId)] || {};
      draft.zalo.incomingRequests = (draft.zalo.incomingRequests || []).filter((item) => String(item.id) !== String(userId));
      draft.zalo.sentRequests = (draft.zalo.sentRequests || []).filter((item) => String(item.id) !== String(userId));
      draft.zalo.recommendations = (draft.zalo.recommendations || []).filter((item) => String(item.id) !== String(userId));
      upsertContact(draft, {
        ...existing,
        id: String(userId),
        displayName: profile.displayName || existing.displayName || String(userId),
        avatarUrl: profile.avatarUrl || profile.avatar || existing.avatarUrl || '',
        phoneNumber: profile.phoneNumber || existing.phoneNumber || '',
        kind: 'stranger'
      });
      if (draft.threads[String(userId)]) draft.threads[String(userId)].source = 'stranger';
      return draft;
    });
    return { ok: true };
  }

  async blockUser(userId, profile = {}) {
    const accountId = String(this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    await api.blockUser(String(userId));
    this.updateAccountState(accountId, (draft) => {
      const existing = draft.contacts[String(userId)] || {};
      const nextBlocked = {
        id: String(userId),
        displayName: profile.displayName || existing.displayName || String(userId),
        avatarUrl: profile.avatarUrl || profile.avatar || existing.avatarUrl || '',
        phoneNumber: profile.phoneNumber || existing.phoneNumber || ''
      };
      draft.zalo.incomingRequests = (draft.zalo.incomingRequests || []).filter((item) => String(item.id) !== String(userId));
      draft.zalo.sentRequests = (draft.zalo.sentRequests || []).filter((item) => String(item.id) !== String(userId));
      draft.zalo.recommendations = (draft.zalo.recommendations || []).filter((item) => String(item.id) !== String(userId));
      draft.zalo.blockedUsers = [nextBlocked, ...(draft.zalo.blockedUsers || []).filter((item) => String(item.id) !== String(userId))];
      upsertContact(draft, {
        ...existing,
        ...nextBlocked,
        kind: 'blocked'
      });
      if (draft.threads[String(userId)]) draft.threads[String(userId)].source = 'blocked';
      return draft;
    });
    return { ok: true };
  }

  async unblockUser(userId, profile = {}) {
    const accountId = String(this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    await api.unblockUser(String(userId));
    this.updateAccountState(accountId, (draft) => {
      draft.zalo.blockedUsers = (draft.zalo.blockedUsers || []).filter((item) => String(item.id) !== String(userId));
      upsertContact(draft, {
        ...(draft.contacts[String(userId)] || {}),
        id: String(userId),
        displayName: profile.displayName || draft.contacts[String(userId)]?.displayName || String(userId),
        avatarUrl: profile.avatarUrl || profile.avatar || draft.contacts[String(userId)]?.avatarUrl || '',
        phoneNumber: profile.phoneNumber || draft.contacts[String(userId)]?.phoneNumber || '',
        kind: 'stranger'
      });
      if (draft.threads[String(userId)] && draft.threads[String(userId)].source === 'blocked') draft.threads[String(userId)].source = 'stranger';
      return draft;
    });
    return { ok: true };
  }

  async deleteConversation(threadId) {
    const { accountId, api, accountState, thread } = this.getActiveThreadContext(threadId);
    const lastMessage = [...(accountState.messages?.[threadId] || [])].reverse().find((item) => item.raw?.cliMsgId && item.raw?.msgId && item.raw?.uidFrom);
    if (lastMessage) {
      await api.deleteChat({
        ownerId: String(lastMessage.raw.uidFrom),
        cliMsgId: String(lastMessage.raw.cliMsgId),
        globalMsgId: String(lastMessage.raw.msgId)
      }, threadId, this.getThreadType(thread));
    }
    this.updateAccountState(accountId, (draft) => {
      delete draft.messages[threadId];
      delete draft.threads[threadId];
      draft.zalo.locallyDeletedThreads = uniqueStrings([...(draft.zalo.locallyDeletedThreads || []), String(threadId)]);
      draft.zalo.pinnedConversations = (draft.zalo.pinnedConversations || []).filter((item) => stripConvPrefix(item) !== String(threadId));
      draft.zalo.hiddenConversations = (draft.zalo.hiddenConversations || []).filter((item) => stripConvPrefix(item?.id || item?.conversationId || item?.thread_id || item) !== String(threadId));
      draft.zalo.archivedConversations = (draft.zalo.archivedConversations || []).filter((item) => stripConvPrefix(item) !== String(threadId));
      draft.zalo.autoDeleteConversations = (draft.zalo.autoDeleteConversations || []).filter((item) => stripConvPrefix(item) !== String(threadId));
      if (draft.zalo.autoDeleteMap) delete draft.zalo.autoDeleteMap[String(threadId)];
      draft.zalo.mutedConversations = (draft.zalo.mutedConversations || []).filter((item) => stripConvPrefix(item) !== String(threadId));
      return draft;
    });
    return { ok: true, softDeleted: !lastMessage };
  }

  async undoMessage(threadId, messageId) {
    const { accountId, api, accountState, thread } = this.getActiveThreadContext(threadId);
    const message = this.findMessage(threadId, messageId, accountState);
    if (!message) throw new Error('Không tìm thấy tin nhắn');
    if (!message?.raw?.msgId || !message?.raw?.cliMsgId) {
      this.updateAccountState(accountId, (draft) => {
        const target = (draft.messages[threadId] || []).find((item) => item.id === messageId);
        if (target) {
          target.text = '[đã thu hồi]';
          target.deleted = true;
          target.recalled = true;
          target.pending = false;
          target.raw = { ...(target.raw || {}), softUndo: true };
        }
        return draft;
      });
      return { ok: true, softUndo: true };
    }
    await api.undo({ msgId: message.raw.msgId, cliMsgId: message.raw.cliMsgId }, threadId, this.getThreadType(thread));
    this.updateAccountState(accountId, (draft) => {
      const target = (draft.messages[threadId] || []).find((item) => item.id === messageId);
      if (target) {
        target.text = '[đã thu hồi]';
        target.deleted = true;
        target.recalled = true;
        target.pending = false;
      }
      return draft;
    });
    return { ok: true };
  }

  async deleteMessageForMe(threadId, messageId) {
    const { accountId, api, accountState, thread } = this.getActiveThreadContext(threadId);
    const message = this.findMessage(threadId, messageId, accountState);
    if (message?.raw?.msgId && message?.raw?.cliMsgId && message?.raw?.uidFrom) {
      await api.deleteMessage({
        data: {
          cliMsgId: String(message.raw.cliMsgId),
          msgId: String(message.raw.msgId),
          uidFrom: String(message.raw.uidFrom)
        },
        threadId,
        type: this.getThreadType(thread)
      }, true);
    }
    this.updateAccountState(accountId, (draft) => {
      const target = (draft.messages[threadId] || []).find((item) => item.id === messageId);
      if (target) {
        target.text = '[đã xoá phía Zalo]';
        target.deleted = true;
        target.recalled = false;
        target.pending = false;
        target.attachments = [];
        target.sticker = null;
        target.album = null;
        target.raw = { ...(target.raw || {}), softDelete: true };
      }
      return draft;
    });
    return { ok: true, softDeleted: !(message?.raw?.msgId && message?.raw?.cliMsgId && message?.raw?.uidFrom) };
  }

  async bootstrapSync() {
    const accountId = String(this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    await this.syncAllData({ loadHistory: true, accountId, applyUi: true });
    this.emit('session.updated', this.store.read().session);
    return { ok: true };
  }

  async renameThread(threadId, name, options = {}) {
    const { accountId, api, accountState, thread } = this.getActiveThreadContext(threadId, { accountId: options.accountId || null });
    const nextName = String(name || '').trim();

    if (thread.type === 'group') {
      if (!nextName) throw new Error('Tên nhóm không được để trống');
      await api.changeGroupName(nextName, threadId);
      this.updateAccountState(accountId, (draft) => {
        if (draft.threads[threadId]) draft.threads[threadId].title = nextName;
        return draft;
      });
      return { ok: true, title: nextName };
    }

    if (nextName) {
      await api.changeFriendAlias(nextName, threadId);
    } else if (typeof api.removeFriendAlias === 'function') {
      await api.removeFriendAlias(threadId);
    }

    this.updateAccountState(accountId, (draft) => {
      const contact = draft.contacts[threadId] || accountState.contacts?.[threadId];
      const fallbackName = contact?.zaloName || contact?.username || contact?.displayName || threadId;
      if (draft.contacts[threadId]) draft.contacts[threadId].displayName = nextName || fallbackName;
      if (draft.threads[threadId]) draft.threads[threadId].title = nextName || fallbackName;
      draft.zalo.aliases = upsertAliasDraft(draft.zalo.aliases || [], threadId, nextName);
      return draft;
    });
    return { ok: true, title: nextName };
  }

  async updateThreadTags(threadId, requestedTags, requestedAccountId = null) {
    const accountId = String(requestedAccountId || this.store.read().activeAccountId || '').trim();
    const api = this.getAccountApi(accountId);
    if (!api) return { ok: true, tags: requestedTags };
    const accountState = getAccountScopedState(this.store.read(), accountId);
    const thread = accountState?.threads?.[threadId];
    if (!thread) throw new Error('Không tìm thấy hội thoại');

    const current = await api.getLabels().catch(() => ({ labelData: [], version: 0, lastUpdateTime: 0 }));
    const labels = [...(current.labelData || [])].map((label) => ({
      ...label,
      conversations: Array.isArray(label.conversations) ? [...label.conversations] : []
    }));

    const nextTags = uniqueStrings(requestedTags);
    const convKey = toConversationKey(thread);
    let nextId = Math.max(0, ...labels.map((label) => Number(label.id) || 0)) + 1;
    let nextOffset = Math.max(0, ...labels.map((label) => Number(label.offset) || 0)) + 1;

    for (const tag of nextTags) {
      if (!labels.some((label) => label.text === tag)) {
        labels.push({
          id: nextId++,
          text: tag,
          textKey: '',
          conversations: [],
          color: LABEL_COLORS[(nextOffset - 1) % LABEL_COLORS.length],
          offset: nextOffset++,
          emoji: '',
          createTime: Date.now()
        });
      }
    }

    for (const label of labels) {
      const convs = new Set((label.conversations || []).map(String));
      if (nextTags.includes(label.text)) convs.add(convKey);
      else convs.delete(convKey);
      label.conversations = [...convs];
    }

    const updated = await api.updateLabels({
      labelData: labels,
      version: current.version || 0
    });

    this.updateAccountState(accountId, (draft) => {
      draft.labels = {
        items: updated.labelData || [],
        version: updated.version || 0,
        lastUpdateTime: updated.lastUpdateTime || 0
      };
      applyLabelsToThreads(draft, draft.labels.items);
      return draft;
    });

    return { ok: true, tags: nextTags };
  }

  attachRealtime(accountId, api = this.api) {
    if (!api?.listener || this.realtimeAttached.has(String(accountId || ''))) return;
    const bind = (eventName, handler) => {
      api.listener.on(eventName, async (payload) => {
        try {
          await handler.call(this, payload, accountId);
          if (eventName !== 'typing') {
            await this.deliverWebhookEvent(eventName, payload, accountId).catch(() => null);
          }
        } catch (error) {
          console.error(`[zalo-user-server] ingest ${eventName} failed`, error);
        }
      });
    };
    bind('message', this.ingestIncomingMessage);
    bind('reaction', this.ingestReaction);
    bind('typing', this.ingestTypingEvent || (async () => {}));
    bind('undo', this.ingestUndoEvent || (async () => {}));
    bind('friend_event', this.ingestFriendEvent || (async () => {}));
    bind('group_event', this.ingestGroupEvent || (async () => {}));
    api.listener.start();
    this.realtimeAttached.add(String(accountId || ''));
  }

  onLoginEvent(event) {
    if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
      const qrImage = normalizeQrImage(event.data.image);
      this.store.update((state) => {
        state.session.status = 'awaiting_qr_scan';
        state.session.qrCode = event.data.code;
        state.session.qrImage = qrImage;
        state.session.error = null;
        state.session.updatedAt = new Date().toISOString();
        return state;
      });
      this.emit('session.updated', this.store.read().session);
      return;
    }

    if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
      this.store.update((state) => {
        state.session.status = 'qr_scanned';
        state.session.account = {
          id: state.session.account?.id || null,
          displayName: event.data.display_name,
          avatarUrl: event.data.avatar
        };
        state.session.updatedAt = new Date().toISOString();
        return state;
      });
      this.emit('session.updated', this.store.read().session);
      return;
    }

    if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
      this.store.update((state) => {
        state.session.status = 'qr_expired';
        state.session.qrCode = null;
        state.session.qrImage = null;
        state.session.error = 'Mã QR đã hết hạn. Bấm “Thêm account bằng QR” để tạo mã mới.';
        state.session.updatedAt = new Date().toISOString();
        return state;
      });
      this.emit('session.updated', this.store.read().session);
      return;
    }

    if (event.type === LoginQRCallbackEventType.QRCodeDeclined) {
      this.store.update((state) => {
        state.session.status = 'qr_declined';
        state.session.qrCode = null;
        state.session.qrImage = null;
        state.session.error = 'Zalo đã từ chối lần quét này. Bấm “Thêm account bằng QR” để tạo mã QR mới.';
        state.session.updatedAt = new Date().toISOString();
        return state;
      });
      this.emit('session.updated', this.store.read().session);
      return;
    }

    if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
      this.pendingQrCredentials = event.data;
      this.store.update((state) => {
        state.session.status = 'syncing';
        state.session.updatedAt = new Date().toISOString();
        return state;
      });
      this.emit('session.updated', this.store.read().session);
    }
  }

  async restoreLogin(credentials, accountIdHint = null, options = {}) {
    const zalo = new Zalo(ZALO_CLIENT_OPTIONS);
    if (options.syncUi) {
      this.store.update((state) => {
        state.session.status = 'reconnecting';
        state.session.error = null;
        state.session.updatedAt = new Date().toISOString();
        return state;
      });
      this.emit('session.updated', this.store.read().session);
    }
    const api = await zalo.login(credentials);
    await this.afterLogin(api, accountIdHint, { ...options, zalo, credentials, loadHistory: options.loadHistory !== false });
  }

  async afterLogin(api, accountIdHint = null, options = {}) {
    const accountInfo = await api.fetchAccountInfo();
    const resolvedAccountId = String(accountInfo?.profile?.userId || accountIdHint || `acc-${Date.now()}`);
    const displayName = accountInfo?.profile?.displayName || accountInfo?.profile?.zaloName || resolvedAccountId;
    const client = { api, zalo: options.zalo || this.zalo, credentials: options.credentials || null, accountInfo };
    this.accountClients.set(resolvedAccountId, client);
    this.store.update((state) => {
      state.accounts[resolvedAccountId] = {
        ...(state.accounts[resolvedAccountId] || {}),
        id: resolvedAccountId,
        userId: resolvedAccountId,
        displayName,
        avatarUrl: accountInfo?.profile?.avatar || '',
        phoneNumber: accountInfo?.profile?.phoneNumber || '',
        status: 'connected',
        error: null,
        updatedAt: new Date().toISOString()
      };
      return state;
    });
    if (options.credentials) {
      this.saveAccountCredentials(resolvedAccountId, options.credentials);
    }
    const applyUi = options.syncUi !== false;
    if (applyUi) this.api = api;
    await this.syncAllData({ loadHistory: options.loadHistory !== false, accountId: resolvedAccountId, applyUi, preloadedAccountInfo: accountInfo });
    if (applyUi) this.emit('session.updated', this.store.read().session);
    this.attachRealtime(resolvedAccountId, api);
    this.startKeepAlive(resolvedAccountId, api);
    return resolvedAccountId;
  }

  async syncAllData({ loadHistory = true, accountId = null, applyUi = true, preloadedAccountInfo = null } = {}) {
    const targetAccountId = String(accountId || this.store.read().activeAccountId || '');
    const api = this.getAccountApi(targetAccountId);
    if (!api) throw new Error('Chưa kết nối Zalo');
    const previous = this.store.read();
    const previousAccountState = getAccountScopedState(previous, targetAccountId) || {
      labels: { items: [], version: 0, lastUpdateTime: 0 },
      zalo: {},
      contacts: {},
      threads: {},
      messages: {},
      session: {}
    };
    const [accountInfo, friends = [], groupList, labelsRes, unreadRes, pinRes, hiddenRes, archivedRes, muteRes, quickRes, autoDeleteRes, recommendationsRes, sentRequestsRes, closeFriendsRes, aliasRes, settingsRes, autoReplyRes] = await Promise.all([
      Promise.resolve(preloadedAccountInfo || null).then((value) => value || api.fetchAccountInfo()),
      api.getAllFriends().catch(() => []),
      api.getAllGroups().catch(() => ({ gridVerMap: {} })),
      api.getLabels().catch(() => ({ labelData: [], version: 0, lastUpdateTime: 0 })),
      api.getUnreadMark().catch(() => ({ data: { convsGroup: [], convsUser: [] } })),
      api.getPinConversations().catch(() => ({ conversations: [], otherTabConvs: [], version: 0 })),
      api.getHiddenConversations().catch(() => ({ threads: [], pin: null })),
      api.getArchivedChatList().catch(() => ({ items: [], version: 0 })),
      api.getMute().catch(() => ({ chatEntries: [], groupChatEntries: [] })),
      api.getQuickMessageList().catch(() => ({ items: [], version: 0, cursor: 0 })),
      api.getAutoDeleteChat().catch(() => ({ convers: [] })),
      api.getFriendRecommendations().catch((error) => ({ recommItems: [], error: error.message || String(error) })),
      api.getSentFriendRequest().catch((error) => ({ error: error.message || String(error) })),
      api.getCloseFriends().catch(() => []),
      api.getAliasList().catch(() => ({ items: [], updateTime: '-1' })),
      api.getSettings().catch(() => ({})),
      api.getAutoReplyList().catch(() => ({ item: [], version: 0 }))
    ]);

    const groupIds = Object.keys(groupList.gridVerMap || {});
    const groupInfo = groupIds.length > 0
      ? await api.getGroupInfo(groupIds).catch(() => ({ gridInfoMap: {} }))
      : { gridInfoMap: {} };

    const groupMemberProfiles = {};
    const allGroupMemberIds = uniqueStrings(Object.values(groupInfo.gridInfoMap || {}).flatMap((group) => extractGroupMemberIds(group)));
    if (allGroupMemberIds.length && typeof api.getGroupMembersInfo === 'function') {
      await mapWithConcurrency(chunkArray(allGroupMemberIds, GROUP_MEMBER_SYNC_BATCH_SIZE), GROUP_MEMBER_SYNC_CONCURRENCY, async (memberIds) => {
        const response = await api.getGroupMembersInfo(memberIds).catch(() => ({ profiles: {} }));
        Object.assign(groupMemberProfiles, response?.profiles || {});
      });
    }

    const groupHistories = {};
    if (loadHistory) {
      await mapWithConcurrency(groupIds, GROUP_HISTORY_SYNC_CONCURRENCY, async (groupId) => {
        try {
          const history = await api.getGroupChatHistory(groupId, GROUP_HISTORY_SYNC_COUNT);
          groupHistories[groupId] = history.groupMsgs || [];
        } catch {
          groupHistories[groupId] = [];
        }
      });
    }

    const populateSyncedState = (targetState, sourceAccountState = previousAccountState) => {
      targetState.labels = {
        items: labelsRes.labelData || [],
        version: labelsRes.version || 0,
        lastUpdateTime: labelsRes.lastUpdateTime || 0
      };
      targetState.zalo = {
        quickMessages: quickRes.items || [],
        pinnedConversations: pinRes.conversations || [],
        hiddenConversations: hiddenRes.threads || [],
        archivedConversations: (archivedRes.items || []).map((item) => item.id || item.conversationId || item),
        autoDeleteConversations: (autoDeleteRes.convers || []).map((item) => item.id || item.conversationId || item.destId || item),
        autoDeleteMap: Object.fromEntries((autoDeleteRes.convers || []).map((item) => [String(item.destId || item.id || item.conversationId || ''), Number(item.ttl || 0)]).filter((entry) => entry[0])),
        recommendations: normalizeRecommendations(recommendationsRes.recommItems || []),
        incomingRequests: normalizeIncomingRequests(recommendationsRes.recommItems || []),
        sentRequests: normalizeSentRequests(sentRequestsRes),
        blockedUsers: sourceAccountState.zalo?.blockedUsers || [],
        mutedConversations: normalizeMutedConversations(muteRes),
        closeFriends: (closeFriendsRes || []).map((item) => String(item)),
        aliases: aliasRes.items || [],
        settings: settingsRes || {},
        autoReplies: autoReplyRes.item || [],
        raw: {
          pins: pinRes,
          hidden: hiddenRes,
          archived: archivedRes,
          mute: muteRes,
          quick: quickRes,
          autoDelete: autoDeleteRes,
          recommendations: recommendationsRes,
          sentRequests: sentRequestsRes,
          closeFriends: closeFriendsRes,
          aliases: aliasRes,
          settings: settingsRes,
          autoReply: autoReplyRes
        }
      };
      targetState.contacts = structuredClone(sourceAccountState.contacts || {});
      targetState.threads = structuredClone(sourceAccountState.threads || {});
      targetState.messages = Object.fromEntries(Object.entries(sourceAccountState.messages || {}).map(([threadId, items]) => [threadId, filterMessagesToRecentWindow(items || [])]));
      targetState.session = {
        ...(targetState.session || {}),
        provider: 'zalo-web',
        status: 'connected',
        qrCode: null,
        qrImage: null,
        error: null,
        account: {
          id: accountInfo.profile.userId,
          displayName: accountInfo.profile.displayName || accountInfo.profile.zaloName,
          avatarUrl: accountInfo.profile.avatar
        },
        updatedAt: new Date().toISOString(),
        syncInfo: {
          lastSyncAt: new Date().toISOString(),
          directHistorySupported: false,
          groupHistoryCount: GROUP_HISTORY_SYNC_COUNT,
          groupMemberProfileCount: Object.keys(groupMemberProfiles).length,
          recentWindowDays: 10,
          note: `Realtime được lưu riêng theo account; UI chỉ hiện hội thoại có hoạt động trong 10 ngày gần nhất. Lịch sử sync giữ tối đa ${GROUP_HISTORY_SYNC_COUNT} tin nhóm gần nhất/thread trong cửa sổ đó. Direct history/call history cần nguồn Zalo Web DOM/local DB vì zca-js hiện chưa expose API đầy đủ.`
        }
      };

      upsertContact(targetState, {
        id: accountInfo.profile.userId,
        displayName: accountInfo.profile.displayName || accountInfo.profile.zaloName,
        zaloName: accountInfo.profile.zaloName || accountInfo.profile.displayName || '',
        avatarUrl: accountInfo.profile.avatar,
        phoneNumber: accountInfo.profile.phoneNumber || '',
        isSelf: true,
        kind: 'self'
      });

      for (const friend of friends) {
        const previousThread = sourceAccountState.threads?.[friend.userId] || {};
        const sanitizedDirectMessages = sanitizeDirectThreadMessages(sourceAccountState.messages?.[friend.userId] || [], targetAccountId, friend.userId);
        upsertContact(targetState, normalizeUser(friend));
        upsertThread(targetState, {
          id: friend.userId,
          title: friend.displayName || friend.zaloName || friend.username || friend.userId,
          type: 'direct',
          participantIds: [friend.userId],
          avatarUrl: friend.avatar,
          source: 'friend',
          assignee: previousThread.assignee ?? null,
          notes: previousThread.notes ?? ''
        });
        replaceThreadMessages(targetState, friend.userId, sanitizedDirectMessages, { resetUnread: true, unreadCount: previousThread.unreadCount || 0 });
      }

      for (const [threadId, previousThread] of Object.entries(sourceAccountState.threads || {})) {
        if (targetState.threads[threadId]) continue;
        if (previousThread.type !== 'direct') continue;
        const sanitizedDirectMessages = sanitizeDirectThreadMessages(sourceAccountState.messages?.[threadId] || [], targetAccountId, threadId);
        const previousContact = sourceAccountState.contacts?.[threadId] || {};
        upsertContact(targetState, {
          id: threadId,
          displayName: previousContact.displayName || previousContact.zaloName || previousThread.title || threadId,
          zaloName: previousContact.zaloName || previousContact.displayName || previousThread.title || threadId,
          username: previousContact.username || '',
          avatarUrl: previousContact.avatarUrl || previousThread.avatarUrl || '',
          kind: previousContact.kind || 'direct_contact'
        });
        upsertThread(targetState, {
          id: threadId,
          title: previousThread.title || previousContact.displayName || previousContact.zaloName || threadId,
          type: 'direct',
          participantIds: previousThread.participantIds?.length ? previousThread.participantIds : [threadId],
          avatarUrl: previousThread.avatarUrl || previousContact.avatarUrl || '',
          source: previousThread.source || 'restored_direct',
          assignee: previousThread.assignee ?? null,
          notes: previousThread.notes ?? ''
        });
        replaceThreadMessages(targetState, threadId, sanitizedDirectMessages, { resetUnread: true, unreadCount: previousThread.unreadCount || 0 });
      }

      for (const [groupId, group] of Object.entries(groupInfo.gridInfoMap || {})) {
        const previousThread = sourceAccountState.threads?.[groupId] || {};
        const memberIds = extractGroupMemberIds(group);
        for (const memberId of memberIds) {
          const fallbackMember = (group.currentMems || []).find((item) => String(item?.id || '') === String(memberId)) || { id: memberId };
          const profile = groupMemberProfiles[String(memberId)] || {};
          const previousContact = sourceAccountState.contacts?.[String(memberId)] || {};
          const normalizedMember = normalizeGroupMemberProfile(profile, fallbackMember, previousContact);
          if (normalizedMember.id) {
            const existingContact = targetState.contacts[String(normalizedMember.id)] || previousContact || {};
            const nextKind = existingContact.isSelf ? 'self' : existingContact.kind === 'friend' ? 'friend' : 'group_member';
            upsertContact(targetState, { ...existingContact, ...normalizedMember, kind: nextKind, isSelf: Boolean(existingContact.isSelf) });
          }
        }
        upsertThread(targetState, {
          id: groupId,
          title: group.name || groupId,
          type: 'group',
          participantIds: memberIds,
          totalMember: group.totalMember || memberIds.length || 0,
          avatarUrl: group.fullAvt || group.avt,
          source: 'group',
          assignee: previousThread.assignee ?? null,
          notes: previousThread.notes ?? ''
        });
        const normalizedHistory = filterMessagesToRecentWindow((groupHistories[groupId] || []).map((message) => normalizeHistoryMessage(message, accountInfo.profile.userId)).filter(Boolean));
        const preservedHistory = normalizedHistory.length ? normalizedHistory : filterMessagesToRecentWindow(sourceAccountState.messages?.[groupId] || []);
        replaceThreadMessages(targetState, groupId, preservedHistory, { resetUnread: true, unreadCount: 0 });
      }

      for (const [threadId, previousThread] of Object.entries(sourceAccountState.threads || {})) {
        if (targetState.threads[threadId]) continue;
        if (previousThread.type !== 'group') continue;
        for (const memberId of previousThread.participantIds || []) {
          const previousContact = sourceAccountState.contacts?.[memberId];
          if (previousContact) upsertContact(targetState, previousContact);
        }
        upsertThread(targetState, {
          ...previousThread,
          id: threadId,
          type: 'group',
          source: previousThread.source || 'restored_group',
          assignee: previousThread.assignee ?? null,
          notes: previousThread.notes ?? ''
        });
        replaceThreadMessages(targetState, threadId, filterMessagesToRecentWindow(sourceAccountState.messages?.[threadId] || []), { resetUnread: true, unreadCount: previousThread.unreadCount || 0 });
      }

      for (const [threadId, thread] of Object.entries(targetState.threads || {})) {
        if (thread.type !== 'direct' || thread.source !== 'friend') continue;
        const contact = targetState.contacts[String(threadId)] || {};
        upsertContact(targetState, { ...contact, id: String(threadId), kind: 'friend' });
      }

      applyLabelsToThreads(targetState, targetState.labels.items);
      applyAliasesToThreads(targetState, targetState.zalo.aliases || []);
      applyConversationFlags(targetState, targetState.zalo);
      applyUnreadMarks(targetState, unreadRes?.data);
      return targetState;
    };

    this.store.update((state) => {
      state.accounts[targetAccountId] = {
        ...(state.accounts[targetAccountId] || {}),
        id: targetAccountId,
        userId: String(accountInfo.profile.userId),
        displayName: accountInfo.profile.displayName || accountInfo.profile.zaloName || String(accountInfo.profile.userId),
        avatarUrl: accountInfo.profile.avatar || '',
        phoneNumber: accountInfo.profile.phoneNumber || '',
        status: 'connected',
        error: null,
        updatedAt: new Date().toISOString()
      };
      if (applyUi) state.activeAccountId = targetAccountId;
      updateAccountScopedState(state, targetAccountId, (snapshot) => populateSyncedState(snapshot, snapshot || previousAccountState));
      return state;
    });
  }

  async ingestIncomingMessage(message, accountId = null) {
    const targetAccountId = String(accountId || this.store.read().activeAccountId || '');
    const accountState = getAccountScopedState(this.store.read(), targetAccountId);
    const ownId = accountState?.session?.account?.id || this.store.read().accounts?.[targetAccountId]?.userId || null;
    const isGroup = message.type === ThreadType.Group;
    const senderId = String(message.data.uidFrom);
    const threadId = String(message.threadId);
    const deleteRefs = extractDeleteMessageRefs(message.data.content, message.data.msgType);
    if (deleteRefs.length) {
      const { nextState, isActive } = this.updateAccountState(targetAccountId, (draft) => {
        removeMessagesByRefs(draft, threadId, deleteRefs);
        return draft;
      });
      if (isActive) this.emit('thread.meta_updated', { accountId: targetAccountId, threadId, kind: 'message_delete', refs: deleteRefs, view: nextState });
      return;
    }
    const normalizedContent = normalizeMessagePayload(message.data.content, message.data.msgType);

    const counterpartId = !isGroup && ownId && senderId === String(ownId) ? threadId : senderId;
    await this.ensureThreadMetadata({ threadId, senderId: counterpartId, isGroup }, targetAccountId);

    const payload = {
      id: String(message.data.msgId || message.data.cliMsgId || `msg-${Date.now()}`),
      threadId,
      senderId,
      text: normalizedContent.text,
      type: normalizedContent.type || message.data.msgType || 'text',
      attachments: normalizedContent.attachments,
      sticker: normalizedContent.sticker,
      album: normalizedContent.album,
      quote: normalizeMessageQuote(message.data.quote),
      mentions: normalizeMessageMentions(message.data.content, message.data.mentions),
      isOutgoing: ownId ? senderId === ownId || message.isSelf : !!message.isSelf,
      createdAt: new Date(Number(message.data.ts || Date.now())).toISOString(),
      raw: {
        msgId: message.data.msgId || null,
        cliMsgId: message.data.cliMsgId || null,
        uidFrom: message.data.uidFrom || null,
        ts: message.data.ts || null,
        msgType: message.data.msgType || null,
        ttl: message.data.ttl ?? null,
        propertyExt: message.data.propertyExt || null,
        content: message.data.content || null,
        quote: message.data.quote || null,
        mentions: message.data.mentions || null
      }
    };

    const { nextState, isActive } = this.updateAccountState(targetAccountId, (draft) => {
      // Canonical ingest path for realtime messages from Zalo.
      // Account scoping happens before this, so this append must stay isolated per account.
      appendMessage(draft, payload);
      return draft;
    });
    if (isActive) this.emit('message.created', { accountId: targetAccountId, threadId, message: payload, view: nextState });
  }

  async ingestReaction(reaction, accountId = null) {
    const targetAccountId = String(accountId || this.store.read().activeAccountId || '');
    const rawThreadId = String(reaction.threadId || reaction?.data?.threadId || '');
    const threadId = normalizeThreadId(rawThreadId);
    const target = reaction?.data?.content?.rMsg?.[0] || {};
    const msgId = String(target.gMsgID || reaction?.data?.msgId || '');
    const cliMsgId = String(target.cMsgID || reaction?.data?.cliMsgId || '');
    if (!threadId || (!msgId && !cliMsgId)) return;
    let matchedMessageId = '';
    const reactionPayload = {
      actionId: String(reaction?.data?.actionId || ''),
      icon: String(reaction?.data?.content?.rIcon || ''),
      by: String(reaction?.data?.uidFrom || ''),
      at: new Date(Number(reaction?.data?.ts || Date.now())).toISOString(),
      self: Boolean(reaction?.isSelf)
    };
    const { nextState, isActive } = this.updateAccountState(targetAccountId, (draft) => {
      const messages = draft.messages[threadId] || [];
      const found = messages.find((item) => String(item?.raw?.msgId || '') === msgId || String(item?.raw?.cliMsgId || '') === cliMsgId || String(item.id || '') === msgId);
      if (!found) return draft;
      matchedMessageId = String(found.id || '');
      applyReactionToDraft(draft, threadId, found.id, reactionPayload);
      return draft;
    });
    if (isActive) this.emit('thread.meta_updated', { accountId: targetAccountId, threadId, kind: 'reaction', messageId: matchedMessageId, reaction: reactionPayload, view: nextState });
  }

  async ingestUndoEvent(event, accountId = null) {
    if (!event) return;
    const targetAccountId = String(accountId || this.store.read().activeAccountId || '');
    const threadId = normalizeThreadId(event.threadId || event?.data?.idTo || event?.data?.content?.destId || '');
    const msgId = String(event?.data?.msgId || event?.data?.realMsgId || event?.data?.content?.globalMsgId || '');
    const cliMsgId = String(event?.data?.cliMsgId || event?.data?.content?.cliMsgId || '');
    if (!threadId || (!msgId && !cliMsgId)) return;
    let matchedMessageId = '';
    const { nextState, isActive } = this.updateAccountState(targetAccountId, (draft) => {
      const messages = draft.messages[threadId] || [];
      const found = messages.find((item) => String(item?.raw?.msgId || '') === msgId || String(item?.raw?.cliMsgId || '') === cliMsgId || String(item.id || '') === msgId || String(item.id || '') === cliMsgId);
      if (!found) return draft;
      matchedMessageId = String(found.id || '');
      found.text = '[đã thu hồi]';
      found.deleted = true;
      found.recalled = true;
      found.raw = { ...(found.raw || {}), undo: event.data || event };
      return draft;
    });
    if (isActive && matchedMessageId) this.emit('thread.meta_updated', { accountId: targetAccountId, threadId, kind: 'undo', messageId: matchedMessageId, view: nextState });
  }

  async ingestGroupEvent(event, accountId = null) {
    if (!event) return;
    const targetAccountId = String(accountId || this.store.read().activeAccountId || '');
    const threadId = normalizeThreadId(event.threadId || event?.data?.groupId || event?.data?.group_id || '');
    if (!threadId) return;
    const result = await this.refreshGroupThreadMetadata(threadId, targetAccountId, event).catch(() => null);
    if (result?.isActive) this.emit('thread.meta_updated', { accountId: targetAccountId, threadId, kind: 'group', eventType: event.type || event.act || '', view: result.nextState });
  }

  async ingestFriendEvent(event, accountId = null) {
    if (!event) return;
    const targetAccountId = String(accountId || this.store.read().activeAccountId || '');
    const type = Number(event.type);
    const accountState = getAccountScopedState(this.store.read(), targetAccountId);
    const ownId = String(accountState?.session?.account?.id || this.store.read().accounts?.[targetAccountId]?.userId || '');
    const counterpartId = resolveFriendEventUserId(event, ownId);
    let profile = null;
    const api = this.getAccountApi(targetAccountId);
    if (counterpartId && api) {
      profile = await api.getUserInfo(counterpartId, AvatarSize.Small)
        .then((info) => info?.changed_profiles?.[counterpartId] || null)
        .catch(() => null);
      if (counterpartId) {
        await this.ensureThreadMetadata({ threadId: counterpartId, senderId: counterpartId, isGroup: false }, targetAccountId).catch(() => null);
      }
    }

    const { nextState, isActive } = this.updateAccountState(targetAccountId, (draft) => {
      if (!counterpartId) return draft;
      const baseProfile = profile ? normalizeUser(profile, profile.isFr ? 'friend' : 'stranger', counterpartId) : {};
      const existing = draft.contacts[counterpartId] || {};
      const removeUserFromSocialLists = () => {
        draft.zalo.incomingRequests = (draft.zalo.incomingRequests || []).filter((item) => String(item.id) !== counterpartId);
        draft.zalo.sentRequests = (draft.zalo.sentRequests || []).filter((item) => String(item.id) !== counterpartId);
        draft.zalo.recommendations = (draft.zalo.recommendations || []).filter((item) => String(item.id) !== counterpartId);
      };

      if (type === 2) {
        if (event.isSelf) {
          const sentItem = buildSocialUserRecord(counterpartId, profile || existing, event?.data?.message || '');
          draft.zalo.sentRequests = [sentItem, ...(draft.zalo.sentRequests || []).filter((item) => String(item.id) !== counterpartId)];
        } else {
          const incomingItem = buildSocialUserRecord(counterpartId, profile || existing, event?.data?.message || '');
          draft.zalo.incomingRequests = [incomingItem, ...(draft.zalo.incomingRequests || []).filter((item) => String(item.id) !== counterpartId)];
        }
        draft.zalo.blockedUsers = (draft.zalo.blockedUsers || []).filter((item) => String(item.id) !== counterpartId);
        upsertContact(draft, { ...existing, ...baseProfile, id: counterpartId, kind: existing.kind === 'friend' ? 'friend' : 'stranger' });
      } else if (type === 3 || type === 4) {
        removeUserFromSocialLists();
        if (existing && existing.kind !== 'friend' && existing.kind !== 'blocked') existing.kind = 'stranger';
      } else if (type === 0) {
        removeUserFromSocialLists();
        draft.zalo.blockedUsers = (draft.zalo.blockedUsers || []).filter((item) => String(item.id) !== counterpartId);
        upsertContact(draft, { ...existing, ...baseProfile, id: counterpartId, kind: 'friend' });
        if (draft.threads[counterpartId]) draft.threads[counterpartId].source = 'friend';
      } else if (type === 1) {
        removeUserFromSocialLists();
        upsertContact(draft, { ...existing, ...baseProfile, id: counterpartId, kind: 'stranger' });
        if (draft.threads[counterpartId]) draft.threads[counterpartId].source = 'stranger';
      } else if (type === 6) {
        removeUserFromSocialLists();
        const blockedItem = buildSocialUserRecord(counterpartId, profile || existing, '');
        draft.zalo.blockedUsers = [blockedItem, ...(draft.zalo.blockedUsers || []).filter((item) => String(item.id) !== counterpartId)];
        upsertContact(draft, { ...existing, ...baseProfile, id: counterpartId, kind: 'blocked' });
        if (draft.threads[counterpartId]) draft.threads[counterpartId].source = 'blocked';
      } else if (type === 7) {
        draft.zalo.blockedUsers = (draft.zalo.blockedUsers || []).filter((item) => String(item.id) !== counterpartId);
        upsertContact(draft, { ...existing, ...baseProfile, id: counterpartId, kind: existing.kind === 'friend' ? 'friend' : 'stranger' });
        if (draft.threads[counterpartId] && draft.threads[counterpartId].source === 'blocked') draft.threads[counterpartId].source = 'stranger';
      }
      return draft;
    });

    if (isActive) this.emit('thread.meta_updated', { accountId: targetAccountId, kind: 'friend', userId: counterpartId, eventType: type, view: nextState });
  }

  async refreshGroupThreadMetadata(threadId, accountId = null, event = null) {
    const targetAccountId = String(accountId || this.store.read().activeAccountId || '');
    const api = this.getAccountApi(targetAccountId);
    if (!api || !threadId) return null;
    const groupInfo = await api.getGroupInfo(threadId).catch(() => null);
    const group = groupInfo?.gridInfoMap?.[threadId] || null;
    const eventData = event?.data || {};
    const memberIds = extractGroupMemberIds(group, eventData.updateMembers?.map((item) => item?.id) || []);
    const memberProfiles = {};
    if (memberIds.length && typeof api.getGroupMembersInfo === 'function') {
      await mapWithConcurrency(chunkArray(memberIds, GROUP_MEMBER_SYNC_BATCH_SIZE), GROUP_MEMBER_SYNC_CONCURRENCY, async (ids) => {
        const response = await api.getGroupMembersInfo(ids).catch(() => ({ profiles: {} }));
        Object.assign(memberProfiles, response?.profiles || {});
      });
    }

    return this.updateAccountState(targetAccountId, (draft) => {
      const currentMems = group?.currentMems || eventData.updateMembers || [];
      for (const memberId of memberIds) {
        const fallbackMember = currentMems.find((item) => String(item?.id || '') === String(memberId)) || { id: memberId };
        const previousContact = draft.contacts[String(memberId)] || {};
        const normalizedMember = normalizeGroupMemberProfile(memberProfiles[String(memberId)] || {}, fallbackMember, previousContact);
        if (normalizedMember.id) upsertContact(draft, { ...normalizedMember, kind: previousContact.kind === 'friend' ? 'friend' : 'group_member' });
      }
      const previousThread = draft.threads[String(threadId)] || {};
      upsertThread(draft, {
        id: String(threadId),
        title: group?.name || eventData.groupName || previousThread.title || String(threadId),
        type: 'group',
        participantIds: memberIds.length ? memberIds : previousThread.participantIds || [],
        totalMember: group?.totalMember || (memberIds.length || previousThread.totalMember || 0),
        avatarUrl: group?.fullAvt || group?.avt || eventData.fullAvt || eventData.avt || previousThread.avatarUrl || '',
        source: 'group',
        assignee: previousThread.assignee ?? null,
        notes: previousThread.notes ?? ''
      });
      return draft;
    });
  }

  async ensureThreadMetadata({ threadId, senderId, isGroup }, accountId = null) {
    const targetAccountId = String(accountId || this.store.read().activeAccountId || '');
    const state = getAccountScopedState(this.store.read(), targetAccountId);
    if (state?.threads?.[threadId]) return;
    const api = this.getAccountApi(targetAccountId);
    if (!api) return;

    if (isGroup) {
      await this.refreshGroupThreadMetadata(threadId, targetAccountId).catch(() => null);
      return;
    }

    await this.ensureDirectThreadMetadata(senderId || threadId, targetAccountId);
  }

  async ensureDirectThreadMetadata(userId, accountId = null) {
    const targetAccountId = String(accountId || this.store.read().activeAccountId || '');
    const targetId = String(userId || '').trim();
    if (!targetId) return;
    const state = getAccountScopedState(this.store.read(), targetAccountId);
    if (state?.threads?.[targetId]) return;
    const api = this.getAccountApi(targetAccountId);
    if (!api) return;

    const info = await api.getUserInfo(targetId, AvatarSize.Small).catch(() => null);
    const user = info?.changed_profiles?.[targetId];
    const existing = state?.contacts?.[targetId] || {};
    const normalized = user
      ? normalizeUser(user, user.isFr ? 'friend' : 'stranger', targetId)
      : (existing.id ? existing : null);
    if (!normalized) return;

    this.updateAccountState(targetAccountId, (draft) => {
      upsertContact(draft, { ...existing, ...normalized, id: targetId, kind: normalized.kind || existing.kind || 'stranger' });
      upsertThread(draft, {
        id: targetId,
        title: normalized.displayName || normalized.zaloName || normalized.username || targetId,
        type: 'direct',
        participantIds: [targetId],
        avatarUrl: normalized.avatarUrl || normalized.avatar || '',
        source: normalized.kind === 'friend' ? 'friend' : 'stranger'
      });
      return draft;
    });
  }

  startKeepAlive(accountId, api = this.api) {
    const key = String(accountId || this.store.read().activeAccountId || '');
    if (!api || this.keepAliveTimers.has(key)) return;
    const timer = setInterval(async () => {
      const currentApi = this.accountClients.get(key)?.api || api;
      if (!currentApi) return;
      try {
        await currentApi.keepAlive();
        if (this.keepAliveFailures.get(key)) this.keepAliveFailures.delete(key);
        this.store.update((state) => {
          if (state.accounts[key] && state.accounts[key].status !== 'connected') {
            state.accounts[key].status = 'connected';
            state.accounts[key].error = null;
            state.accounts[key].updatedAt = new Date().toISOString();
          }
          if (String(state.activeAccountId || '') === key && state.session.status !== 'connected') {
            state.session.status = 'connected';
            state.session.error = null;
            state.session.updatedAt = new Date().toISOString();
          }
          return state;
        });
      } catch (error) {
        const failures = Number(this.keepAliveFailures.get(key) || 0) + 1;
        this.keepAliveFailures.set(key, failures);
        console.error('[zalo-user-server] keepAlive failed', key, failures, error?.message || error);
        if (failures >= KEEPALIVE_FAIL_THRESHOLD) {
          this.handleConnectionLoss(error, 'reconnect_failed', key);
        }
      }
    }, 60_000);
    this.keepAliveTimers.set(key, timer);
  }

  listCredentialEntries() {
    const entries = [];
    if (!fs.existsSync(this.credentialsDir)) return entries;
    for (const name of fs.readdirSync(this.credentialsDir)) {
      const filePath = path.join(this.credentialsDir, name, 'credentials.json');
      if (fs.existsSync(filePath)) entries.push({ accountId: name, filePath });
    }
    return entries;
  }

  saveAccountCredentials(accountId, credentials) {
    if (!credentials) return;
    const dir = path.join(this.credentialsDir, String(accountId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(credentials, null, 2));
  }

  async logoutAccount(accountId) {
    const key = String(accountId || this.store.read().activeAccountId || '').trim();
    if (!key) throw new Error('Thiếu accountId');
    const client = this.accountClients.get(key);
    client?.api?.listener?.stop?.();
    const timer = this.keepAliveTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.keepAliveTimers.delete(key);
    }
    this.keepAliveFailures.delete(key);
    this.realtimeAttached.delete(key);
    this.accountClients.delete(key);
    if (String(this.store.read().activeAccountId || '') === key) {
      this.api = null;
    }

    const credentialDir = path.join(this.credentialsDir, key);
    if (fs.existsSync(credentialDir)) {
      fs.rmSync(credentialDir, { recursive: true, force: true });
    }
    if (key === 'legacy' && fs.existsSync(this.credentialsPath)) {
      fs.rmSync(this.credentialsPath, { force: true });
    }

    const remainingAccountIds = this.listCredentialEntries().map((entry) => String(entry.accountId));
    this.store.update((state) => {
      delete state.accounts[key];
      if (state.accountStateById) delete state.accountStateById[key];
      if (String(state.activeAccountId || '') === key) {
        const nextActive = remainingAccountIds.find(Boolean) || null;
        if (nextActive) {
          // Logout must destroy the old bucket completely before another bucket is opened.
          // Do not leave the old global view attached while activeAccountId already points elsewhere.
          resetChatState(state);
          state.labels = { items: [], version: 0, lastUpdateTime: 0 };
          state.zalo = {};
          state.session.account = null;
          state.session.syncInfo = null;
          state.session.error = null;
          state.session.qrCode = null;
          state.session.qrImage = null;
          state.activeAccountId = '';
          switchActiveAccountState(state, nextActive);
        } else {
          resetChatState(state);
          state.accounts = {};
          state.accountStateById = {};
          state.activeAccountId = null;
          state.session.provider = 'zalo-web';
          state.session.account = null;
          state.session.syncInfo = null;
          state.session.error = null;
          state.session.qrCode = null;
          state.session.qrImage = null;
          state.session.status = 'logged_out';
          state.session.updatedAt = new Date().toISOString();
        }
      }
      return state;
    });

    if (remainingAccountIds.length) {
      const nextActive = String(this.store.read().activeAccountId || remainingAccountIds[0]);
      await this.selectAccount(nextActive);
      return { ok: true, activeAccountId: nextActive };
    }

    this.emit('session.updated', this.store.read().session);
    return { ok: true, activeAccountId: null };
  }

  async selectAccount(accountId, options = {}) {
    const key = String(accountId || '').trim();
    if (!key) throw new Error('Thiếu accountId');
    const client = this.accountClients.get(key);
    if (!client?.api) throw new Error('Tài khoản chưa sẵn sàng');
    this.api = client.api;
    const hasStoredHistory = hasPersistedAccountHistory(this.store.read(), key);
    const shouldSyncInBackground = hasStoredHistory && options.awaitSync !== true;
    const effectiveLoadHistory = options.loadHistory !== undefined ? options.loadHistory !== false : !hasStoredHistory;
    const immediateState = this.store.update((state) => {
      switchActiveAccountState(state, key);
      state.session.provider = 'zalo-web';
      state.session.status = 'syncing';
      state.session.error = null;
      state.session.updatedAt = new Date().toISOString();
      if (state.accounts[key]) {
        state.accounts[key].status = 'syncing';
        state.accounts[key].error = null;
        state.accounts[key].updatedAt = new Date().toISOString();
      }
      return state;
    });
    this.emit('session.updated', immediateState.session);

    const syncTask = this.queueAccountSync(key, {
      loadHistory: effectiveLoadHistory,
      applyUi: true,
      preloadedAccountInfo: client.accountInfo || null
    });

    if (!shouldSyncInBackground) await syncTask;
    return { ok: true, accountId: key, deferredSync: shouldSyncInBackground };
  }

  async updateIntegrationConfig(config) {
    this.store.update((state) => {
      state.integration = {
        ...(state.integration || {}),
        webhookUrl: String(config?.webhookUrl || '').trim(),
        webhookSecret: String(config?.webhookSecret || '').trim(),
        enabled: Boolean(config?.enabled && String(config?.webhookUrl || '').trim()),
        selectedAccountIds: Array.isArray(config?.selectedAccountIds)
          ? [...new Set(config.selectedAccountIds.map((item) => String(item || '').trim()).filter(Boolean))]
          : (state.integration?.selectedAccountIds || [])
      };
      return state;
    });
    return this.store.read().integration;
  }

  async deliverWebhookEvent(eventName, payload, accountId) {
    const state = this.store.read();
    const integration = state.integration || {};
    if (!integration.enabled || !integration.webhookUrl) return { skipped: true };
    const selectedAccountIds = Array.isArray(integration.selectedAccountIds) ? integration.selectedAccountIds.map(String) : [];
    if (selectedAccountIds.length && !selectedAccountIds.includes(String(accountId || ''))) return { skipped: true, reason: 'account_not_selected' };
    const account = state.accounts?.[String(accountId || '')] || null;
    const normalizedPayload = eventName === 'message'
      ? buildRealtimeWebhookMessagePayload(state, payload, accountId)
      : payload;
    const body = buildWebhookEnvelope(eventName, normalizedPayload, account);
    if (eventName === 'message' && body?.messageData?.album?.groupId) {
      return this.queueAlbumWebhookDelivery({ accountId, threadId: body.messageData.threadId, groupId: body.messageData.album.groupId });
    }
    return this.sendWebhookBody(body, integration);
  }

  async queueAlbumWebhookDelivery({ accountId, threadId, groupId }) {
    const key = [String(accountId || ''), String(threadId || ''), String(groupId || '')].join(':');
    const existing = this.pendingAlbumWebhooks.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    const timer = setTimeout(async () => {
      this.pendingAlbumWebhooks.delete(key);
      try {
        const state = this.store.read();
        const integration = state.integration || {};
        const account = state.accounts?.[String(accountId || '')] || null;
        const body = buildAlbumWebhookEnvelope(state, accountId, threadId, groupId, account);
        if (!body) return;
        await this.sendWebhookBody(body, integration);
      } catch (error) {
        console.error('[zalo-user-server] album webhook delivery failed', error);
      }
    }, 700);
    this.pendingAlbumWebhooks.set(key, { timer });
    return { queued: true };
  }

  async sendWebhookBody(body, integration = this.store.read().integration || {}) {
    const headers = { 'content-type': 'application/json' };
    if (integration.webhookSecret) headers['x-bot-api-secret-token'] = integration.webhookSecret;
    try {
      const res = await fetch(integration.webhookUrl, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Webhook n8n trả HTTP ${res.status}`);
      this.store.update((draft) => {
        draft.integration.lastDeliveryAt = new Date().toISOString();
        draft.integration.lastDeliveryError = null;
        return draft;
      });
      return { ok: true };
    } catch (error) {
      this.store.update((draft) => {
        draft.integration.lastDeliveryError = error.message || String(error);
        return draft;
      });
      throw error;
    }
  }

  getThreadType(thread) {
    return thread?.type === 'group' ? ThreadType.Group : ThreadType.User;
  }

  findMessage(threadId, messageId, accountState = null) {
    const source = accountState || getAccountScopedState(this.store.read(), this.store.read().activeAccountId) || this.store.read();
    return (source.messages?.[threadId] || []).find((item) => item.id === messageId) || null;
  }
}



function hasPersistedAccountHistory(state, accountId) {
  const key = String(accountId || '').trim();
  if (!key) return false;
  const snapshot = state?.accountStateById?.[key];
  if (!snapshot || typeof snapshot !== 'object') return false;
  const threadCount = Object.keys(snapshot.threads || {}).length;
  const messageCount = Object.values(snapshot.messages || {}).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
  return threadCount > 0 || messageCount > 0;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function sanitizeDirectThreadMessages(messages, ownUserId, threadId) {
  return filterMessagesToRecentWindow((Array.isArray(messages) ? messages : []).filter((message) => {
    const senderId = String(message?.senderId || '');
    if (!senderId) return false;
    return senderId === String(ownUserId || '') || senderId === String(threadId || '');
  }));
}

function filterMessagesToRecentWindow(messages, now = Date.now()) {
  const cutoff = now - MESSAGE_SYNC_WINDOW_MS;
  return (Array.isArray(messages) ? messages : []).filter((message) => {
    const time = Date.parse(String(message?.createdAt || ''));
    return Number.isFinite(time) && time >= cutoff;
  });
}

function normalizeRecommendations(items) {
  return (items || []).filter((item) => Number(item?.dataInfo?.recommType) === 1).map((item) => ({
    id: String(item?.dataInfo?.userId || ''),
    displayName: item?.dataInfo?.displayName || item?.dataInfo?.zaloName || '',
    avatarUrl: item?.dataInfo?.avatar || '',
    status: item?.dataInfo?.status || '',
    phoneNumber: item?.dataInfo?.phoneNumber || '',
    reason: item?.dataInfo?.recommInfo?.message || '',
    recommType: item?.dataInfo?.recommType || null
  })).filter((item) => item.id);
}

function normalizeIncomingRequests(items) {
  return (items || []).filter((item) => Number(item?.dataInfo?.recommType) === 2).map((item) => ({
    id: String(item?.dataInfo?.userId || ''),
    displayName: item?.dataInfo?.displayName || item?.dataInfo?.zaloName || '',
    avatarUrl: item?.dataInfo?.avatar || '',
    phoneNumber: item?.dataInfo?.phoneNumber || '',
    message: item?.dataInfo?.recommInfo?.message || '',
    time: item?.dataInfo?.recommTime || null,
    seen: Boolean(item?.dataInfo?.isSeenFriendReq)
  })).filter((item) => item.id);
}

function normalizeSentRequests(value) {
  if (!value || value.error) return [];
  return Object.values(value).map((item) => ({
    id: String(item.userId),
    displayName: item.displayName || item.zaloName || '',
    avatarUrl: item.avatar || '',
    message: item.fReqInfo?.message || '',
    time: item.fReqInfo?.time || null
  }));
}

function normalizeMutedConversations(value) {
  return [
    ...((value?.chatEntries || []).map((item) => String(item.id))),
    ...((value?.groupChatEntries || []).map((item) => String(item.id)))
  ];
}

function normalizeFoundUser(user) {
  if (!user) return null;
  return {
    id: String(user.uid || user.userId || user.globalId || ''),
    username: user.username || '',
    displayName: user.display_name || user.displayName || user.zalo_name || user.zaloName || '',
    avatarUrl: user.avatar || '',
    status: user.status || '',
    globalId: user.globalId || '',
    phoneNumber: user.phoneNumber || ''
  };
}

function normalizeQrImage(value) {
  if (!value) return null;
  if (value.startsWith('data:image/')) return value;
  return `data:image/png;base64,${value}`;
}

function normalizeUser(user, kind = 'friend', fallbackId = '') {
  const id = String(user?.userId || user?.uid || user?.id || fallbackId || '');
  return {
    id,
    displayName: user?.displayName || user?.zaloName || user?.username || id,
    zaloName: user?.zaloName || '',
    username: user?.username || '',
    avatarUrl: user?.avatar || user?.avatarUrl || '',
    phoneNumber: user?.phoneNumber || '',
    globalId: user?.globalId || '',
    kind
  };
}

function buildSocialUserRecord(userId, profile = {}, message = '') {
  return {
    id: String(userId),
    displayName: profile.displayName || profile.zaloName || profile.username || String(userId),
    avatarUrl: profile.avatarUrl || profile.avatar || '',
    phoneNumber: profile.phoneNumber || '',
    message: String(message || ''),
    time: Date.now()
  };
}

function resolveFriendEventUserId(event, ownId) {
  const type = Number(event?.type);
  if ([0, 1, 6, 7, 8, 9].includes(type)) return String(event?.data || '');
  if (type === 2 || type === 3 || type === 4) {
    const fromUid = String(event?.data?.fromUid || '');
    const toUid = String(event?.data?.toUid || '');
    if (fromUid && fromUid !== ownId) return fromUid;
    if (toUid && toUid !== ownId) return toUid;
    return fromUid || toUid;
  }
  return String(event?.threadId || '');
}

function normalizeHistoryMessage(message, ownId) {
  const deleteRefs = extractDeleteMessageRefs(message?.data?.content, message?.data?.msgType);
  if (deleteRefs.length) return null;
  const normalizedContent = normalizeMessagePayload(message.data.content, message.data.msgType);
  return {
    id: String(message.data.msgId || message.data.cliMsgId || message.data.actionId),
    threadId: String(message.threadId),
    senderId: String(message.data.uidFrom),
    text: normalizedContent.text,
    type: normalizedContent.type || message.data.msgType || 'text',
    attachments: normalizedContent.attachments,
    sticker: normalizedContent.sticker,
    album: normalizedContent.album,
    quote: normalizeMessageQuote(message.data.quote),
    mentions: normalizeMessageMentions(message.data.content, message.data.mentions),
    isOutgoing: message.isSelf || String(message.data.uidFrom) === String(ownId),
    createdAt: new Date(Number(message.data.ts || Date.now())).toISOString(),
    raw: {
      msgId: message.data.msgId || null,
      cliMsgId: message.data.cliMsgId || null,
      uidFrom: message.data.uidFrom || null,
      ts: message.data.ts || null,
      msgType: message.data.msgType || null,
      ttl: message.data.ttl ?? null,
      propertyExt: message.data.propertyExt || null,
      content: message.data.content || null,
      quote: message.data.quote || null,
      mentions: message.data.mentions || null
    }
  };
}

function extractDeleteMessageRefs(content, msgType) {
  if (String(msgType || '') !== 'chat.delete') return [];
  const items = Array.isArray(content) ? content : [content];
  const refs = [];
  for (const item of items) {
    const rawMsgId = stringifyDeleteRef(item?.globalDelMsgId ?? item?.globalMsgId ?? item?.msgId ?? '');
    const rawCliMsgId = stringifyDeleteRef(item?.clientDelMsgId ?? item?.cliMsgId ?? '');
    if (rawMsgId || rawCliMsgId) refs.push({ msgId: rawMsgId, cliMsgId: rawCliMsgId });
  }
  return refs;
}

function stringifyDeleteRef(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(stringifyDeleteRef).filter(Boolean).join('');
  if (value && typeof value === 'object' && Array.isArray(value.c)) return value.c.map((part) => String(part ?? '')).join('');
  return '';
}

function removeMessagesByRefs(state, threadId, refs = []) {
  const messages = Array.isArray(state?.messages?.[threadId]) ? state.messages[threadId] : null;
  if (!messages || !refs.length) return;
  for (const message of messages) {
    const msgId = String(message?.raw?.msgId || message?.id || '');
    const cliMsgId = String(message?.raw?.cliMsgId || '');
    const matched = refs.some((ref) => (ref.msgId && msgId === ref.msgId) || (ref.cliMsgId && cliMsgId === ref.cliMsgId));
    if (!matched) continue;
    message.text = '[đã xoá phía Zalo]';
    message.deleted = true;
    message.recalled = false;
    message.pending = false;
    message.attachments = [];
    message.sticker = null;
    message.album = null;
    message.raw = { ...(message.raw || {}), deleteEventRefs: refs };
  }
}

function normalizeMessagePayload(content, msgType) {
  const album = extractAlbumMeta(content);
  const stickerUrl = content?.stickerWebpUrl || content?.stickerUrl || content?.thumbUrl || content?.iconUrl || null;
  if (stickerUrl || String(msgType || '').includes('sticker')) {
    return {
      text: String(stickerUrl || ''),
      type: 'chat.sticker',
      sticker: {
        url: stickerUrl || null,
        webpUrl: content?.stickerWebpUrl || null,
        thumbUrl: content?.thumbUrl || content?.iconUrl || null,
        id: content?.id || content?.stickerId || null,
        cateId: content?.cateId || content?.cate_id || content?.catId || null,
        type: content?.type || null,
        text: content?.text || ''
      },
      attachments: [],
      album
    };
  }

  const mediaUrl = content?.hdUrl || content?.normalUrl || content?.rawUrl || content?.href || content?.fileUrl || null;
  if (mediaUrl) {
    return {
      text: String(mediaUrl),
      type: msgType || inferTypeFromUrl(mediaUrl),
      attachments: [{
        url: String(mediaUrl),
        name: content?.fileName || content?.title || '',
        contentType: content?.contentType || '',
        kind: inferAttachmentKind(content?.contentType || '', mediaUrl)
      }],
      sticker: null,
      album
    };
  }

  return {
    text: normalizeMessageText(content),
    type: msgType || 'text',
    attachments: [],
    sticker: null,
    album
  };
}

function extractAlbumMeta(content) {
  const params = parseContentParams(content?.params);
  const total = Number(params?.total_item_in_group || 0);
  const groupId = String(params?.group_layout_id || '');
  const index = Number(params?.id_in_group || 0);
  if (!groupId || !total || total <= 1) return null;
  return { groupId, total, index: Number.isFinite(index) ? index : 0 };
}

function parseContentParams(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function normalizeMessageText(content) {
  if (typeof content === 'string') return content;
  if (content?.stickerWebpUrl || content?.stickerUrl) return content.stickerWebpUrl || content.stickerUrl;
  if (content?.hdUrl || content?.normalUrl || content?.rawUrl) return content.hdUrl || content.normalUrl || content.rawUrl;
  if (content?.fileUrl) return content.fileUrl;
  if (content?.title || content?.description) {
    return [content.title, content.description].filter(Boolean).join(' — ');
  }
  if (content?.href) return content.href;
  try {
    return JSON.stringify(content);
  } catch {
    return '[tin nhắn không đọc được nội dung]';
  }
}

function normalizeMessageQuote(quote) {
  if (!quote || typeof quote !== 'object') return null;
  return {
    ownerId: String(quote.ownerId || ''),
    ownerName: String(quote.fromD || ''),
    text: String(quote.msg || ''),
    msgType: String(quote.cliMsgType || ''),
    msgId: String(quote.globalMsgId || ''),
    cliMsgId: String(quote.cliMsgId || ''),
    ts: Number(quote.ts || 0) || null,
    ttl: Number(quote.ttl || 0) || null,
    attach: String(quote.attach || '')
  };
}

function normalizeMessageMentions(content, mentions) {
  const text = normalizeMessageText(content);
  if (!Array.isArray(mentions) || !mentions.length || typeof text !== 'string') return [];
  return mentions.map((item) => {
    const pos = Number(item?.pos || 0);
    const len = Number(item?.len || 0);
    const start = Number.isFinite(pos) && pos >= 0 ? pos : 0;
    const length = Number.isFinite(len) && len > 0 ? len : 0;
    const label = length ? text.slice(start, start + length) : '';
    return {
      uid: String(item?.uid || ''),
      pos: start,
      len: length,
      text: label
    };
  }).filter((item) => item.uid && item.len > 0);
}

function buildSendMessageQuote(message) {
  const raw = message?.raw;
  if (!message || !raw || !raw.msgId || !raw.cliMsgId || !raw.uidFrom) return null;
  return {
    content: raw.content ?? message.text ?? '',
    msgType: raw.msgType || message.type || 'webchat',
    propertyExt: raw.propertyExt || undefined,
    uidFrom: raw.uidFrom,
    msgId: raw.msgId,
    cliMsgId: raw.cliMsgId,
    ts: raw.ts || Date.now(),
    ttl: raw.ttl ?? 0
  };
}

function normalizeOutgoingMentions(items, text, threadType) {
  if (threadType !== ThreadType.Group || !Array.isArray(items) || !items.length || !text) return [];
  return items.map((item) => ({
    uid: String(item?.uid || ''),
    pos: Number(item?.pos || 0),
    len: Number(item?.len || 0)
  })).filter((item) => item.uid && Number.isFinite(item.pos) && Number.isFinite(item.len) && item.pos >= 0 && item.len > 0 && (item.pos + item.len) <= text.length);
}

function applyLabelsToThreads(state, labels) {
  for (const thread of Object.values(state.threads)) {
    thread.tags = [];
  }
  for (const label of labels || []) {
    for (const conv of label.conversations || []) {
      const normalized = String(conv);
      const threadId = normalized.startsWith('g') || normalized.startsWith('u') ? normalized.slice(1) : normalized;
      if (state.threads[threadId]) {
        state.threads[threadId].tags = uniqueStrings([...(state.threads[threadId].tags || []), label.text]);
      }
    }
  }
}

function applyAliasesToThreads(state, aliases) {
  for (const item of aliases || []) {
    const threadId = String(item?.userId || item?.id || '');
    const alias = String(item?.alias || '').trim();
    if (!threadId || !alias) continue;
    if (state.contacts[threadId]) state.contacts[threadId].displayName = alias;
    if (state.threads[threadId]) state.threads[threadId].title = alias;
  }
}

function normalizeOutgoingAttachments(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    name: item?.name || '',
    contentType: item?.contentType || '',
    size: item?.size || 0,
    kind: inferAttachmentKind(item?.contentType || '', item?.name || item?.url || ''),
    url: item?.url || null,
    previewUrl: item?.previewUrl || null
  }));
}

function summarizeOutgoingMessageText(text, attachments) {
  const messageText = String(text || '').trim();
  if (messageText) return messageText;
  const normalized = normalizeOutgoingAttachments(attachments);
  if (!normalized.length) return '';
  if (normalized.every((item) => item.kind === 'image')) {
    return normalized.length > 1 ? `[${normalized.length} ảnh]` : '[Ảnh]';
  }
  return normalized.length > 1 ? `[${normalized.length} tệp đính kèm]` : '[Tệp đính kèm]';
}

function createLocalOutgoingMessage({ threadId, accountId, text = '', attachments = [], quoteSource = null, mentions = [] } = {}) {
  const normalizedAttachments = stripAttachmentPreviews(normalizeOutgoingAttachments(attachments));
  const summaryText = summarizeOutgoingMessageText(text, attachments);
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    threadId: String(threadId || ''),
    senderId: String(accountId || 'self'),
    text: summaryText,
    type: normalizedAttachments.length ? inferOutgoingAttachmentType(normalizedAttachments) : 'webchat',
    attachments: normalizedAttachments,
    quote: buildSendMessageQuote(quoteSource),
    mentions: Array.isArray(mentions) ? mentions : [],
    isOutgoing: true,
    pending: true,
    createdAt: new Date().toISOString(),
    raw: {
      msgId: null,
      cliMsgId: null,
      uidFrom: String(accountId || 'self') || null,
      localOnly: true,
    }
  };
}

function stripAttachmentPreviews(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    ...item,
    previewUrl: null
  }));
}

function inferOutgoingAttachmentType(items) {
  const normalized = normalizeOutgoingAttachments(items);
  if (!normalized.length) return 'file';
  if (normalized.every((item) => item.kind === 'image')) return 'chat.photo';
  return 'chat.file';
}

function inferAttachmentKind(contentType, nameOrUrl) {
  const type = String(contentType || '').toLowerCase();
  const value = String(nameOrUrl || '').toLowerCase();
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(value)) return 'image';
  return 'file';
}

function inferTypeFromUrl(url) {
  return inferAttachmentKind('', url) === 'image' ? 'chat.photo' : 'chat.file';
}

function normalizeThreadId(value) {
  const raw = String(value || '');
  if (!raw) return '';
  return /^[ug]\d+$/i.test(raw) ? raw.slice(1) : raw;
}

function normalizeStickerCatalog(catalog) {
  const normalized = [];
  const seen = new Set();
  for (const pack of catalog?.all || []) {
    const cateId = extractCateIdFromStickerPack(pack);
    if (!cateId || seen.has(cateId)) continue;
    seen.add(cateId);
    normalized.push({
      storeId: String(pack?.id || ''),
      cateId,
      name: pack?.name || `Sticker ${cateId}`,
      iconUrl: pack?.iconUrl || '',
      thumbImg: pack?.thumbImg || '',
      qrCode: pack?.qrCode || '',
      totalImage: pack?.totalImage || '',
      price: pack?.price || '',
      source: pack?.source || ''
    });
  }
  return normalized;
}

function extractCateIdFromStickerPack(pack) {
  const candidates = [pack?.iconUrl, pack?.thumbImg, pack?.bannerUrl, pack?.qrCode, pack?.id];
  for (const value of candidates) {
    const match = String(value || '').match(/\/(\d{2,})\//);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

function normalizeStickerDetail(item) {
  return {
    id: Number(item?.id),
    cateId: Number(item?.cateId),
    type: Number(item?.type),
    text: item?.text || '',
    stickerUrl: item?.stickerUrl || null,
    stickerWebpUrl: item?.stickerWebpUrl || null,
    stickerSpriteUrl: item?.stickerSpriteUrl || null,
    thumbUrl: item?.thumbUrl || item?.stickerUrl || null,
    totalFrames: item?.totalFrames || 0,
    duration: item?.duration || 0
  };
}

function upsertAliasDraft(items, userId, alias) {
  const next = Array.isArray(items) ? [...items] : [];
  const id = String(userId);
  const value = String(alias || '').trim();
  const index = next.findIndex((item) => String(item?.userId || item?.id || '') === id);
  if (!value) {
    if (index >= 0) next.splice(index, 1);
    return next;
  }
  if (index >= 0) next[index] = { ...next[index], userId: id, alias: value };
  else next.push({ userId: id, alias: value });
  return next;
}

function extractGroupMemberIds(group, fallback = []) {
  const directIds = Array.isArray(group?.memberIds) ? group.memberIds : [];
  const currentMemIds = Array.isArray(group?.currentMems) ? group.currentMems.map((item) => item?.id) : [];
  const memVerIds = Array.isArray(group?.memVerList)
    ? group.memVerList.map((item) => String(item || '').split('_')[0]).filter(Boolean)
    : [];
  return uniqueStrings([...(directIds || []), ...(currentMemIds || []), ...(memVerIds || []), ...(Array.isArray(fallback) ? fallback : [])]);
}

function normalizeGroupMemberProfile(profile, fallbackMember, contact) {
  return {
    id: String(profile?.id || fallbackMember?.id || contact?.id || ''),
    displayName: profile?.displayName || fallbackMember?.zaloName || fallbackMember?.dName || contact?.displayName || contact?.zaloName || '',
    zaloName: profile?.zaloName || fallbackMember?.zaloName || contact?.zaloName || '',
    avatarUrl: profile?.avatar || fallbackMember?.avatar || contact?.avatarUrl || '',
    globalId: profile?.globalId || contact?.globalId || '',
    role: String(fallbackMember?.type || profile?.type || '')
  };
}

function applyReactionToDraft(draft, threadId, messageId, reaction) {
  const messages = draft.messages[threadId] || [];
  const target = messages.find((item) => String(item.id) === String(messageId));
  if (!target) return;
  const next = Array.isArray(target.reactions) ? [...target.reactions] : [];
  const actionId = String(reaction?.actionId || '');
  let filtered = next;
  if (actionId) {
    filtered = next.filter((item) => String(item?.actionId || '') !== actionId);
  }
  if (String(reaction.icon || '').trim()) {
    filtered = filtered.filter((item) => !(item?.pending && String(item.by || '') === String(reaction.by || '') && String(item.icon || '') === String(reaction.icon || '')));
    filtered.push(reaction);
  }
  target.reactions = filtered;
}

function applyUnreadMarks(state, unreadData) {
  for (const thread of Object.values(state.threads)) {
    thread.unreadCount = 0;
  }
  for (const item of unreadData?.convsUser || []) {
    const thread = state.threads[String(item.id)];
    if (thread) thread.unreadCount += 1;
  }
  for (const item of unreadData?.convsGroup || []) {
    const thread = state.threads[String(item.id)];
    if (thread) thread.unreadCount += 1;
  }
}

function toConversationKey(thread) {
  return `${thread.type === 'group' ? 'g' : 'u'}${thread.id}`;
}


function applyConversationFlags(state, zalo) {
  const pinned = new Set((zalo?.pinnedConversations || []).map(stripConvPrefix));
  const hidden = new Set((zalo?.hiddenConversations || []).map((item) => stripConvPrefix(item?.id || item?.conversationId || item)));
  const archived = new Set((zalo?.archivedConversations || []).map(stripConvPrefix));
  const autoDelete = new Set((zalo?.autoDeleteConversations || []).map(stripConvPrefix));
  const autoDeleteMap = zalo?.autoDeleteMap || {};
  const muted = new Set((zalo?.mutedConversations || []).map(stripConvPrefix));
  for (const thread of Object.values(state.threads)) {
    thread.pinned = pinned.has(String(thread.id));
    thread.hidden = hidden.has(String(thread.id));
    thread.archived = archived.has(String(thread.id));
    thread.autoDelete = autoDelete.has(String(thread.id));
    thread.autoDeleteTtl = Number(autoDeleteMap[String(thread.id)] || 0);
    thread.muted = muted.has(String(thread.id));
  }
}

function stripConvPrefix(value) {
  const raw = String(value || '');
  return raw.startsWith('u') || raw.startsWith('g') ? raw.slice(1) : raw;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((item) => String(item).trim()).filter(Boolean))];
}

async function getImageMetadata(filePath) {
  const [buffer, stats] = await Promise.all([
    fs.promises.readFile(filePath),
    fs.promises.stat(filePath)
  ]);
  const meta = detectImageSize(buffer);
  if (!meta) return null;
  return {
    width: meta.width,
    height: meta.height,
    size: stats.size
  };
}

function detectImageSize(buffer) {
  if (!buffer || buffer.length < 10) return null;

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3 || marker === 0xc5 || marker === 0xc6 || marker === 0xc7 || marker === 0xc9 || marker === 0xca || marker === 0xcb || marker === 0xcd || marker === 0xce || marker === 0xcf) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7)
        };
      }
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const size = buffer.readUInt16BE(offset + 2);
      if (!size) break;
      offset += 2 + size;
    }
  }

  if ((buffer.toString('ascii', 0, 3) === 'GIF') && buffer.length >= 10) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8)
    };
  }

  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff
      };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const b0 = buffer[21];
      const b1 = buffer[22];
      const b2 = buffer[23];
      const b3 = buffer[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      };
    }
    if (chunk === 'VP8X' && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3)
      };
    }
  }

  return null;
}

function buildWebhookEnvelope(eventName, payload, account) {
  const accountMeta = {
    account: account || null,
    account_id: account?.id || account?.userId || null,
    account_name: account?.displayName || null,
    zalo_name: account?.displayName || null
  };
  if (eventName === 'message') return { event: 'message', messageData: payload, ...accountMeta };
  if (eventName === 'friend_event') return { event: 'friend_event', friendEvent: payload, ...accountMeta };
  return { event: eventName, data: payload, ...accountMeta };
}

function buildRealtimeWebhookMessagePayload(state, payload, accountId) {
  if (!payload?.data) return payload;
  const accountState = getAccountScopedState(state, accountId);
  const ownId = accountState?.session?.account?.id || state.accounts?.[String(accountId || '')]?.userId || null;
  return normalizeHistoryMessage(payload, ownId);
}

function buildAlbumWebhookEnvelope(state, accountId, threadId, groupId, account) {
  const accountState = getAccountScopedState(state, accountId);
  const messages = Array.isArray(accountState?.messages?.[String(threadId || '')]) ? accountState.messages[String(threadId || '')] : [];
  const albumMessages = messages
    .filter((item) => String(item?.album?.groupId || '') === String(groupId || ''))
    .sort((left, right) => Number(left?.album?.index || 0) - Number(right?.album?.index || 0));
  if (!albumMessages.length) return null;
  const primary = albumMessages[0];
  const attachments = dedupeWebhookAttachments(albumMessages.flatMap((item) => Array.isArray(item?.attachments) ? item.attachments : []));
  return buildWebhookEnvelope('message', {
    ...primary,
    attachments,
    album: {
      ...(primary.album || {}),
      itemsReceived: albumMessages.length,
      complete: Number(primary?.album?.total || 0) ? albumMessages.length >= Number(primary.album.total || 0) : attachments.length > 1
    },
    imageCount: attachments.filter((item) => item?.kind === 'image').length,
    imageUrls: attachments
      .filter((item) => item?.kind === 'image')
      .map((item) => item?.previewUrl || item?.url || '')
      .filter(Boolean),
    albumItems: albumMessages.map((item) => ({
      id: item.id,
      text: item.text,
      createdAt: item.createdAt,
      attachmentCount: Array.isArray(item?.attachments) ? item.attachments.length : 0,
      attachments: Array.isArray(item?.attachments) ? item.attachments : []
    }))
  }, account);
}

function dedupeWebhookAttachments(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((item) => {
    const key = [item?.kind || '', item?.url || '', item?.previewUrl || '', item?.name || ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
