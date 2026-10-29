import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../server/app.mjs';
import { createMysqlFixture } from './mysql.helpers.mjs';

test('真实 MySQL：多教练计划、按教练预约与独立名额', async t => {
  const fixture = await createMysqlFixture();
  const now = new Date('2026-10-28T02:00:00Z'), password = 'Multi-Coach-Test-2026!';
  let server, base, admin, storeId, coachA, coachB, coachC, otherCoach, coachAToken, studentA, studentB, memberA, memberB, cardA, cardB, planId, classA, classB, bookingA, bookingB;
  async function start() { server = await createLocalServer({ databaseOptions: fixture.options, clock: () => now });await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));base = `http://127.0.0.1:${server.address().port}`; }
  async function stop() { if (!server) return;await new Promise(resolve => server.close(resolve));await server.closeDatabase();server = null; }
  async function request(path, body, token = admin) { const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });return { status: response.status, data: await response.json() }; }
  async function workspace(token = admin) { const r = await request('/api/workspace', undefined, token);assert.equal(r.status, 200, JSON.stringify(r.data));return r.data; }
  async function action(action, payload, token = admin, expected = 200) { const w = await workspace(token), r = await request('/api/actions', { version: w.version, action, payload }, token);assert.equal(r.status, expected, `${action}: ${JSON.stringify(r.data)}`);return r.data; }
  async function counts() { const result = {};for (const table of ['schedule_plans', 'classes', 'bookings', 'audit', 'ledger']) result[table] = Number((await server.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n);result.version = (await server.database.prepare("SELECT value FROM meta WHERE `key`='version'").get()).value;return result; }
  async function account(name, account, role, extra) { await action('account.create', { name, account, password, role, storeId, ...extra });const r = await request('/api/auth/login', { account, password }, null);assert.equal(r.status, 200);return r.data.token; }
  const payload = () => ({ mode: 'availability', name: '两位教练私教服务', type: '力量', storeId, coachIds: [coachA, coachB], sharedRoom: true, startDate: '2026-11-02', endDate: '2026-11-02', weekdays: [1], startTime: '09:00', endTime: '11:00', durationMinutes: 60, gapMinutes: 0, capacity: 1, credits: 1, price: 12800, room: '允许并行训练区域' });
  try {
    await start();
    const r = await request('/api/setup', { mode: 'organization', name: '多教练测试管理员', account: 'multi_admin', password, tenantName: '多教练测试品牌', storeName: '训练一店' }, null);assert.equal(r.status, 200);admin = r.data.token;storeId = (await workspace()).data.stores[0].id;
    for (const [index, name] of ['教练甲', '教练乙', '教练丙'].entries()) {
      const created = await action('coach.invite', { name, phone: `1390000600${index + 1}`, storeId, specialty: '力量', certificate: '测试核验资质', certificateExpiresAt: '2027-12-31' });const id = created.data.coaches.find(item => item.name === name).id;await action('coach.review', { id, approved: true });if (index === 0) coachA = id;else if (index === 1) coachB = id;else coachC = id;
    }
    let created = await action('store.create', { name: '其他门店', address: '测试二店', manager: '测试负责人', phone: '13900006009' });const store2 = created.data.stores.find(item => item.id !== storeId).id;
    created = await action('coach.invite', { name: '其他门店教练', phone: '13900006008', storeId: store2, specialty: '力量', certificate: '测试核验资质', certificateExpiresAt: '2027-12-31' });otherCoach = created.data.coaches.find(item => item.name === '其他门店教练').id;await action('coach.review', { id: otherCoach, approved: true });
    coachAToken = await account('教练甲', 'multi_coach_a', 'coach', { coachId: coachA });
    for (const [index, name] of ['学员甲', '学员乙'].entries()) {
      created = await action('member.create', { name, phone: `1380000600${index + 1}`, storeId, coachId: coachA });const memberId = created.data.members.find(item => item.name === name).id;
      created = await action('card.issue', { name: '自主选择教练课卡', memberId, storeId, total: 8, amount: 80000, expiresAt: '2027-12-31', scope: 'home', classTypes: ['力量'] });const cardId = created.data.cards.find(item => item.memberId === memberId).id;
      const token = await account(name, `multi_student_${index}`, 'student', { memberId });if (!index) { memberA = memberId;cardA = cardId;studentA = token; } else { memberB = memberId;cardB = cardId;studentB = token; }
    }

    await t.test('预览明确每位教练的实际课次，多教练共享场地须主动确认', async () => {
      const before = await counts();let result = await request('/api/schedules/preview', { payload: payload() });assert.equal(result.status, 200, JSON.stringify(result.data));assert.equal(result.data.coachCount, 2);assert.equal(result.data.timeSlotCount, 2);assert.equal(result.data.slotCount, 4);assert.equal(result.data.occurrenceCount, 1);assert.deepEqual(result.data.items.map(item => item.coachId), [coachA, coachB, coachA, coachB]);assert.ok(result.data.items.every(item => item.coachName && item.room === payload().room));assert.deepEqual(await counts(), before);
      result = await request('/api/schedules/preview', { payload: { ...payload(), sharedRoom: false } });assert.equal(result.status, 400);assert.deepEqual(await counts(), before);
      await action('schedule.publish', { ...payload(), sharedRoom: false }, admin, 400);
      await action('schedule.publish', { ...payload(), coachIds: [coachA, coachA] }, admin, 400);
      await action('schedule.publish', { ...payload(), coachIds: [coachA, otherCoach] }, admin, 403);
      await action('schedule.publish', { ...payload(), coachId: coachB }, admin, 400);
    });

    await t.test('发布一条规则，为两位教练分别生成独立一人时段', async () => {
      const w = await action('schedule.publish', payload());const plan = w.data.schedulePlans.find(item => item.name === payload().name);assert.ok(plan);planId = plan.id;assert.deepEqual(plan.coachIds, [coachA, coachB]);assert.equal(plan.sharedRoom, true);
      const sessions = w.data.classes.filter(item => item.schedulePlanId === planId);assert.equal(sessions.length, 4);assert.ok(sessions.every(item => item.capacity === 1));classA = sessions.find(item => item.coachId === coachA).id;const a = sessions.find(item => item.id === classA);classB = sessions.find(item => item.coachId === coachB && item.startAt === a.startAt).id;assert.ok(classB);
      const learner = await workspace(studentA);assert.ok(learner.data.classes.some(item => item.id === classA));assert.ok(learner.data.classes.some(item => item.id === classB));assert.equal(learner.data.bookings.length, 0);
    });

    await t.test('选教练预约必须绑定对应课次；同一学员不能同一时间重复约两位教练', async () => {
      let result = await action('booking.create', { classId: classA, coachId: coachA, cardId: cardA, memberId: memberA }, studentA);bookingA = result.data.bookings.find(item => item.classId === classA).id;assert.equal(result.data.bookings.find(item => item.id === bookingA).coachId, coachA);
      await action('booking.create', { classId: classB, coachId: coachB, cardId: cardA, memberId: memberA }, studentA, 400);
      await action('booking.create', { classId: classA, coachId: coachB, cardId: cardA, memberId: memberA }, studentA, 400);
      result = await action('booking.create', { classId: classB, coachId: coachB, cardId: cardB, memberId: memberB }, studentB);bookingB = result.data.bookings.find(item => item.classId === classB).id;assert.equal(result.data.bookings.find(item => item.id === bookingB).coachId, coachB);
      const adminView = (await workspace()).data;assert.equal(adminView.cards.find(item => item.id === cardA).frozen, 1);assert.equal(adminView.cards.find(item => item.id === cardB).frozen, 1);assert.equal(adminView.classes.find(item => item.id === classA).bookedCount, 1);assert.equal(adminView.classes.find(item => item.id === classB).bookedCount, 1);
    });

    await t.test('一个教练满额不影响另一位，取消后只释放所选教练时段', async () => {
      await action('booking.cancel', { id: bookingA }, studentA);const data = (await workspace()).data;assert.equal(data.classes.find(item => item.id === classA).bookedCount, 0);assert.equal(data.classes.find(item => item.id === classB).bookedCount, 1);assert.equal(data.cards.find(item => item.id === cardA).frozen, 0);assert.equal(data.cards.find(item => item.id === cardB).frozen, 1);
      await action('booking.create', { classId: classB, coachId: coachB, cardId: cardA }, studentA, 400);
      const result = await action('booking.create', { classId: classA, coachId: coachA, cardId: cardA }, studentA);bookingA = result.data.bookings.find(item => item.classId === classA && item.status === 'reserved').id;
    });

    await t.test('教练只看到本人课次，不能停用多人整计划或越权给同事发布', async () => {
      const w = await workspace(coachAToken);assert.ok(w.data.schedulePlans.some(item => item.id === planId));assert.ok(w.data.classes.every(item => item.coachId === coachA));assert.ok(w.data.bookings.every(item => item.coachId === coachA));const before = await counts();
      await action('schedule.cancel', { id: planId, reason: '不能影响同事' }, coachAToken, 403);await action('schedule.publish', { ...payload(), coachIds: [coachA, coachB] }, coachAToken, 403);assert.deepEqual(await counts(), before);
    });

    await t.test('共享许可仅在同一计划内生效；任何教练校验失败或外部冲突都整批拒绝', async () => {
      const before = await counts();await action('schedule.publish', { ...payload(), coachIds: [coachC] }, admin, 409);assert.deepEqual(await counts(), before);
      const row = await server.database.prepare('SELECT data FROM coaches WHERE id=?').get(coachB);await server.database.prepare('UPDATE coaches SET data=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.data), certificateExpiresAt: '2026-11-01' }), coachB);
      try { await action('schedule.publish', { ...payload(), startDate: '2026-11-03', endDate: '2026-11-03', weekdays: [2], room: '另一训练区' }, admin, 400);assert.deepEqual(await counts(), before); } finally { await server.database.prepare('UPDATE coaches SET data=? WHERE id=?').run(row.data, coachB); }
    });

    await t.test('重启保留教练数组和预约归属；管理员停用后逐一释放各课卡', async () => {
      const before = await counts();await stop();await start();assert.deepEqual(await counts(), { ...before, version: String(Number(before.version) + 1) });
      // First upgraded startup links legacy room names; a second startup is idempotent.
      const upgraded = await counts();assert.ok((await workspace()).data.venues.length > 0);await stop();await start();assert.deepEqual(await counts(), upgraded);let data = (await workspace()).data;assert.deepEqual(data.schedulePlans.find(item => item.id === planId).coachIds, [coachA, coachB]);assert.equal(data.bookings.find(item => item.id === bookingA).coachId, coachA);assert.equal(data.bookings.find(item => item.id === bookingB).coachId, coachB);
      data = (await action('schedule.cancel', { id: planId, reason: '管理员调整多人排课' })).data;assert.ok(data.classes.filter(item => item.schedulePlanId === planId).every(item => item.status === 'cancelled'));assert.ok(data.cards.every(item => item.frozen === 0));assert.equal(data.bookings.find(item => item.id === bookingA).status, 'cancelled');assert.equal(data.bookings.find(item => item.id === bookingB).status, 'cancelled');
    });
  } finally { await stop();await fixture.dispose(); }
});
