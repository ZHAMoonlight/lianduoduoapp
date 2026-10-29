import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLocalServer } from '../server/app.mjs';
import { createMySQLDatabase } from '../server/database.mjs';
import { generateTeamCode, TEAM_MATCH_ERROR, teamCodeHash } from '../server/team-codes.mjs';
import { createMysqlFixture } from './mysql.helpers.mjs';

const PHONE = '13900000901', PASSWORD = 'Team-Code-Fixture-2026!';
const sha = value => createHash('sha256').update(value).digest('hex');

test('六位团队码使用均匀整数源且保留前导零', () => {
  assert.equal(generateTeamCode((min, max) => { assert.equal(min, 0);assert.equal(max, 1000000);return 7; }), '000007');
  assert.equal(generateTeamCode(() => 999999), '999999');
});

test('真实MySQL团队码：门店授权、微信身份、重置、事务、防接管和持久限流', async t => {
  const fixture = await createMysqlFixture();let server, base, now = new Date('2026-10-29T02:00:00Z'), sequence = 0, queued = [], phoneExchanges = 0;
  const previousPhoneEnabled = process.env.WECHAT_PHONE_LOGIN_ENABLED;process.env.WECHAT_PHONE_LOGIN_ENABLED = 'false';
  async function start() {
    server = await createLocalServer({ databaseOptions: fixture.options, clock: () => now,
      wechatCodeExchange: async code => ({ openid: `team-openid-${code.split(':')[0]}` }),
      wechatPhoneExchange: async () => { phoneExchanges++;throw new Error('Team matching must not request a verified phone'); },
      teamCodeGenerator: () => queued.shift() ?? String(++sequence).padStart(6, '0'),
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { if (server) { await new Promise(resolve => server.close(resolve));await server.closeDatabase();server = null; } }
  t.after(async () => { await stop();await fixture.dispose();if (previousPhoneEnabled === undefined) delete process.env.WECHAT_PHONE_LOGIN_ENABLED;else process.env.WECHAT_PHONE_LOGIN_ENABLED = previousPhoneEnabled; });
  await start();
  async function request(path, body, token) { const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });return { status: response.status, data: await response.json() }; }
  async function workspace(token) { const result = await request('/api/workspace', undefined, token);assert.equal(result.status, 200, JSON.stringify(result.data));return result.data; }
  async function action(token, name, payload) { const w = await workspace(token), result = await request('/api/actions', { action: name, payload, version: w.version }, token);assert.equal(result.status, 200, JSON.stringify(result.data));return result.data; }
  async function onboarding(principal) { const result = await request('/api/auth/wechat', { code: `${principal}:${crypto.randomUUID()}` });assert.equal(result.status, 200, JSON.stringify(result.data));assert.equal(result.data.needsOnboarding, true);return result.data.onboardingToken; }
  async function match(ticket, teamCode, extra = {}, token) { return request('/api/auth/wechat/team-match', { phone: PHONE, teamCode, ...(ticket ? { onboardingToken: ticket } : {}), ...extra }, token); }
  async function grant(principal, teamCode, token) { const ticket = token ? undefined : await onboarding(principal), result = await match(ticket, teamCode, {}, token);assert.equal(result.status, 200, JSON.stringify(result.data));return { ...result.data, ticket }; }
  async function join(grant, coachId, token) { return request('/api/auth/wechat/coach-join', { claimToken: grant.claimToken, coachId, ...(grant.ticket ? { onboardingToken: grant.ticket } : {}) }, token); }
  async function reset(storeId, token) { const result = await request('/api/store-team-code', { storeId }, token);assert.equal(result.status, 200, JSON.stringify(result.data));return result.data; }
  async function patch(table, id, changes) { const row = await server.database.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id), original = row.data;await server.database.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify({ ...JSON.parse(original), ...changes }), id);return () => server.database.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(original, id); }
  async function account(owner, account, role, extra) { await action(owner, 'account.create', { account, name: account, password: PASSWORD, role, ...extra });const result = await request('/api/auth/login', { account, password: PASSWORD });assert.equal(result.status, 200);return result.data; }
  async function snapshot() { const result = {};for (const table of ['users', 'memberships', 'wechat_bindings', 'wechat_coach_links', 'audit']) result[table] = (await server.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n;result.version = (await server.database.prepare("SELECT value FROM meta WHERE `key`='version'").get()).value;return result; }
  const setup = await request('/api/setup', { account: 'team_owner', name: '团队码管理员', password: PASSWORD, tenantName: '团队测试品牌', storeName: '团队一店' });assert.equal(setup.status, 200);
  const owner = setup.data, token = owner.token;let w = await workspace(token);const storeId = w.data.stores[0].id, tenantId = owner.activeMembership.tenantId;
  w = await action(token, 'store.create', { name: '团队二店', address: '二店地址', manager: '店长', phone: '13900000909' });const store2 = w.data.stores.find(store => store.id !== storeId).id;
  async function coach(name, store = storeId, phone = PHONE, approved = true) { const creationPhone = `1380000${String(++sequence).padStart(4, '0')}`;let result = await action(token, 'coach.invite', { storeId: store, name, phone: creationPhone, specialty: '力量', certificate: '测试资质', certificateExpiresAt: '2099-12-31' });const id = result.data.coaches.find(item => item.name === name).id;if (approved) await action(token, 'coach.review', { id, approved: true });await patch('coaches', id, { phone });return id; }
  const first = await coach('目标教练'), second = await coach('二店同号教练', store2), race = await coach('并发教练'), pending = await coach('待审核教练', storeId, PHONE, false), existing = await coach('已开账号教练'), unrelated = await coach('不同号码教练', storeId, '13900000999');
  const manager = await account(token, 'team_manager', 'manager', { storeId });
  const legacy = await account(token, 'team_existing', 'coach', { storeId, coachId: existing });
  w = await action(token, 'member.create', { storeId, name: '测试学员', phone: '13600000901' });const memberId = w.data.members[0].id;
  const student = await account(token, 'team_student', 'student', { storeId, memberId });
  let code1, code2, joined;

  await t.test('管理接口仅本品牌hq和本店manager，其他角色及solo不能读写', async () => {
    assert.equal((await request(`/api/store-team-code?storeId=${storeId}`)).status, 401);
    assert.equal((await request(`/api/store-team-code?storeId=${store2}`, undefined, manager.token)).status, 403);
    for (const auth of [legacy.token, student.token]) for (const body of [undefined, { storeId }]) assert.equal((await request(body ? '/api/store-team-code' : `/api/store-team-code?storeId=${storeId}`, body, auth)).status, 403);
    const platform = owner.memberships.find(item => item.role === 'platform');await request('/api/auth/context', { membershipId: platform.id }, token);
    assert.equal((await request(`/api/store-team-code?storeId=${storeId}`, undefined, token)).status, 403);await request('/api/auth/context', { membershipId: owner.activeMembership.id }, token);
    const ticket = await onboarding('solo-admin'), solo = await request('/api/auth/wechat/register', { onboardingToken: ticket, name: '独立教练' });assert.equal(solo.status, 200);
    assert.equal((await request('/api/store-team-code', { storeId }, solo.data.token)).status, 403);
    for (const path of [`/api/store-team-code?storeId=${storeId}&teamCode=000001`, `/api/store-team-code?storeId=${storeId}&storeId=${store2}`]) assert.equal((await request(path, undefined, token)).status, 403);
    assert.equal((await request('/api/store-team-code', { storeId, teamCode: '123456' }, token)).status, 403);
    assert.equal((await request('/api/store-team-code', { storeId: 'foreign-store' }, token)).status, 403);
  });

  await t.test('首次状态只读，生成保留前导零、仅存hash、轮换审计和全局码唯一', async () => {
    const before = await workspace(token), status = await request(`/api/store-team-code?storeId=${storeId}`, undefined, token);
    assert.deepEqual(status.data, { storeId, status: 'not_generated', expiresAt: null });assert.equal((await workspace(token)).version, before.version);
    queued = ['000007'];code1 = await reset(storeId, manager.token);assert.equal(code1.teamCode, '000007');assert.equal(Date.parse(code1.expiresAt) - now.getTime(), 7 * 86400000);
    queued = [code1.teamCode, '000008'];code2 = await reset(store2, token);assert.equal(code2.teamCode, '000008');
    const stored = await server.database.prepare('SELECT * FROM store_team_codes WHERE store_id=?').get(storeId);assert.equal(stored.code_hash, teamCodeHash(code1.teamCode));assert.notEqual(stored.code_hash, code1.teamCode);
    const after = await workspace(token);assert.equal(after.version, before.version + 2);const audit = after.data.audit.filter(item => item.action === 'store.team-code.reset');assert.equal(audit.length, 2);assert.ok(audit.every(item => !/000007|000008|code_hash|13900000901/.test(JSON.stringify(item))));assert.equal(Object.hasOwn(after.data, 'storeTeamCodes'), false);
    const read = await request(`/api/store-team-code?storeId=${storeId}`, undefined, token);assert.deepEqual(read.data, { storeId, status: 'active', expiresAt: code1.expiresAt });assert.equal(Object.hasOwn(read.data, 'teamCode'), false);
  });

  await t.test('微信principal先验证，错误输入统一拒绝且不能伪造组织或教练', async () => {
    assert.equal((await match(null, code1.teamCode)).status, 401);assert.equal((await match(null, code1.teamCode, {}, token)).status, 403);
    assert.equal((await match('forged-ticket', code1.teamCode)).status, 401);
    const ticket = await onboarding('bad-inputs');
    for (const extra of [{ coachId: first }, { tenantId }, { storeId }, { phoneNumber: PHONE }]) assert.equal((await match(ticket, code1.teamCode, extra)).status, 403);
    for (const [phone, code] of [['13900000000', code1.teamCode], [PHONE, '987654'], ['invalid', code1.teamCode], [PHONE, 7]]) { const result = await match(ticket, code, { phone });assert.equal(result.status, 400);assert.equal(result.data.error, TEAM_MATCH_ERROR); }
    assert.equal(phoneExchanges, 0);
  });

  await t.test('输入手机号与门店码匹配后只返回该店脱敏候选，team证明独立于微信取号', async () => {
    const before = await snapshot(), grantA = await grant('scoped-candidates', code1.teamCode);assert.match(grantA.phoneMasked, /^139\*+0901$/);assert.ok(!JSON.stringify(grantA).includes(PHONE));assert.ok(grantA.matches.every(item => item.storeName === '团队一店' && item.coachName.includes('*')));
    assert.deepEqual(new Set(grantA.matches.map(item => item.coachId)), new Set([first, race, pending, existing]));assert.ok(!grantA.matches.some(item => [second, unrelated].includes(item.coachId)));assert.equal(grantA.matches.find(item => item.coachId === pending).canJoin, false);assert.equal(grantA.matches.find(item => item.coachId === existing).canJoin, false);
    const row = await server.database.prepare('SELECT * FROM wechat_phone_claims WHERE ticket_hash=?').get(sha(grantA.claimToken));assert.equal(row.proof_method, 'team_code');assert.equal(row.team_store_id, storeId);assert.equal(row.team_tenant_id, tenantId);assert.ok(row.team_generation);assert.notEqual(row.phone_hash, PHONE);assert.deepEqual(await snapshot(), before);
    assert.equal((await join(grantA, second)).status, 403);assert.equal((await join(grantA, unrelated)).status, 403);assert.equal((await join(grantA, pending)).status, 403);assert.equal((await join(grantA, existing)).status, 409);
    const other = await onboarding('wrong-principal');assert.equal((await join({ ...grantA, ticket: other }, first)).status, 403);assert.equal(phoneExchanges, 0);
  });

  await t.test('重置立即作废原码和未用claim，不能偶然重新生成原码', async () => {
    const waiting = await grant('waiting-for-reset', code1.teamCode), old = code1.teamCode;
    queued = [old, code2.teamCode, '000009'];code1 = await reset(storeId, token);assert.equal(code1.teamCode, '000009');assert.equal((await join(waiting, first)).status, 410);
    const ticket = await onboarding('old-code-after-reset'), result = await match(ticket, old);assert.equal(result.status, 400);assert.equal(result.data.error, TEAM_MATCH_ERROR);
  });

  await t.test('团队码轮换与审计版本同一事务，审计失败保留原code与generation', async () => {
    const before = await snapshot(), row = await server.database.prepare('SELECT * FROM store_team_codes WHERE store_id=?').get(storeId);
    await server.database.exec("CREATE TRIGGER fail_team_reset_audit BEFORE INSERT ON audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional team reset rollback'");
    try { assert.equal((await request('/api/store-team-code', { storeId }, token)).status, 500);assert.deepEqual(await server.database.prepare('SELECT * FROM store_team_codes WHERE store_id=?').get(storeId), row);assert.deepEqual(await snapshot(), before); }
    finally { await server.database.exec('DROP TRIGGER fail_team_reset_audit'); }
    const claimant = await grant('original-code-after-rollback', code1.teamCode);assert.ok(claimant.matches.some(item => item.coachId === first));
  });

  await t.test('后置失败整笔回滚，同claim并发成功幂等，不生成验证手机号标识', async () => {
    const claimant = await grant('successful-main', code1.teamCode), before = await snapshot();
    await server.database.exec("CREATE TRIGGER fail_team_join BEFORE INSERT ON wechat_coach_links FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional team join rollback'");
    try { assert.equal((await join(claimant, first)).status, 500);assert.deepEqual(await snapshot(), before);assert.equal((await server.database.prepare('SELECT used_at FROM wechat_phone_claims WHERE ticket_hash=?').get(sha(claimant.claimToken))).used_at, null); }
    finally { await server.database.exec('DROP TRIGGER fail_team_join'); }
    const both = await Promise.all([join(claimant, first), join(claimant, first)]);assert.deepEqual(both.map(item => item.status), [200, 200]);joined = both[0].data;assert.equal(both[1].data.user.id, joined.user.id);assert.equal(joined.activeMembership.coachId, first);assert.equal(joined.activeMembership.storeId, storeId);assert.equal(joined.loginMethod, 'wechat');
    const after = await snapshot();assert.equal(after.users, before.users + 1);assert.equal(after.memberships, before.memberships + 1);assert.equal(after.wechat_coach_links, before.wechat_coach_links + 1);const link = await server.database.prepare('SELECT * FROM wechat_coach_links WHERE coach_id=?').get(first);assert.equal(link.join_method, 'team_code');assert.equal(Object.hasOwn(link, 'phone_verified'), false);
    const audit = (await workspace(token)).data.audit.find(item => item.actorId === joined.user.id && item.action === 'wechat.coach-join');assert.match(audit.detail, /用户填写/);assert.doesNotMatch(audit.detail, /验证手机号/);
    code1 = await reset(storeId, token);assert.equal((await join(claimant, first)).status, 200);assert.equal((await request('/api/workspace', undefined, joined.token)).status, 200);
  });

  await t.test('不同微信并发领取只有一方成功，已有账号与其他scope不可被接管', async () => {
    const a = await grant('race-one', code1.teamCode), b = await grant('race-two', code1.teamCode), before = await snapshot();
    const results = await Promise.all([join(a, race), join(b, race)]);assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);assert.equal((await snapshot()).users, before.users + 1);
    const forged = await grant('cannot-take-main', code1.teamCode);assert.equal(forged.matches.find(item => item.coachId === first).canJoin, false);assert.equal((await join(forged, first)).status, 409);
    const secondGrant = await grant('second-store-only', code2.teamCode);assert.deepEqual(secondGrant.matches.map(item => item.coachId), [second]);assert.equal((await join(secondGrant, first)).status, 403);
  });

  await t.test('旧claim与已关联教练动态复核手机号、审核资质和门店状态', async () => {
    now = new Date(now.getTime() + 16 * 60000);
    for (const [table, id, changes] of [['coaches', first, { phone: '13900000992' }], ['coaches', first, { status: 'pending' }], ['coaches', first, { certificateExpiresAt: '2026-10-28' }], ['stores', storeId, { status: 'inactive' }]]) {
      const claimant = await grant(`dynamic-${id}-${Object.keys(changes)[0]}`, code1.teamCode, joined.token), undo = await patch(table, id, changes);
      try { assert.equal((await join(claimant, first, joined.token)).status, 403);assert.equal((await request('/api/workspace', undefined, joined.token)).status, 403); }
      finally { await undo(); }
    }
    assert.equal((await request('/api/workspace', undefined, joined.token)).status, 200);
  });

  await t.test('团队码到期仅阻止新加入，不撤销此前成功的微信门店身份', async () => {
    const expiring = await grant('expiring-claim', code2.teamCode);now = new Date(now.getTime() + 8 * 86400000);
    assert.equal((await request(`/api/store-team-code?storeId=${storeId}`, undefined, (await request('/api/auth/login', { account: 'team_owner', password: PASSWORD })).data.token)).data.status, 'expired');
    const ticket = await onboarding('after-expiry'), failed = await match(ticket, code2.teamCode);assert.equal(failed.status, 400);assert.equal(failed.data.error, TEAM_MATCH_ERROR);assert.equal((await join(expiring, second)).status, 410);
    const returning = await request('/api/auth/wechat', { code: `successful-main:${crypto.randomUUID()}` });assert.equal(returning.status, 200);assert.equal(returning.data.activeMembership.coachId, first);assert.equal(returning.data.user.id, joined.user.id);
  });

  await t.test('失败计数独立提交且重启不丢失，principal与IP均限流', async () => {
    const newOwner = await request('/api/auth/login', { account: 'team_owner', password: PASSWORD });code1 = await reset(storeId, newOwner.data.token);now = new Date(now.getTime() + 16 * 60000);
    const ticket = await onboarding('persistent-rate');for (let n = 0; n < 10; n++) assert.equal((await match(ticket, '999999')).status, 400);
    assert.equal((await server.database.prepare('SELECT MAX(attempts) AS n FROM wechat_team_attempts').get()).n, 10);
    const before = await snapshot();await stop();await start();assert.deepEqual(await snapshot(), before);assert.equal((await match(ticket, code1.teamCode)).status, 429);
    now = new Date(now.getTime() + 16 * 60000);
    for (let n = 0; n < 30; n++) { const other = await onboarding(`ip-rate-${n}`);assert.equal((await match(other, '999999')).status, 400); }
    const last = await onboarding('ip-rate-last');assert.equal((await match(last, code1.teamCode)).status, 429);assert.equal(phoneExchanges, 0);
  });
});

test('schema7从旧手机号schema升级幂等，既有claim/link保持微信取号来源，不生成业务码', async t => {
  const fixture = await createMysqlFixture();let db;
  t.after(async () => { if (db) await db.close();await fixture.dispose(); });
  db = await createMySQLDatabase(fixture.options);
  const stamp = '2026-10-29T02:00:00.000Z';
  await db.prepare('INSERT INTO tenants(id,data) VALUES(?,?)').run('old-tenant', JSON.stringify({ id: 'old-tenant' }));
  await db.prepare('INSERT INTO coaches(id,tenant_id,data) VALUES(?,?,?)').run('old-coach', 'old-tenant', JSON.stringify({ id: 'old-coach', tenantId: 'old-tenant' }));
  await db.prepare('INSERT INTO users(id,account,name,password_hash,status,created_at) VALUES(?,?,?,?,?,?)').run('old-user', 'old-team-migration-user', '原微信教练', '!wechat-only', 'active', stamp);
  await db.prepare('INSERT INTO wechat_coach_links(coach_id,user_id,phone_hash,created_at) VALUES(?,?,?,?)').run('old-coach', 'old-user', sha('old-verified-phone'), stamp);
  await db.prepare('INSERT INTO wechat_phone_claims(ticket_hash,openid_hash,phone_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(sha('old-claim'), sha('old-openid'), sha('old-phone'), stamp, '2099-01-01T00:00:00.000Z');
  const before = await db.prepare('SELECT ticket_hash,openid_hash,phone_hash,created_at,expires_at FROM wechat_phone_claims').all();
  const oldLinks = await db.prepare('SELECT coach_id,user_id,phone_hash,created_at FROM wechat_coach_links').all();
  for (const column of ['proof_method', 'team_store_id', 'team_tenant_id', 'team_generation']) await db.exec(`ALTER TABLE wechat_phone_claims DROP COLUMN ${column}`);
  await db.exec('ALTER TABLE wechat_coach_links DROP COLUMN join_method');await db.exec('DROP TABLE store_team_codes');await db.exec('DROP TABLE wechat_team_attempts');await db.prepare('DELETE FROM schema_migrations WHERE version=7').run();
  await db.close();db = await createMySQLDatabase(fixture.options);assert.deepEqual(await db.prepare('SELECT ticket_hash,openid_hash,phone_hash,created_at,expires_at FROM wechat_phone_claims').all(), before);
  const upgraded = await db.prepare('SELECT proof_method,team_store_id,team_tenant_id,team_generation FROM wechat_phone_claims').get();assert.deepEqual(upgraded, { proof_method: 'wechat_phone', team_store_id: null, team_tenant_id: null, team_generation: null });
  assert.deepEqual(await db.prepare('SELECT coach_id,user_id,phone_hash,created_at FROM wechat_coach_links').all(), oldLinks);assert.equal((await db.prepare('SELECT join_method FROM wechat_coach_links').get()).join_method, 'wechat_phone');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM store_team_codes').get()).n, 0);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM wechat_team_attempts').get()).n, 0);
  // Simulate interruption after DDL was committed but before the migration marker.
  await db.prepare('DELETE FROM schema_migrations WHERE version=7').run();
  await db.close();db = await createMySQLDatabase(fixture.options);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=7').get()).n, 1);assert.deepEqual(await db.prepare('SELECT ticket_hash,openid_hash,phone_hash,created_at,expires_at FROM wechat_phone_claims').all(), before);assert.equal((await db.prepare("SELECT value FROM meta WHERE `key`='version'").get()).value, '0');
});
