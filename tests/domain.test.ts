import assert from "node:assert/strict";
import test from "node:test";
import { applyAction, assertInvariants, DomainError, getPersona, projectWorkspace } from "../lib/domain";
import { createSeed, shanghaiDate } from "../lib/seed";
import { resolveOwner } from "../lib/request-auth";
import type { WorkspaceData } from "../lib/types";

const NOW = new Date("2026-10-24T03:00:00Z");
const seed = () => createSeed(NOW);
const reserve = (data: WorkspaceData, classId = "cls-2", cardId = "card1", memberId = "m1") => applyAction(data, "student", "booking.create", { classId, cardId, memberId }, NOW);
function rejects(fn: () => unknown, message: RegExp, status = 400) {
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.status === status && message.test(error.message));
}

test("示例种子满足余额、冻结、容量与清分唯一性约束", () => {
  assertInvariants(seed());
  assert.equal(shanghaiDate(new Date("2026-10-23T17:00:00Z")), "2026-10-24");
});
test("预约冻结课时但不扣实余额，重复预约不重复冻结", () => {
  const original = seed(); const booked = reserve(original); const card = booked.cards.find((c) => c.id === "card1")!;
  assert.equal(card.remaining, 24); assert.equal(card.frozen, 3);
  assert.equal(original.cards[0].frozen, 2, "原始状态不可被事务函数变更");
  const retry = reserve(booked);
  assert.equal(retry.cards[0].frozen, 3); assert.equal(retry.bookings.length, booked.bookings.length);
});
test("取消释放冻结课时，重试不重复释放，可重新预约", () => {
  const booked = reserve(seed()); const booking = booked.bookings.find((b) => b.classId === "cls-2" && b.memberId === "m1")!;
  const cancelled = applyAction(booked, "student", "booking.cancel", { id: booking.id }, NOW);
  assert.equal(cancelled.cards[0].frozen, 2); assert.equal(cancelled.cards[0].remaining, 24);
  const retry = applyAction(cancelled, "student", "booking.cancel", { id: booking.id }, NOW);
  assert.equal(retry.cards[0].frozen, 2);
  assert.equal(reserve(retry).cards[0].frozen, 3);
});
test("取消截止为严格早于开课前60分钟，边界拒绝且余额不变", () => {
  const data = seed(); const cls = data.classes.find((c) => c.id === "cls-1")!;
  const cutoff = new Date(Date.parse(cls.startAt) - 60 * 60_000);
  rejects(() => applyAction(data, "student", "booking.cancel", { id: "b5" }, cutoff), /60 分钟/);
  assert.equal(applyAction(data, "student", "booking.cancel", { id: "b5" }, new Date(cutoff.getTime() - 1)).bookings.find((b) => b.id === "b5")!.status, "cancelled");
});
test("签到、消课及跨店清分原子发生，重复消课不再次扣除", () => {
  const data = seed();
  const completed = applyAction(data, "coach", "booking.complete", { id: "b4" }, NOW);
  const card = completed.cards.find((c) => c.id === "card3")!;
  assert.equal(card.remaining, 11); assert.equal(card.frozen, 0);
  const settlement = completed.settlements.find((s) => s.bookingId === "b4")!;
  assert.equal(settlement.amount, 16800); assert.equal(settlement.fromStoreId, "s2"); assert.equal(settlement.toStoreId, "s1");
  const retry = applyAction(completed, "coach", "booking.complete", { id: "b4" }, NOW);
  assert.equal(retry.cards.find((c) => c.id === "card3")!.remaining, 11);
  assert.equal(retry.settlements.filter((s) => s.bookingId === "b4").length, 1);
  assert.equal(retry.audit.length, completed.audit.length);
});
test("未签到不允许消课；签到重复提交不改变课时", () => {
  rejects(() => applyAction(seed(), "coach", "booking.complete", { id: "b1" }, NOW), /先完成学员签到/);
  const checked = applyAction(seed(), "coach", "booking.checkin", { id: "b1" }, NOW);
  const retry = applyAction(checked, "coach", "booking.checkin", { id: "b1" }, NOW);
  assert.equal(retry.bookings.find((b) => b.id === "b1")!.status, "checked_in"); assert.equal(retry.cards[0].remaining, 24); assert.equal(retry.cards[0].frozen, 2);
  assert.equal(applyAction(retry, "coach", "booking.complete", { id: "b1" }, NOW).cards[0].remaining, 23);
});
test("已完成和已签到课程不能取消", () => {
  rejects(() => applyAction(seed(), "student", "booking.cancel", { id: "b2" }, NOW), /已签到或已完成/);
});
test("签到窗口外不允许签到，开课前不允许消课", () => {
  rejects(() => applyAction(seed(), "manager", "booking.checkin", { id: "b5" }, NOW), /2 小时/);
  const data = seed(); const booking = data.bookings.find((b) => b.id === "b5")!; booking.status = "checked_in";
  rejects(() => applyAction(data, "manager", "booking.complete", { id: "b5" }, NOW), /尚未开始/);
});
test("跨店多课时使用售卡分摊价值而非课程展示价", () => {
  const data = seed(); const b = data.bookings.find((item) => item.id === "b4")!;
  b.credits = 2; data.cards.find((c) => c.id === "card3")!.frozen = 2;
  data.classes.find((c) => c.id === "cls-live")!.price = 99900;
  const done = applyAction(data, "manager", "booking.complete", { id: "b4" }, NOW);
  assert.equal(done.settlements.find((s) => s.bookingId === "b4")!.amount, 33600);
  assert.equal(done.cards.find((c) => c.id === "card3")!.remaining, 10);
});
test("总部清分确认幂等且门店不可确认", () => {
  const data = seed(); rejects(() => applyAction(data, "manager", "settlement.confirm", { id: "st1" }, NOW), /无权/, 403);
  const confirmed = applyAction(data, "hq", "settlement.confirm", { id: "st1" }, NOW);
  assert.equal(confirmed.settlements[0].status, "confirmed");
  assert.equal(applyAction(confirmed, "hq", "settlement.confirm", { id: "st1" }, NOW).audit.length, confirmed.audit.length);
});
test("卡余额不足、冻结、到期及科目不符均被拒绝", () => {
  const low = seed(); low.cards[0].remaining = low.cards[0].frozen; rejects(() => reserve(low), /可用课时不足/);
  const frozen = seed(); frozen.cards[0].status = "frozen"; rejects(() => reserve(frozen), /课卡已冻结/);
  const expired = seed(); expired.cards[0].expiresAt = "2026-10-24"; rejects(() => reserve(expired), /开课日已过期/);
  const type = seed(); type.cards[0].classTypes = []; rejects(() => reserve(type), /课程科目/);
});
test("课卡有效期的当天仍可约，绑定孩子使用自己的课卡", () => {
  const data = seed(); data.cards[0].expiresAt = "2026-10-25";
  assert.equal(reserve(data).cards[0].frozen, 3);
  const cancelled = applyAction(seed(), "student", "booking.cancel", { id: "b3" }, NOW);
  assert.equal(reserve(cancelled, "cls-3", "card2", "m2").cards.find((c) => c.id === "card2")!.frozen, 1);
  rejects(() => reserve(cancelled, "cls-3", "card1", "m2"), /课卡不属于/, 403);
});
test("本店卡不可跨店，不能借用未绑定学员", () => {
  const data = seed(); data.cards[0].scope = "home"; rejects(() => reserve(data), /仅适用于开卡门店/);
  rejects(() => reserve(seed(), "cls-2", "card3", "m3"), /本人或已绑定孩子/, 403);
});
test("满员、已开课、学员时间冲突不可预约", () => {
  const full = seed(); full.classes.find((c) => c.id === "cls-2")!.capacity = 0; rejects(() => reserve(full), /已约满/);
  const started = seed(); started.classes.find((c) => c.id === "cls-2")!.startAt = NOW.toISOString(); rejects(() => reserve(started), /已开始/);
  const overlap = seed(); const first = overlap.classes.find((c) => c.id === "cls-1")!; const next = overlap.classes.find((c) => c.id === "cls-4")!; next.startAt = first.startAt; next.endAt = first.endAt;
  rejects(() => reserve(overlap, "cls-4"), /已有预约/);
});
test("教练未审核、资质开课日到期或科目不符均阻止预约", () => {
  const pending = seed(); pending.coaches.find((c) => c.id === "c2")!.status = "pending"; rejects(() => reserve(pending), /尚未通过资质审核/);
  const expired = seed(); expired.coaches.find((c) => c.id === "c2")!.certificateExpiresAt = "2026-10-24"; rejects(() => reserve(expired), /资质在开课日已过期/);
  const specialty = seed(); specialty.classes.find((c) => c.id === "cls-2")!.type = "少儿体能"; rejects(() => reserve(specialty), /教学资格/);
});

const classPayload = { name: "周末训练", storeId: "s1", coachId: "c1", type: "力量训练", startAt: "2026-10-27T14:00", endAt: "2026-10-27T15:00", capacity: 10, credits: 1, price: 19800, room: "A 区" };
test("排课接受上海本地时间并拒绝教练、场地冲突及跨店教练", () => {
  const created = applyAction(seed(), "manager", "class.create", classPayload, NOW);
  assert.equal(created.classes.at(-1)!.startAt, "2026-10-27T06:00:00.000Z");
  rejects(() => applyAction(created, "manager", "class.create", { ...classPayload, room: "B 区" }, NOW), /已有课程/);
  rejects(() => applyAction(created, "manager", "class.create", { ...classPayload, coachId: "c3", type: "少儿体能" }, NOW), /已有课程/);
  rejects(() => applyAction(seed(), "manager", "class.create", { ...classPayload, coachId: "c2", type: "瑜伽普拉提" }, NOW), /归属其他门店/);
  rejects(() => applyAction(seed(), "manager", "class.create", { ...classPayload, startAt: "2026-02-30T14:00" }, NOW), /有效日期/);
});
test("门店和教练不能通过替换ID操作其他门店或其他教练课程", () => {
  rejects(() => applyAction(seed(), "manager", "coach.review", { id: "c4", approved: true }, NOW), /本门店/, 403);
  rejects(() => applyAction(seed(), "manager", "task.complete", { id: "task2" }, NOW), /本门店/, 403);
  rejects(() => applyAction(seed(), "coach", "booking.checkin", { id: "b3" }, NOW), /自己的课程/, 403);
  rejects(() => applyAction(seed(), "manager", "booking.cancel", { id: "b2" }, NOW), /本门店/, 403);
});
test("平台与总部权限不同，无效persona无法提权", () => {
  rejects(() => applyAction(seed(), "hq", "tenant.update", { id: "t2", status: "suspended" }, NOW), /无权/, 403);
  rejects(() => applyAction(seed(), "student", "booking.complete", { id: "b1" }, NOW), /无权/, 403);
  rejects(() => getPersona({ id: "hq", role: "platform" }), /有效的预置体验身份/);
});
test("暂停或到期品牌保留读取，阻止所有业务写入", () => {
  const data = seed(); data.tenants[0].status = "suspended";
  assert.equal(projectWorkspace(data, "student", 1).data.cards.length, 2);
  rejects(() => reserve(data), /服务已暂停或到期/, 403);
  rejects(() => applyAction(data, "hq", "task.complete", { id: "task1" }, NOW), /服务已暂停或到期/, 403);
  const expired = seed(); expired.tenants[0].expiresAt = "2026-10-23"; rejects(() => reserve(expired), /服务已暂停或到期/, 403);
});
test("入驻审核开通品牌，重复提交不重复创建品牌", () => {
  const approved = applyAction(seed(), "platform", "application.review", { id: "ap1", approved: true }, NOW);
  assert.equal(approved.tenants.length, 4);
  const retry = applyAction(approved, "platform", "application.review", { id: "ap1", approved: true }, NOW);
  assert.equal(retry.tenants.length, 4); assert.equal(retry.audit.length, approved.audit.length);
  rejects(() => applyAction(approved, "platform", "application.review", { id: "ap1", approved: false }, NOW), /已处理/);
});
test("品牌续期要求有效计划和日期", () => {
  rejects(() => applyAction(seed(), "platform", "tenant.update", { id: "t3", status: "active" }, NOW), /延长/);
  const renewed = applyAction(seed(), "platform", "tenant.update", { id: "t3", status: "active", expiresAt: "2027-10-24", plan: "旗舰版" }, NOW);
  assert.equal(renewed.tenants.find((t) => t.id === "t3")!.status, "active");
});
test("教练邀请生成待审邀请码，资质有效期须实际填写后才能通过", () => {
  const payload = { name: "新教练", phone: "13900139011", storeId: "s1", specialty: "力量训练" };
  const pending = applyAction(seed(), "manager", "coach.invite", payload, NOW);
  const coach = pending.coaches.at(-1)!;
  assert.equal(coach.status, "pending"); assert.match(coach.inviteCode!, /^[A-F0-9]{8}$/); assert.equal(coach.certificateExpiresAt, "");
  rejects(() => applyAction(pending, "manager", "coach.review", { id: coach.id, approved: true }, NOW), /有效的教练资质/);
  rejects(() => applyAction(seed(), "manager", "coach.invite", { ...payload, certificate: "NSCA" }, NOW), /证书实际有效期/);
  const supplied = applyAction(seed(), "manager", "coach.invite", { ...payload, certificate: "NSCA", certificateExpiresAt: "2027-01-01" }, NOW);
  assert.equal(applyAction(supplied, "hq", "coach.review", { id: supplied.coaches.at(-1)!.id, approved: true }, NOW).coaches.at(-1)!.status, "approved");
});
test("角色读取按品牌、门店、家庭过滤且学员仍获得准确容量汇总", () => {
  const data = seed(); const student = projectWorkspace(data, "student", 7);
  assert.equal(student.version, 7); assert.equal(student.data.members.length, 2);
  assert.equal(student.data.tenants.length, 1); assert.equal(student.data.applications.length, 0); assert.equal(student.data.tasks.length, 0);
  assert.ok(student.data.bookings.every((b) => ["m1", "m2"].includes(b.memberId)));
  assert.equal(student.data.classes.find((c) => c.id === "cls-live")!.bookedCount, 2);
  assert.ok(student.data.announcements.every((a) => a.audience !== "staff"));
  assert.ok(student.data.coaches.every((c) => !c.phone && !c.inviteCode));
  const manager = projectWorkspace(data, "manager", 1).data;
  assert.ok(manager.stores.every((s) => s.id === "s1")); assert.ok(manager.classes.every((c) => c.storeId === "s1"));
  assert.ok(manager.members.some((m) => m.id === "m3"), "本店教练需要知道到访学员");
  assert.ok(manager.cards.some((c) => c.id === "card3"), "到访预约使用的卡可供门店履约");
  const coach = projectWorkspace(data, "coach", 1).data;
  assert.ok(coach.classes.every((c) => c.coachId === "c1")); assert.equal(coach.cards.length, 0);
  assert.equal(projectWorkspace(data, "platform", 1).data.tenants.length, 3);
});
test("总部任务完成幂等与定向公告过滤", () => {
  const created = applyAction(seed(), "hq", "announcement.create", { title: "学员公告", content: "预约提醒", audience: "students" }, NOW);
  assert.ok(projectWorkspace(created, "student", 1).data.announcements.some((a) => a.title === "学员公告"));
  assert.ok(!projectWorkspace(created, "manager", 1).data.announcements.some((a) => a.title === "学员公告"));
  const completed = applyAction(created, "manager", "task.complete", { id: "task1" }, NOW);
  assert.equal(applyAction(completed, "manager", "task.complete", { id: "task1" }, NOW).audit.length, completed.audit.length);
});
test("所有者来源：本机匿名、远程认证、不同账号隔离键及远程无认证401", () => {
  assert.equal(resolveOwner(new Request("http://127.0.0.1:3000/api/workspace")), "local-demo");
  assert.equal(resolveOwner(new Request("http://localhost:3000/api/workspace")), "local-demo");
  const a = resolveOwner(new Request("https://example.com/api/workspace", { headers: { "oai-authenticated-user-id": "user-a" } }));
  const b = resolveOwner(new Request("https://example.com/api/workspace", { headers: { "oai-authenticated-user-id": "user-b" } }));
  assert.notEqual(a, b);
  rejects(() => resolveOwner(new Request("https://example.com/api/workspace")), /ChatGPT 登录/, 401);
  rejects(() => resolveOwner(new Request("https://localhost.example.com/api/workspace")), /ChatGPT 登录/, 401);
});
test("检测异常冻结额使事务整体撤回", () => {
  const data = seed(); data.cards[0].frozen = 0;
  rejects(() => applyAction(data, "hq", "task.complete", { id: "task1" }, NOW), /余额核对失败/, 409);
  assert.equal(data.tasks[0].status, "pending");
});
