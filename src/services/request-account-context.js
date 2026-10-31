import { AsyncLocalStorage } from 'node:async_hooks';
export const requestAccountContext = new AsyncLocalStorage();
export function currentRequestAccountId() {
  return requestAccountContext.getStore()?.accountId || null;
}

export function runWithAccount(accountId, callback) {
  return requestAccountContext.run({ accountId: String(accountId || '') || null }, callback);
}

export function withoutAccountContext(callback) {
  return requestAccountContext.exit(callback);
}
