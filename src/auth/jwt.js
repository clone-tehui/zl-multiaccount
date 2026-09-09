import crypto from 'node:crypto';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function decodeBase64url(input) {
  return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

export function signJwt(payload, secret, options = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = {
    iat: now,
    exp: now + (options.expiresInSeconds || 7 * 24 * 60 * 60),
    jti: options.jti || crypto.randomBytes(12).toString('hex'),
    ...payload
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifyJwt(token, secret) {
  const [encodedHeader, encodedPayload, signature] = String(token || '').split('.');
  if (!encodedHeader || !encodedPayload || !signature) throw new Error('JWT không hợp lệ');
  const expected = crypto.createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
  if (!timingSafeEqual(signature, expected)) throw new Error('JWT signature không hợp lệ');
  const header = JSON.parse(decodeBase64url(encodedHeader));
  if (header.alg !== 'HS256') throw new Error('JWT alg không hỗ trợ');
  const payload = JSON.parse(decodeBase64url(encodedPayload));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) throw new Error('JWT đã hết hạn');
  return payload;
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
