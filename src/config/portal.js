export function getPortalConfig() {
  return {
    cookieDomain: process.env.PORTAL_COOKIE_DOMAIN || '.tehui.io.vn',
    cookieSecure: process.env.PORTAL_COOKIE_SECURE !== 'false',
    sameSite: process.env.PORTAL_COOKIE_SAMESITE || 'Lax',
    jwtSecret: process.env.PORTAL_JWT_SECRET || process.env.SESSION_SECRET || 'change-me',
    portalUrl: process.env.PORTAL_URL || 'https://portal.tehui.io.vn',
    workspaceUrl: process.env.WORKSPACE_URL || 'https://zl.tehui.io.vn',
    readSource: process.env.PORTAL_READ_SOURCE || 'auto'
  };
}
