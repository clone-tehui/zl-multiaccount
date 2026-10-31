import { readCookie, serializeCookie } from './cookies.js';
import { signJwt, verifyJwt } from './jwt.js';

export const PORTAL_COOKIE_NAME = 'th_portal_session';
export const LEGACY_COOKIE_NAME = 'zalo_sid';

export function createPortalSessionToken(user, options = {}) {
  return signJwt({
    sub: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    roles: Array.isArray(user.roles) ? user.roles : [],
    departmentIds: Array.isArray(user.departmentIds) ? user.departmentIds : [],
    permissions: Array.isArray(user.permissions) ? user.permissions : [],
    sessionVersion: user.sessionVersion || 1
  }, options.jwtSecret, { expiresInSeconds: options.expiresInSeconds });
}

export function buildPortalSessionCookie(token, options = {}) {
  return serializeCookie(PORTAL_COOKIE_NAME, token, {
    domain: Object.prototype.hasOwnProperty.call(options, 'cookieDomain') ? options.cookieDomain : '.tehui.io.vn',
    path: '/',
    httpOnly: true,
    secure: options.secure !== false,
    sameSite: options.sameSite || 'Lax',
    maxAge: options.maxAgeSeconds || 7 * 24 * 60 * 60
  });
}

export function buildPortalLogoutCookie(options = {}) {
  return serializeCookie(PORTAL_COOKIE_NAME, '', {
    domain: Object.prototype.hasOwnProperty.call(options, 'cookieDomain') ? options.cookieDomain : '.tehui.io.vn',
    path: '/',
    httpOnly: true,
    secure: options.secure !== false,
    sameSite: options.sameSite || 'Lax',
    maxAge: 0
  });
}

export function tryReadPortalPrincipal(req, options = {}) {
  const token = readCookie(req, PORTAL_COOKIE_NAME);
  if (!token || !options.jwtSecret) return null;
  try {
    const payload = verifyJwt(token, options.jwtSecret);
    return {
      source: 'sso',
      userId: payload.sub,
      username: payload.username,
      displayName: payload.displayName || payload.username,
      roles: normalizeArray(payload.roles),
      departmentIds: normalizeArray(payload.departmentIds),
      permissions: normalizeArray(payload.permissions),
      sessionVersion: payload.sessionVersion || 1,
      raw: payload
    };
  } catch {
    return null;
  }
}

export function tryReadLegacyPrincipal(req, options = {}) {
  const token = readCookie(req, LEGACY_COOKIE_NAME);
  if (!token || !options.legacySessions?.has(token)) return null;
  const session = options.legacySessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    options.legacySessions.delete(token);
    return null;
  }
  return {
    source: 'legacy',
    userId: session.username,
    username: session.username,
    displayName: session.username,
    roles: [options.legacyRole || 'admin'],
    departmentIds: [],
    permissions: ['*'],
    sessionVersion: 1,
    raw: session
  };
}

export function resolveRequestPrincipal(req, options = {}) {
  return tryReadPortalPrincipal(req, options) || tryReadLegacyPrincipal(req, options) || null;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}
