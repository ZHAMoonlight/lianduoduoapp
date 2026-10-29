import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createLocalServer } from '../server/app.mjs';
import { createMysqlFixture } from './mysql.helpers.mjs';

const PHONE = '13900000301';
const PASSWORD = 'Phone-Join-Test-2026!';
const sha = value => createHash('sha256').update(value).digest('hex');

async function phoneFixture(run, { configured = true } = {}) {
  const fixture = await createMysqlFixture();
  let now = new Date('2026-10-28T02:00:00Z');
  const exchanges = [];
  let server;
  try {
    server = await createLocalServer({ databaseOptions: fixture.options, clock: () => now,
      wechatCodeExchange: async code => ({ openid: `phone-join-openid-${code.split(':')[0]}` }),
      ...(configured ? { wechatPhoneExchange: async code => {
        exchanges.push(code);
        if (code === 'phone-upstream-down') throw new Error('synthetic phone outage');
        if (code === 'phone-invalid') return { errcode: 40029, errmsg: 'invalid code' };
        const phone = code.startsWith('no-match') ? '13800009999' : PHONE;
        return { phone_info: { purePhoneNumber: phone, phoneNumber: phone, countryCode: '86', watermark: { appid: 'injected-test-app', timestamp: Math.floor(now.getTime() / 1000) } } };
      } } : {})
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const database = server.database;
    async function request(path, body, token) {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json(), headers: response.headers };
    }
    async function workspace(token) { const result = await request('/api/workspace', undefined, token);assert.equal(result.status, 200, JSON.stringify(result.data));return result.data; }
    async function action(token, action, payload, expected = 200) { const current = await workspace(token);const result = await request('/api/actions', { action, payload, version: current.version }, token);assert.equal(result.status, expected, JSON.stringify(result.data));return result; }
    async function onboarding(principal) { const result = await request('/api/auth/wechat', { code: `${principal}:login-${Math.random()}` });assert.equal(result.status, 200, JSON.stringify(result.data));assert.equal(result.data.needsOnboarding, true);return result.data.onboardingToken; }
    async function claim(code, { onboardingToken, token } = {}) { const result = await request('/api/auth/wechat/phone', { code, ...(onboardingToken ? { onboardingToken } : {}) }, token);assert.equal(result.status, 200, JSON.stringify(result.data));return result.data; }
    async function join(claimToken, coachId, { onboardingToken, token } = {}) { return request('/api/auth/wechat/coach-join', { claimToken, coachId, ...(onboardingToken ? { onboardingToken } : {}) }, token); }
    async function rowCount(table) { return (await database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n; }
    async function snapshot() { const tables = ['users', 'memberships', 'wechat_bindings', 'wechat_coach_links', 'wechat_phone_claims', 'sessions', 'tenants', 'stores', 'coaches', 'audit'];return { ...(Object.fromEntries(await Promise.all(tables.map(async table => [table, await rowCount(table)])))), version: (await database.prepare("SELECT value FROM meta WHERE `key`='version'").get()).value }; }
    async function patch(table, id, changes) { const row = await database.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);assert.ok(row);const original = JSON.parse(row.data);await database.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify({ ...original, ...changes }), id);return () => database.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(row.data, id); }
    await run({ request, workspace, action, onboarding, claim, join, rowCount, snapshot, patch, database, exchanges, advance: milliseconds => { now = new Date(now.getTime() + milliseconds); } });
  } finally {
    if (server) { await new Promise(resolve => server.close(resolve));await server.closeDatabase(); }
    await fixture.dispose();
  }
}

async function organization(context) {
  const { request, workspace, action } = context;
  const setup = await request('/api/setup', { name: '手机号测试管理员', account: 'phone_join_admin', password: PASSWORD, tenantName: '授权测试品牌', storeName: '授权一店' });assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const token = setup.data.token, current = await workspace(token), tenantId = setup.data.activeMembership.tenantId, storeId = current.data.stores[0].id;
  let result = await action(token, 'store.create', { name: '授权二店', address: '二店测试路', manager: '二店负责人', phone: '13900000311' });const store2 = result.data.data.stores.find(store => store.id !== storeId).id;
  result = await action(token, 'store.create', { name: '停用测试店', address: '停用测试路', manager: '三店负责人', phone: '13900000312' });const store3 = result.data.data.stores.find(store => store.id !== storeId && store.id !== store2).id;
  let phoneSequence = 400;
  async function invite(name, { store = storeId, approved = true, phone = PHONE } = {}) {
    const creationPhone = phone === PHONE ? '1390000' + String(++phoneSequence).padStart(4, '0') : phone;
    let result = await action(token, 'coach.invite', { name, phone: creationPhone, storeId: store, specialty: '力量训练', certificate: '已核验教练资质', certificateExpiresAt: '2027-10-28' });
    const coachId = result.data.data.coaches.find(coach => coach.name === name).id;
    if (approved !== null) result = await action(token, 'coach.review', { id: coachId, approved });
    // Simulate historical duplicate-format records only in this disposable fixture.
    if (creationPhone !== phone) await context.patch('coaches', coachId, { phone });
    return coachId;
  }
  const first = await invite('一店目标教练');
  const second = await invite('二店目标教练', { store: store2 });
  const race = await invite('并发领取教练');await context.patch('coaches', race, { phone: '+86 139 0000 0301' });
  const pending = await invite('待审核教练', { approved: null });
  const rejected = await invite('已驳回教练', { approved: false });
  const expired = await invite('资质已过期教练');await context.patch('coaches', expired, { certificateExpiresAt: '2026-10-27' });
  const inactiveStore = await invite('停用门店教练', { store: store3 });await action(token, 'store.update', { id: store3, status: 'inactive' });
  const legacy = await invite('已有账号教练');await action(token, 'account.create', { name: '已有教练账号', account: 'legacy_phone_coach', password: PASSWORD, role: 'coach', storeId, coachId: legacy });
  const unrelated = await invite('其他手机号教练', { phone: '13700000399' });
  result = await action(token, 'member.create', { name: '一店负责学员', phone: '13600000301', storeId, coachId: first });const member = result.data.data.members.find(item => item.coachId === first).id;
  await action(token, 'member.create', { name: '二店其他学员', phone: '13600000302', storeId: store2, coachId: second });
  await action(token, 'card.issue', { memberId: member, storeId, name: '隔离财务课包', total: 5, amount: 10000, expiresAt: '2027-10-28', scope: 'all', classTypes: ['力量训练'] });
  return { token, tenantId, storeId, store2, first, second, race, pending, rejected, expired, inactiveStore, legacy, unrelated, member, hqMembership: setup.data.activeMembership.id };
}

test('手机号授权领取后台教练档案：匹配、身份边界、事务与授权撤销', async t => phoneFixture(async context => {
  const org = await organization(context);
  const { request, workspace, action, onboarding, claim, join, snapshot, patch, database, exchanges } = context;
  const pendingA = await onboarding('claimant-A'), pendingB = await onboarding('claimant-B');
  let grantA, joinedA, solo, soloCoach, soloClaim;

  await t.test('接口只接受有效微信principal和一次性code，不接受账密会话或明文手机号', async () => {
    const setup = await request('/api/setup');assert.equal(setup.data.wechatPhoneConfigured, true);
    assert.equal((await request('/api/auth/wechat/phone', { code: 'anonymous-code' })).status, 401);
    assert.equal((await request('/api/auth/wechat/phone', { code: 'password-code' }, org.token)).status, 403);
    assert.equal((await request('/api/auth/wechat/phone', { code: 'forged-principal-code', onboardingToken: 'forged-ticket' })).status, 401);
    for (const extra of [{ phone: PHONE }, { phoneNumber: PHONE }, { role: 'platform' }]) assert.equal((await request('/api/auth/wechat/phone', { code: `spoof-${Object.keys(extra)[0]}`, onboardingToken: pendingA, ...extra })).status, 403);
    assert.equal(exchanges.length, 0);
    await action(org.token, 'coach.invite', { name: '伪造已绑定标记', phone: PHONE, storeId: org.storeId, specialty: '力量训练', wxLinked: true }, 403);
  });

  await t.test('已核验手机号返回可选与受限候选的最小信息，不提前创建身份或暴露原号码', async () => {
    const before = await snapshot();grantA = await claim('phone-A-first', { onboardingToken: pendingA });
    assert.ok(typeof grantA.claimToken === 'string' && grantA.claimToken.length >= 32);assert.ok(Date.parse(grantA.expiresAt));assert.match(grantA.phoneMasked, /^139\*+0301$/);
    assert.ok(!JSON.stringify(grantA).includes(PHONE));assert.ok(!JSON.stringify(grantA).includes('phone-join-openid'));
    const byId = new Map(grantA.matches.map(item => [item.coachId, item]));
    assert.equal(byId.has(org.unrelated), false);
    for (const id of [org.first, org.second, org.race]) { assert.equal(byId.get(id).canJoin, true);assert.equal(byId.get(id).status, 'approved');assert.equal(byId.get(id).tenantName, '授权测试品牌');assert.ok(byId.get(id).storeName); }
    for (const id of [org.pending, org.rejected, org.expired, org.inactiveStore, org.legacy]) { assert.equal(byId.get(id).canJoin, false);assert.ok(byId.get(id).reason); }
    assert.equal(byId.get(org.pending).status, 'pending');assert.equal(byId.get(org.rejected).status, 'rejected');
    const after = await snapshot();for (const table of ['users', 'tenants', 'stores', 'coaches', 'memberships', 'wechat_bindings', 'wechat_coach_links']) assert.equal(after[table], before[table], table);
    assert.equal(after.wechat_phone_claims, before.wechat_phone_claims + 1);
    const stored = await database.prepare('SELECT * FROM wechat_phone_claims WHERE ticket_hash=?').get(sha(grantA.claimToken));assert.ok(stored);assert.notEqual(stored.phone_hash, PHONE);assert.equal(stored.used_at, null);
  });

  await t.test('取号code全局防重放，不匹配号码没有候选，也不能抢选其他档案', async () => {
    assert.equal((await request('/api/auth/wechat/phone', { code: 'phone-A-first', onboardingToken: pendingB })).status, 409);assert.equal(exchanges.filter(code => code === 'phone-A-first').length, 1);
    const empty = await claim('no-match-B', { onboardingToken: pendingB });assert.deepEqual(empty.matches, []);
    assert.equal((await join(empty.claimToken, org.first, { onboardingToken: pendingB })).status, 403);
    assert.equal((await join(grantA.claimToken, org.unrelated, { onboardingToken: pendingA })).status, 403);
    for (const id of [org.pending, org.rejected, org.expired, org.inactiveStore]) assert.equal((await join(grantA.claimToken, id, { onboardingToken: pendingA })).status, 403);
    assert.equal((await join(grantA.claimToken, org.legacy, { onboardingToken: pendingA })).status, 409);
  });

  await t.test('claim限定微信本人，伪造或夹带身份不能领取他人的候选', async () => {
    assert.equal((await join('forged-claim', org.first, { onboardingToken: pendingA })).status, 400);
    assert.equal((await join(grantA.claimToken, org.first, { onboardingToken: pendingB })).status, 403);
    assert.equal((await request('/api/auth/wechat/coach-join', { claimToken: grantA.claimToken, coachId: org.first, onboardingToken: pendingA, role: 'hq', tenantId: 'forged-tenant' })).status, 403);
  });

  await t.test('关联写入后置失败会回滚用户、微信、会员、审计和claim，原凭证可修正后重试', async () => {
    const before = await snapshot();
    await database.exec("CREATE TRIGGER fail_phone_coach_join BEFORE INSERT ON wechat_coach_links FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional coach join rollback'");
    try { assert.equal((await join(grantA.claimToken, org.first, { onboardingToken: pendingA })).status, 500);assert.deepEqual(await snapshot(), before);assert.equal((await database.prepare('SELECT used_at FROM wechat_phone_claims WHERE ticket_hash=?').get(sha(grantA.claimToken))).used_at, null); }
    finally { await database.exec('DROP TRIGGER fail_phone_coach_join'); }
  });

  await t.test('新微信直接领取既有教练档案，同claim并发与已消费onboarding重试幂等', async () => {
    const before = await snapshot();const concurrent = await Promise.all([join(grantA.claimToken, org.first, { onboardingToken: pendingA }), join(grantA.claimToken, org.first, { onboardingToken: pendingA })]);
    assert.deepEqual(concurrent.map(result => result.status), [200, 200]);joinedA = concurrent[0].data;assert.equal(concurrent[1].data.user.id, joinedA.user.id);assert.equal(joinedA.loginMethod, 'wechat');assert.equal(joinedA.memberships.length, 1);assert.equal(joinedA.activeMembership.role, 'coach');assert.equal(joinedA.activeMembership.coachId, org.first);assert.equal(joinedA.activeMembership.tenantId, org.tenantId);assert.equal(joinedA.activeMembership.storeId, org.storeId);
    const retry = await join(grantA.claimToken, org.first, { onboardingToken: pendingA });assert.equal(retry.status, 200);assert.equal(retry.data.user.id, joinedA.user.id);
    assert.equal((await join(grantA.claimToken, org.second, { onboardingToken: pendingA })).status, 409);
    const after = await snapshot();assert.equal(after.users, before.users + 1);assert.equal(after.memberships, before.memberships + 1);assert.equal(after.wechat_bindings, before.wechat_bindings + 1);assert.equal(after.wechat_coach_links, before.wechat_coach_links + 1);for (const table of ['tenants', 'stores', 'coaches']) assert.equal(after[table], before[table], table);
    assert.equal((await database.prepare('SELECT password_hash FROM users WHERE id=?').get(joinedA.user.id)).password_hash, '!wechat-only');assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id=? AND coach_id=? AND role='coach'").get(joinedA.user.id, org.first)).n, 1);
    assert.match(concurrent[0].headers.get('set-cookie'), /HttpOnly/);
    const admin = await workspace(org.token);assert.equal(admin.data.coaches.find(item => item.id === org.first).wxLinked, true);assert.equal(admin.data.coaches.find(item => item.id === org.second).wxLinked, false);
    assert.equal(JSON.parse((await database.prepare('SELECT data FROM coaches WHERE id=?').get(org.first)).data).wxLinked, undefined);
  });

  await t.test('组织教练只获得本人学员与业务范围，不获得总部和财务授权，也不能被其他微信抢占', async () => {
    const beforeUsers = await context.rowCount('users');
    await action(org.token, 'account.create', { name: '不能另设密码账号', account: 'forged_password_coach', password: PASSWORD, role: 'coach', storeId: org.storeId, coachId: org.first }, 409);
    assert.equal(await context.rowCount('users'), beforeUsers);
    const own = await workspace(joinedA.token);assert.equal(own.persona.role, 'coach');assert.deepEqual(own.data.members.map(item => item.id), [org.member]);for (const table of ['orders', 'ledger', 'accounts']) assert.equal(own.data[table].length, 0, table);
    await action(joinedA.token, 'member.create', { name: '越权学员', phone: '13600000399', storeId: org.storeId }, 403);
    const grantB = await claim('phone-B-after-link', { onboardingToken: pendingB });assert.equal(grantB.matches.find(item => item.coachId === org.first).canJoin, false);assert.equal((await join(grantB.claimToken, org.first, { onboardingToken: pendingB })).status, 409);
    const returning = await request('/api/auth/wechat', { code: 'claimant-A:returning' });assert.equal(returning.status, 200);assert.equal(returning.data.user.id, joinedA.user.id);assert.equal(returning.data.activeMembership.coachId, org.first);
  });

  await t.test('不同微信并发领取同一空档案只成功一位，不合并或抢占用户', async () => {
    const firstTicket = await onboarding('racing-first'), secondTicket = await onboarding('racing-second');
    const firstClaim = await claim('phone-racing-first', { onboardingToken: firstTicket }), secondClaim = await claim('phone-racing-second', { onboardingToken: secondTicket });
    const before = await snapshot();
    const result = await Promise.all([join(firstClaim.claimToken, org.race, { onboardingToken: firstTicket }), join(secondClaim.claimToken, org.race, { onboardingToken: secondTicket })]);
    assert.deepEqual(result.map(item => item.status).sort(), [200, 409]);
    const winner = result.find(item => item.status === 200).data;
    assert.equal(winner.activeMembership.coachId, org.race);assert.equal(winner.memberships.length, 1);
    const after = await snapshot();assert.equal(after.users, before.users + 1);assert.equal(after.memberships, before.memberships + 1);assert.equal(after.wechat_coach_links, before.wechat_coach_links + 1);assert.equal(after.coaches, before.coaches);
    assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM wechat_coach_links WHERE coach_id=?').get(org.race)).n, 1);
  });

  await t.test('已有独立教练追加门店身份，保留原用户、独立空间与本人课务', async () => {
    const ticket = await onboarding('existing-solo');const registered = await request('/api/auth/wechat/register', { onboardingToken: ticket, name: '原独立教练', tenantName: '原独立空间', specialty: '力量训练' });assert.equal(registered.status, 200);solo = registered.data;
    const before = await snapshot();soloClaim = await claim('phone-existing-solo', { token: solo.token });const result = await join(soloClaim.claimToken, org.second, { token: solo.token });assert.equal(result.status, 200, JSON.stringify(result.data));soloCoach = result.data;
    assert.equal(soloCoach.user.id, solo.user.id);assert.equal(soloCoach.loginMethod, 'wechat');assert.equal(soloCoach.activeMembership.role, 'coach');assert.equal(soloCoach.activeMembership.coachId, org.second);assert.equal(soloCoach.activeMembership.storeId, org.store2);assert.equal(soloCoach.memberships.length, 2);assert.ok(soloCoach.memberships.some(item => item.id === solo.activeMembership.id && item.workspaceMode === 'solo'));
    const after = await snapshot();for (const table of ['users', 'tenants', 'stores', 'coaches', 'wechat_bindings']) assert.equal(after[table], before[table], table);assert.equal(after.memberships, before.memberships + 1);
    const switched = await request('/api/auth/context', { membershipId: solo.activeMembership.id }, soloCoach.token);assert.equal(switched.status, 200);const own = await workspace(soloCoach.token);assert.equal(own.persona.tenantId, solo.activeMembership.tenantId);assert.equal(own.data.stores.length, 0);
    const stolen = await join(grantA.claimToken, org.first, { token: soloCoach.token });assert.equal(stolen.status, 403);
  });

  await t.test('无效微信取号code不清除已登录独立空间，也不消费其他正常claim', async () => {
    assert.equal((await join('forged-existing-solo-claim', org.second, { token: soloCoach.token })).status, 400);
    const invalid = await request('/api/auth/wechat/phone', { code: 'phone-invalid' }, soloCoach.token);assert.equal(invalid.status, 400);
    assert.equal((await request('/api/auth/session', undefined, soloCoach.token)).status, 200);
    const failed = await request('/api/auth/wechat/phone', { code: 'phone-upstream-down' }, soloCoach.token);assert.equal(failed.status, 502);assert.equal((await request('/api/auth/session', undefined, soloCoach.token)).status, 200);
  });

  for (const scenario of [
    { name: '手机号已变更', table: 'coaches', id: org.second, changes: { phone: '13900000399' } },
    { name: '审核被撤回', table: 'coaches', id: org.second, changes: { status: 'pending' } },
    { name: '资质已过期', table: 'coaches', id: org.second, changes: { certificateExpiresAt: '2026-10-27' } },
    { name: '归属门店停用', table: 'stores', id: org.store2, changes: { status: 'inactive' } },
    { name: '品牌服务暂停', table: 'tenants', id: org.tenantId, changes: { status: 'paused' } }
  ]) await t.test(`${scenario.name}后重新校验旧claim和旧门店授权，已有solo可回退`, async () => {
    assert.equal((await request('/api/auth/context', { membershipId: soloCoach.activeMembership.id }, soloCoach.token)).status, 200);
    const liveClaim = await claim(`phone-live-${scenario.name}`, { token: soloCoach.token });const undo = await patch(scenario.table, scenario.id, scenario.changes);
    try {
      const oldWorkspace = await request('/api/workspace', undefined, soloCoach.token);
      if (oldWorkspace.status === 200) { assert.equal(oldWorkspace.data.persona.role, 'hq');assert.equal(oldWorkspace.data.persona.tenantId, solo.activeMembership.tenantId);assert.equal(oldWorkspace.data.data.stores.length, 0); }
      else assert.equal(oldWorkspace.status, 403);
      assert.equal((await join(liveClaim.claimToken, org.second, { token: soloCoach.token })).status, 403);
      const returning = await request('/api/auth/wechat', { code: `existing-solo:return-${scenario.name}` });assert.equal(returning.status, 200, JSON.stringify(returning.data));assert.equal(returning.data.user.id, solo.user.id);assert.equal(returning.data.activeMembership.id, solo.activeMembership.id);assert.ok(!returning.data.memberships.some(item => item.role === 'coach' && item.coachId === org.second));
    } finally { await undo(); }
  });

  await t.test('组织专属教练失效后不再持有门店数据访问权，无solo时也不暗建空间', async () => {
    const before = await snapshot();const undo = await patch('coaches', org.first, { status: 'rejected' });
    try { assert.equal((await request('/api/workspace', undefined, joinedA.token)).status, 403);assert.equal((await request('/api/auth/wechat', { code: 'claimant-A:revoked' })).status, 403);const after = await snapshot();for (const table of ['tenants', 'stores', 'coaches', 'users', 'memberships']) assert.equal(after[table], before[table], table); }
    finally { await undo(); }
  });

  await t.test('过期或已用onboarding不能新取号，过期claim不能重试领取', async () => {
    const expiringTicket = await onboarding('expiring-principal');const expiringClaim = await claim('phone-expiring', { onboardingToken: expiringTicket });context.advance(6 * 60000);
    assert.equal((await request('/api/auth/wechat/phone', { code: 'phone-expired-ticket', onboardingToken: expiringTicket })).status, 410);
    assert.equal((await join(expiringClaim.claimToken, org.second, { onboardingToken: expiringTicket })).status, 410);
    assert.equal((await join(grantA.claimToken, org.first, { onboardingToken: pendingA })).status, 410);
  });
}));

test('未配置微信取号时显式返回不可用，不用客户端手机号或假结果降级', async () => phoneFixture(async ({ request, onboarding, exchanges }) => {
  assert.equal((await request('/api/setup')).data.wechatPhoneConfigured, false);const ticket = await onboarding('unconfigured-phone');const result = await request('/api/auth/wechat/phone', { code: 'unconfigured-code', onboardingToken: ticket });assert.equal(result.status, 503);assert.equal(exchanges.length, 0);
}, { configured: false }));


test('关闭取号开关时不创建领取凭证或降级接受明文手机号', async () => {
  const previous = process.env.WECHAT_PHONE_LOGIN_ENABLED;process.env.WECHAT_PHONE_LOGIN_ENABLED = 'false';
  try {
    await phoneFixture(async ({ request, onboarding, exchanges }) => {
      const ticket = await onboarding('disabled-phone-feature');assert.equal((await request('/api/setup')).data.wechatPhoneConfigured, false);
      assert.equal((await request('/api/auth/wechat/phone', { code: 'disabled-feature-code', onboardingToken: ticket })).status, 503);
      assert.equal(exchanges.length, 0);
    });
  } finally { if (previous === undefined) delete process.env.WECHAT_PHONE_LOGIN_ENABLED;else process.env.WECHAT_PHONE_LOGIN_ENABLED = previous; }
});
