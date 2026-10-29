import test from "node:test";
import assert from "node:assert/strict";
import { applyAction, assertInvariants, DomainError, getPersona, projectWorkspace } from "../lib/domain";
import { authorizedCoachBillingFilter, buildCoachBillingReport, CoachBillingError, coachBillingMonthRange, previewCoachBill } from "../lib/coach-billing";
import { createSeed } from "../lib/seed";
import type { CoachBillCreatePayload, CoachBillRule, CoachBillingFilter, Persona, WorkspaceData } from "../lib/types";

const NOW = new Date("2026-10-28T02:00:00Z");
const FILTER: CoachBillingFilter = { tenantId: "t1", coachId: "c1", storeId: "s1", dateFrom: "2026-10-01", dateTo: "2026-10-31" };
const FLAT: CoachBillRule = { type: "flat_session", sessionAmountCents: 5000 };
function fixture(): WorkspaceData {
  const data = createSeed(NOW);data.classes = [{ id: "lesson-one", tenantId: "t1", storeId: "s1", coachId: "c1", name: "已授力量训练", type: "力量训练", startAt: "2026-10-25T09:00:00+08:00", endAt: "2026-10-25T10:00:00+08:00", capacity: 8, credits: 1, price: 999999, room: "真实训练区", status: "scheduled" }];
  data.bookings = [
    { id: "done-one", tenantId: "t1", memberId: "m1", classId: "lesson-one", cardId: "card1", status: "completed", credits: 1, createdAt: "2026-10-24T01:00:00Z", completedAt: "2026-10-25T02:00:00Z" },
    { id: "done-two", tenantId: "t1", memberId: "m4", classId: "lesson-one", cardId: "card4", status: "completed", credits: 1, createdAt: "2026-10-24T01:00:00Z", completedAt: "2026-10-25T02:01:00Z" },
  ];
  data.ledger = data.bookings.map((booking, index) => ({ id: `consume-${index}`, tenantId: "t1", storeId: "s1", cardId: booking.cardId, memberId: booking.memberId, bookingId: booking.id, type: "consume", credits: 1, remaining: 10, frozen: 0, amount: -(101 + index), note: "booking.complete", createdAt: booking.completedAt! }));
  data.cards.forEach(card => { card.frozen = 0; });data.settlements = [];data.audit = [];data.orders = [];data.coachBills = [];
  return data;
}
function rejects(run: () => unknown, pattern: RegExp, status = 400) { assert.throws(run, error => (error instanceof DomainError || error instanceof CoachBillingError) && error.status === status && pattern.test(error.message)); }
function create(data = fixture(), rule = FLAT, actor: Persona | string = "hq", filter = FILTER) {
  const preview = previewCoachBill(data, { ...filter, rule }, NOW);
  const payload: CoachBillCreatePayload = { coachId: filter.coachId!, storeId: filter.storeId, dateFrom: filter.dateFrom, dateTo: filter.dateTo, rule, expectedPreviewHash: preview.previewHash };
  return applyAction(data, actor, "coachBill.create", payload, NOW);
}

test("教练报表仅计明确完成履约，收入优先消课流水并区分课次与人次", () => {
  const data = fixture();
  for (const status of ["cancelled", "no_show", "late_cancelled", "reserved", "checked_in"] as const) data.bookings.push({ ...data.bookings[0], id: `excluded-${status}`, status });
  const report = buildCoachBillingReport(data, FILTER, NOW);
  assert.equal(report.rows.length, 2);assert.equal(report.totals.sessionCount, 1);assert.equal(report.totals.completedCount, 2);assert.equal(report.totals.credits, 2);assert.equal(report.totals.durationMinutes, 60);assert.equal(report.totals.consumedAmountCents, 203);assert.equal(report.totals.estimatedCount, 0);
  assert.ok(report.rows.every(row => row.revenueSource === "consume_ledger"));assert.ok(report.rows.every(row => !row.flatEligible));assert.match(report.notes.join(" "), /待处理预约/);
});

test("历史完成依据缺失或异常有明确警告，仅明确消课流水可补可靠完成时间", () => {
  const data = fixture();delete data.bookings[0].completedAt;data.bookings[1].completedAt = "2027-01-01T01:00:00Z";
  const report = buildCoachBillingReport(data, FILTER, NOW);
  assert.equal(report.rows.length, 1);assert.equal(report.rows[0].completionSource, "consume_ledger");assert.equal(report.totals.ledgerCompletionCount, 1);assert.equal(report.totals.excludedCompletionCount, 1);assert.match(report.notes.join(" "), /流水时间|异常/);
  data.ledger[0].note = "历史其他记录";assert.equal(buildCoachBillingReport(data, FILTER, NOW).rows.length, 0);
});

test("缺消课流水才按课卡单位价值估算，完全缺金额为未知而非0或展示价", () => {
  const data = fixture();data.ledger = [];
  let report = buildCoachBillingReport(data, FILTER, NOW);assert.equal(report.rows[0].consumedAmountCents, 16800);assert.equal(report.totals.estimatedCount, 2);
  delete (data.cards.find(card => card.id === "card1")! as unknown as Record<string, unknown>).unitValueCents;
  report = buildCoachBillingReport(data, FILTER, NOW);assert.equal(report.rows[0].consumedAmountCents, null);assert.equal(report.totals.missingAmountCount, 1);assert.match(report.notes.join(" "), /未知|缺少/);
  const share = previewCoachBill(data, { ...FILTER, rule: { type: "revenue_share", basisPoints: 5000 } }, NOW);assert.deepEqual(share.details.map(row => row.bookingId), ["done-two"]);assert.equal(share.amountCents, 9900);
  const fixed = previewCoachBill(data, { ...FILTER, rule: FLAT }, NOW);assert.equal(fixed.amountCents, 5000);assert.equal(fixed.totals.missingAmountCount, 1);
  data.cards.find(card => card.id === "card4")!.unitValueCents = 0;assert.equal(buildCoachBillingReport(data, FILTER, NOW).rows[1].consumedAmountCents, 0);
});

test("账期按课程开始的上海日期筛选，不按UTC日或完成时间归档", () => {
  const data = fixture();data.classes[0].startAt = "2026-09-30T16:30:00Z";data.classes[0].endAt = "2026-09-30T17:30:00Z";
  assert.equal(buildCoachBillingReport(data, { ...FILTER, dateFrom: "2026-10-01", dateTo: "2026-10-01" }, NOW).rows.length, 2);
  assert.equal(buildCoachBillingReport(data, { ...FILTER, dateFrom: "2026-09-30", dateTo: "2026-09-30" }, NOW).rows.length, 0);
  assert.deepEqual(coachBillingMonthRange(new Date("2026-09-30T16:30:00Z")), { dateFrom: "2026-10-01", dateTo: "2026-10-31" });
});

test("教练报表和账单授权按品牌与实际授课店，历史被驳回或换店不丢历史", () => {
  const data = fixture();data.coaches[0].status = "rejected";data.coaches[0].storeId = "s2";
  const filter = authorizedCoachBillingFilter(data, getPersona("manager"), { coachId: "c1", dateFrom: FILTER.dateFrom, dateTo: FILTER.dateTo }, NOW);assert.equal(filter.storeId, "s1");assert.equal(buildCoachBillingReport(data, filter, NOW).rows.length, 2);assert.equal(create(data).coachBills!.length, 1);
  rejects(() => authorizedCoachBillingFilter(data, getPersona("manager"), { storeId: "s2" }, NOW), /本门店/, 403);
  rejects(() => authorizedCoachBillingFilter(data, getPersona("hq"), { coachId: "foreign", storeId: "s4" }, NOW), /训练空间|品牌/, 403);
  rejects(() => authorizedCoachBillingFilter(data, getPersona("coach"), { coachId: "c3" }, NOW), /本人/, 403);
  rejects(() => authorizedCoachBillingFilter(data, getPersona("hq"), { tenantId: "t2" }, NOW), /不能自行指定/, 403);
  for (const actor of ["coach", "student", "platform"]) rejects(() => create(data, FLAT, actor), /无权/, 403);
});

test("固定课酬按多人课的一节课计算一次，快照不随之后改名金额改变", () => {
  const data = fixture(), before = structuredClone(data), billed = create(data), bill = billed.coachBills![0];
  assert.equal(bill.status, "unpaid");assert.equal(bill.amountCents, 5000);assert.equal(bill.details.length, 2);assert.equal(bill.sessions.length, 1);assert.equal(bill.details.reduce((sum, row) => sum + row.amountCents, 0), 5000);assert.deepEqual(data, before);
  const snapshot = structuredClone(bill);billed.classes[0].name = "后来改名";billed.coaches[0].name = "后来教练名";billed.ledger[0].amount = -90000;assert.deepEqual(billed.coachBills![0], snapshot);assertInvariants(billed);
  assert.ok(previewCoachBill(billed, { ...FILTER, rule: FLAT }, NOW).blocking.length);rejects(() => create(billed), /没有符合/);
});

test("未闭合课次暂不计固定课酬，提成可先计已完成并补后续履约且不重复固定", () => {
  const data = fixture();data.bookings[1].status = "checked_in";delete data.bookings[1].completedAt;data.cards.find(card => card.id === "card4")!.frozen = 1;
  const fixed = previewCoachBill(data, { ...FILTER, rule: FLAT }, NOW);assert.ok(fixed.blocking.length);assert.match(fixed.notes.join(" "), /待处理预约/);
  const billed = create(data, { type: "revenue_share", basisPoints: 5000 });assert.equal(billed.coachBills![0].details.length, 1);
  billed.bookings[1].status = "completed";billed.bookings[1].completedAt = "2026-10-25T02:01:00Z";billed.cards.find(card => card.id === "card4")!.frozen = 0;
  assert.ok(previewCoachBill(billed, { ...FILTER, rule: FLAT }, NOW).blocking.length);
  const extra = create(billed, { type: "revenue_share", basisPoints: 5000 });assert.equal(extra.coachBills!.length, 2);assert.deepEqual(extra.coachBills![1].details.map(row => row.bookingId), ["done-two"]);assertInvariants(extra);
});

test("提成以总额精确四舍五入并最大余数分配，大乘积仍使用整数运算", () => {
  const data = fixture();data.ledger.forEach(entry => { entry.amount = -1; });
  let preview = previewCoachBill(data, { ...FILTER, rule: { type: "revenue_share", basisPoints: 5000 } }, NOW);assert.equal(preview.amountCents, 1);assert.deepEqual(preview.details.map(row => row.amountCents), [1, 0]);
  data.ledger.forEach(entry => { entry.amount = -4_000_000_000_000_000; });
  preview = previewCoachBill(data, { ...FILTER, rule: { type: "revenue_share", basisPoints: 3333 } }, NOW);assert.equal(preview.amountCents, 2_666_400_000_000_000);assert.equal(preview.details.reduce((sum, row) => sum + row.amountCents, 0), preview.amountCents);
  data.ledger.forEach(entry => { entry.amount = -Number.MAX_SAFE_INTEGER; });rejects(() => previewCoachBill(data, { ...FILTER, rule: { type: "revenue_share", basisPoints: 5000 } }, NOW), /安全计算/);
});

test("创建必须匹配可信预览，金额变化或伪造字段拒绝且不能重复入账", () => {
  const data = fixture(), preview = previewCoachBill(data, { ...FILTER, rule: { type: "revenue_share", basisPoints: 5000 } }, NOW);
  const payload = { coachId: "c1", storeId: "s1", dateFrom: FILTER.dateFrom, dateTo: FILTER.dateTo, rule: { type: "revenue_share", basisPoints: 5000 }, expectedPreviewHash: preview.previewHash };
  data.ledger[0].amount = -500;const before = structuredClone(data);rejects(() => applyAction(data, "hq", "coachBill.create", payload, NOW), /已变化/, 409);assert.deepEqual(data, before);
  rejects(() => applyAction(data, "hq", "coachBill.create", { ...payload, amountCents: 1 }, NOW), /不能自行指定/, 403);
  rejects(() => previewCoachBill(data, { ...FILTER, rule: { type: "revenue_share", basisPoints: 0.5 } }, NOW), /整数基点/);
  const billed = create(data, { type: "revenue_share", basisPoints: 5000 });assert.ok(previewCoachBill(billed, { ...FILTER, rule: { type: "revenue_share", basisPoints: 5000 } }, NOW).blocking.length);
});

test("结算仅登记快照实付金额，日期必填备注选填，同参重试幂等且不能改付款", () => {
  const billed = create(), bill = billed.coachBills![0];
  rejects(() => applyAction(billed, "hq", "coachBill.settle", { id: bill.id, paidDate: "2026-10-29" }, NOW), /晚于今天/);
  const paid = applyAction(billed, "manager", "coachBill.settle", { id: bill.id, paidDate: "2026-10-27" }, NOW);assert.equal(paid.coachBills![0].status, "paid");assert.equal(paid.coachBills![0].amountCents, 5000);assert.equal(paid.coachBills![0].settleNote, "");
  assert.deepEqual(applyAction(paid, "manager", "coachBill.settle", { id: bill.id, paidDate: "2026-10-27" }, NOW), paid);
  rejects(() => applyAction(paid, "hq", "coachBill.settle", { id: bill.id, paidDate: "2026-10-27", ref: "不同支付记录" }, NOW), /已登记支付/, 409);
  rejects(() => applyAction(paid, "hq", "coachBill.settle", { id: bill.id, paidDate: "2026-10-27", amountCents: 1 }, NOW), /不能修改/, 403);
  rejects(() => applyAction(paid, { ...getPersona("manager"), storeId: "s2" }, "coachBill.settle", { id: bill.id, paidDate: "2026-10-27" }, NOW), /本门店/, 403);
});

test("账单投影只给授权品牌门店或本人，独立空间无门店也能结算且快照防篡改", () => {
  const billed = create();assert.equal(projectWorkspace(billed, "hq", 1).data.coachBills!.length, 1);assert.equal(projectWorkspace(billed, "coach", 1).data.coachBills!.length, 1);
  for (const actor of ["student", "platform"]) assert.deepEqual(projectWorkspace(billed, actor, 1).data.coachBills, []);
  assert.deepEqual(projectWorkspace(billed, { ...getPersona("manager"), storeId: "s2" }, 1).data.coachBills, []);
  const tampered = structuredClone(billed);tampered.coachBills![0].amountCents = 1;rejects(() => assertInvariants(tampered), /快照|金额/, 409);
  const solo = fixture();solo.tenants[0].mode = "solo";solo.coaches[0].storeId = "";solo.coaches[0].selfManaged = true;solo.classes[0].storeId = "";
  const owner: Persona = { ...getPersona("hq"), workspaceMode: "solo", coachId: "c1" }, filter = { ...FILTER, storeId: "" };
  assert.equal(create(solo, FLAT, owner, filter).coachBills![0].storeId, "");
});
