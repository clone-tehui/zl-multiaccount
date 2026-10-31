import { validateRequestAccount } from './request-account-selection.js';
import { resolveVisibleThreadIds } from './access-service.js';

export function authorizeVoiceThread(principal, accountId, threadId, state, portalState) {
  const key = validateRequestAccount(accountId, principal, state, portalState);
  const thread = state.accountStateById?.[key]?.threads?.[threadId];
  if (thread?.type !== 'direct') {
    const error = new Error('Chỉ hỗ trợ gọi thoại hội thoại cá nhân.');
    error.statusCode = 403;
    throw error;
  }
  const broadAccess = (principal.roles || []).some((role) => ['admin', 'manager'].includes(role)) || (principal.permissions || []).includes('*');
  if (!broadAccess && !resolveVisibleThreadIds([{ ...thread, id: threadId, accountId: key }], principal, portalState, key).includes(threadId)) {
    const error = new Error('Forbidden: hội thoại ngoài phạm vi được phép');
    error.statusCode = 403;
    throw error;
  }
  return { accountId: key, threadId };
}
