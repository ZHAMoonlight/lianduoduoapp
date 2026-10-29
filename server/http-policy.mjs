import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

function normalizedIP(value) {
  if (typeof value !== 'string' || !isIP(value)) return '';
  const lower = value.toLowerCase();
  return lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4 ? lower.slice(7) : lower;
}

export function createHttpPolicy(environment = process.env) {
  const configuredOrigin = (environment.PUBLIC_ORIGIN || '').trim();
  let publicOrigin = '';
  if (configuredOrigin) {
    let parsed;
    try { parsed = new URL(configuredOrigin); } catch { throw new Error('PUBLIC_ORIGIN 必须为有效的 HTTP(S) origin。'); }
    const authority = /^https?:\/\/([^/?#\\]+)\/?$/i.exec(configuredOrigin)?.[1] || '';
    if (!authority || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || authority.includes('@') || parsed.pathname !== '/' || parsed.search || parsed.hash || /[\u0000-\u0020\u007f]/.test(configuredOrigin)) throw new Error('PUBLIC_ORIGIN 只能包含 HTTP(S) 协议和主机，不可包含账号、路径、查询参数或片段。');
    publicOrigin = parsed.origin;
  }
  const trustedProxyIPs = new Set();
  for (const address of (environment.TRUSTED_PROXY_IPS || '').split(',').map(value => value.trim()).filter(Boolean)) {
    const normalized = normalizedIP(address);
    if (!normalized) throw new Error('TRUSTED_PROXY_IPS 仅接受以逗号分隔的完整 IP 地址。');
    trustedProxyIPs.add(normalized);
  }
  const setupToken = environment.SETUP_TOKEN || '';
  const setupDigest = setupToken ? createHash('sha256').update(setupToken).digest() : null;
  return {
    publicOrigin,
    setupTokenRequired: !!setupDigest,
    expectedOrigin(request) { return publicOrigin || `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}`; },
    secureCookie(request) { return publicOrigin.startsWith('https:') || !!request.socket.encrypted; },
    clientIP(request) {
      const remote = request.socket.remoteAddress || '', real = request.headers['x-real-ip'];
      if (trustedProxyIPs.has(normalizedIP(remote)) && typeof real === 'string' && normalizedIP(real.trim())) return normalizedIP(real.trim());
      return remote;
    },
    validSetupToken(request) {
      if (!setupDigest) return true;
      const supplied = request.headers['x-setup-token'];
      if (typeof supplied !== 'string') return false;
      // Fixed-size digests permit constant-time comparison regardless of input length.
      return timingSafeEqual(setupDigest, createHash('sha256').update(supplied).digest());
    },
  };
}
