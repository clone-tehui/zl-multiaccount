import { randomUUID } from 'node:crypto';
import { buildView, updateAccountScopedState } from '../lib/store.js';
import { buildAgentPlan, buildHiddenCustomerContext, patchThreadAutomationState, runIsolatedAgent } from './ai-automation-service.js';
import { logExecutionStep, readExecutionLogs } from './agent-system-db.js';
import { AUTOMATION_ACTIONS, AUTOMATION_RESULTS, buildAutomationDecision, createAutomationAction, normalizeAutomationInboundEvent } from './ai-automation-contract.js';
import { generateOpenRouterReply, recordAiAutomationUsage } from './ai-automation-openrouter.js';
import { sendTelegramAlert } from './telegram-alert-service.js';

const HUMAN_REQUEST_RE = /người thật|nhân viên|quản lý|gặp người|gọi giúp/i;
const BOOKING_DATE_RE = /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/;
const BOOKING_GUEST_RE = /\b\d+\s*(khách|người|phòng|phòng ngủ|pn|giường|giuong|pax|adults?)\b/i;
const BOOKING_NATURAL_DATE_RE = /hôm nay|ngày mai|cuối tuần|tháng này/i;
const GREETING_RE = /xin chào|hello|\bhi\b|\balo\b|ad ơi|shop ơi|bên mình ơi/i;
const NEGATIVE_RE = /khiếu nại|bực|tức|không hài lòng|refund|hoàn tiền/;
const DEFAULT_ESCALATION_MESSAGE = 'Dạ em đã ghi nhận nội dung này và đang chuyển người phụ trách hỗ trợ ngay ạ.';
const MAX_AUTOMATION_LOG_ITEMS = 200;
const MAX_LOG_PREVIEW_CHARS = 180;

export function analyzeAutomationInput({ message, thread, portalBinding, config, confidence = 0.86, now = Date.now() } = {}) {
  const text = String(message?.text || '').trim();
  const intent = inferAutomationIntent(text, message);
  const complexity = inferAutomationComplexity(text, message);
  const sentiment = inferAutomationSentiment(text);
  const asksHuman = HUMAN_REQUEST_RE.test(text);
  const repeatedQuestions = countRepeatedQuestions(thread, text);
  const plan = buildAgentPlan({
    message,
    thread,
    portalBinding,
    config,
    intent,
    confidence,
    complexity,
    asksHuman,
    repeatedQuestions,
    sentiment,
    now
  });
  return { text, intent, complexity, sentiment, asksHuman, repeatedQuestions, plan };
}

async function analyzeAutomationInputWithAgentRouter({ message, thread, portalBinding, config, confidence = 0.86, now = Date.now() } = {}) {
  const deterministic = analyzeAutomationInput({ message, thread, portalBinding, config, confidence, now });
  const routed = await inferAutomationRouteWithAgent({ message, thread, portalBinding, config, fallbackIntent: deterministic.intent });
  if (!routed?.intent) return deterministic;
  if (routed.intent === deterministic.intent) {
    attachAgentRouteToPlan(deterministic.plan, routed);
    return { ...deterministic, agentRoute: routed };
  }
  const plan = buildAgentPlan({
    message,
    thread,
    portalBinding,
    config,
    intent: routed.intent,
    confidence: Number(routed.confidence || confidence),
    complexity: routed.complexity || deterministic.complexity,
    asksHuman: deterministic.asksHuman,
    repeatedQuestions: deterministic.repeatedQuestions,
    sentiment: deterministic.sentiment,
    now
  });
  attachAgentRouteToPlan(plan, routed);
  return {
    ...deterministic,
    intent: routed.intent,
    complexity: routed.complexity || deterministic.complexity,
    agentRoute: routed,
    plan
  };
}

function attachAgentRouteToPlan(plan = null, routed = null) {
  if (!plan || !routed || typeof plan !== 'object') return plan;
  plan.executionSignals = {
    ...(plan.executionSignals || {}),
    aiRoute: routed,
    needsKnowledge: Boolean(routed.needsKnowledge),
    needsLiveAvailability: Boolean(routed.needsLiveAvailability),
    needsHumanReview: Boolean(routed.needsHumanReview),
    sensitiveHandling: Boolean(routed.sensitiveHandling),
    toolPolicy: Array.isArray(routed.tools) ? routed.tools : []
  };
  return plan;
}

async function inferAutomationRouteWithAgent({ message = {}, thread = {}, portalBinding = null, config = {}, fallbackIntent = 'general' } = {}) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) return null;
  const model = pickRouterModel(config);
  if (!model) return null;
  const currentText = String(message?.text || '').trim();
  if (!currentText) return null;
  const hiddenCustomerContext = buildHiddenCustomerContext(thread);
  const recent = (Array.isArray(thread?.messages) ? thread.messages : [])
    .slice(-8)
    .map((item) => `${item?.isOutgoing ? 'ChiHome' : 'Khách'}: ${String(item?.text || '').replace(/\s+/g, ' ').trim()}`)
    .filter(Boolean)
    .join('\n');
  const body = {
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: [
          'Bạn là AI router/orchestrator cho CSKH ChiHome. Nhiệm vụ: đọc TIN NHẮN HIỆN TẠI của khách và chọn intent/tool route phù hợp. Không trả lời khách.',
          'Ưu tiên ý chính của tin nhắn hiện tại hơn lịch sử. Lịch sử chỉ để hiểu ngữ cảnh, không được tự lấy ngày/số phòng từ lịch sử để biến câu hỏi khác thành tìm phòng.',
          'Có thể có customerContext ẩn lấy từ tag CRM/booking. Chỉ dùng như bối cảnh phụ để hiểu tình huống tinh tế hơn và chọn tool đúng hơn. Vẫn tư vấn/chăm sóc khách bình thường, đặc biệt vẫn tư vấn chọn phòng bình thường khi khách hỏi. Tuyệt đối không nhắc tag, trạng thái nội bộ, lịch sử đặt phòng hoặc “em thấy anh/chị đã...” trong câu trả lời khách.',
          'Các intent hợp lệ: greeting, availability, quote, booking, pricing, room_info, building_info, amenities, policy, checkin, checkout, service, complaint, refund, urgent, general.',
          'Nếu khách hỏi giờ nhận/trả phòng, quy định, hồ bơi/gym, wifi, thẻ, máy nước nóng, phụ phí, nội quy: chọn checkin/checkout/policy/service/amenities phù hợp, KHÔNG chọn availability chỉ vì có chữ đặt phòng/phòng.',
          'Chỉ chọn availability/quote/booking khi khách thật sự muốn kiểm tra còn phòng/tìm căn/báo giá theo ngày ở/số khách/số phòng ngủ.',
          'Quan trọng: trước khi để composer trả lời fact/policy/fee/quy định/hướng dẫn vận hành, phải quyết định tool. Nếu có khả năng câu trả lời nằm trong tài liệu nội bộ ChiHome thì needsKnowledge=true/tools có knowledge. Nếu cần dữ liệu phòng/giá/ngày ở thật thì needsLiveAvailability=true/tools có live_availability. Nếu câu tế nhị/khiếu nại/pháp lý/hoàn tiền/khách tức giận thì tools có human_review hoặc policy_guard.',
          'Không được chọn tools none cho câu hỏi về chính sách, phí, tiện ích, check-in/check-out, thẻ, wifi, gửi xe, hồ bơi/gym, nội quy, thanh toán, cọc, huỷ, hoặc câu cần dữ liệu live.',
          'Trả JSON thuần: {"intent":"...","confidence":0-1,"complexity":"simple|structured|complex","needsKnowledge":boolean,"needsLiveAvailability":boolean,"needsHumanReview":boolean,"sensitiveHandling":boolean,"tools":["knowledge"|"live_availability"|"pricing"|"policy_guard"|"human_review"|"none"],"reason":"ngắn"}'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify({
          departmentId: portalBinding?.departmentId || null,
          currentMessage: currentText,
          recentContext: recent,
          customerContext: hiddenCustomerContext,
          fallbackIntent
        })
      }
    ]
  };
  try {
    const response = await fetch(`${String(process.env.OPENROUTER_API_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const text = String(payload?.choices?.[0]?.message?.content || '').trim();
    const json = parseRouterJson(text);
    const intent = normalizeRouterIntent(json?.intent);
    if (!intent) return null;
    return {
      intent,
      confidence: Number(json?.confidence || 0.86),
      complexity: ['simple', 'structured', 'complex'].includes(String(json?.complexity)) ? String(json.complexity) : 'simple',
      needsKnowledge: Boolean(json?.needsKnowledge) || normalizeRouterTools(json?.tools).includes('knowledge'),
      needsLiveAvailability: Boolean(json?.needsLiveAvailability) || normalizeRouterTools(json?.tools).includes('live_availability'),
      needsHumanReview: Boolean(json?.needsHumanReview) || normalizeRouterTools(json?.tools).includes('human_review'),
      sensitiveHandling: Boolean(json?.sensitiveHandling),
      tools: normalizeRouterTools(json?.tools),
      reason: String(json?.reason || '').slice(0, 200),
      modelId: model
    };
  } catch {
    return null;
  }
}

function pickRouterModel(config = {}) {
  const catalog = Array.isArray(config.modelCatalog) ? config.modelCatalog : [];
  const preferredTier = String(config.modelRouter?.classify || 'small');
  return (catalog.find((item) => item?.tier === preferredTier && item?.modelId)
    || catalog.find((item) => item?.modelId)
    || null)?.modelId || '';
}

function parseRouterJson(text = '') {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(raw); } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function normalizeRouterTools(value = []) {
  const allowed = new Set(['knowledge', 'live_availability', 'pricing', 'policy_guard', 'human_review', 'none']);
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(items.map((item) => String(item || '').trim().toLowerCase()).filter((item) => allowed.has(item)))];
}

function normalizeRouterIntent(value = '') {
  const intent = String(value || '').trim().toLowerCase();
  const allowed = new Set(['greeting', 'availability', 'quote', 'booking', 'pricing', 'room_info', 'building_info', 'amenities', 'policy', 'checkin', 'checkout', 'service', 'complaint', 'refund', 'urgent', 'general']);
  return allowed.has(intent) ? intent : '';
}

export async function composeAutomationReply({ message, plan, portalBinding }) {
  const text = String(message?.text || '').trim();
  const signal = plan.executionSignals || {};
  const intent = String(signal.intent || 'general');
  const hasAttachments = Boolean(signal.hasAttachments);
  const isChiHome = isChiHomeDepartmentName(portalBinding?.departmentId, portalBinding?.channelId);

  if (intent === 'availability' || intent === 'quote' || intent === 'pricing' || intent === 'booking') {
    const needsDates = !BOOKING_DATE_RE.test(text) && !BOOKING_NATURAL_DATE_RE.test(text);
    const needsGuestCount = !BOOKING_GUEST_RE.test(text);
    const missing = [];
    if (needsDates) missing.push('ngày check-in / check-out');
    if (needsGuestCount) missing.push('số khách hoặc số phòng cần đặt');
    if (missing.length) {
      return `Dạ em hỗ trợ kiểm tra phòng rất nhanh ạ. Anh/chị cho em xin ${missing.join(' và ')} để em kiểm tra chính xác rồi báo lại ngay nhé.`;
    }
    return isChiHome
      ? 'Dạ em đã nhận yêu cầu kiểm tra phòng/giá. Em đang đối chiếu thông tin để báo phương án phù hợp nhanh nhất cho anh/chị ạ.'
      : 'Dạ em đã nhận yêu cầu báo giá/kiểm tra availability. Em đang kiểm tra lại thông tin để phản hồi ngay ạ.';
  }

  if (intent === 'service' || intent === 'amenities' || intent === 'room_info' || intent === 'building_info') {
    return isChiHome
      ? 'Dạ em đã nhận câu hỏi về tiện ích / thông tin phòng. Anh/chị cho em biết giúp em mình đang quan tâm toà hoặc loại phòng nào để em trả lời đúng nhất nhé.'
      : 'Dạ em đã nhận câu hỏi về tiện ích / thông tin phòng. Anh/chị cho em biết thêm phòng hoặc nhu cầu cụ thể để em trả lời chính xác nhé.';
  }

  if (intent === 'policy' || intent === 'checkin' || intent === 'checkout') {
    return isChiHome
      ? 'Dạ em đã nhận câu hỏi về chính sách / check-in / check-out. Em đang đối chiếu thông tin chuẩn để phản hồi đúng nhất cho anh/chị ạ.'
      : 'Dạ em đã nhận câu hỏi về chính sách / check-in / check-out. Em đang kiểm tra lại thông tin chuẩn để phản hồi ngay ạ.';
  }

  if (hasAttachments) {
    return 'Dạ em đã nhận được ảnh / tệp anh/chị gửi. Em đang xem nội dung và sẽ phản hồi ngắn gọn, đúng ý nhất ngay ạ.';
  }

  if (intent === 'greeting' || GREETING_RE.test(text)) {
    return isChiHome
      ? 'Dạ em đây ạ. Anh/chị cần hỗ trợ đặt phòng, kiểm tra phòng trống, báo giá, tiện ích hay chính sách nào để em hỗ trợ ngay nhé.'
      : 'Dạ em đây ạ. Anh/chị cần em hỗ trợ nội dung gì để em xử lý ngay nhé.';
  }

  return 'Dạ em đã nhận tin nhắn. Anh/chị nói rõ thêm giúp em nhu cầu chính để em hỗ trợ nhanh và đúng hơn nhé.';
}

export async function previewAutomationOutcome({ message, thread, portalBinding, config, confidence = 0.86, now = Date.now(), threadId = null, accountId = null, channel = 'unknown' } = {}) {
  const analysis = await analyzeAutomationInputWithAgentRouter({ message, thread, portalBinding, config, confidence, now });
  const replyText = analysis.plan.shouldReply && analysis.plan.action !== AUTOMATION_RESULTS.ESCALATE
    ? await composeAutomationReply({ message, plan: analysis.plan, portalBinding })
    : null;

  const actions = [];
  if (analysis.plan.action === AUTOMATION_RESULTS.ESCALATE) {
    actions.push(createAutomationAction(AUTOMATION_ACTIONS.PATCH_THREAD, {
      patchType: 'escalation',
      reason: analysis.plan.reason,
      modelTier: analysis.plan.modelTier || 'large'
    }));
    actions.push(createAutomationAction(AUTOMATION_ACTIONS.SEND_REPLY, {
      threadId,
      accountId,
      text: DEFAULT_ESCALATION_MESSAGE
    }));
    actions.push(createAutomationAction(AUTOMATION_ACTIONS.EMIT_EVENT, {
      type: 'thread.meta_updated',
      action: 'automation'
    }));
    return buildAutomationDecision({
      result: AUTOMATION_RESULTS.ESCALATE,
      shouldReply: false,
      plan: analysis.plan,
      analysis,
      escalationMessage: DEFAULT_ESCALATION_MESSAGE,
      actions
    });
  }

  if (analysis.plan.shouldReply && replyText) {
    actions.push(createAutomationAction(AUTOMATION_ACTIONS.SEND_REPLY, {
      threadId,
      accountId,
      text: replyText
    }));
    actions.push(createAutomationAction(AUTOMATION_ACTIONS.PATCH_THREAD, {
      patchType: 'reply',
      reason: analysis.plan.reason,
      modelTier: analysis.plan.modelTier || null
    }));
    actions.push(createAutomationAction(AUTOMATION_ACTIONS.EMIT_EVENT, {
      type: 'thread.meta_updated',
      action: 'automation'
    }));
    return buildAutomationDecision({
      result: AUTOMATION_RESULTS.REPLY,
      shouldReply: true,
      plan: analysis.plan,
      analysis,
      replyText,
      actions
    });
  }

  return buildAutomationDecision({
    result: AUTOMATION_RESULTS.SKIP,
    shouldReply: false,
    plan: analysis.plan,
    analysis,
    actions
  });
}

export function createAiAutomationRuntime({
  readAppState,
  updateAppState,
  readPortalState,
  resolveThreadRecord,
  resolvePortalThreadBinding,
  getDepartmentIdForThread,
  getConfigForDepartment,
  adapter,
  emitEvent,
  logger = console
} = {}) {
  const inFlight = new Set();

  return {
    queueIncoming(payload) {
      setTimeout(() => {
        this.runIncoming(payload).catch((error) => {
          logger.error?.('[zalo-user-server] ai automation turn failed', error);
        });
      }, 0);
    },

    async preview(payload = {}) {
      const incoming = normalizeAutomationInboundEvent(payload);
      const appState = readAppState();
      const portalDepartmentId = incoming.threadId ? getDepartmentIdForThread(incoming.threadId, incoming.accountId) : (payload?.departmentId || null);
      const baseConfig = getConfigForDepartment(appState, portalDepartmentId);
      const config = {
        ...baseConfig,
        ...(payload?.configOverride && typeof payload.configOverride === 'object' ? payload.configOverride : {}),
        enabled: payload?.forceEnabled === true ? true : baseConfig.enabled
      };
      const thread = incoming.threadId
        ? (resolveThreadRecord(appState, incoming.threadId, incoming.accountId) || {})
        : buildPreviewThread(payload?.thread || {}, payload?.threadMode || 'auto');
      const portalBinding = incoming.threadId ? (resolvePortalThreadBinding(readPortalState(), incoming.threadId, incoming.accountId) || null) : (payload?.portalBinding || null);
      return previewAutomationOutcome({
        channel: incoming.channel,
        accountId: incoming.accountId,
        threadId: incoming.threadId,
        message: incoming.message || {},
        thread,
        portalBinding,
        config,
        confidence: Number(payload?.confidence ?? 0.86),
        now: Number(payload?.now || Date.now())
      });
    },

    async runIncoming(payload) {
      const incoming = normalizeAutomationInboundEvent(payload);
      const executionId = randomUUID();
      let executionStep = 0;
      const traceExecution = ({ nodeType, nodeName, inputData, outputData, modelUsed = null, durationMs = 0 }) => {
        executionStep += 1;
        logExecutionStep({ executionId, stepNumber: executionStep, nodeType, nodeName, inputData, outputData, modelUsed, durationMs });
      };
      const logBase = {
        accountId: incoming.accountId,
        threadId: incoming.threadId,
        senderId: incoming.message?.senderId || null,
        direction: incoming.message?.isOutgoing ? 'outgoing' : 'inbound',
        textPreview: summarizeAutomationText(incoming.message?.text || ''),
        messageKey: getAutomationMessageKey(incoming.message),
        executionId
      };
      traceExecution({
        nodeType: 'ingest',
        nodeName: 'Nhận tin khách',
        inputData: { accountId: incoming.accountId, threadId: incoming.threadId, messageKey: getAutomationMessageKey(incoming.message) },
        outputData: { textPreview: summarizeAutomationText(incoming.message?.text || '') }
      });
      if (!incoming.threadId || !incoming.message || !incoming.accountId) {
        appendAutomationLog(updateAppState, {
          ...logBase,
          stage: 'ingest',
          status: 'skip',
          reason: 'missing-required-fields'
        });
        return;
      }
      if (incoming.message.isOutgoing) {
        appendAutomationLog(updateAppState, {
          ...logBase,
          stage: 'ingest',
          status: 'skip',
          reason: 'outgoing-self-message'
        });
        return;
      }

      const dedupeKey = `${incoming.accountId}:${incoming.threadId}:${String(incoming.message.id || incoming.message.cliMsgId || incoming.message.createdAt || Date.now())}`;
      if (inFlight.has(dedupeKey)) {
        appendAutomationLog(updateAppState, {
          ...logBase,
          stage: 'ingest',
          status: 'skip',
          reason: 'duplicate-inflight'
        });
        return;
      }
      inFlight.add(dedupeKey);

      try {
        const appState = readAppState();
        const portalDepartmentId = getDepartmentIdForThread(incoming.threadId, incoming.accountId);
        const config = getConfigForDepartment(appState, portalDepartmentId);
        if (!config.enabled) {
          appendAutomationLog(updateAppState, {
            ...logBase,
            departmentId: portalDepartmentId,
            stage: 'config',
            status: 'skip',
            reason: 'department-disabled'
          });
          appendAutomationMessageTrace(updateAppState, {
            ...logBase,
            departmentId: portalDepartmentId,
            status: 'skip',
            reason: 'department-disabled',
            nodes: buildTraceNodes({ stage: 'config', status: 'skip', reason: 'AI của bộ phận đang tắt.' })
          });
          return;
        }
        const thread = resolveThreadRecord(appState, incoming.threadId, incoming.accountId);
        if (Array.isArray(config.selectedAccountIds) && config.selectedAccountIds.length && !config.selectedAccountIds.includes(String(incoming.accountId))) {
          appendAutomationLog(updateAppState, {
            ...logBase,
            departmentId: portalDepartmentId,
            stage: 'config',
            status: 'skip',
            reason: 'account-not-enabled'
          });
          appendAutomationMessageTrace(updateAppState, {
            ...logBase,
            departmentId: portalDepartmentId,
            status: 'skip',
            reason: 'account-not-enabled',
            nodes: buildTraceNodes({ stage: 'config', status: 'skip', reason: 'Account Zalo này chưa được chọn trong cấu hình AI của bộ phận.' })
          });
          return;
        }

        if (!thread) {
          appendAutomationLog(updateAppState, {
            ...logBase,
            departmentId: portalDepartmentId,
            stage: 'lookup',
            status: 'skip',
            reason: 'thread-not-found'
          });
          return;
        }

        const portalBinding = resolvePortalThreadBinding(readPortalState(), incoming.threadId, incoming.accountId) || null;
        const decisionStartedAt = Date.now();
        const decision = await previewAutomationOutcome({
          channel: incoming.channel,
          accountId: incoming.accountId,
          threadId: incoming.threadId,
          message: incoming.message,
          thread,
          portalBinding,
          config,
          confidence: 0.86,
          now: Date.now()
        });
        traceExecution({
          nodeType: 'orchestrator',
          nodeName: 'Orchestrator phân luồng',
          inputData: { intent: decision.plan?.executionSignals?.intent || null, textPreview: logBase.textPreview },
          outputData: { result: decision.result, reason: decision.plan?.reason || null, aiRoute: decision.analysis?.agentRoute || null, agents: (decision.plan?.specialistAgents || []).map((agent) => agent.id) },
          modelUsed: decision.plan?.modelTier || null,
          durationMs: Date.now() - decisionStartedAt
        });
        appendAutomationLog(updateAppState, {
          ...logBase,
          departmentId: portalDepartmentId || portalBinding?.departmentId || null,
          stage: 'decision',
          status: decision.result === AUTOMATION_RESULTS.SKIP ? 'skip' : 'ok',
          reason: decision.plan?.reason || null,
          decision: decision.result,
          modelTier: decision.plan?.modelTier || null,
          replyPreview: summarizeAutomationText(decision.replyText || decision.escalationMessage || '')
        });
        if (decision.result === AUTOMATION_RESULTS.ESCALATE) {
          notifyAutomationAlert({
            title: 'Khách khiếu nại / cần người xử lý',
            text: `AI đã dừng tự động và chuyển người phụ trách cho thread ${incoming.threadId}.`,
            details: buildAlertDetails({ incoming, portalDepartmentId, portalBinding, decision, stage: 'escalation' })
          });
        }

        if (decision.result === AUTOMATION_RESULTS.REPLY) {
          const modelStartedAt = Date.now();
          const aiResult = await generateOpenRouterReply({ config, plan: decision.plan, message: incoming.message, thread, portalBinding });
          const requestAt = new Date().toISOString();
          updateAppState((draft) => {
            recordAiAutomationUsage(draft, { departmentId: portalDepartmentId || portalBinding?.departmentId || null, result: aiResult, requestAt });
            return draft;
          });
          traceExecution({
            nodeType: 'model',
            nodeName: 'Model provider',
            inputData: { provider: aiResult.provider || null, requestedAgents: (decision.plan?.specialistAgents || []).map((agent) => agent.id) },
            outputData: { ok: aiResult.ok, replyPreview: summarizeAutomationText(aiResult.text || ''), error: aiResult.ok ? null : (aiResult.details || aiResult.reason || null) },
            modelUsed: aiResult.modelId || null,
            durationMs: Date.now() - modelStartedAt
          });
          appendAutomationLog(updateAppState, {
            ...logBase,
            departmentId: portalDepartmentId || portalBinding?.departmentId || null,
            stage: 'model',
            status: aiResult.ok ? 'ok' : 'error',
            reason: aiResult.ok ? 'reply-generated' : (aiResult.reason || 'reply-failed'),
            decision: decision.result,
            provider: aiResult.provider || null,
            modelId: aiResult.modelId || null,
            modelTier: decision.plan?.modelTier || null,
            tokens: Number(aiResult.usage?.totalTokens || 0),
            costUsd: Number(aiResult.usage?.costUsd || 0),
            replyPreview: summarizeAutomationText(aiResult.text || ''),
            error: aiResult.ok ? null : (aiResult.details || aiResult.reason || null)
          });
          if (!aiResult.ok || aiResult?.liveContext?.status === 'error') {
            notifyAutomationAlert({
              title: 'Lỗi truy vấn / xử lý AI Zalo',
              text: `Có lỗi khi xử lý thread ${incoming.threadId}. Khách không được nhận chi tiết nội bộ.`,
              details: buildAlertDetails({ incoming, portalDepartmentId, portalBinding, decision, aiResult, stage: 'model' })
            });
          }
          if (aiResult.ok && aiResult.text) {
            decision.replyText = aiResult.text;
            decision.aiResult = aiResult;
            const sendReplyAction = (decision.actions || []).find((item) => item.kind === AUTOMATION_ACTIONS.SEND_REPLY);
            if (sendReplyAction) {
              sendReplyAction.payload.text = aiResult.text;
              sendReplyAction.payload.attachmentsUrls = Array.isArray(aiResult.attachmentsUrls) ? aiResult.attachmentsUrls : [];
              sendReplyAction.payload.messageParts = Array.isArray(aiResult.messageParts) ? aiResult.messageParts : [];
            }
          } else {
            // Không gửi câu placeholder kiểu “đang kiểm tra/đang đối chiếu” nếu model/tool không tạo được câu trả lời thật.
            // Trước đây SEND_REPLY được tạo từ composeAutomationReply() nên khi OpenRouter lỗi có thể gửi nhầm câu chờ khách.
            decision.actions = [];
            decision.result = AUTOMATION_RESULTS.SKIP;
            decision.action = AUTOMATION_RESULTS.SKIP;
            decision.shouldReply = false;
            decision.replyText = null;
          }
        }

        const actionResults = await applyDecision({
          decision,
          incomingMessage: incoming.message,
          threadId: incoming.threadId,
          accountId: incoming.accountId,
          portalDepartmentId,
          portalBinding,
          updateAppState,
          getConfigForDepartment,
          adapter,
          emitEvent
        });
        const sendResult = actionResults.find((item) => item.kind === AUTOMATION_ACTIONS.SEND_REPLY) || null;
        if (sendResult) {
          traceExecution({
            nodeType: 'send',
            nodeName: 'Gửi trả lời khách',
            inputData: { threadId: incoming.threadId, accountId: incoming.accountId },
            outputData: { ok: true, replyPreview: summarizeAutomationText(decision.replyText || sendResult.result?.text || '') },
            modelUsed: sendResult.result?.modelId || null,
            durationMs: 0
          });
          appendAutomationLog(updateAppState, {
            ...logBase,
            departmentId: portalDepartmentId || portalBinding?.departmentId || null,
            stage: 'send',
            status: 'ok',
            reason: 'reply-sent',
            decision: decision.result,
            provider: sendResult.result?.provider || null,
            modelId: sendResult.result?.modelId || null,
            modelTier: decision.plan?.modelTier || null,
            replyPreview: summarizeAutomationText(decision.replyText || sendResult.result?.text || '')
          });
          appendAutomationMessageTrace(updateAppState, {
            ...logBase,
            departmentId: portalDepartmentId || portalBinding?.departmentId || null,
            status: 'ok',
            reason: 'reply-sent',
            decision: decision.result,
            provider: sendResult.result?.provider || null,
            modelId: sendResult.result?.modelId || null,
            modelTier: decision.plan?.modelTier || null,
            replyPreview: summarizeAutomationText(decision.replyText || sendResult.result?.text || ''),
            nodes: buildSuccessTraceNodes({ decision, provider: sendResult.result?.provider || null, modelId: sendResult.result?.modelId || null })
          });
        } else if (decision.result === AUTOMATION_RESULTS.SKIP) {
          appendAutomationMessageTrace(updateAppState, {
            ...logBase,
            departmentId: portalDepartmentId || portalBinding?.departmentId || null,
            status: 'skip',
            reason: decision.plan?.reason || 'skip',
            decision: decision.result,
            nodes: buildTraceNodes({ stage: 'decision', status: 'skip', reason: decision.plan?.reason || 'Không đủ điều kiện trả lời.' })
          });
        }
      } catch (error) {
        appendAutomationLog(updateAppState, {
          ...logBase,
          stage: 'runtime',
          status: 'error',
          reason: 'runtime-exception',
          error: error?.message || 'Unknown automation error'
        });
        appendAutomationMessageTrace(updateAppState, {
          ...logBase,
          status: 'error',
          reason: 'runtime-exception',
          error: error?.message || 'Unknown automation error',
          nodes: buildTraceNodes({ stage: 'runtime', status: 'error', reason: error?.message || 'Runtime exception' })
        });
        notifyAutomationAlert({
          title: 'Runtime exception Zalo AI',
          text: `Có lỗi runtime khi xử lý thread ${incoming.threadId}.`,
          details: { ...logBase, accountId: incoming.accountId, threadId: incoming.threadId, error: error?.message || 'Unknown automation error', stack: error?.stack || null }
        });
        throw error;
      } finally {
        setTimeout(() => inFlight.delete(dedupeKey), 15000);
      }
    }
  };
}

async function applyDecision({ decision, incomingMessage = {}, threadId, accountId, portalDepartmentId, portalBinding, updateAppState, getConfigForDepartment, adapter, emitEvent }) {
  const actionResults = [];
  for (const action of decision.actions || []) {
    if (action.kind === AUTOMATION_ACTIONS.PATCH_THREAD) {
      const now = Date.now();
      const nextState = updateAppState((draft) => {
        const normalizedConfig = getConfigForDepartment(draft, portalDepartmentId || portalBinding?.departmentId || null);
        updateAccountScopedState(draft, accountId, (snapshot) => {
          const targetThread = snapshot.threads?.[threadId];
          if (!targetThread) return snapshot;
          const memoryPatch = action.payload?.patchType === 'escalation'
            ? {}
            : buildAutomationMemoryPatch({
                currentAutomation: targetThread.automation || {},
                plan: decision.plan || {},
                incomingMessage,
                replyText: decision.replyText || '',
                aiResult: decision.aiResult || null,
                now
              });
          targetThread.automation = action.payload?.patchType === 'escalation'
            ? patchThreadAutomationState(targetThread.automation || {}, {
                mode: 'paused_by_escalation',
                reason: 'AI tự dừng do phát hiện complaint / case cần người thật.',
                lastEscalatedAt: new Date(now).toISOString(),
                escalationCount: Number(targetThread.automation?.escalationCount || 0) + 1,
                lastDecision: { action: 'escalate', reason: action.payload?.reason, modelTier: action.payload?.modelTier || 'large', at: new Date(now).toISOString() }
              }, normalizedConfig, now)
            : patchThreadAutomationState(targetThread.automation || {}, {
                lastDecision: { action: 'reply', reason: action.payload?.reason, modelTier: action.payload?.modelTier || null, at: new Date(now).toISOString() },
                ...memoryPatch
              }, normalizedConfig, now);
          return snapshot;
        });
        return draft;
      });
      action.__nextState = nextState;
      continue;
    }

    if (action.kind === AUTOMATION_ACTIONS.SEND_REPLY) {
      const result = await adapter?.execute?.(action, { threadId, accountId });
      actionResults.push({ kind: action.kind, result });
      continue;
    }

    if (action.kind === AUTOMATION_ACTIONS.EMIT_EVENT) {
      const viewSource = (decision.actions || []).find((item) => item.__nextState)?.__nextState || null;
      const view = viewSource ? buildView(viewSource) : undefined;
      emitEvent?.(action.payload?.type || 'thread.meta_updated', { threadId, accountId, action: action.payload?.action || 'automation', ...(view ? { view } : {}) });
    }
  }
  return actionResults;
}

function notifyAutomationAlert(payload = {}) {
  sendTelegramAlert(payload).catch((error) => {
    console.error('[zalo-user-server] telegram alert failed:', error?.message || error);
  });
}

function buildAlertDetails({ incoming = {}, portalDepartmentId = null, portalBinding = null, decision = null, aiResult = null, stage = '' } = {}) {
  return {
    stage,
    accountId: incoming.accountId || null,
    threadId: incoming.threadId || null,
    messageId: incoming.message?.id || incoming.message?.cliMsgId || null,
    customerText: summarizeAutomationText(incoming.message?.text || '', 500),
    departmentId: portalDepartmentId || portalBinding?.departmentId || null,
    intent: decision?.plan?.executionSignals?.intent || null,
    decision: decision?.result || null,
    modelTier: decision?.plan?.modelTier || null,
    provider: aiResult?.provider || null,
    modelId: aiResult?.modelId || null,
    reason: aiResult?.reason || aiResult?.liveContext?.reason || decision?.plan?.reason || null,
    error: aiResult?.details || aiResult?.liveContext?.error || null,
    safeReplyPreview: summarizeAutomationText(aiResult?.text || decision?.replyText || decision?.escalationMessage || '', 500)
  };
}

function buildAutomationMemoryPatch({ currentAutomation = {}, plan = {}, incomingMessage = {}, replyText = '', aiResult = null, now = Date.now() } = {}) {
  const currentAgentMemories = currentAutomation?.agentMemories && typeof currentAutomation.agentMemories === 'object'
    ? currentAutomation.agentMemories
    : {};
  const currentMemoryRows = Array.isArray(currentAutomation?.memoryRows)
    ? currentAutomation.memoryRows
    : [];
  const customerText = summarizeAutomationText(incomingMessage?.text || '');
  const replyPreview = summarizeAutomationText(replyText || '');
  const intent = String(plan?.executionSignals?.intent || '').trim() || null;
  const updatedAt = new Date(now).toISOString();
  const conversationSummary = [
    intent ? `Intent gần nhất: ${intent}` : '',
    customerText ? `Khách hỏi: ${customerText}` : '',
    replyPreview ? `Đã trả lời: ${replyPreview}` : ''
  ].filter(Boolean).join(' | ');
  const nextAgentMemories = { ...currentAgentMemories };
  for (const agent of Array.isArray(plan?.specialistAgents) ? plan.specialistAgents : []) {
    const agentId = String(agent?.id || '').trim();
    if (!agentId) continue;
    const role = String(agent?.label || agent?.role || agentId).trim();
    const summary = [
      role ? `Vai trò: ${role}` : '',
      intent ? `intent=${intent}` : '',
      customerText ? `khách hỏi="${customerText}"` : '',
      replyPreview ? `reply="${replyPreview}"` : ''
    ].filter(Boolean).join(' | ');
    nextAgentMemories[agentId] = {
      ...(currentAgentMemories[agentId] || {}),
      lastIntent: intent,
      lastCustomerMessage: customerText || null,
      lastReply: replyPreview || null,
      summary,
      updatedAt
    };
  }
  const nextMemoryRows = [...currentMemoryRows];
  if (customerText) {
    nextMemoryRows.push({
      id: `mem_${now}_customer_${Math.random().toString(36).slice(2, 8)}`,
      scope: 'conversation',
      kind: 'customer',
      intent,
      text: customerText,
      createdAt: updatedAt
    });
  }
  if (replyPreview) {
    nextMemoryRows.push({
      id: `mem_${now}_reply_${Math.random().toString(36).slice(2, 8)}`,
      scope: 'conversation',
      kind: 'reply',
      intent,
      text: replyPreview,
      createdAt: updatedAt
    });
  }
  const availabilityMemory = buildAvailabilityMemory({ currentAutomation, aiResult });
  return {
    conversationMemory: {
      ...(currentAutomation?.conversationMemory || {}),
      lastIntent: intent,
      lastCustomerMessage: customerText || null,
      lastReply: replyPreview || null,
      summary: conversationSummary || null,
      ...(availabilityMemory ? { lastAvailability: availabilityMemory } : {}),
      updatedAt
    },
    agentMemories: nextAgentMemories,
    memoryRows: nextMemoryRows.slice(-500)
  };
}

function buildAvailabilityMemory({ currentAutomation = {}, aiResult = null } = {}) {
  const liveContext = aiResult?.liveContext;
  const rooms = Array.isArray(liveContext?.rooms) ? liveContext.rooms : [];
  if (!liveContext?.searched || !rooms.length) return null;
  const allRoomCodes = rooms.map((room) => normalizeRoomCodeForMemory(room)).filter(Boolean);
  const previous = currentAutomation?.conversationMemory?.lastAvailability || {};
  const previousSent = new Set(liveContext?.fromAvailabilityMemory
    ? (Array.isArray(previous.sentRoomCodes) ? previous.sentRoomCodes : []).map(normalizeCodeForMemory).filter(Boolean)
    : []);
  const currentlyShown = Array.isArray(liveContext?.lastShownRoomCodes)
    ? liveContext.lastShownRoomCodes.map(normalizeCodeForMemory).filter(Boolean)
    : collectShownRoomCodesFromMessageParts(aiResult?.messageParts);
  for (const code of currentlyShown) previousSent.add(code);
  return {
    liveContext: sanitizeLiveContextForMemory(liveContext),
    rooms: rooms.slice(0, 50),
    dates: liveContext.dates || null,
    search: liveContext.search || null,
    allRoomCodes,
    lastShownRoomCodes: currentlyShown,
    sentRoomCodes: [...previousSent],
    updatedAt: new Date().toISOString()
  };
}

function sanitizeLiveContextForMemory(liveContext = {}) {
  return {
    status: liveContext.status || 'ok',
    searched: Boolean(liveContext.searched),
    dates: liveContext.dates || null,
    search: liveContext.search || null,
    building: liveContext.building || null,
    roomType: liveContext.roomType || null,
    requestedGroup: liveContext.requestedGroup || null
  };
}

function collectShownRoomCodesFromMessageParts(parts = []) {
  const codes = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    const match = String(part?.text || '').match(/\+\s*Căn\s+\d+:\s*([^\n]+)/i);
    if (!match) continue;
    const code = normalizeCodeForMemory(match[1]);
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

function normalizeRoomCodeForMemory(room = {}) {
  return normalizeCodeForMemory(room?.roomCode || room?.roomNumber || room?.number || room?.roomId || '');
}

function normalizeCodeForMemory(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildPreviewThread(thread = {}, defaultMode = 'auto') {
  const next = thread && typeof thread === 'object' ? { ...thread } : {};
  next.automation = next.automation && typeof next.automation === 'object'
    ? { ...next.automation }
    : { mode: String(defaultMode || 'auto') };
  if (!next.automation.mode) next.automation.mode = String(defaultMode || 'auto');
  return next;
}

function inferAutomationIntent(text = '', message = {}) {
  const haystack = String(text || '').toLowerCase();
  const normalized = normalizeAutomationText(haystack);
  if (/khiếu nại|bực|tức|không hài lòng|refund|hoàn tiền|khẩn cấp/.test(haystack)) return 'complaint';
  if (/xin chào|hello|\bhi\b|\balo\b|ad ơi|shop ơi|bên mình ơi/.test(haystack)) return 'greeting';
  if (/check\s*in|check-in|nhận phòng|nhan phong|vao o luc|vao luc may gio|mấy giờ nhận phòng|may gio nhan phong|mấy giờ check in|may gio check in/.test(normalized)) return 'checkin';
  if (/check\s*out|checkout|check-out|trả phòng|tra phong|mấy giờ trả phòng|may gio tra phong/.test(normalized)) return 'checkout';
  if (hasBookingReadySignals(normalized)) return 'availability';
  if (/nội quy|noi quy|chính sách|chinh sach|phụ thu|phu thu|đặt cọc|dat coc|hủy|huy|ho boi|hồ bơi|gym|mất thẻ|mat the|thẻ ra vào|the ra vao|thẻ căn hộ|the can ho|phí thẻ|phi the/.test(normalized)) return 'policy';
  if (hasBookingSearchSignals(normalized)) return 'availability';
  if (/phòng trống|còn phòng|con phong|available|availability|đặt phòng|dat phong|booking|ngày ở|ngay o/.test(haystack)) return 'availability';
  if (/giá|bao nhiêu|rate|báo giá|bao gia/.test(haystack)) return 'pricing';
  if (/tiện ích|tien ich|amenities/.test(haystack)) return 'amenities';
  if (/toà|toa|building|opera|galleria|crest|villa|vinhome|lancaster/.test(haystack)) return 'building_info';
  if (/loại phòng|loai phong|phòng .* gồm|phong .* gom|1 phòng ngủ|2 phòng ngủ|3 phòng ngủ|4 phòng ngủ|studio|biệt thự|biet thu/.test(haystack)) return 'room_info';
  if (/dịch vụ|dich vu|service|wifi|wi-fi|internet|máy nước nóng|may nuoc nong|nước nóng|nuoc nong|dọn phòng|don phong|vệ sinh|ve sinh|khăn|khan|bãi xe|bai xe|đỗ xe|do xe|parking/.test(normalized)) return 'service';
  if (Array.isArray(message?.attachments) && message.attachments.length) return 'service';
  return 'general';
}

function normalizeAutomationText(text = '') {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function hasBookingReadySignals(normalizedText = '') {
  const value = String(normalizedText || '');
  const dateTokens = value.match(/\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?|hom kia|hom qua|hom nay|hnay|ngay mai|mai|ngay mot|ngay kia|mot|toi nay|dem nay|toi mai|dem mai/g) || [];
  const hasDateRange = dateTokens.length >= 2 || /\b(in|check\s*in|nhan phong|tu|from)\b.{0,40}\b(out|check\s*out|tra phong|den|toi|to)\b/.test(value) || /\b\d{1,2}\s*(dem|night|nights)\b/.test(value);
  const hasOccupancy = /\b\d+\s*(khach|nguoi|pax|phong ngu|phong|pn|giuong|bed|beds|bedroom|adults?)\b/i.test(value)
    || /\b(biet thu|villa)\b/i.test(value);
  return Boolean(hasDateRange && hasOccupancy);
}

function hasBookingSearchSignals(normalizedText = '') {
  return /\b(can|tim|dat|thue|bao gia|con|kiem tra|check)\b.{0,30}\b(phong|can|pn|giuong|availability|booking)\b/i.test(String(normalizedText || ''));
}

function inferAutomationComplexity(text = '', message = {}) {
  const haystack = String(text || '').toLowerCase();
  if ((Array.isArray(message?.attachments) && message.attachments.length) || /và|hoặc|so sánh|mấy loại|nhiều phương án/.test(haystack)) return 'structured';
  return 'simple';
}

function inferAutomationSentiment(text = '') {
  return NEGATIVE_RE.test(String(text || '').toLowerCase()) ? 'negative' : 'neutral';
}

function getAutomationMessageKey(message = {}) {
  return String(message?.id || message?.msgId || message?.cliMsgId || message?.createdAt || '').trim();
}

function buildTraceNodes({ stage = 'decision', status = 'info', reason = '' } = {}) {
  return [{ stage, label: stage, status, detail: reason }];
}

function buildSuccessTraceNodes({ decision = {}, provider = null, modelId = null } = {}) {
  const signal = decision.plan?.executionSignals || {};
  const agents = Array.isArray(decision.plan?.specialistAgents) ? decision.plan.specialistAgents : [];
  const nodes = [
    { stage: 'ingest', label: 'Nhận tin khách', status: 'ok', detail: signal.intent ? `intent=${signal.intent}` : 'Đã nhận inbound message' },
    { stage: 'orchestrator', label: 'Orchestrator phân luồng', status: 'ok', detail: agents.map((item) => item.id).filter(Boolean).join(' → ') || decision.plan?.reason || '' }
  ];
  for (const agent of agents.filter((item) => item.id !== 'orchestrator')) {
    nodes.push({ stage: 'agent', label: agent.label || agent.id, status: 'ok', detail: `${agent.role || 'agent'} · ${agent.modelId || agent.modelTier || ''}`.trim() });
  }
  nodes.push({ stage: 'model', label: 'Model provider', status: 'ok', detail: [provider, modelId].filter(Boolean).join(' · ') || 'tool/direct reply' });
  nodes.push({ stage: 'send', label: 'Gửi trả lời khách', status: 'ok', detail: decision.result || 'reply' });
  return nodes;
}

function appendAutomationMessageTrace(updateAppState, entry = {}) {
  if (typeof updateAppState !== 'function') return;
  const messageKey = String(entry.messageKey || '').trim();
  if (!entry.accountId || !entry.threadId || !messageKey) return;
  updateAppState((draft) => {
    updateAccountScopedState(draft, entry.accountId, (snapshot) => {
      const targetThread = snapshot.threads?.[entry.threadId];
      if (!targetThread) return snapshot;
      const automation = targetThread.automation && typeof targetThread.automation === 'object' ? targetThread.automation : {};
      const messageTraces = automation.messageTraces && typeof automation.messageTraces === 'object' ? automation.messageTraces : {};
      const trace = {
        id: `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        executionId: entry.executionId || null,
        at: new Date().toISOString(),
        accountId: entry.accountId || null,
        threadId: entry.threadId || null,
        departmentId: entry.departmentId || null,
        messageKey,
        status: entry.status || 'info',
        reason: entry.reason || null,
        decision: entry.decision || null,
        provider: entry.provider || null,
        modelId: entry.modelId || null,
        modelTier: entry.modelTier || null,
        textPreview: summarizeAutomationText(entry.textPreview || ''),
        replyPreview: summarizeAutomationText(entry.replyPreview || ''),
        error: entry.error || null,
        nodes: Array.isArray(entry.nodes) ? entry.nodes : []
      };
      const nextEntries = Object.entries({ ...messageTraces, [messageKey]: trace }).slice(-80);
      targetThread.automation = { ...automation, messageTraces: Object.fromEntries(nextEntries) };
      return snapshot;
    });
    return draft;
  });
}

function appendAutomationLog(updateAppState, entry = {}) {
  if (typeof updateAppState !== 'function') return;
  updateAppState((draft) => {
    const items = Array.isArray(draft.aiAutomationLogs) ? draft.aiAutomationLogs : [];
    items.unshift({
      id: `ai-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      executionId: entry.executionId || null,
      at: new Date().toISOString(),
      accountId: entry.accountId || null,
      threadId: entry.threadId || null,
      departmentId: entry.departmentId || null,
      senderId: entry.senderId || null,
      messageKey: entry.messageKey || null,
      direction: entry.direction || 'inbound',
      stage: entry.stage || 'decision',
      status: entry.status || 'info',
      reason: entry.reason || null,
      decision: entry.decision || null,
      provider: entry.provider || null,
      modelId: entry.modelId || null,
      modelTier: entry.modelTier || null,
      tokens: Number(entry.tokens || 0),
      costUsd: Number(entry.costUsd || 0),
      textPreview: summarizeAutomationText(entry.textPreview || ''),
      replyPreview: summarizeAutomationText(entry.replyPreview || ''),
      error: entry.error || null
    });
    draft.aiAutomationLogs = items.slice(0, MAX_AUTOMATION_LOG_ITEMS);
    return draft;
  });
}

function summarizeAutomationText(value = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_LOG_PREVIEW_CHARS) return text;
  return `${text.slice(0, MAX_LOG_PREVIEW_CHARS)}…`;
}

function countRepeatedQuestions(thread, incomingText) {
  const text = String(incomingText || '').trim().toLowerCase();
  if (!isRepeatedEscalationCandidate(text)) return 0;
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  return messages
    .filter((item) => !item?.isOutgoing)
    .slice(-8)
    .filter((item) => String(item?.text || '').trim().toLowerCase() === text)
    .length;
}

function isRepeatedEscalationCandidate(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  if (value.length < 18) return false;
  if (GREETING_RE.test(value)) return false;
  return /[?？]|\b(sao|chưa|chua|lại|lai|vẫn|van|không trả lời|khong tra loi|hỏi lại|hoi lai)\b/i.test(value);
}

function isChiHomeDepartmentName(...values) {
  return values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean).some((value) => value.includes('chihome'));
}

export async function processWorkflow(sessionId, rootAgentId, userMessage) {
  const executionId = randomUUID();
  let stepNumber = 0;
  const trace = ({ nodeType, nodeName, inputData, outputData, modelUsed = null, durationMs = 0 }) => {
    stepNumber += 1;
    logExecutionStep({ executionId, stepNumber, nodeType, nodeName, inputData, outputData, modelUsed, durationMs });
  };
  trace({
    nodeType: 'start',
    nodeName: 'Workflow start',
    inputData: { sessionId, rootAgentId, userMessage },
    outputData: { executionId },
    durationMs: 0
  });
  const startedAt = Date.now();
  const result = await runIsolatedAgent({
    sessionId,
    agentId: rootAgentId || 'orchestrator',
    input: userMessage,
    executionId,
    trace
  });
  trace({
    nodeType: 'end',
    nodeName: 'Workflow end',
    inputData: { executionId },
    outputData: result,
    modelUsed: result?.modelId || null,
    durationMs: Date.now() - startedAt
  });
  return { executionId, text: result?.output || '', result };
}

export function getExecutionTrace(executionId) {
  const rows = readExecutionLogs(executionId);
  const nodes = rows.map((row) => ({
    id: String(row.step_number),
    label: row.node_name,
    type: row.node_type,
    stepNumber: row.step_number,
    inputData: row.input_data,
    outputData: row.output_data,
    modelUsed: row.model_used,
    durationMs: row.duration_ms
  }));
  const edges = [];
  for (let i = 1; i < nodes.length; i += 1) {
    edges.push({ id: `${nodes[i - 1].id}->${nodes[i].id}`, from: nodes[i - 1].id, to: nodes[i].id });
  }
  return { executionId: String(executionId || ''), nodes, edges };
}
