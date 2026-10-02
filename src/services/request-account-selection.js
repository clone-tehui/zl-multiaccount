import { createHash } from 'node:crypto';
import { projectAccountState } from '../lib/store.js';
import { resolveVisibleAccountIds } from './access-service.js';
const selectedBySession = new Map();
const SESSION_SELECTION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_SELECTION_LIMIT = 2048;
function pruneSelections(now) {
  for (const [key, entry] of selectedBySession) {
    if (entry.expiresAt <= now) selectedBySession.delete(key);
  }
  while (selectedBySession.size >= SESSION_SELECTION_LIMIT) {
    selectedBySession.delete(selectedBySession.keys().next().value);
  }
}
export function requestAccountId(req, principal, state, portalState, selected = null) {
  const allowed = resolveVisibleAccountIds(Object.values(state.accounts || {}), principal, portalState);
  const key = createHash('sha256').update(String(principal.userId || principal.username || '') + '\0' + String(req.headers.cookie || '')).digest('hex');
  const now = Date.now();
  pruneSelections(now);
  if (selected !== null) {
    if (!allowed.includes(String(selected))) { const e = new Error('Forbidden'); e.statusCode = 403; throw e; }
    selectedBySession.delete(key);
    selectedBySession.set(key, { accountId: String(selected), expiresAt: now + SESSION_SELECTION_TTL_MS });
  }
  const preferred = selectedBySession.get(key)?.accountId;
  return allowed.includes(preferred) ? preferred : allowed[0] || null;
}
export function projectRequestAccount(state, accountId) {
  return projectAccountState(state, accountId || '');
}

export function validateRequestAccount(accountId, principal, state, portalState) {
  const key = String(accountId || '').trim();
  const allowed = resolveVisibleAccountIds(Object.values(state.accounts || {}), principal, portalState);
  if (!key || !state.accounts?.[key] || !allowed.includes(key)) {
    const error = new Error('Forbidden: account ngoài phạm vi được cấp');
    error.statusCode = 403;
    throw error;
  }
  return key;
}
