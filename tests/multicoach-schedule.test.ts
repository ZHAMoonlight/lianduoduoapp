import test from "node:test";
import assert from "node:assert/strict";
import { applyAction, assertInvariants, DomainError, getPersona, previewSchedule, projectWorkspace } from "../lib/domain";
import { createSeed } from "../lib/seed";
import type { Persona, SchedulePlanPublishPayload, WorkspaceData } from "../lib/types";

const NOW = new Date("2026-10-28T02:00:00Z");
function fixture(): WorkspaceData {
  const data = createSeed(NOW);
  data.classes = [];data.bookings = [];data.audit = [];data.ledger = [];data.settlements = [];
  data.cards.forEach(card => { card.frozen = 0; });
  const first = data.coaches.find(coach => coach.id === "c1")!, second = data.coaches.find(coach => coach.id === "c3")!;
  second.status = "approved";second.specialty = first.specialty;second.certificate = first.certificate;second.certificateExpiresAt = first.certificateExpiresAt;
  return data;
}
function payload(overrides: Partial<SchedulePlanPublishPayload> = {}): SchedulePlanPublishPayload {
  return { mode: "availability", name: "自选教练私教", type: "力量训练", storeId: "s1", coachIds: ["c1", "c3"], sharedRoom: true, startDate: "2026-10-29", endDate: "2026-10-29", weekdays: [4], startTime: "09:00", endTime: "12:00", durationMinutes: 60, gapMinutes: 15, capacity: 1, credits: 1, price: 19800, room: "共享训练区域", ...overrides };
}
function publish(data = fixture(), p = payload(), actor: Persona | string = "hq") { return applyAction(data, actor, "schedule.publish", p, NOW); }
function rejects(run: () => unknown, pattern: RegExp, status = 400) { assert.throws(run, error => error instanceof DomainError && error.status === status && pattern.test(error.message)); }
const memberFour: Persona = { ...getPersona("student"), memberId: "m4", memberIds: ["m4"] };
const secondCoach: Persona = { ...getPersona("coach"), coachId: "c3" };

test("多教练按相同时间分别生成独立课次，预览显示教练、时间数与总容量范围", () => {
  const data = fixture(), before = structuredClone(data), preview = previewSchedule(data, "hq", payload(), NOW);
  assert.equal(preview.coachCount, 2);assert.equal(preview.timeSlotCount, 2);assert.equal(preview.slotCount, 4);assert.equal(preview.occurrenceCount, 1);
  assert.deepEqual(preview.items.map(item => item.coachId), ["c1", "c3", "c1", "c3"]);assert.ok(preview.items.every(item => item.coachName && item.room === "共享训练区域"));assert.deepEqual(data, before);
  const result = publish(data), plan = result.schedulePlans![0];
  assert.deepEqual(plan.coachIds, ["c1", "c3"]);assert.equal(plan.coachId, "c1");assert.equal(plan.sharedRoom, true);
  assert.equal(result.classes.length, 4);assert.ok(result.classes.every(cls => cls.capacity === 1 && cls.schedulePlanId === plan.id));assertInvariants(result);
  const recurring = publish(fixture(), payload({ mode: "recurring", capacity: 8, endTime: "10:00", endDate: "2026-11-12" }));
  assert.equal(recurring.classes.length, 6);assert.ok(recurring.classes.every(cls => cls.capacity === 8));
});

test("多教练需要明确共享场地确认，不放宽已有计划和单次课程的场地冲突", () => {
  rejects(() => publish(fixture(), payload({ sharedRoom: false })), /确认|场地/);
  rejects(() => publish(fixture(), payload({ sharedRoom: undefined })), /确认|场地/);
  const existing = applyAction(fixture(), "hq", "class.create", { name: "已排课程", storeId: "s1", coachId: "c1", type: "力量训练", startAt: "2026-10-29T09:00:00+08:00", endAt: "2026-10-29T10:00:00+08:00", capacity: 1, credits: 1, price: 0, room: "共享训练区域" }, NOW);
  const roomOnly = previewSchedule(existing, "hq", payload({ coachIds: ["c3"], sharedRoom: true }), NOW);assert.equal(roomOnly.conflicts.length, 1);assert.equal(roomOnly.conflicts[0].coachId, "c3");
  const before = structuredClone(existing);rejects(() => publish(existing), /冲突/, 409);assert.deepEqual(existing, before);
  const published = publish();
  rejects(() => applyAction(published, "hq", "class.create", { name: "额外单次课", storeId: "s1", coachId: "c1", type: "力量训练", startAt: "2026-10-29T09:00:00+08:00", endAt: "2026-10-29T10:00:00+08:00", capacity: 1, credits: 1, price: 0, room: "另一场地" }, NOW), /已有课程|冲突/);
});

test("两种排课模式均允许不共享场地的单教练预览和发布，未确认共享时拒绝多人", () => {
  for (const { mode, capacity, endTime, expectedSlots } of [
    { mode: "recurring", capacity: 8, endTime: "10:00", expectedSlots: 1 },
    { mode: "availability", capacity: 1, endTime: "12:00", expectedSlots: 2 },
  ] as const) {
    const data = fixture(), before = structuredClone(data);
    const single = payload({ mode, coachIds: ["c1"], sharedRoom: false, capacity, endTime });
    const preview = previewSchedule(data, "hq", single, NOW);
    assert.equal(preview.coachCount, 1, mode);assert.equal(preview.slotCount, expectedSlots, mode);
    assert.deepEqual(preview.conflicts, [], mode);assert.deepEqual(data, before, mode);
    const published = publish(data, single), plan = published.schedulePlans![0];
    assert.deepEqual(plan.coachIds, ["c1"], mode);assert.equal(plan.sharedRoom, false, mode);
    assert.equal(published.classes.length, expectedSlots, mode);
    assert.ok(published.classes.every(cls => cls.coachId === "c1" && cls.capacity === capacity && cls.schedulePlanId === plan.id), mode);
    assertInvariants(published);
    const multiple = { ...single, coachIds: ["c1", "c3"] };
    rejects(() => previewSchedule(data, "hq", multiple, NOW), /确认|场地/);
    rejects(() => publish(data, multiple), /确认|场地/);
    assert.deepEqual(data, before, `${mode} 拒绝多人后不改变原数据`);
  }
});

test("任何教练不合格或越界都拒绝整批，多选字段不容重复或矛盾", () => {
  for (const p of [payload({ coachIds: [] }), payload({ coachIds: ["c1", "c1"] }), payload({ coachIds: ["c1", " c1 "] }), payload({ coachIds: Array.from({ length: 21 }, (_, index) => `coach-${index}`) }), payload({ coachId: "c3" })]) rejects(() => publish(fixture(), p), /教练|重复|一致/);
  const expired = fixture();expired.coaches.find(coach => coach.id === "c3")!.certificateExpiresAt = "2026-10-28";const before = structuredClone(expired);
  rejects(() => publish(expired), /资质/);assert.deepEqual(expired, before);
  const pending = fixture();pending.coaches.find(coach => coach.id === "c3")!.status = "pending";rejects(() => publish(pending), /尚未通过/);
  const wrongSubject = fixture();wrongSubject.coaches.find(coach => coach.id === "c3")!.specialty = "瑜伽";rejects(() => publish(wrongSubject), /教学资格/);
  rejects(() => publish(fixture(), payload({ coachIds: ["c1", "c2"] })), /授权|自己/, 403);
  rejects(() => publish(fixture(), payload(), "coach"), /自己|授权/, 403);
  rejects(() => publish(fixture(), payload(), "student"), /无权/, 403);
});

test("总发布上限包含全部教练，同一教练旧字段与新单元素数组兼容", () => {
  const preview = previewSchedule(fixture(), "hq", payload({ coachIds: ["c1"], coachId: "c1", sharedRoom: false }), NOW);assert.equal(preview.coachCount, 1);assert.equal(preview.slotCount, 2);
  const legacy = publish(fixture(), payload({ coachIds: undefined, coachId: "c1", sharedRoom: undefined }));assert.deepEqual(legacy.schedulePlans![0].coachIds, ["c1"]);assert.equal(legacy.classes.length, 2);
  rejects(() => publish(fixture(), payload({ startDate: "2026-10-29", endDate: "2026-11-01", weekdays: [4, 5, 6, 7], startTime: "08:00", endTime: "20:00", durationMinutes: 15, gapMinutes: 0 })), /256/);
});

test("学员选择的教练写入预约，不能篡改或跨教练重复占用同一时间", () => {
  const data = publish(), first = data.classes.find(cls => cls.coachId === "c1")!, second = data.classes.find(cls => cls.coachId === "c3")!;
  rejects(() => applyAction(data, "student", "booking.create", { classId: first.id, coachId: "c3", cardId: "card1", memberId: "m1" }, NOW), /所选教练/);
  const firstReserved = applyAction(data, "student", "booking.create", { classId: first.id, coachId: "c1", cardId: "card1", memberId: "m1" }, NOW);
  assert.equal(firstReserved.bookings[0].coachId, "c1");assert.equal(firstReserved.cards[0].frozen, 1);
  rejects(() => applyAction(firstReserved, "student", "booking.create", { classId: first.id, coachId: "c3", cardId: "card1", memberId: "m1" }, NOW), /所选教练/);
  rejects(() => applyAction(firstReserved, "student", "booking.create", { classId: second.id, coachId: "c3", cardId: "card1", memberId: "m1" }, NOW), /已有预约/);
  const both = applyAction(firstReserved, memberFour, "booking.create", { classId: second.id, coachId: "c3", cardId: "card4", memberId: "m4" }, NOW);
  assert.equal(both.bookings.length, 2);assert.deepEqual(new Set(both.bookings.map(booking => booking.coachId)), new Set(["c1", "c3"]));assert.equal(both.classes.filter(cls => cls.startAt === first.startAt).reduce((sum, cls) => sum + cls.capacity, 0), 2);
  assert.equal(both.members.find(member => member.id === "m1")!.coachId, data.members.find(member => member.id === "m1")!.coachId, "选课不改动学员负责教练");assertInvariants(both);
});

test("取消某位教练预约仅释放其名额，整计划停用仅管理员可执行", () => {
  let data = publish();const first = data.classes.find(cls => cls.coachId === "c1")!, second = data.classes.find(cls => cls.coachId === "c3")!;
  data = applyAction(data, "student", "booking.create", { classId: first.id, coachId: "c1", cardId: "card1", memberId: "m1" }, NOW);
  data = applyAction(data, memberFour, "booking.create", { classId: second.id, coachId: "c3", cardId: "card4", memberId: "m4" }, NOW);
  const firstBooking = data.bookings.find(booking => booking.coachId === "c1")!;
  const cancelled = applyAction(data, "student", "booking.cancel", { id: firstBooking.id }, NOW);
  assert.equal(cancelled.cards.find(card => card.id === "card1")!.frozen, 0);assert.equal(cancelled.cards.find(card => card.id === "card4")!.frozen, 1);assert.equal(cancelled.bookings.find(booking => booking.coachId === "c3")!.status, "reserved");
  const id = data.schedulePlans![0].id, before = structuredClone(cancelled);rejects(() => applyAction(cancelled, "coach", "schedule.cancel", { id, reason: "本人调整" }, NOW), /多教练/, 403);rejects(() => applyAction(cancelled, secondCoach, "schedule.cancel", { id, reason: "本人调整" }, NOW), /多教练/, 403);assert.deepEqual(cancelled, before);
  const stopped = applyAction(cancelled, "manager", "schedule.cancel", { id, reason: "门店统一调整多教练安排" }, NOW);assert.equal(stopped.schedulePlans![0].status, "cancelled");assert.ok(stopped.classes.every(cls => cls.status === "cancelled"));assert.ok(stopped.cards.every(card => card.frozen === 0));assertInvariants(stopped);
});

test("共享计划投影包含本人而课次预约仅本人，旧预约可缺教练字段，新预约不可伪造", () => {
  let data = publish();const second = data.classes.find(cls => cls.coachId === "c3")!;
  data = applyAction(data, "student", "booking.create", { classId: second.id, coachId: "c3", cardId: "card1", memberId: "m1" }, NOW);
  const view = projectWorkspace(data, secondCoach, 1);assert.equal(view.data.schedulePlans!.length, 1);assert.ok(view.data.classes.every(cls => cls.coachId === "c3"));assert.ok(view.data.bookings.every(booking => booking.coachId === "c3"));
  const firstView = projectWorkspace(data, "coach", 1);assert.equal(firstView.data.schedulePlans!.length, 1);assert.equal(firstView.data.bookings.length, 0);
  const legacy = structuredClone(data);delete legacy.bookings[0].coachId;assertInvariants(legacy);
  const forged = structuredClone(data);forged.bookings[0].coachId = "c1";rejects(() => assertInvariants(forged), /所选教练/, 409);
  const forgedClass = structuredClone(data);forgedClass.classes[0].coachId = "c2";rejects(() => assertInvariants(forgedClass), /计划不一致/, 409);
});
