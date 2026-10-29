import test from "node:test";
import assert from "node:assert/strict";
import { applyAction, assertInvariants, DomainError, getPersona, previewSchedule, projectWorkspace } from "../lib/domain";
import { normalizeVenueName } from "../lib/venues";
import { createSeed } from "../lib/seed";
import type { ActionName, Persona, SchedulePlanPublishPayload, WorkspaceData } from "../lib/types";

const NOW = new Date("2026-10-28T02:00:00Z");
function fixture() {
  const data = createSeed(NOW);data.classes = [];data.bookings = [];data.audit = [];data.ledger = [];data.settlements = [];
  data.cards.forEach(card => { card.frozen = 0; });data.coaches.find(coach => coach.id === "c3")!.specialty = "力量训练";
  return data;
}
function act(data: WorkspaceData, action: ActionName, payload: unknown, actor: Persona | string = "hq", now = NOW) { return applyAction(data, actor, action, payload, now); }
function rejects(run: () => unknown, pattern: RegExp, status = 400) { assert.throws(run, error => error instanceof DomainError && error.status === status && pattern.test(error.message)); }
function create(data = fixture(), fields: Record<string, unknown> = {}) { const result = act(data, "venue.create", { storeId: "s1", name: "A 区", ...fields });return { data: result, id: result.venues!.at(-1)!.id }; }
function plan(venueId?: string, extra: Partial<SchedulePlanPublishPayload> = {}): SchedulePlanPublishPayload { return { mode: "availability", name: "场地训练", type: "力量训练", storeId: "s1", coachIds: ["c1"], sharedRoom: false, startDate: "2026-10-29", endDate: "2026-10-29", weekdays: [4], startTime: "09:00", endTime: "12:00", durationMinutes: 60, gapMinutes: 15, capacity: 1, credits: 1, price: 0, ...(venueId ? { venueId } : { room: "A 区" }), ...extra }; }
function single(venueId?: string, extra: Record<string, unknown> = {}) { return { name: "场地课程", storeId: "s1", coachId: "c1", type: "力量训练", startAt: "2026-10-29T09:00:00+08:00", endAt: "2026-10-29T10:00:00+08:00", capacity: 1, credits: 1, price: 0, ...(venueId ? { venueId } : { room: "A 区" }), ...extra }; }

test("场地按品牌门店授权管理，同名规范化去重并禁止修改归属", () => {
  const original = fixture(), before = structuredClone(original);
  const { data, id } = create(original, { name: "  Ａ   区  ", location: "二楼", description: "真实训练区" });
  assert.equal(data.venues![0].name, "A 区");assert.equal(data.venues![0].allowShared, false);assert.equal(data.venues![0].status, "active");assert.equal(normalizeVenueName(" Ａ  区 "), "a 区");assert.deepEqual(original, before);
  rejects(() => create(data, { name: "a 区" }), /同名/, 409);
  rejects(() => act(data, "venue.update", { id, storeId: "s2" }), /不能修改/, 403);
  rejects(() => act(data, "venue.create", { storeId: "s2", name: "其他店" }, "manager"), /本门店/, 403);
  rejects(() => act(data, "venue.update", { id }, { ...getPersona("hq"), tenantId: "t2" }), /其他品牌/, 403);
  for (const actor of ["coach", "student", "platform"]) rejects(() => act(data, "venue.update", { id, name: "越权" }, actor), /无权/, 403);
  for (const fields of [{ name: " " }, { name: "x".repeat(61) }, { allowShared: "true" }, { location: "x".repeat(161) }, { description: "x".repeat(501) }]) rejects(() => create(data, fields), /场地|填写/);
  const manager = act(data, "venue.update", { id, allowShared: true, location: "三楼" }, "manager");assert.equal(manager.venues![0].allowShared, true);assert.equal(manager.venues![0].location, "三楼");
});

test("独立教练可管理无门店场地，同名场地跨门店互不混淆", () => {
  const data = fixture();data.tenants[0].mode = "solo";data.coaches[0].storeId = "";data.coaches[0].selfManaged = true;
  const owner: Persona = { ...getPersona("hq"), coachId: "c1", workspaceMode: "solo" };
  const created = act(data, "venue.create", { name: "户外训练区" }, owner);assert.equal(created.venues![0].storeId, "");
  rejects(() => act(created, "venue.create", { storeId: "s1", name: "越界" }, owner), /没有门店/, 403);
  const changed = act(created, "venue.update", { id: created.venues![0].id, name: "公园", status: "inactive" }, owner);assert.equal(changed.venues![0].status, "inactive");
  const first = create(), second = create(first.data, { storeId: "s2", name: "A 区" });assert.equal(second.data.venues!.length, 2);
  const booked = act(second.data, "class.create", single(first.id));
  const independent = act(booked, "class.create", single(second.id, { storeId: "s2", coachId: "c2", type: "瑜伽普拉提" }));assert.equal(independent.classes.length, 2);
});

test("新场地ID严格验证，旧文本仅能解析本门店已有场地或空场地库", () => {
  const legacy = act(fixture(), "class.create", single());assert.equal(legacy.classes[0].venueId, undefined);
  const { data, id } = create();
  const resolved = act(data, "class.create", single(undefined, { room: "  Ａ  区 " }));assert.equal(resolved.classes[0].venueId, id);assert.equal(resolved.classes[0].room, "A 区");
  rejects(() => act(data, "class.create", single(undefined, { room: "随意新场地" })), /已有|登记/);
  rejects(() => previewSchedule(data, "hq", plan(undefined, { room: "随意新场地" }), NOW), /已有|登记/);
  rejects(() => act(data, "class.create", single("不存在", { room: "A 区" })), /不存在/, 404);
  rejects(() => act(data, "class.create", single(id, { venueId: "", room: "A 区" })), /有效场地/);
  const other = create(data, { storeId: "s2", name: "另一店" });rejects(() => previewSchedule(other.data, "hq", plan(other.id), NOW), /当前训练空间|门店/, 403);
  const inactive = act(data, "venue.update", { id, status: "inactive" });
  rejects(() => previewSchedule(inactive, "hq", plan(id), NOW), /停用/);rejects(() => act(inactive, "class.create", single()), /停用/);
});

test("场地改名保留课次和计划快照，冲突以稳定ID判断且不同ID可复用旧名", () => {
  const { data, id } = create();const published = act(data, "schedule.publish", plan(id));
  const renamed = act(published, "venue.update", { id, name: "B 区" });assert.equal(renamed.schedulePlans![0].room, "A 区");assert.ok(renamed.classes.every(cls => cls.room === "A 区" && cls.venueId === id));
  assert.ok(previewSchedule(renamed, "hq", plan(id, { coachIds: ["c3"] }), NOW).conflicts.length);
  rejects(() => act(renamed, "class.create", single(id, { coachId: "c3" })), /场地|课程/);
  const replacement = create(renamed, { name: "A 区" });
  const independent = act(replacement.data, "class.create", single(replacement.id, { coachId: "c3" }));assert.equal(independent.classes.at(-1)!.venueId, replacement.id);assert.equal(independent.classes.at(-1)!.room, "A 区");
});

test("无人预约的课次也占场地，预约取消不释放整课而课程取消释放占用", () => {
  const { data, id } = create();const published = act(data, "class.create", single(id)), cls = published.classes[0];
  const reserved = act(published, "booking.create", { classId: cls.id, cardId: "card1", memberId: "m1" }, "student");
  const cancelledBooking = act(reserved, "booking.cancel", { id: reserved.bookings[0].id }, "student");
  rejects(() => act(cancelledBooking, "class.create", single(id, { coachId: "c3" })), /场地|课程/);
  rejects(() => act(cancelledBooking, "venue.update", { id, status: "inactive" }), /未来|正在进行/, 409);
  const cancelledClass = act(cancelledBooking, "class.cancel", { id: cls.id, reason: "取消授课" });
  assert.equal(act(cancelledClass, "class.create", single(id, { coachId: "c3" })).classes.length, 2);
  const stopped = act(cancelledClass, "venue.update", { id, status: "inactive" });assert.equal(stopped.venues![0].status, "inactive");
});

test("场地占用边界按真实课次，接壤和空闲间隔可排课，进行中课程阻止停用", () => {
  const { data, id } = create();const published = act(data, "schedule.publish", plan(id));
  const gap = act(published, "class.create", single(id, { coachId: "c3", startAt: "2026-10-29T10:00:00+08:00", endAt: "2026-10-29T10:15:00+08:00" }));assert.equal(gap.classes.length, 3);
  const touching = act(gap, "class.create", single(id, { coachId: "c3", startAt: "2026-10-29T08:00:00+08:00", endAt: "2026-10-29T09:00:00+08:00" }));assert.equal(touching.classes.length, 4);
  rejects(() => act(touching, "venue.update", { id, status: "inactive" }, "hq", new Date("2026-10-29T01:30:00Z")), /未来|正在进行/, 409);
  const afterEnd = act(touching, "venue.update", { id, status: "inactive" }, "hq", new Date("2026-10-29T04:00:00Z"));assert.equal(afterEnd.venues![0].status, "inactive");
});

test("两种模式多教练必须场地允许且主动确认，共享不豁免其他计划冲突", () => {
  for (const mode of ["recurring", "availability"] as const) {
    const { data, id } = create();const p = plan(id, { mode, coachIds: ["c1", "c3"], sharedRoom: true });
    rejects(() => previewSchedule(data, "hq", p, NOW), /不允许|并行/);
    const shared = act(data, "venue.update", { id, allowShared: true });
    rejects(() => act(shared, "schedule.publish", { ...p, sharedRoom: false }), /确认|场地/);
    const published = act(shared, "schedule.publish", p);assert.equal(published.classes.length, mode === "availability" ? 4 : 2);assert.ok(published.classes.every(cls => cls.venueId === id));assertInvariants(published);
    assert.ok(previewSchedule(published, "hq", p, NOW).conflicts.length);rejects(() => act(published, "schedule.publish", p), /冲突/, 409);
  }
});

test("仍有未来或进行中多人重叠授课时不能改为独占，单人和已结束取消不受限制", () => {
  const { data, id } = create(fixture(), { allowShared: true });
  const published = act(data, "schedule.publish", plan(id, { mode: "recurring", coachIds: ["c1", "c3"], sharedRoom: true, endTime: "10:00" }));
  const before = structuredClone(published);
  for (const now of [NOW, new Date("2026-10-29T01:30:00Z")]) rejects(() => act(published, "venue.update", { id, allowShared: false }, "hq", now), /先调整|独占/, 409);
  assert.deepEqual(published, before);
  const oneRemaining = act(published, "class.cancel", { id: published.classes[1].id, reason: "调整授课人" });
  assert.equal(act(oneRemaining, "venue.update", { id, allowShared: false }).venues![0].allowShared, false);
  const stopped = act(published, "schedule.cancel", { id: published.schedulePlans![0].id, reason: "取消多人训练" });
  assert.equal(act(stopped, "venue.update", { id, allowShared: false }).venues![0].allowShared, false);
  assert.equal(act(published, "venue.update", { id, allowShared: false }, "hq", new Date("2026-10-29T02:00:00Z")).venues![0].allowShared, false);
  const sequential = act(oneRemaining, "class.create", single(id, { coachId: "c3", startAt: "2026-10-29T10:00:00+08:00", endAt: "2026-10-29T11:00:00+08:00" }));
  assert.equal(act(sequential, "venue.update", { id, allowShared: false }).venues![0].allowShared, false);
});

test("登记场地补绑定同名旧课次与计划，混合旧快照仍冲突且改名不丢失关联", () => {
  const legacy = act(fixture(), "schedule.publish", plan());const { data, id } = create(legacy);
  assert.equal(data.schedulePlans![0].venueId, id);assert.ok(data.classes.every(cls => cls.venueId === id && cls.room === "A 区"));
  const mixed = structuredClone(data);mixed.classes.forEach(cls => { delete cls.venueId; });delete mixed.schedulePlans![0].venueId;
  assert.ok(previewSchedule(mixed, "hq", plan(id, { coachIds: ["c3"] }), NOW).conflicts.length);
  const renamed = act(mixed, "venue.update", { id, name: "新名字" });assert.ok(renamed.classes.every(cls => cls.venueId === id && cls.room === "A 区"));assert.equal(renamed.schedulePlans![0].venueId, id);
  assert.ok(previewSchedule(renamed, "hq", plan(id, { coachIds: ["c3"] }), NOW).conflicts.length);
  const legacyInput = previewSchedule(data, "hq", plan(undefined, { coachIds: ["c3"], room: "A 区" }), NOW);assert.ok(legacyInput.items.every(item => item.venueId === id));assert.ok(legacyInput.conflicts.length);
});

test("已有旧文本多人并行授课时不能登记为独占场地，需主动共享或先调整课程", () => {
  const legacy = act(fixture(), "schedule.publish", plan(undefined, { mode: "recurring", coachIds: ["c1", "c3"], sharedRoom: true, endTime: "10:00" })), before = structuredClone(legacy);
  for (const now of [NOW, new Date("2026-10-29T01:30:00Z")]) rejects(() => act(legacy, "venue.create", { storeId: "s1", name: "Ａ  区" }, "hq", now), /允许共享|先调整/, 409);
  assert.deepEqual(legacy, before);
  const shared = create(legacy, { allowShared: true });assert.ok(shared.data.classes.every(cls => cls.venueId === shared.id));assert.equal(shared.data.venues![0].allowShared, true);
  const singleLegacy = act(fixture(), "schedule.publish", plan());assert.equal(create(singleLegacy).data.venues![0].allowShared, false);
  const stopped = act(legacy, "schedule.cancel", { id: legacy.schedulePlans![0].id, reason: "取消旧共享课程" });assert.equal(create(stopped).data.venues![0].allowShared, false);
  assert.equal(act(legacy, "venue.create", { storeId: "s1", name: "A 区" }, "hq", new Date("2026-10-29T02:00:00Z")).venues![0].allowShared, false);
});

test("场地投影隔离品牌门店，学员不获得内部场地清单，归属不变量防篡改", () => {
  const first = create(), second = create(first.data, { storeId: "s2", name: "二店场地" });
  const foreign = act(second.data, "venue.create", { storeId: "s4", name: "其他品牌场地" }, { ...getPersona("hq"), tenantId: "t2" });
  assert.equal(projectWorkspace(foreign, "hq", 1).data.venues!.length, 2);
  for (const actor of ["coach", "manager"]) assert.deepEqual(projectWorkspace(foreign, actor, 1).data.venues!.map(venue => venue.id), [first.id]);
  assert.deepEqual(projectWorkspace(foreign, "student", 1).data.venues, []);
  const tampered = act(first.data, "class.create", single(first.id));tampered.classes[0].venueId = "不存在";rejects(() => assertInvariants(tampered), /场地归属/, 409);
});
