import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../server/app.mjs';
import { createMysqlFixture } from './mysql.helpers.mjs';

test('真实 MySQL：循环排课与开放时段预览、发布、预约、释放、停用和持久化', async t => {
  const fixture = await createMysqlFixture();
  let now = new Date('2026-10-28T02:00:00Z'), server, base;
  const password = 'Schedule-Test-Only-2026!';
  let admin, coachToken, student, otherStudent, tenantId, storeId, coachId, memberId, cardId, otherCardId, recurringPlan, availabilityPlan, slotId, firstBooking, futureBooking;
  async function start() { server = await createLocalServer({ databaseOptions: fixture.options, clock: () => now });await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));base = `http://127.0.0.1:${server.address().port}`; }
  async function stop() { if (!server) return;await new Promise(resolve => server.close(resolve));await server.closeDatabase();server = null; }
  async function request(path, payload, token = admin) {
    const response = await fetch(base + path, { method: payload === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, data: await response.json() };
  }
  async function workspace(token = admin) { const r = await request('/api/workspace', undefined, token);assert.equal(r.status, 200, JSON.stringify(r.data));return r.data; }
  async function action(action, payload, token = admin, expected = 200) { const current = await workspace(token);const r = await request('/api/actions', { action, payload, version: current.version }, token);assert.equal(r.status, expected, JSON.stringify(r.data));return r.data; }
  async function counts() { const result = {};for (const table of ['schedule_plans', 'classes', 'bookings', 'audit', 'ledger']) result[table] = Number((await server.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n);result.version = (await server.database.prepare("SELECT value FROM meta WHERE `key`='version'").get()).value;return result; }
  const fixed = () => ({ mode: 'recurring', name: '每周力量小班', storeId, coachId, type: '力量', startDate: '2026-11-02', endDate: '2026-11-09', weekdays: [1, 3], startTime: '09:00', endTime: '10:00', capacity: 4, credits: 1, price: 12800, room: '循环教室' });
  const availability = () => ({ ...fixed(), mode: 'availability', name: '私教可约时间', startDate: '2026-11-03', endDate: '2026-11-03', weekdays: [2], startTime: '09:00', endTime: '12:00', capacity: 1, durationMinutes: 60, gapMinutes: 15, room: '私教训练区' });
  try {
    await start();
    const setup = await request('/api/setup', { mode: 'organization', name: '排课测试管理员', account: 'schedule_admin', password, tenantName: '排课测试机构', storeName: '测试一店' }, null);assert.equal(setup.status, 200);admin = setup.data.token;
    const initial = await workspace();tenantId = initial.persona.tenantId;storeId = initial.data.stores[0].id;
    let created = await action('coach.invite', { name: '排课教练', phone: '13900005001', storeId, specialty: '力量', certificate: '真实核验的测试资质', certificateExpiresAt: '2027-12-31' });coachId = created.data.coaches[0].id;await action('coach.review', { id: coachId, approved: true });
    for (const [index, account] of ['schedule_student', 'schedule_other'].entries()) {
      created = await action('member.create', { name: `排课学员${index + 1}`, phone: `1390000500${index + 2}`, storeId, coachId });
      const member = created.data.members.find(item => item.name === `排课学员${index + 1}`);
      created = await action('card.issue', { name: '预约课卡', memberId: member.id, storeId, total: 12, amount: 120000, expiresAt: '2027-12-31', scope: 'home', classTypes: ['力量'] });
      const card = created.data.cards.find(item => item.memberId === member.id);
      await action('account.create', { name: member.name, account, password, role: 'student', storeId, memberId: member.id });
      const login = await request('/api/auth/login', { account, password }, null);assert.equal(login.status, 200);
      if (!index) { student = login.data.token;memberId = member.id;cardId = card.id; } else { otherStudent = login.data.token;otherCardId = card.id; }
    }
    await action('account.create', { name: '排课教练', account: 'schedule_coach', password, role: 'coach', storeId, coachId });
    coachToken = (await request('/api/auth/login', { account: 'schedule_coach', password }, null)).data.token;

    await t.test('schema4升级，预览只读；匿名、学员及伪造身份不能预览发布', async () => {
      assert.ok((await server.database.prepare('SELECT version FROM schema_migrations WHERE version=4').get()));
      const before = await counts(), preview = await request('/api/schedules/preview', { payload: fixed() });
      assert.equal(preview.status, 200, JSON.stringify(preview.data));assert.equal(preview.data.occurrenceCount, 3);assert.equal(preview.data.slotCount, 3);assert.deepEqual(preview.data.items.map(item => item.date), ['2026-11-02', '2026-11-04', '2026-11-09']);assert.deepEqual(preview.data.conflicts, []);assert.deepEqual(await counts(), before);
      assert.equal((await request('/api/schedules/preview', { payload: fixed() }, null)).status, 401);
      assert.equal((await request('/api/schedules/preview', { payload: fixed() }, student)).status, 403);
      assert.equal((await request('/api/schedules/preview', { payload: fixed(), persona: 'hq' }, student)).status, 400);
      await action('schedule.publish', fixed(), student, 403);
    });

    await t.test('循环规则发布为真实课次并持久化独立计划，不批量创建预约', async () => {
      const before = await counts();const published = await action('schedule.publish', fixed());
      recurringPlan = published.data.schedulePlans.find(item => item.mode === 'recurring');assert.ok(recurringPlan);assert.equal(recurringPlan.tenantId, tenantId);assert.equal(recurringPlan.status, 'active');
      const classes = published.data.classes.filter(item => item.schedulePlanId === recurringPlan.id);assert.equal(classes.length, 3);assert.ok(classes.every(item => item.bookingMode === 'recurring' && item.capacity === 4));
      const after = await counts();assert.equal(after.schedule_plans, before.schedule_plans + 1);assert.equal(after.classes, before.classes + 3);assert.equal(after.bookings, before.bookings);
    });

    await t.test('冲突可预览，发布整批拒绝；资质、scope或错误区间同样不写入', async () => {
      const before = await counts();const preview = await request('/api/schedules/preview', { payload: fixed() });assert.equal(preview.status, 200);assert.equal(preview.data.conflicts.length, 3);
      await action('schedule.publish', fixed(), admin, 409);assert.deepEqual(await counts(), before);
      const otherStore = (await action('store.create', { name: '测试二店', address: '第二训练区', manager: '测试店长', phone: '13900005009' })).data.stores.find(item => item.id !== storeId).id;
      await action('schedule.publish', { ...availability(), storeId: otherStore }, coachToken, 403);
      await action('schedule.publish', { ...availability(), endTime: '08:00' }, admin, 400);
      const row = await server.database.prepare('SELECT data FROM coaches WHERE id=?').get(coachId);await server.database.prepare('UPDATE coaches SET data=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.data), certificateExpiresAt: '2026-11-01' }), coachId);
      try { assert.equal((await request('/api/schedules/preview', { payload: availability() })).status, 400); } finally { await server.database.prepare('UPDATE coaches SET data=? WHERE id=?').run(row.data, coachId); }
    });

    await t.test('教练自己开放空闲区间，60分钟课加15分钟间隔生成两个容量1时段', async () => {
      const preview = await request('/api/schedules/preview', { payload: availability() }, coachToken);assert.equal(preview.status, 200, JSON.stringify(preview.data));assert.equal(preview.data.occurrenceCount, 1);assert.equal(preview.data.slotCount, 2);
      const result = await action('schedule.publish', availability(), coachToken);availabilityPlan = result.data.schedulePlans.find(item => item.mode === 'availability');assert.ok(availabilityPlan);
      const slots = result.data.classes.filter(item => item.schedulePlanId === availabilityPlan.id).sort((a,b) => Date.parse(a.startAt) - Date.parse(b.startAt));assert.equal(slots.length, 2);assert.ok(slots.every(item => item.capacity === 1));assert.equal(Date.parse(slots[1].startAt) - Date.parse(slots[0].endAt), 15 * 60000);slotId = slots[0].id;
      const learner = await workspace(student);assert.equal(learner.data.classes.find(item => item.id === slotId).bookingMode, 'availability');assert.equal(learner.data.bookings.length, 0);assert.ok(learner.data.schedulePlans.every(item => item.tenantId === tenantId));
    });

    await t.test('同一可约时段并发只能一位学员预约，另一课卡不冻结；取消后可再次预约', async () => {
      const version = (await workspace()).version;
      const result = await Promise.all([request('/api/actions', { action: 'booking.create', payload: { classId: slotId, cardId }, version }, student), request('/api/actions', { action: 'booking.create', payload: { classId: slotId, cardId: otherCardId }, version }, otherStudent)]);
      assert.deepEqual(result.map(item => item.status).sort(), [200, 409]);
      const winnerIndex = result.findIndex(item => item.status === 200), winnerToken = winnerIndex === 0 ? student : otherStudent, winningCard = winnerIndex === 0 ? cardId : otherCardId, loserToken = winnerIndex === 0 ? otherStudent : student, losingCard = winnerIndex === 0 ? otherCardId : cardId;
      const learner = await workspace(winnerToken);const booking = learner.data.bookings.find(item => item.classId === slotId && item.status === 'reserved');assert.ok(booking);assert.equal(learner.data.cards.find(item => item.id === winningCard).frozen, 1);
      await action('booking.create', { classId: slotId, cardId: losingCard }, loserToken, 400);assert.equal((await workspace(loserToken)).data.cards.find(item => item.id === losingCard).frozen, 0);
      await action('booking.cancel', { id: booking.id }, winnerToken);assert.equal((await workspace(winnerToken)).data.cards.find(item => item.id === winningCard).frozen, 0);
      await action('booking.create', { classId: slotId, cardId: losingCard }, loserToken);assert.equal((await workspace(loserToken)).data.cards.find(item => item.id === losingCard).frozen, 1);
    });

    await t.test('后置MySQL触发器故障回滚整批计划、课次、审计和业务版本', async () => {
      const payload = { ...fixed(), name: '整批回滚计划', startDate: '2026-11-16', endDate: '2026-11-17', weekdays: [1, 2], room: '回滚训练区' }, before = await counts();
      await server.database.exec("CREATE TRIGGER fail_schedule_batch BEFORE INSERT ON classes FOR EACH ROW BEGIN IF NEW.data LIKE '%2026-11-17%' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional schedule batch rollback'; END IF; END");
      try { await action('schedule.publish', payload, admin, 500);assert.deepEqual(await counts(), before); } finally { await server.database.exec('DROP TRIGGER fail_schedule_batch'); }
    });

    await t.test('服务重启后规则、时段和已冻结预约保持一致', async () => {
      const before = await counts();await stop();await start();assert.deepEqual(await counts(), { ...before, version: String(Number(before.version) + 1) });
      // First upgraded startup links legacy room names; a second startup is idempotent.
      const upgraded = await counts();assert.ok((await workspace()).data.venues.length > 0);await stop();await start();assert.deepEqual(await counts(), upgraded);const data = (await workspace()).data;
      assert.ok(data.schedulePlans.find(item => item.id === recurringPlan.id));assert.ok(data.schedulePlans.find(item => item.id === availabilityPlan.id));assert.equal(data.bookings.filter(item => item.classId === slotId && item.status === 'reserved').length, 1);
    });

    await t.test('循环课仍可正常签到消课，停用计划只取消未来课次并释放冻结，历史保留', async () => {
      const classes = (await workspace()).data.classes.filter(item => item.schedulePlanId === recurringPlan.id).sort((a,b) => Date.parse(a.startAt) - Date.parse(b.startAt));
      let result = await action('booking.create', { classId: classes[0].id, cardId, memberId });firstBooking = result.data.bookings.find(item => item.classId === classes[0].id).id;
      result = await action('booking.create', { classId: classes[1].id, cardId, memberId });futureBooking = result.data.bookings.find(item => item.classId === classes[1].id).id;
      now = new Date('2026-11-02T01:30:00Z');await action('booking.checkin', { id: firstBooking }, coachToken);await action('booking.complete', { id: firstBooking }, coachToken);
      const remaining = (await workspace()).data.cards.find(item => item.id === cardId).remaining;
      await action('schedule.cancel', { id: recurringPlan.id, reason: '教练调整未来循环安排' }, coachToken);
      const data = (await workspace()).data;assert.equal(data.schedulePlans.find(item => item.id === recurringPlan.id).status, 'cancelled');assert.equal(data.bookings.find(item => item.id === firstBooking).status, 'completed');assert.equal(data.bookings.find(item => item.id === futureBooking).status, 'cancelled');assert.equal(data.classes.find(item => item.id === classes[0].id).status, 'scheduled');assert.ok(classes.slice(1).every(item => data.classes.find(c => c.id === item.id).status === 'cancelled'));assert.equal(data.cards.find(item => item.id === cardId).remaining, remaining);
      await action('schedule.cancel', { id: availabilityPlan.id, reason: '停止开放私教时间' }, coachToken);
      const final = (await workspace()).data;assert.ok(final.cards.every(card => card.frozen === 0));assert.equal(final.bookings.find(item => item.id === firstBooking).status, 'completed');assert.ok(final.ledger.some(item => item.type === 'release'));
    });
  } finally { await stop();await fixture.dispose(); }
});
