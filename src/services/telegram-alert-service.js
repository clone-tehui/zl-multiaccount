const DEFAULT_TIMEOUT_MS = 8000;

export async function sendTelegramAlert({ title = 'Zalo AI alert', text = '', details = null } = {}) {
  const token = String(process.env.TELEGRAM_ALERT_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_ALERT_CHAT_ID || '').trim();
  if (!token || !chatId) return { ok: false, reason: 'missing_telegram_alert_config' };
  const message = formatAlertMessage({ title, text, details });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, reason: `http_${response.status}`, payload };
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'telegram_alert_failed') };
  } finally {
    clearTimeout(timer);
  }
}

function formatAlertMessage({ title = '', text = '', details = null } = {}) {
  const lines = [
    `🚨 ${String(title || 'Zalo AI alert').trim()}`,
    String(text || '').trim()
  ].filter(Boolean);
  const normalized = normalizeDetails(details);
  if (normalized) lines.push('', normalized);
  return truncate(lines.join('\n'), 3900);
}

function normalizeDetails(details) {
  if (!details) return '';
  if (typeof details === 'string') return truncate(details.trim(), 2500);
  try {
    return truncate(JSON.stringify(redactSecrets(details), null, 2), 2500);
  } catch {
    return '';
  }
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/token|secret|key|password|cookie|authorization/i.test(key)) return [key, '[redacted]'];
      return [key, redactSecrets(item)];
    }));
  }
  if (typeof value === 'string') {
    return value.replace(/\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]');
  }
  return value;
}

function truncate(value = '', max = 3900) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
