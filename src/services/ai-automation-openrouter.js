import fs from 'node:fs';
import path from 'node:path';
import { createChiHomeHotelClient } from './chihomehotel-client.js';
import { selectOpenRouterModel } from './agent-system-db.js';
import { buildHiddenCustomerContext } from './ai-automation-service.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export function buildDefaultAiAutomationUsage() {
  return {
    providerStatus: {
      provider: 'openrouter',
      ready: false,
      reason: 'missing_api_key',
      modelId: null,
      lastRequestAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null
    },
    totals: buildEmptyUsageBucket(),
    byDepartment: {},
    recentCalls: []
  };
}

export function buildEmptyUsageBucket() {
  return {
    requests: 0,
    successRequests: 0,
    failedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    lastRequestAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastModelId: null,
    lastError: null
  };
}

export function normalizeAiAutomationUsage(input = {}) {
  const next = buildDefaultAiAutomationUsage();
  next.providerStatus = {
    ...next.providerStatus,
    ...(input.providerStatus || {})
  };
  next.totals = normalizeUsageBucket(input.totals || {});
  next.byDepartment = Object.fromEntries(Object.entries(input.byDepartment || {}).map(([key, value]) => [key, normalizeUsageBucket(value || {})]));
  next.recentCalls = Array.isArray(input.recentCalls) ? input.recentCalls.slice(0, 20) : [];
  return next;
}

export function normalizeUsageBucket(input = {}) {
  const base = buildEmptyUsageBucket();
  return {
    ...base,
    ...input,
    requests: Number(input.requests || 0),
    successRequests: Number(input.successRequests || 0),
    failedRequests: Number(input.failedRequests || 0),
    promptTokens: Number(input.promptTokens || 0),
    completionTokens: Number(input.completionTokens || 0),
    totalTokens: Number(input.totalTokens || 0),
    costUsd: Number(input.costUsd || 0)
  };
}

export function pickModelForPlan(config = {}, plan = {}) {
  const items = Array.isArray(config.modelCatalog) ? config.modelCatalog : [];
  const targetTier = String(plan.modelTier || 'small');
  return items.find((item) => String(item?.tier || '') === targetTier)
    || items.find((item) => String(item?.tier || '') === 'medium')
    || items[0]
    || null;
}

export function routeModel(inputText = '') {
  const text = String(inputText || '');
  const complexKeywords = /code|lập trình|tính toán|logic|sơ đồ|phân tích|debug|sql|api|workflow|kiến trúc|architecture|calculate|diagram|reasoning/i;
  const capability = complexKeywords.test(text) || text.length > 700 ? 'complex' : 'basic';
  const selected = selectOpenRouterModel(capability) || selectOpenRouterModel('basic');
  return selected?.model_id || selected?.modelId || null;
}

export async function callOpenRouter(model, systemPrompt = '', history = [], userMessage = '') {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  const baseUrl = String(process.env.OPENROUTER_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const modelId = typeof model === 'string' ? model : (model?.model_id || model?.modelId || '');
  if (!apiKey) throw new Error('missing_openrouter_api_key');
  if (!modelId) throw new Error('missing_openrouter_model');
  const messages = [
    { role: 'system', content: String(systemPrompt || '').trim() || ' ' },
    ...(Array.isArray(history) ? history.map((item) => ({ role: normalizeOpenRouterRole(item?.role), content: String(item?.content || '').trim() || ' ' })) : []),
    { role: 'user', content: String(userMessage || '').trim() || ' ' }
  ];
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://tehui.io.vn',
      'X-Title': process.env.OPENROUTER_APP_TITLE || 'ChiHome AI Automation'
    },
    body: JSON.stringify({ model: modelId, messages, temperature: 0.3 })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `openrouter_http_${response.status}`);
  return {
    ok: true,
    modelId,
    text: String(payload?.choices?.[0]?.message?.content || '').trim(),
    raw: payload,
    usage: normalizeUsage(payload?.usage || {})
  };
}

function normalizeOpenRouterRole(role = '') {
  const normalized = String(role || '').toLowerCase();
  if (normalized === 'assistant' || normalized === 'system' || normalized === 'tool') return normalized;
  return 'user';
}

export async function generateOpenRouterReply({ config = {}, plan = {}, message = {}, thread = {}, portalBinding = null } = {}) {
  const toolContext = await runAgentToolPipeline({ config, plan, message, thread, portalBinding });
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  const baseUrl = String(process.env.OPENROUTER_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = pickModelForPlan(config, plan);

  if (!apiKey || !model?.modelId) {
    const offlineReply = toolContext?.directReply || buildDirectKnowledgeReply({ config, plan, message, toolContext });
    if (offlineReply) {
      return {
        ok: true,
        provider: toolContext?.provider || 'agent-tools-offline-fallback',
        modelId: toolContext?.modelId || 'agent-tools-offline-fallback',
        modelLabel: toolContext?.modelLabel || 'Agent Tool Pipeline Offline Fallback',
        text: offlineReply,
        attachmentsUrls: Array.isArray(toolContext?.attachmentsUrls) ? toolContext.attachmentsUrls : [],
        messageParts: Array.isArray(toolContext?.messageParts) ? toolContext.messageParts : [],
        liveContext: toolContext?.liveContext || null,
        pricingContext: toolContext?.pricingContext || null,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 }
      };
    }
    return buildFailureResult({ model, reason: !apiKey ? 'missing_api_key' : 'missing_model' });
  }

  const result = await runOpenRouterMultiAgentReply({ config, plan, message, thread, portalBinding, toolContext, apiKey, baseUrl });
  return {
    ...result,
    liveContext: result?.liveContext || toolContext?.liveContext || null,
    pricingContext: result?.pricingContext || toolContext?.pricingContext || null
  };
}

async function runOpenRouterMultiAgentReply({ config = {}, plan = {}, message = {}, thread = {}, portalBinding = null, toolContext = {}, apiKey = '', baseUrl = DEFAULT_BASE_URL } = {}) {
  const activeAgents = normalizeRuntimeAgents(plan);
  const specialistResults = [];
  let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
  let lastError = null;

  for (const agent of activeAgents.filter((item) => item.id !== 'orchestrator' && item.id !== 'composer')) {
    const result = await callOpenRouterAgentWithFallback({
      config,
      agent,
      plan,
      message,
      thread,
      portalBinding,
      toolContext,
      apiKey,
      baseUrl,
      stage: 'specialist'
    });
    specialistResults.push({
      agentId: agent.id,
      label: agent.label || agent.id,
      role: agent.role || null,
      ok: result.ok,
      modelId: result.modelId || null,
      text: result.text || '',
      reason: result.reason || null,
      details: result.details || null
    });
    totalUsage = addUsage(totalUsage, result.usage);
    if (!result.ok) lastError = result.details || result.reason || lastError;
  }

  const enrichedToolContext = mergeSpecialistResultsIntoToolContext(toolContext, specialistResults);
  if (toolContext?.directReply && (toolContext?.provider === 'knowledge-tools' || toolContext?.provider === 'grounding-guard' || toolContext?.directReplySource === 'script-knowledge' || toolContext?.directReplySource === 'no-confident-knowledge')) {
    return {
      ok: true,
      provider: toolContext?.provider || 'knowledge-tools',
      modelId: toolContext?.modelId || 'knowledge-tools',
      modelLabel: toolContext?.modelLabel || 'Knowledge Tool Pipeline',
      text: ensureFinalReplyGrounded(toolContext.directReply, toolContext),
      attachmentsUrls: Array.isArray(toolContext?.attachmentsUrls) ? toolContext.attachmentsUrls : [],
      messageParts: Array.isArray(toolContext?.messageParts) ? toolContext.messageParts : [],
      usage: totalUsage,
      agents: specialistResults
    };
  }
  if (toolContext?.directReply && (toolContext?.liveContext?.searched || toolContext?.liveContext?.missing?.length || toolContext?.liveContext?.status === 'error')) {
    return {
      ok: true,
      provider: toolContext?.provider || 'agent-tools-booking-flow',
      modelId: toolContext?.modelId || 'agent-tools-booking-flow',
      modelLabel: toolContext?.modelLabel || 'Agent Tools Booking Flow',
      text: ensureFinalReplyGrounded(toolContext.directReply, toolContext),
      attachmentsUrls: Array.isArray(toolContext?.attachmentsUrls) ? toolContext.attachmentsUrls : [],
      messageParts: Array.isArray(toolContext?.messageParts) ? toolContext.messageParts : [],
      usage: totalUsage,
      agents: specialistResults
    };
  }
  const finalAgent = activeAgents.find((item) => item.id === 'orchestrator') || activeAgents.find((item) => item.id === 'composer') || { id: 'orchestrator', label: 'Orchestrator chính', modelTier: plan.modelTier || 'medium' };
  const finalMessages = buildOpenRouterMessages({
    config,
    plan,
    message,
    thread,
    portalBinding,
    liveContext: toolContext?.liveContext || null,
    agentToolContext: enrichedToolContext
  });
  finalMessages[0].content = [
    finalMessages[0].content,
    'Bạn là agent chính/orchestrator. Bạn chỉ được gửi 1 câu trả lời cuối cùng cho khách sau khi đã đọc kết quả các specialist agents. Không nhắc đến tên agent, model, tool hoặc hệ thống nội bộ.'
  ].filter(Boolean).join('\n\n');
  finalMessages[1].content = [
    finalMessages[1].content,
    formatSpecialistModelOutputs(specialistResults) ? `Kết quả specialist AI agents:\n${formatSpecialistModelOutputs(specialistResults)}` : '',
    'Hãy tổng hợp, kiểm tra mâu thuẫn, ưu tiên dữ liệu live/tool/knowledge nội bộ, rồi trả lời khách.'
  ].filter(Boolean).join('\n\n');

  const finalResult = await callOpenRouterAgentWithFallback({
    config,
    agent: finalAgent,
    plan,
    message,
    thread,
    portalBinding,
    toolContext: enrichedToolContext,
    apiKey,
    baseUrl,
    stage: 'orchestrator',
    messagesOverride: finalMessages
  });
  totalUsage = addUsage(totalUsage, finalResult.usage);

  if (finalResult.ok && finalResult.text) {
    const finalText = ensureFinalReplyGrounded(finalResult.text, toolContext);
    return {
      ok: true,
      provider: 'openrouter-multi-agent',
      modelId: finalResult.modelId,
      modelLabel: finalResult.modelLabel,
      text: finalText,
      attachmentsUrls: Array.isArray(toolContext?.attachmentsUrls) ? toolContext.attachmentsUrls : [],
      messageParts: Array.isArray(toolContext?.messageParts) ? toolContext.messageParts : [],
      usage: totalUsage,
      agents: specialistResults
    };
  }

  const deterministicFallback = toolContext?.directReply || buildDirectKnowledgeReply({ config, plan, message, toolContext });
  if (deterministicFallback) {
    return {
      ok: true,
      provider: 'agent-tools-fallback-after-model-error',
      modelId: 'agent-tools-fallback',
      modelLabel: 'Agent Tools Fallback',
      text: deterministicFallback,
      attachmentsUrls: Array.isArray(toolContext?.attachmentsUrls) ? toolContext.attachmentsUrls : [],
      messageParts: Array.isArray(toolContext?.messageParts) ? toolContext.messageParts : [],
      usage: totalUsage,
      agents: specialistResults,
      fallbackReason: finalResult.details || finalResult.reason || lastError || 'final_model_failed'
    };
  }

  return buildFailureResult({ model: pickModelForPlan(config, plan), reason: finalResult.reason || 'multi_agent_failed', details: finalResult.details || lastError || 'Multi-agent OpenRouter run failed' });
}

async function callOpenRouterAgentWithFallback({ config = {}, agent = {}, plan = {}, message = {}, thread = {}, portalBinding = null, toolContext = {}, apiKey = '', baseUrl = DEFAULT_BASE_URL, stage = 'agent', messagesOverride = null } = {}) {
  const candidates = pickModelFallbackChain(config, agent, plan);
  let lastFailure = null;
  for (const model of candidates) {
    if (!model?.modelId) continue;
    const body = {
      model: model.modelId,
      temperature: stage === 'orchestrator' ? 0.3 : 0.15,
      messages: messagesOverride || buildAgentMessages({ config, agent, plan, message, thread, portalBinding, toolContext, stage })
    };
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastFailure = buildFailureResult({ model, reason: `http_${response.status}`, details: payload?.error?.message || payload?.message || response.statusText || 'OpenRouter request failed' });
        continue;
      }
      const text = extractTextFromOpenRouterPayload(payload);
      if (!text) {
        lastFailure = buildFailureResult({ model, reason: 'empty_response', details: 'OpenRouter returned empty content' });
        continue;
      }
      const usage = normalizeUsage(payload?.usage || {});
      return {
        ok: true,
        provider: 'openrouter',
        modelId: model.modelId,
        modelLabel: model.label || model.modelId,
        text,
        usage: { ...usage, costUsd: estimateCostUsd(model, usage) }
      };
    } catch (error) {
      lastFailure = buildFailureResult({ model, reason: 'network_error', details: error?.message || 'OpenRouter network error' });
    }
  }
  return lastFailure || buildFailureResult({ model: null, reason: 'missing_model', details: `No model candidate for ${agent.id || stage}` });
}

function normalizeRuntimeAgents(plan = {}) {
  const agents = Array.isArray(plan?.specialistAgents) ? plan.specialistAgents : [];
  const byId = new Map();
  for (const item of agents) {
    const id = String(item?.id || '').trim();
    if (id) byId.set(id, item);
  }
  if (!byId.has('orchestrator')) byId.set('orchestrator', { id: 'orchestrator', label: 'Orchestrator chính', role: 'planner', modelTier: plan.modelTier || 'medium' });
  if (!byId.has('composer')) byId.set('composer', { id: 'composer', label: 'Reply composer', role: 'writer', modelTier: plan.modelTier || 'medium' });
  return [...byId.values()];
}

function pickModelFallbackChain(config = {}, agent = {}, plan = {}) {
  const catalog = Array.isArray(config.modelCatalog) ? config.modelCatalog : [];
  const tiers = [...new Set([
    String(agent.modelTier || '').trim(),
    String(plan.modelTier || '').trim(),
    String(config.modelRouter?.fallback || '').trim(),
    'medium',
    'small',
    'large'
  ].filter(Boolean))];
  const preferredModelId = String(agent.modelId || '').trim();
  const candidates = [];
  if (preferredModelId) {
    candidates.push(catalog.find((item) => item?.modelId === preferredModelId || item?.id === preferredModelId) || { id: preferredModelId, modelId: preferredModelId, label: preferredModelId, tier: agent.modelTier || plan.modelTier || 'medium' });
  }
  for (const tier of tiers) {
    candidates.push(...catalog.filter((item) => String(item?.tier || '') === tier));
  }
  candidates.push(...catalog);
  const seen = new Set();
  return candidates.filter((item) => {
    const key = String(item?.modelId || item?.id || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

function getAgentOperatingGuide(agentId = '') {
  const id = String(agentId || '').trim();
  if (id === 'orchestrator') {
    return [
      'Bạn là agent chính của ChiHome: tư vấn tinh tế, ngắn gọn, không nói mình là AI và không nhắc hệ thống/tool/model.',
      'Booking/tìm phòng: phân việc cho booking_agent để lấy đúng 3 dữ kiện; khi đủ thì dùng kết quả hotel_live_data và room_detail_agent để trả lời khách.',
      'Ngày tương đối của khách phải được hiểu theo ngày hệ thống tại Việt Nam: hôm kia=-2 ngày, hôm qua=-1 ngày, hôm nay=ngày hiện tại, ngày mai/mai=+1 ngày, mốt/ngày kia=+2 ngày. Không đưa nguyên chữ “hôm nay/ngày mai/mốt” vào API; phải chuyển thành ngày YYYY-MM-DD/checkindate/check-outdate trước.',
      'Khi có kết quả phòng live, format bắt buộc: “Dạ em tìm được [N] căn phù hợp với thông tin mình đưa…” + nhắc lại ngày nhận/trả, số đêm, số khách/số PN nếu có; sau đó gửi từng căn theo mẫu “+ Căn X: [Tòa + mã căn]”, số PN, số WC, giá 1 đêm, tổng tiền theo số đêm, rồi hình ảnh của đúng căn đó. Không trả lời cụt chỉ bằng số lượng căn.',
      'Không hỏi view/toà/ngân sách trước khi có đủ check-in, check-out và số phòng ngủ/số khách. Nếu thiếu dữ kiện, chỉ hỏi đúng dữ kiện còn thiếu.'
    ].join('\n');
  }
  if (id === 'booking_agent') {
    return [
      'Bạn là booking requirements agent. Nhiệm vụ duy nhất: thu đúng 3 dữ kiện để tìm phòng live.',
      'Dữ kiện bắt buộc: checkindate dạng YYYY-MM-DDT14:00, checkoutdate dạng YYYY-MM-DDT12:00, sophongngu.',
      'Bắt buộc tự chuyển ngày tự nhiên sang ngày thật theo timezone Việt Nam trước khi query: hôm kia=-2, hôm qua=-1, hôm nay=0, ngày mai/mai=+1, mốt/ngày kia=+2. Ví dụ “hôm nay out mai” = check-in hôm nay, check-out ngày mai.',
      'Nếu khách chỉ nói số khách: 1-2 khách -> 1PN; 3-4 -> 2PN; 5-6 -> 3PN; 7-8 -> 4PN; nhiều hơn thì làm tròn lên theo 2 khách/PN.',
      'Năm mặc định theo hệ thống hiện tại nếu khách không nói năm. Không hỏi view/toà/giá/ngân sách trừ khi khách tự nêu.',
      'Khi thiếu thông tin, chỉ nêu đúng thông tin còn thiếu. Khi đủ, báo đã đủ điều kiện để hotel_live_data query live.'
    ].join('\n');
  }
  if (id === 'hotel_live_data') {
    return [
      'Bạn là live availability agent. Chỉ dùng dữ liệu từ tool nội bộ search_availability_live / lookup_room_catalog_live đã được runtime cung cấp.',
      'Không chào hỏi, không tư vấn lan man, không tự bịa giá/diện tích/ảnh. Nếu thiếu check-in/check-out/sophongngu thì nói rõ thiếu gì.',
      'Nếu có kết quả live, giữ nguyên danh sách căn và facts để room_detail_agent/composer dùng.'
    ].join('\n');
  }
  if (id === 'room_detail_agent') {
    return [
      'Bạn là room detail data processor. Không phải nhân viên tư vấn: không chào hỏi, không cảm thán, không mở/kết bài.',
      'Nhận danh sách căn từ live data và format từng căn đúng mẫu: + Căn [số]: [Tên toà] [Mã căn]; - Số phòng ngủ; - Số WC; - Giá 1 đêm; - Tổng tiền theo số đêm khách ở; - Hình ảnh căn: toàn bộ URL/ảnh của riêng căn đó nếu có.',
      'Liệt kê đầy đủ các căn có trong input. Nếu thiếu trường nào ghi “Thông tin đang cập nhật”. Không tự bịa. Không được rút gọn thành một câu summary.'
    ].join('\n');
  }
  return '';
}

function buildAgentMessages({ config = {}, agent = {}, plan = {}, message = {}, thread = {}, portalBinding = null, toolContext = {}, stage = 'agent' } = {}) {
  const recentMessages = getThreadMessagesAfterMemoryClear(thread)
    .slice(-8)
    .map((item) => `${item?.isOutgoing ? 'Nhân viên/AI' : 'Khách'}: ${String(item?.text || '').trim()}`)
    .filter(Boolean)
    .join('\n');
  const agentToolText = formatAgentToolContext(filterToolContextForAgent(toolContext, agent.id));
  const hiddenCustomerContextText = formatHiddenCustomerContext(plan?.executionSignals?.hiddenCustomerContext || buildHiddenCustomerContext(thread));
  const knowledgeContext = buildKnowledgeContext({ config, plan, message });
  const memoryText = formatAgentMemories(thread?.automation?.agentMemories, [agent]);
  const system = [
    `Bạn là AI agent chuyên nhiệm: ${agent.label || agent.id || stage}.`,
    agent.role ? `Vai trò: ${agent.role}.` : '',
    Array.isArray(agent.responsibilities) && agent.responsibilities.length ? `Nhiệm vụ: ${agent.responsibilities.join('; ')}.` : '',
    Array.isArray(agent.tools) && agent.tools.length ? `Tools/gợi ý dùng agent: ${agent.tools.join('; ')}.` : '',
    getAgentOperatingGuide(agent.id),
    'Chỉ trả về kết quả phục vụ agent chính, ngắn gọn, có căn cứ. Nếu thiếu dữ liệu thì nói rõ thiếu gì. Không bịa thông tin.'
  ].filter(Boolean).join('\n');
  const user = [
    `Bộ phận: ${portalBinding?.departmentId || 'chưa rõ'}`,
    `Intent: ${plan?.executionSignals?.intent || 'general'}`,
    `Tin khách mới nhất: ${String(message?.text || '').trim()}`,
    recentMessages ? `Ngữ cảnh gần đây:\n${recentMessages}` : '',
    hiddenCustomerContextText ? `Customer context ẩn từ tag/booking CRM — chỉ dùng nội bộ, không được tiết lộ cho khách:\n${hiddenCustomerContextText}` : '',
    memoryText ? `Memory riêng của agent:\n${memoryText}` : '',
    agentToolText ? `Tool/data dành cho agent:\n${agentToolText}` : '',
    knowledgeContext ? `Tài liệu nội bộ liên quan:\n${knowledgeContext}` : '',
    'Hãy trả về: facts chính, rủi ro/mâu thuẫn nếu có, đề xuất cho agent chính.'
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function filterToolContextForAgent(toolContext = {}, agentId = '') {
  if (!toolContext || typeof toolContext !== 'object') return toolContext;
  const outputs = toolContext.agentOutputs || {};
  const filtered = { ...toolContext, agentOutputs: {} };
  const wanted = new Set([String(agentId || '').trim(), 'orchestrator']);
  for (const [key, value] of Object.entries(outputs)) {
    if (wanted.has(key) || String(agentId) === 'composer') filtered.agentOutputs[key] = value;
  }
  return filtered;
}

function mergeSpecialistResultsIntoToolContext(toolContext = {}, specialistResults = []) {
  const agentOutputs = { ...(toolContext?.agentOutputs || {}) };
  for (const result of specialistResults) {
    agentOutputs[`model_${result.agentId}`] = {
      summary: result.ok ? `Specialist model ${result.agentId} hoàn tất` : `Specialist model ${result.agentId} lỗi`,
      parameters: { modelId: result.modelId || null, ok: result.ok },
      resultText: result.text || result.details || result.reason || ''
    };
  }
  return { ...(toolContext || {}), agentOutputs };
}

function formatSpecialistModelOutputs(results = []) {
  return (Array.isArray(results) ? results : [])
    .map((item) => `## ${item.label || item.agentId}\n- Model: ${item.modelId || 'n/a'}\n- Trạng thái: ${item.ok ? 'ok' : 'error'}\n- Kết quả: ${item.text || item.details || item.reason || ''}`)
    .join('\n\n');
}

function addUsage(a = {}, b = {}) {
  return {
    promptTokens: Number(a.promptTokens || 0) + Number(b?.promptTokens || 0),
    completionTokens: Number(a.completionTokens || 0) + Number(b?.completionTokens || 0),
    totalTokens: Number(a.totalTokens || 0) + Number(b?.totalTokens || 0),
    costUsd: Number((Number(a.costUsd || 0) + Number(b?.costUsd || 0)).toFixed(8))
  };
}

function ensureFinalReplyGrounded(text = '', toolContext = {}) {
  let reply = String(text || '').trim();
  reply = stripUnaskedTransportAdvice(reply, toolContext);
  const liveContext = toolContext?.liveContext || null;
  const urls = Array.isArray(toolContext?.attachmentsUrls) ? toolContext.attachmentsUrls.filter(Boolean).slice(0, 3) : [];
  if (toolContext?.pricingContext?.negotiation && !/xin hỗ trợ khoảng|có thể giảm khoảng|mức tốt hơn/i.test(reply)) {
    reply = `${reply}\n\nNếu anh/chị muốn, em có thể xin hỗ trợ khoảng/mức tốt hơn cho căn phù hợp nhất ạ.`;
  }
  if (urls.length && !/Link ảnh chọn lọc:/i.test(reply)) {
    const imageLines = urls.map((url, index) => `- Ảnh ${index + 1}: ${url}`).join('\n');
    reply = `${reply}\n\nLink ảnh chọn lọc:\n${imageLines}`;
  }
  if (!liveContext || !Array.isArray(liveContext.rooms) || !liveContext.rooms.length) return reply;
  if (/căn|phòng trống|phong trong|ChiHomeHotel|The Opera|The Galleria|The Crest|Lancaster|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/i.test(reply)) return reply;
  return `${reply}\n\nEm sẽ lọc tiếp các căn phù hợp nhất theo đúng ngày anh/chị cần nếu mình muốn chốt phương án ạ.`;
}

function stripUnaskedTransportAdvice(text = '', toolContext = {}) {
  const reply = String(text || '').trim();
  if (!reply) return reply;
  const query = normalizeSearchText(toolContext?.messageText || toolContext?.conversationText || '');
  const customerAskedTransport = /\b(grab|green\s*sm|xanh\s*sm|taxi|san bay|airport|dua don|don san bay|xe|di chuyen)\b/i.test(query);
  if (customerAskedTransport) return reply;
  const paragraphs = reply.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const kept = paragraphs.filter((part) => !/\b(Grab|Green\s*SM|Xanh\s*SM|taxi|sân bay|airport|đưa đón|di chuyển)\b/i.test(part));
  return (kept.length ? kept : paragraphs).join('\n\n');
}


export function recordAiAutomationUsage(draft, { departmentId = null, result = null, requestAt = new Date().toISOString() } = {}) {
  draft.aiAutomationUsage = normalizeAiAutomationUsage(draft.aiAutomationUsage || {});
  const usageState = draft.aiAutomationUsage;
  const bucketKey = String(departmentId || '').trim() || 'global';
  if (!usageState.byDepartment[bucketKey]) usageState.byDepartment[bucketKey] = buildEmptyUsageBucket();
  const buckets = [usageState.totals, usageState.byDepartment[bucketKey]];
  for (const bucket of buckets) {
    bucket.requests += 1;
    bucket.lastRequestAt = requestAt;
    bucket.lastModelId = result?.modelId || bucket.lastModelId || null;
  }

  usageState.providerStatus = {
    provider: result?.provider || 'openrouter',
    ready: Boolean(result?.ok),
    reason: result?.ok ? 'ok' : (result?.reason || 'unknown_error'),
    modelId: result?.modelId || null,
    lastRequestAt: requestAt,
    lastSuccessAt: result?.ok ? requestAt : usageState.providerStatus?.lastSuccessAt || null,
    lastErrorAt: result?.ok ? usageState.providerStatus?.lastErrorAt || null : requestAt,
    lastError: result?.ok ? null : (result?.details || result?.reason || 'unknown_error')
  };

  for (const bucket of buckets) {
    if (result?.ok) {
      bucket.successRequests += 1;
      bucket.promptTokens += Number(result.usage?.promptTokens || 0);
      bucket.completionTokens += Number(result.usage?.completionTokens || 0);
      bucket.totalTokens += Number(result.usage?.totalTokens || 0);
      bucket.costUsd += Number(result.usage?.costUsd || 0);
      bucket.lastSuccessAt = requestAt;
      bucket.lastError = null;
    } else {
      bucket.failedRequests += 1;
      bucket.lastErrorAt = requestAt;
      bucket.lastError = result?.details || result?.reason || 'unknown_error';
    }
  }

  usageState.recentCalls.unshift({
    at: requestAt,
    departmentId: bucketKey,
    ok: Boolean(result?.ok),
    provider: result?.provider || 'openrouter',
    modelId: result?.modelId || null,
    promptTokens: Number(result?.usage?.promptTokens || 0),
    completionTokens: Number(result?.usage?.completionTokens || 0),
    totalTokens: Number(result?.usage?.totalTokens || 0),
    costUsd: Number(result?.usage?.costUsd || 0),
    error: result?.ok ? null : (result?.details || result?.reason || 'unknown_error')
  });
  usageState.recentCalls = usageState.recentCalls.slice(0, 20);
}

function buildFailureResult({ model = null, reason = 'unknown_error', details = null } = {}) {
  return {
    ok: false,
    provider: 'openrouter',
    modelId: model?.modelId || null,
    modelLabel: model?.label || model?.modelId || null,
    reason,
    details,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 }
  };
}

function normalizeUsage(usage = {}) {
  const promptTokens = Number(usage.prompt_tokens || usage.promptTokens || 0);
  const completionTokens = Number(usage.completion_tokens || usage.completionTokens || 0);
  const totalTokens = Number(usage.total_tokens || usage.totalTokens || (promptTokens + completionTokens));
  return { promptTokens, completionTokens, totalTokens };
}

function estimateCostUsd(model = {}, usage = {}) {
  const prompt = Number(model.promptPricePer1M || 0) * (Number(usage.promptTokens || 0) / 1_000_000);
  const completion = Number(model.completionPricePer1M || 0) * (Number(usage.completionTokens || 0) / 1_000_000);
  return Number((prompt + completion).toFixed(8));
}

function buildOpenRouterMessages({ config = {}, plan = {}, message = {}, thread = {}, portalBinding = null, liveContext = null, agentToolContext = null } = {}) {
  const recentMessages = getThreadMessagesAfterMemoryClear(thread)
    .slice(-8)
    .map((item) => `${item?.isOutgoing ? 'Agent' : 'Khách'}: ${String(item?.text || '').trim()}`)
    .filter(Boolean)
    .join('\n');
  const specialistGuide = buildSpecialistGuide({ config, plan });
  const promptHints = buildPromptHints({ config, plan, message });
  const knowledgeContext = buildKnowledgeContext({ config, plan, message });
  const directDraft = buildDirectDraftReply({ config, plan, message });
  const liveContextText = formatLiveContext(liveContext);
  const hiddenCustomerContextText = formatHiddenCustomerContext(plan?.executionSignals?.hiddenCustomerContext || buildHiddenCustomerContext(thread));
  const conversationMemoryText = formatConversationMemory(thread?.automation?.conversationMemory);
  const agentMemoryText = formatAgentMemories(thread?.automation?.agentMemories, plan?.specialistAgents);
  const toolContextText = formatAgentToolContext(agentToolContext);
  const system = [
    String(config.systemPrompt || '').trim(),
    String(config.replyStylePrompt || '').trim(),
    specialistGuide,
    getAgentOperatingGuide('orchestrator'),
    'Luật booking bắt buộc: nếu khách đã có check-in + check-out + số khách hoặc số phòng ngủ/số giường/loại căn, phải kiểm tra live và gửi phương án phòng ngay; không trả lời kiểu “đang tìm/đang kiểm tra rồi báo lại”. Không tự nhắc Grab, Green SM/Xanh SM, taxi, sân bay, đưa đón hoặc di chuyển nếu khách không hỏi trực tiếp.',
    'Luật ngày tháng bắt buộc: mọi cụm “hôm kia/hôm qua/hôm nay/ngày mai/mai/mốt/ngày kia” phải được chuyển sang ngày thật theo timezone Việt Nam trước khi gọi API tìm phòng nhanh. Nếu chỉ có một ngày mà thiếu checkout/số đêm thì hỏi lại checkout/số đêm.',
    'Luật format kết quả phòng bắt buộc: khi tìm thấy phòng, không trả lời cụt. Phải nhắc lại thông tin khách đưa, tổng số căn phù hợp, ngày nhận/trả, số đêm, số khách/số PN nếu có; sau đó gửi lần lượt từng căn gồm tòa + mã căn, số PN, số WC, giá/đêm, tổng tiền theo số đêm và toàn bộ hình của căn đó.',
    'Luôn trả lời bằng tiếng Việt tự nhiên, ngắn gọn, rõ ràng. Không bịa thông tin. Nếu thiếu dữ liệu, hỏi lại đúng chỗ thiếu. Không nhắc tới model hay hệ thống nội bộ. Nếu knowledge nội bộ và dữ liệu live mâu thuẫn, ưu tiên dữ liệu live mới nhất. Nếu knowledge nội bộ có địa chỉ, mức giá, hotline, script, phí, policy hoặc caveat cụ thể thì phải bám đúng các fact đó, không tự suy diễn từ kiến thức ngoài.',
    'Grounding bắt buộc: với câu hỏi về chính sách, phí, nội quy, hướng dẫn vận hành, check-in/check-out, thẻ, wifi, gửi xe, hồ bơi/gym, thanh toán/cọc/huỷ, chỉ được trả fact có trong tool/data/knowledge. Nếu tool báo NO_CONFIDENT_KNOWLEDGE_SOURCE hoặc không có nguồn đủ chắc thì không được tự trả lời theo kiến thức chung; hãy nói sẽ kiểm tra lại thông tin chính xác.',
    'Customer context ẩn từ tag/booking CRM chỉ là bối cảnh phụ để hiểu tình huống tinh tế hơn. Vẫn nhắn với khách như CSKH bình thường, vẫn tư vấn/chọn phòng/báo giá bình thường khi khách hỏi; không cư xử khác, không tỏ ra biết thông tin nội bộ. Tuyệt đối không nói với khách rằng hệ thống thấy tag/trạng thái/lịch sử booking, không tự nhắc “anh/chị đã từng đặt” nếu khách không hỏi hoặc không cần thiết.'
  ].filter(Boolean).join('\n\n');
  const user = [
    `Bộ phận: ${portalBinding?.departmentId || 'chưa rõ'}`,
    `Intent: ${plan?.executionSignals?.intent || 'general'}`,
    `Độ phức tạp: ${plan?.executionSignals?.complexity || 'simple'}`,
    liveContextText ? `Dữ liệu live từ ChiHomeHotel API:\n${liveContextText}` : '',
    hiddenCustomerContextText ? `Customer context ẩn từ tag/booking CRM — chỉ dùng nội bộ, không tiết lộ cho khách:\n${hiddenCustomerContextText}` : '',
    promptHints ? `Hướng dẫn tác vụ liên quan:\n${promptHints}` : '',
    knowledgeContext ? `BẮT BUỘC ưu tiên các fact nội bộ sau nếu chúng liên quan trực tiếp câu hỏi:\n${knowledgeContext}` : '',
    directDraft ? `Bản nháp factual cần bám sát, chỉ được tinh chỉnh câu chữ chứ không đổi fact:\n${directDraft}` : '',
    conversationMemoryText ? `Bộ nhớ hội thoại đã lưu:\n${conversationMemoryText}` : '',
    agentMemoryText ? `Bộ nhớ theo agent đang áp dụng:\n${agentMemoryText}` : '',
    toolContextText ? `Kết quả tool theo agent:\n${toolContextText}` : '',
    recentMessages ? `Ngữ cảnh gần đây:\n${recentMessages}` : '',
    `Tin nhắn khách mới nhất: ${String(message?.text || '').trim()}`,
    'Hãy soạn đúng 1 câu trả lời cuối cùng để gửi cho khách.'
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function formatHiddenCustomerContext(context = null) {
  if (!context || typeof context !== 'object' || (!context.hasTags && !context.hasBookingHistory)) return '';
  const lines = [
    Array.isArray(context.tags) && context.tags.length ? `- Tags hiện có: ${context.tags.join(', ')}` : '',
    context.bookingState && context.bookingState !== 'unknown' ? `- Trạng thái booking suy ra: ${context.bookingState}` : '',
    context.hasBookingHistory ? '- Có tín hiệu khách đã/đang liên quan booking.' : '',
    context.activeBooking ? '- Có tín hiệu booking đang active/đã xác nhận hoặc khách đang ở.' : '',
    Array.isArray(context.signals) && context.signals.length ? `- Tín hiệu: ${context.signals.join(', ')}` : '',
    '- Chỉ dùng làm bối cảnh phụ để tinh tế hơn; vẫn nhắn và tư vấn bình thường, không tiết lộ tag/trạng thái/lịch sử nội bộ cho khách.'
  ].filter(Boolean);
  return lines.join('\n');
}

function formatConversationMemory(memory = null) {
  if (!memory || typeof memory !== 'object') return '';
  const lines = [
    memory.summary ? `- Tóm tắt: ${memory.summary}` : '',
    memory.lastIntent ? `- Intent gần nhất: ${memory.lastIntent}` : '',
    memory.lastCustomerMessage ? `- Tin khách gần nhất đã lưu: ${memory.lastCustomerMessage}` : '',
    memory.lastReply ? `- Trả lời gần nhất đã lưu: ${memory.lastReply}` : ''
  ].filter(Boolean);
  return lines.join('\n');
}

function formatAgentMemories(memories = {}, activeAgents = []) {
  const activeIds = new Set((Array.isArray(activeAgents) ? activeAgents : []).map((item) => String(item?.id || '').trim()).filter(Boolean));
  const items = Object.entries(memories || {})
    .filter(([agentId]) => !activeIds.size || activeIds.has(String(agentId || '').trim()))
    .map(([agentId, memory]) => {
      if (!memory || typeof memory !== 'object') return null;
      const summary = String(memory.summary || '').trim();
      const details = [
        memory.lastIntent ? `intent=${memory.lastIntent}` : '',
        memory.lastCustomerMessage ? `khách="${memory.lastCustomerMessage}"` : '',
        memory.lastReply ? `reply="${memory.lastReply}"` : ''
      ].filter(Boolean).join(' | ');
      const body = [summary, details].filter(Boolean).join(' — ');
      return body ? `- ${agentId}: ${body}` : null;
    })
    .filter(Boolean);
  return items.join('\n');
}

function formatAgentToolContext(toolContext = null) {
  if (!toolContext || typeof toolContext !== 'object') return '';
  const outputs = Object.entries(toolContext.agentOutputs || {})
    .map(([agentId, payload]) => {
      if (!payload || typeof payload !== 'object') return null;
      const lines = [
        payload.summary ? `- Tóm tắt: ${payload.summary}` : '',
        payload.parameters ? `- Tham số: ${JSON.stringify(payload.parameters, null, 0)}` : '',
        payload.resultText ? `- Kết quả: ${payload.resultText}` : ''
      ].filter(Boolean);
      if (!lines.length) return null;
      return `## ${agentId}\n${lines.join('\n')}`;
    })
    .filter(Boolean);
  return outputs.join('\n\n');
}

function buildSpecialistGuide({ config = {}, plan = {} } = {}) {
  const registry = new Map((Array.isArray(config.agentRegistry) ? config.agentRegistry : []).map((item) => [String(item?.id || ''), item]));
  const active = (Array.isArray(plan?.specialistAgents) ? plan.specialistAgents : [])
    .map((item) => registry.get(String(item?.id || '')) || item)
    .filter(Boolean)
    .map((item) => {
      const label = item.label || item.id || 'agent';
      const instruction = item.instruction || item.prompt || '';
      const responsibilities = Array.isArray(item.responsibilities) ? item.responsibilities.join(', ') : '';
      const tools = Array.isArray(item.tools) && item.tools.length ? ` Tools: ${item.tools.join('; ')}` : '';
      return `- ${label}: ${instruction || responsibilities}${tools}`.trim();
    })
    .filter(Boolean);
  if (!active.length) return '';
  return `Agent playbook đang áp dụng:\n${active.join('\n')}`;
}

function buildPromptHints({ config = {}, plan = {}, message = {} } = {}) {
  const items = Array.isArray(config.promptLibrary) ? config.promptLibrary : [];
  if (!items.length) return '';
  const haystack = `${String(message?.text || '').toLowerCase()} ${String(plan?.executionSignals?.intent || '').toLowerCase()}`;
  const scored = items.map((item) => ({ item, score: scorePromptItem(item, haystack) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((entry) => `- ${entry.item.label || entry.item.id}: ${entry.item.prompt || ''}`.trim())
    .filter(Boolean);
  return scored.join('\n');
}

function scorePromptItem(item = {}, haystack = '') {
  const text = `${String(item.id || '')} ${String(item.label || '')} ${String(item.prompt || '')}`.toLowerCase();
  let score = 0;
  for (const token of tokenizeForMatch(haystack)) {
    if (token.length < 2) continue;
    if (text.includes(token)) score += token.length > 4 ? 3 : 1;
  }
  return score;
}

function buildKnowledgeContext({ config = {}, plan = {}, message = {} } = {}) {
  const docs = Array.isArray(config.knowledgeDocuments) ? config.knowledgeDocuments : [];
  if (!docs.length) return '';
  const query = `${String(message?.text || '')}\n${String(plan?.executionSignals?.intent || '')}`;
  const structuredHints = buildStructuredKnowledgeHints(docs, query);
  const retrieved = retrieveRelevantKnowledgeChunks({ docs, query, maxChunks: 6, maxPerDoc: 2 });
  const formatted = formatRetrievedKnowledgeChunks(retrieved);
  const all = [...structuredHints, formatted].filter(Boolean);
  if (!all.length) return '';
  return all.join('\n\n');
}

function buildDirectKnowledgeReply() {
  return '';
}

function buildDirectDraftReply({ config = {}, plan = {}, message = {} } = {}) {
  return buildDirectKnowledgeReply({ config, plan, message });
}

async function runAgentToolPipeline({ config = {}, plan = {}, message = {}, thread = {}, portalBinding = null } = {}) {
  const intent = String(plan?.executionSignals?.intent || 'general').trim().toLowerCase();
  const activeAgents = new Set((Array.isArray(plan?.specialistAgents) ? plan.specialistAgents : []).map((item) => String(item?.id || '').trim()).filter(Boolean));
  const conversationText = buildConversationSearchText({ message, thread });
  const agentOutputs = {};
  const hiddenCustomerContext = plan?.executionSignals?.hiddenCustomerContext || buildHiddenCustomerContext(thread);

  agentOutputs.orchestrator = {
    summary: `Intent=${intent || 'general'} | complexity=${String(plan?.executionSignals?.complexity || 'simple')}`,
    parameters: {
      departmentId: portalBinding?.departmentId || null,
      knowledgeSources: (Array.isArray(plan?.knowledgeSources) ? plan.knowledgeSources : []).map((item) => item?.id).filter(Boolean),
      delegatedAgents: [...activeAgents].filter((id) => id !== 'orchestrator'),
      hiddenCustomerContext
    },
    resultText: hiddenCustomerContext?.hasBookingHistory
      ? 'Đã phân việc theo intent, nguồn dữ liệu phù hợp và customer context ẩn; không tiết lộ trạng thái/tag nội bộ cho khách.'
      : 'Đã phân việc theo intent và nguồn dữ liệu phù hợp.'
  };

  const rememberedAvailability = buildRememberedAvailabilityContext({ message, thread });
  const liveContext = rememberedAvailability || (activeAgents.has('hotel_live_data')
    ? await buildLiveHotelContext({ config, plan, message, thread, portalBinding, conversationText })
    : null);
  if (liveContext) {
    agentOutputs.hotel_live_data = {
      summary: summarizeHotelLiveContext(liveContext),
      parameters: liveContext.search || null,
      resultText: formatLiveContext(liveContext) || liveContext.reason || ''
    };
    if (activeAgents.has('room_detail_agent') && Array.isArray(liveContext.rooms)) {
      agentOutputs.room_detail_agent = {
        summary: `Đã chuẩn hoá chi tiết ${liveContext.rooms.length} căn từ live data.`,
        parameters: liveContext.search || null,
        resultText: formatRoomDetailList(liveContext.rooms)
      };
    }
  }

  const pricingContext = activeAgents.has('retrieval')
    ? buildPricingToolContext({ config, message, conversationText, liveContext })
    : null;
  if (pricingContext) {
    agentOutputs.retrieval = {
      summary: pricingContext.summary,
      parameters: pricingContext.parameters || null,
      resultText: pricingContext.resultText || ''
    };
  }

  const scriptAgentIds = ['house_rules_agent', 'guest_stay_agent', 'company_ops_agent', 'special_cases_agent', 'retrieval', 'policy_guard'];
  const shouldProbeKnowledge = shouldProbeInternalKnowledge({ config, message, conversationText, intent, route: plan?.executionSignals?.aiRoute || null });
  const scriptContext = (scriptAgentIds.some((id) => activeAgents.has(id)) || shouldProbeKnowledge)
    ? buildScriptToolContext({ config, message, conversationText, intent })
    : null;
  if (!scriptContext && shouldProbeKnowledge) {
    agentOutputs.retrieval = {
      ...(agentOutputs.retrieval || {}),
      summary: [agentOutputs.retrieval?.summary, 'Đã được router yêu cầu tra knowledge nhưng chưa tìm thấy nguồn đủ chắc.'].filter(Boolean).join(' | '),
      parameters: agentOutputs.retrieval?.parameters || { intent, needsKnowledge: true },
      resultText: [agentOutputs.retrieval?.resultText, 'NO_CONFIDENT_KNOWLEDGE_SOURCE: không được tự chế fact/policy/fee; cần hỏi lại hoặc chuyển người phụ trách nếu câu hỏi cần thông tin chắc chắn.'].filter(Boolean).join('\n')
    };
  }
  if (scriptContext) {
    const targetId = ['house_rules_agent', 'guest_stay_agent', 'company_ops_agent', 'special_cases_agent', 'policy_guard', 'retrieval'].find((id) => activeAgents.has(id)) || 'retrieval';
    agentOutputs[targetId] = {
      ...(agentOutputs[targetId] || {}),
      summary: [agentOutputs[targetId]?.summary, scriptContext.summary].filter(Boolean).join(' | '),
      parameters: agentOutputs[targetId]?.parameters || scriptContext.parameters || null,
      resultText: [agentOutputs[targetId]?.resultText, scriptContext.resultText].filter(Boolean).join('\n')
    };
  }

  const directReply = buildAgentToolDirectReply({ intent, message, conversationText, liveContext, pricingContext, scriptContext, needsKnowledge: shouldProbeKnowledge });
  if (directReply) {
    agentOutputs.composer = {
      summary: 'Composer xuất câu trả lời factual từ kết quả tool.',
      parameters: { source: directReply.source || 'agent-tools' },
      resultText: directReply.text
    };
  }

  return {
    provider: directReply?.provider || null,
    modelId: directReply?.modelId || null,
    modelLabel: directReply?.modelLabel || null,
    directReply: directReply?.text || null,
    directReplySource: directReply?.source || null,
    attachmentsUrls: Array.isArray(directReply?.attachmentsUrls) ? directReply.attachmentsUrls : [],
    messageParts: Array.isArray(directReply?.messageParts) ? directReply.messageParts : [],
    liveContext,
    pricingContext,
    scriptContext,
    hiddenCustomerContext,
    messageText: String(message?.text || ''),
    conversationText,
    agentOutputs
  };
}

function buildRememberedAvailabilityContext({ message = {}, thread = {} } = {}) {
  if (!isAskMoreRoomsMessage(message?.text || '')) return null;
  const last = thread?.automation?.conversationMemory?.lastAvailability;
  if (!last || typeof last !== 'object' || !Array.isArray(last.rooms) || !last.rooms.length) return null;
  const sent = new Set((Array.isArray(last.sentRoomCodes) ? last.sentRoomCodes : []).map(normalizeCode).filter(Boolean));
  if (Array.isArray(last.lastShownRoomCodes)) {
    for (const code of last.lastShownRoomCodes) if (normalizeCode(code)) sent.add(normalizeCode(code));
  }
  return {
    ...(last.liveContext || {}),
    status: 'ok',
    searched: true,
    fromAvailabilityMemory: true,
    rooms: sortRoomsForCustomer(last.rooms),
    dates: last.dates || last.liveContext?.dates || null,
    search: last.search || last.liveContext?.search || {},
    sentRoomCodes: [...sent],
    allRoomCodes: Array.isArray(last.allRoomCodes) ? last.allRoomCodes : last.rooms.map(normalizeRoomCode).filter(Boolean)
  };
}

function buildAgentToolDirectReply({ intent = 'general', message = {}, conversationText = '', liveContext = null, pricingContext = null, scriptContext = null, needsKnowledge = false } = {}) {
  if (isAskMoreRoomsMessage(message?.text || conversationText) && liveContext?.fromAvailabilityMemory && Array.isArray(liveContext?.rooms) && liveContext.rooms.length) {
    return {
      text: buildMoreAvailabilityReply({ liveContext, pricingContext }),
      attachmentsUrls: [],
      messageParts: buildRoomInfoImageMessageParts({ message, conversationText, liveContext, pricingContext }),
      provider: 'agent-tools',
      modelId: 'agent-tools',
      modelLabel: 'Agent Tool Pipeline',
      source: 'availability-more'
    };
  }

  if (['availability', 'pricing', 'booking', 'quote'].includes(intent)) {
    if (liveContext?.status === 'error' && liveContext?.directReply) {
      return { text: liveContext.directReply, provider: 'hotel-live-error', modelId: 'hotel-live-error', modelLabel: 'Hotel Live Error' };
    }
    if (liveContext?.missing?.length) {
      return {
        text: `Dạ em kiểm tra được ngay ạ. Anh/chị cho em xin thêm ${liveContext.missing.join(' và ')} ạ.`,
        provider: 'agent-tools',
        modelId: 'agent-tools',
        modelLabel: 'Agent Tool Pipeline',
        source: 'missing-fields'
      };
    }
    if (Array.isArray(liveContext?.rooms) && liveContext.rooms.length) {
      return {
        text: buildAvailabilityAndPricingReply({ message, conversationText, liveContext, pricingContext }),
        attachmentsUrls: [],
        messageParts: buildRoomInfoImageMessageParts({ message, conversationText, liveContext, pricingContext }),
        provider: 'agent-tools',
        modelId: 'agent-tools',
        modelLabel: 'Agent Tool Pipeline',
        source: 'availability-pricing'
      };
    }
    if (liveContext?.searched) {
      return {
        text: buildNoAvailabilityReply({ liveContext }),
        provider: 'agent-tools',
        modelId: 'agent-tools',
        modelLabel: 'Agent Tool Pipeline',
        source: 'availability-empty'
      };
    }
  }

  if (['checkin', 'checkout', 'policy', 'service', 'general', 'greeting', 'building_info', 'amenities', 'room_info', 'pricing'].includes(intent) && scriptContext?.replyText && scriptContext?.allowDirectReply !== false) {
    return {
      text: scriptContext.replyText,
      provider: 'knowledge-tools',
      modelId: 'knowledge-tools',
      modelLabel: 'Knowledge Tool Pipeline',
      source: 'script-knowledge'
    };
  }
  if (needsKnowledge && !scriptContext?.replyText && !['availability', 'quote', 'booking'].includes(intent)) {
    return {
      text: 'Dạ để em kiểm tra lại thông tin chính xác rồi phản hồi mình ngay ạ.',
      provider: 'grounding-guard',
      modelId: 'grounding-guard',
      modelLabel: 'Grounding Guard',
      source: 'no-confident-knowledge'
    };
  }
  return null;
}

function formatRoomDetailList(rooms = []) {
  return (Array.isArray(rooms) ? rooms : []).map((room, index) => {
    const building = room?.building?.name || room?.buildingName || 'Thông tin đang cập nhật';
    const code = room?.roomCode || room?.roomNumber || room?.number || room?.roomId || 'Thông tin đang cập nhật';
    const area = room?.area || room?.acreage || room?.roomType?.area || 'Thông tin đang cập nhật';
    const price = room?.price != null ? `${formatCurrencyVnd(room.price)} Đ/đêm` : 'Thông tin đang cập nhật';
    const features = [room?.roomType?.name, room?.view, room?.note, ...(Array.isArray(room?.amenities) ? room.amenities.slice(0, 4) : [])]
      .filter(Boolean)
      .join(', ') || 'Thông tin đang cập nhật';
    const images = Array.isArray(room?.images) ? room.images.filter(Boolean) : [];
    const imageText = images.length ? ` + [${images.join(', ')}]` : '';
    return `${index + 1}. Căn ${building} ${code} - ${area} - ${price} - ${features}${imageText}`;
  }).join('\n');
}

function withDefaultCheckTime(dateValue = '', time = '00:00') {
  const value = String(dateValue || '').trim();
  if (!value) return '';
  if (/T\d{2}:\d{2}/.test(value)) return value;
  return `${value}T${time}`;
}

function buildAvailabilityAndPricingReply({ message = {}, conversationText = '', liveContext = null, pricingContext = null } = {}) {
  const items = Array.isArray(liveContext?.rooms) ? liveContext.rooms : [];
  const dates = liveContext?.dates || {};
  const dateText = `${formatDisplayDate(dates.checkInDate)} đến ${formatDisplayDate(dates.checkOutDate)}`;
  const guestText = Number.isFinite(Number(liveContext?.search?.guestCount)) && Number(liveContext.search.guestCount) > 0
    ? ` cho ${Number(liveContext.search.guestCount)} khách`
    : '';
  const bedroomText = Number.isFinite(Number(liveContext?.search?.requestedBedroomCount)) && Number(liveContext.search.requestedBedroomCount) > 0
    ? `, ưu tiên ${Number(liveContext.search.requestedBedroomCount)} phòng ngủ`
    : '';
  const filters = [liveContext?.roomType?.name, liveContext?.building?.name].filter(Boolean).join(' tại ');
  const grouped = summarizeAvailableRooms(items);
  const summary = grouped.slice(0, 4).map((item) => `${item.label}: ${item.count} căn`).join('; ');
  const pricedOptions = Array.isArray(pricingContext?.matchedOptions) ? pricingContext.matchedOptions.slice(0, 3) : [];
  const negotiation = Boolean(pricingContext?.negotiation);
  const priceSummary = pricingContext?.priceRangeText ? ` Giá bán hiện tại khoảng ${pricingContext.priceRangeText}.` : '';
  const selectedRooms = selectRoomsForCurrentSend({ liveContext, pricingContext });
  const pricedByCode = new Map((Array.isArray(pricingContext?.matchedOptions) ? pricingContext.matchedOptions : [])
    .map((item) => [normalizeCode(item?.roomCode || item?.code), item])
    .filter(([key]) => key));
  const roomLines = selectedRooms.map((room, index) => {
    const option = pricedByCode.get(normalizeCode(room?.roomCode || room?.roomNumber || room?.roomId)) || {};
    return formatSingleRoomInfoLine(room, option, index, dates);
  }).filter(Boolean).join('\n\n');
  const staySummary = formatStayRequestSummary({ liveContext, dateText });
  const negotiationText = negotiation ? ' Nếu anh/chị đang cân nhắc vì giá, em có thể lọc các căn mềm hơn hoặc hỗ trợ xin mức tốt hơn cho vài căn phù hợp ạ.' : '';
  return [
    `Dạ em tìm được ${items.length} căn phù hợp với thông tin mình đưa${staySummary ? `: ${staySummary}` : ''}.`,
    `Kết quả${filters ? ` tại ${filters}` : ''}${guestText}${bedroomText} từ ${dateText}${summary ? ` (${summary})` : ''}.${priceSummary}`,
    roomLines,
    'Em sẽ gửi lần lượt toàn bộ hình của từng căn ngay sau thông tin căn đó để anh/chị xem cho dễ ạ.',
    `Anh/chị muốn em giữ căn nào hoặc em lọc thêm theo toà/view/ngân sách cho mình ạ?${negotiationText}`
  ].filter(Boolean).join('\n\n');
}


function buildRoomInfoImageMessageParts({ message = {}, conversationText = '', liveContext = null, pricingContext = null } = {}) {
  const rooms = Array.isArray(liveContext?.rooms) ? liveContext.rooms : [];
  if (!rooms.length) return [];
  const dates = liveContext?.dates || {};
  const dateText = `${formatDisplayDate(dates.checkInDate)} đến ${formatDisplayDate(dates.checkOutDate)}`;
  const guestText = Number.isFinite(Number(liveContext?.search?.guestCount)) && Number(liveContext.search.guestCount) > 0
    ? ` cho ${Number(liveContext.search.guestCount)} khách`
    : '';
  const bedroomText = Number.isFinite(Number(liveContext?.search?.requestedBedroomCount)) && Number(liveContext.search.requestedBedroomCount) > 0
    ? `, ưu tiên ${Number(liveContext.search.requestedBedroomCount)} phòng ngủ`
    : '';
  const filters = [liveContext?.roomType?.name, liveContext?.building?.name].filter(Boolean).join(' tại ');
  const grouped = summarizeAvailableRooms(rooms);
  const summary = grouped.slice(0, 4).map((item) => `${item.label}: ${item.count} căn`).join('; ');
  const priceSummary = pricingContext?.priceRangeText ? ` Giá bán hiện tại khoảng ${pricingContext.priceRangeText}.` : '';
  const staySummary = formatStayRequestSummary({ liveContext, dateText });
  const selectedRooms = selectRoomsForCurrentSend({ liveContext, pricingContext });
  if (liveContext && typeof liveContext === 'object') {
    liveContext.lastShownRoomCodes = selectedRooms.map(normalizeRoomCode).filter(Boolean);
  }
  const introText = liveContext?.fromAvailabilityMemory
    ? buildMoreAvailabilityReply({ liveContext, pricingContext })
    : [
      `Dạ em tìm được ${rooms.length} căn phù hợp với thông tin mình đưa${staySummary ? `: ${staySummary}` : ''}.`,
      `Kết quả${filters ? ` tại ${filters}` : ''}${guestText}${bedroomText} từ ${dateText}${summary ? ` (${summary})` : ''}.${priceSummary}`,
      `Em gửi lần lượt từng căn: thông tin căn đó trước, rồi tới toàn bộ hình của căn đó ạ.`
    ].filter(Boolean).join('\n\n');
  const parts = [{
    text: introText,
    attachmentsUrls: []
  }];
  const pricedByCode = new Map((Array.isArray(pricingContext?.matchedOptions) ? pricingContext.matchedOptions : [])
    .map((item) => [normalizeCode(item?.roomCode || item?.code), item])
    .filter(([key]) => key));
  selectedRooms.forEach((room, index) => {
    const option = pricedByCode.get(normalizeCode(room?.roomCode || room?.roomNumber || room?.roomId)) || {};
    const infoText = formatSingleRoomInfoLine(room, option, index, dates);
    if (infoText) parts.push({ text: infoText, attachmentsUrls: [] });
    const roomImageUrls = collectSingleRoomImageUrls(room, option)
      .filter(isDirectDownloadableImageUrl)
      .filter((url, urlIndex, list) => list.indexOf(url) === urlIndex);
    if (roomImageUrls.length) {
      const code = room?.roomCode || room?.roomNumber || room?.number || room?.roomId || option?.roomCode || option?.code || `số ${index + 1}`;
      parts.push({ text: `- Hình ảnh căn ${code} ạ.`, attachmentsUrls: roomImageUrls });
    }
  });
  const negotiation = Boolean(pricingContext?.negotiation);
  parts.push({
    text: `Anh/chị muốn em giữ căn nào hoặc lọc thêm theo toà/view/ngân sách cho mình ạ?${negotiation ? ' Nếu anh/chị đang cân nhắc vì giá, em có thể lọc các căn mềm hơn hoặc hỗ trợ xin mức tốt hơn cho vài căn phù hợp ạ.' : ''}`,
    attachmentsUrls: []
  });
  return parts.filter((part) => String(part?.text || '').trim() || (Array.isArray(part?.attachmentsUrls) && part.attachmentsUrls.length));
}

function selectRoomsForCustomerSend({ rooms = [], pricingContext = null } = {}) {
  const sortedRooms = sortRoomsForCustomer(rooms);
  const topOptions = Array.isArray(pricingContext?.matchedOptions) ? pricingContext.matchedOptions.slice(0, 50) : [];
  const preferredCodes = topOptions.map((item) => normalizeCode(item?.roomCode || item?.code)).filter(Boolean);
  const picked = [];
  for (const code of preferredCodes) {
    const room = sortedRooms.find((item) => normalizeRoomCode(item) === code);
    if (room && !picked.includes(room)) picked.push(room);
  }
  for (const room of sortedRooms) {
    if (!picked.includes(room)) picked.push(room);
  }
  return picked;
}

function selectRoomsForCurrentSend({ liveContext = null, pricingContext = null, limit = 5 } = {}) {
  const rooms = Array.isArray(liveContext?.rooms) ? liveContext.rooms : [];
  const all = selectRoomsForCustomerSend({ rooms, pricingContext });
  const alreadySent = new Set((Array.isArray(liveContext?.sentRoomCodes) ? liveContext.sentRoomCodes : []).map(normalizeCode).filter(Boolean));
  const page = all.filter((room) => !alreadySent.has(normalizeRoomCode(room))).slice(0, limit);
  return page.length ? page : all.slice(0, limit);
}

function buildMoreAvailabilityReply({ liveContext = null, pricingContext = null } = {}) {
  const total = Array.isArray(liveContext?.allRoomCodes) ? liveContext.allRoomCodes.length : (Array.isArray(liveContext?.rooms) ? liveContext.rooms.length : 0);
  const sentCount = Array.isArray(liveContext?.sentRoomCodes) ? liveContext.sentRoomCodes.length : 0;
  const current = selectRoomsForCurrentSend({ liveContext, pricingContext });
  const remainingAfterThis = Math.max(0, total - sentCount - current.length);
  return [
    `Dạ em gửi thêm ${current.length} căn tiếp theo cho mình xem ạ.`,
    remainingAfterThis > 0 ? `Sau nhóm này còn ${remainingAfterThis} căn khác, nếu mình muốn em gửi tiếp ạ.` : 'Đây là các căn còn lại em đang thấy phù hợp ạ.'
  ].join('\n\n');
}

function isAskMoreRoomsMessage(text = '') {
  const normalized = normalizeSearchText(text);
  return /\b(xem them|gui them|con nua|phong khac|can khac|lua chon khac|them can|them phong|show more|more)\b/i.test(normalized);
}

function sortRoomsForCustomer(rooms = []) {
  return [...(Array.isArray(rooms) ? rooms : [])].sort((a, b) => {
    const pa = buildingPriority(a);
    const pb = buildingPriority(b);
    if (pa !== pb) return pa - pb;
    return String(a?.roomCode || a?.roomNumber || a?.number || '').localeCompare(String(b?.roomCode || b?.roomNumber || b?.number || ''), 'vi', { numeric: true });
  });
}

function buildingPriority(room = {}) {
  const name = normalizeSearchText([room?.building?.name, room?.buildingName, room?.building?.code].filter(Boolean).join(' '));
  if (name.includes('opera')) return 0;
  if (name.includes('galleria')) return 1;
  if (name.includes('crest')) return 2;
  return 3;
}

function normalizeRoomCode(room = {}) {
  return normalizeCode(room?.roomCode || room?.roomNumber || room?.number || room?.roomId || '');
}

function formatConciseRoomSuggestions(rooms = [], pricingContext = null) {
  const pricedByCode = new Map((Array.isArray(pricingContext?.matchedOptions) ? pricingContext.matchedOptions : [])
    .map((item) => [normalizeCode(item?.roomCode || item?.code), item])
    .filter(([key]) => key));
  return (Array.isArray(rooms) ? rooms : []).slice(0, 3).map((room) => {
    const code = room?.roomCode || room?.roomNumber || room?.number || room?.roomId || '';
    const option = pricedByCode.get(normalizeCode(code)) || {};
    const building = room?.building?.name || room?.buildingName || option?.building || '';
    const price = room?.price != null ? `${formatCurrencyVnd(room.price)} Đ/đêm` : '';
    return [building, code, price ? `giá ${price}` : ''].filter(Boolean).join(' ');
  }).filter(Boolean).join('; ');
}

function formatSingleRoomInfoLine(room = {}, option = {}, index = 0, dates = {}) {
  const building = room?.building?.name || room?.buildingName || option?.building || 'Thông tin đang cập nhật';
  const code = room?.roomCode || room?.roomNumber || room?.number || room?.roomId || option?.roomCode || option?.code || 'Thông tin đang cập nhật';
  const bedroomCount = resolveRoomBedroomCount(room, option);
  const bathroomCount = resolveRoomBathroomCount(room, option);
  const priceNumber = parseMoneyNumber(room?.price ?? option?.price ?? option?.priceWeekend);
  const price = Number.isFinite(priceNumber) && priceNumber > 0 ? `${formatCurrencyVnd(priceNumber)} Đ/đêm` : 'Thông tin đang cập nhật';
  const nights = countStayNights(dates?.checkInDate, dates?.checkOutDate);
  const total = Number.isFinite(priceNumber) && priceNumber > 0 && Number.isFinite(nights) && nights > 0
    ? `${formatCurrencyVnd(priceNumber * nights)} Đ / ${nights} đêm`
    : 'Thông tin đang cập nhật';
  return [
    `+ Căn ${index + 1}: ${building} ${code}`,
    `- Số phòng ngủ: ${bedroomCount || 'Thông tin đang cập nhật'}`,
    `- Số WC: ${bathroomCount || 'Thông tin đang cập nhật'}`,
    `- Giá 1 đêm: ${price}`,
    `- Tổng tiền theo số đêm khách ở: ${total}`
  ].join('\n');
}

function resolveRoomBedroomCount(room = {}, option = {}) {
  const direct = [room?.bedroomCount, room?.bedrooms, room?.bedRoomCount, room?.roomType?.bedroomCount, option?.bedroomCount]
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value > 0);
  if (direct) return `${direct} phòng ngủ`;
  const inferred = inferBedroomCountFromRoomType(room?.roomType?.name || option?.group || '');
  return inferred ? `${inferred} phòng ngủ` : '';
}

function resolveRoomBathroomCount(room = {}, option = {}) {
  const direct = [room?.bathroomCount, room?.bathrooms, room?.toiletCount, room?.wcCount, room?.roomType?.bathroomCount, option?.bathroomCount, option?.wcCount]
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value > 0);
  return direct ? `${direct} WC` : '';
}

function parseMoneyNumber(value) {
  if (value === null || value === undefined || value === '') return Number.NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  const raw = String(value || '').trim();
  if (!raw) return Number.NaN;
  const compact = raw.replace(/[^\d.,]/g, '');
  if (!compact) return Number.NaN;
  if (/^\d+(?:[.,]\d+)?$/.test(compact) && Number(compact.replace(',', '.')) < 1000) {
    return Number(compact.replace(',', '.')) * 1000000;
  }
  const digits = compact.replace(/[^\d]/g, '');
  const num = Number(digits);
  return Number.isFinite(num) ? num : Number.NaN;
}

function countStayNights(checkInDate = '', checkOutDate = '') {
  const start = Date.parse(`${String(checkInDate || '').slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${String(checkOutDate || '').slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return Number.NaN;
  return Math.round((end - start) / 86400000);
}

function formatStayRequestSummary({ liveContext = null, dateText = '' } = {}) {
  const parts = [];
  if (liveContext?.building?.name) parts.push(liveContext.building.name);
  if (Number.isFinite(Number(liveContext?.search?.guestCount)) && Number(liveContext.search.guestCount) > 0) parts.push(`${Number(liveContext.search.guestCount)} khách`);
  if (Number.isFinite(Number(liveContext?.search?.requestedBedroomCount)) && Number(liveContext.search.requestedBedroomCount) > 0) parts.push(`${Number(liveContext.search.requestedBedroomCount)} phòng ngủ`);
  if (dateText && !/Invalid|NaN/i.test(dateText)) parts.push(`từ ${dateText}`);
  return parts.join(', ');
}

function collectSingleRoomImageUrls(room = {}, option = {}) {
  const urls = [];
  const add = (raw) => {
    const value = String(raw || '').trim();
    if (/^https?:\/\//i.test(value) && !urls.includes(value)) urls.push(value);
  };
  add(option?.imageLink);
  for (const url of Array.isArray(room?.images) ? room.images : []) add(url);
  return urls;
}

function isDirectDownloadableImageUrl(url = '') {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) return false;
  if (/photos\.google\.com\/share|photos\.app\.goo\.gl/i.test(value)) return false;
  return /\.(png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(value) || /\/uploads\/rooms\//i.test(value);
}

function stripUrls(value = '') {
  return String(value || '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
}

function collectRoomImageUrls({ liveContext = null, pricingContext = null } = {}) {
  const rooms = Array.isArray(liveContext?.rooms) ? liveContext.rooms : [];
  const topOptions = (Array.isArray(pricingContext?.matchedOptions) ? pricingContext.matchedOptions : []).slice(0, 3);
  const preferredCodes = new Set(topOptions.map((item) => normalizeCode(item?.code)).filter(Boolean));
  const prioritized = rooms.filter((room) => preferredCodes.has(normalizeCode(room?.roomCode || room?.roomNumber)));
  const selectedRooms = (prioritized.length ? prioritized : rooms).slice(0, 3);
  const urls = [];
  for (const item of topOptions) {
    const value = String(item?.imageLink || '').trim();
    if (/^https?:\/\//i.test(value) && !urls.includes(value)) urls.push(value);
  }
  for (const room of selectedRooms) {
    for (const url of Array.isArray(room?.images) ? room.images : []) {
      const value = String(url || '').trim();
      if (value && !urls.includes(value)) urls.push(value);
    }
  }
  return urls;
}

function buildSafeSystemIssueReply() {
  return 'Dạ hiện hệ thống kiểm tra phòng đang gián đoạn nhẹ, em đã chuyển người phụ trách kiểm tra lại ngay cho mình ạ.';
}

function buildNoAvailabilityReply({ liveContext = null } = {}) {
  const filters = [liveContext?.roomType?.name, liveContext?.building?.name].filter(Boolean).join(' tại ');
  const dateText = `${formatDisplayDate(liveContext?.dates?.checkInDate)} đến ${formatDisplayDate(liveContext?.dates?.checkOutDate)}`;
  return `Dạ em vừa kiểm tra${filters ? ` cho ${filters}` : ''} từ ${dateText} nhưng hiện chưa thấy căn trống phù hợp ạ. Nếu anh/chị muốn, em kiểm tra thêm toà khác hoặc loại phòng gần nhất với nhu cầu ngay.`;
}

function buildPricingToolContext({ config = {}, message = {}, conversationText = '', liveContext = null } = {}) {
  const rooms = Array.isArray(liveContext?.rooms) ? liveContext.rooms : [];
  if (!rooms.length) return null;
  const negotiation = shouldRevealNegotiationPrice({ message, conversationText });
  const pricingText = resolvePricingKnowledgeText({ config });
  const pricingRows = pricingText ? parsePricingRows(pricingText) : [];
  const matchedPricingRows = pricingRows.length
    ? matchPricingRows({ rows: pricingRows, liveContext, query: `${conversationText}\n${String(message?.text || '')}` })
    : [];
  const matchedPricingRowMap = new Map(matchedPricingRows.map((row) => [normalizeCode(row.code), row]).filter(([key]) => key));
  const roomByCode = new Map(rooms.map((room) => [String(room?.roomCode || room?.roomNumber || room?.roomId || ''), room]));
  const matchedOptions = rooms.map((room) => ({
    code: room?.roomCode || room?.roomNumber || room?.roomId || '',
    roomCode: room?.roomCode || room?.roomNumber || room?.roomId || '',
    group: room?.roomType?.name || '',
    building: room?.building?.name || room?.building?.code || '',
    priceWeekend: parseVndToMillion(room?.price),
    priceDiscount: negotiation ? parseVndToMillion(room?.discountablePrice) : Number.NaN,
    imageLink: '',
    saleDescription: ''
  })).map((item) => {
    const matchedRow = matchedPricingRowMap.get(normalizeCode(item.roomCode));
    const room = roomByCode.get(item.roomCode);
    const fallbackImageLink = Array.isArray(room?.images) ? String(room.images[0] || '').trim() : '';
    return {
      ...item,
      imageLink: String(matchedRow?.imageLink || fallbackImageLink || '').trim(),
      saleDescription: String(matchedRow?.saleDescription || '').trim()
    };
  });
  const priceRows = matchedOptions.filter((item) => Number.isFinite(item.priceWeekend));
  const priceRangeText = priceRows.length
    ? `${formatMillion(Math.min(...priceRows.map((item) => item.priceWeekend)))} - ${formatMillion(Math.max(...priceRows.map((item) => item.priceWeekend)))}/đêm`
    : '';
  return {
    summary: priceRows.length
      ? `Đã lấy giá trực tiếp từ API live cho ${priceRows.length} căn phù hợp${matchedPricingRows.length ? ` và ghép ${matchedPricingRows.length} dòng bảng giá nội bộ để lấy link ảnh chọn lọc` : ''}.`
      : 'Đã có availability live nhưng chưa thấy giá ở kết quả API.',
    parameters: {
      roomCount: rooms.length,
      negotiation,
      desiredBuilding: liveContext?.building?.name || null,
      desiredGroup: liveContext?.requestedGroup || null,
      pricingKnowledgeRows: matchedPricingRows.length
    },
    resultText: matchedOptions.slice(0, 6).map((item) => {
      const bits = [item.code || 'N/A'];
      if (item.building) bits.push(item.building);
      if (item.group) bits.push(item.group);
      if (Number.isFinite(item.priceWeekend)) bits.push(`giá bán ${formatMillion(item.priceWeekend)}`);
      if (negotiation && Number.isFinite(item.priceDiscount)) bits.push(`có thể giảm khoảng ${formatMillion(item.priceDiscount)}`);
      return `- ${bits.join(' | ')}`;
    }).join('\n'),
    matchedOptions,
    priceRangeText,
    negotiation
  };
}

function isPricingKnowledgeDoc(doc = {}) {
  const haystack = normalizeSearchText(`${doc?.id || ''} ${doc?.name || ''} ${doc?.title || ''} ${doc?.path || ''}`);
  return /bang(?:\s|_)*gia|price/.test(haystack);
}

function resolvePricingKnowledgeText({ config = {} } = {}) {
  const docs = Array.isArray(config?.knowledgeDocuments) ? config.knowledgeDocuments : [];
  const pricingDoc = docs.find((doc) => isPricingKnowledgeDoc(doc));
  if (pricingDoc) {
    const text = readKnowledgeText(pricingDoc);
    if (text) return text;
  }
  const candidateDirs = [
    String(process.env.DATA_DIR || '').trim(),
    path.join(process.cwd(), 'data')
  ].filter(Boolean);
  for (const dir of candidateDirs) {
    const fallbackPath = path.join(dir, 'ai-knowledge', 'chihome-metropole-bang-gia.md');
    try {
      return fs.readFileSync(fallbackPath, 'utf8');
    } catch {}
  }
  return '';
}

function buildScriptToolContext({ config = {}, message = {}, conversationText = '', intent = 'general' } = {}) {
  const docs = getInternalKnowledgeDocs(config);
  if (!docs.length) return null;
  const knowledgeText = docs.map(readKnowledgeText).filter(Boolean).join('\n\n');
  const currentText = String(message?.text || '').trim();
  const query = `${currentText || conversationText}\n${intent}`.trim();
  const normalizedQuery = normalizeSearchText(query);
  const scriptMatch = buildScriptMatchFromDocs(docs, query);
  const hint = scriptMatch.hint;
  const defaultTimes = extractDefaultCheckTimes(knowledgeText);
  let replyText = '';
  let directSource = '';
  const asksTimeOnly = /(may\s+gio|mấy\s+giờ|gio\s+nao|giờ\s+nào|luc\s+may\s+gio|lúc\s+mấy\s+giờ|mac\s+dinh|mặc\s+định|what\s+time)/i.test(normalizedQuery);
  if (intent === 'checkin' && defaultTimes.checkIn && asksTimeOnly) {
    replyText = `Dạ thời gian nhận phòng mặc định là từ ${defaultTimes.checkIn} ạ. Nếu anh/chị muốn nhận sớm hơn, em kiểm tra giúp mình theo tình trạng căn trong ngày nhé.`;
    directSource = 'default_time';
  } else if (intent === 'checkout' && defaultTimes.checkOut && asksTimeOnly) {
    replyText = `Dạ giờ trả phòng mặc định là ${defaultTimes.checkOut} ạ. Nếu anh/chị muốn trả muộn hơn, em kiểm tra giúp mình theo tình trạng khách kế tiếp nhé.`;
    directSource = 'default_time';
  } else {
    replyText = hint ? convertScriptHintToReply(hint, intent) : '';
    if (replyText && scriptMatch.exact) directSource = 'exact_script';
    else if (replyText && scriptMatch.topScore >= 32) directSource = 'strong_retrieval';
  }
  if (/\bmat\s+the\b|\bphi\s+mat\s+the\b|\blam\s+mat\s+the\b/.test(normalizedQuery) && /^\s*[\d.,]+\s*(vnd|đ|usd|\$)/i.test(replyText)) {
    replyText = `Dạ phí mất thẻ là ${replyText.trim()} ạ.`;
  }
  if (/\bnoi\s+em\s+be\b|\bcui\s+em\s+be\b|\bem\s+be\b/.test(normalizedQuery) && /^\s*(?:[\d.,]+\s*(?:vnd|đ|usd|\$)|\$\s*[\d.,]+)/i.test(replyText)) {
    replyText = `Dạ phí nôi em bé là ${replyText.trim()} ạ.`;
  }
  const wifiReply = buildWifiKnowledgeReply({ knowledgeText, normalizedQuery });
  if (wifiReply) {
    replyText = wifiReply;
    directSource = 'wifi_knowledge';
  }
  const poolReply = buildPoolGymKnowledgeReply({ knowledgeText, normalizedQuery });
  if (poolReply) {
    replyText = poolReply;
    directSource = 'pool_gym_knowledge';
  }
  const parkingReply = buildParkingKnowledgeReply({ knowledgeText, normalizedQuery });
  if (parkingReply) {
    replyText = parkingReply;
    directSource = 'parking_knowledge';
  }
  if (!replyText && intent === 'checkin' && defaultTimes.checkIn) {
    replyText = `Dạ thời gian nhận phòng mặc định là từ ${defaultTimes.checkIn} ạ. Nếu anh/chị muốn nhận sớm hơn, em kiểm tra giúp mình theo tình trạng căn trong ngày nhé.`;
    directSource = 'default_time';
  }
  if (!replyText && intent === 'checkout' && defaultTimes.checkOut) {
    replyText = `Dạ giờ trả phòng mặc định là ${defaultTimes.checkOut} ạ. Nếu anh/chị muốn trả muộn hơn, em kiểm tra giúp mình theo tình trạng khách kế tiếp nhé.`;
    directSource = 'default_time';
  }
  if (!hint && !replyText) return null;
  return {
    summary: 'Đã tìm thấy script nội bộ liên quan.',
    parameters: { documentId: docs.map((doc) => doc.id || doc.name).filter(Boolean).slice(0, 5).join(',') || null, intent, confidence: scriptMatch.topScore || 0, exact: scriptMatch.exact || false },
    resultText: hint || [defaultTimes.checkIn ? `Check-in: ${defaultTimes.checkIn}` : '', defaultTimes.checkOut ? `Check-out: ${defaultTimes.checkOut}` : ''].filter(Boolean).join(' | '),
    replyText,
    confidence: scriptMatch.topScore || (directSource ? 100 : 0),
    exact: Boolean(scriptMatch.exact || directSource === 'default_time' || directSource === 'parking_knowledge' || directSource === 'wifi_knowledge' || directSource === 'pool_gym_knowledge'),
    directSource,
    allowDirectReply: Boolean(replyText && (directSource || scriptMatch.exact || scriptMatch.topScore >= 32))
  };
}

function buildWifiKnowledgeReply({ knowledgeText = '', normalizedQuery = '' } = {}) {
  const q = String(normalizedQuery || '');
  if (!/\bwifi\b|\bwi\s*fi\b|mat\s+khau\s+wifi|pass\s+wifi/.test(q)) return '';
  const match = String(knowledgeText || '').match(/(?:📶\s*)?WIFI:\s*\n\s*-?\s*([^\n]+)\s*\n\s*-?\s*Pass:\s*([^\n]+)/i)
    || String(knowledgeText || '').match(/Chihome\s+wifi\s*\n\s*Pass:\s*([^\n]+)/i);
  if (!match) return '';
  if (match.length >= 3) return `Dạ wifi là ${match[1].trim()}, pass: ${match[2].trim()} ạ.`;
  return `Dạ wifi là Chihome wifi, pass: ${match[1].trim()} ạ.`;
}

function buildPoolGymKnowledgeReply({ knowledgeText = '', normalizedQuery = '' } = {}) {
  const q = String(normalizedQuery || '');
  if (!/\bho\s+boi\b|\bgym\b|\bpool\b|phong\s+tap/.test(q)) return '';
  const raw = String(knowledgeText || '');
  const line = raw.split(/\r?\n/).map((item) => item.trim()).find((item) => /ho\s*bơi|hồ\s*bơi/i.test(item) && /gym/i.test(item) && /kh[oô]ng\s+sử\s+dụng|khong\s+su\s+dung/i.test(item));
  if (line) return line;
  const fallback = raw.match(/Tôi rất tiếc[^\n]*hồ bơi[^\n]*(?:\n[^#\n]+)?/i);
  return fallback ? fallback[0].trim() : '';
}

function buildParkingKnowledgeReply({ knowledgeText = '', normalizedQuery = '' } = {}) {
  const q = String(normalizedQuery || '');
  if (!/\b(gui\s+xe|goi\s+xe|do\s+xe|dau\s+xe|bai\s+xe|parking|o\s+to|xe\s+hoi)\b/.test(q)) return '';
  const registration = extractKnowledgeSectionBody(knowledgeText, /\bgui\s+xe\b/);
  const fee = extractKnowledgeSectionBody(knowledgeText, /phi\s+dau\s+xe|phi\s+do\s+xe|dau\s+xe\s+duoi\s+ham/);
  const asksFee = /\b(phi|gia|bao\s+nhieu)\b/.test(q);
  const selected = asksFee ? fee : [registration, fee].filter(Boolean).join('\n\n');
  if (!selected) return '';
  return trimText(selected, 900);
}

function extractKnowledgeSectionBody(text = '', titlePattern = /$^/) {
  const sections = splitKnowledgeSections(text);
  const hit = sections.find((section) => titlePattern.test(normalizeSearchText(extractSectionTitle(section) || '')));
  if (!hit) return '';
  return String(hit || '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*##\s+/.test(line))
    .filter((line) => !/^\s*Trigger\/ý định\s*:/i.test(line))
    .join('\n')
    .trim();
}

function extractDefaultCheckTimes(text = '') {
  const raw = String(text || '');
  const checkInMatch = raw.match(/Thời gian nhận phòng là từ\s*([^\n.]+)/i) || raw.match(/nhận phòng là từ\s*([^\n.]+)/i);
  const checkOutMatch = raw.match(/Giờ checkout là\s*([^\n.]+)/i) || raw.match(/Giờ trả phòng là\s*([^\n.]+)/i);
  return {
    checkIn: checkInMatch ? checkInMatch[1].trim() : '',
    checkOut: checkOutMatch ? checkOutMatch[1].trim() : ''
  };
}

function convertScriptHintToReply(hint = '', intent = 'general') {
  const text = String(hint || '').replace(/^### Script nội bộ liên quan\s*/i, '').trim();
  if (!text) return '';
  const blocks = text.split(/\n\n+/).map((item) => item.trim()).filter(Boolean);
  const contentBlocks = blocks.filter((item) => !/^#{1,6}\s+/.test(item));
  const primary = contentBlocks.length ? contentBlocks.join('\n\n') : (blocks[0] || text);
  if (['greeting', 'general'].includes(intent)) return trimText(primary, 1200);
  return trimText(primary, 1600);
}

function summarizeHotelLiveContext(liveContext = null) {
  if (!liveContext || typeof liveContext !== 'object') return '';
  if (liveContext.status === 'error') return `Tool live lỗi: ${liveContext.reason || 'unknown'}`;
  if (liveContext.missing?.length) return `Thiếu dữ liệu để query live: ${liveContext.missing.join(', ')}`;
  if (Array.isArray(liveContext.rooms) && liveContext.rooms.length) return `Tìm thấy ${liveContext.rooms.length} căn phù hợp từ API live.`;
  if (liveContext.searched) return 'Đã query API live nhưng chưa có căn phù hợp.';
  return 'Đã đọc catalog/building/room type từ API live.';
}

function buildConversationSearchText({ message = {}, thread = {} } = {}) {
  const recent = getThreadMessagesAfterMemoryClear(thread)
    .slice(-12)
    .map((item) => String(item?.text || '').trim())
    .filter(Boolean);
  const memoryBits = [
    String(thread?.automation?.conversationMemory?.lastCustomerMessage || '').trim(),
    String(thread?.automation?.conversationMemory?.summary || '').trim()
  ].filter(Boolean);
  return [...recent, ...memoryBits, String(message?.text || '').trim()].filter(Boolean).join('\n');
}

function getThreadMessagesAfterMemoryClear(thread = {}) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const clearedAt = Date.parse(thread?.automation?.memoryClearedAt || '');
  if (!Number.isFinite(clearedAt)) return messages;
  return messages.filter((item) => {
    const createdAt = Date.parse(item?.createdAt || item?.timestamp || item?.time || '');
    return Number.isFinite(createdAt) && createdAt > clearedAt;
  });
}

function matchPricingRows({ rows = [], liveContext = null, query = '' } = {}) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const desiredBuilding = detectDesiredBuilding(query) || String(liveContext?.building?.name || '').trim();
  const desiredGroup = detectDesiredGroup(query) || liveContext?.requestedGroup || detectDesiredGroup(String(liveContext?.roomType?.name || ''));
  const roomCodeSet = new Set((Array.isArray(liveContext?.rooms) ? liveContext.rooms : []).flatMap((room) => [room?.roomCode, room?.roomNumber]).map(normalizeCode).filter(Boolean));
  let matched = normalizedRows.filter((row) => roomCodeSet.has(normalizeCode(row.code)));
  if (!matched.length && desiredBuilding && desiredGroup) matched = normalizedRows.filter((row) => row.building === desiredBuilding && row.group === desiredGroup);
  if (!matched.length && desiredBuilding) matched = normalizedRows.filter((row) => row.building === desiredBuilding);
  if (!matched.length && desiredGroup) matched = normalizedRows.filter((row) => row.group === desiredGroup);
  if (!matched.length && desiredBuilding && desiredGroup) matched = normalizedRows.filter((row) => row.building === desiredBuilding || row.group === desiredGroup);
  return matched.slice(0, 20);
}

function normalizeCode(value = '') {
  return normalizeSearchText(String(value || '')).replace(/[^a-z0-9]/g, '');
}

function buildStructuredKnowledgeHints(docs = [], query = '') {
  const out = [];
  const scriptDoc = docs.find((doc) => String(doc.id || '').includes('kich_ban'));
  if (scriptDoc) {
    const scriptHint = buildScriptHintFromDoc(scriptDoc, query);
    if (scriptHint) out.push(scriptHint);
  }
  return out;
}

function buildPricingHintFromDoc() {
  return '';
}

function getInternalKnowledgeDocs(config = {}) {
  return (Array.isArray(config.knowledgeDocuments) ? config.knowledgeDocuments : [])
    .filter((doc) => doc?.enabled !== false)
    .filter((doc) => {
      const key = normalizeSearchText(`${doc.id || ''} ${doc.name || ''} ${(doc.tags || []).join(' ')}`);
      return /chihome|kich\s*ban|script|noi\s*quy|metropole|tin\s*nhan\s*mau/.test(key);
    });
}

function shouldProbeInternalKnowledge({ config = {}, message = {}, conversationText = '', intent = 'general', route = null } = {}) {
  const docs = getInternalKnowledgeDocs(config);
  if (!docs.length) return false;
  const query = `${conversationText || ''}\n${message?.text || ''}\n${intent || ''}`.trim();
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery || normalizedQuery.length < 3) return false;
  const routeTools = Array.isArray(route?.tools) ? route.tools : [];
  if (route?.needsKnowledge || routeTools.includes('knowledge') || routeTools.includes('policy_guard')) return true;
  if (['availability', 'quote', 'booking'].includes(String(intent))) return false;
  if (/(san bay|airport|ho boi|gym|checkin|checkout|nhan phong|tra phong|noi quy|ve sinh|don phong|the|wifi|opera|galleria|crest|may nuoc nong|nuoc nong|gui xe|goi xe|bai xe|do xe|dau xe|parking|o to|xe hoi|khan|phu thu|dat coc|huy phong|ho chieu|cccd|tam tru|hut thuoc|toilet|bon cau|em be|noi em be|cui em be|giu phong|quen do|tien phong|thanh toan)/i.test(normalizedQuery)) return true;
  const top = retrieveRelevantKnowledgeChunks({ docs, query: normalizedQuery, maxChunks: 1, maxPerDoc: 1 })[0];
  return Number(top?.score || 0) >= 12;
}

function buildScriptHintFromDocs(docs = [], query = '') {
  return buildScriptMatchFromDocs(docs, query).hint;
}

function buildScriptMatchFromDocs(docs = [], query = '') {
  const normalizedQuery = normalizeSearchText(query);
  const exact = docs.flatMap((doc) => findExactScriptSections({ doc, query: normalizedQuery }));
  const retrieved = exact.length ? exact.slice(0, 1) : retrieveRelevantKnowledgeChunks({ docs, query: normalizedQuery, maxChunks: 3, maxPerDoc: 2 });
  const strongHitsRaw = retrieved.filter((item) => Number(item.score || 0) >= (exact.length ? 0 : 14));
  const seen = new Set();
  const strongHits = [];
  for (const item of strongHitsRaw) {
    const key = normalizeSearchText(String(item.content || '')).replace(/\s+/g, ' ').slice(0, 220);
    if (seen.has(key)) continue;
    seen.add(key);
    strongHits.push(item);
  }
  const hits = strongHits.map((item) => trimText(item.content, 1200));
  if (!hits.length) return { hint: '', exact: false, topScore: 0, hitCount: 0 };
  return {
    hint: `### Script nội bộ liên quan\n${hits.join('\n\n')}`,
    exact: exact.length > 0,
    topScore: Math.max(...strongHits.map((item) => Number(item.score || 0))),
    hitCount: strongHits.length
  };
}

function buildScriptHintFromDoc(doc = {}, query = '') {
  return buildScriptHintFromDocs([doc], query);
}

function findExactScriptSections({ doc = {}, query = '' } = {}) {
  const q = normalizeSearchText(query);
  const sections = splitKnowledgeSections(readKnowledgeText(doc));
  const titleContains = (pattern) => sections
    .map((section) => ({ section, title: normalizeSearchText(extractSectionTitle(section) || '') }))
    .filter((item) => pattern.test(item.title))
    .map((item, index) => ({
      docId: String(doc.id || doc.name || 'script'),
      docName: String(doc.name || doc.id || 'script'),
      sectionTitle: extractSectionTitle(item.section),
      content: item.section,
      chunkIndex: index,
      sectionIndex: index,
      tags: Array.isArray(doc.tags) ? doc.tags : [],
      score: 100
    }));
  if (/\bmat\s+the\b|\bphi\s+mat\s+the\b|\blam\s+mat\s+the\b/.test(q)) return titleContains(/\bmat\s+the\b/).slice(0, 2);
  if (/\bde\s+the\b|\btra\s+the\b|\bthe\s+o\s+dau\b/.test(q)) {
    const cardPlacement = titleContains(/de\s+the|the\s+o\s+dau/);
    return (cardPlacement.length ? cardPlacement : titleContains(/tra\s+phong|checkout/)).slice(0, 2);
  }
  if (/\bphi\s+the\b|\bphat\s+hanh\s+the\b/.test(q)) return titleContains(/phi\s+the|phat\s+hanh\s+the/).slice(0, 2);
  if (/\bnoi\s+em\s+be\b|\bcui\s+em\s+be\b|\bem\s+be\b/.test(q)) return titleContains(/noi\s+em\s+be|cui\s+em\s+be/).slice(0, 2);
  if (/\bmay\s+nuoc\s+nong\b|\bnuoc\s+nong\b/.test(q)) return titleContains(/may\s+nuoc\s+nong|nuoc\s+nong/).slice(0, 2);
  if (/\b(check\s*in|nhan\s+phong)\b.{0,30}\b(som|early)\b|\b(som|early)\b.{0,30}\b(check\s*in|nhan\s+phong)\b/.test(q)) return titleContains(/nhan\s+phong\s+som|check\s*in\s+som/).slice(0, 1);
  if (/\bwifi\b|\bwi\s*fi\b|mat\s+khau\s+wifi|pass\s+wifi/.test(q)) return titleContains(/noi\s+quy\s+khach\s+le|noi\s+quy\s+sale/).slice(0, 1);
  if (/\bho\s+boi\b|\bgym\b|\bpool\b|phong\s+tap/.test(q)) return titleContains(/ho\s+boi|gym|khong\s+tieu\s+de|noi\s+quy\s+khach\s+le/).slice(0, 1);
  if (/\b(phi|gia|bao\s+nhieu)\b.{0,30}\b(gui\s+xe|do\s+xe|dau\s+xe|bai\s+xe|parking|o\s+to|xe\s+hoi)\b|\b(gui\s+xe|do\s+xe|dau\s+xe|bai\s+xe|parking|o\s+to|xe\s+hoi)\b.{0,30}\b(phi|gia|bao\s+nhieu)\b/.test(q)) return titleContains(/phi\s+dau\s+xe|phi\s+do\s+xe|dau\s+xe\s+duoi\s+ham/).slice(0, 2);
  if (/\b(gui\s+xe|goi\s+xe|do\s+xe|dau\s+xe|bai\s+xe|parking|o\s+to|xe\s+hoi)\b/.test(q)) return titleContains(/^gui\s+xe$|gui\s+xe|do\s+xe|dau\s+xe|bai\s+xe|parking/).slice(0, 2);
  return [];
}

function parsePricingRows(text = '') {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('- Mã căn:')) continue;
    const parts = line.slice(2).split('|').map((item) => item.trim()).filter(Boolean);
    const data = {};
    for (const part of parts) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      data[key] = value;
    }
    out.push({
      code: extractCanonicalRoomCode(`${data['Mã căn'] || ''} ${data['Mô tả/chốt sale mẫu'] || ''}`),
      rawCode: data['Mã căn'] || '',
      group: data['Nhóm'] || '',
      building: data['Toà/Khu'] || inferBuildingFromText(`${data['Mã căn'] || ''} ${data['Mô tả/chốt sale mẫu'] || ''}`),
      priceWeekend: parseMillionValue(data['Giá T6/T7'] || ''),
      priceDiscount: parseMillionValue(data['Giá có thể giảm'] || ''),
      note: data['Ghi chú'] || '',
      monthly: data['Giá tháng tham khảo'] || '',
      imageLink: extractFirstUrl(data['Link ảnh'] || data['Mô tả/chốt sale mẫu'] || ''),
      saleDescription: data['Mô tả/chốt sale mẫu'] || ''
    });
  }
  return out;
}

function extractCanonicalRoomCode(text = '') {
  const raw = String(text || '').toUpperCase();
  const match = raw.match(/([A-Z]\d{1,2}(?:[A-Z])?\.\d{1,2}[A-Z]?)/);
  if (!match) return '';
  return normalizeCanonicalRoomCode(match[1]);
}

function normalizeCanonicalRoomCode(value = '') {
  const normalized = String(value || '').trim().toUpperCase();
  const match = normalized.match(/^([A-Z]+)(\d+)([A-Z]?)(?:\.(\d+)([A-Z]?))?$/);
  if (!match) return normalized;
  const [, prefix, leftDigits, leftSuffix = '', rightDigits = '', rightSuffix = ''] = match;
  const left = leftDigits.padStart(2, '0');
  const canonical = rightDigits
    ? `${prefix}${left}${leftSuffix}.${rightDigits.padStart(2, '0')}${rightSuffix}`
    : `${prefix}${left}${leftSuffix}`;
  return canonical === 'C05.03' ? 'C05.03A' : canonical;
}

function detectDesiredGroup(query = '') {
  const q = normalizeSearchText(query);
  const match = q.match(/([1-5])\s*(pn|phong ngu)/i);
  if (match) return `${match[1]}PN`;
  if (q.includes('studio')) return 'Studio';
  return '';
}

function detectDesiredBuilding(query = '') {
  const q = normalizeSearchText(query);
  if (q.includes('opera')) return 'The Opera';
  if (q.includes('galleria')) return 'The Galleria';
  if (q.includes('crest')) return 'The Crest';
  if (q.includes('villa') || q.includes('vinhomes')) return 'Biệt Thự VinHomes Victoria Golden River';
  return '';
}

function inferBuildingFromText(text = '') {
  const q = normalizeSearchText(text);
  if (q.includes('opera')) return 'The Opera';
  if (q.includes('galleria')) return 'The Galleria';
  if (q.includes('crest')) return 'The Crest';
  if (q.includes('villa') || q.includes('vinhome')) return 'Biệt Thự VinHomes Victoria Golden River';
  return '';
}

function normalizeSearchText(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function parseMillionValue(value = '') {
  const raw = String(value || '').toLowerCase().replace(/\s+/g, '');
  if (!raw) return Number.NaN;
  const match = raw.match(/\d+(?:[.,]\d+)?/);
  if (!match) return Number.NaN;
  return Number(match[0].replace(',', '.'));
}

function parseVndToMillion(value = '') {
  const amount = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return Number.NaN;
  return amount / 1_000_000;
}

function shouldRevealNegotiationPrice({ message = {}, conversationText = '' } = {}) {
  const haystack = normalizeSearchText(`${conversationText || ''}\n${String(message?.text || '')}`);
  const patterns = [
    /bot\s*(duoc|dc|khong|k)?/i,
    /giam\s*gia/i,
    /re\s*hon/i,
    /mem\s*hon/i,
    /thuong\s*luong/i,
    /deal/i,
    /fix\s*gia/i,
    /chot\s*gia/i,
    /gia.*cang/i,
    /ho\s*tro\s*gia/i,
    /gia\s*tot\s*hon/i,
    /ngan\s*sach\s*chi\s*co/i,
    /budget\s*chi\s*co/i
  ];
  return patterns.some((pattern) => pattern.test(haystack));
}

function extractFirstUrl(value = '') {
  const match = String(value || '').match(/https?:\/\/\S+/i);
  return match ? match[0].trim() : '';
}

function formatMillion(value) {
  return `${String(Number(value).toFixed(1)).replace(/\.0$/, '')}tr`;
}

function scoreKnowledgeDocument(doc = {}, query = '') {
  const base = `${String(doc.name || '')} ${String(doc.summary || '')} ${String(doc.previewText || '')} ${(Array.isArray(doc.tags) ? doc.tags.join(' ') : '')} ${trimText(readKnowledgeText(doc), 12000)}`.toLowerCase();
  let score = 0;
  for (const token of tokenizeForMatch(query)) {
    if (token.length < 2) continue;
    if (base.includes(token)) score += token.length > 4 ? 3 : 1;
  }
  return score;
}

function formatKnowledgeDocument(doc = {}, query = '') {
  const retrieved = retrieveRelevantKnowledgeChunks({ docs: [doc], query, maxChunks: 3, maxPerDoc: 3 });
  if (retrieved.length) return formatRetrievedKnowledgeChunks(retrieved);
  const excerpt = trimText(readKnowledgeText(doc) || String(doc.previewText || ''), 1400);
  if (!excerpt) return '';
  return `### ${doc.name || 'knowledge'}\n${trimText(excerpt, 1800)}`;
}

function readKnowledgeText(doc = {}) {
  const storagePath = String(doc.storagePath || doc.path || '').trim();
  const candidates = [storagePath];
  if (storagePath && !path.isAbsolute(storagePath)) {
    candidates.push(path.join(process.cwd(), storagePath));
    candidates.push(path.join(process.cwd(), 'data', 'ai-knowledge', path.basename(storagePath)));
  }
  if (storagePath) {
    const fileName = storagePath.split('/').filter(Boolean).pop();
    if (fileName) candidates.push(`/data/ai-knowledge/${fileName}`);
  }
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return String(fs.readFileSync(candidate, 'utf8') || '').trim();
    } catch {
      break;
    }
  }
  return String(doc.previewText || '').trim();
}

function splitKnowledgeSections(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  const parts = normalized.split(/\n(?=##\s+)/g).map((item) => item.trim()).filter(Boolean);
  return parts.length ? parts : [normalized];
}

function chunkKnowledgeSection(section = '', options = {}) {
  const chunkSize = Math.max(500, Number(options.chunkSize || 1100));
  const chunkOverlap = Math.max(80, Number(options.chunkOverlap || 180));
  const normalized = String(section || '').trim();
  if (!normalized) return [];
  if (normalized.length <= chunkSize) return [normalized];
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + chunkSize);
    if (end < normalized.length) {
      const window = normalized.slice(start, end + 120);
      const breakMatch = window.match(/([\n.!?])[^\n.!?]{0,80}$/);
      if (breakMatch?.index != null && breakMatch.index > 0) {
        end = start + breakMatch.index + 1;
      }
    }
    const piece = normalized.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - chunkOverlap);
  }
  return chunks;
}

function buildKnowledgeChunks(doc = {}, options = {}) {
  const sections = splitKnowledgeSections(readKnowledgeText(doc));
  const chunks = [];
  sections.forEach((section, sectionIndex) => {
    const title = extractSectionTitle(section) || `${doc.name || 'knowledge'} #${sectionIndex + 1}`;
    chunkKnowledgeSection(section, options).forEach((content, chunkIndex) => {
      chunks.push({
        docId: String(doc.id || doc.name || `doc_${sectionIndex + 1}`),
        docName: String(doc.name || doc.id || 'knowledge'),
        sectionTitle: title,
        content,
        chunkIndex,
        sectionIndex,
        tags: Array.isArray(doc.tags) ? doc.tags : []
      });
    });
  });
  return chunks;
}

function extractSectionTitle(section = '') {
  const match = String(section || '').match(/^##\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function retrieveRelevantKnowledgeChunks({ docs = [], query = '', maxChunks = 6, maxPerDoc = 2 } = {}) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  const perDocCounter = new Map();
  return (Array.isArray(docs) ? docs : [])
    .flatMap((doc) => buildKnowledgeChunks(doc).map((chunk) => ({ ...chunk, score: scoreKnowledgeChunk(chunk, normalizedQuery) })))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter((item) => {
      const current = perDocCounter.get(item.docId) || 0;
      if (current >= maxPerDoc) return false;
      perDocCounter.set(item.docId, current + 1);
      return true;
    })
    .slice(0, maxChunks);
}

function scoreKnowledgeChunk(chunk = {}, query = '') {
  const haystack = normalizeSearchText(`${chunk.docName} ${chunk.sectionTitle} ${chunk.content} ${(chunk.tags || []).join(' ')}`);
  const tokens = tokenizeForMatch(query);
  let score = 0;
  for (const token of tokens) {
    if (token.length < 2) continue;
    if (haystack.includes(token)) score += token.length > 4 ? 4 : 1;
  }
  const phrase = normalizeSearchText(query).replace(/\s+/g, ' ').trim();
  if (phrase && haystack.includes(phrase)) score += 8;
  if (/checkin|checkout|nhan phong|tra phong|noi quy|ho boi|gym|mat the|phi the|wifi|may nuoc nong|nuoc nong|gui xe|goi xe|bai xe|do xe|dau xe|parking|o to|xe hoi/.test(query) && /script|chinh sach|check|noi quy|ho boi|gym|mat the|phi the|wifi|may nuoc nong|nuoc nong|gui xe|bai xe|do xe|dau xe|parking|o to|xe hoi/.test(haystack)) score += 12;
  if (/\bmat\s+the\b/.test(query) && /\bmat\s+the\b/.test(haystack)) score += 40;
  if (/\bthe\b/.test(query) && /\b(the\s+ra\s+vao|mat\s+the|phi\s+the|de\s+the)\b/.test(haystack)) score += 15;
  if (/gia|bao nhieu|bao gia/.test(query) && /gia|bang gia|sale/.test(haystack)) score += 6;
  if (/opera|galleria|crest|villa|vinhome/.test(query) && /opera|galleria|crest|villa|vinhome/.test(haystack)) score += 5;
  return score;
}

function formatRetrievedKnowledgeChunks(items = []) {
  if (!Array.isArray(items) || !items.length) return '';
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.docName}|||${item.sectionTitle}`;
    if (!grouped.has(key)) grouped.set(key, { docName: item.docName, sectionTitle: item.sectionTitle, contents: [] });
    grouped.get(key).contents.push(trimText(item.content, 900));
  }
  return [...grouped.values()]
    .map((group) => `### ${group.docName}${group.sectionTitle ? ` · ${group.sectionTitle}` : ''}\n${group.contents.join('\n\n')}`)
    .join('\n\n');
}

function scoreSection(section = '', query = '') {
  return scoreKnowledgeChunk({ docName: '', sectionTitle: extractSectionTitle(section), content: section, tags: [] }, query);
}

function tokenizeForMatch(text = '') {
  return [...new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}.]+/u).map((item) => item.trim()).filter(Boolean))];
}

function trimText(text = '', limit = 1800) {
  const value = String(text || '').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export async function buildLiveHotelContext({ config = {}, plan = {}, message = {}, thread = {}, portalBinding = null, conversationText = '' } = {}) {
  const intent = String(plan?.executionSignals?.intent || '').trim().toLowerCase();
  if (!['availability', 'pricing', 'booking', 'quote', 'service', 'room_info', 'amenities', 'building_info'].includes(intent)) {
    return null;
  }

  const client = createChiHomeHotelClient();
  if (!client.hasAuth) {
    if (['availability', 'pricing', 'booking', 'quote'].includes(intent)) {
      return {
        status: 'error',
        reason: 'missing_api_key',
        directReply: buildSafeSystemIssueReply()
      };
    }
    return null;
  }

  const text = String(message?.text || '').trim();
  const mergedText = String(conversationText || buildConversationSearchText({ message, thread }) || text).trim();
  const dates = extractDateRange(text);
  const explicitBedroomCount = extractRequestedBedroomCount(text);
  const guestCount = explicitBedroomCount ? null : extractGuestCount(text);
  const requestedBedroomCount = explicitBedroomCount || inferBedroomCountFromGuests(guestCount);
  const bookingReady = Boolean(dates?.checkInDate && dates?.checkOutDate && requestedBedroomCount);
  const bookingLikeIntent = ['availability', 'pricing', 'booking', 'quote'].includes(intent) || (['service', 'room_info', 'amenities', 'building_info'].includes(intent) && bookingReady);
  const missing = [];
  if (bookingLikeIntent) {
    if (!dates?.checkInDate || !dates?.checkOutDate) missing.push('ngày check-in / check-out');
    if (!requestedBedroomCount) missing.push('số khách hoặc số phòng ngủ');
  }

  try {
    const [buildings, roomTypes] = await Promise.all([
      client.listBuildings(),
      client.listRoomTypes()
    ]);

    const building = matchBuilding(buildings, mergedText);
    const roomType = matchRoomType(roomTypes, mergedText);
    const context = {
      status: 'ok',
      intent,
      searched: false,
      search: {
        guestCount: guestCount || null,
        requestedBedroomCount: requestedBedroomCount || null,
        departmentId: portalBinding?.departmentId || null,
        buildingHint: building?.name || null,
        roomTypeHint: roomType?.name || null
      },
      building: building ? { id: building.id, name: building.name, code: building.code } : null,
      roomType: roomType ? { id: roomType.id, name: roomType.name, basePrice: roomType.basePrice, maxGuests: roomType.maxGuests, amenities: roomType.amenities } : null,
      buildings: Array.isArray(buildings) ? buildings : [],
      roomTypes: Array.isArray(roomTypes) ? roomTypes : [],
      dates: dates ? { ...dates, checkindate: withDefaultCheckTime(dates.checkInDate, '14:00'), checkoutdate: withDefaultCheckTime(dates.checkOutDate, '12:00') } : dates,
      missing
    };

    if (bookingLikeIntent && missing.length) {
      return context;
    }

    if (bookingLikeIntent && dates?.checkInDate && dates?.checkOutDate) {
      const roomTypeById = new Map((Array.isArray(roomTypes) ? roomTypes : []).map((item) => [String(item?.id || ''), item]));
      const rooms = await client.quickRoomSearch({
        checkInDate: withDefaultCheckTime(dates.checkInDate, '14:00'),
        checkOutDate: withDefaultCheckTime(dates.checkOutDate, '12:00'),
        buildingId: building?.id,
        roomTypeId: roomType?.id
      });
      context.searched = true;
      context.rooms = sortRoomsForCustomer(filterRoomsByNeed({ rooms, roomType, roomTypeById, guestCount, requestedBedroomCount }));
      context.requestedGroup = normalizeBedroomGroupLabel(requestedBedroomCount);
      return context;
    }

    if (['service', 'room_info', 'amenities', 'building_info', 'pricing'].includes(intent) && (roomType || building)) {
      const roomsPage = await client.listRooms({
        limit: 8,
        buildingId: building?.id,
        roomTypeId: roomType?.id
      }).catch(() => null);
      context.roomsPage = roomsPage;
      context.directReply = buildRoomInfoReply({ building, roomType, roomsPage });
      return context;
    }

    return context;
  } catch (error) {
    if (bookingLikeIntent && dates?.checkInDate && dates?.checkOutDate) {
      return {
        status: 'error',
        reason: error?.code || error?.message || 'live_api_error',
        search: { guestCount: guestCount || null },
        directReply: buildSafeSystemIssueReply()
      };
    }
    return {
      status: 'error',
      reason: error?.code || error?.message || 'live_api_error',
      search: { guestCount: guestCount || null }
    };
  }
}

function buildAvailabilityReply({ text = '', dates = null, rooms = [], building = null, roomType = null } = {}) {
  const items = Array.isArray(rooms) ? rooms : [];
  const dateText = `${formatDisplayDate(dates?.checkInDate)} đến ${formatDisplayDate(dates?.checkOutDate)}`;
  const filters = [roomType?.name, building?.name].filter(Boolean).join(' tại ');
  if (!items.length) {
    return `Dạ em vừa kiểm tra live ChiHomeHotel cho ${filters ? `${filters} ` : ''}từ ${dateText} nhưng hiện chưa thấy phòng trống phù hợp ạ. Nếu anh/chị muốn, em kiểm tra thêm toà khác hoặc loại phòng khác ngay.`;
  }
  const grouped = summarizeAvailableRooms(items);
  const examples = items.slice(0, 5).map((room) => `- ${room.building?.name || 'N/A'} · ${room.roomType?.name || 'N/A'} · ${room.roomCode || room.roomNumber || room.roomId}`).join('\n');
  const summary = grouped.slice(0, 4).map((item) => `${item.label}: ${item.count} căn`).join('; ');
  return [
    `Dạ em vừa kiểm tra live ChiHomeHotel cho ${filters ? `${filters} ` : ''}từ ${dateText}.`,
    `Hiện còn ${items.length} căn phù hợp${summary ? ` (${summary})` : ''}.`,
    examples ? `Một vài lựa chọn đang trống:\n${examples}` : '',
    /\d+\s*(khach|nguoi)/i.test(normalizeSearchText(text))
      ? 'Nếu anh/chị muốn, em chốt tiếp căn phù hợp nhất theo ngân sách hoặc toà ưu tiên.'
      : 'Anh/chị cho em thêm số khách hoặc toà ưu tiên nếu muốn em lọc ra phương án sát nhất nhé.'
  ].filter(Boolean).join(' ');
}

function buildRoomInfoReply({ building = null, roomType = null, roomsPage = null } = {}) {
  if (!roomType && !building) return '';
  const samples = Array.isArray(roomsPage?.items) ? roomsPage.items.slice(0, 3) : [];
  const sampleText = samples.length
    ? ` Một vài căn đang có trong hệ thống: ${samples.map((item) => item.number).join(', ')}.`
    : '';
  if (roomType) {
    const amenities = Array.isArray(roomType.amenities) && roomType.amenities.length ? roomType.amenities.join(', ') : 'chưa có danh sách tiện ích chi tiết';
    return `Dạ theo dữ liệu live ChiHomeHotel, loại ${roomType.name}${building?.name ? ` tại ${building.name}` : ''} có giá niêm yết từ ${formatCurrencyVnd(roomType.basePrice)}/đêm, tối đa ${roomType.maxGuests || '?'} khách, tiện ích gồm ${amenities}.${sampleText}`;
  }
  return `Dạ theo dữ liệu live ChiHomeHotel, hiện em đã nhận diện toà ${building.name}.${sampleText} Nếu anh/chị muốn em báo đúng loại phòng/phòng trống trong toà này, cho em xin thêm ngày ở hoặc loại phòng nhé.`;
}

function formatLiveContext(liveContext = null) {
  if (!liveContext || liveContext.status === 'error') return '';
  const lines = [];
  if (liveContext.dates?.checkInDate && liveContext.dates?.checkOutDate) lines.push(`- Ngày ở: ${liveContext.dates.checkindate || liveContext.dates.checkInDate} -> ${liveContext.dates.checkoutdate || liveContext.dates.checkOutDate}`);
  if (liveContext.building?.name) lines.push(`- Toà: ${liveContext.building.name}`);
  if (liveContext.roomType?.name) {
    lines.push(`- Loại phòng: ${liveContext.roomType.name}`);
    if (liveContext.roomType.basePrice != null) lines.push(`- Giá niêm yết room type: ${formatCurrencyVnd(liveContext.roomType.basePrice)}/đêm`);
    if (Array.isArray(liveContext.roomType.amenities) && liveContext.roomType.amenities.length) lines.push(`- Tiện ích room type: ${liveContext.roomType.amenities.join(', ')}`);
  }
  if (Array.isArray(liveContext.rooms) && liveContext.rooms.length) {
    lines.push(`- Kết quả availability: ${liveContext.rooms.length} căn`);
    const detailText = formatRoomDetailList(liveContext.rooms);
    if (detailText) lines.push(detailText.split('\n').map((line) => `  - ${line}`).join('\n'));
  }
  if (Array.isArray(liveContext.roomsPage?.items) && liveContext.roomsPage.items.length) lines.push(`- Mẫu căn trong catalog: ${liveContext.roomsPage.items.slice(0, 5).map((item) => item.number).join(', ')}`);
  return lines.join('\n');
}

function extractGuestCount(text = '') {
  const normalized = normalizeSearchText(text);
  const match = normalized.match(/(\d+)\s*(khach|nguoi|adults?|pax)/i);
  return match ? Number(match[1]) : null;
}

function extractRequestedBedroomCount(text = '') {
  const normalized = normalizeSearchText(text);
  const match = normalized.match(/(\d+)\s*(phong ngu|pn|bed(room)?s?|giuong|bed|phong)/i);
  return match ? Number(match[1]) : null;
}

function inferBedroomCountFromGuests(guestCount = null) {
  const guests = Number(guestCount || 0);
  if (!Number.isFinite(guests) || guests <= 0) return null;
  if (guests <= 2) return 1;
  if (guests <= 4) return 2;
  if (guests <= 6) return 3;
  if (guests <= 8) return 4;
  return Math.ceil(guests / 2);
}

function normalizeBedroomGroupLabel(count = null) {
  const number = Number(count || 0);
  if (!Number.isFinite(number) || number <= 0) return '';
  return `${number}PN`;
}

function filterRoomsByNeed({ rooms = [], roomType = null, roomTypeById = new Map(), guestCount = null, requestedBedroomCount = null } = {}) {
  let items = Array.isArray(rooms) ? rooms : [];
  if (roomType?.id) {
    items = items.filter((item) => String(item?.roomType?.id || '') === String(roomType.id));
  }
  if (Number.isFinite(Number(requestedBedroomCount)) && Number(requestedBedroomCount) > 0) {
    items = items.filter((item) => inferBedroomCountFromRoomType(item?.roomType?.name || roomTypeById.get(String(item?.roomType?.id || ''))?.name || '') === Number(requestedBedroomCount));
  }
  if (Number.isFinite(Number(guestCount)) && Number(guestCount) > 0) {
    items = items.filter((item) => {
      const meta = roomTypeById.get(String(item?.roomType?.id || '')) || item?.roomType || {};
      const maxGuests = Number(meta?.maxGuests || 0);
      return !maxGuests || maxGuests >= Number(guestCount);
    });
  }
  return items;
}

function inferBedroomCountFromRoomType(name = '') {
  const normalized = normalizeSearchText(name);
  if (normalized.includes('studio')) return 1;
  const match = normalized.match(/(\d+)\s*(phong ngu|pn)/i);
  return match ? Number(match[1]) : null;
}

function extractDateRange(text = '') {
  const normalizedText = String(text || '').trim();
  const lower = normalizeSearchText(normalizedText);
  const isoDates = normalizedText.match(/20\d{2}-\d{2}-\d{2}/g) || [];
  if (isoDates.length >= 2) return normalizeDateRange({ checkInDate: isoDates[0], checkOutDate: isoDates[1] });

  const localDateTokens = normalizedText.match(/\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?/g) || [];
  const relativeCheckIn = resolveRelativeCheckInDate(lower);
  const nightCount = extractNightCount(lower);

  if (relativeCheckIn && localDateTokens.length >= 1) {
    const checkoutToken = pickCheckoutDateToken(normalizedText, localDateTokens) || localDateTokens[localDateTokens.length - 1];
    return normalizeDateRange({ checkInDate: toIsoFromDate(relativeCheckIn), checkOutDate: parseLocalDateToken(checkoutToken) });
  }

  if (localDateTokens.length >= 2) {
    const [start, end] = localDateTokens;
    return normalizeDateRange({ checkInDate: parseLocalDateToken(start), checkOutDate: parseLocalDateToken(end) });
  }

  const relativeRange = resolveRelativeDateRange(lower);
  if (relativeRange) return relativeRange;

  if (relativeCheckIn && nightCount) {
    return normalizeDateRange({ checkInDate: toIsoFromDate(relativeCheckIn), checkOutDate: toIsoFromDate(addDays(relativeCheckIn, nightCount)) });
  }

  if (localDateTokens.length === 1 && nightCount) {
    const startIso = parseLocalDateToken(localDateTokens[0]);
    const start = startIso ? parseIsoAsLocalDate(startIso) : null;
    if (start) return normalizeDateRange({ checkInDate: startIso, checkOutDate: toIsoFromDate(addDays(start, nightCount)) });
  }

  return null;
}

function resolveRelativeCheckInDate(normalizedText = '') {
  const mention = extractRelativeDateMentions(normalizedText)[0];
  return mention ? addDays(startOfLocalDay(new Date()), mention.offset) : null;
}

function resolveRelativeDateRange(normalizedText = '') {
  const mentions = extractRelativeDateMentions(normalizedText);
  if (mentions.length < 2) return null;
  const today = startOfLocalDay(new Date());
  const checkInDate = toIsoFromDate(addDays(today, mentions[0].offset));
  const checkOutDate = toIsoFromDate(addDays(today, mentions[1].offset));
  return normalizeDateRange({ checkInDate, checkOutDate });
}

function extractRelativeDateMentions(normalizedText = '') {
  const text = String(normalizedText || '');
  const patterns = [
    { re: /\b(hom kia|bua kia)\b/g, offset: -2 },
    { re: /\b(hom qua|bua qua)\b/g, offset: -1 },
    { re: /\b(hom nay|hnay|toi nay|dem nay)\b/g, offset: 0 },
    { re: /\b(ngay mai|mai|toi mai|dem mai)\b/g, offset: 1 },
    { re: /\b(ngay kia|ngay mot|mot)\b/g, offset: 2 }
  ];
  const matches = [];
  for (const { re, offset } of patterns) {
    for (const match of text.matchAll(re)) {
      matches.push({ index: match.index ?? 0, offset, value: match[0] });
    }
  }
  return matches
    .sort((a, b) => a.index - b.index || b.value.length - a.value.length)
    .filter((item, index, list) => index === 0 || item.index >= list[index - 1].index + list[index - 1].value.length);
}

function extractNightCount(normalizedText = '') {
  const match = String(normalizedText || '').match(/\b(\d{1,2})\s*(dem|đem|đêm|night|nights)\b/i);
  const nights = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(nights) && nights > 0 ? nights : null;
}

function parseLocalDateToken(token = '') {
  const match = String(token || '').match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
  if (!match) return null;
  return toIsoDate(match[1], match[2], match[3]);
}

function pickCheckoutDateToken(text = '', tokens = []) {
  const value = String(text || '');
  const checkoutMatch = value.match(/(?:out|checkout|check-out|tra phong|trả phòng|den|đến|toi|tới)\D{0,20}(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)/i);
  if (checkoutMatch?.[1]) return checkoutMatch[1];
  return tokens[tokens.length - 1] || null;
}

function normalizeDateRange(range = {}) {
  const checkInDate = range?.checkInDate || null;
  const checkOutDate = range?.checkOutDate || null;
  if (!checkInDate || !checkOutDate) return null;
  const start = Date.parse(`${String(checkInDate).slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${String(checkOutDate).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { checkInDate, checkOutDate };
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date = new Date(), days = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + Number(days || 0));
}

function parseIsoAsLocalDate(value = '') {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function toIsoDate(day, month, year) {
  const yyyy = year ? normalizeYear(year) : new Date().getFullYear();
  return `${yyyy}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeYear(year) {
  const value = Number(year);
  if (!Number.isFinite(value)) return new Date().getFullYear();
  return value < 100 ? 2000 + value : value;
}

function toIsoFromDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function matchBuilding(buildings = [], text = '') {
  const haystack = normalizeSearchText(text);
  return (Array.isArray(buildings) ? buildings : []).find((item) => {
    const target = normalizeSearchText(`${item?.name || ''} ${item?.code || ''}`);
    return (target && haystack.includes(target)) || (haystack.includes('opera') && /opera/.test(target)) || (haystack.includes('galleria') && /galleria/.test(target)) || (haystack.includes('crest') && /crest/.test(target)) || ((haystack.includes('vinhome') || haystack.includes('villa')) && /(vinhome|biet thu)/.test(target)) || (haystack.includes('lancaster') && /lancaster/.test(target));
  }) || null;
}

function matchRoomType(roomTypes = [], text = '') {
  const haystack = normalizeSearchText(text);
  return (Array.isArray(roomTypes) ? roomTypes : []).find((item) => {
    const target = normalizeSearchText(item?.name || '');
    return (target && haystack.includes(target)) || (haystack.includes('studio') && target.includes('studio')) || (/1\s*(pn|phong ngu)/.test(haystack) && target.includes('1 phong ngu')) || (/2\s*(pn|phong ngu)/.test(haystack) && target.includes('2 phong ngu')) || (/3\s*(pn|phong ngu)/.test(haystack) && target.includes('3 phong ngu')) || (/4\s*(pn|phong ngu)/.test(haystack) && target.includes('4 phong ngu')) || ((haystack.includes('biet thu') || haystack.includes('villa')) && target.includes('biet thu'));
  }) || null;
}

function summarizeAvailableRooms(rooms = []) {
  const counts = new Map();
  for (const room of Array.isArray(rooms) ? rooms : []) {
    const label = [room?.building?.name, room?.roomType?.name].filter(Boolean).join(' · ') || 'Khác';
    counts.set(label, Number(counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function formatDisplayDate(value = '') {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function formatCurrencyVnd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value || '');
  return new Intl.NumberFormat('vi-VN').format(amount);
}

function extractTextFromOpenRouterPayload(payload = {}) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((item) => typeof item?.text === 'string' ? item.text : '').join('\n').trim();
  }
  return '';
}
