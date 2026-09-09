export const AUTOMATION_ACTIONS = Object.freeze({
  SEND_REPLY: 'send-reply',
  PATCH_THREAD: 'patch-thread-automation',
  EMIT_EVENT: 'emit-event'
});

export const AUTOMATION_RESULTS = Object.freeze({
  SKIP: 'skip',
  REPLY: 'reply',
  ESCALATE: 'escalate'
});

export function normalizeAutomationInboundEvent(input = {}) {
  return {
    channel: String(input.channel || input.provider || 'unknown').trim() || 'unknown',
    accountId: String(input.accountId || input.view?.activeAccountId || '').trim(),
    threadId: String(input.threadId || input.message?.threadId || '').trim(),
    message: input.message || null,
    metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {}
  };
}

export function createAutomationAction(kind, payload = {}) {
  return { kind, payload };
}

export function buildAutomationDecision({
  result = AUTOMATION_RESULTS.SKIP,
  shouldReply = false,
  plan = null,
  analysis = {},
  replyText = null,
  escalationMessage = null,
  actions = []
} = {}) {
  return {
    result,
    action: result,
    shouldReply,
    plan,
    analysis,
    replyText: String(replyText || '').trim() || null,
    escalationMessage: String(escalationMessage || '').trim() || null,
    actions: Array.isArray(actions) ? actions : []
  };
}
