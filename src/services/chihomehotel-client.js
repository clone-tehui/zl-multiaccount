const DEFAULT_BASE_URL = 'https://api.tehui.io.vn/api';
const DEFAULT_TIMEOUT_MS = 15000;

export function createChiHomeHotelClient({
  baseUrl = process.env.CHIHOME_HOTEL_API_BASE_URL || DEFAULT_BASE_URL,
  apiKey = process.env.CHIHOME_HOTEL_API_KEY || '',
  timeoutMs = Number(process.env.CHIHOME_HOTEL_API_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
} = {}) {
  const normalizedBaseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const normalizedApiKey = String(apiKey || '').trim();
  const normalizedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  return {
    baseUrl: normalizedBaseUrl,
    hasAuth: Boolean(normalizedApiKey),

    async listBuildings() {
      return fetchJson(`${normalizedBaseUrl}/buildings`, { apiKey: normalizedApiKey, timeoutMs: normalizedTimeoutMs });
    },

    async listRoomTypes() {
      return fetchJson(`${normalizedBaseUrl}/room-types`, { apiKey: normalizedApiKey, timeoutMs: normalizedTimeoutMs });
    },

    async listRooms(query = {}) {
      return fetchJson(withQuery(`${normalizedBaseUrl}/rooms`, query), { apiKey: normalizedApiKey, timeoutMs: normalizedTimeoutMs });
    },

    async quickRoomSearch(query = {}) {
      return fetchJson(withQuery(`${normalizedBaseUrl}/reservations/quick-room-search`, query), { apiKey: normalizedApiKey, timeoutMs: normalizedTimeoutMs });
    },

    async listReservations(query = {}) {
      return fetchJson(withQuery(`${normalizedBaseUrl}/reservations`, query), { apiKey: normalizedApiKey, timeoutMs: normalizedTimeoutMs });
    }
  };
}

async function fetchJson(url, { apiKey = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!String(apiKey || '').trim()) {
    const error = new Error('missing_api_key');
    error.code = 'missing_api_key';
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.message || response.statusText || `http_${response.status}`);
      error.code = `http_${response.status}`;
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload?.data ?? payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const next = new Error('timeout');
      next.code = 'timeout';
      throw next;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function withQuery(url, query = {}) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    next.searchParams.set(key, String(value));
  }
  return next.toString();
}
