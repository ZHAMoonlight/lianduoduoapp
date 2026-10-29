import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../server/app.mjs';
import { createMysqlFixture } from './mysql.helpers.mjs';

async function harness(t, mode = 'organization') {
  const fixture = await createMysqlFixture();
  let server, base, token, now = new Date('2026-10-28T01:00:00Z');
  const password = 'Coach-Billing-Test-Only-2026!';
  async function start() { server = await createLocalServer({ databaseOptions: fixture.options, clock: () => now }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; }
  async function stop() { if (server) { await new Promise(resolve => server.close(resolve)); await server.closeDatabase(); server = null; } }
  t.after(async () => { await stop(); await fixture.dispose(); });
  await start();
  async function request(path, body, auth = token) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function workspace(auth = token) { const r = await request('/api/workspace', undefined, auth); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
  async function action(action, payload, auth = token, expected = 200) { if (action === 'coachBill.create' && !payload.expectedPreviewHash && expected !== 403) { const preview = await request('/api/coach-bills/preview', { payload }, auth); assert.equal(preview.status, 200, JSON.stringify(preview.data)); payload = { ...payload, expectedPreviewHash: preview.data.previewHash }; } const w = await workspace(auth), r = await request('/api/actions', { action, payload, version: w.version }, auth); assert.equal(r.status, expected, JSON.stringify(r.data)); return r.data; }
  async function account(name, role, extra, auth = token) { await action('account.create', { name, account: name, password, role, ...extra }, auth); const r = await request('/api/auth/login', { account: name, password }, null); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.token; }
  async function report(filter = {}, auth = token, expected = 200) { const query = new URLSearchParams({ dateFrom: '2026-10-01', dateTo: '2026-10-31', ...filter }); const r = await request(`/api/coach-report?${query}`, undefined, auth); assert.equal(r.status, expected, JSON.stringify(r.data)); return r.data; }
  async function preview(payload, auth = token, expected = 200) { const r = await request('/api/coach-bills/preview', { payload }, auth); assert.equal(r.status, expected, JSON.stringify(r.data)); return r.data; }
  async function immutable() { const out = {}; for (const table of ['cards', 'ledger', 'settlements']) out[table] = await server.database.prepare(`SELECT data FROM ${table} ORDER BY seq`).all(); return out; }
  const setup = await request('/api/setup', { mode, name: '账单测试管理员', account: 'coach_bill_owner', password, tenantName: '账单测试机构', ...(mode === 'organization' ? { storeName: '售卡一店' } : { specialty: '力量' }) }, null);
  assert.equal(setup.status, 200, JSON.stringify(setup.data)); token = setup.data.token;
  return { request, workspace, action, account, report, preview, immutable, start, stop, password, setNow(value) { now = new Date(value); }, get token() { return token; }, get server() { return server; } };
}

async function seedOrganization(h) {
  let w = await h.workspace(); const store1 = w.data.stores[0].id, tenantId = w.persona.tenantId;
  w = await h.action('store.create', { name: '授课二店', address: '二店训练路', manager: '店长二', phone: '13900008001' }); const store2 = w.data.stores.find(s => s.id !== store1).id;
  const coaches = [], venues = [];
  for (const [index, storeId] of [store1, store1, store2].entries()) {
    w = await h.action('coach.invite', { storeId, name: `账单教练${index + 1}`, phone: `1390000801${index}`, specialty: '力量', certificate: 'NASM测试证', certificateExpiresAt: '2099-12-31' });
    const coachId = w.data.coaches.find(c => c.name === `账单教练${index + 1}`).id; coaches.push(coachId); await h.action('coach.review', { id: coachId, approved: true });
  }
  for (const [index, storeId] of [store1, store2].entries()) { w = await h.action('venue.create', { storeId, name: `账单训练区${index + 1}` }); venues.push(w.data.venues.find(v => v.storeId === storeId).id); }
  const members = [], cards = [];
  for (let i = 0; i < 3; i++) {
    w = await h.action('member.create', { name: `账单学员${i + 1}`, phone: `1380000801${i}`, storeId: store1, coachId: coaches[0] }); const memberId = w.data.members.find(m => m.name === `账单学员${i + 1}`).id; members.push(memberId);
    w = await h.action('card.issue', { memberId, storeId: store1, name: '跨店课时卡', total: 3, amount: 10001, expiresAt: '2099-12-31', scope: 'all', classTypes: ['力量'] }); cards.push(w.data.cards.find(c => c.memberId === memberId).id);
  }
  const classIds = [];
  for (const [index, [storeId, coachId, venueId, hour]] of [[store1, coaches[0], venues[0], 10], [store2, coaches[2], venues[1], 11], [store1, coaches[1], venues[0], 13]].entries()) {
    w = await h.action('class.create', { name: `账单授课${index + 1}`, type: '力量', storeId, coachId, venueId, startAt: `2026-10-28T${hour}:00:00+08:00`, endAt: `2026-10-28T${hour + 1}:00:00+08:00`, capacity: 4, credits: 1, price: 99999 }); classIds.push(w.data.classes.find(c => c.name === `账单授课${index + 1}`).id);
  }
  const bookings = [];
  for (const [classIndex, memberIndex] of [[0, 0], [0, 1], [0, 2], [1, 0], [2, 1]]) {
    w = await h.action('booking.create', { classId: classIds[classIndex], memberId: members[memberIndex], cardId: cards[memberIndex] }); bookings.push(w.data.bookings.find(b => b.classId === classIds[classIndex] && b.memberId === members[memberIndex]).id);
  }
  const manager1 = await h.account('bill_manager_one', 'manager', { storeId: store1 }), manager2 = await h.account('bill_manager_two', 'manager', { storeId: store2 });
  const coach1 = await h.account('bill_coach_one', 'coach', { storeId: store1, coachId: coaches[0] }), coach2 = await h.account('bill_coach_two', 'coach', { storeId: store1, coachId: coaches[1] });
  const student = await h.account('bill_student_one', 'student', { storeId: store1, memberId: members[0] });
  h.setNow('2026-10-28T02:10:00Z'); for (const bookingId of bookings.slice(0, 2)) { await h.action('booking.checkin', { id: bookingId }, coach1); await h.action('booking.complete', { id: bookingId }, coach1); }
  h.setNow('2026-10-28T03:10:00Z'); await h.action('booking.checkin', { id: bookings[3] }, manager2); await h.action('booking.complete', { id: bookings[3] }, manager2); await h.action('booking.no_show', { id: bookings[2], reason: '测试未到课，不计教练授课结算' }, manager1);
  return { tenantId, store1, store2, coaches, classIds, bookings, members, cards, manager1, manager2, coach1, coach2, student };
}

test('真实MySQL：教练账单报表、课酬快照、权限、防重和结算记录', async t => {
  const h = await harness(t), s = await seedOrganization(h);
  const flat = { coachId: s.coaches[0], storeId: s.store1, dateFrom: '2026-10-01', dateTo: '2026-10-31', rule: { type: 'flat_session', sessionAmountCents: 8000 }, note: '10月固定课酬' };
  const share = { coachId: s.coaches[2], storeId: s.store2, dateFrom: '2026-10-01', dateTo: '2026-10-31', rule: { type: 'revenue_share', basisPoints: 3333 }, note: '10月比例课酬' };
  let flatBill, shareBill;
  await t.test('schema6兼容空账单、报表与预览只读且不按课程展示价计算', async () => {
    assert.ok(await h.server.database.prepare('SELECT version FROM schema_migrations WHERE version=6').get());
    assert.deepEqual((await h.workspace()).data.coachBills, []);
    const before = await h.workspace(), immutable = await h.immutable();
    const report = await h.report({ coachId: s.coaches[0], storeId: s.store1 });
    const preview = await h.preview(flat, s.manager1);
    assert.equal(preview.amountCents, 8000); assert.equal(preview.sessions.length, 1); assert.equal(preview.totals.completedCount, 2); assert.equal(preview.totals.consumedAmountCents, 6666);
    assert.equal(report.totals.sessionCount, 1); assert.equal(report.totals.completedCount, 2); assert.equal(report.totals.credits, 2); assert.equal(report.totals.consumedAmountCents, 6666);
    const stale = await h.request('/api/actions', { action: 'coachBill.create', payload: { ...flat, rule: { type: 'flat_session', sessionAmountCents: 9000 }, expectedPreviewHash: preview.previewHash }, version: before.version }, s.manager1);
    assert.equal(stale.status, 409, '不能在预览后悄悄改变课酬规则');
    assert.equal((await h.workspace()).version, before.version); assert.deepEqual(await h.immutable(), immutable); assert.equal((await h.workspace()).data.coachBills.length, 0);
  });
  await t.test('跨店授课按真实consume分摊金额；门店报表不因售卡账本过滤而失真', async () => {
    assert.equal((await h.workspace(s.manager2)).data.ledger.length, 0, '二店不读取一店售卡账本');
    const report = await h.report({ storeId: s.store2 }, s.manager2), preview = await h.preview(share, s.manager2);
    assert.equal(report.totals.consumedAmountCents, 3334); assert.equal(report.totals.completedCount, 1); assert.equal(preview.totals.consumedAmountCents, 3334); assert.equal(preview.amountCents, 1111);
    assert.equal(JSON.stringify(report).includes('password_hash'), false); assert.equal(Object.hasOwn(report, 'ledger'), false); assert.equal(Object.hasOwn(report, 'orders'), false);
  });
  await t.test('登录、身份参数、学员及跨店/跨教练越权全部拦截', async () => {
    await h.report({}, null, 401); await h.report({}, s.student, 403); await h.preview(flat, s.coach1, 403); await h.preview(flat, s.student, 403);
    await h.report({ storeId: s.store2 }, s.manager1, 403); await h.report({ coachId: s.coaches[1] }, s.coach1, 403); await h.report({ storeId: s.store2 }, s.coach1, 403);
    await h.preview(share, s.manager1, 403); await h.action('coachBill.create', share, s.manager1, 403); await h.action('coachBill.create', flat, s.coach1, 403);
    assert.equal((await h.request('/api/coach-report?dateFrom=2026-10-01&dateTo=2026-10-31&persona=hq', undefined, s.coach1)).status, 403);
    const own = await h.report({}, s.coach1); assert.equal(own.totals.completedCount, 2); assert.ok(own.rows.every(row => row.coachId === s.coaches[0]));
    await h.report({ dateFrom: '2026-10-32' }, h.token, 400); await h.report({ dateFrom: '2026-11-01', dateTo: '2026-10-01' }, h.token, 400);
  });
  await t.test('多人同课固定课酬只算一次，生成不可重入账快照且不触发资金业务', async () => {
    const immutable = await h.immutable(); let w = await h.action('coachBill.create', flat, s.manager1); flatBill = w.data.coachBills[0];
    assert.equal(flatBill.status, 'unpaid'); assert.equal(flatBill.amountCents, 8000); assert.equal(flatBill.sessions.length, 1); assert.equal(flatBill.totals.completedCount, 2); assert.equal(flatBill.totals.consumedAmountCents, 6666);
    assert.deepEqual(await h.immutable(), immutable); await h.action('coachBill.create', flat, s.manager1, 400); assert.equal((await h.workspace()).data.coachBills.length, 1);
    assert.equal((await h.workspace(s.coach1)).data.coachBills.length, 1); assert.deepEqual((await h.workspace(s.coach2)).data.coachBills, []); assert.deepEqual((await h.workspace(s.student)).data.coachBills, []);
  });
  await t.test('同一版本并发生成只能成功一个，范围重叠不重复结算', async () => {
    const expectedPreviewHash = (await h.preview(share, s.manager2)).previewHash; const version = (await h.workspace()).version;
    const results = await Promise.all([h.request('/api/actions', { action: 'coachBill.create', payload: { ...share, expectedPreviewHash }, version }, s.manager2), h.request('/api/actions', { action: 'coachBill.create', payload: { ...share, expectedPreviewHash }, version }, s.manager2)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); const w = await h.workspace(); shareBill = w.data.coachBills.find(b => b.coachId === s.coaches[2]); assert.equal(shareBill.amountCents, 1111);
    await h.action('coachBill.create', { ...share, dateFrom: '2026-10-20' }, s.manager2, 400); assert.equal((await h.workspace()).data.coachBills.length, 2);
    assert.equal((await h.workspace(s.manager1)).data.coachBills.length, 1); assert.equal((await h.workspace(s.manager2)).data.coachBills.length, 1);
  });
  await t.test('登记真实结算、幂等重试及越权保护，不改消课账本', async () => {
    const immutable = await h.immutable(); const payload = { id: flatBill.id, paidDate: '2026-10-28', ref: 'TEST-TRANSFER-ONLY-1001', note: '已线下核对支付' };
    await h.action('coachBill.settle', payload, s.manager2, 403); await h.action('coachBill.settle', payload, s.coach1, 403); await h.action('coachBill.settle', { ...payload, paidDate: '2099-12-31' }, s.manager1, 400);
    let w = await h.action('coachBill.settle', payload, s.manager1); const paid = w.data.coachBills.find(b => b.id === flatBill.id); assert.equal(paid.status, 'paid'); assert.equal(paid.paidDate, payload.paidDate); assert.equal(paid.ref, payload.ref); const auditCount = w.data.audit.length;
    w = await h.action('coachBill.settle', payload, s.manager1); assert.deepEqual(w.data.coachBills.find(b => b.id === flatBill.id), paid); assert.equal(w.data.audit.length, auditCount);
    await h.action('coachBill.settle', { ...payload, ref: 'MISMATCH-TRANSFER' }, s.manager1, 409); assert.deepEqual(await h.immutable(), immutable);
    const own = await h.report({}, s.coach1); assert.ok(own.rows.every(row => row.existingBillStatus === 'paid')); assert.equal((await h.workspace(s.coach1)).data.coachBills[0].amountCents, 8000);
  });
  await t.test('另一租户不能读取账单或使用原租户教练；重启保留全部快照', async () => {
    const login = await h.request('/api/auth/login', { account: 'coach_bill_owner', password: h.password }, null); const platform = login.data.memberships.find(m => m.role === 'platform'); const platformToken = login.data.token;
    assert.equal((await h.request('/api/auth/context', { membershipId: platform.id }, platformToken)).status, 200);
    let w = await h.action('tenant.create', { name: '另一账单机构', contact: '另一负责人', phone: '13900008999', plan: '专业版', expiresAt: '2099-12-31' }, platformToken); const tenantId = w.data.tenants.find(item => item.id !== s.tenantId).id;
    const other = await h.account('bill_other_hq', 'hq', { tenantId }, platformToken); assert.deepEqual((await h.workspace(other)).data.coachBills, []); await h.report({ coachId: s.coaches[0] }, other, 403); await h.action('coachBill.settle', { id: shareBill.id, paidDate: '2026-10-28', note: '越权' }, other, 403);
    const before = await h.workspace(); await h.stop(); await h.start(); const after = await h.workspace(); assert.deepEqual(after.data.coachBills, before.data.coachBills); assert.deepEqual(after.data.ledger, before.data.ledger); assert.deepEqual(after.data.settlements, before.data.settlements); assert.equal(after.version, before.version);
    assert.equal((await h.server.database.prepare('SELECT COUNT(*) AS n FROM coach_bills').get()).n, 2); assert.ok((await h.report({ storeId: s.store2 }, s.manager2)).rows.every(row => row.existingBillStatus === 'unpaid')); assert.equal((await h.workspace(s.manager2)).data.coachBills[0].amountCents, 1111);
  });
});

test('真实MySQL：独立教练无门店也可生成账单并登记结算', async t => {
  const h = await harness(t, 'solo'); let w = await h.workspace(); const coachId = w.data.coaches[0].id;
  w = await h.action('venue.create', { name: '独立训练区' }); const venueId = w.data.venues[0].id;
  w = await h.action('member.create', { name: '独立账单学员', phone: '13800008888' }); const memberId = w.data.members[0].id;
  w = await h.action('card.issue', { memberId, name: '独立训练课卡', total: 3, amount: 10001, expiresAt: '2099-12-31', scope: 'home', classTypes: ['力量'] }); const cardId = w.data.cards[0].id;
  w = await h.action('class.create', { coachId, name: '独立训练', type: '力量', venueId, startAt: '2026-10-28T10:00:00+08:00', endAt: '2026-10-28T11:00:00+08:00', capacity: 1, credits: 1, price: 10000 }); const classId = w.data.classes[0].id;
  w = await h.action('booking.create', { classId, memberId, cardId }); const bookingId = w.data.bookings[0].id;
  h.setNow('2026-10-28T02:10:00Z'); await h.action('booking.checkin', { id: bookingId }); await h.action('booking.complete', { id: bookingId });
  const payload = { coachId, dateFrom: '2026-10-01', dateTo: '2026-10-31', rule: { type: 'revenue_share', basisPoints: 10000 } };
  assert.equal((await h.preview(payload)).amountCents, 3333); w = await h.action('coachBill.create', payload); const bill = w.data.coachBills[0]; assert.equal(bill.storeId, ''); assert.equal(bill.amountCents, 3333);
  w = await h.action('coachBill.settle', { id: bill.id, paidDate: '2026-10-28', note: '独立经营核对完成' }); assert.equal(w.data.coachBills[0].status, 'paid'); assert.equal(w.data.settlements.length, 0);
  assert.ok((await h.report()).rows.every(row => row.existingBillStatus === 'paid')); await h.report({ storeId: 'nonexistent-store' }, h.token, 403);
});

test('真实MySQL：既有schema5安全升级空账单表，不改变原业务与版本', async t => {
  const h = await harness(t, 'solo'), before = await h.workspace();
  // This generated, isolated test schema has no bills. Recreate its pre-feature
  // schema state without touching the user's database or any business records.
  assert.equal((await h.server.database.prepare('SELECT COUNT(*) AS n FROM coach_bills').get()).n, 0);
  await h.server.database.exec('DROP TABLE coach_bills');
  await h.server.database.prepare('DELETE FROM schema_migrations WHERE version=6').run();
  await h.stop(); await h.start();
  assert.ok(await h.server.database.prepare('SELECT version FROM schema_migrations WHERE version=6').get());
  assert.deepEqual(await h.workspace(), before);
  await h.stop(); await h.start(); assert.deepEqual(await h.workspace(), before);
});
