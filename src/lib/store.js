import fs from 'node:fs';
import path from 'node:path';
import { requestAccountContext } from '../services/request-account-context.js';
import { normalizeAiAutomationConfig, normalizeAiAutomationDepartmentMap } from '../services/ai-automation-service.js';
import { buildDefaultAiAutomationUsage, normalizeAiAutomationUsage } from '../services/ai-automation-openrouter.js';

const STATE_REVISION = Symbol.for('zlsever.stateRevision');
const MAX_STORED_MESSAGES_PER_THREAD = 250;
const MAX_VIEW_MESSAGES_PER_THREAD = 80;
const RECENT_THREAD_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
const MAX_AI_AUTOMATION_LOG_ITEMS = 200;

const DEFAULT_STATE = {
  activeAccountId: null,
  accounts: {},
  accountStateById: {},
  integration: {
    webhookUrl: '',
    webhookSecret: '',
    enabled: false,
    selectedAccountIds: [],
    lastDeliveryAt: null,
    lastDeliveryError: null
  },
  aiAutomationByDepartment: {},
  aiAutomationUsage: buildDefaultAiAutomationUsage(),
  aiAutomationLogs: [],
  aiAutomation: {
    enabled: false,
    mode: 'assistive',
    defaultThreadMode: 'off',
    allowedDepartments: [],
    adminAlertUserIds: [],
    systemPrompt: 'Bạn là AI điều phối CSKH cho ChiHome. Chỉ trả lời khi đủ dữ liệu. Ưu tiên gọi đúng nguồn knowledge/tool theo intent. Không bịa. Nếu thiếu chắc chắn, chuyển người thật.',
    replyStylePrompt: 'Trả lời ngắn gọn, rõ ràng, lịch sự, dùng tiếng Việt tự nhiên. Với câu hỏi availability/giá/phòng, luôn nêu điều kiện ngày ở và đề xuất bước tiếp theo.',
    humanHandoffPrompt: 'Tóm tắt ngắn case, nêu lý do escalation, thông tin còn thiếu, và đề xuất hành động cho admin.',
    flowDefinitions: [
      {
        id: 'booking_discovery',
        label: 'Tư vấn đặt phòng',
        enabled: true,
        intents: ['availability', 'quote', 'booking'],
        steps: ['classify_intent', 'collect_dates', 'check_availability', 'summarize_options', 'ask_for_booking_confirmation']
      },
      {
        id: 'faq_room_service',
        label: 'FAQ phòng / dịch vụ',
        enabled: true,
        intents: ['room_info', 'amenities', 'service', 'policy'],
        steps: ['classify_intent', 'retrieve_knowledge', 'draft_answer', 'verify_answer']
      },
      {
        id: 'complaint_handoff',
        label: 'Complaint / escalation',
        enabled: true,
        intents: ['complaint', 'refund', 'urgent'],
        steps: ['detect_risk', 'pause_automation', 'alert_admin', 'handoff_summary']
      }
    ],
    promptLibrary: [
      {
        id: 'guest_greeting',
        label: 'Mở đầu hội thoại',
        prompt: 'Chào khách, xác nhận nhu cầu chính, và hỏi tối thiểu thông tin còn thiếu để tra cứu chính xác.'
      },
      {
        id: 'availability_compose',
        label: 'Compose availability',
        prompt: 'Từ dữ liệu live, tóm tắt phòng trống phù hợp theo ngày, số khách, tiện ích nổi bật và gợi ý bước chốt booking.'
      },
      {
        id: 'complaint_acknowledge',
        label: 'Acknowledgement complaint',
        prompt: 'Không tranh cãi. Xác nhận đã tiếp nhận, xin lỗi ngắn gọn, không hứa điều vượt thẩm quyền, và chuyển người phụ trách.'
      }
    ],
    automationRules: [
      {
        id: 'auto_pause_on_complaint',
        enabled: true,
        when: { sentiment: 'negative', keywordGroup: 'complaintKeywords' },
        then: { action: 'escalate', mode: 'paused_by_escalation' }
      },
      {
        id: 'require_live_data_for_booking',
        enabled: true,
        when: { intentIn: ['availability', 'quote', 'booking'] },
        then: { action: 'require_knowledge_source', sourceId: 'chihomehotel_availability' }
      },
      {
        id: 'small_model_for_faq',
        enabled: true,
        when: { intentIn: ['greeting', 'general', 'faq'] },
        then: { action: 'prefer_model_tier', tier: 'small' }
      }
    ],
    agentRegistry: [
      {
        id: 'orchestrator',
        label: 'Orchestrator chính',
        enabled: true,
        role: 'planner',
        responsibilities: ['phân loại intent', 'chọn flow', 'giao việc cho specialist agents', 'ra quyết định escalation'],
        modelTier: 'medium'
      },
      {
        id: 'retrieval',
        label: 'Retrieval agent',
        enabled: true,
        role: 'grounding',
        responsibilities: ['đọc knowledge base', 'rag search', 'gom facts'],
        modelTier: 'small'
      },
      {
        id: 'hotel_live_data',
        label: 'Hotel live data agent',
        enabled: true,
        role: 'tool_user',
        responsibilities: ['gọi API chihomehotel', 'kiểm tra availability', 'lấy room facts'],
        modelTier: 'small'
      },
      {
        id: 'policy_guard',
        label: 'Policy / QA agent',
        enabled: true,
        role: 'verifier',
        responsibilities: ['soát sai fact', 'soát tone', 'kiểm tra policy'],
        modelTier: 'medium'
      },
      {
        id: 'composer',
        label: 'Reply composer',
        enabled: true,
        role: 'writer',
        responsibilities: ['soạn câu trả lời cuối', 'giữ giọng điệu', 'đưa CTA rõ ràng'],
        modelTier: 'medium'
      }
    ],
    delegationRules: [
      {
        id: 'booking_needs_live_data',
        label: 'Booking phải gọi live data',
        enabled: true,
        when: { intentIn: ['availability', 'quote', 'booking'] },
        handoff: ['retrieval', 'hotel_live_data', 'policy_guard', 'composer']
      },
      {
        id: 'complaint_needs_guard',
        label: 'Complaint phải có QA agent',
        enabled: true,
        when: { intentIn: ['complaint', 'refund', 'urgent'] },
        handoff: ['policy_guard']
      }
    ],
    modelCatalog: [
      {
        id: 'deepseek_v4_flash',
        modelId: 'deepseek/deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        provider: 'openrouter',
        kind: 'chat',
        tier: 'small',
        promptPricePer1M: 0.112,
        completionPricePer1M: 0.224,
        contextLength: 1048576,
        strengths: ['rất rẻ', 'context lớn', 'tool calling / structured outputs', 'phù hợp classify/router/retrieval passes'],
        weaknesses: ['không phải lựa chọn an toàn nhất cho case quá nhạy cảm', 'chất lượng wording cuối có thể cần model mạnh hơn để polish'],
        useCases: ['classify_intent', 'light_routing', 'retrieval_planning', 'faq_simple', 'draft_internal_summary'],
        recommendedFor: ['router nhỏ', 'nhiệm vụ nền số lượng lớn', 'bước suy luận phụ giá rẻ'],
        verifiedSource: 'OpenRouter model API'
      },
      {
        id: 'google_gemini_35_flash',
        modelId: 'google/gemini-3.5-flash',
        label: 'Google Gemini 3.5 Flash',
        provider: 'openrouter',
        kind: 'chat',
        tier: 'medium',
        promptPricePer1M: 1.5,
        completionPricePer1M: 9,
        contextLength: 1048576,
        modality: 'text+image+file+audio+video',
        strengths: ['đa phương thức mạnh', 'agentic execution tốt', 'hợp file/image/audio', 'hợp các lượt compose cần hiểu ngữ cảnh lớn'],
        weaknesses: ['đắt hơn DeepSeek khá nhiều', 'không nên dùng mặc định cho mọi lượt vì tốn cost'],
        useCases: ['compose_structured', 'file_grounding', 'multimodal_guest_request', 'verification_with_attachments'],
        recommendedFor: ['khách gửi ảnh/file', 'cần đọc tài liệu dài', 'orchestrator trung tâm cho ca vừa'],
        verifiedSource: 'OpenRouter model API'
      },
      {
        id: 'deepseek_v4_pro',
        modelId: 'deepseek/deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        provider: 'openrouter',
        kind: 'chat',
        tier: 'medium',
        promptPricePer1M: 0.435,
        completionPricePer1M: 0.87,
        contextLength: 1048576,
        strengths: ['reasoning text-only mạnh hơn flash', 'rẻ hơn rất nhiều so với frontier premium', 'context rất lớn'],
        weaknesses: ['không multimodal như Gemini 3.5 Flash', 'không nên là lựa chọn duy nhất cho case cần wording/guardrails cao cấp nhất'],
        useCases: ['policy_lookup', 'quote_reasoning', 'complex_text_reasoning', 'verifier_text_only'],
        recommendedFor: ['ca phức tạp nhưng chủ yếu text', 'verifier trung cấp', 'tool orchestration giá hợp lý'],
        verifiedSource: 'OpenRouter model API'
      },
      {
        id: 'openai_gpt_55',
        modelId: 'openai/gpt-5.5',
        label: 'OpenAI GPT-5.5',
        provider: 'openrouter',
        kind: 'chat',
        tier: 'large',
        promptPricePer1M: 5,
        completionPricePer1M: 30,
        contextLength: 1050000,
        modality: 'text+image+file',
        strengths: ['frontier reasoning mạnh', 'độ tin cậy cao cho case khó', 'phù hợp final review / complaint / escalations'],
        weaknesses: ['rất đắt', 'không phù hợp làm default cho lượt chat thường'],
        useCases: ['complaint', 'final_review', 'high_stakes_handoff', 'complex_multistep'],
        recommendedFor: ['case rủi ro cao', 'VIP', 'complaint nhạy cảm', 'review cuối trước khi gửi khách'],
        verifiedSource: 'OpenRouter model API'
      }
    ],
    embeddingCatalog: [
      {
        id: 'openai_text_embedding_3_large',
        modelId: 'openai/text-embedding-3-large',
        label: 'OpenAI text-embedding-3-large',
        provider: 'openrouter',
        dimensions: 3072,
        supportedDimensions: [3072, 1536],
        maxInputTokens: 8192,
        promptPricePer1M: 0.13,
        strengths: ['embedding chất lượng cao', 'mạnh cho retrieval precision', 'phù hợp knowledge base nhỏ-vừa cần độ chính xác cao'],
        weaknesses: ['vector nặng hơn, tốn storage hơn bản rút gọn'],
        verifiedSource: 'OpenAI embeddings docs + OpenRouter endpoints',
        status: 'ready_template'
      },
      {
        id: 'google_gemini_embedding_001',
        modelId: 'google/gemini-embedding-001',
        label: 'Google Gemini Embedding 001',
        provider: 'openrouter',
        dimensions: 3072,
        supportedDimensions: [768, 1536, 3072],
        maxInputTokens: 20000,
        promptPricePer1M: 0.15,
        strengths: ['context input dài hơn', 'linh hoạt truncate dimension', 'hợp dữ liệu lớn / nhiều tài liệu bảng'],
        weaknesses: ['nếu truncate dưới 3072 thì với model 001 cần chú ý normalize thủ công theo docs Google'],
        verifiedSource: 'Google embeddings docs + OpenRouter endpoints',
        status: 'ready_template'
      }
    ],
    vectorStores: [
      {
        id: 'default_rag_store',
        label: 'Kho tri thức mặc định',
        enabled: true,
        backend: 'pgvector',
        collection: 'zlsever_ai_knowledge',
        embeddingModelId: 'google_gemini_embedding_001',
        dimensions: 1536,
        distanceMetric: 'cosine',
        normalizationRequired: true,
        status: 'planned'
      }
    ],
    knowledgeDocuments: [],
    modelRouter: {
      classify: 'small',
      retrieve: 'small',
      composeSimple: 'small',
      composeStructured: 'medium',
      complaint: 'large',
      fallback: 'medium'
    },
    providerRouting: {
      primary: 'openrouter',
      fallback: 'openrouter'
    },
    orchestration: {
      maxAutoTurns: 4,
      maxToolCallsPerTurn: 3,
      enableDraftReview: false,
      autoDisableOnEscalation: true,
      humanHandoffMode: 'pause_and_alert'
    },
    escalation: {
      complaintKeywords: [],
      directHumanRequest: true,
      negativeSentiment: true,
      repeatQuestionThreshold: 2,
      lowConfidenceThreshold: 0.72,
      complexIntentThreshold: 0.82,
      pauseThreadOnEscalation: true
    },
    knowledgeSources: [],
    threadControls: {
      snoozePresetsMinutes: [5, 10, 20, 30, 60],
      allowCustomSnoozeHours: true,
      defaultResumeNote: 'Tự mở lại auto reply sau thời gian tạm dừng.'
    }
  },
  session: {
    provider: 'mock',
    status: 'logged_out',
    qrCode: null,
    qrImage: null,
    account: null,
    error: null,
    updatedAt: null,
    syncInfo: null
  },
  labels: {
    items: [],
    version: 0,
    lastUpdateTime: 0
  },
  zalo: {
    quickMessages: [],
    pinnedConversations: [],
    hiddenConversations: [],
    archivedConversations: [],
    autoDeleteConversations: [],
    autoDeleteMap: {},
    recommendations: [],
    incomingRequests: [],
    sentRequests: [],
    blockedUsers: [],
    closeFriends: [],
    aliases: [],
    mutedConversations: [],
    locallyDeletedThreads: [],
    settings: {},
    autoReplies: [],
    raw: {}
  },
  contacts: {},
  threads: {},
  messages: {}
};

export class JsonStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.filePath = path.join(baseDir, 'state.json');
    this.cachedState = null;
    this.cachedStatKey = null;
    this.revisionCounter = 0;
    fs.mkdirSync(baseDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.write(structuredClone(DEFAULT_STATE));
    }
  }

  read() {
    const state = this.readGlobal();
    const context = requestAccountContext.getStore();
    return context ? projectAccountState(state, context.accountId) : state;
  }

  readGlobal() {
    try {
      const stat = fs.statSync(this.filePath);
      const statKey = `${stat.mtimeMs}:${stat.size}`;
      if (this.cachedState && this.cachedStatKey === statKey) {
        return this.cachedState;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const merged = mergeDefaults(parsed, DEFAULT_STATE);
      markStateRevision(merged, ++this.revisionCounter);
      this.cachedState = merged;
      this.cachedStatKey = statKey;
      return merged;
    } catch {
      const fallback = structuredClone(DEFAULT_STATE);
      markStateRevision(fallback, ++this.revisionCounter);
      this.cachedState = fallback;
      this.cachedStatKey = null;
      return fallback;
    }
  }

  write(nextState) {
    persistActiveAccountSnapshot(nextState);
    const payload = JSON.stringify(nextState, null, 2);
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, payload);
    fs.renameSync(tempPath, this.filePath);
    const stat = fs.statSync(this.filePath);
    markStateRevision(nextState, ++this.revisionCounter);
    this.cachedState = nextState;
    this.cachedStatKey = `${stat.mtimeMs}:${stat.size}`;
    return nextState;
  }

  update(mutator) {
    const context = requestAccountContext.getStore();
    const state = this.readGlobal();
    if (!context) return this.write(mutator(state) || state);
    const accountId = String(context.accountId || '');
    const projected = projectAccountState(state, accountId);
    const next = mutator(projected) || projected;
    if (String(next.activeAccountId || '') !== accountId) {
      throw new Error('Account-scoped writes cannot change the global selection');
    }
    for (const key of Object.keys(next)) {
      if (!ACCOUNT_STATE_KEYS.includes(key) && key !== 'activeAccountId') state[key] = next[key];
    }
    if (accountId && state.accounts?.[accountId]) {
      state.accountStateById[accountId] = buildAccountSnapshotFromGlobal(next, accountId);
    }
    applyAccountSnapshotToGlobal(state, getAccountScopedState(state, state.activeAccountId) || createEmptyAccountState());
    this.write(state);
    return projectAccountState(state, accountId);
  }
}

const ACCOUNT_STATE_KEYS = ['contacts', 'threads', 'messages', 'labels', 'zalo', 'session'];

export function projectAccountState(state, accountId) {
  const key = String(accountId || '');
  const bucket = getAccountScopedState(state, key) || createEmptyAccountState();
  const projected = { ...state, ...bucket, activeAccountId: key || null };
  projected.session = { provider: state.session?.provider, ...bucket.session };
  markStateRevision(projected, getStateRevision(state));
  return projected;
}

export function getStateRevision(state) {
  return Number(state?.[STATE_REVISION] || 0);
}

function markStateRevision(state, revision) {
  if (!state || typeof state !== 'object') return state;
  Object.defineProperty(state, STATE_REVISION, {
    value: Number(revision || 0),
    enumerable: false,
    configurable: true,
    writable: true
  });
  return state;
}

function mergeDefaults(value, defaults) {
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : structuredClone(defaults);
  if (defaults && typeof defaults === 'object') {
    const out = structuredClone(defaults);
    for (const key of Object.keys(value || {})) {
      out[key] = mergeDefaults(value[key], defaults[key]);
    }
    return out;
  }
  return value ?? defaults;
}

export function upsertContact(state, contact) {
  state.contacts[contact.id] = {
    ...(state.contacts[contact.id] || {}),
    ...contact
  };
}

export function upsertThread(state, thread) {
  state.threads[thread.id] = {
    unreadCount: 0,
    participantIds: [],
    type: 'direct',
    tags: [],
    assignee: null,
    notes: '',
    pinned: false,
    hidden: false,
    archived: false,
    autoDelete: false,
    autoDeleteTtl: 0,
    muted: false,
    ...(state.threads[thread.id] || {}),
    ...thread
  };
}

export function appendMessage(state, message) {
  if (!state.messages[message.threadId]) {
    state.messages[message.threadId] = [];
  }
  state.messages[message.threadId].push(message);
  state.messages[message.threadId] = dedupeMessages(state.messages[message.threadId]);
  recalcThreadSummary(state, message.threadId, { incrementUnread: !message.isOutgoing });
}

export function replaceThreadMessages(state, threadId, messages, options = {}) {
  state.messages[threadId] = dedupeMessages(messages || []);
  recalcThreadSummary(state, threadId, {
    resetUnread: options.resetUnread ?? true,
    unreadCount: options.unreadCount ?? 0,
    incrementUnread: false
  });
}

function dedupeMessages(messages) {
  const sorted = [...messages].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const deduped = [];
  const seen = new Set();

  for (const message of sorted) {
    const key = message.id || `${message.threadId}:${message.senderId}:${message.createdAt}:${message.text}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const duplicateIndex = deduped.findIndex((existing) => isSameLogicalMessage(existing, message));
    if (duplicateIndex >= 0) {
      deduped[duplicateIndex] = mergeMessageRecords(deduped[duplicateIndex], message);
      continue;
    }

    deduped.push(message);
  }

  return deduped.slice(-MAX_STORED_MESSAGES_PER_THREAD);
}

function isSameLogicalMessage(left, right) {
  if (!left || !right) return false;
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
  if ((leftRawMsgId && rightRawMsgId && leftRawMsgId !== rightRawMsgId) || (leftCliMsgId && rightCliMsgId && leftCliMsgId !== rightCliMsgId)) {
    return false;
  }

  const leftTs = new Date(left.createdAt || 0).getTime();
  const rightTs = new Date(right.createdAt || 0).getTime();
  if (!Number.isFinite(leftTs) || !Number.isFinite(rightTs)) return false;
  if (Math.abs(leftTs - rightTs) > 15000) return false;

  const leftRaw = Boolean(left.raw?.msgId || left.raw?.cliMsgId);
  const rightRaw = Boolean(right.raw?.msgId || right.raw?.cliMsgId);
  const leftLocal = isLocalMessage(left);
  const rightLocal = isLocalMessage(right);
  const sameType = String(left.type || 'text') === String(right.type || 'text');
  const sameText = String(left.text || '') === String(right.text || '');
  const textLikePair = isTextLikeMessage(left) && isTextLikeMessage(right);
  const sameAttachmentShape = getAttachmentSignature(left) === getAttachmentSignature(right);
  const compatibleAttachmentShape = getAttachmentKindSignature(left) === getAttachmentKindSignature(right) && getAttachmentCount(left) === getAttachmentCount(right);
  const sameImageLike = isImageLikeMessage(left) && isImageLikeMessage(right) && compatibleAttachmentShape;

  if (!sameText && !sameImageLike && !sameAttachmentShape) return false;
  if (!sameType && !(textLikePair && (leftLocal || rightLocal)) && !sameImageLike && !sameAttachmentShape) return false;
  if ((leftRawMsgId && rightRawMsgId && leftRawMsgId === rightRawMsgId) || (leftCliMsgId && rightCliMsgId && leftCliMsgId === rightCliMsgId)) return true;

  return (leftLocal || rightLocal || leftRaw || rightRaw);
}

function isTextLikeMessage(message) {
  const type = String(message?.type || 'text');
  return ['text', 'webchat', 'chat.text'].includes(type);
}

function isLocalMessage(message) {
  return String(message?.id || '').startsWith('local-') || String(message?.id || '').startsWith('client-');
}

function isImageLikeMessage(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (attachments.length && attachments.every((item) => String(item?.kind || '') === 'image')) return true;
  const type = String(message?.type || '');
  return type.includes('photo');
}

function getAttachmentSignature(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return '';
  return attachments.map((item) => `${item?.kind || ''}:${item?.name || ''}:${item?.contentType || ''}:${item?.url || ''}:${item?.previewUrl || ''}`).join('|');
}

function getAttachmentKindSignature(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return '';
  return attachments.map((item) => `${item?.kind || ''}:${item?.contentType || ''}`).join('|');
}

function getAttachmentCount(message) {
  return Array.isArray(message?.attachments) ? message.attachments.length : 0;
}

function mergeMessageRecords(left, right) {
  const leftScore = messageRecordScore(left);
  const rightScore = messageRecordScore(right);
  const primary = rightScore >= leftScore ? right : left;
  const secondary = primary === right ? left : right;
  return {
    ...secondary,
    ...primary,
    raw: primary.raw || secondary.raw,
    reactions: mergeReactionLists(secondary.reactions, primary.reactions)
  };
}

function mergeReactionLists(left, right) {
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

function messageRecordScore(message) {
  let score = 0;
  if (!message) return score;
  if (message.raw?.msgId) score += 4;
  if (message.raw?.cliMsgId) score += 3;
  if (!String(message.id || '').startsWith('local-')) score += 2;
  if (message.reactions?.length) score += 1;
  return score;
}

function recalcThreadSummary(state, threadId, options = {}) {
  const thread = state.threads[threadId];
  if (!thread) return;
  const messages = state.messages[threadId] || [];
  const lastMessage = messages[messages.length - 1];
  thread.lastMessageAt = lastMessage?.createdAt || thread.lastMessageAt || null;
  thread.lastMessageText = summarizeThreadMessage(lastMessage) || thread.lastMessageText || '';
  if (options.resetUnread) {
    thread.unreadCount = options.unreadCount ?? 0;
  } else if (options.incrementUnread) {
    thread.unreadCount = (thread.unreadCount || 0) + 1;
  }
}

function summarizeThreadMessage(message) {
  if (!message) return '';
  const type = String(message.type || '');
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const text = String(message.text || '').trim();
  if (type.includes('sticker')) return 'Sticker';
  if (attachments.length && attachments.every((item) => item?.kind === 'image')) return attachments.length > 1 ? `[${attachments.length} ảnh]` : '[Ảnh]';
  if (attachments.length) return attachments.length > 1 ? `[${attachments.length} tệp]` : '[Tệp đính kèm]';
  return text || type;
}

const viewCache = new WeakMap();

export function buildView(state) {
  const revision = getStateRevision(state);
  const cached = viewCache.get(state);
  if (cached && cached.revision === revision) return cached.value;
  const now = Date.now();
  const recentCutoffIso = new Date(now - RECENT_THREAD_WINDOW_MS).toISOString();
  const locallyDeleted = new Set((state.zalo?.locallyDeletedThreads || []).map(String));
  const allThreads = Object.values(state.threads)
    .filter((thread) => !locallyDeleted.has(String(thread.id)))
    .map((thread) => ({
      ...thread,
      participants: (Array.isArray(thread.participantIds) ? thread.participantIds : []).map((id) => state.contacts[id]).filter(Boolean),
      messages: (state.messages[thread.id] || []).slice(-MAX_VIEW_MESSAGES_PER_THREAD).map(serializeMessageForView)
    }));

  const sortThreads = (items) => [...items].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || ''));
  });

  const threads = sortThreads(allThreads.filter((thread) => hasRecentThreadActivity(thread, recentCutoffIso)));
  const searchableThreads = sortThreads(allThreads.filter((thread) => thread.type === 'group' && !hasRecentThreadActivity(thread, recentCutoffIso))).map((thread) => ({
    ...thread,
    messages: []
  }));

  const built = {
    activeAccountId: state.activeAccountId || null,
    accounts: Object.values(state.accounts || {}).sort((a, b) => String(a.displayName || a.userId || '').localeCompare(String(b.displayName || b.userId || ''))),
    integration: state.integration || {},
    aiAutomation: normalizeAiAutomationConfig(state.aiAutomation || {}),
    aiAutomationByDepartment: normalizeAiAutomationDepartmentMap(state.aiAutomationByDepartment || {}, state.aiAutomation || {}),
    aiAutomationUsage: normalizeAiAutomationUsage(state.aiAutomationUsage || {}),
    aiAutomationLogs: normalizeAiAutomationLogs((state.aiAutomationLogs || []).filter((entry) => String(entry.accountId || '') === String(state.activeAccountId || ''))),
    session: state.session,
    labels: state.labels,
    zalo: state.zalo,
    threads,
    searchableThreads,
    contacts: Object.values(state.contacts),
    stats: {
      threadCount: threads.length,
      unreadThreads: threads.filter((thread) => (thread.unreadCount || 0) > 0).length,
      unreadMessages: threads.reduce((sum, thread) => sum + (thread.unreadCount || 0), 0)
    }
  };
  viewCache.set(state, { revision, value: built });
  return built;
}

function hasRecentThreadActivity(thread, recentCutoffIso) {
  return Boolean(thread?.lastMessageAt) && String(thread.lastMessageAt) >= String(recentCutoffIso);
}

function normalizeAiAutomationLogs(input = []) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item && typeof item === 'object')
    .slice(0, MAX_AI_AUTOMATION_LOG_ITEMS)
    .map((item) => ({
      id: String(item.id || ''),
      at: item.at || null,
      accountId: item.accountId || null,
      threadId: item.threadId || null,
      departmentId: item.departmentId || null,
      senderId: item.senderId || null,
      direction: item.direction || 'inbound',
      stage: item.stage || 'decision',
      status: item.status || 'info',
      reason: item.reason || null,
      decision: item.decision || null,
      provider: item.provider || null,
      modelId: item.modelId || null,
      modelTier: item.modelTier || null,
      tokens: Number(item.tokens || 0),
      costUsd: Number(item.costUsd || 0),
      textPreview: item.textPreview || '',
      replyPreview: item.replyPreview || '',
      error: item.error || null
    }));
}

function serializeMessageForView(message) {
  if (!message || typeof message !== 'object') return message;
  const next = {
    ...message,
    text: isHugeInlineImage(message.text) ? summarizeThreadMessage(message) : message.text,
    attachments: (Array.isArray(message.attachments) ? message.attachments : []).map((item) => ({
      ...item,
      url: isHugeInlineImage(item?.url) ? null : item?.url || null,
      previewUrl: isHugeInlineImage(item?.previewUrl) ? null : item?.previewUrl || null
    })),
    album: message.album || null,
    quote: message.quote || null,
    mentions: Array.isArray(message.mentions) ? message.mentions : []
  };
  if (message.raw && typeof message.raw === 'object') {
    next.raw = {
      msgId: message.raw.msgId || null,
      cliMsgId: message.raw.cliMsgId || null,
      uidFrom: message.raw.uidFrom || null,
      ts: message.raw.ts || null,
      msgType: message.raw.msgType || null,
      ttl: message.raw.ttl ?? null,
      propertyExt: message.raw.propertyExt || null
    };
  }
  return next;
}

function isHugeInlineImage(value) {
  return typeof value === 'string' && value.startsWith('data:image/');
}

export function resetChatState(state) {
  state.contacts = {};
  state.threads = {};
  state.messages = {};
}

export function createEmptyAccountState() {
  return {
    labels: structuredClone(DEFAULT_STATE.labels),
    zalo: structuredClone(DEFAULT_STATE.zalo),
    contacts: {},
    threads: {},
    messages: {},
    session: {
      account: null,
      syncInfo: null,
      status: null,
      updatedAt: null
    }
  };
}

export function updateAccountScopedState(state, accountId, mutator) {
  // Bucket model:
  // - state.accountStateById[accountId] is the real per-account storage bucket.
  // - global state.contacts/threads/messages is only the currently-open account view.
  // Mutations must target exactly one bucket, then optionally mirror into global if that bucket is active.
  const key = String(accountId || state?.activeAccountId || '').trim();
  if (!key) return null;
  const storedSnapshot = getAccountScopedState(state, key);
  // A changed activeAccountId does not establish ownership of the global view.
  // Preserve legacy global-only history only when its session identifies this account.
  const globalOwnerId = String(state.session?.account?.id || '').trim();
  const snapshot = storedSnapshot || (key === String(state.activeAccountId || '') && globalOwnerId === key
    ? buildAccountSnapshotFromGlobal(state, key)
    : createEmptyAccountState());

  const nextSnapshot = sanitizeAccountSnapshot(key, mutator(snapshot) || snapshot);
  state.accountStateById = state.accountStateById || {};
  state.accountStateById[key] = structuredClone(nextSnapshot);

  if (key === String(state.activeAccountId || '')) {
    applyAccountSnapshotToGlobal(state, nextSnapshot);
  }

  return nextSnapshot;
}

export function getAccountScopedState(state, accountId = null) {
  const key = String(accountId === null ? state?.activeAccountId || '' : accountId).trim();
  if (!key) return null;
  const snapshot = state?.accountStateById?.[key];
  if (!snapshot || typeof snapshot !== 'object') return null;
  return structuredClone(sanitizeAccountSnapshot(key, snapshot));
}

export function switchActiveAccountState(state, accountId) {
  // Switching account means:
  // 1) persist the current open bucket back into accountStateById[previousKey]
  // 2) load the target bucket into the global view
  // No chat/contact/message object should be shared across buckets.
  const key = String(accountId || '').trim();
  if (!key) return null;
  state.accountStateById = state.accountStateById || {};
  const previousKey = String(state.activeAccountId || '').trim();
  if (previousKey && previousKey !== key && String(state.session?.account?.id || '') === previousKey) {
    state.accountStateById[previousKey] = buildAccountSnapshotFromGlobal(state, previousKey);
  }
  const snapshot = getAccountScopedState(state, key) || createEmptyAccountState();
  state.activeAccountId = key;
  applyAccountSnapshotToGlobal(state, snapshot);
  return snapshot;
}

function persistActiveAccountSnapshot(state) {
  if (!state || typeof state !== 'object') return;
  const accountId = String(state.activeAccountId || '').trim();
  if (!accountId) return;
  if (String(state.session?.account?.id || '') !== accountId) return;
  state.accountStateById = state.accountStateById || {};
  state.accountStateById[accountId] = buildAccountSnapshotFromGlobal(state, accountId, { updatedAt: new Date().toISOString() });
}

function buildAccountSnapshotFromGlobal(state, accountId, sessionOverrides = {}) {
  // Snapshot the currently-open global view back into a single account bucket.
  return sanitizeAccountSnapshot(accountId, {
    labels: structuredClone(state.labels || { items: [], version: 0, lastUpdateTime: 0 }),
    zalo: structuredClone(state.zalo || {}),
    contacts: structuredClone(state.contacts || {}),
    threads: structuredClone(state.threads || {}),
    messages: structuredClone(state.messages || {}),
    session: {
      account: structuredClone(state.session?.account || null),
      syncInfo: structuredClone(state.session?.syncInfo || null),
      status: state.session?.status || null,
      updatedAt: state.session?.updatedAt || null,
      ...sessionOverrides
    }
  });
}

function applyAccountSnapshotToGlobal(state, snapshot) {
  // Mirror one account bucket into the global view layer used by the UI/API response.
  state.labels = structuredClone(snapshot.labels || DEFAULT_STATE.labels);
  state.zalo = structuredClone(snapshot.zalo || DEFAULT_STATE.zalo);
  state.contacts = structuredClone(snapshot.contacts || {});
  state.threads = structuredClone(snapshot.threads || {});
  state.messages = structuredClone(snapshot.messages || {});
  state.session = {
    ...state.session,
    account: structuredClone(snapshot.session?.account || null),
    syncInfo: structuredClone(snapshot.session?.syncInfo || null),
    status: snapshot.session?.status || state.session?.status || null,
    updatedAt: snapshot.session?.updatedAt || state.session?.updatedAt || null
  };
}

function sanitizeAccountSnapshot(accountId, snapshot) {
  const ownId = String(snapshot?.session?.account?.id || accountId || '');
  const threads = snapshot?.threads || {};
  const messages = snapshot?.messages || {};
  const nextMessages = {};

  for (const [threadId, items] of Object.entries(messages)) {
    const thread = threads[threadId];
    if (!thread) continue;
    const normalized = (Array.isArray(items) ? items : [])
      .filter((message) => String(message?.threadId || threadId) === String(threadId))
      .filter((message) => {
        if (thread.type !== 'direct') return true;
        const senderId = String(message?.senderId || '');
        return senderId === ownId || senderId === String(threadId);
      });
    nextMessages[threadId] = normalized;
  }

  return {
    ...snapshot,
    threads,
    messages: nextMessages
  };
}
