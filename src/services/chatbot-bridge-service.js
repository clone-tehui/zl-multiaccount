function parseAccountIds(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

async function postJson(fetchImpl, url, headers, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    });
  } finally {
    clearTimeout(timer);
  }
}

export class ChatbotBridgeService {
  constructor({
    webhookUrl = process.env.CHATBOT_WEBHOOK_URL || '',
    secret = process.env.CHATBOT_BRIDGE_SECRET || '',
    selectedAccountIds = process.env.CHATBOT_BRIDGE_ACCOUNT_IDS || '',
    allowGroups = process.env.CHATBOT_BRIDGE_ALLOW_GROUPS === 'true',
    timeoutMs = Number(process.env.CHATBOT_BRIDGE_TIMEOUT_MS || 8000),
    fetchImpl = fetch,
    logger = console,
  } = {}) {
    this.webhookUrl = String(webhookUrl || '').trim();
    this.secret = String(secret || '').trim();
    this.selectedAccountIds = parseAccountIds(selectedAccountIds);
    this.allowGroups = Boolean(allowGroups);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  get enabled() {
    return Boolean(this.webhookUrl && this.secret);
  }

  accountEnabled(accountId) {
    if (!this.selectedAccountIds.size) return true;
    return this.selectedAccountIds.has(String(accountId || ''));
  }

  shouldForward({ accountId, isOutgoing, isGroup }) {
    if (!this.enabled) return false;
    if (!this.accountEnabled(accountId)) return false;
    if (isOutgoing) return false;
    if (isGroup && !this.allowGroups) return false;
    return true;
  }

  async deliver(payload, { accountId, isOutgoing = false, isGroup = false } = {}) {
    if (!this.shouldForward({ accountId, isOutgoing, isGroup })) {
      return { skipped: true };
    }

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await postJson(
          this.fetch,
          this.webhookUrl,
          { 'x-chatbot-bridge-secret': this.secret },
          payload,
          this.timeoutMs,
        );
        if (response.ok) return { ok: true, status: response.status };
        lastError = new Error('Chatbot webhook HTTP ' + response.status);
      } catch (error) {
        lastError = error;
      }

      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }

    this.logger.error('[zalo-user-server] chatbot webhook delivery failed', {
      accountId,
      error: lastError?.message || String(lastError),
    });
    throw lastError;
  }
}

export function isChatbotBridgeAccount(accountId) {
  const url = String(process.env.CHATBOT_WEBHOOK_URL || '').trim();
  const secret = String(process.env.CHATBOT_BRIDGE_SECRET || '').trim();
  if (!url || !secret) return false;
  const selected = parseAccountIds(process.env.CHATBOT_BRIDGE_ACCOUNT_IDS || '');
  return !selected.size || selected.has(String(accountId || ''));
}
