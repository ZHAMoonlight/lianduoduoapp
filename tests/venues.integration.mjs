import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../server/app.mjs';
import { createMysqlFixture } from './mysql.helpers.mjs';

async function harness(t) {
  const fixture = await createMysqlFixture(); let server, base, token;
  const clock = () => new Date('2026-10-28T02:00:00Z');
  async function start() { server = await createLocalServer({ databaseOptions: fixture.options, clock }); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; }
  async function stop() { if (server) { await new Promise(r => server.close(r)); await server.closeDatabase(); server = null; } }
  t.after(async () => { await stop(); await fixture.dispose(); }); await start();
  async function request(path, body, auth = token) { const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; }
  async function workspace(auth = token) { const r = await request('/api/workspace', undefined, auth); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
  async function action(action, payload, auth = token, expected = 200) { const w = await workspace(auth), r = await request('/api/actions', { action, payload, version: w.version }, auth); assert.equal(r.status, expected, JSON.stringify(r.data)); return r.data; }
  async function counts() { const result = {}; for (const table of ['venues', 'classes', 'schedule_plans', 'bookings', 'audit', 'ledger']) result[table] = Number((await server.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n); result.version = (await workspace()).version; return result; }
  const password = 'Venue-Test-Only-2026!';
  const setup = await request('/api/setup', { mode: 'organization', name: '场地测试管理员', account: 'venue_admin', password, tenantName: '场地测试机构', storeName: '场地一店' }, null); assert.equal(setup.status, 200); token = setup.data.token;
  const storeId = (await workspace()).data.stores[0].id;
  const coachIds = [];
  for (const [i, name] of ['场地教练甲', '场地教练乙'].entries()) { let w = await action('coach.invite', { name, storeId, phone: `1390000900${i + 1}`, specialty: '力量', certificate: '测试资质', certificateExpiresAt: '2099-12-31' }); const id = w.data.coaches.find(c => c.name === name).id; coachIds.push(id); await action('coach.review', { id, approved: true }); }
  async function account(name, role, extra) { await action('account.create', { name, account: name, password, role, ...extra }); const r = await request('/api/auth/login', { account: name, password }, null); assert.equal(r.status, 200); return r.data.token; }
  const fixed = overrides => ({ mode: 'recurring', name: '场地循环课', type: '力量', storeId, coachIds: [coachIds[0]], sharedRoom: false, startDate: '2026-11-02', endDate: '2026-11-02', weekdays: [1], startTime: '09:00', endTime: '10:00', capacity: 4, credits: 1, price: 12800, ...overrides });
  const single = overrides => ({ name: '场地单次课', type: '力量', storeId, coachId: coachIds[0], startAt: '2026-11-02T09:00:00+08:00', endAt: '2026-11-02T10:00:00+08:00', capacity: 4, credits: 1, price: 12800, ...overrides });
  return { request, workspace, action, counts, fixed, single, account, start, stop, get server() { return server; }, get token() { return token; }, storeId, coachIds };
}

test('真实MySQL：场地管理、稳定占用身份、独占共享、释放和权限', async t => {
  const h = await harness(t); let exclusiveId, sharedId, classId, secondStore, manager, coach, student, memberId, cardId;
  await t.test('schema5持久化场地，规范化名称防重复与范围权限', async () => {
    assert.ok(await h.server.database.prepare('SELECT version FROM schema_migrations WHERE version=5').get());
    let w = await h.action('venue.create', { storeId: h.storeId, name: '  A  教室 ', location: '一楼', allowShared: false }); exclusiveId = w.data.venues[0].id; assert.equal(w.data.venues[0].name, 'A 教室');
    await h.action('venue.create', { storeId: h.storeId, name: 'ａ 教室' }, h.token, 409);
    w = await h.action('venue.create', { storeId: h.storeId, name: '共享训练区', allowShared: true }); sharedId = w.data.venues.find(v => v.allowShared).id;
    w = await h.action('store.create', { name: '场地二店', address: '二店地址', manager: '二店店长', phone: '13900009009' }); secondStore = w.data.stores.find(s => s.id !== h.storeId).id;
    manager = await h.account('venue_manager', 'manager', { storeId: h.storeId }); coach = await h.account('venue_coach', 'coach', { storeId: h.storeId, coachId: h.coachIds[0] });
    await h.action('venue.create', { storeId: secondStore, name: '越权场地' }, manager, 403); await h.action('venue.update', { id: exclusiveId, storeId: secondStore }, h.token, 403); await h.action('venue.create', { storeId: h.storeId, name: '教练越权' }, coach, 403);
    await h.action('venue.create', { storeId: secondStore, name: 'A 教室' }); assert.equal((await h.workspace(manager)).data.venues.length, 2);
    w = await h.action('member.create', { name: '场地学员', phone: '13800009001', storeId: h.storeId, coachId: h.coachIds[0] }); memberId = w.data.members[0].id;
    w = await h.action('card.issue', { name: '场地测试课卡', memberId, storeId: h.storeId, total: 12, amount: 120000, expiresAt: '2099-12-31', scope: 'home', classTypes: ['力量'] }); cardId = w.data.cards[0].id;
    student = await h.account('venue_student', 'student', { storeId: h.storeId, memberId }); assert.deepEqual((await h.workspace(student)).data.venues, []); await h.action('venue.update', { id: exclusiveId, name: '学员越权' }, student, 403);
  });
  await t.test('发布即占场，无预约也拦重叠，接壤不冲突', async () => {
    const before = await h.counts(); let r = await h.request('/api/schedules/preview', { payload: h.fixed({ venueId: exclusiveId }) }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.items[0].venueId, exclusiveId); assert.deepEqual(await h.counts(), before);
    let w = await h.action('class.create', h.single({ venueId: exclusiveId })); classId = w.data.classes[0].id; assert.equal(w.data.classes[0].room, 'A 教室'); assert.equal(w.data.bookings.length, 0);
    r = await h.request('/api/schedules/preview', { payload: h.fixed({ venueId: exclusiveId, coachIds: [h.coachIds[1]] }) }); assert.equal(r.status, 200); assert.equal(r.data.conflicts.length, 1);
    const occupied = await h.counts(); await h.action('schedule.publish', h.fixed({ venueId: exclusiveId, coachIds: [h.coachIds[1]] }), h.token, 409); assert.deepEqual(await h.counts(), occupied);
    await h.action('class.create', h.single({ venueId: exclusiveId, startAt: '2026-11-02T10:00:00+08:00', endAt: '2026-11-02T11:00:00+08:00' }));
    await h.action('venue.update', { id: exclusiveId, status: 'inactive' }, manager, 409);
  });
  await t.test('改名不改历史快照，不绕过同ID场地占用', async () => {
    const w = await h.action('venue.update', { id: exclusiveId, name: '力量训练室', location: '一楼东侧' }); assert.equal(w.data.classes.find(c => c.id === classId).room, 'A 教室'); assert.equal(w.data.classes.find(c => c.id === classId).venueId, exclusiveId);
    await h.action('class.create', h.single({ venueId: exclusiveId, room: '伪造无冲突名称', coachId: h.coachIds[1] }), h.token, 400);
    const r = await h.request('/api/schedules/preview', { payload: h.fixed({ venueId: exclusiveId, coachIds: [h.coachIds[1]] }) }); assert.equal(r.status, 200); assert.equal(r.data.conflicts.length, 1);
    await h.action('class.create', h.single({ venueId: 'not-a-venue', room: '力量训练室', coachId: h.coachIds[1] }), h.token, 404);
  });
  await t.test('共享须场地许可及计划确认，外部计划仍独立防冲突', async () => {
    const p = h.fixed({ venueId: exclusiveId, coachIds: h.coachIds, sharedRoom: true, startDate: '2026-11-03', endDate: '2026-11-03', weekdays: [2] }); await h.action('schedule.publish', p, h.token, 400);
    const shared = { ...p, venueId: sharedId }; await h.action('schedule.publish', { ...shared, sharedRoom: false }, h.token, 400);
    const w = await h.action('schedule.publish', shared); const plan = w.data.schedulePlans.at(-1); assert.equal(w.data.classes.filter(c => c.schedulePlanId === plan.id).length, 2);
    await h.action('venue.update', { id: sharedId, allowShared: false }, h.token, 409);
    await h.action('schedule.publish', { ...shared, coachIds: [h.coachIds[0]] }, h.token, 409);
    await h.action('schedule.cancel', { id: plan.id, reason: '测试释放共享场地' }); await h.action('venue.update', { id: sharedId, allowShared: false }); await h.action('venue.update', { id: sharedId, allowShared: true });
  });
  await t.test('取消预约仅释放学员，取消课次才释放场地', async () => {
    let w = await h.action('booking.create', { classId, cardId, memberId }, student); const booking = w.data.bookings[0]; await h.action('booking.cancel', { id: booking.id }, student);
    await h.action('class.create', h.single({ venueId: exclusiveId, coachId: h.coachIds[1] }), h.token, 400);
    await h.action('class.cancel', { id: classId, reason: '测试取消场地占用' }); w = await h.action('class.create', h.single({ venueId: exclusiveId, coachId: h.coachIds[1] })); assert.ok(w.data.classes.some(c => c.venueId === exclusiveId && c.coachId === h.coachIds[1] && c.status === 'scheduled'));
  });
  await t.test('场地停用、跨店和未建档文字不能绕过正式场地', async () => {
    let w = await h.action('venue.create', { storeId: h.storeId, name: '暂停教室' }); const id = w.data.venues.at(-1).id; await h.action('venue.update', { id, status: 'inactive' });
    await h.action('schedule.publish', h.fixed({ venueId: id }), h.token, 400); await h.action('schedule.publish', h.fixed({ room: '未建档训练区' }), h.token, 400);
    const other = (await h.workspace()).data.venues.find(v => v.storeId === secondStore); await h.action('schedule.publish', h.fixed({ venueId: other.id }), h.token, 403);
  });
  await t.test('并发争用同一场地由事务版本锁保证只成功一个', async () => {
    const w = await h.action('venue.create', { storeId: h.storeId, name: '并发训练区' }), id = w.data.venues.at(-1).id, version = w.version;
    const results = await Promise.all(h.coachIds.map(coachId => h.request('/api/actions', { action: 'class.create', payload: h.single({ venueId: id, coachId, startAt: '2026-11-06T09:00:00+08:00', endAt: '2026-11-06T10:00:00+08:00' }), version })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal((await h.workspace()).data.classes.filter(c => c.venueId === id).length, 1);
  });
  await t.test('重启后场地、绑定、占用、历史快照和版本保持一致', async () => {
    const before = await h.counts(), w = await h.workspace(); await h.stop(); await h.start(); assert.deepEqual(await h.counts(), before); const after = await h.workspace(); assert.deepEqual(after.data.venues, w.data.venues); assert.deepEqual(after.data.classes, w.data.classes);
  });
});

test('真实MySQL：既有文本场地原子回填，保留历史显示、账本审计并幂等重启', async t => {
  const h = await harness(t); let w = await h.action('class.create', h.single({ room: '  旧训练区 ' }));
  await h.action('schedule.publish', h.fixed({ room: '旧训练区', coachIds: h.coachIds, sharedRoom: true, startDate: '2026-11-03', endDate: '2026-11-03', weekdays: [2] }));
  w = await h.workspace(); const originalClasses = w.data.classes, originalPlans = w.data.schedulePlans, beforeVersion = w.version;
  const immutable = {}; for (const table of ['ledger', 'audit']) immutable[table] = await h.server.database.prepare(`SELECT data FROM ${table} ORDER BY seq`).all();
  await h.stop(); await h.start(); let migrated = await h.workspace(); assert.equal(migrated.data.venues.length, 1); const venue = migrated.data.venues[0]; assert.equal(venue.name, '旧训练区'); assert.equal(venue.allowShared, true); assert.equal(migrated.version, beforeVersion + 1);
  for (const cls of migrated.data.classes) assert.deepEqual(cls, { ...originalClasses.find(c => c.id === cls.id), venueId: venue.id });
  for (const plan of migrated.data.schedulePlans) assert.deepEqual(plan, { ...originalPlans.find(p => p.id === plan.id), venueId: venue.id });
  for (const table of ['ledger', 'audit']) assert.deepEqual(await h.server.database.prepare(`SELECT data FROM ${table} ORDER BY seq`).all(), immutable[table]);
  await h.stop(); await h.start(); assert.deepEqual(await h.workspace(), migrated);
});

test('真实MySQL：混合目录回填保留未结束并行安排，已取消历史不重开共享许可', async t => {
  const h = await harness(t);
  const first = h.fixed({ room: '既有训练区', coachIds: h.coachIds, sharedRoom: true });
  await h.action('schedule.publish', first);
  let w = await h.action('schedule.publish', { ...first, room: '历史训练区', startDate: '2026-11-03', endDate: '2026-11-03', weekdays: [2] });
  const stopped = w.data.schedulePlans.at(-1); await h.action('schedule.cancel', { id: stopped.id, reason: '历史已取消计划' }); w = await h.workspace();
  for (const [id, name] of [['existing-venue', '既有训练区'], ['history-venue', '历史训练区']]) {
    const venue = { id, tenantId: w.persona.tenantId, storeId: h.storeId, name, location: '', description: '', allowShared: false, status: 'active', createdAt: '2026-10-28T02:00:00.000Z', updatedAt: '2026-10-28T02:00:00.000Z' };
    await h.server.database.prepare('INSERT INTO venues(id,tenant_id,store_id,data) VALUES(?,?,?,?)').run(id, venue.tenantId, venue.storeId, JSON.stringify(venue));
  }
  const version = w.version; await h.stop(); await h.start(); w = await h.workspace(); assert.equal(w.version, version + 1);
  assert.equal(w.data.venues.find(v => v.id === 'existing-venue').allowShared, true);
  assert.equal(w.data.venues.find(v => v.id === 'history-venue').allowShared, false);
  assert.ok(w.data.classes.every(c => c.venueId === (c.room === '既有训练区' ? 'existing-venue' : 'history-venue')));
  await h.stop(); await h.start(); assert.deepEqual(await h.workspace(), w);
});
