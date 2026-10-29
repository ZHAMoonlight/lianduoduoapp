import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpPolicy } from '../server/http-policy.mjs';

const request = (remoteAddress = '127.0.0.1', headers = {}, encrypted = false) => ({ socket: { remoteAddress, encrypted }, headers: { host: 'internal:43101', ...headers } });

test('未配置生产HTTP策略时保持本地协议、Cookie与socket IP语义', () => {
  const policy = createHttpPolicy({});
  assert.equal(policy.expectedOrigin(request()), 'http://internal:43101');
  assert.equal(policy.expectedOrigin(request('127.0.0.1', {}, true)), 'https://internal:43101');
  assert.equal(policy.secureCookie(request()), false);
  assert.equal(policy.secureCookie(request('127.0.0.1', {}, true)), true);
  assert.equal(policy.clientIP(request('::ffff:127.0.0.1', { 'x-real-ip': '203.0.113.1' })), '::ffff:127.0.0.1');
  assert.equal(policy.setupTokenRequired, false);
  assert.equal(policy.validSetupToken(request()), true);
});

test('固定HTTPS origin使内部HTTP连接Cookie带Secure，不信任转发协议伪造', () => {
  const policy = createHttpPolicy({ PUBLIC_ORIGIN: 'https://lianduoduo.aiapaas.com/' });
  assert.equal(policy.publicOrigin, 'https://lianduoduo.aiapaas.com');
  assert.equal(policy.expectedOrigin(request()), 'https://lianduoduo.aiapaas.com');
  assert.equal(policy.secureCookie(request()), true);
  const local = createHttpPolicy({});
  assert.equal(local.expectedOrigin(request('127.0.0.1', { 'x-forwarded-proto': 'https', origin: 'https://evil.example' })), 'http://internal:43101');
  assert.equal(local.secureCookie(request('127.0.0.1', { 'x-forwarded-proto': 'https' })), false);
});

test('PUBLIC_ORIGIN拒绝userinfo、路径、查询、片段及非HTTP协议', () => {
  for (const origin of ['not-a-url', 'ftp://example.com', 'https://name:password@example.com', 'https://@example.com', 'https://example.com/path', 'https://example.com/.', 'https://example.com/%2e', 'https://example.com//', 'https://example.com/?q=1', 'https://example.com/#fragment', 'https://example.com\\path', 'https://exam\nple.com']) assert.throws(() => createHttpPolicy({ PUBLIC_ORIGIN: origin }), /PUBLIC_ORIGIN/, origin);
});

test('仅信任精确代理socket IP发送的合法单值X-Real-IP，兼容mapped IPv4', () => {
  const policy = createHttpPolicy({ TRUSTED_PROXY_IPS: '127.0.0.1,::ffff:172.18.0.1,::1' });
  assert.equal(policy.clientIP(request('::ffff:127.0.0.1', { 'x-real-ip': '203.0.113.1' })), '203.0.113.1');
  assert.equal(policy.clientIP(request('172.18.0.1', { 'x-real-ip': '2001:db8::1' })), '2001:db8::1');
  assert.equal(policy.clientIP(request('::1', { 'x-real-ip': '::ffff:203.0.113.2' })), '203.0.113.2');
  assert.equal(policy.clientIP(request('192.0.2.1', { 'x-real-ip': '203.0.113.1' })), '192.0.2.1');
  assert.equal(policy.clientIP(request('127.0.0.1', { 'x-forwarded-for': '203.0.113.1' })), '127.0.0.1');
  for (const real of [['203.0.113.1'], '203.0.113.1,127.0.0.1', 'not-an-ip', 'https://example.com', '', '203.0.113.01']) assert.equal(policy.clientIP(request('127.0.0.1', { 'x-real-ip': real })), '127.0.0.1');
  for (const trusted of ['*', '0.0.0.0/0', 'localhost', '127.0.0.1,invalid']) assert.throws(() => createHttpPolicy({ TRUSTED_PROXY_IPS: trusted }), /TRUSTED_PROXY_IPS/);
});

test('开通口令只以指定header匹配，不公开口令且不接受前缀或其他长度', () => {
  const token = 'fixture-only-setup-allow-2026', policy = createHttpPolicy({ SETUP_TOKEN: token });
  assert.equal(policy.setupTokenRequired, true);
  assert.equal(policy.validSetupToken(request()), false);
  assert.equal(policy.validSetupToken(request('127.0.0.1', { 'x-setup-token': [token] })), false);
  for (const bad of ['', token.slice(0, -1), token + 'x', token.toUpperCase()]) assert.equal(policy.validSetupToken(request('127.0.0.1', { 'x-setup-token': bad })), false);
  assert.equal(policy.validSetupToken(request('127.0.0.1', { 'x-setup-token': token })), true);
  assert.equal(JSON.stringify(policy).includes(token), false);
});
