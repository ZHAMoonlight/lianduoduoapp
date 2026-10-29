import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../server/app.mjs';
import { createMysqlFixture } from './mysql.helpers.mjs';

function environment(values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
}

test('无效PUBLIC_ORIGIN在读取数据库前阻止服务启动', async () => {
  const restore = environment({ PUBLIC_ORIGIN: 'https://lianduoduo.aiapaas.com/not-an-origin' });
  try { await assert.rejects(createLocalServer({ database: new Proxy({}, { get() { throw new Error('不可访问数据库'); } }) }), /PUBLIC_ORIGIN/); }
  finally { restore(); }
});

test('生产HTTPS、开通口令、反代限流真实HTTP/MySQL验证', async t => {
  const fixture = await createMysqlFixture(), origin = 'https://lianduoduo.aiapaas.com', setupToken = 'fixture-production-setup-2026';
  const payload = { account: 'production_policy_admin', password: 'Production-Policy-Fixture-2026!', name: '部署验证管理员', tenantName: '部署验证空间', storeName: '验证一店' };
  let server, base;
  async function start(trustedProxyIPs) {
    const restore = environment({ PUBLIC_ORIGIN: origin, TRUSTED_PROXY_IPS: trustedProxyIPs, SETUP_TOKEN: setupToken });
    try { server = await createLocalServer({ databaseOptions: fixture.options }); }
    finally { restore(); }
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { if (server) { await new Promise(resolve => server.close(resolve)); await server.closeDatabase(); server = null; } }
  t.after(async () => { await stop(); await fixture.dispose(); });
  async function request(path, body, headers = {}) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  await start('127.0.0.1');
  await t.test('公开状态只返回口令需求，缺失/错误口令不可初始化', async () => {
    const metadata = await request('/api/setup'); assert.equal(metadata.status, 200); assert.equal(metadata.data.initialized, false); assert.equal(metadata.data.setupTokenRequired, true); assert.equal(JSON.stringify(metadata.data).includes(setupToken), false);
    for (const headers of [{}, { 'X-Setup-Token': setupToken.slice(0, -1) }]) assert.equal((await request('/api/setup', payload, headers)).status, 403);
    assert.equal((await server.database.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 0);
  });
  await t.test('HTTPS外部origin允许，HTTP内部或其他origin拒绝', async () => {
    const headers = { 'X-Setup-Token': setupToken };
    assert.equal((await request('/api/setup', payload, { ...headers, Origin: base })).status, 403);
    assert.equal((await request('/api/setup', payload, { ...headers, Origin: 'https://evil.example' })).status, 403);
    const created = await request('/api/setup', payload, headers); assert.equal(created.status, 200, JSON.stringify(created.data)); assert.match(created.headers.get('set-cookie'), /; HttpOnly; SameSite=Lax/); assert.match(created.headers.get('set-cookie'), /; Secure(?:;|$)/);
  });
  await t.test('初始化后不再提示口令，带或不带口令均不能再次开通', async () => {
    const metadata = await request('/api/setup'); assert.equal(metadata.data.initialized, true); assert.equal(metadata.data.setupTokenRequired, false);
    assert.equal((await request('/api/setup', {})).status, 409);
    assert.equal((await request('/api/setup', payload, { 'X-Setup-Token': setupToken })).status, 409);
    assert.equal((await server.database.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 1);
  });
  const wrongLogin = { account: payload.account, password: 'Wrong-Login-Fixture-2026!' };
  await t.test('可信代理真实IP分别计数，不让所有用户共用网关限流', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await request('/api/auth/login', wrongLogin, { 'X-Real-IP': '192.0.2.10' })).status, 401);
    assert.equal((await request('/api/auth/login', wrongLogin, { 'X-Real-IP': '192.0.2.10' })).status, 429);
    assert.equal((await request('/api/auth/login', wrongLogin, { 'X-Real-IP': '192.0.2.11' })).status, 401);
  });
  await stop(); await start('192.0.2.250');
  await t.test('非可信socket不能伪造X-Real-IP或XFF绕过同一来源限流', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await request('/api/auth/login', wrongLogin, { 'X-Real-IP': `198.51.100.${i + 1}`, 'X-Forwarded-For': `203.0.113.${i + 1}` })).status, 401);
    assert.equal((await request('/api/auth/login', wrongLogin, { 'X-Real-IP': '198.51.100.99', 'X-Forwarded-For': '203.0.113.99' })).status, 429);
  });
});
