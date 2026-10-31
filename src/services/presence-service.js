export function derivePresenceStatus({ declaredStatus, lastActiveAt, forceOfflineUntil } = {}, options = {}) {
  const now = options.now || Date.now();
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs || 90_000;
  const forcedUntil = forceOfflineUntil ? new Date(forceOfflineUntil).getTime() : 0;
  if (forcedUntil && forcedUntil > now) return 'offline';
  if (declaredStatus === 'busy') return 'busy';
  const lastActiveMs = lastActiveAt ? new Date(lastActiveAt).getTime() : 0;
  if (!lastActiveMs || now - lastActiveMs > heartbeatTimeoutMs) return 'offline';
  return 'online';
}
