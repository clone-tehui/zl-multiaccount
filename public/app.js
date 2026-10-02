const CLIENT_VERSION = detectClientVersion();
const REQUEST_TIMEOUT_MS = 8000;
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;

const state = {
  view: null,
  activeThreadId: null,
  authenticated: false,
  authIdentity: null,
  eventSource: null,
  currentView: 'chats',
  selectedAiDepartmentId: null,
  contextMenu: null,
  replyTo: null,
  appNotice: null,
  versionPollTimer: null,
  composerPanel: null,
  pendingAttachments: [],
  threadDrafts: {},
  stickerPacks: [],
  stickerPackDetails: {},
  pendingStickerLoads: new Set(),
  activeStickerCateId: null,
  lightboxImages: [],
  lightboxIndex: 0,
  isSendingMessage: false,
  realtimeReconnectTimer: null,
  realtimeFailureCount: 0,
  realtimeConnected: false,
  notifiedEventKeys: [],
  theme: 'light',
  sidebarWidth: 310,
  threadProfile: null,
  threadProfileTab: 'overview',
  threadProfileMemberQuery: '',
  forwardMessage: null,
  forwardSearchQuery: '',
  forwardTargetId: null,
  forwardSending: false,
  forwardStatus: '',
  bookingBridgeOpen: false,
  bookingBridgeLoading: false,
  bookingBridgeUrl: '',
  bookingBridgeContextKey: '',
  isSwitchingAccount: false,
  relationRefreshInFlight: new Set(),
  pendingReactionKeys: new Set(),
  integratedSearch: {
    remoteItems: [],
    loading: false,
    query: '',
    seq: 0,
    timer: null
  },
  rbac: null,
  threadMemory: {
    threadId: null,
    accountId: null,
    rows: [],
    selectedIds: new Set(),
    loading: false,
    loadedAt: null
  },
  agentSystem: {
    items: [],
    loading: false,
    loadedAt: null
  }
};

const els = {
  appShell: document.querySelector('.app-shell'),
  appNotice: document.getElementById('app-notice'),
  appNoticeText: document.getElementById('app-notice-text'),
  btnAppReload: document.getElementById('btn-app-reload'),
  authOverlay: document.getElementById('auth-overlay'),
  loginForm: document.getElementById('login-form'),
  loginUsername: document.getElementById('login-username'),
  loginPassword: document.getElementById('login-password'),
  loginError: document.getElementById('login-error'),
  setupForm: document.getElementById('setup-form'),
  setupUsername: document.getElementById('setup-username'),
  setupPassword: document.getElementById('setup-password'),
  setupPasswordConfirm: document.getElementById('setup-password-confirm'),
  setupError: document.getElementById('setup-error'),
  btnLogout: document.getElementById('btn-logout'),
  btnThemeToggle: document.getElementById('btn-theme-toggle'),
  themeSelect: document.getElementById('theme-select'),
  btnViewChats: document.getElementById('btn-view-chats'),
  btnViewUtility: document.getElementById('btn-view-utility'),
  chatView: document.getElementById('chat-view'),
  utilityView: document.getElementById('utility-view'),
  friendSearchInput: document.getElementById('friend-search-input'),
  btnFriendSearch: document.getElementById('btn-friend-search'),
  friendSearchResults: document.getElementById('friend-search-results'),
  incomingRequests: document.getElementById('incoming-requests'),
  recommendations: document.getElementById('recommendations'),
  sentRequests: document.getElementById('sent-requests'),
  blockedUsers: document.getElementById('blocked-users'),
  friendList: document.getElementById('friend-list'),
  autoReplies: document.getElementById('auto-replies'),
  utilityWebhookPanel: document.getElementById('utility-webhook-panel'),
  utilityRbacPanel: document.getElementById('utility-rbac-panel'),
  utilityAiPanel: document.getElementById('utility-ai-panel'),
  aiAutomationSummary: document.getElementById('ai-automation-summary'),
  aiRoutingBoard: document.getElementById('ai-routing-board'),
  aiExecutionBoard: document.getElementById('ai-execution-board'),
  aiEnabledMode: document.getElementById('ai-enabled-mode'),
  aiDefaultThreadMode: document.getElementById('ai-default-thread-mode'),
  aiProviderPrimary: document.getElementById('ai-provider-primary'),
  aiProviderFallback: document.getElementById('ai-provider-fallback'),
  aiAdminAlertUsers: document.getElementById('ai-admin-alert-users'),
  aiAllowedDepartments: document.getElementById('ai-allowed-departments'),
  aiSelectedAccountIds: document.getElementById('ai-selected-account-ids'),
  aiAccountPicker: document.getElementById('ai-account-picker'),
  aiModelClassify: document.getElementById('ai-model-classify'),
  aiModelRetrieve: document.getElementById('ai-model-retrieve'),
  aiModelComposeSimple: document.getElementById('ai-model-compose-simple'),
  aiModelComposeStructured: document.getElementById('ai-model-compose-structured'),
  aiModelComplaint: document.getElementById('ai-model-complaint'),
  aiModelFallback: document.getElementById('ai-model-fallback'),
  aiMaxAutoTurns: document.getElementById('ai-max-auto-turns'),
  aiMaxToolCalls: document.getElementById('ai-max-tool-calls'),
  aiLowConfidenceThreshold: document.getElementById('ai-low-confidence-threshold'),
  aiComplexThreshold: document.getElementById('ai-complex-threshold'),
  aiRepeatThreshold: document.getElementById('ai-repeat-threshold'),
  aiSnoozePresets: document.getElementById('ai-snooze-presets'),
  aiComplaintKeywords: document.getElementById('ai-complaint-keywords'),
  aiSystemPrompt: document.getElementById('ai-system-prompt'),
  aiReplyStylePrompt: document.getElementById('ai-reply-style-prompt'),
  aiHumanHandoffPrompt: document.getElementById('ai-human-handoff-prompt'),
  aiKnowledgeSources: document.getElementById('ai-knowledge-sources'),
  aiFlowDefinitions: document.getElementById('ai-flow-definitions'),
  aiPromptLibrary: document.getElementById('ai-prompt-library'),
  aiAutomationRules: document.getElementById('ai-automation-rules'),
  aiAgentRegistry: document.getElementById('ai-agent-registry'),
  aiDelegationRules: document.getElementById('ai-delegation-rules'),
  aiModelCatalog: document.getElementById('ai-model-catalog'),
  aiEmbeddingCatalog: document.getElementById('ai-embedding-catalog'),
  aiVectorStores: document.getElementById('ai-vector-stores'),
  aiPlanPreviewOutput: document.getElementById('ai-plan-preview-output'),
  aiAgentRegistryBoard: document.getElementById('ai-agent-registry-board'),
  aiAgentSystemDbBoard: document.getElementById('ai-agent-system-db-board'),
  btnAiAgentSystemRefresh: document.getElementById('btn-ai-agent-system-refresh'),
  aiModelCatalogBoard: document.getElementById('ai-model-catalog-board'),
  aiKnowledgeLibrary: document.getElementById('ai-knowledge-library'),
  aiKnowledgeUploadTarget: document.getElementById('ai-knowledge-upload-target'),
  aiKnowledgeUploadTags: document.getElementById('ai-knowledge-upload-tags'),
  aiKnowledgeFileInput: document.getElementById('ai-knowledge-file-input'),
  btnAiKnowledgeUpload: document.getElementById('btn-ai-knowledge-upload'),
  btnAiKnowledgeRefresh: document.getElementById('btn-ai-knowledge-refresh'),
  btnAiPlanPreview: document.getElementById('btn-ai-plan-preview'),
  aiDepartmentSelect: document.getElementById('ai-department-select'),
  aiDepartmentHint: document.getElementById('ai-department-hint'),
  btnAiSaveConfig: document.getElementById('btn-ai-save-config'),
  notesFieldWrap: document.getElementById('notes-field-wrap'),
  webhookUrlInput: document.getElementById('webhook-url-input'),
  webhookSecretInput: document.getElementById('webhook-secret-input'),
  webhookEnabledInput: document.getElementById('webhook-enabled-input'),
  webhookAccountPicker: document.getElementById('webhook-account-picker'),
  webhookAccountIds: document.getElementById('webhook-account-ids'),
  webhookStatus: document.getElementById('webhook-status'),
  btnSaveWebhook: document.getElementById('btn-save-webhook'),
  rbacPanel: document.getElementById('rbac-panel'),
  rbacDepartmentsBoard: document.getElementById('rbac-departments-board'),
  rbacUsersBoard: document.getElementById('rbac-users-board'),
  rbacRoleMatrix: document.getElementById('rbac-role-matrix'),
  btnRbacApplyRoles: document.getElementById('btn-rbac-apply-roles'),
  rbacDepartmentCode: document.getElementById('rbac-department-code'),
  rbacDepartmentName: document.getElementById('rbac-department-name'),
  rbacDepartmentManagers: document.getElementById('rbac-department-managers'),
  btnRbacSaveDepartment: document.getElementById('btn-rbac-save-department'),
  rbacAccountDepartmentId: document.getElementById('rbac-account-department-id'),
  rbacDepartmentAccountPicker: document.getElementById('rbac-department-account-picker'),
  btnRbacSaveDepartmentAccounts: document.getElementById('btn-rbac-save-department-accounts'),
  rbacUserUsername: document.getElementById('rbac-user-username'),
  rbacUserDisplay: document.getElementById('rbac-user-display'),
  rbacUserPassword: document.getElementById('rbac-user-password'),
  btnRbacTogglePassword: document.getElementById('btn-rbac-toggle-password'),
  rbacUserRole: document.getElementById('rbac-user-role'),
  rbacUserDepartmentPicker: document.getElementById('rbac-user-department-picker'),
  rbacUserDepartments: document.getElementById('rbac-user-departments'),
  rbacUserAccountIds: document.getElementById('rbac-user-account-ids'),
  rbacUserAccountPicker: document.getElementById('rbac-user-account-picker'),
  btnRbacSaveUser: document.getElementById('btn-rbac-save-user'),
  threadList: document.getElementById('thread-list'),
  threadCount: document.getElementById('thread-count'),
  unreadSummary: document.getElementById('unread-summary'),
  threadSearch: document.getElementById('thread-search'),
  accountSelect: document.getElementById('account-select'),
  btnZaloAccountLogout: document.getElementById('btn-zalo-account-logout'),
  sessionBadge: document.getElementById('session-badge'),
  accountLine: document.getElementById('account-line'),
  syncNote: document.getElementById('sync-note'),
  qrBox: document.getElementById('qr-box'),
  chatTitle: document.getElementById('chat-title'),
  chatSubtitle: document.getElementById('chat-subtitle'),
  chatRelationRow: document.getElementById('chat-relation-row'),
  chatBookingRow: document.getElementById('chat-booking-row'),
  chatDirectActions: document.getElementById('chat-direct-actions'),
  chatAvatarWrap: document.getElementById('chat-avatar-wrap'),
  chatHeaderTrigger: document.getElementById('chat-header-trigger'),
  chatAiQuickbar: document.getElementById('chat-ai-quickbar'),
  chatAiSnoozeWrap: document.getElementById('chat-ai-snooze-wrap'),
  chatAiSnoozeMenu: document.getElementById('chat-ai-snooze-menu'),
  btnChatAiToggle: document.getElementById('btn-chat-ai-toggle'),
  btnChatAiSnooze: document.getElementById('btn-chat-ai-snooze'),
  btnChatAiHuman: document.getElementById('btn-chat-ai-human'),
  messageList: document.getElementById('message-list'),
  messageInput: document.getElementById('message-input'),
  btnSend: document.getElementById('btn-send'),
  btnBookingBridge: document.getElementById('btn-booking-bridge'),
  btnAttach: document.getElementById('btn-attach'),
  btnEmoji: document.getElementById('btn-emoji'),
  btnSticker: document.getElementById('btn-sticker'),
  fileInput: document.getElementById('file-input'),
  composerTray: document.getElementById('composer-tray'),
  imageLightbox: document.getElementById('image-lightbox'),
  imageLightboxImg: document.getElementById('image-lightbox-img'),
  imageLightboxClose: document.getElementById('image-lightbox-close'),
  imageLightboxPrev: document.getElementById('image-lightbox-prev'),
  imageLightboxNext: document.getElementById('image-lightbox-next'),
  attachmentPreview: document.getElementById('attachment-preview'),
  emojiPanel: document.getElementById('emoji-panel'),
  stickerPanel: document.getElementById('sticker-panel'),
  stickerPackList: document.getElementById('sticker-pack-list'),
  stickerPackCount: document.getElementById('sticker-pack-count'),
  stickerGrid: document.getElementById('sticker-grid'),
  btnSync: document.getElementById('btn-sync'),
  btnThreadMeta: document.getElementById('btn-thread-meta'),
  btnCloseThreadMeta: document.getElementById('btn-close-thread-meta'),
  btnSaveMeta: document.getElementById('btn-save-meta'),
  btnStartQr: document.getElementById('btn-start-qr'),
  btnConfirmQr: document.getElementById('btn-confirm-qr'),
  btnRefresh: document.getElementById('btn-refresh'),
  renameInput: document.getElementById('rename-input'),
  assigneeInput: document.getElementById('assignee-input'),
  tagsInput: document.getElementById('tags-input'),
  autoDeleteSelect: document.getElementById('auto-delete-select'),
  availableTags: document.getElementById('available-tags'),
  quickMessages: document.getElementById('quick-messages'),
  replyPreview: document.getElementById('reply-preview'),
  notesInput: document.getElementById('notes-input'),
  threadDetails: document.getElementById('thread-details'),
  threadAutomationPanel: document.getElementById('thread-automation-panel'),
  threadAutomationHint: document.getElementById('thread-automation-hint'),
  threadAutomationStatus: document.getElementById('thread-automation-status'),
  threadAutomationDetails: document.getElementById('thread-automation-details'),
  threadAutomationMode: document.getElementById('thread-automation-mode'),
  threadAutomationHours: document.getElementById('thread-automation-hours'),
  threadAutomationMinutes: document.getElementById('thread-automation-minutes'),
  threadAutomationResumePreview: document.getElementById('thread-automation-resume-preview'),
  threadAutomationFlowId: document.getElementById('thread-automation-flow-id'),
  threadAutomationPolicyId: document.getElementById('thread-automation-policy-id'),
  threadAutomationReason: document.getElementById('thread-automation-reason'),
  btnThreadAutomationOff: document.getElementById('btn-thread-automation-off'),
  btnThreadAutomationAuto: document.getElementById('btn-thread-automation-auto'),
  btnThreadAutomation5m: document.getElementById('btn-thread-automation-5m'),
  btnThreadAutomation30m: document.getElementById('btn-thread-automation-30m'),
  btnThreadAutomationHuman: document.getElementById('btn-thread-automation-human'),
  btnThreadAutomationSave: document.getElementById('btn-thread-automation-save'),
  threadMemoryPanel: document.getElementById('thread-memory-panel'),
  threadMemoryHint: document.getElementById('thread-memory-hint'),
  threadMemoryCount: document.getElementById('thread-memory-count'),
  threadMemoryTable: document.getElementById('thread-memory-table'),
  btnThreadMemoryRefresh: document.getElementById('btn-thread-memory-refresh'),
  btnThreadMemoryDelete: document.getElementById('btn-thread-memory-delete'),
  contextMenu: document.getElementById('context-menu'),
  eventToastStack: document.getElementById('event-toast-stack'),
  layoutResizer: document.getElementById('layout-resizer'),
  threadProfileModal: document.getElementById('thread-profile-modal'),
  threadProfileContent: document.getElementById('thread-profile-content'),
  threadProfileClose: document.getElementById('thread-profile-close'),
  bookingBridgeModal: document.getElementById('booking-bridge-modal'),
  bookingBridgeClose: document.getElementById('booking-bridge-close'),
  bookingBridgeFrame: document.getElementById('booking-bridge-frame'),
  bookingBridgeStatus: document.getElementById('booking-bridge-status'),
  forwardModal: document.getElementById('forward-modal'),
  forwardModalClose: document.getElementById('forward-modal-close'),
  forwardSearch: document.getElementById('forward-search'),
  forwardThreadList: document.getElementById('forward-thread-list'),
  forwardStatus: document.getElementById('forward-status'),
  forwardSend: document.getElementById('forward-send')
};

const REACTION_OPTIONS = [
  { icon: '/-strong', label: 'Thích', display: '👍' },
  { icon: '/-heart', label: 'Tim', display: '❤️' },
  { icon: ':>', label: 'Haha', display: '😆' },
  { icon: ':o', label: 'Wow', display: '😮' },
  { icon: ':-((', label: 'Buồn', display: '😢' },
  { icon: ':-h', label: 'Giận', display: '😠' },
  { icon: ':-*', label: 'Hôn', display: '😘' },
  { icon: ":')", label: 'Vui rơi lệ', display: '😂' },
  { icon: '/-shit', label: 'Poop', display: '💩' },
  { icon: '/-rose', label: 'Hoa hồng', display: '🌹' },
  { icon: '/-break', label: 'Tim vỡ', display: '💔' },
  { icon: '/-weak', label: 'Dislike', display: '👎' },
  { icon: ';xx', label: 'Yêu', display: '🥰' },
  { icon: ';-/', label: 'Khó hiểu', display: '😕' },
  { icon: ';-)', label: 'Nháy mắt', display: '😉' },
  { icon: '/-fade', label: 'Biến mất', display: '🫥' },
  { icon: '/-li', label: 'Mặt trời', display: '☀️' },
  { icon: '/-bd', label: 'Sinh nhật', display: '🎂' },
  { icon: '/-bome', label: 'Bom', display: '💣' },
  { icon: '/-ok', label: 'OK', display: '👌' },
  { icon: '/-v', label: 'Peace', display: '✌️' },
  { icon: '/-thanks', label: 'Cảm ơn', display: '🙏' },
  { icon: '/-punch', label: 'Đấm', display: '👊' },
  { icon: '/-share', label: 'Chia sẻ', display: '📤' },
  { icon: '_()_', label: 'Cầu nguyện', display: '🙏' },
  { icon: '/-no', label: 'Không', display: '🙅' },
  { icon: '/-bad', label: 'Tệ', display: '👎' },
  { icon: '/-loveu', label: 'Yêu bạn', display: '🫶' },
  { icon: '--b', label: 'Buồn nhẹ', display: '😔' },
  { icon: ':((', label: 'Rất buồn', display: '😭' },
  { icon: 'x-)', label: 'Cool', display: '😎' },
  { icon: '8-)', label: 'Nerd', display: '🤓' },
  { icon: ';-d', label: 'Cười lớn', display: '😁' },
  { icon: 'b-)', label: 'Kính râm', display: '🕶️' },
  { icon: ':--|', label: 'Bình thản', display: '😐' },
  { icon: 'p-(', label: 'Mặt buồn', display: '☹️' },
  { icon: ':-bye', label: 'Tạm biệt', display: '👋' },
  { icon: '|-)', label: 'Buồn ngủ', display: '😴' },
  { icon: ':wipe', label: 'Lau nước mắt', display: '🥲' },
  { icon: ':-dig', label: 'Đào', display: '⛏️' },
  { icon: '&-(', label: 'Đau khổ', display: '😣' },
  { icon: ':handclap', label: 'Vỗ tay', display: '👏' },
  { icon: '>-|', label: 'Cọc', display: '😤' },
  { icon: ':-f', label: 'Ghế F', display: '🪑F' },
  { icon: ':-l', label: 'Ghế L', display: '🪑L' },
  { icon: ':-r', label: 'Ghế R', display: '🪑R' },
  { icon: ';-x', label: 'Im lặng', display: '🤐' },
  { icon: ':-o', label: 'Ngạc nhiên', display: '😯' },
  { icon: ';-s', label: 'Ngại', display: '😳' },
  { icon: ';-a', label: 'Sợ', display: '😨' },
  { icon: ':-<', label: 'Buồn 2', display: '😟' },
  { icon: ':))', label: 'Cười to', display: '🤣' },
  { icon: '$-)', label: 'Giàu', display: '🤑' },
  { icon: '/-beer', label: 'Bia', display: '🍺' }
];

const EMOJI_CHOICES = ['😀','😁','😂','🤣','😊','😍','😘','😎','🥹','😭','😡','👍','👎','🙏','👏','❤️','💔','🔥','🎉','🤝','🤖','✨','🌹','💣','😴','😮','😢','😅','🤔','🥰'];

function detectClientVersion() {
  try {
    const script = document.querySelector('script[src*="/app.js"]');
    const src = script?.getAttribute('src') || '';
    const url = new URL(src, window.location.href);
    return url.searchParams.get('v') || 'dev';
  } catch {
    return 'dev';
  }
}

const SUPPORTED_THEMES = ['default', 'light', 'dark', 'glass', 'origin'];

function getStoredTheme() {
  try {
    const raw = localStorage.getItem('zalo-ui-theme') || localStorage.getItem('theme') || '';
    if (raw === 'light') return 'light';
    if (raw === 'dark') return 'dark';
    if (raw === 'glass' || raw === 'liquid-glass') return 'glass';
    if (raw === 'origin' || raw === 'origin-gallery') return 'origin';
    if (raw === 'default') return 'default';
    if (raw) {
      const lower = String(raw).toLowerCase().trim();
      if (SUPPORTED_THEMES.includes(lower)) return lower;
    }
  } catch {
    // Safe fallback if localStorage is unavailable
  }
  return 'default';
}

function setStoredTheme(theme) {
  try {
    localStorage.setItem('zalo-ui-theme', theme);
  } catch {
    // Safe fallback if localStorage is unavailable
  }
}

function applyTheme(themeName) {
  const resolvedTheme = SUPPORTED_THEMES.includes(themeName) ? themeName : 'default';
  state.theme = resolvedTheme;
  setStoredTheme(resolvedTheme);

  document.body.setAttribute('data-theme', resolvedTheme);
  document.body.classList.remove('theme-default', 'theme-light', 'theme-dark', 'theme-glass', 'theme-origin', 'theme-sample');
  document.body.classList.add(`theme-${resolvedTheme}`);

  // Maintain backward compatibility with existing body.dark behavior
  document.body.classList.toggle('dark', resolvedTheme !== 'light');

  if (els.themeSelect && els.themeSelect.value !== resolvedTheme) {
    els.themeSelect.value = resolvedTheme;
  }
  if (els.btnThemeToggle) {
    if (resolvedTheme === 'light') {
      els.btnThemeToggle.textContent = '🌙';
      els.btnThemeToggle.title = 'Chuyển sang giao diện tối';
      els.btnThemeToggle.setAttribute('aria-label', 'Chuyển sang giao diện tối');
    } else if (resolvedTheme === 'glass') {
      els.btnThemeToggle.textContent = '✨';
      els.btnThemeToggle.title = 'Chuyển sang giao diện sáng';
      els.btnThemeToggle.setAttribute('aria-label', 'Chuyển sang giao diện sáng');
    } else if (resolvedTheme === 'origin') {
      els.btnThemeToggle.textContent = '🏛️';
      els.btnThemeToggle.title = 'Chuyển sang giao diện sáng';
      els.btnThemeToggle.setAttribute('aria-label', 'Chuyển sang giao diện sáng');
    } else {
      els.btnThemeToggle.textContent = '☀️';
      els.btnThemeToggle.title = 'Chuyển sang giao diện sáng';
      els.btnThemeToggle.setAttribute('aria-label', 'Chuyển sang giao diện sáng');
    }
  }
}

function applySavedTheme() {
  applyTheme(getStoredTheme());
}

function toggleTheme() {
  const nextTheme = state.theme === 'light' ? 'dark' : 'light';
  applyTheme(nextTheme);
}

function applySavedSidebarWidth() {
  const raw = Number(localStorage.getItem('zalo-sidebar-width') || 310);
  state.sidebarWidth = Math.min(520, Math.max(240, raw || 310));
  document.body.style.setProperty('--sidebar-width', `${state.sidebarWidth}px`);
}

function bindLayoutResizer() {
  const handle = els.layoutResizer;
  if (!handle) return;
  let dragging = false;
  const onMove = (event) => {
    if (!dragging) return;
    const next = Math.min(520, Math.max(240, event.clientX - 10));
    state.sidebarWidth = next;
    document.body.style.setProperty('--sidebar-width', `${next}px`);
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    localStorage.setItem('zalo-sidebar-width', String(state.sidebarWidth));
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stop);
  };
  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    document.body.classList.add('resizing');
    handle.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
  });
}

boot();

async function boot() {
  bindEvents();
  enhanceUtilityPanels();
  applySavedTheme();
  applySavedSidebarWidth();
  switchView('chats');
  startVersionPolling();
  await hydrateAuth();
}

function bindEvents() {
  document.addEventListener('click', maybeRequestNotificationPermission, { passive: true });
  els.btnThemeToggle?.addEventListener('click', toggleTheme);
  els.themeSelect?.addEventListener('change', (e) => applyTheme(e.target.value));
  els.btnRefresh.addEventListener('click', reloadState);
  els.btnStartQr.addEventListener('click', () => post('/api/sessions/qr/start').then(reloadState));
  els.btnConfirmQr.addEventListener('click', () => post('/api/sessions/qr/confirm').then(reloadState));
  els.btnZaloAccountLogout?.addEventListener('click', logoutZaloAccount);
  els.btnSend.addEventListener('click', sendMessage);
  els.btnAttach.addEventListener('click', () => els.fileInput.click());
  els.btnEmoji.addEventListener('click', () => toggleComposerPanel('emoji'));
  els.btnSticker.addEventListener('click', () => toggleComposerPanel('sticker'));
  els.fileInput.addEventListener('change', handleFilePicked);
  els.messageInput.addEventListener('input', handleComposerInput);
  els.messageInput.addEventListener('paste', handleComposerPaste);
  els.messageList.addEventListener('click', handleMessageListClick);
  els.imageLightbox.addEventListener('click', handleImageLightboxClick);
  els.imageLightboxPrev?.addEventListener('click', () => stepImageLightbox(-1));
  els.imageLightboxNext?.addEventListener('click', () => stepImageLightbox(1));
  els.imageLightboxClose.addEventListener('click', closeImageLightbox);
  els.btnSync.addEventListener('click', () => post('/api/sync/bootstrap').then(reloadState));
  els.btnThreadMeta.addEventListener('click', toggleThreadMeta);
  els.chatHeaderTrigger?.addEventListener('click', openThreadProfile);
  els.chatHeaderTrigger?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openThreadProfile();
    }
  });
  els.btnChatAiToggle?.addEventListener('click', toggleCurrentThreadAutomation);
  els.btnChatAiSnooze?.addEventListener('click', toggleChatAiSnoozeMenu);
  els.chatAiSnoozeMenu?.addEventListener('click', handleChatAiSnoozeMenuClick);
  els.btnChatAiHuman?.addEventListener('click', () => quickSetThreadAutomation('human_only'));
  els.threadProfileClose?.addEventListener('click', closeThreadProfile);
  els.threadProfileModal?.addEventListener('click', (event) => {
    if (event.target === els.threadProfileModal) closeThreadProfile();
  });
  els.btnBookingBridge?.addEventListener('click', openBookingBridgeModal);
  els.bookingBridgeClose?.addEventListener('click', closeBookingBridgeModal);
  els.bookingBridgeModal?.addEventListener('click', (event) => {
    if (event.target === els.bookingBridgeModal) closeBookingBridgeModal();
  });
  window.addEventListener('message', handleBookingBridgeMessage);
  els.forwardModalClose?.addEventListener('click', closeForwardModal);
  els.forwardModal?.addEventListener('click', (event) => {
    if (event.target === els.forwardModal) closeForwardModal();
  });
  els.forwardSearch?.addEventListener('input', (event) => {
    state.forwardSearchQuery = event.target.value || '';
    renderForwardThreadList();
  });
  els.forwardSend?.addEventListener('click', submitForwardSelection);
  els.btnCloseThreadMeta.addEventListener('click', hideThreadMeta);
  els.btnSaveMeta.addEventListener('click', () => saveMeta());
  els.btnThreadMemoryRefresh?.addEventListener('click', () => loadThreadMemory({ force: true }));
  els.btnThreadMemoryDelete?.addEventListener('click', deleteSelectedThreadMemoryRows);
  els.btnLogout.addEventListener('click', logout);
  els.btnViewChats.addEventListener('click', () => switchView('chats'));
  els.btnViewUtility.addEventListener('click', () => switchView('utility'));
  els.btnFriendSearch.addEventListener('click', searchFriends);
  els.friendSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      searchFriends();
    }
  });
  els.loginForm.addEventListener('submit', handleLogin);
  els.setupForm.addEventListener('submit', handleSetup);
  els.threadSearch.addEventListener('input', handleIntegratedSearchInput);
  els.accountSelect.addEventListener('change', handleAccountSelect);
  document.addEventListener('visibilitychange', handleVisibilityRecovery);
  window.addEventListener('focus', handleVisibilityRecovery);
  window.addEventListener('online', handleVisibilityRecovery);
  els.btnSaveWebhook?.addEventListener('click', saveWebhookConfig);
  els.webhookAccountPicker?.addEventListener('change', syncSelectedWebhookAccounts);
  els.btnAiSaveConfig?.addEventListener('click', saveAiAutomationConfig);
  els.aiDepartmentSelect?.addEventListener('change', (event) => { state.selectedAiDepartmentId = event.target.value || null; renderAiAutomationPanel(); });
  els.aiAccountPicker?.addEventListener('change', syncSelectedAiAccounts);
  els.btnAiAgentSystemRefresh?.addEventListener('click', () => loadAgentSystemAgents({ force: true }));
  els.aiAgentSystemDbBoard?.addEventListener('click', handleAgentSystemBoardClick);
  els.btnAiPlanPreview?.addEventListener('click', previewAiPlanForCurrentThread);
  els.btnAiKnowledgeUpload?.addEventListener('click', () => els.aiKnowledgeFileInput?.click());
  els.btnAiKnowledgeRefresh?.addEventListener('click', reloadState);
  els.aiKnowledgeFileInput?.addEventListener('change', handleKnowledgeFilesPicked);
  els.btnRbacSaveDepartment?.addEventListener('click', saveRbacDepartment);
  els.btnRbacSaveDepartmentAccounts?.addEventListener('click', saveRbacDepartmentAccounts);
  els.rbacAccountDepartmentId?.addEventListener('change', renderDepartmentAccountPicker);
  els.btnRbacSaveUser?.addEventListener('click', saveRbacUser);
  els.rbacUserRole?.addEventListener('change', handleRbacUserRoleChange);
  els.rbacUserDepartmentPicker?.addEventListener('change', handleRbacUserDepartmentsChange);
  els.btnRbacApplyRoles?.addEventListener('click', saveRbacRoles);
  els.btnRbacTogglePassword?.addEventListener('click', toggleRbacPasswordVisibility);
  els.rbacUsersBoard?.addEventListener('click', handleRbacUsersBoardClick);
  els.rbacUserAccountPicker?.addEventListener('change', syncSelectedRbacAccounts);
  els.tagsInput.addEventListener('change', renderTagPicker);
  els.autoDeleteSelect.addEventListener('change', updateAutoDelete);
  els.btnThreadAutomationSave?.addEventListener('click', () => saveThreadAutomation());
  els.btnThreadAutomationOff?.addEventListener('click', () => quickSetThreadAutomation('off'));
  els.btnThreadAutomationAuto?.addEventListener('click', () => quickSetThreadAutomation('auto'));
  els.btnThreadAutomation5m?.addEventListener('click', () => quickSetThreadAutomation('snoozed', 5));
  els.btnThreadAutomation30m?.addEventListener('click', () => quickSetThreadAutomation('snoozed', 30));
  els.btnThreadAutomationHuman?.addEventListener('click', () => quickSetThreadAutomation('human_only'));
  els.threadAutomationMode?.addEventListener('change', () => updateThreadAutomationResumePreview());
  els.threadAutomationHours?.addEventListener('input', () => updateThreadAutomationResumePreview());
  els.threadAutomationMinutes?.addEventListener('input', () => updateThreadAutomationResumePreview());
  els.messageInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    sendMessage();
  });
  document.addEventListener('click', (event) => {
    hideContextMenu();
    if (!els.chatAiSnoozeWrap?.contains(event.target)) closeChatAiSnoozeMenu();
  });
  document.addEventListener('scroll', hideContextMenu, true);
  window.addEventListener('resize', hideContextMenu);
  els.btnAppReload.addEventListener('click', () => window.location.reload());
  document.addEventListener('keydown', handleGlobalKeydown);
  bindLayoutResizer();
  renderEmojiPanel();
}

function switchView(name) {
  hideContextMenu();
  if (name !== 'chats') hideThreadMeta();
  const showingChats = name === 'chats';
  state.currentView = showingChats ? 'chats' : 'utility';
  // These are separate pages in the main panel. Use hidden as well as active so
  // legacy CSS can never leave Chat and Utilities visible together.
  els.chatView.hidden = !showingChats;
  els.utilityView.hidden = showingChats;
  els.chatView.classList.toggle('active', showingChats);
  els.utilityView.classList.toggle('active', !showingChats);
  els.btnViewChats.classList.toggle('active', showingChats);
  els.btnViewUtility.classList.toggle('active', !showingChats);
}

async function hydrateAuth() {
  try {
    const auth = await getJson('/api/auth/status');
    state.authIdentity = auth.authenticated ? auth : null;
    if (auth.setupRequired) {
      setAuthenticated(false, true);
      return;
    }
    if (auth.authEnabled && !auth.authenticated) {
      setAuthenticated(false);
      return;
    }
    setAuthenticated(true);
    await reloadState();
    connectEvents();
  } catch (error) {
    showLoginError(error.message || 'Không kiểm tra được trạng thái đăng nhập');
    setAuthenticated(false);
  }
}

function setAuthenticated(value, setupRequired = false) {
  state.authenticated = value;
  els.authOverlay.classList.toggle('hidden', value);
  els.appShell.classList.toggle('hidden', !value);
  document.body.classList.toggle('login-mode', !value);
  els.btnLogout.classList.toggle('hidden', !value);
  if (!value) {
    disconnectEvents();
    els.loginPassword.value = '';
    els.loginForm.classList.toggle('hidden', setupRequired);
    els.setupForm.classList.toggle('hidden', !setupRequired);
    if (setupRequired) els.setupUsername.focus();
    else els.loginUsername.focus();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  hideLoginError();
  const username = els.loginUsername.value.trim();
  const password = els.loginPassword.value;
  if (!username || !password) return showLoginError('Nhập tài khoản và mật khẩu');
  try {
    const auth = await post('/api/auth/login', { username, password });
    state.authIdentity = auth;
    setAuthenticated(true);
    await reloadState();
    connectEvents();
  } catch (error) {
    showLoginError(error.message || 'Đăng nhập thất bại');
    setAuthenticated(false);
  }
}

async function handleSetup(event) {
  event.preventDefault();
  els.setupError.classList.add('hidden');
  const username = els.setupUsername.value.trim();
  const password = els.setupPassword.value;
  if (!username || !password) return showSetupError('Nhập tên đăng nhập và mật khẩu');
  if (password !== els.setupPasswordConfirm.value) return showSetupError('Xác nhận mật khẩu chưa khớp');
  try {
    const auth = await post('/api/auth/setup', { username, password });
    state.authIdentity = auth;
    setAuthenticated(true);
    await reloadState();
    connectEvents();
  } catch (error) {
    showSetupError(error.message || 'Không tạo được tài khoản quản trị');
  }
}

function showSetupError(message) {
  els.setupError.textContent = message;
  els.setupError.classList.remove('hidden');
}

async function logout() {
  await post('/api/auth/logout');
  state.view = null;
  state.authIdentity = null;
  state.rbac = null;
  state.activeThreadId = null;
  state.threadDrafts = {};
  setAuthenticated(false);
}

async function reloadState() {
  saveComposerDraft();
  const requestedAccountId = String(state.view?.activeAccountId || '');
  const previousActiveThreadId = state.activeThreadId;
  const data = await getJson('/api/state');
  if (requestedAccountId !== String(state.view?.activeAccountId || '')) return;
  state.view = data;
  await loadRbacCatalog();
  hideAppNotice();
  const threadIds = (state.view.threads || []).map((thread) => String(thread.id));
  const requestedThreadId = getRequestedThreadId();
  if (requestedThreadId && threadIds.includes(String(requestedThreadId))) {
    state.activeThreadId = requestedThreadId;
  } else if (!threadIds.includes(String(state.activeThreadId || ''))) {
    state.activeThreadId = threadIds[0] || null;
  }
  syncThreadQueryParam(state.activeThreadId);
  if (String(previousActiveThreadId || '') !== String(state.activeThreadId || '')) {
    restoreComposerDraft(state.activeThreadId);
  } else {
    syncReplyDraftReference();
  }
  render();
}

function connectEvents() {
  if (state.eventSource || !state.authenticated) return;
  const streamAccountId = String(state.view?.activeAccountId || '');
  clearTimeout(state.realtimeReconnectTimer);
  state.realtimeReconnectTimer = null;
  state.eventSource = new EventSource(`/api/events?accountId=${encodeURIComponent(state.view?.activeAccountId || '')}`);
  state.eventSource.onopen = () => {
    state.realtimeConnected = true;
    state.realtimeFailureCount = 0;
    if (state.appNotice?.message?.includes('Realtime')) hideAppNotice();
  };
  for (const name of ['snapshot', 'message.created', 'session.updated', 'thread.meta_updated']) {
    state.eventSource.addEventListener(name, (event) => {
      if (streamAccountId !== String(state.view?.activeAccountId || '')) return;
      const payload = JSON.parse(event.data);
      const inner = payload.payload || payload;
      if (shouldIgnoreRealtimeEvent(payload, inner)) return;
      if (name === 'thread.meta_updated' && (inner?.kind === 'reaction' || inner?.kind === 'friend')) {
        applyRealtimeEvent(payload.type || name, {
          ...inner,
          view: payload.view || inner?.view || null
        });
        return;
      }
      if (payload.view || payload.threads) {
        saveComposerDraft();
        state.view = payload.view || payload;
        syncReplyDraftReference();
        restoreComposerDraft(state.activeThreadId);
        hideAppNotice();
        render();
        return;
      }
      applyRealtimeEvent(payload.type || name, inner);
    });
  }
  state.eventSource.onerror = () => {
    state.realtimeConnected = false;
    state.realtimeFailureCount += 1;
    const pageHidden = document.visibilityState && document.visibilityState !== 'visible';
    if (!pageHidden && state.realtimeFailureCount >= 3) {
      showAppNotice('Realtime đang chập chờn, web sẽ tự nối lại. Nếu kéo dài, hãy tải lại trang.', 'warning');
    }
    const delay = pageHidden ? 1500 : Math.min(15000, 2000 + (state.realtimeFailureCount * 1000));
    disconnectEvents();
    state.realtimeReconnectTimer = setTimeout(() => {
      if (document.visibilityState && document.visibilityState !== 'visible') {
        connectEvents();
        return;
      }
      reloadState().catch(() => null).finally(() => connectEvents());
    }, delay);
  };
}

function disconnectEvents(reason = '') {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  clearTimeout(state.realtimeReconnectTimer);
  state.realtimeReconnectTimer = null;
  state.realtimeConnected = false;
  if (reason) showAppNotice(reason, 'warning');
}

function shouldIgnoreRealtimeEvent(payload, inner = null) {
  const currentAccountId = String(state.view?.activeAccountId || '').trim();
  const eventAccountId = String(payload?.accountId || inner?.accountId || payload?.view?.activeAccountId || inner?.view?.activeAccountId || '').trim();
  return Boolean(currentAccountId && eventAccountId && currentAccountId !== eventAccountId);
}

function applyRealtimeEvent(type, payload) {
  if (!state.view) return;

  if (type === 'message.created') {
    // Realtime is the source of truth for attachment/albums and the final merge point for text sends.
    const message = payload?.message || payload;
    const threadId = String(payload?.threadId || message?.threadId || '');
    const thread = (state.view.threads || []).find((item) => String(item.id) === threadId);
    if (!thread) {
      reloadState().catch(() => null);
      return;
    }

    thread.messages = removeClientPendingAlbumOnRealtime(thread.messages || [], message);
    thread.messages = dedupeClientMessages([...(thread.messages || []), message]);
    thread.lastMessageAt = message.createdAt || thread.lastMessageAt || null;
    thread.lastMessageText = summarizeClientMessage(message);
    if (!message.isOutgoing) {
      if (threadId !== state.activeThreadId) thread.unreadCount = (thread.unreadCount || 0) + 1;
      else thread.unreadCount = 0;
      notifyIncomingEvent({ kind: 'message', thread, message });
    }
    recalcUnreadStats();
    sortThreadsInView();
    hideAppNotice();
    render();
    return;
  }

  if (type === 'thread.meta_updated' && payload?.kind === 'reaction') {
    const threadId = String(payload?.threadId || '');
    const thread = (state.view.threads || []).find((item) => String(item.id) === threadId);
    if (!thread) {
      reloadState().catch(() => null);
      return;
    }
    const message = (thread.messages || []).find((item) => String(item.id) === String(payload?.messageId || ''));
    if (message) {
      const reactions = Array.isArray(message.reactions) ? [...message.reactions] : [];
      const actionId = String(payload?.reaction?.actionId || '');
      let next = reactions;
      if (actionId) next = next.filter((item) => String(item?.actionId || '') !== actionId);
      next = next.filter((item) => !(item?.pending && String(item.by) === String(payload?.reaction?.by || '') && String(item.icon || '') === String(payload?.reaction?.icon || '')));
      if (String(payload?.reaction?.icon || '').trim()) next.push(payload.reaction);
      message.reactions = next;
      if (!payload?.reaction?.self) {
        if (threadId !== state.activeThreadId) thread.unreadCount = (thread.unreadCount || 0) + 1;
        notifyIncomingEvent({ kind: 'reaction', thread, message, reaction: payload.reaction });
      }
      recalcUnreadStats();
      render();
      return;
    }
  }

  if (type === 'thread.meta_updated' && payload?.kind === 'friend') {
    const previousIncomingIds = new Set((state.view?.zalo?.incomingRequests || []).map((item) => String(item.id)));
    if (payload.view) {
      saveComposerDraft();
      state.view = payload.view;
      syncReplyDraftReference();
      restoreComposerDraft(state.activeThreadId);
    }
    hideAppNotice();
    render();
    if (Number(payload?.eventType) === 2) {
      const userId = String(payload?.userId || '');
      const isIncoming = incomingRequestMap().has(userId) && !previousIncomingIds.has(userId);
      if (isIncoming) notifyIncomingEvent({ kind: 'friend_request', user: findContact(userId) || incomingRequestMap().get(userId) });
    }
    return;
  }

  reloadState().catch(() => null);
}

function startVersionPolling() {
  if (state.versionPollTimer) return;
  checkAppVersion();
  state.versionPollTimer = setInterval(checkAppVersion, 10000);
}

async function checkAppVersion() {
  try {
    const meta = await fetchJson('/api/version', { credentials: 'same-origin' }, { silentNotice: true, timeoutMs: 4000 });
    if (meta?.version) {
      state.serverVersion = String(meta.version);
      if (state.view?.session) renderSession();
    }
    if (meta?.version && String(meta.version) !== CLIENT_VERSION) {
      showAppNotice(`Server vừa cập nhật sang bản ${meta.version} (UI hiện tại ${CLIENT_VERSION}). Vui lòng tải lại trang để tiếp tục sử dụng.`, 'danger');
      disconnectEvents();
    }
  } catch {
    // ignore; request helpers already handle meaningful failures elsewhere
  }
}

function recalcUnreadStats() {
  if (!state.view) return;
  const threads = state.view.threads || [];
  state.view.stats = {
    ...(state.view.stats || {}),
    unreadThreads: threads.filter((thread) => (thread.unreadCount || 0) > 0).length,
    unreadMessages: threads.reduce((sum, thread) => sum + (thread.unreadCount || 0), 0)
  };
}

function clearUnreadForThread(threadId) {
  const thread = (state.view?.threads || []).find((item) => String(item.id) === String(threadId));
  if (!thread) return;
  thread.unreadCount = 0;
  recalcUnreadStats();
}

function currentDraftKey(threadId = state.activeThreadId) {
  const accountId = String(state.view?.activeAccountId || state.view?.session?.account?.id || 'default');
  const targetThreadId = String(threadId || '');
  return targetThreadId ? `${accountId}:${targetThreadId}` : '';
}

function currentActiveAccountId() {
  return String(state.view?.activeAccountId || state.view?.session?.account?.id || '').trim();
}

function currentBookingBridgeContextKey(threadId = state.activeThreadId) {
  const accountId = currentActiveAccountId();
  const targetThreadId = String(threadId || '').trim();
  return accountId && targetThreadId ? `${accountId}:${targetThreadId}` : '';
}

function isCurrentAccountChiHome() {
  const accountId = currentActiveAccountId();
  if (!accountId) return false;
  const channel = getAccountChannel(accountId);
  if (!channel) return false;
  const department = getDepartmentMap().get(String(channel.departmentId || ''));
  return [channel.departmentId, department?.id, department?.code, department?.name]
    .map((value) => String(value || '').trim().toLowerCase())
    .includes('chihome');
}

function clonePendingAttachment(item) {
  return item ? { ...item } : item;
}

function saveComposerDraft(threadId = state.activeThreadId) {
  const key = currentDraftKey(threadId);
  if (!key || !els.messageInput) return;
  const draft = {
    text: els.messageInput.value || '',
    attachments: (state.pendingAttachments || []).map(clonePendingAttachment),
    replyToId: state.replyTo?.id || null
  };
  if (!draft.text.trim() && !draft.attachments.length && !draft.replyToId) {
    delete state.threadDrafts[key];
    return;
  }
  state.threadDrafts[key] = draft;
}

function clearComposerDraft(threadId = state.activeThreadId) {
  const key = currentDraftKey(threadId);
  if (key) delete state.threadDrafts[key];
}

function restoreComposerDraft(threadId = state.activeThreadId) {
  const key = currentDraftKey(threadId);
  const draft = key ? state.threadDrafts[key] : null;
  els.messageInput.value = draft?.text || '';
  state.pendingAttachments = (draft?.attachments || []).map(clonePendingAttachment);
  state.replyTo = null;
  if (draft?.replyToId) {
    const thread = (state.view?.threads || []).find((item) => String(item.id) === String(threadId || ''));
    state.replyTo = (thread?.messages || []).find((item) => String(item.id) === String(draft.replyToId)) || null;
  }
  renderAttachmentPreview();
  renderReplyPreview();
}

function syncReplyDraftReference() {
  if (!state.replyTo?.id) return;
  const thread = currentThread();
  if (!thread) {
    state.replyTo = null;
    saveComposerDraft();
    return;
  }
  state.replyTo = (thread.messages || []).find((item) => String(item.id) === String(state.replyTo.id)) || state.replyTo;
  saveComposerDraft();
}

function switchActiveThread(threadId) {
  const nextThreadId = String(threadId || '');
  if (!nextThreadId) return;
  if (String(state.activeThreadId || '') === nextThreadId) {
    syncThreadQueryParam(nextThreadId);
    restoreComposerDraft(nextThreadId);
    return;
  }
  saveComposerDraft();
  state.activeThreadId = nextThreadId;
  syncThreadQueryParam(nextThreadId);
  restoreComposerDraft(nextThreadId);
  if (state.bookingBridgeOpen) {
    refreshBookingBridgeContext({ forceReload: true }).catch(() => null);
  }
}

function render() {
  renderSession();
  renderThreads();
  renderMessages();
  renderAccounts();
  renderBookingBridgeControls();
  renderIntegration();
  renderTagPicker();
  renderQuickMessages();
  renderReplyPreview();
  renderAttachmentPreview();
  renderSocialPanels();
  renderRbacPanel();
  renderAiAutomationPanel();
  renderThreadMemoryPanel();
  applyRoleBasedUi();
}

function renderBookingBridgeControls() {
  const visible = Boolean(currentThread()) && isCurrentAccountChiHome();
  els.btnBookingBridge?.classList.toggle('hidden', !visible);
  if (els.btnBookingBridge) els.btnBookingBridge.disabled = state.bookingBridgeLoading || !visible;
  if (!visible && state.bookingBridgeOpen) closeBookingBridgeModal({ preserveState: false });
}

async function openBookingBridgeModal() {
  const thread = currentThread();
  if (!thread || !isCurrentAccountChiHome()) return;
  state.bookingBridgeOpen = true;
  els.bookingBridgeModal?.classList.remove('hidden');
  await refreshBookingBridgeContext({ forceReload: true });
}

function closeBookingBridgeModal() {
  state.bookingBridgeOpen = false;
  els.bookingBridgeModal?.classList.add('hidden');
  state.bookingBridgeUrl = '';
  state.bookingBridgeContextKey = '';
  if (els.bookingBridgeFrame) els.bookingBridgeFrame.src = 'about:blank';
}

async function refreshBookingBridgeContext(options = {}) {
  if (!state.bookingBridgeOpen) return;
  const thread = currentThread();
  const accountId = currentActiveAccountId();
  const contextKey = currentBookingBridgeContextKey(thread?.id);
  if (!thread || !accountId || !contextKey) return;
  if (!options.forceReload && state.bookingBridgeContextKey === contextKey) {
    if (state.bookingBridgeLoading) return;
    if (state.bookingBridgeUrl && els.bookingBridgeFrame?.src === state.bookingBridgeUrl) return;
  }
  state.bookingBridgeContextKey = contextKey;
  state.bookingBridgeLoading = true;
  if (els.btnBookingBridge) els.btnBookingBridge.disabled = true;
  if (els.bookingBridgeStatus) els.bookingBridgeStatus.textContent = `Đang mở form cho thread ${thread.id}...`;
  try {
    const res = await getJson(`/api/chihomehotel/booking-bridge?threadId=${encodeURIComponent(thread.id)}&accountId=${encodeURIComponent(accountId)}`);
    state.bookingBridgeUrl = String(res.url || '').trim();
    state.bookingBridgeContextKey = contextKey;
    if (els.bookingBridgeFrame && state.bookingBridgeUrl) els.bookingBridgeFrame.src = state.bookingBridgeUrl;
    if (els.bookingBridgeStatus) els.bookingBridgeStatus.textContent = `Thread ${thread.id} · account ${accountId}`;
  } catch (error) {
    if (els.bookingBridgeStatus) els.bookingBridgeStatus.textContent = error.message || 'Không mở được form đặt phòng.';
    showAppNotice(error.message || 'Không mở được form đặt phòng ChiHome.', 'danger');
  } finally {
    state.bookingBridgeLoading = false;
    if (els.btnBookingBridge) els.btnBookingBridge.disabled = !Boolean(currentThread()) || !isCurrentAccountChiHome();
  }
}

function handleBookingBridgeMessage(event) {
  const type = String(event?.data?.type || '');
  if (!type.startsWith('chihomehotel-booking-')) return;
  if (type === 'chihomehotel-booking-close') {
    closeBookingBridgeModal();
    return;
  }
  if (type === 'chihomehotel-booking-created') {
    closeBookingBridgeModal({ preserveState: false });
    showAppNotice('Đã đồng bộ booking sang chihomehotel.', 'warning');
  }
}

function renderAccounts() {
  const accounts = state.view?.accounts || [];
  const active = state.view?.activeAccountId || '';
  els.accountSelect.innerHTML = accounts.map((item) => {
    const label = formatAccountOptionLabel(item);
    return `<option value="${escapeAttribute(item.id)}" ${String(item.id) === String(active) ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  if (!accounts.length) {
    els.accountSelect.innerHTML = '<option value="">Chưa có account</option>';
  }
  if (els.btnZaloAccountLogout) {
    els.btnZaloAccountLogout.disabled = !active || state.isSwitchingAccount;
    els.btnZaloAccountLogout.textContent = accounts.length > 1 ? 'Đăng xuất account đang chọn' : 'Đăng xuất account Zalo';
  }
}

function formatAccountOptionLabel(account) {
  const baseLabel = account?.displayName || account?.userId || account?.id || 'Không rõ account';
  const roles = Array.isArray(state.view?.portal?.me?.roles) ? state.view.portal.me.roles : [];
  if (!roles.includes('admin') && !roles.includes('manager')) return baseLabel;
  const deptNames = getAccountDepartmentNames(account?.id || account?.userId || '');
  if (!deptNames.length) return `${baseLabel} (chưa có bộ phận)`;
  return `${baseLabel} — ${deptNames.join(', ')}`;
}

function getDepartmentMap() {
  const departments = Array.isArray(state.rbac?.catalog?.portal?.departments) ? state.rbac.catalog.portal.departments : [];
  return new Map(departments.map((item) => [String(item.id), item]));
}

function getPortalChannels() {
  return Array.isArray(state.rbac?.catalog?.portal?.channels) ? state.rbac.catalog.portal.channels : [];
}

function getAccountChannel(accountId) {
  const targetId = String(accountId || '').trim();
  if (!targetId) return null;
  return getPortalChannels().find((channel) => {
    const candidateIds = [channel?.accountId, channel?.code, channel?.id].map((value) => String(value || '').trim()).filter(Boolean);
    return candidateIds.includes(targetId);
  }) || null;
}

function getAccountDepartmentNames(accountId) {
  const channel = getAccountChannel(accountId);
  if (!channel?.departmentId) return [];
  const department = getDepartmentMap().get(String(channel.departmentId));
  return [department?.name || channel.departmentId].filter(Boolean);
}

function formatAccountDepartmentLabel(account) {
  const accountId = String(account?.id || account?.userId || '').trim();
  const deptNames = getAccountDepartmentNames(accountId);
  return deptNames.length ? deptNames.join(', ') : 'chưa có bộ phận';
}

function enhanceUtilityPanels() {
  const panels = els.utilityView?.querySelectorAll('.utility-panel');
  if (!panels?.length) return;
  panels.forEach((panel, index) => {
    if (panel.dataset.collapsibleReady === '1') return;
    const titleRow = panel.querySelector('.panel-title-row');
    if (!titleRow) return;
    const panelId = panel.id || `utility-panel-${index + 1}`;
    panel.dataset.collapsibleReady = '1';
    panel.dataset.panelId = panelId;
    panel.classList.add('utility-collapsible');

    const body = document.createElement('div');
    body.className = 'utility-panel-body collapsed';
    body.dataset.bodyFor = panelId;

    const movableChildren = [...panel.children].filter((child) => child !== titleRow);
    movableChildren.forEach((child) => body.appendChild(child));
    panel.appendChild(body);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ghost-btn utility-panel-toggle';
    toggle.dataset.toggleFor = panelId;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '▾';
    titleRow.appendChild(toggle);

    titleRow.classList.add('utility-panel-header');
    titleRow.addEventListener('click', (event) => {
      const target = event.target;
      if (target.closest('a, button, input, select, textarea, label')) {
        if (target === toggle || target.closest('.utility-panel-toggle')) {
          event.preventDefault();
          toggleUtilityPanel(panelId);
        }
        return;
      }
      toggleUtilityPanel(panelId);
    });
  });
}

function toggleUtilityPanel(panelId) {
  const panel = els.utilityView?.querySelector(`[data-panel-id="${CSS.escape(panelId)}"]`);
  const body = panel?.querySelector('.utility-panel-body');
  const toggle = panel?.querySelector('.utility-panel-toggle');
  if (!panel || !body || !toggle) return;
  const collapsed = body.classList.contains('collapsed');
  body.classList.toggle('collapsed', !collapsed);
  panel.classList.toggle('is-open', collapsed);
  toggle.setAttribute('aria-expanded', String(collapsed));
  toggle.textContent = collapsed ? '▴' : '▾';
}

function renderIntegration() {
  const integration = state.view?.integration || {};
  if (els.webhookUrlInput) els.webhookUrlInput.value = integration.webhookUrl || '';
  if (els.webhookSecretInput) els.webhookSecretInput.value = integration.webhookSecret || '';
  if (els.webhookEnabledInput) els.webhookEnabledInput.checked = Boolean(integration.enabled);
  if (els.webhookAccountIds) {
    els.webhookAccountIds.value = Array.isArray(integration.selectedAccountIds) ? integration.selectedAccountIds.join(',') : '';
  }
  renderWebhookAccountPicker();
  if (els.webhookStatus) {
    const parts = [];
    if (integration.enabled && integration.webhookUrl) parts.push('Đang bật webhook n8n.');
    const selectedCount = Array.isArray(integration.selectedAccountIds) ? integration.selectedAccountIds.length : 0;
    if (selectedCount) parts.push(`Đang cho phép ${selectedCount} acc Zalo gửi webhook.`);
    if (integration.lastDeliveryAt) parts.push(`Lần gửi cuối: ${formatTime(integration.lastDeliveryAt)}`);
    if (integration.lastDeliveryError) parts.push(`Lỗi gần nhất: ${integration.lastDeliveryError}`);
    els.webhookStatus.textContent = parts.join(' ') || 'Chưa cấu hình webhook n8n.';
  }
}

function renderWebhookAccountPicker() {
  if (!els.webhookAccountPicker) return;
  const accounts = state.view?.accounts || [];
  const selected = new Set(csvList(els.webhookAccountIds?.value));
  if (!accounts.length) {
    els.webhookAccountPicker.textContent = 'Chưa có account Zalo nào đang login trên server.';
    return;
  }
  els.webhookAccountPicker.innerHTML = accounts.map((item) => {
    const accountId = String(item.id || '');
    const label = item.displayName || item.userId || item.id;
    const connected = String(item.status || '').toLowerCase() === 'connected';
    const isSelected = selected.has(accountId);
    return `
      <label class="rbac-account-option">
        <input type="checkbox" data-webhook-account-id="${escapeAttribute(accountId)}" ${isSelected ? 'checked' : ''} />
        <span>
          ${escapeHtml(label)}
          <small>${escapeHtml(accountId)}</small>
          <small>${connected ? '🟢 Connected' : '🔴 Disconnected'} · ${isSelected ? '✅ Đã chọn' : '⬜ Chưa chọn'}</small>
        </span>
      </label>
    `;
  }).join('');
}

function syncSelectedWebhookAccounts() {
  if (!els.webhookAccountPicker || !els.webhookAccountIds) return;
  const selected = [...els.webhookAccountPicker.querySelectorAll('[data-webhook-account-id]:checked')]
    .map((input) => input.dataset.webhookAccountId)
    .filter(Boolean);
  els.webhookAccountIds.value = selected.join(',');
  renderWebhookAccountPicker();
}

function getVisibleAiDepartments() {
  const fromView = Array.isArray(state.view?.portal?.departments) ? state.view.portal.departments : [];
  return fromView.filter(Boolean);
}

function getDefaultAiDepartmentId() {
  const departments = getVisibleAiDepartments();
  const activeAccountId = currentActiveAccountId();
  const activeChannel = (state.view?.portal?.channels || []).find((item) => String(item.accountId || '') === String(activeAccountId || ''));
  const preferred = String(activeChannel?.departmentId || '').trim();
  if (preferred && departments.some((item) => String(item.id) === preferred)) return preferred;
  return departments[0]?.id || null;
}

function getSelectedAiDepartmentId() {
  const departments = getVisibleAiDepartments();
  const current = String(state.selectedAiDepartmentId || '').trim();
  if (current && departments.some((item) => String(item.id) === current)) return current;
  const fallback = getDefaultAiDepartmentId();
  state.selectedAiDepartmentId = fallback;
  return fallback;
}

function getAiAutomationConfigMap() {
  return state.view?.aiAutomationByDepartment || {};
}

function getSelectedAiAutomationConfig() {
  const departmentId = getSelectedAiDepartmentId();
  const departmentConfig = departmentId ? getAiAutomationConfigMap()[String(departmentId)] : null;
  return departmentConfig || state.view?.aiAutomation || {};
}

function renderAiDepartmentPicker() {
  if (!els.aiDepartmentSelect) return;
  const departments = getVisibleAiDepartments();
  const selected = getSelectedAiDepartmentId();
  els.aiDepartmentSelect.innerHTML = departments.map((dept) => `<option value="${escapeAttribute(dept.id)}" ${String(dept.id) === String(selected || '') ? 'selected' : ''}>${escapeHtml(dept.name || dept.code || dept.id)}</option>`).join('');
  if (els.aiDepartmentHint) {
    const active = departments.find((item) => String(item.id) === String(selected || ''));
    els.aiDepartmentHint.textContent = active
      ? `Đang chỉnh automation riêng cho bộ phận: ${active.name || active.code || active.id}`
      : 'Mỗi bộ phận có workflow và knowledge riêng.';
  }
}

function renderAiAutomationPanel() {
  renderAiDepartmentPicker();
  const cfg = getSelectedAiAutomationConfig();
  const selectedDepartmentId = getSelectedAiDepartmentId();
  const modeLabel = cfg.enabled ? (cfg.mode || 'assistive') : 'disabled';
  const usageState = state.view?.aiAutomationUsage || {};
  const usageBucket = usageState.byDepartment?.[String(selectedDepartmentId || 'global')] || usageState.totals || {};
  const summaryCards = [
    { label: 'Bộ phận', value: selectedDepartmentId || 'global' },
    { label: 'Trạng thái', value: modeLabel },
    { label: 'Thread mặc định', value: cfg.defaultThreadMode || 'off' },
    { label: 'Agents', value: `${(cfg.agentRegistry || []).length}` },
    { label: 'Knowledge docs', value: `${(cfg.knowledgeDocuments || []).length}` },
    { label: 'Flows', value: `${(cfg.flowDefinitions || []).length}` },
    { label: 'Model sẵn sàng', value: `${(cfg.modelCatalog || []).length}` },
    { label: 'Tokens đã tốn', value: `${Number(usageBucket.totalTokens || 0).toLocaleString('vi-VN')}` },
    { label: 'Chi phí tạm tính', value: `$${Number(usageBucket.costUsd || 0).toFixed(4)}` }
  ];
  if (els.aiAutomationSummary) {
    els.aiAutomationSummary.innerHTML = summaryCards.map((item) => `
      <article class="ai-summary-card">
        <div class="ai-summary-label">${escapeHtml(item.label)}</div>
        <div class="ai-summary-value">${escapeHtml(item.value)}</div>
      </article>
    `).join('');
  }
  if (els.aiEnabledMode) els.aiEnabledMode.value = cfg.enabled ? (cfg.mode || 'assistive') : 'disabled';
  if (els.aiDefaultThreadMode) els.aiDefaultThreadMode.value = cfg.defaultThreadMode || 'off';
  if (els.aiProviderPrimary) els.aiProviderPrimary.value = cfg.providerRouting?.primary || 'openrouter';
  if (els.aiProviderFallback) els.aiProviderFallback.value = cfg.providerRouting?.fallback || 'openrouter';
  if (els.aiAdminAlertUsers) els.aiAdminAlertUsers.value = (cfg.adminAlertUserIds || []).join(',');
  if (els.aiAllowedDepartments) els.aiAllowedDepartments.value = (cfg.allowedDepartments || []).join(',');
  if (els.aiSelectedAccountIds) els.aiSelectedAccountIds.value = (cfg.selectedAccountIds || []).join(',');
  if (els.aiModelClassify) els.aiModelClassify.value = cfg.modelRouter?.classify || 'small';
  if (els.aiModelRetrieve) els.aiModelRetrieve.value = cfg.modelRouter?.retrieve || 'small';
  if (els.aiModelComposeSimple) els.aiModelComposeSimple.value = cfg.modelRouter?.composeSimple || 'small';
  if (els.aiModelComposeStructured) els.aiModelComposeStructured.value = cfg.modelRouter?.composeStructured || 'medium';
  if (els.aiModelComplaint) els.aiModelComplaint.value = cfg.modelRouter?.complaint || 'large';
  if (els.aiModelFallback) els.aiModelFallback.value = cfg.modelRouter?.fallback || 'medium';
  if (els.aiMaxAutoTurns) els.aiMaxAutoTurns.value = cfg.orchestration?.maxAutoTurns ?? 4;
  if (els.aiMaxToolCalls) els.aiMaxToolCalls.value = cfg.orchestration?.maxToolCallsPerTurn ?? 3;
  if (els.aiLowConfidenceThreshold) els.aiLowConfidenceThreshold.value = cfg.escalation?.lowConfidenceThreshold ?? 0.72;
  if (els.aiComplexThreshold) els.aiComplexThreshold.value = cfg.escalation?.complexIntentThreshold ?? 0.82;
  if (els.aiRepeatThreshold) els.aiRepeatThreshold.value = cfg.escalation?.repeatQuestionThreshold ?? 2;
  if (els.aiSnoozePresets) els.aiSnoozePresets.value = (cfg.threadControls?.snoozePresetsMinutes || []).join(',');
  if (els.aiComplaintKeywords) els.aiComplaintKeywords.value = (cfg.escalation?.complaintKeywords || []).join('\n');
  if (els.aiSystemPrompt) els.aiSystemPrompt.value = cfg.systemPrompt || '';
  if (els.aiReplyStylePrompt) els.aiReplyStylePrompt.value = cfg.replyStylePrompt || '';
  if (els.aiHumanHandoffPrompt) els.aiHumanHandoffPrompt.value = cfg.humanHandoffPrompt || '';
  if (els.aiKnowledgeSources) els.aiKnowledgeSources.value = prettyJson(cfg.knowledgeSources || []);
  if (els.aiFlowDefinitions) els.aiFlowDefinitions.value = prettyJson(cfg.flowDefinitions || []);
  if (els.aiPromptLibrary) els.aiPromptLibrary.value = prettyJson(cfg.promptLibrary || []);
  if (els.aiAutomationRules) els.aiAutomationRules.value = prettyJson(cfg.automationRules || []);
  if (els.aiAgentRegistry) els.aiAgentRegistry.value = prettyJson(cfg.agentRegistry || []);
  if (els.aiDelegationRules) els.aiDelegationRules.value = prettyJson(cfg.delegationRules || []);
  if (els.aiModelCatalog) els.aiModelCatalog.value = prettyJson(cfg.modelCatalog || []);
  if (els.aiEmbeddingCatalog) els.aiEmbeddingCatalog.value = prettyJson(cfg.embeddingCatalog || []);
  if (els.aiVectorStores) els.aiVectorStores.value = prettyJson(cfg.vectorStores || []);
  renderAiRoutingBoard(cfg);
  renderAiExecutionBoard(cfg, usageState, usageBucket);
  renderAiAccountPicker(cfg);
  renderAgentSystemDbBoard();
  loadAgentSystemAgents().catch(() => null);
  renderModelCatalogBoard(cfg.modelCatalog || [], cfg.embeddingCatalog || []);
  renderKnowledgeLibrary(cfg.knowledgeDocuments || []);
  renderThreadAutomationControls();
}

function renderAiAccountPicker(cfg = {}) {
  if (!els.aiAccountPicker) return;
  const accounts = state.view?.accounts || [];
  const selected = new Set(csvList(els.aiSelectedAccountIds?.value || (cfg.selectedAccountIds || []).join(',')));
  if (!accounts.length) {
    els.aiAccountPicker.textContent = 'Chưa có account Zalo nào đang login trên server.';
    return;
  }
  els.aiAccountPicker.innerHTML = accounts.map((item) => {
    const accountId = String(item.id || item.userId || '').trim();
    const label = item.displayName || item.zaloName || item.userId || item.id || 'Account Zalo';
    const connected = String(item.status || '').toLowerCase() === 'connected';
    const checked = selected.has(accountId);
    return `
      <label class="rbac-account-option">
        <input type="checkbox" data-ai-account-id="${escapeAttribute(accountId)}" ${checked ? 'checked' : ''} />
        <span>
          ${escapeHtml(label)}
          <small>${escapeHtml(accountId)}</small>
          <small>${connected ? '🟢 Connected' : '🔴 Disconnected'} · ${checked ? '✅ Được phép dùng AI' : '⬜ Không dùng AI'}</small>
        </span>
      </label>
    `;
  }).join('');
}

function syncSelectedAiAccounts() {
  if (!els.aiAccountPicker || !els.aiSelectedAccountIds) return;
  const selected = [...els.aiAccountPicker.querySelectorAll('[data-ai-account-id]:checked')]
    .map((input) => input.dataset.aiAccountId)
    .filter(Boolean);
  els.aiSelectedAccountIds.value = selected.join(',');
  renderAiAccountPicker(getSelectedAiAutomationConfig());
}

function renderAiRoutingBoard(cfg = {}) {
  if (!els.aiRoutingBoard) return;
  const modelRouter = cfg.modelRouter || {};
  const rows = [
    { label: 'Tin đơn giản / classify', tier: modelRouter.classify || 'small', note: 'ưu tiên rẻ, phản hồi nhanh' },
    { label: 'RAG / retrieval / live data', tier: modelRouter.retrieve || 'small', note: 'gom facts trước khi trả lời' },
    { label: 'Compose thường', tier: modelRouter.composeSimple || 'small', note: 'FAQ và câu trả lời ngắn' },
    { label: 'Compose có cấu trúc / có file', tier: modelRouter.composeStructured || 'medium', note: 'ca có nhiều điều kiện hoặc attachment' },
    { label: 'Complaint / escalation', tier: modelRouter.complaint || 'large', note: 'ưu tiên chắc chắn hơn chi phí' },
    { label: 'Fallback', tier: modelRouter.fallback || 'medium', note: 'khi confidence thấp hoặc tín hiệu xấu' }
  ];
  els.aiRoutingBoard.innerHTML = `
    <div class="ai-overview-title-row">
      <div>
        <strong>Routing playbook</strong>
        <div class="muted small-note">Hệ sẽ đổi tier/model theo từng tin nhắn, không cố định một model cho toàn bộ luồng.</div>
      </div>
    </div>
    <div class="ai-playbook-list top-gap-sm">
      ${rows.map((item) => `
        <article class="ai-playbook-item">
          <div>
            <strong>${escapeHtml(item.label)}</strong>
            <div class="muted small-note">${escapeHtml(item.note)}</div>
          </div>
          <span class="mini-chip ai-tier-chip ai-tier-${escapeAttribute(String(item.tier || 'small'))}">${escapeHtml(String(item.tier || 'small').toUpperCase())}</span>
        </article>
      `).join('')}
    </div>
  `;
}

function renderAiExecutionBoard(cfg = {}, usageState = {}, usageBucket = {}) {
  if (!els.aiExecutionBoard) return;
  const modeLabel = cfg.enabled ? (cfg.mode || 'assistive') : 'disabled';
  const providerStatus = usageState.providerStatus || {};
  const lines = [
    `Mode hiện tại: ${modeLabel}`,
    `Provider chính: ${cfg.providerRouting?.primary || 'openrouter'}`,
    `Fallback: ${cfg.providerRouting?.fallback || 'openrouter'}`,
    `Provider ready: ${providerStatus.ready ? 'có' : 'chưa'}`,
    `Lỗi provider gần nhất: ${providerStatus.lastError || providerStatus.reason || 'không có'}`,
    `Requests: ${Number(usageBucket.requests || 0).toLocaleString('vi-VN')}`,
    `Prompt tokens: ${Number(usageBucket.promptTokens || 0).toLocaleString('vi-VN')}`,
    `Completion tokens: ${Number(usageBucket.completionTokens || 0).toLocaleString('vi-VN')}`,
    `Chi phí USD: $${Number(usageBucket.costUsd || 0).toFixed(4)}`,
    `Snooze preset: ${(cfg.threadControls?.snoozePresetsMinutes || []).join(', ') || 'chưa đặt'} phút`,
    `Escalation khi confidence < ${cfg.escalation?.lowConfidenceThreshold ?? 0.72}`
  ];
  els.aiExecutionBoard.innerHTML = `
    <div class="ai-overview-title-row">
      <div>
        <strong>Checklist vận hành</strong>
        <div class="muted small-note">Thứ tự chỉnh hợp lý cho admin.</div>
      </div>
    </div>
    <ol class="ai-checklist top-gap-sm">
      <li>Bật chế độ toàn cục phù hợp: tắt / assistive / autonomous.</li>
      <li>Chọn thread mặc định và bộ phận được phép dùng AI.</li>
      <li>Rà playbook routing để đảm bảo small → medium → large đúng ý.</li>
      <li>Nếu cần sâu hơn, mở các khối JSON nâng cao bên dưới.</li>
    </ol>
    <div class="ai-inline-facts top-gap-sm">
      ${lines.map((item) => `<span class="mini-chip">${escapeHtml(item)}</span>`).join('')}
    </div>
  `;
}

function renderAgentSystemDbBoard() {
  if (!els.aiAgentSystemDbBoard) return;
  if (state.agentSystem.loading) {
    els.aiAgentSystemDbBoard.textContent = 'Đang tải Agent System DB...';
    return;
  }
  const items = Array.isArray(state.agentSystem.items) ? state.agentSystem.items : [];
  if (!items.length) {
    els.aiAgentSystemDbBoard.innerHTML = '<div class="muted">Chưa có agent trong SQLite Agent System DB.</div>';
    return;
  }
  const sortedItems = [...items].sort((a, b) => {
    const aMain = isMainAgent(a) ? 0 : 1;
    const bMain = isMainAgent(b) ? 0 : 1;
    return aMain - bMain || String(a.name || a.id || '').localeCompare(String(b.name || b.id || ''), 'vi');
  });
  els.aiAgentSystemDbBoard.innerHTML = `
    <div class="ai-card-grid ai-agent-db-grid">
      ${sortedItems.map((item) => {
        const mainAgent = isMainAgent(item);
        return `
        <article class="ai-mini-card ai-agent-db-card ${mainAgent ? 'ai-agent-main-card' : ''}" data-agent-db-card="${escapeAttribute(item.id)}">
          <div class="panel-title-row">
            <div>
              <div class="row-gap">
                <strong>${escapeHtml(item.name || item.id)}</strong>
                ${mainAgent ? '<span class="mini-chip ai-main-agent-chip">Agent chính</span>' : '<span class="mini-chip">Agent phụ</span>'}
              </div>
              <div class="small-note">${escapeHtml(item.id)} · ${escapeHtml(item.role || 'role chưa đặt')}</div>
              ${mainAgent ? '<div class="muted small-note">Đây là prompt điều phối chính trước khi gọi các agent/tools khác.</div>' : ''}
            </div>
            <button class="secondary-btn" type="button" data-agent-save="${escapeAttribute(item.id)}">Lưu prompt</button>
          </div>
          <label class="top-gap-sm">
            <span>${mainAgent ? 'Prompt agent chính / system_instruction' : 'system_instruction'}</span>
            <textarea class="mono-input" rows="${mainAgent ? 10 : 8}" data-agent-instruction="${escapeAttribute(item.id)}">${escapeHtml(item.system_instruction || '')}</textarea>
          </label>
        </article>`;
      }).join('')}
    </div>
  `;
}

function isMainAgent(item = {}) {
  return String(item?.id || '').trim() === 'orchestrator';
}

async function loadAgentSystemAgents({ force = false } = {}) {
  if (!els.aiAgentSystemDbBoard) return;
  if (state.agentSystem.loading) return;
  if (!force && state.agentSystem.loadedAt && Date.now() - state.agentSystem.loadedAt < 30000) return;
  state.agentSystem.loading = true;
  renderAgentSystemDbBoard();
  try {
    const res = await getJson('/api/agents');
    state.agentSystem.items = Array.isArray(res.items) ? res.items : [];
    state.agentSystem.loadedAt = Date.now();
  } catch (error) {
    els.aiAgentSystemDbBoard.innerHTML = `<div class="muted">${escapeHtml(error.message || 'Tải Agent System DB thất bại.')}</div>`;
  } finally {
    state.agentSystem.loading = false;
    renderAgentSystemDbBoard();
  }
}

async function handleAgentSystemBoardClick(event) {
  const button = event.target.closest('[data-agent-save]');
  if (!button) return;
  const agentId = button.dataset.agentSave || '';
  const input = els.aiAgentSystemDbBoard?.querySelector(`[data-agent-instruction="${cssEscape(agentId)}"]`);
  if (!input) return;
  button.disabled = true;
  try {
    const res = await fetchJson(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction: input.value }),
      credentials: 'same-origin'
    });
    state.agentSystem.items = state.agentSystem.items.map((item) => String(item.id) === String(agentId) ? (res.item || item) : item);
    showAppNotice(`Đã lưu prompt agent ${agentId}.`, 'success');
    renderAgentSystemDbBoard();
  } catch (error) {
    showAppNotice(error.message || 'Lưu prompt agent thất bại.', 'danger');
  } finally {
    button.disabled = false;
  }
}

function cssEscape(value = '') {
  if (window.CSS?.escape) return window.CSS.escape(String(value || ''));
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function renderModelCatalogBoard(models, embeddings) {
  if (!els.aiModelCatalogBoard) return;
  els.aiModelCatalogBoard.innerHTML = `
    <div class="ai-card-grid">
      ${(models || []).map((item) => `
        <article class="ai-mini-card">
          <div class="panel-title-row">
            <strong>${escapeHtml(item.label || item.id || 'model')}</strong>
            <span class="mini-chip ai-tier-chip ai-tier-${escapeAttribute(item.tier || 'small')}">${escapeHtml(String(item.tier || '-').toUpperCase())}</span>
          </div>
          <div class="small-note">${escapeHtml(item.provider || 'provider?')} · ${escapeHtml(item.kind || 'chat')}</div>
          <div class="muted small-note top-gap-sm">${escapeHtml((item.useCases || []).join(', ') || 'Chưa có use case')}</div>
          <div class="ai-inline-facts top-gap-sm">
            ${item.promptPricePer1M != null ? `<span class="mini-chip">in $${escapeHtml(String(item.promptPricePer1M))}/1M</span>` : ''}
            ${item.completionPricePer1M != null ? `<span class="mini-chip">out $${escapeHtml(String(item.completionPricePer1M))}/1M</span>` : ''}
            ${item.contextLength ? `<span class="mini-chip">ctx ${escapeHtml(shortNumber(item.contextLength))}</span>` : ''}
          </div>
        </article>
      `).join('')}
      ${(embeddings || []).map((item) => `
        <article class="ai-mini-card soft">
          <strong>${escapeHtml(item.label || item.id || 'embedding')}</strong>
          <div class="small-note">dimension ${escapeHtml(String(item.dimensions || '?'))}</div>
          <div class="ai-inline-facts top-gap-sm">
            ${Array.isArray(item.supportedDimensions) ? `<span class="mini-chip">dims ${escapeHtml(item.supportedDimensions.join(' / '))}</span>` : ''}
            ${item.promptPricePer1M != null ? `<span class="mini-chip">$${escapeHtml(String(item.promptPricePer1M))}/1M</span>` : ''}
          </div>
          <div class="muted small-note top-gap-sm">${escapeHtml(item.verifiedSource || item.status || '')}</div>
        </article>
      `).join('')}
    </div>
  `;
}

function renderKnowledgeLibrary(items) {
  if (!els.aiKnowledgeLibrary) return;
  if (!items.length) {
    els.aiKnowledgeLibrary.innerHTML = '<div class="muted">Chưa có tài liệu. Bấm “Thêm tài liệu cho AI” để nạp txt/csv/xlsx/json.</div>';
    return;
  }
  els.aiKnowledgeLibrary.innerHTML = items.map((item) => `
    <article class="knowledge-doc-card">
      <div class="panel-title-row">
        <div>
          <strong>${escapeHtml(item.name || item.id || 'document')}</strong>
          <div class="small-note">${escapeHtml(item.ingestMode || item.target || 'rag')} · ${escapeHtml(item.status || 'unknown')} · ${escapeHtml(formatBytes(item.size || 0))}</div>
        </div>
        <button class="ghost-btn" type="button" data-role="delete-knowledge-doc" data-document-id="${escapeAttribute(item.id || '')}">Xoá</button>
      </div>
      <div class="row-gap top-gap-sm">
        ${(item.tags || []).map((tag) => `<span class="mini-chip">#${escapeHtml(tag)}</span>`).join('')}
      </div>
      ${item.summary ? `<div class="muted small-note top-gap-sm">${escapeHtml(item.summary)}</div>` : ''}
      ${item.previewText ? `<pre class="knowledge-preview">${escapeHtml(item.previewText)}</pre>` : ''}
    </article>
  `).join('');
  for (const button of els.aiKnowledgeLibrary.querySelectorAll('[data-role="delete-knowledge-doc"]')) {
    button.addEventListener('click', () => deleteKnowledgeDocument(button.dataset.documentId));
  }
}


function renderThreadMemoryPanel() {
  const thread = currentThread();
  const accountId = currentActiveAccountId();
  if (els.threadMemoryPanel) els.threadMemoryPanel.classList.toggle('hidden', !thread);
  if (!thread) {
    resetThreadMemoryState();
    if (els.threadMemoryCount) els.threadMemoryCount.textContent = '0 mục';
    if (els.threadMemoryHint) els.threadMemoryHint.textContent = 'Chọn một hội thoại để xem memory AI.';
    if (els.threadMemoryTable) els.threadMemoryTable.textContent = 'Chưa chọn hội thoại.';
    return;
  }
  ensureThreadMemoryScope(thread.id, accountId);
  if (!state.threadMemory.loading) syncThreadMemoryRowsFromThread(thread);
  const rows = Array.isArray(state.threadMemory.rows) ? state.threadMemory.rows : [];
  const selectedCount = state.threadMemory.selectedIds?.size || 0;
  if (els.threadMemoryCount) els.threadMemoryCount.textContent = `${rows.length} mục`;
  if (els.threadMemoryHint) {
    els.threadMemoryHint.textContent = state.threadMemory.loading
      ? 'Đang tải memory AI...'
      : rows.length
        ? `Đang xem memory của hội thoại này${state.threadMemory.loadedAt ? ` · tải lúc ${formatTimeOnly(state.threadMemory.loadedAt)}` : ''}.`
        : 'Chưa có memory AI hoặc chưa tải dữ liệu.';
  }
  if (els.btnThreadMemoryRefresh) els.btnThreadMemoryRefresh.disabled = state.threadMemory.loading;
  if (els.btnThreadMemoryDelete) {
    els.btnThreadMemoryDelete.disabled = state.threadMemory.loading || selectedCount === 0;
    els.btnThreadMemoryDelete.textContent = selectedCount ? `Xoá ${selectedCount} mục đã chọn` : 'Xoá mục đã chọn';
  }
  if (!els.threadMemoryTable) return;
  if (state.threadMemory.loading) {
    els.threadMemoryTable.innerHTML = '<div class="muted small-note">Đang tải memory...</div>';
    return;
  }
  if (!rows.length) {
    els.threadMemoryTable.innerHTML = '<div class="muted small-note">Chưa có memory nào cho hội thoại này.</div>';
    return;
  }
  els.threadMemoryTable.innerHTML = `
    <div class="memory-data-table" role="table" aria-label="Memory AI">
      <div class="memory-data-row memory-data-head" role="row">
        <div role="columnheader">Chọn</div>
        <div role="columnheader">Loại</div>
        <div role="columnheader">Agent</div>
        <div role="columnheader">Intent</div>
        <div role="columnheader">Nội dung</div>
        <div role="columnheader">Thời gian</div>
      </div>
      ${rows.map((row) => renderThreadMemoryRow(row)).join('')}
    </div>
  `;
  for (const checkbox of els.threadMemoryTable.querySelectorAll('[data-role="thread-memory-select"]')) {
    checkbox.addEventListener('change', () => {
      const id = String(checkbox.dataset.rowId || '');
      if (!id) return;
      if (checkbox.checked) state.threadMemory.selectedIds.add(id);
      else state.threadMemory.selectedIds.delete(id);
      renderThreadMemoryPanel();
    });
  }
}

function renderThreadMemoryRow(row = {}) {
  const id = String(row.id || '');
  const checked = state.threadMemory.selectedIds?.has(id) ? ' checked' : '';
  return `
    <div class="memory-data-row" role="row">
      <label class="memory-select-cell"><input type="checkbox" data-role="thread-memory-select" data-row-id="${escapeAttribute(id)}"${checked} /></label>
      <div>${escapeHtml(row.kind || '-')}</div>
      <div>${escapeHtml(row.agentLabel || row.agentId || 'conversation')}</div>
      <div>${escapeHtml(row.intent || '-')}</div>
      <div class="memory-text-cell">${escapeHtml(row.text || '')}</div>
      <div>${escapeHtml(formatDateTime(row.createdAt))}</div>
    </div>
  `;
}

async function loadThreadMemory({ force = false } = {}) {
  const thread = currentThread();
  const accountId = currentActiveAccountId();
  if (!thread || !accountId) return;
  ensureThreadMemoryScope(thread.id, accountId);
  if (!force && state.threadMemory.loadedAt) {
    renderThreadMemoryPanel();
    return;
  }
  state.threadMemory.loading = true;
  renderThreadMemoryPanel();
  try {
    const data = await getJson(`/api/threads/memory?threadId=${encodeURIComponent(thread.id)}&accountId=${encodeURIComponent(accountId)}`);
    ensureThreadMemoryScope(thread.id, accountId);
    state.threadMemory.rows = Array.isArray(data.rows) ? data.rows : [];
    state.threadMemory.selectedIds = new Set([...state.threadMemory.selectedIds].filter((id) => state.threadMemory.rows.some((row) => String(row.id || '') === id)));
    state.threadMemory.loadedAt = new Date().toISOString();
    hideAppNotice();
  } catch (error) {
    showAppNotice(error.message || 'Tải memory AI thất bại.', 'danger');
  } finally {
    state.threadMemory.loading = false;
    renderThreadMemoryPanel();
  }
}

async function deleteSelectedThreadMemoryRows() {
  const thread = currentThread();
  const accountId = currentActiveAccountId();
  const rowIds = [...(state.threadMemory.selectedIds || new Set())];
  if (!thread || !accountId || !rowIds.length) return;
  const ok = window.confirm(`Xoá ${rowIds.length} memory đã chọn khỏi hội thoại này?`);
  if (!ok) return;
  state.threadMemory.loading = true;
  renderThreadMemoryPanel();
  try {
    const data = await post('/api/threads/memory/delete', { threadId: thread.id, accountId, rowIds }, { timeoutMs: 15000 });
    if (data.view) state.view = data.view;
    state.threadMemory.rows = Array.isArray(data.rows) ? data.rows : [];
    state.threadMemory.selectedIds = new Set();
    state.threadMemory.loadedAt = new Date().toISOString();
    showAppNotice('Đã xoá memory AI đã chọn.', 'warning');
    render();
  } catch (error) {
    showAppNotice(error.message || 'Xoá memory AI thất bại.', 'danger');
  } finally {
    state.threadMemory.loading = false;
    renderThreadMemoryPanel();
  }
}

function ensureThreadMemoryScope(threadId, accountId) {
  if (state.threadMemory.threadId === threadId && state.threadMemory.accountId === accountId) return;
  state.threadMemory.threadId = threadId || null;
  state.threadMemory.accountId = accountId || null;
  state.threadMemory.rows = [];
  state.threadMemory.selectedIds = new Set();
  state.threadMemory.loading = false;
  state.threadMemory.loadedAt = null;
}

function resetThreadMemoryState() {
  state.threadMemory.threadId = null;
  state.threadMemory.accountId = null;
  state.threadMemory.rows = [];
  state.threadMemory.selectedIds = new Set();
  state.threadMemory.loading = false;
  state.threadMemory.loadedAt = null;
}

function syncThreadMemoryRowsFromThread(thread = null) {
  const rows = resolveClientThreadMemoryRows(thread?.automation || {});
  state.threadMemory.rows = rows;
  state.threadMemory.selectedIds = new Set([...(state.threadMemory.selectedIds || new Set())].filter((id) => rows.some((row) => String(row.id || '') === id)));
}

function resolveClientThreadMemoryRows(automation = {}) {
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

function formatTimeOnly(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function renderThreadAutomationControls() {
  const thread = currentThread();
  const automation = thread?.automation || {};
  const mode = automation.mode || 'off';
  if (els.threadAutomationMode) els.threadAutomationMode.value = mode;
  if (els.threadAutomationReason) els.threadAutomationReason.value = automation.reason || '';
  if (els.threadAutomationFlowId) els.threadAutomationFlowId.value = automation.assignedFlowId || '';
  if (els.threadAutomationPolicyId) els.threadAutomationPolicyId.value = automation.policyId || '';
  if (els.threadAutomationHours || els.threadAutomationMinutes) {
    const resumeAt = automation.resumeAt ? Date.parse(automation.resumeAt) : NaN;
    const remainingMinutes = Number.isFinite(resumeAt) ? Math.max(1, Math.round((resumeAt - Date.now()) / 60000)) : 0;
    if (els.threadAutomationHours) els.threadAutomationHours.value = mode === 'snoozed' && remainingMinutes ? String(Math.floor(remainingMinutes / 60)) : '';
    if (els.threadAutomationMinutes) els.threadAutomationMinutes.value = mode === 'snoozed' && remainingMinutes ? String(remainingMinutes % 60) : '';
  }
  if (els.threadAutomationStatus) {
    const label = !thread
      ? 'Chưa chọn khách'
      : mode === 'auto'
        ? 'AI đang bật'
        : mode === 'snoozed'
          ? `Tạm dừng · mở lại lúc ${formatDateTime(automation.resumeAt)}`
          : mode === 'human_only'
            ? 'Chỉ người xử lý'
            : mode === 'paused_by_escalation'
              ? 'Đã dừng do escalation'
              : 'Đang tắt';
    els.threadAutomationStatus.textContent = label;
    els.threadAutomationStatus.className = `mini-chip ${threadAutomationStatusClass(mode)}`;
  }
  if (els.threadAutomationHint) {
    els.threadAutomationHint.textContent = !thread
      ? 'Chọn một hội thoại để bật/tắt AI cho đúng khách.'
      : mode === 'auto'
        ? 'AI sẽ trả lời tự động cho thread này.'
        : mode === 'snoozed'
          ? 'AI đang tạm dừng; mỗi lần đặt lại thời gian sẽ reset mốc mở lại từ hiện tại.'
          : mode === 'human_only'
            ? 'Thread này đang khóa về người thật xử lý.'
            : mode === 'paused_by_escalation'
              ? 'AI đã dừng do tín hiệu escalation / rủi ro.'
              : 'Bấm Bật AI để mở khung đặt lịch tạm dừng / mở lại cho khách này.';
  }
  updateThreadAutomationResumePreview(automation.resumeAt || null);
  renderChatAiQuickbar(thread, automation);
}

function renderChatAiQuickbar(thread, automation = {}) {
  const mode = automation.mode || 'off';
  if (els.chatAiQuickbar) els.chatAiQuickbar.classList.toggle('hidden', !thread);
  if (!thread) closeChatAiSnoozeMenu();
  if (els.btnChatAiToggle) {
    els.btnChatAiToggle.disabled = !thread;
    els.btnChatAiToggle.textContent = !thread ? 'AI: Tắt' : mode === 'auto' ? 'AI: Đang bật' : mode === 'snoozed' ? 'AI: Snooze' : mode === 'human_only' ? 'AI: Người xử lý' : mode === 'paused_by_escalation' ? 'AI: Escalation' : 'AI: Tắt';
    els.btnChatAiToggle.className = `ghost-btn chat-ai-toggle ${threadAutomationStatusClass(mode)}`;
  }
  if (els.btnChatAiSnooze) {
    els.btnChatAiSnooze.disabled = !thread;
    els.btnChatAiSnooze.title = mode === 'snoozed' && automation.resumeAt ? `Mở lại ${formatDateTime(automation.resumeAt)}` : 'Chọn giờ mở lại AI';
  }
  if (els.btnChatAiHuman) els.btnChatAiHuman.disabled = !thread;
}

function threadAutomationStatusClass(mode) {
  return mode === 'auto' ? 'status-auto' : mode === 'snoozed' ? 'status-snoozed' : mode === 'paused_by_escalation' ? 'status-escalated' : 'status-off';
}

async function saveAiAutomationConfig() {
  try {
    const payload = collectAiAutomationPayloadFromForm();
    await post('/api/ai-automation/config', payload);
    await reloadState();
    showAppNotice('Đã lưu cấu hình AI automation.', 'warning');
  } catch (error) {
    showAppNotice(error.message || 'Lưu AI automation thất bại.', 'danger');
  }
}

function collectAiAutomationPayloadFromForm() {
  const enabledMode = String(els.aiEnabledMode?.value || 'disabled');
  const existing = getSelectedAiAutomationConfig();
  return {
    departmentId: getSelectedAiDepartmentId(),
    enabled: enabledMode !== 'disabled',
    mode: enabledMode === 'disabled' ? 'assistive' : enabledMode,
    defaultThreadMode: String(els.aiDefaultThreadMode?.value || 'off'),
    allowedDepartments: csvList(els.aiAllowedDepartments?.value),
    selectedAccountIds: csvList(els.aiSelectedAccountIds?.value),
    adminAlertUserIds: csvList(els.aiAdminAlertUsers?.value),
    systemPrompt: els.aiSystemPrompt?.value || '',
    replyStylePrompt: els.aiReplyStylePrompt?.value || '',
    humanHandoffPrompt: els.aiHumanHandoffPrompt?.value || '',
    flowDefinitions: parseJsonTextarea(els.aiFlowDefinitions?.value, 'Flow definitions', existing.flowDefinitions || []),
    promptLibrary: parseJsonTextarea(els.aiPromptLibrary?.value, 'Prompt library', existing.promptLibrary || []),
    automationRules: parseJsonTextarea(els.aiAutomationRules?.value, 'Automation rules', existing.automationRules || []),
    knowledgeSources: parseJsonTextarea(els.aiKnowledgeSources?.value, 'Knowledge sources', existing.knowledgeSources || []),
    agentRegistry: parseJsonTextarea(els.aiAgentRegistry?.value, 'Agent registry', existing.agentRegistry || []),
    delegationRules: parseJsonTextarea(els.aiDelegationRules?.value, 'Delegation rules', existing.delegationRules || []),
    modelCatalog: parseJsonTextarea(els.aiModelCatalog?.value, 'Model catalog', existing.modelCatalog || []),
    embeddingCatalog: parseJsonTextarea(els.aiEmbeddingCatalog?.value, 'Embedding catalog', existing.embeddingCatalog || []),
    vectorStores: parseJsonTextarea(els.aiVectorStores?.value, 'Vector stores', existing.vectorStores || []),
    knowledgeDocuments: existing.knowledgeDocuments || [],
    providerRouting: {
      primary: String(els.aiProviderPrimary?.value || 'openrouter').trim(),
      fallback: String(els.aiProviderFallback?.value || 'openrouter').trim()
    },
    modelRouter: {
      classify: els.aiModelClassify?.value || 'small',
      retrieve: els.aiModelRetrieve?.value || 'small',
      composeSimple: els.aiModelComposeSimple?.value || 'small',
      composeStructured: els.aiModelComposeStructured?.value || 'medium',
      complaint: els.aiModelComplaint?.value || 'large',
      fallback: els.aiModelFallback?.value || 'medium'
    },
    orchestration: {
      maxAutoTurns: Number(els.aiMaxAutoTurns?.value || 4),
      maxToolCallsPerTurn: Number(els.aiMaxToolCalls?.value || 3)
    },
    escalation: {
      complaintKeywords: splitLinesOrCsv(els.aiComplaintKeywords?.value),
      lowConfidenceThreshold: Number(els.aiLowConfidenceThreshold?.value || 0.72),
      complexIntentThreshold: Number(els.aiComplexThreshold?.value || 0.82),
      repeatQuestionThreshold: Number(els.aiRepeatThreshold?.value || 2)
    },
    threadControls: {
      snoozePresetsMinutes: splitLinesOrCsv(els.aiSnoozePresets?.value).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)
    }
  };
}

async function handleKnowledgeFilesPicked(event) {
  const files = [...(event.target.files || [])];
  event.target.value = '';
  if (!files.length) return;
  try {
    validateSelectedFiles(files);
    const mapped = await Promise.all(files.map(readSelectedFile));
    await post('/api/ai-automation/knowledge/upload', {
      departmentId: getSelectedAiDepartmentId(),
      files: mapped,
      target: els.aiKnowledgeUploadTarget?.value || 'rag',
      tags: csvList(els.aiKnowledgeUploadTags?.value)
    }, { timeoutMs: 30000 });
    await reloadState();
    showAppNotice(`Đã nạp ${files.length} tài liệu vào knowledge library.`, 'warning');
  } catch (error) {
    showAppNotice(error.message || 'Nạp tài liệu thất bại.', 'danger');
  }
}

async function deleteKnowledgeDocument(documentId) {
  if (!documentId) return;
  if (!confirm('Xoá tài liệu này khỏi knowledge library?')) return;
  try {
    await post('/api/ai-automation/knowledge/delete', { departmentId: getSelectedAiDepartmentId(), documentId });
    await reloadState();
    showAppNotice('Đã xoá tài liệu khỏi knowledge library.', 'warning');
  } catch (error) {
    showAppNotice(error.message || 'Xoá tài liệu thất bại.', 'danger');
  }
}

async function previewAiPlanForCurrentThread() {
  const thread = currentThread();
  if (!thread) return showAppNotice('Chọn thread trước khi preview AI plan.', 'warning');
  try {
    const latestIncoming = [...(thread.messages || [])].reverse().find((item) => !item.isOutgoing) || thread.messages?.[thread.messages.length - 1] || null;
    const res = await post('/api/ai-automation/plan-preview', {
      threadId: thread.id,
      accountId: currentActiveAccountId(),
      message: latestIncoming ? { text: latestIncoming.text || '' } : { text: '' },
      intent: guessIntentForPreview(latestIncoming?.text || ''),
      confidence: 0.86,
      complexity: guessComplexityForPreview(latestIncoming?.text || ''),
      sentiment: guessSentimentForPreview(latestIncoming?.text || '')
    });
    if (els.aiPlanPreviewOutput) els.aiPlanPreviewOutput.textContent = prettyJson(res.plan || res);
    showAppNotice('Đã chạy preview plan cho thread hiện tại.', 'warning');
  } catch (error) {
    showAppNotice(error.message || 'Preview AI plan thất bại.', 'danger');
  }
}

async function saveThreadAutomation(modeOverride = null, minutesOverride = null) {
  const thread = currentThread();
  if (!thread) return showAppNotice('Chọn khách trước khi lưu automation.', 'warning');
  try {
    const mode = modeOverride || String(els.threadAutomationMode?.value || 'off');
    const parsedHours = Number(els.threadAutomationHours?.value || 0);
    const parsedMinutes = minutesOverride ?? Number(els.threadAutomationMinutes?.value || 0);
    const hours = Number.isFinite(parsedHours) && parsedHours > 0 ? parsedHours : undefined;
    const minutes = Number.isFinite(parsedMinutes) && parsedMinutes >= 0 ? parsedMinutes : undefined;
    await post('/api/threads/automation', {
      threadId: thread.id,
      accountId: currentActiveAccountId(),
      mode,
      hours,
      minutes,
      assignedFlowId: els.threadAutomationFlowId?.value || '',
      policyId: els.threadAutomationPolicyId?.value || '',
      reason: els.threadAutomationReason?.value || ''
    });
    await reloadState();
    showAppNotice('Đã lưu automation cho khách này.', 'warning');
  } catch (error) {
    showAppNotice(error.message || 'Lưu automation thread thất bại.', 'danger');
  }
}

function quickSetThreadAutomation(mode, minutes = null) {
  if (els.threadAutomationMode) els.threadAutomationMode.value = mode;
  if (els.threadAutomationHours) els.threadAutomationHours.value = mode === 'snoozed' ? '0' : '';
  if (els.threadAutomationMinutes) els.threadAutomationMinutes.value = minutes != null ? String(minutes) : '';
  updateThreadAutomationResumePreview();
  void saveThreadAutomation(mode, minutes);
}

function openThreadAutomationEditor(mode = 'auto', options = {}) {
  if (!currentThread()) return showAppNotice('Chọn khách trước khi chỉnh AI automation.', 'warning');
  els.threadDetails?.classList.remove('hidden');
  if (els.threadAutomationDetails) els.threadAutomationDetails.open = true;
  if (els.threadAutomationMode) els.threadAutomationMode.value = mode;
  if (typeof options.hours !== 'undefined' && els.threadAutomationHours) els.threadAutomationHours.value = String(options.hours ?? '');
  if (typeof options.minutes !== 'undefined' && els.threadAutomationMinutes) els.threadAutomationMinutes.value = String(options.minutes ?? '');
  updateThreadAutomationResumePreview();
}

function closeChatAiSnoozeMenu() {
  els.chatAiSnoozeMenu?.classList.add('hidden');
  els.btnChatAiSnooze?.setAttribute('aria-expanded', 'false');
}

function toggleChatAiSnoozeMenu(event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (!currentThread()) return showAppNotice('Chọn khách trước khi hẹn giờ AI.', 'warning');
  const shouldOpen = els.chatAiSnoozeMenu?.classList.contains('hidden') !== false;
  els.chatAiSnoozeMenu?.classList.toggle('hidden', !shouldOpen);
  els.btnChatAiSnooze?.setAttribute('aria-expanded', String(shouldOpen));
}

function handleChatAiSnoozeMenuClick(event) {
  const button = event.target.closest('[data-minutes]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const minutes = Number(button.dataset.minutes || 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  if (els.threadAutomationReason) els.threadAutomationReason.value = `Tạm dừng AI ${minutes} phút từ header hội thoại.`;
  closeChatAiSnoozeMenu();
  quickSetThreadAutomation('snoozed', minutes);
}

function toggleCurrentThreadAutomation() {
  const thread = currentThread();
  if (!thread) return showAppNotice('Chọn khách trước khi bật/tắt AI.', 'warning');
  const automation = thread.automation || {};
  const nextMode = automation.mode === 'auto' ? 'off' : 'auto';
  if (els.threadAutomationReason) {
    els.threadAutomationReason.value = nextMode === 'auto'
      ? 'Bật nhanh AI từ header hội thoại.'
      : 'Tắt nhanh AI từ header hội thoại.';
  }
  closeChatAiSnoozeMenu();
  quickSetThreadAutomation(nextMode);
}

function toggleThreadAutomationForThread(thread, event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (!thread?.id) return;
  state.selectedThreadId = thread.id;
  render();
  const automation = thread.automation || {};
  const nextMode = automation.mode === 'auto' ? 'off' : 'auto';
  closeChatAiSnoozeMenu();
  if (els.threadAutomationReason) {
    els.threadAutomationReason.value = nextMode === 'auto'
      ? 'Bật nhanh AI từ danh sách hội thoại.'
      : 'Tắt nhanh AI từ danh sách hội thoại.';
  }
  quickSetThreadAutomation(nextMode);
}

function updateThreadAutomationResumePreview(existingResumeAt = null) {
  if (!els.threadAutomationResumePreview) return;
  const mode = String(els.threadAutomationMode?.value || 'off');
  if (mode !== 'snoozed') {
    els.threadAutomationResumePreview.value = existingResumeAt ? formatDateTime(existingResumeAt) : 'Bật lại ngay khi lưu';
    return;
  }
  const hours = Number(els.threadAutomationHours?.value || 0);
  const minutes = Number(els.threadAutomationMinutes?.value || 0);
  const totalMinutes = Math.max(0, (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0));
  if (!totalMinutes) {
    els.threadAutomationResumePreview.value = 'Chưa đặt thời gian mở lại';
    return;
  }
  const resumeAt = new Date(Date.now() + totalMinutes * 60 * 1000).toISOString();
  els.threadAutomationResumePreview.value = `${formatDateTime(resumeAt)} · reset từ bây giờ`;
}

function prettyJson(value) {
  try {
    return JSON.stringify(value ?? [], null, 2);
  } catch {
    return '[]';
  }
}

function parseJsonTextarea(value, label, fallback = []) {
  if (value == null) return Array.isArray(fallback) ? fallback : [];
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${label} phải là JSON array.`);
    return parsed;
  } catch (error) {
    throw new Error(error.message || `${label} không hợp lệ.`);
  }
}

function splitLinesOrCsv(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function guessIntentForPreview(text) {
  const haystack = String(text || '').toLowerCase();
  if (/phòng trống|còn phòng|check in|check-in|check out|checkout|ngày/.test(haystack)) return 'availability';
  if (/giá|bao nhiêu|rate|báo giá/.test(haystack)) return 'pricing';
  if (/tiện ích|dịch vụ|amenities/.test(haystack)) return 'service';
  if (/khiếu nại|bực|tức|refund|hoàn tiền/.test(haystack)) return 'complaint';
  return 'general';
}

function guessComplexityForPreview(text) {
  const haystack = String(text || '').toLowerCase();
  if (/và|hoặc|nếu|so sánh|mấy loại|nhiều/.test(haystack)) return 'structured';
  return 'simple';
}

function guessSentimentForPreview(text) {
  const haystack = String(text || '').toLowerCase();
  if (/khiếu nại|bực|tức|không hài lòng|refund|hoàn tiền/.test(haystack)) return 'negative';
  return 'neutral';
}

function formatDateTime(value) {
  if (!value) return 'không rõ';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'không rõ';
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function getCurrentRoles() {
  const roles = state.rbac?.catalog?.portal?.me?.roles || state.view?.portal?.me?.roles || [];
  return Array.isArray(roles) ? roles : [];
}

function isCurrentAdmin() {
  return getCurrentRoles().includes('admin');
}

function isCurrentManager() {
  return getCurrentRoles().includes('manager');
}

function setDisplay(element, visible) {
  if (!element) return;
  element.style.display = visible ? '' : 'none';
}

function applyRoleBasedUi() {
  const isAdmin = isCurrentAdmin();
  const isManager = isCurrentManager();
  const canManageChannels = isAdmin || isManager;
  setDisplay(els.utilityWebhookPanel, isAdmin);
  setDisplay(els.utilityRbacPanel, isAdmin || isManager);
  setDisplay(els.utilityAiPanel, isAdmin || isManager);
  setDisplay(els.threadAutomationPanel, isAdmin || isManager);
  setDisplay(els.chatAiQuickbar, isAdmin || isManager);
  setDisplay(els.notesFieldWrap, isAdmin);
  setDisplay(els.btnStartQr, canManageChannels);

  const rbacDepartmentsBoardSection = els.rbacDepartmentsBoard?.closest('.rbac-block');
  const rbacAccountAssignmentSection = els.rbacAccountDepartmentId?.closest('.rbac-block');
  const rbacRoleMatrixSection = els.rbacRoleMatrix?.closest('.rbac-block');
  const rbacDepartmentEditorGrid = els.rbacDepartmentCode?.closest('.details-grid');
  const rbacDepartmentEditorActions = rbacDepartmentEditorGrid?.nextElementSibling;
  const rbacUsersBoardSection = els.rbacUsersBoard?.closest('.rbac-block');
  const rbacUserEditorGrid = els.rbacUserUsername?.closest('.details-grid');
  const rbacUserEditorActions = rbacUserEditorGrid?.nextElementSibling;

  setDisplay(rbacDepartmentsBoardSection, isAdmin);
  setDisplay(rbacAccountAssignmentSection, isAdmin || isManager);
  setDisplay(rbacRoleMatrixSection, isAdmin);
  setDisplay(rbacDepartmentEditorGrid, isAdmin);
  setDisplay(rbacDepartmentEditorActions, isAdmin);
  setDisplay(rbacUsersBoardSection, isAdmin);
  setDisplay(rbacUserEditorGrid, isAdmin);
  setDisplay(rbacUserEditorActions, isAdmin);
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

function buildThreadSearchPool() {
  // Search must stay account-scoped: only start from the active account snapshot,
  // then optionally add virtual friend rows that also belong to that same account.
  const sourceThreads = [
    ...(Array.isArray(state.view?.threads) ? state.view.threads : []),
    ...(Array.isArray(state.view?.searchableThreads) ? state.view.searchableThreads.map((thread) => ({ ...thread, isSearchOnlyResult: true })) : [])
  ];
  const baseThreads = sourceThreads.map((thread) => {
    const participants = Array.isArray(thread.participants) ? thread.participants : [];
    return {
      ...thread,
      searchHint: thread.type === 'group'
        ? ['Nhóm', ...participants.flatMap((p) => [p.displayName, p.zaloName, p.username])].filter(Boolean).join(' · ')
        : [thread.searchHint, ...participants.flatMap((p) => [p.displayName, p.zaloName, p.username, p.phoneNumber])].filter(Boolean).join(' · ')
    };
  });
  const seen = new Set(baseThreads.map((thread) => String(thread.id)));
  const friendContacts = (state.view?.contacts || []).filter((contact) => String(contact?.kind || '') === 'friend');

  for (const contact of friendContacts) {
    const contactId = String(contact?.id || '');
    if (!contactId || seen.has(contactId)) continue;
    baseThreads.push({
      id: contactId,
      title: contact.displayName || contact.zaloName || contact.username || contactId,
      type: 'direct',
      participantIds: [contactId],
      participants: [contact],
      avatarUrl: contact.avatarUrl || '',
      source: 'friend',
      unreadCount: 0,
      tags: [],
      messages: [],
      lastMessageText: '',
      lastMessageAt: '',
      searchHint: [contact.zaloName, contact.username, contact.phoneNumber, 'Bạn bè'].filter(Boolean).join(' · '),
      isVirtualSearchResult: true
    });
    seen.add(contactId);
  }

  return baseThreads;
}

function openSearchThread(thread, options = {}) {
  ensureSearchResultThread(thread);
  switchActiveThread(thread.id);
  if (options.clearUnread !== false) clearUnreadForThread(thread.id);
  if (options.renderNow !== false) {
    render();
    switchView('chats');
  }
}

function ensureSearchResultThread(thread) {
  if (!state.view || !thread) return;
  const exists = (state.view.threads || []).some((item) => String(item.id) === String(thread.id));
  const contact = findContact(thread.id) || thread.participants?.[0] || null;
  if (contact && !(state.view.contacts || []).some((item) => String(item.id) === String(contact.id))) {
    state.view.contacts = [contact, ...(state.view.contacts || [])];
  }
  if (exists) return;
  state.view.threads = [
    {
      ...thread,
      participants: contact
        ? (thread.type === 'group' ? (thread.participants || []) : [contact])
        : (thread.participants || []),
      searchHint: thread.searchHint || (thread.type === 'group' ? 'Nhóm' : 'Bạn bè'),
      isVirtualSearchResult: false,
      isSearchOnlyResult: false,
      messages: Array.isArray(thread.messages) ? thread.messages : []
    },
    ...(state.view.threads || [])
  ];
  if (state.view.stats) state.view.stats.threadCount = state.view.threads.length;
}

async function handleAccountSelect() {
  const accountId = els.accountSelect.value;
  if (!accountId || state.isSwitchingAccount) return;
  const previousValue = state.view?.activeAccountId || '';
  state.isSwitchingAccount = true;
  els.accountSelect.disabled = true;
  try {
    disconnectEvents();
    resetClientViewForAccountSwitch(accountId);
    showAppNotice('Đang chuyển tài khoản Zalo...', 'warning');
    await post('/api/accounts/select', { accountId }, { timeoutMs: 60000 });
    await reloadState();
    connectEvents();
    hideAppNotice();
  } catch (error) {
    if (previousValue) { els.accountSelect.value = previousValue; resetClientViewForAccountSwitch(previousValue); }
    await reloadState().catch(() => null);
    connectEvents();
    showAppNotice(error.message || 'Không chuyển được account.', 'danger');
  } finally {
    state.isSwitchingAccount = false;
    els.accountSelect.disabled = false;
  }
}

function resetClientViewForAccountSwitch(accountId) {
  saveComposerDraft();
  clearTimeout(state.integratedSearch.timer);
  state.integratedSearch.seq += 1;
  state.integratedSearch.remoteItems = [];
  state.integratedSearch.query = '';
  state.integratedSearch.loading = false;
  els.threadSearch.value = '';
  els.friendSearchResults.textContent = '';
  els.threadProfileModal.classList.add('hidden');
  els.eventToastStack.textContent = '';
  hideContextMenu();
  closeImageLightbox();
  closeForwardModal();
  resetThreadMemoryState();
  closeBookingBridgeModal({ preserveState: false });
  state.activeThreadId = null;
  state.threadProfile = null;
  state.replyTo = null;
  state.pendingAttachments = [];
  state.notifiedEventKeys = [];
  state.stickerPackDetails = {};
  state.pendingStickerLoads = new Set();
  if (state.view) {
    state.view = {
      ...state.view,
      activeAccountId: accountId,
      session: { account: null, status: null },
      labels: { items: [] },
      aiAutomationLogs: [],
      threads: [],
      searchableThreads: [],
      contacts: [],
      stats: {
        ...(state.view.stats || {}),
        threadCount: 0,
        unreadThreads: 0,
        unreadMessages: 0
      },
      zalo: {}
    };
  }
  render();
}

function handleVisibilityRecovery() {
  if (!state.authenticated || state.isSwitchingAccount) return;
  if (document.visibilityState && document.visibilityState !== 'visible') return;
  if (state.realtimeConnected && state.eventSource) return;
  reloadState().catch(() => null).finally(() => {
    if (!state.eventSource) connectEvents();
  });
}

async function logoutZaloAccount() {
  const accountId = String(els.accountSelect?.value || state.view?.activeAccountId || '').trim();
  if (!accountId || state.isSwitchingAccount) return;
  const selected = (state.view?.accounts || []).find((item) => String(item.id) === accountId);
  const label = selected?.displayName || selected?.userId || accountId;
  if (!confirm(`Đăng xuất account Zalo "${label}" khỏi server này?`)) return;
  state.isSwitchingAccount = true;
  els.accountSelect.disabled = true;
  if (els.btnZaloAccountLogout) els.btnZaloAccountLogout.disabled = true;
  try {
    disconnectEvents();
    showAppNotice(`Đang đăng xuất account ${label}...`, 'warning');
    await post('/api/accounts/logout', { accountId }, { timeoutMs: 60000 });
    await reloadState();
    connectEvents();
    showAppNotice(`Đã đăng xuất account ${label}.`, 'warning');
  } catch (error) {
    await reloadState().catch(() => null);
    connectEvents();
    showAppNotice(error.message || 'Không đăng xuất được account Zalo.', 'danger');
  } finally {
    state.isSwitchingAccount = false;
    els.accountSelect.disabled = false;
    if (els.btnZaloAccountLogout) els.btnZaloAccountLogout.disabled = false;
    renderAccounts();
  }
}

async function saveWebhookConfig() {
  try {
    await post('/api/integration/config', {
      webhookUrl: els.webhookUrlInput.value.trim(),
      webhookSecret: els.webhookSecretInput.value.trim(),
      enabled: els.webhookEnabledInput.checked,
      selectedAccountIds: csvList(els.webhookAccountIds?.value)
    });
    await reloadState();
    showAppNotice('Đã lưu cấu hình webhook n8n.', 'warning');
  } catch (error) {
    showAppNotice(error.message || 'Lưu webhook thất bại.', 'danger');
  }
}

async function loadRbacCatalog() {
  if (!state.authenticated) return;
  try {
    const catalog = await getJson('/api/portal/catalog');
    let roles = null;
    const isAdmin = Array.isArray(catalog?.portal?.me?.roles) && catalog.portal.me.roles.includes('admin');
    if (isAdmin) {
      try {
        roles = await getJson('/api/portal/roles');
      } catch (error) {
        roles = { error: error.message || 'Không tải được ma trận quyền' };
      }
    }
    state.rbac = { catalog, roles };
  } catch (error) {
    state.rbac = { error: error.message || 'Không tải được cấu hình phân quyền' };
  }
}

function renderRbacPanel() {
  const internalRbacContext = { state, post, getJson, reloadState, showAppNotice, escapeHtml, escapeAttribute };
  window.__internalRbacContext = internalRbacContext;
  if (typeof window.renderInternalRbacWorkspace === 'function') {
    window.renderInternalRbacWorkspace(internalRbacContext);
    return;
  }
  const root = document.querySelector('#internal-rbac-workspace');
  if (root) root.textContent = 'Đang tải Phân quyền nội bộ…';
}

function renderDepartmentsBoard(departments, users, channels) {
  if (!els.rbacDepartmentsBoard) return;
  if (!departments.length) {
    els.rbacDepartmentsBoard.textContent = 'Chưa có bộ phận nào.';
    return;
  }
  els.rbacDepartmentsBoard.innerHTML = departments.map((dept) => {
    const deptUsers = users.filter((user) => (user.departmentIds || []).includes(dept.id));
    const managers = deptUsers.filter((user) => (user.roles || []).includes('manager'));
    const staffs = deptUsers.filter((user) => (user.roles || []).includes('staff'));
    const deptChannels = channels.filter((channel) => String(channel.departmentId || '') === String(dept.id));
    return `
      <div class="rbac-department-card">
        <strong>${escapeHtml(dept.name || dept.code || dept.id)}</strong>
        <div class="small-note">Mã: ${escapeHtml(dept.code || dept.id || '')}</div>
        <div class="small-note">Số account đã cấp: <strong>${deptChannels.length}</strong></div>
        <div class="small-note">Quản lí: ${managers.map((user) => escapeHtml(user.username)).join(', ') || 'Chưa có'}</div>
        <div class="small-note">Nhân viên: ${staffs.map((user) => escapeHtml(user.username)).join(', ') || 'Chưa có'}</div>
        <div class="small-note">Danh sách account Zalo: ${deptChannels.map((channel) => escapeHtml(channel.name || channel.accountId || channel.code || channel.id || '')).join(', ') || 'Chưa cấp'}</div>
      </div>
    `;
  }).join('');
}

function renderDepartmentAssignmentControls(departments) {
  if (els.rbacAccountDepartmentId) {
    const current = String(els.rbacAccountDepartmentId.value || '');
    els.rbacAccountDepartmentId.innerHTML = ['<option value="">Chọn bộ phận</option>']
      .concat((departments || []).map((dept) => `<option value="${escapeAttribute(dept.id)}" ${String(dept.id) === current ? 'selected' : ''}>${escapeHtml(dept.name || dept.code || dept.id)}</option>`))
      .join('');
    if (current && !(departments || []).some((dept) => String(dept.id) === current)) {
      els.rbacAccountDepartmentId.value = '';
    }
  }
  renderDepartmentAccountPicker();
}

function renderDepartmentAccountPicker() {
  if (!els.rbacDepartmentAccountPicker) return;
  const selectedDepartmentId = String(els.rbacAccountDepartmentId?.value || '').trim();
  const accounts = state.view?.accounts || [];
  if (!selectedDepartmentId) {
    els.rbacDepartmentAccountPicker.textContent = 'Chọn bộ phận để hiện account.';
    return;
  }
  if (!accounts.length) {
    els.rbacDepartmentAccountPicker.textContent = 'Chưa có account Zalo nào đang login trên server.';
    return;
  }
  els.rbacDepartmentAccountPicker.innerHTML = accounts.map((item) => {
    const accountId = String(item.id || item.userId || '').trim();
    const channel = getAccountChannel(accountId);
    const checked = String(channel?.departmentId || '') === selectedDepartmentId;
    const currentDepartmentLabel = formatAccountDepartmentLabel(item);
    return `
      <label class="rbac-account-option">
        <input type="checkbox" data-rbac-department-account-id="${escapeAttribute(accountId)}" ${checked ? 'checked' : ''} />
        <span>${escapeHtml(item.displayName || item.userId || item.id)}<small>${escapeHtml(accountId)} · ${escapeHtml(currentDepartmentLabel)}</small></span>
      </label>
    `;
  }).join('');
}

function renderRbacDepartmentPicker(departments) {
  if (!els.rbacUserDepartmentPicker || !els.rbacUserDepartments) return;
  if (!departments.length) {
    els.rbacUserDepartmentPicker.textContent = 'Chưa có bộ phận nào.';
    return;
  }
  const selected = new Set(csvList(els.rbacUserDepartments.value));
  els.rbacUserDepartmentPicker.innerHTML = departments.map((dept) => `
    <label class="rbac-account-option">
      <input type="checkbox" data-rbac-user-department-id="${escapeAttribute(dept.id)}" ${selected.has(String(dept.id)) ? 'checked' : ''} />
      <span>${escapeHtml(dept.name || dept.code || dept.id)}<small>${escapeHtml(dept.code || dept.id || '')}</small></span>
    </label>
  `).join('');
}

function renderUsersBoard(users, departments) {
  if (!els.rbacUsersBoard) return;
  if (!users.length) {
    els.rbacUsersBoard.textContent = 'Chưa có account nội bộ nào.';
    return;
  }
  const deptMap = new Map((departments || []).map((item) => [String(item.id), item]));
  const channels = Array.isArray(state.rbac?.catalog?.portal?.channels) ? state.rbac.catalog.portal.channels : [];
  els.rbacUsersBoard.innerHTML = users.map((user) => {
    const role = Array.isArray(user.roles) && user.roles.length ? user.roles.join(', ') : 'staff';
    const deptNames = (user.departmentIds || []).map((id) => deptMap.get(String(id))?.name || id).join(', ') || 'Chưa gán';
    const accountIds = channels
      .filter((channel) => Array.isArray(channel.members) && channel.members.some((member) => String((member && typeof member === 'object' ? (member.userId || member.id || member.username) : member) || '') === String(user.username || user.id || '')))
      .map((channel) => {
        const departmentName = deptMap.get(String(channel.departmentId || ''))?.name || channel.departmentId || 'Chưa gán';
        const accountLabel = channel.name || channel.accountId || channel.code || channel.id;
        return `${accountLabel} (${departmentName})`;
      })
      .filter(Boolean);
    return `
      <div class="rbac-user-row">
        <div>
          <strong>${escapeHtml(user.displayName || user.username || user.id)}</strong>
          <div class="small-note">Username: ${escapeHtml(user.username || user.id || '')}</div>
          <div class="small-note">Vai trò: ${escapeHtml(role)}</div>
          <div class="small-note">Bộ phận: ${escapeHtml(deptNames)}</div>
          <div class="small-note">Được vào ${accountIds.length} account Zalo: ${escapeHtml(accountIds.join(', ') || 'Chưa cấp')}</div>
          <div class="small-note">Trạng thái: ${user.active === false ? 'Đã khoá' : 'Đang dùng'}</div>
        </div>
        <div class="rbac-user-actions">
          <button class="ghost-btn" type="button" data-rbac-user-edit="${escapeAttribute(user.id || user.username || '')}">Sửa</button>
          <button class="ghost-btn" type="button" data-rbac-user-delete="${escapeAttribute(user.id || user.username || '')}">Xoá</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderRbacAccountPicker() {
  if (!els.rbacUserAccountPicker) return;
  const accounts = state.view?.accounts || [];
  const selectedAccountIds = new Set(csvList(els.rbacUserAccountIds?.value));
  const selectedDepartmentIds = new Set(csvList(els.rbacUserDepartments?.value));
  if (!selectedDepartmentIds.size) {
    els.rbacUserAccountPicker.textContent = 'Chọn bộ phận trước để hiện account Zalo tương ứng.';
    return;
  }
  const filteredAccounts = accounts.filter((item) => selectedDepartmentIds.has(String(getAccountChannel(item.id || item.userId || '')?.departmentId || '')));
  if (!filteredAccounts.length) {
    els.rbacUserAccountPicker.textContent = 'Chưa có account Zalo nào thuộc bộ phận đã chọn.';
    return;
  }
  els.rbacUserAccountPicker.innerHTML = filteredAccounts.map((item) => {
    const accountId = String(item.id || item.userId || '');
    const label = item.displayName || item.userId || item.id;
    const departmentLabel = formatAccountDepartmentLabel(item);
    return `
      <label class="rbac-account-option">
        <input type="checkbox" data-rbac-account-id="${escapeAttribute(accountId)}" ${selectedAccountIds.has(accountId) ? 'checked' : ''} />
        <span>${escapeHtml(label)}<small>${escapeHtml(accountId)} · ${escapeHtml(departmentLabel)}</small></span>
      </label>
    `;
  }).join('');
}

function syncSelectedRbacAccounts() {
  if (!els.rbacUserAccountPicker || !els.rbacUserAccountIds) return;
  const selected = [...els.rbacUserAccountPicker.querySelectorAll('[data-rbac-account-id]:checked')]
    .map((input) => input.dataset.rbacAccountId)
    .filter(Boolean);
  els.rbacUserAccountIds.value = selected.join(',');
}

function syncSelectedRbacDepartments() {
  if (!els.rbacUserDepartmentPicker || !els.rbacUserDepartments) return [];
  const selected = [...els.rbacUserDepartmentPicker.querySelectorAll('[data-rbac-user-department-id]:checked')]
    .map((input) => input.dataset.rbacUserDepartmentId)
    .filter(Boolean);
  els.rbacUserDepartments.value = selected.join(',');
  return selected;
}

function handleRbacUserRoleChange() {
  const role = String(els.rbacUserRole?.value || 'staff');
  if (role !== 'staff') return;
  const selected = syncSelectedRbacDepartments();
  if (selected.length <= 1) return;
  const keep = selected[0];
  [...els.rbacUserDepartmentPicker.querySelectorAll('[data-rbac-user-department-id]')].forEach((input) => {
    input.checked = input.dataset.rbacUserDepartmentId === keep;
  });
  els.rbacUserDepartments.value = keep;
  renderRbacAccountPicker();
  showAppNotice('Vai trò staff chỉ giữ 1 bộ phận đầu tiên.', 'warning');
}

function handleRbacUserDepartmentsChange() {
  const selected = syncSelectedRbacDepartments();
  if (String(els.rbacUserRole?.value || 'staff') === 'staff' && selected.length > 1) {
    handleRbacUserRoleChange();
    return;
  }
  const visibleAccountIds = new Set((state.view?.accounts || [])
    .filter((item) => selected.includes(String(getAccountChannel(item.id || item.userId || '')?.departmentId || '')))
    .map((item) => String(item.id || item.userId || '')));
  if (els.rbacUserAccountIds) {
    els.rbacUserAccountIds.value = csvList(els.rbacUserAccountIds.value).filter((accountId) => visibleAccountIds.has(String(accountId))).join(',');
  }
  renderRbacAccountPicker();
}

function renderRoleMatrix(roleState) {
  if (!els.rbacRoleMatrix) return;
  if (!roleState) {
    els.rbacRoleMatrix.textContent = 'Chỉ admin mới chỉnh được ma trận quyền.';
    if (els.btnRbacApplyRoles) els.btnRbacApplyRoles.style.display = 'none';
    return;
  }
  if (roleState.error) {
    els.rbacRoleMatrix.textContent = roleState.error;
    if (els.btnRbacApplyRoles) els.btnRbacApplyRoles.style.display = 'none';
    return;
  }
  if (els.btnRbacApplyRoles) els.btnRbacApplyRoles.style.display = 'inline-flex';
  const roles = roleState.roles || {};
  const permissions = Array.isArray(roleState.permissions) ? roleState.permissions : [];
  const managerSet = new Set(roles.manager || []);
  const staffSet = new Set(roles.staff || []);
  els.rbacRoleMatrix.innerHTML = `
    <div class="rbac-role-grid">
      <div class="rbac-role-card admin">
        <strong>Admin</strong>
        <div class="small-note">Full quyền mặc định.</div>
        <div class="small-note">Không cần tích chọn.</div>
      </div>
      <div class="rbac-role-card">
        <strong>Quản lí</strong>
        ${permissions.map((item) => `
          <label class="rbac-permission-item">
            <input type="checkbox" data-role-permission="manager" data-permission="${escapeAttribute(item.key)}" ${managerSet.has(item.key) ? 'checked' : ''} />
            <span>${escapeHtml(item.label)}<small>${escapeHtml(item.group)}</small></span>
          </label>
        `).join('')}
      </div>
      <div class="rbac-role-card">
        <strong>Nhân viên</strong>
        ${permissions.map((item) => `
          <label class="rbac-permission-item">
            <input type="checkbox" data-role-permission="staff" data-permission="${escapeAttribute(item.key)}" ${staffSet.has(item.key) ? 'checked' : ''} />
            <span>${escapeHtml(item.label)}<small>${escapeHtml(item.group)}</small></span>
          </label>
        `).join('')}
      </div>
    </div>
  `;
}

function csvList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

async function saveRbacDepartment() {
  try {
    await post('/api/portal/departments', {
      id: els.rbacDepartmentCode.value.trim(),
      code: els.rbacDepartmentCode.value.trim(),
      name: els.rbacDepartmentName.value.trim(),
      managerUserIds: csvList(els.rbacDepartmentManagers.value)
    });
    await reloadState();
    showAppNotice('Đã lưu bộ phận.', 'warning');
  } catch (error) {
    showAppNotice(error.message || 'Lưu bộ phận thất bại.', 'danger');
  }
}

async function saveRbacDepartmentAccounts() {
  try {
    const departmentId = String(els.rbacAccountDepartmentId?.value || '').trim();
    if (!departmentId) throw new Error('Chọn bộ phận trước khi lưu account.');
    const selectedAccountIds = new Set([
      ...els.rbacDepartmentAccountPicker.querySelectorAll('[data-rbac-department-account-id]:checked')
    ].map((input) => String(input.dataset.rbacDepartmentAccountId || '')).filter(Boolean));
    const accounts = state.view?.accounts || [];
    const changes = [];
    for (const item of accounts) {
      const accountId = String(item.id || item.userId || '').trim();
      if (!accountId) continue;
      const existing = getAccountChannel(accountId);
      const currentDepartmentId = String(existing?.departmentId || '').trim();
      const shouldBelong = selectedAccountIds.has(accountId);
      if (shouldBelong && currentDepartmentId !== departmentId) {
        changes.push(post('/api/portal/channels', {
          id: existing?.id || accountId,
          code: existing?.code || accountId,
          name: existing?.name || item.displayName || accountId,
          accountId,
          departmentId,
          channelType: existing?.channelType || 'zalo_personal',
          botStatus: existing?.botStatus || 'disabled',
          routingMode: existing?.routingMode || 'least_connections',
          credentials: existing?.credentials || {},
          members: Array.isArray(existing?.members) ? existing.members : [],
          active: existing?.active !== false
        }));
      }
      if (!shouldBelong && currentDepartmentId === departmentId) {
        changes.push(post('/api/portal/channels', {
          id: existing?.id || accountId,
          code: existing?.code || accountId,
          name: existing?.name || item.displayName || accountId,
          accountId,
          departmentId: null,
          channelType: existing?.channelType || 'zalo_personal',
          botStatus: existing?.botStatus || 'disabled',
          routingMode: existing?.routingMode || 'least_connections',
          credentials: existing?.credentials || {},
          members: Array.isArray(existing?.members) ? existing.members : [],
          active: existing?.active !== false
        }));
      }
    }
    await Promise.all(changes);
    await reloadState();
    if (els.rbacAccountDepartmentId) els.rbacAccountDepartmentId.value = departmentId;
    renderDepartmentAccountPicker();
    showAppNotice('Đã lưu account Zalo cho bộ phận.', 'warning');
  } catch (error) {
    showAppNotice(error.message || 'Lưu account cho bộ phận thất bại.', 'danger');
  }
}

async function saveRbacUser() {
  try {
    const role = String(els.rbacUserRole.value || 'staff');
    const departmentIds = syncSelectedRbacDepartments();
    if (!departmentIds.length) throw new Error('Chọn ít nhất 1 bộ phận cho user.');
    if (role === 'staff' && departmentIds.length > 1) throw new Error('Nhân viên chỉ được thuộc 1 bộ phận.');
    await post('/api/portal/users', {
      username: els.rbacUserUsername.value.trim(),
      displayName: els.rbacUserDisplay.value.trim(),
      password: els.rbacUserPassword.value,
      roles: [role],
      departmentIds,
      accountIds: csvList(els.rbacUserAccountIds?.value),
      permissions: []
    });
    if (els.rbacUserPassword) els.rbacUserPassword.value = '';
    if (els.rbacUserAccountIds) els.rbacUserAccountIds.value = '';
    renderRbacAccountPicker();
    await reloadState();
    showAppNotice('Đã lưu user phân quyền.', 'warning');
  } catch (error) {
    showAppNotice(error.message || 'Lưu user thất bại.', 'danger');
  }
}

async function saveRbacRoles() {
  try {
    const manager = [...document.querySelectorAll('[data-role-permission="manager"]:checked')].map((item) => item.dataset.permission).filter(Boolean);
    const staff = [...document.querySelectorAll('[data-role-permission="staff"]:checked')].map((item) => item.dataset.permission).filter(Boolean);
    await post('/api/portal/roles', { manager, staff });
    await loadRbacCatalog();
    renderRbacPanel();
    showAppNotice('Đã áp dụng quyền mới. Hiệu lực ngay.', 'warning');
  } catch (error) {
    showAppNotice(error.message || 'Cập nhật ma trận quyền thất bại.', 'danger');
  }
}

function toggleRbacPasswordVisibility() {
  if (!els.rbacUserPassword || !els.btnRbacTogglePassword) return;
  const showing = els.rbacUserPassword.type === 'text';
  els.rbacUserPassword.type = showing ? 'password' : 'text';
  els.btnRbacTogglePassword.textContent = showing ? '👁' : '🙈';
  els.btnRbacTogglePassword.setAttribute('aria-label', showing ? 'Hiện mật khẩu' : 'Ẩn mật khẩu');
  els.btnRbacTogglePassword.setAttribute('title', showing ? 'Hiện mật khẩu' : 'Ẩn mật khẩu');
}

function handleRbacUsersBoardClick(event) {
  const editId = event.target?.closest?.('[data-rbac-user-edit]')?.dataset?.rbacUserEdit;
  if (editId) {
    return populateRbacUserForm(editId);
  }
  const deleteId = event.target?.closest?.('[data-rbac-user-delete]')?.dataset?.rbacUserDelete;
  if (deleteId) {
    void deleteRbacUser(deleteId);
  }
}

function populateRbacUserForm(userId) {
  const users = Array.isArray(state.rbac?.catalog?.users) ? state.rbac.catalog.users : [];
  const user = users.find((item) => String(item.id || item.username || '') === String(userId || ''));
  if (!user) return;
  const channels = Array.isArray(state.rbac?.catalog?.portal?.channels) ? state.rbac.catalog.portal.channels : [];
  const accountIds = channels
    .filter((channel) => Array.isArray(channel.members) && channel.members.some((member) => String((member && typeof member === 'object' ? (member.userId || member.id || member.username) : member) || '') === String(user.username || user.id || '')))
    .map((channel) => channel.accountId || channel.code || channel.id)
    .filter(Boolean);
  if (els.rbacUserUsername) els.rbacUserUsername.value = user.username || user.id || '';
  if (els.rbacUserDisplay) els.rbacUserDisplay.value = user.displayName || '';
  if (els.rbacUserRole) els.rbacUserRole.value = Array.isArray(user.roles) && user.roles[0] ? user.roles[0] : 'staff';
  if (els.rbacUserDepartments) els.rbacUserDepartments.value = Array.isArray(user.departmentIds) ? user.departmentIds.join(',') : '';
  renderRbacDepartmentPicker(Array.isArray(state.rbac?.catalog?.portal?.departments) ? state.rbac.catalog.portal.departments : []);
  if (els.rbacUserAccountIds) els.rbacUserAccountIds.value = accountIds.join(',');
  renderRbacAccountPicker();
  if (els.rbacUserPassword) els.rbacUserPassword.value = '';
  showAppNotice(`Đã nạp account ${user.username || user.id} lên form để sửa.`, 'warning');
}

async function deleteRbacUser(userId) {
  const users = Array.isArray(state.rbac?.catalog?.users) ? state.rbac.catalog.users : [];
  const user = users.find((item) => String(item.id || item.username || '') === String(userId || ''));
  if (!user) return;
  const ok = window.confirm(`Xoá account ${user.username || user.id}?`);
  if (!ok) return;
  try {
    await fetchJson(`/api/portal/users/${encodeURIComponent(String(user.id || user.username || ''))}`, {
      method: 'DELETE',
      credentials: 'same-origin'
    });
    await reloadState();
    showAppNotice('Đã xoá account nội bộ.', 'warning');
  } catch (error) {
    showAppNotice(error.message || 'Xoá account thất bại.', 'danger');
  }
}

async function refreshDirectRelation(userId, currentRelation = relationForUser(userId)) {
  const id = String(userId || '');
  if (!id || state.relationRefreshInFlight.has(id)) return;
  if (!['stranger', 'outgoing_request', 'incoming_request'].includes(String(currentRelation || ''))) return;
  state.relationRefreshInFlight.add(id);
  try {
    const result = await fetchJson(`/api/friends/status?userId=${encodeURIComponent(id)}`, { credentials: 'same-origin' }, { silentNotice: true, timeoutMs: 5000 });
    if (result?.relation && String(result.relation) !== String(currentRelation || '')) {
      await reloadState();
    }
  } catch {
    // ignore silent relation refresh failures
  } finally {
    state.relationRefreshInFlight.delete(id);
  }
}

function renderSession() {
  const session = state.view?.session;
  if (!session) return;
  const online = session.status === 'connected';
  const lostConnection = ['reconnect_failed', 'login_error'].includes(session.status);
  els.sessionBadge.textContent = online ? 'Connected' : session.status;
  els.sessionBadge.className = `badge ${online ? 'badge-online' : 'badge-offline'}`;
  const username = String(state.authIdentity?.username || '').trim();
  const roles = Array.isArray(state.authIdentity?.roles) ? state.authIdentity.roles : [];
  const roleLabel = roles.includes('admin') ? 'Quản trị viên' : roles.includes('staff') ? 'Nhân viên' : 'Người dùng';
  els.accountLine.textContent = username ? `${username} · ${roleLabel}` : 'Tài khoản quản trị';
  els.syncNote.textContent = lostConnection
    ? 'Phiên Zalo đã rớt. Hãy bấm tạo QR mới và quét lại để nối realtime.'
    : [session.syncInfo?.note || '', `Server ${state.serverVersion || CLIENT_VERSION}`].filter(Boolean).join(' · ');
  if (session.qrImage) {
    els.qrBox.innerHTML = `<img src="${session.qrImage}" alt="QR login" class="qr-image" /><div class="qr-code-text">${escapeHtml(session.qrCode || '')}</div>`;
  } else if (lostConnection) {
    els.qrBox.innerHTML = `<div><strong>Phiên Zalo đã mất kết nối</strong><div class="qr-code-text">${escapeHtml(session.error || 'Hãy tạo QR mới rồi quét lại.')}</div></div>`;
  } else {
    els.qrBox.textContent = session.qrCode || session.error || 'Chưa có QR';
  }
  els.btnConfirmQr.style.display = session.provider === 'mock' ? 'inline-block' : 'none';
}

function renderThreads() {
  const visibleThreads = Array.isArray(state.view?.threads) ? state.view.threads : [];
  const searchPool = buildThreadSearchPool();
  const rawQuery = els.threadSearch.value.trim();
  const query = normalizeSearchText(rawQuery);
  const filteredThreads = query
    ? searchPool.filter((thread) => normalizeSearchText([
      thread.title,
      thread.lastMessageText,
      ...(thread.tags || []),
      thread.assignee,
      thread.searchHint,
      ...(thread.participants || []).flatMap((p) => [p.displayName, p.zaloName, p.username, p.phoneNumber])
    ].filter(Boolean).join(' ')).includes(query))
    : visibleThreads;

  els.threadCount.textContent = query
    ? `${Number(filteredThreads.length || 0)}/${Number(searchPool.length || 0)}`
    : `${Number(filteredThreads.length || 0)}/${Number(visibleThreads.length || 0)}`;
  els.unreadSummary.textContent = `${state.view?.stats?.unreadThreads || 0} chưa đọc`;
  els.threadList.innerHTML = '';

  if (!query) {
    for (const thread of filteredThreads) appendThreadSearchRow(thread);
    return;
  }

  appendSearchSectionTitle(`Hội thoại · ${filteredThreads.length}`);
  if (!filteredThreads.length) {
    appendSearchEmpty('Không thấy hội thoại nào khớp.');
  } else {
    for (const thread of filteredThreads) appendThreadSearchRow(thread);
  }

  const remote = Array.isArray(state.integratedSearch?.remoteItems) ? state.integratedSearch.remoteItems : [];
  appendSearchSectionTitle(`Người dùng Zalo${state.integratedSearch?.loading ? ' · đang tìm...' : remote.length ? ` · ${remote.length}` : ''}`);
  if (state.integratedSearch?.loading) {
    appendSearchEmpty('Đang tra Zalo theo số điện thoại / username...');
  } else if (!remote.length) {
    appendSearchEmpty('Không thấy thêm user Zalo phù hợp.');
  } else {
    for (const item of remote) appendIntegratedUserSearchRow(item);
  }
}

function appendThreadSearchRow(thread) {
  const item = document.createElement('div');
  item.className = `thread-item ${thread.id === state.activeThreadId ? 'active' : ''}`;
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.addEventListener('click', () => {
    openSearchThread(thread);
  });
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openSearchThread(thread);
    }
  });
  item.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSearchThread(thread, { renderNow: false, clearUnread: true });
    render();
    showContextMenu(event.clientX, event.clientY, buildThreadMenu(thread));
  });

  item.innerHTML = `
    ${renderAvatar(thread.avatarUrl, initials(thread.title))}
    <div class="thread-meta">
      <div class="thread-title-row">
        <strong>${escapeHtml(thread.title)}</strong>
        <div class="thread-title-actions">
          <button class="thread-ai-pill ${threadAutomationStatusClass(thread.automation?.mode || 'off')}" type="button" data-role="thread-ai-toggle">${escapeHtml(thread.automation?.mode === 'auto' ? 'AI ON' : thread.automation?.mode === 'snoozed' ? 'AI 30P' : thread.automation?.mode === 'human_only' ? 'NGƯỜI' : 'AI OFF')}</button>
          <span class="thread-time">${formatTime(thread.lastMessageAt)}</span>
          <button class="more-btn" type="button" data-role="thread-more">⋯</button>
        </div>
      </div>
      <div class="thread-preview-row">
        <span class="thread-preview">${escapeHtml(thread.lastMessageText || defaultPreview(thread))}</span>
        ${thread.unreadCount ? `<span class="unread-pill">${thread.unreadCount}</span>` : ''}
      </div>
      <div class="thread-extra-row">
        ${thread.type === 'direct' ? `<span class="${relationChipClass(relationForUser(thread.participants?.[0]?.id || thread.id))}">${escapeHtml(relationLabel(relationForUser(thread.participants?.[0]?.id || thread.id)))}</span>` : ''}
        ${thread.pinned ? `<span class="mini-chip">📌</span>` : ''}
        ${thread.archived ? `<span class="mini-chip">🗄️</span>` : ''}
        ${thread.hidden ? `<span class="mini-chip">🙈</span>` : ''}
        ${thread.muted ? `<span class="mini-chip">🔕</span>` : ''}
        ${thread.autoDelete ? `<span class="mini-chip">⏳ ${formatAutoDelete(thread.autoDeleteTtl)}</span>` : ''}
        ${(thread.tags || []).slice(0, 3).map((tag) => `<span class="mini-chip">#${escapeHtml(tag)}</span>`).join('')}
      </div>
    </div>
  `;
  item.querySelector('[data-role="thread-ai-toggle"]')?.addEventListener('click', (event) => toggleThreadAutomationForThread(thread, event));
  item.querySelector('[data-role="thread-more"]').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSearchThread(thread, { renderNow: false, clearUnread: true });
    render();
    showContextMenu(event.clientX || item.getBoundingClientRect().right - 8, event.clientY || item.getBoundingClientRect().top + 28, buildThreadMenu(thread));
  });
  els.threadList.appendChild(item);
}

function appendIntegratedUserSearchRow(user) {
  const row = document.createElement('div');
  row.className = 'thread-item thread-item-search-user';
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.addEventListener('click', () => openIntegratedSearchUser(user));
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openIntegratedSearchUser(user);
    }
  });
  const relation = user.isFriend ? 'friend' : user.isRequesting ? 'incoming_request' : user.isRequested ? 'outgoing_request' : relationForUser(user.id);
  row.innerHTML = `
    ${renderAvatar(user.avatarUrl, initials(user.displayName || user.username || '?'))}
    <div class="thread-meta">
      <div class="thread-title-row">
        <strong>${escapeHtml(user.displayName || user.username || user.id)}</strong>
        <span class="thread-time">${escapeHtml(user.phoneNumber || user.username || user.id || '')}</span>
      </div>
      <div class="thread-preview-row">
        <span class="thread-preview">${escapeHtml([user.username, user.zaloName, relationLabel(relation)].filter(Boolean).join(' · ') || 'User Zalo')}</span>
      </div>
      <div class="thread-extra-row integrated-user-actions">
        <span class="${relationChipClass(relation)}">${escapeHtml(relationLabel(relation))}</span>
      </div>
    </div>
  `;
  const actionWrap = row.querySelector('.integrated-user-actions');
  mountActionButtons(actionWrap, [{ label: 'Mở', className: 'secondary-btn', action: () => openIntegratedSearchUser(user) }, ...directActionButtons(user)], true);
  row.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', (event) => event.stopPropagation());
  });
  els.threadList.appendChild(row);
}

function appendSearchSectionTitle(text) {
  const node = document.createElement('div');
  node.className = 'thread-search-section-title muted';
  node.textContent = text;
  els.threadList.appendChild(node);
}

function appendSearchEmpty(text) {
  const node = document.createElement('div');
  node.className = 'thread-search-empty muted';
  node.textContent = text;
  els.threadList.appendChild(node);
}

async function openThreadProfile(targetId = '', options = {}) {
  const current = currentThread();
  const threadId = String(targetId || current?.id || '');
  if (!threadId) return;
  const resetTab = options.resetTab !== false;
  if (resetTab) {
    state.threadProfileTab = 'overview';
    state.threadProfileMemberQuery = '';
  }
  els.threadProfileModal.classList.remove('hidden');
  els.threadProfileContent.innerHTML = '<div class="panel" style="margin:16px;">Đang tải thông tin hội thoại...</div>';
  const media = targetId && current && current.id !== threadId ? [] : collectThreadMedia(current);
  const files = targetId && current && current.id !== threadId ? [] : collectThreadFiles(current);
  try {
    const res = await getJson(`/api/threads/profile?threadId=${encodeURIComponent(threadId)}`);
    state.threadProfile = {
      ...(res.item || {}),
      media,
      files
    };
    renderThreadProfile();
  } catch (error) {
    els.threadProfileContent.innerHTML = `<div class="panel" style="margin:16px;">${escapeHtml(error.message || 'Không tải được thông tin hội thoại.')}</div>`;
  }
}

function closeThreadProfile() {
  els.threadProfileModal.classList.add('hidden');
}

function collectThreadMedia(thread) {
  return [...(thread?.messages || [])]
    .reverse()
    .flatMap((message) => (Array.isArray(message.attachments) ? message.attachments : [])
      .filter((item) => item.kind === 'image')
      .map((item) => ({ ...item, senderId: message.senderId, createdAt: message.createdAt })));
}

function collectThreadFiles(thread) {
  return [...(thread?.messages || [])]
    .reverse()
    .flatMap((message) => (Array.isArray(message.attachments) ? message.attachments : [])
      .filter((item) => item.kind !== 'image')
      .map((item) => ({ ...item, senderId: message.senderId, createdAt: message.createdAt })));
}

function renderThreadProfile() {
  const data = state.threadProfile;
  if (!data) return;
  const adminView = isCurrentAdmin();
  const memberQuery = state.threadProfileMemberQuery.trim().toLowerCase();
  const members = (data.members || []).filter((item) => !memberQuery || [item.displayName, item.zaloName, item.id].filter(Boolean).join(' ').toLowerCase().includes(memberQuery));
  const overview = `
    <div class="profile-grid">
      <section class="profile-panel">
        <h3>Thông tin</h3>
        <div class="profile-kv">
          <div>Tên</div><div>${escapeHtml(data.title || '')}</div>
          <div>Mô tả</div><div>${escapeHtml(data.description || data.subtitle || 'Không có')}</div>
          ${adminView ? `<div>ID</div><div>${escapeHtml(data.threadId || data.id || 'Không rõ')}</div>` : ''}
          ${data.type === 'direct' ? `<div>SĐT</div><div>${escapeHtml(data.phoneNumber || 'Không public')}</div>
          <div>Username</div><div>${escapeHtml(data.username || 'Không public')}</div>
          <div>Zalo name</div><div>${escapeHtml(data.zaloName || 'Không public')}</div>
          <div>Trạng thái</div><div>${escapeHtml(data.status || 'Không public')}</div>` : `<div>Thành viên</div><div>${escapeHtml(String(data.totalMember || 0))}</div>`}
          <div>Gọi thoại</div><div>${data.capabilities?.call ? 'Có hỗ trợ' : 'Chưa thấy API public khả dụng trong zca-js'}</div>
          <div>Gọi video</div><div>${data.capabilities?.videoCall ? 'Có hỗ trợ' : 'Chưa thấy API public khả dụng trong zca-js'}</div>
        </div>
      </section>
      <section class="profile-panel">
        <h3>Thao tác</h3>
        <div class="member-actions">
          ${data.type === 'group' ? `
            <button class="secondary-btn" type="button" data-profile-action="share-link">Lấy liên kết nhóm</button>
            <button class="secondary-btn" type="button" data-profile-action="invite-member">Mời người vào nhóm</button>
            <button class="danger-btn" type="button" data-profile-action="leave-group">Rời nhóm</button>
            <button class="ghost-btn" type="button" data-profile-action="leave-group-silent">Rời nhóm trong im lặng</button>
          ` : renderDirectProfileActions(data)}
        </div>
        ${adminView ? '<p class="muted small-note">Ảnh bìa, hồ sơ public, media cũ và file cũ được gom ngay trong popup này để xem nhanh.</p>' : ''}
      </section>
    </div>`;
  const media = `
    <div class="profile-panel">
      <h3>Ảnh & media cũ</h3>
      <div class="media-grid">
        ${(data.media || []).length ? data.media.map((item) => `<button class="media-card image-preview-btn" data-preview-image="${escapeAttribute(item.url || '')}" type="button"><img src="${escapeAttribute(item.url || '')}" alt="media" /></button>`).join('') : '<div class="muted">Chưa có ảnh/media cũ.</div>'}
      </div>
    </div>`;
  const files = `
    <div class="profile-panel">
      <h3>File cũ</h3>
      <div class="file-list">
        ${(data.files || []).length ? data.files.map((item) => `<a class="file-card" href="${escapeAttribute(item.url || '#')}" target="_blank" rel="noreferrer">📎 ${escapeHtml(item.name || 'Tệp đính kèm')}<div class="muted small-note">${escapeHtml(formatTime(item.createdAt))}</div></a>`).join('') : '<div class="muted">Chưa có file cũ.</div>'}
      </div>
    </div>`;
  const membersBlock = data.type === 'group' ? `
    <div class="profile-panel">
      <div class="profile-members-head">
        <h3 style="margin:0;">Thành viên nhóm</h3>
        <input id="profile-member-search" class="search-input compact no-top" placeholder="Tìm thành viên..." value="${escapeAttribute(state.threadProfileMemberQuery)}" />
      </div>
      <div class="member-list">
        ${members.map((item) => `<div class="member-row">
          ${renderAvatar(item.avatarUrl, initials(item.displayName || item.zaloName || '?'), 'avatar', '')}
          <div><strong>${escapeHtml(item.displayName || item.zaloName || item.id)}</strong>${adminView ? `<div class="muted small-note">${escapeHtml(item.zaloName || item.id || '')}</div>` : ''}</div>
          <div class="member-actions"><button class="ghost-btn" type="button" data-profile-member="${escapeAttribute(item.id)}">Xem</button></div>
        </div>`).join('') || '<div class="muted">Không có thành viên phù hợp.</div>'}
      </div>
    </div>` : '';
  els.threadProfileContent.innerHTML = `
    <div class="profile-cover" style="background-image:url('${escapeAttribute(data.coverUrl || data.avatarUrl || '')}')"></div>
    <div class="profile-head">
      ${renderAvatar(data.avatarUrl, initials(data.title || '?'), 'avatar profile-avatar-lg')}
      <div>
        <h2 class="profile-title">${escapeHtml(data.title || '')}</h2>
        <div class="profile-meta"><span class="mini-chip">${escapeHtml(data.subtitle || '')}</span><span class="mini-chip">${data.type === 'group' ? 'Nhóm' : 'Người dùng'}</span></div>
      </div>
      <div class="profile-actions">
        <button class="profile-tab ${state.threadProfileTab === 'overview' ? 'active' : ''}" type="button" data-profile-tab="overview">Tổng quan</button>
        <button class="profile-tab ${state.threadProfileTab === 'media' ? 'active' : ''}" type="button" data-profile-tab="media">Ảnh</button>
        <button class="profile-tab ${state.threadProfileTab === 'files' ? 'active' : ''}" type="button" data-profile-tab="files">File</button>
        ${data.type === 'group' ? `<button class="profile-tab ${state.threadProfileTab === 'members' ? 'active' : ''}" type="button" data-profile-tab="members">Thành viên</button>` : ''}
      </div>
    </div>
    <div class="profile-body">
      ${state.threadProfileTab === 'overview' ? overview : ''}
      ${state.threadProfileTab === 'media' ? media : ''}
      ${state.threadProfileTab === 'files' ? files : ''}
      ${state.threadProfileTab === 'members' ? membersBlock : ''}
    </div>
  `;
  els.threadProfileContent.querySelectorAll('[data-preview-image]').forEach((button) => button.addEventListener('click', () => openImageLightbox(button.dataset.previewImage || '')));
  els.threadProfileContent.querySelectorAll('[data-profile-tab]').forEach((button) => button.addEventListener('click', () => {
    state.threadProfileTab = button.dataset.profileTab || 'overview';
    renderThreadProfile();
  }));
  els.threadProfileContent.querySelector('#profile-member-search')?.addEventListener('input', (event) => {
    state.threadProfileMemberQuery = event.target.value || '';
    renderThreadProfile();
  });
  els.threadProfileContent.querySelectorAll('[data-profile-member]').forEach((button) => button.addEventListener('click', async () => {
    const id = button.dataset.profileMember || '';
    if (!id) return;
    try {
      const res = await getJson(`/api/threads/profile?threadId=${encodeURIComponent(id)}`);
      state.threadProfile = { ...(res.item || {}), media: [], files: [] };
      state.threadProfileTab = 'overview';
      renderThreadProfile();
    } catch (error) {
      showAppNotice(error.message || 'Không mở được hồ sơ thành viên.', 'danger');
    }
  }));
  els.threadProfileContent.querySelector('[data-profile-action="share-link"]')?.addEventListener('click', shareCurrentGroupLink);
  els.threadProfileContent.querySelector('[data-profile-action="invite-member"]')?.addEventListener('click', inviteMemberToCurrentGroup);
  els.threadProfileContent.querySelector('[data-profile-action="leave-group"]')?.addEventListener('click', () => leaveCurrentGroup(false));
  els.threadProfileContent.querySelector('[data-profile-action="leave-group-silent"]')?.addEventListener('click', () => leaveCurrentGroup(true));
  els.threadProfileContent.querySelector('[data-profile-action="friend-request"]')?.addEventListener('click', () => requestFriend(data));
  els.threadProfileContent.querySelector('[data-profile-action="friend-accept"]')?.addEventListener('click', () => acceptFriend(data));
  els.threadProfileContent.querySelector('[data-profile-action="friend-reject"]')?.addEventListener('click', () => rejectFriend(data));
  els.threadProfileContent.querySelector('[data-profile-action="friend-undo"]')?.addEventListener('click', () => undoFriendRequest(data.threadId || data.id));
  els.threadProfileContent.querySelector('[data-profile-action="friend-remove"]')?.addEventListener('click', () => removeDirectFriend(data));
  els.threadProfileContent.querySelector('[data-profile-action="friend-block"]')?.addEventListener('click', () => blockDirectUser(data));
  els.threadProfileContent.querySelector('[data-profile-action="friend-unblock"]')?.addEventListener('click', () => unblockDirectUser(data));
}

function renderDirectProfileActions(data) {
  const user = { id: data.threadId || data.id, displayName: data.title, avatarUrl: data.avatarUrl, phoneNumber: data.phoneNumber, username: data.username };
  const relation = relationForUser(user.id);
  if (relation === 'friend') return '<button class="secondary-btn" type="button" data-profile-action="friend-remove">Huỷ kết bạn</button><button class="danger-btn" type="button" data-profile-action="friend-block">Chặn</button>';
  if (relation === 'incoming_request') {
    return '<button class="primary-btn" type="button" data-profile-action="friend-accept">Chấp nhận</button><button class="secondary-btn" type="button" data-profile-action="friend-reject">Từ chối</button><button class="danger-btn" type="button" data-profile-action="friend-block">Chặn</button>';
  }
  if (relation === 'outgoing_request') {
    return '<button class="secondary-btn" type="button" data-profile-action="friend-undo">Thu hồi lời mời</button><button class="danger-btn" type="button" data-profile-action="friend-block">Chặn</button>';
  }
  if (relation === 'blocked') return '<button class="secondary-btn" type="button" data-profile-action="friend-unblock">Bỏ chặn</button>';
  return '<button class="primary-btn" type="button" data-profile-action="friend-request">Kết bạn</button><button class="danger-btn" type="button" data-profile-action="friend-block">Chặn</button>';
}

async function shareCurrentGroupLink() {
  const thread = currentThread();
  if (!thread) return;
  const res = await post('/api/groups/link', { threadId: thread.id });
  const link = res?.data?.link || res?.link || res?.groupLink || res?.url || '';
  if (link) {
    await navigator.clipboard?.writeText(link).catch(() => null);
    alert(`Đã lấy link nhóm:\n${link}`);
  } else {
    alert('Zalo đã bật link nhóm nhưng API hiện không trả về URL rõ ràng.');
  }
}

async function inviteMemberToCurrentGroup() {
  const thread = currentThread();
  if (!thread) return;
  const raw = prompt('Nhập userId cần mời vào nhóm. Có thể nhập nhiều id, ngăn cách dấu phẩy.');
  if (!raw) return;
  const userIds = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (!userIds.length) return;
  await post('/api/groups/invite', { threadId: thread.id, userIds });
  showAppNotice('Đã gửi lời mời vào nhóm.', 'warning');
}

async function leaveCurrentGroup(silent) {
  const thread = currentThread();
  if (!thread) return;
  if (!confirm(silent ? 'Rời nhóm trong im lặng?' : 'Rời nhóm này?')) return;
  await post('/api/groups/leave', { threadId: thread.id, silent });
  closeThreadProfile();
  await reloadState();
}

function renderMessages() {
  const thread = currentThread();
  if (!thread) {
    els.chatTitle.textContent = 'Chọn hội thoại';
    els.chatSubtitle.textContent = 'Realtime nội bộ server';
    els.chatRelationRow.innerHTML = '';
    if (els.chatBookingRow) {
      els.chatBookingRow.innerHTML = '';
      els.chatBookingRow.classList.add('hidden');
    }
    els.chatDirectActions.innerHTML = '';
    els.chatAvatarWrap.innerHTML = '<div id="chat-avatar" class="avatar large">?</div>';
    els.messageList.className = 'message-list empty-state';
    els.messageList.textContent = 'Chưa chọn hội thoại nào.';
    renderThreadAutomationControls();
    return;
  }

  els.chatTitle.textContent = thread.title;
  els.chatSubtitle.textContent = thread.type === 'group'
    ? `${thread.totalMember || thread.participantIds?.length || thread.participants?.length || 0} thành viên`
    : 'Chat trực tiếp Zalo';
  els.chatAvatarWrap.innerHTML = renderAvatar(thread.avatarUrl, initials(thread.title), 'avatar large', 'chat-avatar');
  els.renameInput.value = thread.title || '';
  els.assigneeInput.value = thread.assignee || '';
  els.tagsInput.value = (thread.tags || []).join(', ');
  els.autoDeleteSelect.value = String(thread.autoDeleteTtl || 0);
  els.notesInput.value = thread.notes || '';
  renderThreadAutomationControls();

  if (thread.type === 'direct') {
    const user = thread.participants?.[0] || findContact(thread.id) || { id: thread.id, displayName: thread.title, avatarUrl: thread.avatarUrl };
    const relation = relationForUser(user.id);
    els.chatRelationRow.innerHTML = `<span class="${relationChipClass(relation)}">${escapeHtml(relationLabel(relation))}</span>`;
    els.chatSubtitle.textContent = `${relationLabel(relation)} · Chat trực tiếp Zalo`;
    els.chatDirectActions.innerHTML = '';
    mountActionButtons(els.chatDirectActions, directActionButtons(user));
    refreshDirectRelation(user.id, relation).catch(() => null);
  } else {
    els.chatRelationRow.innerHTML = '';
    els.chatDirectActions.innerHTML = '';
  }

  if (els.chatBookingRow) {
    els.chatBookingRow.innerHTML = '';
    els.chatBookingRow.classList.add('hidden');
  }

  els.messageList.className = 'message-list';
  els.messageList.innerHTML = '';

  if (!thread.messages?.length) {
    els.messageList.classList.add('empty-state');
    els.messageList.innerHTML = `<div>${escapeHtml(emptyMessageForThread(thread))}</div>`;
    return;
  }

  const visibleMessages = (thread.messages || []).slice(-120);
  const participants = Array.isArray(thread.participants) ? thread.participants : [];
  for (const group of groupMessagesForDisplay(visibleMessages)) {
    const anchorMessage = group.anchor;
    const row = document.createElement('div');
    row.className = `message-row ${anchorMessage.isOutgoing ? 'outgoing' : 'incoming'}${thread.type === 'group' && !anchorMessage.isOutgoing ? ' group-message' : ''}`;
    const sender = findContact(anchorMessage.senderId) || participants.find((item) => item.id === anchorMessage.senderId);
    const senderName = anchorMessage.isOutgoing ? 'Bạn' : sender?.displayName || sender?.zaloName || 'Người dùng';
    const senderAvatar = sender?.avatarUrl || '';
    const senderProfileId = !anchorMessage.isOutgoing && anchorMessage.senderId ? String(anchorMessage.senderId) : '';
    const canReact = Boolean(anchorMessage.raw?.msgId && anchorMessage.raw?.cliMsgId);
    row.innerHTML = `
      ${thread.type === 'group' && !anchorMessage.isOutgoing ? `<button class="message-side-avatar avatar-hit" type="button" data-open-profile="${escapeAttribute(senderProfileId)}">${renderAvatar(senderAvatar, initials(senderName), 'avatar message-avatar')}</button>` : ''}
      <div class="message-bubble-wrap">
        <div class="message-bubble">
          <div class="message-bubble-head">
            ${senderProfileId ? `<button class="message-author profile-link-btn" type="button" data-open-profile="${escapeAttribute(senderProfileId)}">${escapeHtml(senderName)}</button>` : `<div class="message-author">${escapeHtml(senderName)}</div>`}
            <button class="more-btn message-more-btn" type="button" data-role="message-more">⋯</button>
          </div>
          <div>${renderMessageGroupContent(group)}</div>
          ${renderAutomationTraceForMessage(thread, anchorMessage)}
          ${renderReactionSummaryForGroup(group)}
          ${canReact ? `
            <div class="message-reactions-bar">
              ${REACTION_OPTIONS.slice(0, 6).map((reaction) => `<button class="reaction-btn" type="button" data-role="react" data-icon="${escapeAttribute(reaction.icon)}">${reaction.display}</button>`).join('')}
              <button class="reaction-btn more-reaction-btn" type="button" data-role="message-reactions-more">⋯</button>
            </div>
          ` : ''}
          <div class="message-time">${formatTime(anchorMessage.createdAt)}${isClientLocal(anchorMessage) && anchorMessage.failed ? ' · Gửi lỗi' : (isClientLocal(anchorMessage) && anchorMessage.pending ? ' · Đang gửi' : (isClientLocal(anchorMessage) && anchorMessage.sent ? ' · Đã gửi' : ''))}</div>
        </div>
      </div>
    `;
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, buildMessageMenu(thread, anchorMessage, group));
    });
    row.querySelector('[data-role="message-more"]').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX || row.getBoundingClientRect().right - 8, event.clientY || row.getBoundingClientRect().top + 20, buildMessageMenu(thread, anchorMessage, group));
    });
    const reactionMore = row.querySelector('[data-role="message-reactions-more"]');
    if (reactionMore) {
      reactionMore.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        showContextMenu(event.clientX || row.getBoundingClientRect().right - 8, event.clientY || row.getBoundingClientRect().bottom - 8, buildReactionMenu(anchorMessage));
      });
    }
    row.querySelectorAll('[data-role="react"]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await reactMessage(anchorMessage.id, button.dataset.icon);
      });
    });
    els.messageList.appendChild(row);
  }

  requestAnimationFrame(() => {
    els.messageList.scrollTop = els.messageList.scrollHeight;
  });
}

function renderAutomationTraceForMessage(thread, message) {
  if (!thread || !message || message.isOutgoing) return '';
  const trace = findAutomationTraceForMessage(thread, message);
  if (!trace) return '';
  const nodes = Array.isArray(trace.nodes) ? trace.nodes : [];
  return `
    <details class="ai-message-trace top-gap-sm">
      <summary>AI trace · ${escapeHtml(trace.status || 'info')} · ${escapeHtml(trace.reason || trace.decision || '')}</summary>
      <div class="ai-trace-node-list">
        ${nodes.map((node) => `
          <div class="ai-trace-node ai-trace-${escapeAttribute(node.status || 'info')}">
            <strong>${escapeHtml(node.label || node.stage || 'node')}</strong>
            <span>${escapeHtml(node.detail || node.reason || '')}</span>
          </div>
        `).join('')}
      </div>
      ${trace.replyPreview ? `<div class="small-note top-gap-sm"><strong>Reply:</strong> ${escapeHtml(trace.replyPreview)}</div>` : ''}
      ${trace.error ? `<div class="small-note top-gap-sm" style="color:#b42318;"><strong>Error:</strong> ${escapeHtml(trace.error)}</div>` : ''}
    </details>
  `;
}

function findAutomationTraceForMessage(thread, message) {
  const traces = thread?.automation?.messageTraces;
  if (!traces || typeof traces !== 'object') return null;
  const ids = [message.id, message.raw?.msgId, message.raw?.cliMsgId, message.cliMsgId, message.createdAt]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  for (const id of ids) {
    if (traces[id]) return traces[id];
  }
  return null;
}

function buildThreadMenu(thread) {
  const items = [
    { label: thread.unreadCount ? 'Đánh dấu đã đọc' : 'Đánh dấu chưa đọc', action: () => thread.unreadCount ? markRead() : markUnread() },
    { label: thread.pinned ? 'Bỏ ghim hội thoại' : 'Ghim hội thoại', action: () => toggleThreadFlag('pin', 'pinned') },
    { label: thread.archived ? 'Bỏ lưu trữ' : 'Lưu trữ hội thoại', action: () => toggleThreadFlag('archive', 'archived') },
    { label: thread.hidden ? 'Bỏ ẩn trò chuyện' : 'Ẩn trò chuyện', action: () => toggleThreadFlag('hide', 'hidden') },
    { label: thread.muted ? 'Bật thông báo' : 'Tắt thông báo', action: () => toggleThreadFlag('mute', 'muted') }
  ];
  if (thread.type === 'direct') {
    const user = thread.participants?.[0] || findContact(thread.id) || { id: thread.id, displayName: thread.title, avatarUrl: thread.avatarUrl };
    const relation = relationForUser(user.id);
    if (relation === 'incoming_request') {
      items.push({ label: 'Chấp nhận kết bạn', action: () => acceptFriend(user) });
      items.push({ label: 'Từ chối kết bạn', action: () => rejectFriend(user) });
    } else if (relation === 'outgoing_request') {
      items.push({ label: 'Thu hồi lời mời', action: () => undoFriendRequest(user.id) });
    } else if (relation === 'stranger') {
      items.push({ label: 'Gửi lời mời kết bạn', action: () => requestFriend(user) });
    } else if (relation === 'friend') {
      items.push({ label: 'Huỷ kết bạn', action: () => removeDirectFriend(user) });
    } else if (relation === 'blocked') {
      items.push({ label: 'Bỏ chặn', action: () => unblockDirectUser(user) });
    }
    items.push({ danger: relation !== 'blocked', label: relation === 'blocked' ? 'Đã chặn' : 'Chặn người này', disabled: relation === 'blocked', action: () => blockDirectUser(user) });
  }
  items.push({ type: 'submenu', label: `Tự xoá tin nhắn${thread.autoDelete ? ` (${formatAutoDelete(thread.autoDeleteTtl)})` : ''}`, items: [
    { label: 'Tắt', action: () => setAutoDelete(0) },
    { label: '1 ngày', action: () => setAutoDelete(86400000) },
    { label: '7 ngày', action: () => setAutoDelete(604800000) },
    { label: '14 ngày', action: () => setAutoDelete(1209600000) }
  ]});
  items.push({ danger: true, label: 'Xoá đoạn chat', action: () => deleteThread() });
  return items;
}

function buildMessageMenu(thread, message, group = null) {
  const forwardTarget = group || message;
  const items = [
    { label: 'Trả lời', action: () => startReply(message) },
    { label: 'Chuyển tiếp', action: () => forwardMessageToThread(forwardTarget) },
    { label: 'Ghim tin nhắn', action: () => alert('Ghim từng tin nhắn hiện adapter public chưa có write API, mình đang chỉ đọc được pinned message.') }
  ];
  if (message.isOutgoing && message.raw?.msgId && message.raw?.cliMsgId && !message.deleted) {
    items.push({ label: 'Thu hồi tin nhắn', action: () => undoMessage(message.id) });
  }
  items.push({ label: 'Xoá phía tôi', action: () => deleteMessage(message.id) });
  return items;
}

function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = els.contextMenu;
  menu.innerHTML = '';
  renderMenuItems(menu, items);
  menu.classList.remove('hidden');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - 12) menu.style.left = `${window.innerWidth - rect.width - 12}px`;
  if (rect.bottom > window.innerHeight - 12) menu.style.top = `${window.innerHeight - rect.height - 12}px`;
}

function renderMenuItems(container, items) {
  for (const item of items) {
    if (item.type === 'submenu') {
      const wrap = document.createElement('div');
      wrap.className = 'context-menu-group';
      const title = document.createElement('div');
      title.className = 'context-menu-subtitle';
      title.textContent = item.label;
      wrap.appendChild(title);
      renderMenuItems(wrap, item.items || []);
      container.appendChild(wrap);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `context-menu-item${item.danger ? ' danger' : ''}`;
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    if (item.action) {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        hideContextMenu();
        await item.action();
      });
    }
    container.appendChild(button);
  }
}

function hideContextMenu() {
  els.contextMenu.classList.add('hidden');
  els.contextMenu.innerHTML = '';
}

function handleMessageListClick(event) {
  const previewButton = event.target.closest('[data-preview-image]');
  if (previewButton) {
    event.preventDefault();
    let gallery = [];
    try { gallery = JSON.parse(previewButton.dataset.previewGallery || '[]'); } catch {}
    openImageLightbox(previewButton.dataset.previewImage || '', gallery);
    return;
  }
  const profileTrigger = event.target.closest('[data-open-profile]');
  if (profileTrigger) {
    event.preventDefault();
    const userId = profileTrigger.dataset.openProfile || '';
    if (userId) openThreadProfile(userId);
  }
}

function openImageLightbox(url, urls = []) {
  const items = (Array.isArray(urls) && urls.length ? urls : [url]).filter(Boolean);
  if (!items.length) return;
  state.lightboxImages = items;
  state.lightboxIndex = Math.max(0, items.indexOf(url));
  if (state.lightboxIndex < 0) state.lightboxIndex = 0;
  renderImageLightbox();
  els.imageLightbox.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function renderImageLightbox() {
  const items = Array.isArray(state.lightboxImages) ? state.lightboxImages : [];
  const index = Number(state.lightboxIndex || 0);
  const current = items[index] || items[0] || '';
  if (!current) return;
  els.imageLightboxImg.src = current;
  const multi = items.length > 1;
  if (els.imageLightboxPrev) els.imageLightboxPrev.hidden = !multi;
  if (els.imageLightboxNext) els.imageLightboxNext.hidden = !multi;
}

function stepImageLightbox(delta) {
  const items = Array.isArray(state.lightboxImages) ? state.lightboxImages : [];
  if (items.length < 2) return;
  state.lightboxIndex = (state.lightboxIndex + delta + items.length) % items.length;
  renderImageLightbox();
}

function closeImageLightbox() {
  els.imageLightbox.classList.add('hidden');
  els.imageLightboxImg.removeAttribute('src');
  state.lightboxImages = [];
  state.lightboxIndex = 0;
  document.body.style.overflow = '';
}

function handleImageLightboxClick(event) {
  if (event.target === els.imageLightbox || event.target === els.imageLightboxClose) {
    closeImageLightbox();
  }
}

function handleGlobalKeydown(event) {
  if (event.key === 'Escape' && !els.imageLightbox.classList.contains('hidden')) {
    closeImageLightbox();
    return;
  }
  if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !els.imageLightbox.classList.contains('hidden')) {
    const items = Array.isArray(state.lightboxImages) ? state.lightboxImages : [];
    if (items.length > 1) {
      stepImageLightbox(event.key === 'ArrowRight' ? 1 : -1);
    }
    return;
  }
  if (event.key === 'Escape' && !els.forwardModal.classList.contains('hidden')) {
    closeForwardModal();
    return;
  }
  if (event.key === 'Escape' && !els.bookingBridgeModal.classList.contains('hidden')) {
    closeBookingBridgeModal();
    return;
  }
  if (event.key === 'Escape' && !els.threadProfileModal.classList.contains('hidden')) {
    closeThreadProfile();
  }
}

function renderMessageGroupContent(group) {
  if (group.kind === 'photo-album') {
    const ordered = [...(group.messages || [])].sort((left, right) => {
      const leftIndex = Number(left?.album?.index || 0);
      const rightIndex = Number(right?.album?.index || 0);
      if (leftIndex && rightIndex && leftIndex !== rightIndex) return leftIndex - rightIndex;
      return String(left?.createdAt || '').localeCompare(String(right?.createdAt || ''));
    });
    const urls = ordered.flatMap((message) => {
      const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
      if (attachments.length) {
        return attachments.map((item) => item?.previewUrl || item?.url || '').filter(Boolean);
      }
      const fallback = String(message?.text || '');
      return fallback ? [fallback] : [];
    });
    return `<div class="message-album-grid">${urls.map((url) => renderPreviewableImage(url, 'image message', 'message-image album', urls)).join('')}</div>`;
  }
  return renderMessageContent(group.anchor);
}

function renderReactionSummaryForGroup(group) {
  const messages = Array.isArray(group?.messages) && group.messages.length ? group.messages : [group?.anchor].filter(Boolean);
  const reactions = messages.flatMap((message) => Array.isArray(message?.reactions) ? message.reactions : []);
  if (!reactions.length) return '';
  const groups = new Map();
  for (const reaction of reactions) {
    const key = String(reaction.icon || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(reaction);
  }
  return `<div class="message-reaction-summary">${[...groups.entries()].map(([icon, items]) => {
    const meta = REACTION_OPTIONS.find((item) => item.icon === icon);
    const label = meta?.display || '🙂';
    const tooltip = escapeAttribute(buildReactionHoverText(icon, items));
    return `<span class="reaction-pill" title="${tooltip}" data-tooltip="${tooltip}">${label} ${items.length}</span>`;
  }).join('')}</div>`;
}

function buildReactionHoverText(icon, reactions) {
  const meta = REACTION_OPTIONS.find((item) => item.icon === icon);
  const label = meta?.display || icon || '🙂';
  const names = (reactions || []).map((reaction) => reactionDisplayName(reaction.by)).filter(Boolean);
  const uniqueNames = [...new Set(names)];
  return `${label} ${uniqueNames.length}\n${uniqueNames.join('\n')}`.trim();
}

function reactionDisplayName(userId) {
  const id = String(userId || '');
  if (!id) return 'Không rõ';
  const selfId = String(state.view?.session?.account?.id || state.view?.activeAccountId || '');
  if (id === selfId) return 'Bạn';
  const contact = findContact(id);
  return contact?.displayName || contact?.zaloName || id;
}

function renderMessageContent(message) {
  const text = String(message.text || '');
  const quoteHtml = renderMessageQuote(message);
  const stickerUrl = resolveStickerUrl(message);
  if (stickerUrl || String(message.type || '').includes('sticker')) {
    if (stickerUrl) {
      const safeUrl = escapeAttribute(stickerUrl);
      return `${quoteHtml}<img class="message-sticker" src="${safeUrl}" alt="sticker" loading="lazy" />`;
    }
    queueStickerResolution(message);
    return `${quoteHtml}<div class="muted">[Sticker]</div>`;
  }

  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (attachments.length && attachments.every((item) => item.kind === 'image' && (item.previewUrl || item.url))) {
    if (attachments.length > 1) {
      return `${quoteHtml}<div class="message-album-grid">${attachments.map((item) => renderPreviewableImage(item.previewUrl || item.url, item.name || 'image', 'message-image album')).join('')}</div>`;
    }
    const first = attachments[0];
    return `${quoteHtml}${renderPreviewableImage(first.previewUrl || first.url, first.name || 'image', 'message-image')}`;
  }
  if ((message.type || '').includes('photo') || isImageUrl(text)) {
    return `${quoteHtml}${renderPreviewableImage(text, 'image message', 'message-image')}`;
  }
  if (attachments.length) {
    return `${quoteHtml}${attachments.map((item) => {
      const href = item.url || item.previewUrl || '#';
      return `<a class="message-file-card" href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">📎 <span>${escapeHtml(item.name || 'Tệp đính kèm')}</span></a>`;
    }).join('')}`;
  }
  if (/^https?:\/\//i.test(text)) {
    const safeUrl = escapeAttribute(text);
    return `${quoteHtml}<a href="${safeUrl}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`;
  }
  return `${quoteHtml}<div class="message-text">${renderMessageTextWithMentions(message)}</div>`;
}

function renderMessageQuote(message) {
  const quote = message?.quote;
  if (!quote) return '';
  const ownerName = quote.ownerName || findContact(quote.ownerId)?.displayName || findContact(quote.ownerId)?.zaloName || 'Người dùng';
  const preview = quote.text || '[ảnh/tệp]';
  const ownerAction = quote.ownerId
    ? `<button class="message-quote-author profile-link-btn" type="button" data-open-profile="${escapeAttribute(quote.ownerId)}">${escapeHtml(ownerName)}</button>`
    : `<span class="message-quote-author">${escapeHtml(ownerName)}</span>`;
  return `<div class="message-quote">${ownerAction}<div class="message-quote-text">${escapeHtml(String(preview).slice(0, 160))}</div></div>`;
}

function renderMessageTextWithMentions(message) {
  const text = String(message?.text || '');
  const mentions = Array.isArray(message?.mentions) ? [...message.mentions] : [];
  if (!mentions.length) return escapeHtml(text);
  mentions.sort((left, right) => Number(left.pos || 0) - Number(right.pos || 0));
  let cursor = 0;
  let html = '';
  for (const mention of mentions) {
    const start = Math.max(0, Number(mention?.pos || 0));
    const len = Math.max(0, Number(mention?.len || 0));
    if (!len || start < cursor || start > text.length) continue;
    html += escapeHtml(text.slice(cursor, start));
    const label = text.slice(start, start + len) || mention.text || '';
    const uid = String(mention?.uid || '');
    html += uid
      ? `<button class="mention-chip profile-link-btn" type="button" data-open-profile="${escapeAttribute(uid)}">${escapeHtml(label)}</button>`
      : escapeHtml(label);
    cursor = start + len;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

function renderPreviewableImage(url, alt, className = 'message-image', gallery = []) {
  const safeUrl = escapeAttribute(url || '');
  const safeGallery = escapeAttribute(JSON.stringify(gallery || []));
  return `<button class="image-preview-btn" type="button" data-preview-image="${safeUrl}" data-preview-gallery="${safeGallery}"><img class="${className}" src="${safeUrl}" alt="${escapeAttribute(alt || 'image')}" loading="lazy" /></button>`;
}

function resolveStickerUrl(message) {
  return message?.sticker?.webpUrl
    || message?.sticker?.url
    || message?.sticker?.stickerWebpUrl
    || message?.sticker?.stickerUrl
    || null;
}

function queueStickerResolution(message) {
  const cateId = Number(message?.sticker?.cateId || message?.raw?.content?.cateId || message?.raw?.content?.cate_id || message?.raw?.content?.catId || 0);
  const stickerId = Number(message?.sticker?.id || message?.raw?.content?.id || message?.raw?.content?.stickerId || 0);
  if (!cateId || !stickerId) return;
  const cacheKey = String(cateId);
  if (state.pendingStickerLoads.has(cacheKey) || state.stickerPackDetails[cacheKey]) return;
  state.pendingStickerLoads.add(cacheKey);
  getJson(`/api/stickers/pack?cateId=${encodeURIComponent(cateId)}`)
    .then((data) => {
      state.stickerPackDetails[cacheKey] = data.items || [];
      for (const thread of state.view?.threads || []) {
        for (const item of thread.messages || []) {
          const itemCateId = Number(item?.sticker?.cateId || item?.raw?.content?.cateId || item?.raw?.content?.cate_id || item?.raw?.content?.catId || 0);
          const itemStickerId = Number(item?.sticker?.id || item?.raw?.content?.id || item?.raw?.content?.stickerId || 0);
          if (itemCateId !== cateId || itemStickerId !== stickerId) continue;
          const matched = (state.stickerPackDetails[cacheKey] || []).find((sticker) => Number(sticker?.id || 0) === itemStickerId);
          if (matched) item.sticker = { ...(item.sticker || {}), ...matched, url: matched.stickerWebpUrl || matched.stickerUrl || matched.thumbUrl || null, webpUrl: matched.stickerWebpUrl || null };
        }
      }
      if (currentThread()?.messages?.some((item) => Number(item?.sticker?.cateId || item?.raw?.content?.cateId || item?.raw?.content?.cate_id || item?.raw?.content?.catId || 0) === cateId)) renderMessages();
    })
    .catch(() => null)
    .finally(() => {
      state.pendingStickerLoads.delete(cacheKey);
    });
}

function groupMessagesForDisplay(messages) {
  const out = [];
  for (const message of messages || []) {
    const prev = out[out.length - 1];
    if (prev && canMergePhotoAlbum(prev.anchor, message)) {
      prev.kind = 'photo-album';
      prev.messages.push(message);
      continue;
    }
    out.push({ kind: 'single', anchor: message, messages: [message] });
  }
  return out;
}

function canMergePhotoAlbum(left, right) {
  if (!left || !right) return false;
  const leftPhoto = isImageMessage(left);
  const rightPhoto = isImageMessage(right);
  if (!leftPhoto || !rightPhoto) return false;
  if (String(left.threadId) !== String(right.threadId)) return false;
  if (String(left.senderId) !== String(right.senderId)) return false;
  if (Boolean(left.isOutgoing) !== Boolean(right.isOutgoing)) return false;
  const leftAlbum = String(left?.album?.groupId || '');
  const rightAlbum = String(right?.album?.groupId || '');
  if (leftAlbum || rightAlbum) return leftAlbum && leftAlbum === rightAlbum;
  if ((left.reactions?.length || 0) > 0 || (right.reactions?.length || 0) > 0) return false;
  const leftMsgId = String(left?.raw?.msgId || left?.id || '');
  const rightMsgId = String(right?.raw?.msgId || right?.id || '');
  if (leftMsgId && rightMsgId && leftMsgId === rightMsgId) return true;
  const leftTs = new Date(left.createdAt || 0).getTime();
  const rightTs = new Date(right.createdAt || 0).getTime();
  return Math.abs(rightTs - leftTs) <= 2000;
}

function isImageMessage(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (attachments.length && attachments.every((item) => item.kind === 'image')) return true;
  return (String(message?.type || '').includes('photo') || isImageUrl(message?.text || '')) && !String(message?.type || '').includes('sticker');
}

function isImageUrl(value) {
  return /^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(String(value || '')) || String(value || '').includes('/jpg/') || String(value || '').includes('data:image/');
}

function toggleThreadMeta(event) {
  if (event) event.stopPropagation();
  const willOpen = els.threadDetails.classList.contains('hidden');
  els.threadDetails.classList.toggle('hidden');
  if (willOpen) loadThreadMemory({ force: false }).catch(() => null);
}

function hideThreadMeta() {
  els.threadDetails.classList.add('hidden');
}

function renderTagPicker() {
  const thread = currentThread();
  const labels = state.view?.labels?.items || [];
  const selected = selectedTags();
  els.availableTags.innerHTML = '';
  if (!thread) return;

  for (const label of labels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tag-chip ${selected.includes(label.text) ? 'active' : ''}`;
    button.textContent = label.text;
    button.style.borderColor = label.color || '#2a3b5b';
    button.addEventListener('click', () => toggleTag(label.text));
    els.availableTags.appendChild(button);
  }
}


function renderReplyPreview() {
  if (!state.replyTo) {
    els.replyPreview.classList.add('hidden');
    els.replyPreview.innerHTML = '';
    return;
  }
  const sender = findContact(state.replyTo.senderId);
  const senderName = state.replyTo.isOutgoing ? 'Bạn' : sender?.displayName || sender?.zaloName || 'Người dùng';
  els.replyPreview.classList.remove('hidden');
  els.replyPreview.innerHTML = `<div class="reply-preview-text"><strong>Đang trả lời ${escapeHtml(senderName)}:</strong> ${escapeHtml(String(state.replyTo.text || '[ảnh/tệp]').slice(0, 120))}</div><button type="button" class="ghost-btn" data-role="reply-cancel">Bỏ</button>`;
  els.replyPreview.querySelector('[data-role="reply-cancel"]').addEventListener('click', () => {
    state.replyTo = null;
    saveComposerDraft();
    renderReplyPreview();
  });
}

function startReply(message) {
  state.replyTo = message;
  const thread = currentThread();
  const replyMention = buildReplyMentionMeta(thread, message);
  if (replyMention && !els.messageInput.value.startsWith(replyMention.text)) {
    els.messageInput.value = `${replyMention.text}${els.messageInput.value}`;
  }
  saveComposerDraft();
  renderReplyPreview();
  els.messageInput.focus();
}

function buildReplyMentionMeta(thread, message) {
  if (!thread || thread.type !== 'group' || !message || message.isOutgoing) return null;
  const sender = findContact(message.senderId) || (thread.participants || []).find((item) => String(item.id) === String(message.senderId));
  const displayName = sender?.displayName || sender?.zaloName || '';
  if (!displayName || !message.senderId) return null;
  const token = `@${displayName}`;
  return {
    uid: String(message.senderId),
    text: `${token} `,
    token,
    pos: 0,
    len: token.length
  };
}

async function forwardMessageToThread(message) {
  const threads = (state.view?.threads || []).filter((item) => item.id !== state.activeThreadId);
  if (!threads.length) return alert('Không có hội thoại khác để chuyển tiếp.');
  state.forwardMessage = message;
  state.forwardSearchQuery = '';
  state.forwardTargetId = null;
  state.forwardSending = false;
  state.forwardStatus = 'Chọn một hội thoại để chuyển tiếp.';
  els.forwardSearch.value = '';
  renderForwardThreadList();
  renderForwardComposerState();
  els.forwardModal.classList.remove('hidden');
  setTimeout(() => els.forwardSearch?.focus(), 0);
}

function closeForwardModal() {
  state.forwardMessage = null;
  state.forwardSearchQuery = '';
  state.forwardTargetId = null;
  state.forwardSending = false;
  state.forwardStatus = '';
  if (els.forwardSearch) els.forwardSearch.value = '';
  renderForwardComposerState();
  els.forwardModal.classList.add('hidden');
}

function renderForwardThreadList() {
  const query = state.forwardSearchQuery.trim().toLowerCase();
  const threads = (state.view?.threads || []).filter((item) => item.id !== state.activeThreadId);
  const filtered = query
    ? threads.filter((item) => [item.title, item.lastMessageText, ...(item.participants || []).map((p) => p.displayName || p.zaloName || p.id)].filter(Boolean).join(' ').toLowerCase().includes(query))
    : threads;
  els.forwardThreadList.innerHTML = '';
  if (!filtered.length) {
    els.forwardThreadList.innerHTML = '<div class="muted">Không tìm thấy hội thoại phù hợp.</div>';
    return;
  }
  for (const thread of filtered.slice(0, 80)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'forward-thread-item';
    button.innerHTML = `
      ${renderAvatar(thread.avatarUrl, initials(thread.title), 'avatar')}
      <div class="forward-thread-meta">
        <strong>${escapeHtml(thread.title || thread.id)}</strong>
        <div class="muted">${escapeHtml(thread.lastMessageText || (thread.type === 'group' ? `${thread.totalMember || 0} thành viên` : 'Chat trực tiếp Zalo'))}</div>
      </div>
      <span class="mini-chip">${thread.type === 'group' ? 'Nhóm' : 'Chat'}</span>
    `;
    if (String(state.forwardTargetId || '') === String(thread.id)) button.classList.add('selected');
    button.addEventListener('click', () => {
      state.forwardTargetId = thread.id;
      state.forwardStatus = `Đã chọn: ${thread.title}`;
      renderForwardThreadList();
      renderForwardComposerState();
    });
    els.forwardThreadList.appendChild(button);
  }
}

function renderForwardComposerState() {
  if (els.forwardStatus) els.forwardStatus.textContent = state.forwardStatus || 'Chọn một hội thoại để chuyển tiếp.';
  if (els.forwardSend) {
    els.forwardSend.disabled = !state.forwardTargetId || state.forwardSending;
    els.forwardSend.textContent = state.forwardSending ? 'Đang gửi...' : 'Gửi';
  }
}

async function submitForwardSelection() {
  const thread = (state.view?.threads || []).find((item) => String(item.id) === String(state.forwardTargetId || ''));
  if (!thread) {
    state.forwardStatus = 'Chưa chọn hội thoại nhận.';
    renderForwardComposerState();
    return;
  }
  await submitForwardToThread(thread);
}

async function submitForwardToThread(thread) {
  const message = state.forwardMessage;
  if (!message || !thread) return;
  const payload = buildForwardPayload(thread.id, message);
  if (!payload) {
    state.forwardStatus = 'Tin nhắn này chưa hỗ trợ chuyển tiếp theo đường hiện tại.';
    renderForwardComposerState();
    return;
  }
  state.forwardSending = true;
  state.forwardStatus = `Đang gửi tới ${thread.title}...`;
  renderForwardComposerState();
  try {
    await post('/api/messages/send', payload, { timeoutMs: 60000 });
    state.forwardStatus = `Đã gửi tới ${thread.title}`;
    renderForwardComposerState();
    setTimeout(() => {
      if (state.forwardSending) return;
      closeForwardModal();
    }, 700);
    showAppNotice(`Đã chuyển tiếp sang ${thread.title}`, 'warning');
  } catch (error) {
    state.forwardStatus = error.message || 'Không gửi được.';
    showAppNotice(error.message || 'Không gửi được.', 'danger');
    renderForwardComposerState();
  } finally {
    state.forwardSending = false;
    renderForwardComposerState();
  }
}

function buildForwardPayload(threadId, messageOrGroup) {
  const groupMessages = Array.isArray(messageOrGroup?.messages) ? messageOrGroup.messages : [messageOrGroup];
  const imageUrls = groupMessages
    .flatMap((item) => Array.isArray(item?.attachments) ? item.attachments : [])
    .map((item) => item?.url || item?.previewUrl || '')
    .filter((url) => /^https?:\/\//i.test(String(url || '')));
  if (imageUrls.length) {
    return { threadId, text: '', attachmentsUrls: imageUrls };
  }
  const text = groupMessages.map((item) => String(item?.text || '').trim()).filter(Boolean).join('\n');
  if (!text) return null;
  return { threadId, text };
}

function renderQuickMessages() {
  const items = state.view?.zalo?.quickMessages || [];
  els.quickMessages.innerHTML = '';
  if (!items.length) return;
  for (const item of items.slice(0, 8)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quick-chip';
    button.textContent = item.keyword;
    button.title = item.message?.title || '';
    button.addEventListener('click', () => {
      els.messageInput.value = item.message?.title || '';
      els.messageInput.focus();
    });
    els.quickMessages.appendChild(button);
  }
}

function renderSocialPanels() {
  renderIncomingRequests();
  renderRecommendations();
  renderSentRequests();
  renderBlockedUsers();
  renderFriendsList();
  renderAutoReplies();
}

function sentRequestMap() {
  return new Map((state.view?.zalo?.sentRequests || []).map((item) => [String(item.id), item]));
}

function incomingRequestMap() {
  return new Map((state.view?.zalo?.incomingRequests || []).map((item) => [String(item.id), item]));
}

function blockedUserMap() {
  return new Map((state.view?.zalo?.blockedUsers || []).map((item) => [String(item.id), item]));
}

function friendContactMap() {
  return new Map((state.view?.contacts || []).filter((item) => String(item.kind || '') === 'friend').map((item) => [String(item.id), item]));
}

function relationForUser(userId) {
  const id = String(userId || '');
  if (!id) return 'unknown';
  if (blockedUserMap().has(id)) return 'blocked';
  if (friendContactMap().has(id)) return 'friend';
  if (incomingRequestMap().has(id)) return 'incoming_request';
  if (sentRequestMap().has(id)) return 'outgoing_request';
  const contact = findContact(id);
  if (String(contact?.kind || '') === 'blocked') return 'blocked';
  if (String(contact?.kind || '') === 'friend') return 'friend';
  return 'stranger';
}

function relationLabel(relation) {
  if (relation === 'friend') return 'Bạn bè';
  if (relation === 'incoming_request') return 'Đã nhận lời mời';
  if (relation === 'outgoing_request') return 'Đã gửi lời mời';
  if (relation === 'blocked') return 'Đã chặn';
  if (relation === 'stranger') return 'Người lạ';
  return 'Không rõ';
}

function relationChipClass(relation) {
  if (relation === 'friend') return 'mini-chip relation-chip relation-friend';
  if (relation === 'incoming_request') return 'mini-chip relation-chip relation-incoming';
  if (relation === 'outgoing_request') return 'mini-chip relation-chip relation-outgoing';
  if (relation === 'blocked') return 'mini-chip relation-chip relation-blocked';
  return 'mini-chip relation-chip relation-stranger';
}

function directActionButtons(user) {
  const id = String(user?.id || '');
  if (!id) return [];
  const relation = relationForUser(id);
  if (relation === 'friend') return [
    { label: 'Huỷ kết bạn', className: 'secondary-btn', action: () => removeDirectFriend(user) },
    { label: 'Chặn', className: 'danger-btn', action: () => blockDirectUser(user) }
  ];
  if (relation === 'incoming_request') {
    return [
      { label: 'Chấp nhận', className: 'primary-btn', action: () => acceptFriend(user) },
      { label: 'Từ chối', className: 'secondary-btn', action: () => rejectFriend(user) },
      { label: 'Chặn', className: 'danger-btn', action: () => blockDirectUser(user) }
    ];
  }
  if (relation === 'outgoing_request') {
    return [
      { label: 'Thu hồi', className: 'secondary-btn', action: () => undoFriendRequest(id) },
      { label: 'Chặn', className: 'danger-btn', action: () => blockDirectUser(user) }
    ];
  }
  if (relation === 'blocked') return [{ label: 'Bỏ chặn', className: 'secondary-btn', action: () => unblockDirectUser(user) }];
  return [
    { label: 'Kết bạn', className: 'primary-btn', action: () => requestFriend(user) },
    { label: 'Chặn', className: 'danger-btn', action: () => blockDirectUser(user) }
  ];
}

function renderIncomingRequests() {
  const items = state.view?.zalo?.incomingRequests || [];
  els.incomingRequests.innerHTML = '';
  if (!items.length) return els.incomingRequests.innerHTML = '<div class="muted">Chưa có lời mời kết bạn mới.</div>';
  for (const item of items.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'friend-result-item';
    row.innerHTML = `
      ${renderAvatar(item.avatarUrl, initials(item.displayName || '?'))}
      <div class="friend-result-meta">
        <strong>${escapeHtml(item.displayName || item.id)}</strong>
        <div class="muted">${escapeHtml(item.message || item.phoneNumber || '')}</div>
      </div>
      <div class="inline-actions"></div>
    `;
    const actionWrap = row.querySelector('.inline-actions');
    mountActionButtons(actionWrap, [
      { label: 'Nhận', className: 'primary-btn friend-add-btn', action: () => acceptFriend(item) },
      { label: 'Từ chối', className: 'secondary-btn friend-add-btn', action: () => rejectFriend(item) },
      { label: 'Chặn', className: 'danger-btn friend-add-btn', action: () => blockDirectUser(item) }
    ]);
    els.incomingRequests.appendChild(row);
  }
}

function renderRecommendations() {
  const items = state.view?.zalo?.recommendations || [];
  els.recommendations.innerHTML = '';
  if (!items.length) return els.recommendations.innerHTML = '<div class="muted">Hiện chưa có gợi ý.</div>';
  for (const item of items.slice(0, 10)) {
    const row = document.createElement('div');
    row.className = 'friend-result-item';
    const relation = relationForUser(item.id);
    row.innerHTML = `
      ${renderAvatar(item.avatarUrl, initials(item.displayName || '?'))}
      <div class="friend-result-meta">
        <strong>${escapeHtml(item.displayName || item.id)}</strong>
        <div class="muted">${escapeHtml(item.reason || item.phoneNumber || '')}</div>
      </div>
      <div class="inline-actions"><span class="${relationChipClass(relation)}">${escapeHtml(relationLabel(relation))}</span></div>
    `;
    const actionWrap = row.querySelector('.inline-actions');
    mountActionButtons(actionWrap, directActionButtons(item), true);
    els.recommendations.appendChild(row);
  }
}

function renderSentRequests() {
  const items = state.view?.zalo?.sentRequests || [];
  els.sentRequests.innerHTML = '';
  if (!items.length) return els.sentRequests.innerHTML = '<div class="muted">Chưa có lời mời kết bạn nào đang chờ.</div>';
  for (const item of items.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'friend-result-item';
    row.innerHTML = `
      ${renderAvatar(item.avatarUrl, initials(item.displayName || '?'))}
      <div class="friend-result-meta">
        <strong>${escapeHtml(item.displayName || item.id)}</strong>
        <div class="muted">${escapeHtml(item.message || '')}</div>
      </div>
      <div class="inline-actions"></div>
    `;
    mountActionButtons(row.querySelector('.inline-actions'), [
      { label: 'Thu hồi', className: 'secondary-btn friend-add-btn', action: () => undoFriendRequest(item.id) },
      { label: 'Chặn', className: 'danger-btn friend-add-btn', action: () => blockDirectUser(item) }
    ]);
    els.sentRequests.appendChild(row);
  }
}

function renderBlockedUsers() {
  const items = state.view?.zalo?.blockedUsers || [];
  els.blockedUsers.innerHTML = '';
  if (!items.length) return els.blockedUsers.innerHTML = '<div class="muted">Chưa chặn ai trên web này.</div>';
  for (const item of items.slice(0, 50)) {
    const row = document.createElement('div');
    row.className = 'friend-result-item';
    row.innerHTML = `
      ${renderAvatar(item.avatarUrl, initials(item.displayName || '?'))}
      <div class="friend-result-meta">
        <strong>${escapeHtml(item.displayName || item.id)}</strong>
        <div class="muted">${escapeHtml(item.phoneNumber || item.id || '')}</div>
      </div>
      <div class="inline-actions"></div>
    `;
    mountActionButtons(row.querySelector('.inline-actions'), [
      { label: 'Bỏ chặn', className: 'secondary-btn friend-add-btn', action: () => unblockDirectUser(item) }
    ]);
    els.blockedUsers.appendChild(row);
  }
}

function renderFriendsList() {
  const items = [...friendContactMap().values()].sort((a, b) => String(a.displayName || a.id).localeCompare(String(b.displayName || b.id)));
  els.friendList.innerHTML = '';
  if (!items.length) return els.friendList.innerHTML = '<div class="muted">Chưa thấy dữ liệu bạn bè. Bấm Đồng bộ lại nếu vừa đăng nhập.</div>';
  for (const item of items.slice(0, 100)) {
    const row = document.createElement('div');
    row.className = 'friend-result-item';
    row.innerHTML = `
      ${renderAvatar(item.avatarUrl, initials(item.displayName || item.id || '?'))}
      <div class="friend-result-meta">
        <strong>${escapeHtml(item.displayName || item.id)}</strong>
        <div class="muted">${escapeHtml(item.phoneNumber || item.id || '')}</div>
      </div>
    `;
    els.friendList.appendChild(row);
  }
}

function renderAutoReplies() {
  const items = state.view?.zalo?.autoReplies || [];
  els.autoReplies.innerHTML = '';
  if (!items.length) return els.autoReplies.innerHTML = '<div class="muted">Chưa có auto reply.</div>';
  for (const item of items.slice(0, 10)) {
    const row = document.createElement('div');
    row.className = 'simple-card';
    row.innerHTML = `<div><strong>${item.enable ? 'Bật' : 'Tắt'}</strong></div><div class="muted">${escapeHtml(item.content || '')}</div>`;
    els.autoReplies.appendChild(row);
  }
}

async function searchFriends() {
  const query = els.friendSearchInput.value.trim();
  if (!query) return els.friendSearchResults.textContent = 'Nhập username hoặc số điện thoại để tìm.';
  els.friendSearchResults.textContent = 'Đang tìm...';
  try {
    const res = await getJson(`/api/friends/search?q=${encodeURIComponent(query)}`);
    renderFriendSearchResults(res.items || []);
  } catch (error) {
    els.friendSearchResults.textContent = error.message || 'Không tìm được';
  }
}

function handleIntegratedSearchInput() {
  scheduleIntegratedRemoteSearch();
  renderThreads();
}

function scheduleIntegratedRemoteSearch() {
  const rawQuery = els.threadSearch.value.trim();
  const normalizedQuery = normalizeSearchText(rawQuery);
  if (state.integratedSearch.timer) {
    clearTimeout(state.integratedSearch.timer);
    state.integratedSearch.timer = null;
  }
  if (!normalizedQuery) {
    state.integratedSearch.remoteItems = [];
    state.integratedSearch.loading = false;
    state.integratedSearch.query = '';
    return;
  }
  state.integratedSearch.loading = true;
  state.integratedSearch.query = normalizedQuery;
  const seq = ++state.integratedSearch.seq;
  state.integratedSearch.timer = setTimeout(async () => {
    try {
      const res = await getJson(`/api/friends/search?q=${encodeURIComponent(rawQuery)}`);
      if (seq !== state.integratedSearch.seq) return;
      state.integratedSearch.remoteItems = dedupeIntegratedRemoteUsers(res.items || []);
    } catch {
      if (seq !== state.integratedSearch.seq) return;
      state.integratedSearch.remoteItems = [];
    } finally {
      if (seq === state.integratedSearch.seq) {
        state.integratedSearch.loading = false;
        renderThreads();
      }
    }
  }, 260);
}

function dedupeIntegratedRemoteUsers(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const id = String(item?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function openIntegratedSearchUser(user) {
  const id = String(user?.id || '').trim();
  if (!id) return;
  const existing = buildThreadSearchPool().find((thread) => String(thread.id) === id);
  if (existing) {
    openSearchThread(existing);
    return;
  }
  openSearchThread({
    id,
    title: user.displayName || user.zaloName || user.username || id,
    type: 'direct',
    participantIds: [id],
    participants: [{
      ...(findContact(id) || {}),
      ...user,
      id,
      kind: relationForUser(id) === 'friend' ? 'friend' : 'stranger'
    }],
    avatarUrl: user.avatarUrl || '',
    source: relationForUser(id) === 'friend' ? 'friend' : 'stranger',
    unreadCount: 0,
    tags: [],
    messages: [],
    lastMessageText: '',
    lastMessageAt: '',
    searchHint: [user.zaloName, user.username, user.phoneNumber, relationLabel(relationForUser(id))].filter(Boolean).join(' · '),
    isVirtualSearchResult: true
  });
}

function renderFriendSearchResults(items) {
  els.friendSearchResults.innerHTML = '';
  if (!items.length) return els.friendSearchResults.textContent = 'Không tìm thấy tài khoản phù hợp.';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'friend-result-item';
    const relation = item.isFriend ? 'friend' : item.isRequesting ? 'incoming_request' : item.isRequested ? 'outgoing_request' : relationForUser(item.id);
    row.innerHTML = `
      ${renderAvatar(item.avatarUrl, initials(item.displayName || item.username || '?'))}
      <div class="friend-result-meta">
        <strong>${escapeHtml(item.displayName || item.username || item.id)}</strong>
        <div class="muted">${escapeHtml(item.username || item.id)}</div>
      </div>
      <div class="inline-actions"><span class="${relationChipClass(relation)}">${escapeHtml(relationLabel(relation))}</span></div>
    `;
    mountActionButtons(row.querySelector('.inline-actions'), directActionButtons(item), true);
    els.friendSearchResults.appendChild(row);
  }
}

function mountActionButtons(container, buttons, preserveStatusChip = false) {
  if (!container) return;
  if (!preserveStatusChip) container.innerHTML = '';
  for (const button of buttons || []) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = button.className || 'secondary-btn';
    node.textContent = button.label;
    node.addEventListener('click', button.action);
    container.appendChild(node);
  }
}

async function requestFriend(item) {
  try {
    const nextItem = {
      id: String(item.id),
      displayName: item.displayName || item.username || item.id,
      avatarUrl: item.avatarUrl || '',
      message: '',
      time: Date.now()
    };
    const rest = (state.view?.zalo?.sentRequests || []).filter((entry) => String(entry.id) !== String(item.id));
    if (state.view?.zalo) state.view.zalo.sentRequests = [nextItem, ...rest];
    if (state.view?.zalo) state.view.zalo.recommendations = (state.view.zalo.recommendations || []).filter((entry) => String(entry.id) !== String(item.id));
    renderSocialPanels();
    await post('/api/friends/request', { userId: item.id, message: '', profile: item });
    await reloadState();
  } catch (error) {
    await reloadState().catch(() => null);
    showAppNotice(error.message || 'Gửi lời mời thất bại', 'danger');
  }
}

async function acceptFriend(item) {
  try {
    await post('/api/friends/request/accept', { userId: item.id, profile: item });
    await reloadState();
  } catch (error) {
    await reloadState().catch(() => null);
    showAppNotice(error.message || 'Chấp nhận kết bạn thất bại', 'danger');
  }
}

async function rejectFriend(item) {
  try {
    await post('/api/friends/request/reject', { userId: item.id, profile: item });
    await reloadState();
  } catch (error) {
    await reloadState().catch(() => null);
    showAppNotice(error.message || 'Từ chối kết bạn thất bại', 'danger');
  }
}

async function removeDirectFriend(item) {
  if (!confirm(`Huỷ kết bạn với ${item.displayName || item.username || item.id}?`)) return;
  try {
    await post('/api/friends/remove', { userId: item.id, profile: item });
    await reloadState();
  } catch (error) {
    await reloadState().catch(() => null);
    showAppNotice(error.message || 'Huỷ kết bạn thất bại', 'danger');
  }
}

async function blockDirectUser(item) {
  try {
    await post('/api/friends/block', { userId: item.id, profile: item });
    await reloadState();
  } catch (error) {
    await reloadState().catch(() => null);
    showAppNotice(error.message || 'Chặn người dùng thất bại', 'danger');
  }
}

async function unblockDirectUser(item) {
  try {
    await post('/api/friends/unblock', { userId: item.id, profile: item });
    await reloadState();
  } catch (error) {
    await reloadState().catch(() => null);
    showAppNotice(error.message || 'Bỏ chặn thất bại', 'danger');
  }
}

async function toggleTag(tag) {
  const current = selectedTags();
  const next = current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag];
  els.tagsInput.value = next.join(', ');
  renderTagPicker();
  await saveMeta({ silent: true });
}

function selectedTags() {
  return [...new Set(els.tagsInput.value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function renderEmojiPanel() {
  els.emojiPanel.innerHTML = EMOJI_CHOICES.map((emoji) => `<button type="button" class="emoji-btn" data-emoji="${emoji}">${emoji}</button>`).join('');
  for (const button of els.emojiPanel.querySelectorAll('[data-emoji]')) {
    button.addEventListener('click', () => insertEmoji(button.dataset.emoji || ''));
  }
}

function insertEmoji(emoji) {
  if (!emoji) return;
  const start = els.messageInput.selectionStart || els.messageInput.value.length;
  const end = els.messageInput.selectionEnd || els.messageInput.value.length;
  const value = els.messageInput.value;
  els.messageInput.value = `${value.slice(0, start)}${emoji}${value.slice(end)}`;
  const nextPos = start + emoji.length;
  els.messageInput.focus();
  els.messageInput.setSelectionRange(nextPos, nextPos);
  saveComposerDraft();
}

function handleComposerInput() {
  saveComposerDraft();
}

function toggleComposerPanel(name) {
  const next = state.composerPanel === name ? null : name;
  state.composerPanel = next;
  els.composerTray.classList.toggle('hidden', !next && !state.pendingAttachments.length);
  els.emojiPanel.classList.toggle('hidden', next !== 'emoji');
  els.stickerPanel.classList.toggle('hidden', next !== 'sticker');
  els.attachmentPreview.classList.toggle('hidden', !state.pendingAttachments.length);
  els.btnEmoji.classList.toggle('active', next === 'emoji');
  els.btnSticker.classList.toggle('active', next === 'sticker');
  if (next === 'sticker') ensureStickerCatalogLoaded();
}

async function handleFilePicked(event) {
  const files = [...(event.target.files || [])];
  event.target.value = '';
  if (!files.length) return;
  await addPendingFiles(files);
}

async function addPendingFiles(files) {
  try {
    validateSelectedFiles(files);
    const mapped = await Promise.all(files.map(readSelectedFile));
    state.pendingAttachments = dedupePendingAttachments([...(state.pendingAttachments || []), ...mapped]);
    saveComposerDraft();
    renderAttachmentPreview();
    toggleComposerPanel(state.composerPanel);
    hideAppNotice();
  } catch (error) {
    showAppNotice(error.message || 'Không thêm được tệp đính kèm.', 'danger');
  }
}

async function handleComposerPaste(event) {
  const items = [...(event.clipboardData?.items || [])];
  const imageFiles = items
    .filter((item) => item.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map((item, index) => {
      const file = item.getAsFile();
      if (!file) return null;
      const ext = String(file.type || 'image/png').split('/')[1] || 'png';
      return new File([file], file.name || `pasted-image-${Date.now()}-${index + 1}.${ext}`, { type: file.type || 'image/png' });
    })
    .filter(Boolean);
  if (!imageFiles.length) return;
  event.preventDefault();
  await addPendingFiles(imageFiles);
}

function validateSelectedFiles(files) {
  for (const file of files || []) {
    if (!file.size) throw new Error(`Tệp ${file.name} rỗng hoặc không hợp lệ.`);
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error(`Tệp ${file.name} vượt quá giới hạn 25MB nên không thể gửi.`);
    }
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 10 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

function shortNumber(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return '0';
  if (num >= 1000000) return `${Math.round(num / 100000) / 10}M`;
  if (num >= 1000) return `${Math.round(num / 100) / 10}K`;
  return String(num);
}

function readSelectedFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const [, data = ''] = result.split(',', 2);
      resolve({
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        data,
        previewUrl: file.type.startsWith('image/') ? result : null,
        clientSignature: `${file.type || 'application/octet-stream'}:${file.size}:${data.slice(0, 120)}`
      });
    };
    reader.onerror = () => reject(new Error(`Không đọc được tệp ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function dedupePendingAttachments(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const key = String(item?.clientSignature || `${item?.contentType || ''}:${item?.size || 0}:${String(item?.name || '')}:${String(item?.data || '').slice(0, 120)}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function renderAttachmentPreview() {
  if (!state.pendingAttachments.length) {
    els.attachmentPreview.classList.add('hidden');
    els.attachmentPreview.innerHTML = '';
    els.composerTray.classList.toggle('hidden', !state.composerPanel);
    return;
  }
  els.attachmentPreview.classList.remove('hidden');
  els.composerTray.classList.remove('hidden');
  els.attachmentPreview.innerHTML = state.pendingAttachments.map((item, index) => `
    <div class="attachment-chip">
      <button class="attachment-remove" type="button" data-remove-attachment="${index}">×</button>
      ${item.previewUrl ? `<img src="${escapeAttribute(item.previewUrl)}" alt="${escapeAttribute(item.name)}" />` : ''}
      <div class="attachment-chip-meta">${escapeHtml(item.name)}<br><span class="attachment-chip-size">${escapeHtml(formatBytes(item.size || 0))}</span></div>
    </div>
  `).join('');
  for (const button of els.attachmentPreview.querySelectorAll('[data-remove-attachment]')) {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.removeAttachment);
      state.pendingAttachments.splice(index, 1);
      saveComposerDraft();
      renderAttachmentPreview();
    });
  }
}

async function ensureStickerCatalogLoaded() {
  if (state.stickerPacks.length) return;
  els.stickerGrid.innerHTML = 'Đang tải sticker...';
  try {
    const data = await getJson('/api/stickers/packs');
    state.stickerPacks = data.items || [];
    els.stickerPackCount.textContent = `${state.stickerPacks.length} pack`;
    renderStickerPackList();
    if (state.stickerPacks[0]?.cateId) {
      await openStickerPack(state.stickerPacks[0].cateId);
    } else {
      els.stickerGrid.innerHTML = 'Không có sticker khả dụng.';
    }
  } catch (error) {
    els.stickerGrid.innerHTML = 'Không tải được sticker.';
    showAppNotice(error.message || 'Không tải được sticker.', 'danger');
  }
}

function renderStickerPackList() {
  els.stickerPackList.innerHTML = state.stickerPacks.map((pack) => `
    <button type="button" class="sticker-pack-btn ${Number(pack.cateId) === Number(state.activeStickerCateId) ? 'active' : ''}" data-cate-id="${pack.cateId}">
      <img src="${escapeAttribute(pack.iconUrl || pack.thumbImg || '')}" alt="${escapeAttribute(pack.name || '')}" />
      <div class="sticker-pack-name">${escapeHtml(pack.name || '')}</div>
    </button>
  `).join('');
  for (const button of els.stickerPackList.querySelectorAll('[data-cate-id]')) {
    button.addEventListener('click', () => openStickerPack(Number(button.dataset.cateId)));
  }
}

async function openStickerPack(cateId) {
  state.activeStickerCateId = Number(cateId);
  renderStickerPackList();
  try {
    if (!state.stickerPackDetails[cateId]) {
      els.stickerGrid.innerHTML = 'Đang tải sticker trong pack...';
      const data = await getJson(`/api/stickers/pack?cateId=${encodeURIComponent(cateId)}`);
      state.stickerPackDetails[cateId] = data.items || [];
    }
    const items = state.stickerPackDetails[cateId] || [];
    if (!items.length) {
      els.stickerGrid.innerHTML = 'Pack này chưa lấy được sticker.';
      return;
    }
    els.stickerGrid.innerHTML = items.map((item, index) => `
      <button type="button" class="sticker-btn" data-sticker-key="${cateId}:${index}">
        <img src="${escapeAttribute(item.stickerWebpUrl || item.stickerUrl || item.thumbUrl || '')}" alt="${escapeAttribute(item.text || 'sticker')}" />
      </button>
    `).join('');
    for (const button of els.stickerGrid.querySelectorAll('[data-sticker-key]')) {
      button.addEventListener('click', async () => {
        const [, idx] = String(button.dataset.stickerKey || '').split(':');
        const sticker = items[Number(idx)];
        if (sticker) await sendSticker(sticker);
      });
    }
  } catch (error) {
    els.stickerGrid.innerHTML = 'Không mở được pack sticker.';
    showAppNotice(error.message || 'Không mở được pack sticker.', 'danger');
  }
}

async function sendSticker(sticker) {
  if (!state.activeThreadId) {
    showAppNotice('Hãy chọn hội thoại trước khi gửi sticker.', 'warning');
    return;
  }
  try {
    await post('/api/messages/sticker', { threadId: state.activeThreadId, sticker });
    hideAppNotice();
  } catch (error) {
    showAppNotice(error.message || 'Gửi sticker thất bại.', 'danger');
  }
}

function renderAvatar(url, fallback, className = 'avatar', id = '') {
  const safeId = id ? ` id="${id}"` : '';
  if (url) return `<div${safeId} class="${className} avatar-image" style="background-image:url('${escapeAttribute(url)}')">&nbsp;</div>`;
  return `<div${safeId} class="${className}">${escapeHtml(fallback)}</div>`;
}

async function sendMessage() {
  if (state.isSendingMessage) return;
  const rawText = els.messageInput.value || '';
  const text = rawText.trim();
  if (!state.activeThreadId) {
    showAppNotice('Hãy chọn hội thoại trước khi gửi.', 'warning');
    return;
  }
  if (!text && !state.pendingAttachments.length) return;

  const threadId = state.activeThreadId;
  const replyTo = state.replyTo;
  const pendingAttachments = state.pendingAttachments.map((item) => ({ ...item }));
  const hasAttachments = pendingAttachments.length > 0;
  const optimisticMessage = createOptimisticOutgoingMessage({ threadId, text, attachments: pendingAttachments });

  const payload = {
    threadId,
    text,
    attachments: pendingAttachments.map((item) => ({
      name: item.name,
      contentType: item.contentType,
      data: item.data
    }))
  };
  if (replyTo?.id) payload.replyToId = replyTo.id;
  const replyMention = buildReplyMentionMeta(currentThread(), replyTo);
  if (replyMention && (text.startsWith(replyMention.text) || text.startsWith(replyMention.token))) {
    payload.mentions = [{ uid: replyMention.uid, pos: replyMention.pos, len: replyMention.len }];
  }

  if (optimisticMessage) appendOptimisticMessage(optimisticMessage);
  els.messageInput.value = '';
  state.pendingAttachments = [];
  state.replyTo = null;
  renderAttachmentPreview();
  renderReplyPreview();
  clearComposerDraft(threadId);
  hideAppNotice();

  setComposerSending(true);
  try {
    await post('/api/messages/send', payload, { timeoutMs: hasAttachments ? 60000 : 30000 });
    optimisticMessage.pending = false;
    optimisticMessage.sent = true;
    renderMessages();
  } catch (error) {
    optimisticMessage.pending = false;
    optimisticMessage.failed = true;
    renderMessages();
    if (!hasAttachments) {
      els.messageInput.value = rawText;
      saveComposerDraft();
    }
    showAppNotice(error.message || 'Gửi tin nhắn thất bại.', 'danger');
  } finally {
    setComposerSending(false);
  }
}

async function saveMeta(options = {}) {
  const thread = currentThread();
  if (!thread) return;
  const renameValue = els.renameInput.value.trim();
  if (renameValue !== String(thread.title || '').trim()) {
    await post('/api/threads/rename', {
      threadId: thread.id,
      name: renameValue
    });
  }
  await post('/api/threads/meta', {
    threadId: thread.id,
    assignee: els.assigneeInput.value.trim() || null,
    notes: els.notesInput.value,
    tags: selectedTags()
  });
  await reloadState();
  if (!options.silent) flashSaved();
}

function flashSaved() {
  const old = els.btnSaveMeta.textContent;
  els.btnSaveMeta.textContent = 'Đã lưu';
  setTimeout(() => { els.btnSaveMeta.textContent = old; }, 1200);
}

async function markRead() {
  const thread = currentThread();
  if (!thread) return;
  clearUnreadForThread(thread.id);
  renderThreads();
  await post('/api/threads/read', { threadId: thread.id });
  await reloadState();
}

async function markUnread() {
  const thread = currentThread();
  if (!thread) return;
  thread.unreadCount = Math.max(1, thread.unreadCount || 0);
  recalcUnreadStats();
  renderThreads();
  await post('/api/threads/unread', { threadId: thread.id });
  await reloadState();
}

async function toggleThreadFlag(endpoint, key) {
  const thread = currentThread();
  if (!thread) return;
  const nextValue = !thread[key];
  const bodyKey = endpoint === 'pin' ? 'pinned' : endpoint === 'archive' ? 'archived' : endpoint === 'hide' ? 'hidden' : 'muted';
  await post(`/api/threads/${endpoint}`, { threadId: thread.id, [bodyKey]: nextValue });
  await reloadState();
}

async function deleteThread() {
  const thread = currentThread();
  if (!thread) return;
  if (!confirm(`Xoá đoạn chat với ${thread.title}?`)) return;
  await post('/api/threads/delete', { threadId: thread.id });
  await reloadState();
}

async function updateAutoDelete() {
  const thread = currentThread();
  if (!thread) return;
  await post('/api/threads/auto-delete', { threadId: thread.id, ttl: Number(els.autoDeleteSelect.value || 0) });
  await reloadState();
}

async function setAutoDelete(ttl) {
  els.autoDeleteSelect.value = String(ttl);
  await updateAutoDelete();
}

async function undoFriendRequest(userId) {
  const previous = Array.isArray(state.view?.zalo?.sentRequests) ? [...state.view.zalo.sentRequests] : [];
  try {
    if (state.view?.zalo) state.view.zalo.sentRequests = previous.filter((item) => String(item.id) !== String(userId));
    renderSocialPanels();
    await post('/api/friends/request/undo', { userId });
    await reloadState();
  } catch (error) {
    if (state.view?.zalo) state.view.zalo.sentRequests = previous;
    renderSocialPanels();
    showAppNotice(error.message || 'Thu hồi lời mời kết bạn thất bại', 'danger');
  }
}

async function undoMessage(messageId) {
  const thread = currentThread();
  if (!thread) return;
  await post('/api/messages/undo', { threadId: thread.id, messageId });
  await reloadState();
}

async function deleteMessage(messageId) {
  const thread = currentThread();
  if (!thread) return;
  await post('/api/messages/delete', { threadId: thread.id, messageId });
  await reloadState();
}

async function reactMessage(messageId, icon) {
  const thread = currentThread();
  if (!thread || !icon) return;
  const reactionKey = `${thread.id}:${messageId}`;
  if (state.pendingReactionKeys.has(reactionKey)) return;
  const ownId = String(state.view?.session?.account?.id || state.view?.activeAccountId || '');
  const targetMessage = (thread.messages || []).find((item) => String(item.id) === String(messageId));
  const previousReactions = Array.isArray(targetMessage?.reactions) ? targetMessage.reactions.map((item) => ({ ...item })) : [];
  state.pendingReactionKeys.add(reactionKey);
  if (targetMessage) {
    const next = [...previousReactions, {
      actionId: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      icon: String(icon),
      by: ownId,
      at: new Date().toISOString(),
      self: true,
      pending: true
    }];
    targetMessage.reactions = next;
    render();
  }
  try {
    await post('/api/messages/react', { threadId: thread.id, messageId, icon }, { timeoutMs: 30000 });
    hideAppNotice();
  } catch (error) {
    if (targetMessage) {
      targetMessage.reactions = previousReactions;
      render();
    }
    showAppNotice(error.message || 'React tin nhắn thất bại', 'danger');
  } finally {
    state.pendingReactionKeys.delete(reactionKey);
  }
}

async function getJson(url) {
  return fetchJson(url, { credentials: 'same-origin' });
}

async function post(url, body = {}, behavior = {}) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin'
  }, behavior);
}

async function fetchJson(url, options = {}, behavior = {}) {
  const { silentNotice = false, timeoutMs = REQUEST_TIMEOUT_MS } = behavior;
  const requestAccountId = String(state.view?.activeAccountId || '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  let res;
  try {
    const accountId = String(state.view?.activeAccountId || '');
    const headers = { ...options.headers, ...(accountId ? { 'X-Zalo-Account-Id': accountId } : {}) };
    res = await fetch(url, { ...options, headers, signal: controller.signal });
  } catch (error) {
    if (!silentNotice) {
      const timeout = error?.name === 'AbortError';
      showAppNotice(timeout
        ? 'Yêu cầu bị treo quá lâu. Có thể phiên web này đã cũ hoặc server vừa cập nhật. Vui lòng tải lại trang.'
        : 'Không kết nối được tới server. Có thể server vừa khởi động lại hoặc phiên web đã cũ. Hãy tải lại trang.', 'danger');
    }
    throw new Error('Không kết nối được tới server');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (requestAccountId !== String(state.view?.activeAccountId || '') && !url.startsWith('/api/auth/')) {
    const error = new Error('Đã chuyển account; bỏ phản hồi của account trước.');
    error.name = 'AbortError';
    throw error;
  }
  if (res.status === 401) {
    if (!silentNotice) showAppNotice('Phiên đăng nhập đã hết hạn hoặc server vừa cập nhật. Vui lòng tải lại trang.', 'danger');
    throw new Error(data.error || 'Unauthorized');
  }
  if (!res.ok || data.ok === false) {
    const message = data.error || (res.status >= 500
      ? 'Server vừa cập nhật hoặc đang lỗi tạm thời. Vui lòng tải lại trang.'
      : 'Yêu cầu không thành công. Vui lòng thử lại.');
    if (!silentNotice) showAppNotice(message, 'danger');
    throw new Error(message);
  }
  return data;
}

function notifyIncomingEvent({ kind, thread, message, reaction, user }) {
  const key = buildNotifyKey({ kind, thread, message, reaction, user });
  if (!rememberNotifiedEvent(key)) return;
  const title = buildNotifyTitle({ kind, thread, reaction, user });
  const body = buildNotifyBody({ kind, message, reaction, user });
  const threadId = thread?.id || message?.threadId || user?.id || '';
  pushEventToast(title, body, threadId);
  maybeShowBrowserNotification(title, body, threadId);
}

function buildNotifyKey({ kind, thread, message, reaction, user }) {
  if (kind === 'reaction') {
    return ['reaction', thread?.id || '', message?.id || '', reaction?.by || '', reaction?.icon || ''].join(':');
  }
  if (kind === 'friend_request') {
    return ['friend_request', user?.id || '', user?.time || ''].join(':');
  }
  const albumGroupId = String(message?.album?.groupId || '');
  if (albumGroupId) return ['message-album', thread?.id || '', albumGroupId].join(':');
  return ['message', thread?.id || '', message?.id || '', message?.createdAt || ''].join(':');
}

function rememberNotifiedEvent(key) {
  if (!key) return false;
  if (state.notifiedEventKeys.includes(key)) return false;
  state.notifiedEventKeys.push(key);
  if (state.notifiedEventKeys.length > 120) state.notifiedEventKeys = state.notifiedEventKeys.slice(-120);
  return true;
}

function buildNotifyTitle({ kind, thread, reaction, user }) {
  const threadTitle = thread?.title || 'Hội thoại mới';
  if (kind === 'reaction') {
    const meta = REACTION_OPTIONS.find((item) => item.icon === String(reaction?.icon || ''));
    return `${reactionDisplayName(reaction?.by)} đã react trong ${threadTitle}`;
  }
  if (kind === 'friend_request') return 'Lời mời kết bạn mới';
  return threadTitle;
}

function buildNotifyBody({ kind, message, reaction, user }) {
  if (kind === 'reaction') {
    const meta = REACTION_OPTIONS.find((item) => item.icon === String(reaction?.icon || ''));
    return `Reaction: ${meta?.display || reaction?.icon || '🙂'}`;
  }
  if (kind === 'friend_request') return `${user?.displayName || user?.id || 'Một người dùng'} vừa gửi lời mời kết bạn.`;
  return summarizeIncomingMessage(message);
}

function summarizeIncomingMessage(message) {
  const text = String(message?.text || '').trim();
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const type = String(message?.type || '');
  const albumTotal = Number(message?.album?.total || 0);
  if (type.includes('sticker')) return 'Sticker mới';
  if (type.includes('photo') || attachments.some((item) => item.kind === 'image')) {
    if (albumTotal > 1) return `Bạn nhận được ${albumTotal} ảnh`;
    return attachments.length > 1 ? `${attachments.length} ảnh mới` : 'Ảnh mới';
  }
  if (type.includes('voice') || type.includes('audio')) return 'Tin nhắn giọng nói mới';
  if (attachments.length) return attachments.length > 1 ? `${attachments.length} tệp mới` : 'Tệp mới';
  return text || 'Tin nhắn mới';
}

function pushEventToast(title, body, threadId = '') {
  const toast = document.createElement('button');
  toast.type = 'button';
  toast.className = 'event-toast';
  toast.innerHTML = `<div class="event-toast-title">${escapeHtml(title)}</div><div class="event-toast-body">${escapeHtml(body)}</div>`;
  toast.addEventListener('click', () => {
    openThreadFromNotification(threadId);
    toast.remove();
  });
  els.eventToastStack.appendChild(toast);
  setTimeout(() => toast.remove(), 6500);
}

function maybeShowBrowserNotification(title, body, threadId = '') {
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, silent: false, tag: threadId ? `thread:${threadId}:${title}` : undefined });
    n.onclick = () => {
      window.focus();
      openThreadFromNotification(threadId);
      n.close();
    };
    setTimeout(() => n.close(), 6500);
  } catch {
    // ignore
  }
}

function openThreadFromNotification(threadId) {
  if (!threadId) return;
  const exists = (state.view?.threads || []).some((item) => String(item.id) === String(threadId));
  if (!exists) return;
  switchActiveThread(threadId);
  clearUnreadForThread(threadId);
  render();
  switchView('chats');
}

function getRequestedThreadId() {
  try {
    return new URLSearchParams(window.location.search).get('threadId') || '';
  } catch {
    return '';
  }
}

function syncThreadQueryParam(threadId) {
  try {
    const url = new URL(window.location.href);
    if (threadId) url.searchParams.set('threadId', threadId);
    else url.searchParams.delete('threadId');
    window.history.replaceState({}, '', url);
  } catch {
    // ignore URL sync issues
  }
}

function maybeRequestNotificationPermission() {
  if (!state.authenticated) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  Notification.requestPermission().catch(() => null);
}

function showAppNotice(message, tone = 'warning') {
  state.appNotice = { message, tone };
  els.appNotice.className = `app-notice app-notice--${tone}`;
  els.appNoticeText.textContent = message;
  els.appNotice.classList.remove('hidden');
}

function hideAppNotice() {
  state.appNotice = null;
  els.appNotice.className = 'app-notice hidden';
  els.appNoticeText.textContent = '';
}

function createOptimisticOutgoingMessage({ threadId, text, attachments }) {
  const accountId = String(state.view?.session?.account?.id || state.view?.activeAccountId || 'self');
  const normalizedAttachments = (attachments || []).map((item) => ({
    name: item.name,
    contentType: item.contentType,
    size: item.size,
    kind: inferClientAttachmentKind(item.contentType, item.name),
    previewUrl: item.previewUrl || null
  }));
  return {
    id: `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    senderId: accountId,
    text: summarizeOutgoingDraft(text, normalizedAttachments),
    type: inferClientMessageType(normalizedAttachments, text),
    attachments: normalizedAttachments,
    isOutgoing: true,
    createdAt: new Date().toISOString(),
    pending: true
  };
}

function appendOptimisticMessage(message) {
  if (!state.view) return;
  const thread = currentThread();
  if (!thread) return;
  thread.messages = dedupeClientMessages([...(thread.messages || []), message]);
  thread.lastMessageAt = message.createdAt;
  thread.lastMessageText = summarizeClientMessage(message);
  thread.unreadCount = 0;
  sortThreadsInView();
  render();
}


function removeMessageById(threadId, messageId) {
  const thread = (state.view?.threads || []).find((item) => String(item.id) === String(threadId));
  if (!thread?.messages?.length) return;
  thread.messages = thread.messages.filter((item) => String(item.id) !== String(messageId));
  const last = thread.messages[thread.messages.length - 1];
  thread.lastMessageAt = last?.createdAt || thread.lastMessageAt || null;
  thread.lastMessageText = last ? summarizeClientMessage(last) : '';
  sortThreadsInView();
  render();
}

function setComposerSending(sending) {
  state.isSendingMessage = Boolean(sending);
  els.btnSend.disabled = state.isSendingMessage;
  els.btnAttach.disabled = state.isSendingMessage;
  els.btnSticker.disabled = state.isSendingMessage;
}



function isMatchingLocalOutgoingMessage(local, realMessage) {
  if (!local || !realMessage || !local.isOutgoing || !realMessage.isOutgoing) return false;
  if (String(local.threadId || '') !== String(realMessage.threadId || '')) return false;
  const localTs = new Date(local.createdAt || 0).getTime();
  const realTs = new Date(realMessage.createdAt || Date.now()).getTime();
  if (Number.isFinite(localTs) && Number.isFinite(realTs) && Math.abs(realTs - localTs) > 120000) return false;

  const localAttachments = attachmentCount(local);
  const realAttachments = attachmentCount(realMessage);
  if (localAttachments > 0 || realAttachments > 0) {
    return localAttachments > 0
      && realAttachments > 0
      && localAttachments === realAttachments
      && (isClientImageLike(local) === isClientImageLike(realMessage) || attachmentKindSignature(local) === attachmentKindSignature(realMessage));
  }

  const localText = String(local.text || '').trim();
  const realText = String(realMessage.text || '').trim();
  return Boolean(localText && realText && localText === realText);
}


function removeClientPendingAlbumOnRealtime(messages, realMessage) {
  if (!realMessage?.isOutgoing || !isClientImageLike(realMessage)) return messages;
  const total = getRealtimeAlbumTotal(realMessage);
  return (messages || []).filter((message) => {
    if (!isClientLocal(message) || !message.isOutgoing || !isClientImageLike(message)) return true;
    if (String(message.threadId || '') !== String(realMessage.threadId || '')) return true;
    const localCount = attachmentCount(message);
    if (total && localCount === total) return false;
    const localTs = new Date(message.createdAt || 0).getTime();
    const realTs = new Date(realMessage.createdAt || Date.now()).getTime();
    return !(localCount > 0 && Number.isFinite(localTs) && Number.isFinite(realTs) && Math.abs(realTs - localTs) <= 300000);
  });
}

function getRealtimeAlbumTotal(message) {
  const params = message?.raw?.content?.params;
  if (!params) return 0;
  try {
    const parsed = typeof params === 'string' ? JSON.parse(params) : params;
    return Number(parsed?.total_item_in_group || 0) || 0;
  } catch {
    return 0;
  }
}

function dedupeClientMessages(messages) {
  // Single merge point for optimistic + realtime message rendering on the client.
  const sorted = [...(messages || [])].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const deduped = [];
  for (const message of sorted) {
    const duplicateIndex = deduped.findIndex((existing) => isSameClientMessage(existing, message));
    if (duplicateIndex >= 0) {
      deduped[duplicateIndex] = mergeClientMessage(existingOr(deduped[duplicateIndex]), message);
      continue;
    }
    deduped.push(message);
  }
  return deduped;
}

function existingOr(message) {
  return message || {};
}

function isSameClientMessage(left, right) {
  if (!left || !right) return false;
  if (String(left.id || '') === String(right.id || '') && left.id) return true;
  if (String(left.threadId || '') !== String(right.threadId || '')) return false;
  if (String(left.senderId || '') !== String(right.senderId || '')) return false;
  if (Boolean(left.isOutgoing) !== Boolean(right.isOutgoing)) return false;

  const leftAlbumId = String(left.album?.groupId || '');
  const rightAlbumId = String(right.album?.groupId || '');
  if (leftAlbumId || rightAlbumId) {
    if (leftAlbumId !== rightAlbumId) return false;
    const leftAlbumIndex = Number(left.album?.index || 0);
    const rightAlbumIndex = Number(right.album?.index || 0);
    if (leftAlbumIndex && rightAlbumIndex && leftAlbumIndex !== rightAlbumIndex) return false;
  }

  const leftRawMsgId = String(left.raw?.msgId || '');
  const rightRawMsgId = String(right.raw?.msgId || '');
  const leftCliMsgId = String(left.raw?.cliMsgId || '');
  const rightCliMsgId = String(right.raw?.cliMsgId || '');
  if ((leftRawMsgId && rightRawMsgId && leftRawMsgId !== rightRawMsgId) || (leftCliMsgId && rightCliMsgId && leftCliMsgId !== rightCliMsgId)) return false;

  const leftTs = new Date(left.createdAt || 0).getTime();
  const rightTs = new Date(right.createdAt || 0).getTime();
  if (!Number.isFinite(leftTs) || !Number.isFinite(rightTs) || Math.abs(leftTs - rightTs) > 15000) return false;

  const sameText = String(left.text || '') === String(right.text || '');
  const sameAttachmentShape = attachmentSignature(left) === attachmentSignature(right);
  const compatibleAttachmentShape = attachmentKindSignature(left) === attachmentKindSignature(right) && attachmentCount(left) === attachmentCount(right);
  const sameImageLike = isClientImageLike(left) && isClientImageLike(right) && compatibleAttachmentShape;
  const sameFileLike = !sameImageLike && attachmentCount(left) > 0 && attachmentCount(left) === attachmentCount(right) && compatibleAttachmentShape;

  if (!sameText && !sameImageLike && !sameFileLike && !sameAttachmentShape) return false;

  if ((leftRawMsgId && rightRawMsgId && leftRawMsgId === rightRawMsgId) || (leftCliMsgId && rightCliMsgId && leftCliMsgId === rightCliMsgId)) {
    return true;
  }

  return isClientLocal(left) || isClientLocal(right) || Boolean(left.raw?.msgId || right.raw?.msgId || left.raw?.cliMsgId || right.raw?.cliMsgId);
}

function mergeClientMessage(left, right) {
  const leftScore = clientMessageScore(left);
  const rightScore = clientMessageScore(right);
  const primary = rightScore >= leftScore ? right : left;
  const secondary = primary === right ? left : right;
  return {
    ...secondary,
    ...primary,
    attachments: mergeClientAttachments(secondary.attachments, primary.attachments),
    reactions: mergeClientReactions(secondary.reactions, primary.reactions),
    pending: false
  };
}

function mergeClientReactions(left, right) {
  const out = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
    const actionId = String(item?.actionId || '');
    const key = actionId || `${String(item?.by || '')}:${String(item?.icon || '')}:${String(item?.at || '')}:${item?.pending ? 'pending' : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function clientMessageScore(message) {
  let score = 0;
  if (!message) return score;
  if (message.raw?.msgId) score += 4;
  if (message.raw?.cliMsgId) score += 3;
  if (!isClientLocal(message)) score += 2;
  if (Array.isArray(message.attachments) && message.attachments.some((item) => item.url)) score += 1;
  return score;
}

function isClientLocal(message) {
  return String(message?.id || '').startsWith('client-') || Boolean(message?.pending);
}

function attachmentSignature(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  return attachments.map((item) => `${item?.kind || ''}:${item?.name || ''}:${item?.contentType || ''}:${item?.url || ''}:${item?.previewUrl || ''}`).join('|');
}

function imageAttachmentSignature(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return '';
  return attachments.map((item) => `${item?.kind || ''}:${item?.url || ''}:${item?.previewUrl || ''}`).join('|');
}

function attachmentKindSignature(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  return attachments.map((item) => `${item?.kind || ''}:${item?.contentType || ''}`).join('|');
}

function attachmentCount(message) {
  return Array.isArray(message?.attachments) ? message.attachments.length : 0;
}

function mergeClientAttachments(left, right) {
  const leftItems = Array.isArray(left) ? left : [];
  const rightItems = Array.isArray(right) ? right : [];
  const max = Math.max(leftItems.length, rightItems.length);
  const out = [];
  for (let i = 0; i < max; i += 1) {
    const base = leftItems[i] || {};
    const next = rightItems[i] || {};
    out.push({
      ...base,
      ...next,
      previewUrl: next.previewUrl || base.previewUrl || null,
      url: next.url || base.url || null,
      name: next.name || base.name || '',
      contentType: next.contentType || base.contentType || ''
    });
  }
  return out.filter((item) => Object.keys(item).length > 0);
}

function isClientImageLike(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (attachments.length && attachments.every((item) => item.kind === 'image')) return true;
  return String(message?.type || '').includes('photo');
}

function inferClientMessageType(attachments, text) {
  if (attachments?.length) {
    return attachments.every((item) => item.kind === 'image') ? 'chat.photo' : 'chat.file';
  }
  return text ? 'text' : 'text';
}

function summarizeOutgoingDraft(text, attachments) {
  const trimmed = String(text || '').trim();
  if (trimmed) return trimmed;
  if (!attachments?.length) return '';
  if (attachments.every((item) => item.kind === 'image')) return attachments.length > 1 ? `[${attachments.length} ảnh]` : '[Ảnh]';
  return attachments.length > 1 ? `[${attachments.length} tệp đính kèm]` : '[Tệp đính kèm]';
}

function summarizeClientMessage(message) {
  const text = String(message?.text || '').trim();
  if (text && !text.startsWith('data:image/')) return text;
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (attachments.length && attachments.every((item) => item.kind === 'image')) return attachments.length > 1 ? `[${attachments.length} ảnh]` : '[Ảnh]';
  if (attachments.length) return attachments.length > 1 ? `[${attachments.length} tệp đính kèm]` : '[Tệp đính kèm]';
  return text;
}

function inferClientAttachmentKind(contentType, value) {
  const type = String(contentType || '').toLowerCase();
  const name = String(value || '').toLowerCase();
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(name)) return 'image';
  return 'file';
}

function sortThreadsInView() {
  if (!state.view?.threads) return;
  state.view.threads.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || ''));
  });
}

function currentThread() {
  return (state.view?.threads || []).find((item) => item.id === state.activeThreadId) || null;
}

function findContact(contactId) {
  return (state.view?.contacts || []).find((item) => String(item.id) === String(contactId)) || null;
}

function defaultPreview(thread) {
  return thread.type === 'group' ? 'Nhấn đồng bộ để lấy tin gần nhất' : 'Tin mới sẽ hiện realtime';
}

function emptyMessageForThread(thread) {
  return thread.type === 'group'
    ? 'Nhóm này chưa có tin trong bộ nhớ. Bấm “Đồng bộ lại” để lấy tin gần nhất.'
    : 'Chat 1-1 hiện ưu tiên tin realtime + phần lịch sử đã cache trên server. Nếu thread cũ trống, đó là giới hạn nguồn Zalo hiện tại chứ không phải web đã xoá mất tin.';
}

function formatAutoDelete(ttl) {
  if (!ttl) return 'tắt';
  if (ttl === 86400000) return '1 ngày';
  if (ttl === 604800000) return '7 ngày';
  if (ttl === 1209600000) return '14 ngày';
  return `${Math.round(ttl / 86400000)} ngày`;
}

function initials(text) {
  return (text || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || '?';
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(date);
}

function showLoginError(message) {
  els.loginError.textContent = message;
  els.loginError.classList.remove('hidden');
}

function hideLoginError() {
  els.loginError.textContent = '';
  els.loginError.classList.add('hidden');
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return String(value).replaceAll("'", '%27');
}
