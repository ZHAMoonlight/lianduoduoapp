import test from "node:test";
import assert from "node:assert/strict";
import { applyAction, assertInvariants, DomainError, getPersona } from "../lib/domain";
import { OperationError } from "../lib/operations";
import { buildCardCourseOptions, CardCourseError, cardCourseKey, cardCourseLabels, matchesCardCourse, resolveCardCourses } from "../lib/card-courses";
import { createSeed } from "../lib/seed";
import type { Card, ClassSession, WorkspaceData } from "../lib/types";

const NOW = new Date("2026-10-29T02:00:00Z");
function fixture(): WorkspaceData {
  const data = createSeed(NOW);data.bookings = [];data.audit = [];data.ledger = [];data.orders = [];data.settlements = [];data.cards.forEach(card => { card.frozen = 0; });
  data.coaches.find(coach => coach.id === "c3")!.specialty = "力量训练";data.coaches.find(coach => coach.id === "c2")!.specialty = "力量训练";
  const course = (id: string, extra: Partial<ClassSession> = {}): ClassSession => ({ id, tenantId: "t1", storeId: "s1", coachId: "c1", name: "Train A", type: "力量训练", startAt: "2026-10-30T09:00:00+08:00", endAt: "2026-10-30T10:00:00+08:00", capacity: 8, credits: 1, price: 99999, room: "A 区", status: "scheduled", ...extra });
  data.classes = [course("ref-a"), course("ref-b", { name: "Ｔｒａｉｎ  Ａ", startAt: "2026-10-31T09:00:00+08:00", endAt: "2026-10-31T10:00:00+08:00" }), course("ref-c", { coachId: "c3" }), course("ref-d", { name: "Train B" }), course("ref-e", { storeId: "s2", coachId: "c2" }), course("ref-f", { tenantId: "t2", storeId: "s4", name: "外品牌课程" }), course("ref-g", { name: "已取消课程", status: "cancelled" }), course("ref-h", { type: "功能训练" })];
  return data;
}
function payload(extra: Record<string, unknown> = {}) { return { memberId: "m1", storeId: "s1", name: "指定课程课包", total: 5, amount: 10000, expiresAt: "2027-10-29", scope: "home", courseIds: ["ref-a"], ...extra }; }
function issue(data = fixture(), extra: Record<string, unknown> = {}) { return applyAction(data, "hq", "card.issue", payload(extra), NOW); }
function rejects(run: () => unknown, pattern: RegExp, status = 400) { assert.throws(run, error => (error instanceof DomainError || error instanceof OperationError || error instanceof CardCourseError) && error.status === status && pattern.test(error.message)); }

test("课程目录按名称科目规范化去重，不按日期教练重复，也不合并同科目异名", () => {
  const data = fixture(), before = structuredClone(data), context = { tenantId: "t1", storeId: "s1", scope: "home" as const };
  const options = buildCardCourseOptions(data, context), trainA = options.find(item => item.name === "Train A" && item.type === "力量训练")!;
  assert.equal(trainA.id, "ref-a");assert.equal(trainA.sessionCount, 3);assert.deepEqual(trainA.storeNames, ["静安旗舰店"]);assert.ok(options.some(item => item.name === "Train B"));assert.ok(options.some(item => item.name === "Train A" && item.type === "功能训练"));assert.ok(!options.some(item => item.name === "已取消课程" || item.name === "外品牌课程"));
  const all = buildCardCourseOptions(data, { ...context, scope: "all" }).find(item => item.name === "Train A" && item.type === "力量训练")!;assert.equal(all.sessionCount, 4);assert.equal(all.storeNames.length, 2);assert.deepEqual(data, before);
});

test("服务端以代表课次生成精确规则快照，派生科目且同课程多ID合为一门", () => {
  const data = fixture(), resolved = resolveCardCourses(data, { tenantId: "t1", storeId: "s1", scope: "home" }, ["ref-a", "ref-b", "ref-d"]);
  assert.equal(resolved.courseMode, "selected");assert.ok(resolved.courseRules);assert.equal(resolved.courseRules.length, 2);assert.deepEqual(resolved.classTypes, ["力量训练"]);
  const issued = issue(data, { courseIds: ["ref-a", "ref-b"] });assert.equal(issued.cards[0].courseMode, "selected");assert.equal(issued.cards[0].courseRules!.length, 1);assert.equal(cardCourseKey(issued.cards[0].courseRules![0]), cardCourseKey(data.classes[0]));assert.deepEqual(issued.cards[0].classTypes, ["力量训练"]);assert.equal(issued.orders.length, 1);assert.equal(issued.ledger[0].type, "issue");
});

test("精确课程卡可约不同日期和教练的同课程，但同科目异课程与同名异科目均拒绝", () => {
  const issued = issue(), card = issued.cards[0];
  for (const classId of ["ref-a", "ref-b", "ref-c"]) { const result = applyAction(issued, "student", "booking.create", { classId, cardId: card.id, memberId: "m1" }, NOW);assert.equal(result.cards[0].frozen, 1); }
  for (const classId of ["ref-d", "ref-h"]) rejects(() => applyAction(issued, "student", "booking.create", { classId, cardId: card.id, memberId: "m1" }, NOW), /课程|科目/);
  assert.deepEqual(cardCourseLabels(card), ["Train A · 力量训练"]);
});

test("原门店范围继续优先，通用卡仅在同品牌相同课程跨店适用", () => {
  const home = issue(), homeCard = home.cards[0];rejects(() => applyAction(home, "student", "booking.create", { classId: "ref-e", cardId: homeCard.id, memberId: "m1" }, NOW), /开卡门店/);
  rejects(() => issue(fixture(), { courseIds: ["ref-e"] }), /门店/, 403);rejects(() => issue(fixture(), { courseIds: ["ref-f"], scope: "all" }), /品牌|门店/, 403);
  const all = issue(fixture(), { courseIds: ["ref-e"], scope: "all" });assert.equal(applyAction(all, "student", "booking.create", { classId: "ref-a", cardId: all.cards[0].id, memberId: "m1" }, NOW).bookings.length, 1);
});

test("坏规则存在时永不退回科目，不变量拒绝损坏或扩大的精确范围", () => {
  const issued = issue(), course = issued.classes[0];
  for (const broken of [[], null, undefined, [{ name: "", type: "力量训练" }], [{ name: "Train A", type: "力量训练" }, { name: "Ｔｒａｉｎ Ａ", type: "力量训练" }]]) {
    const card = { ...issued.cards[0], courseRules: broken } as unknown as Card;assert.equal(matchesCardCourse(card, course), false);assert.deepEqual(cardCourseLabels(card), ["课程范围待核对"]);
    const tampered = structuredClone(issued);tampered.cards[0] = card;rejects(() => assertInvariants(tampered), /指定课程/, 409);
  }
  const widened = structuredClone(issued);widened.cards[0].classTypes.push("功能训练");rejects(() => assertInvariants(widened), /派生科目/, 409);
});

test("严格卡续购必须重选课程并创建新快照，不能被旧客户端退回科目宽范围", () => {
  const issued = issue(), original = structuredClone(issued.cards[0]);
  const base = { id: original.id, name: "续购指定课程卡", total: 5, amount: 10000, expiresAt: "2027-11-29", scope: "home" };
  rejects(() => applyAction(issued, "hq", "card.renew", { ...base, classTypes: ["力量训练"] }, NOW), /重新选择|科目范围/);
  rejects(() => applyAction(issued, "hq", "card.renew", base, NOW), /重新选择|科目范围/);
  const renewed = applyAction(issued, "hq", "card.renew", { ...base, courseIds: ["ref-d"] }, NOW);assert.equal(renewed.cards[0].courseRules![0].name, "Train B");assert.deepEqual(renewed.cards.find(card => card.id === original.id), original);assert.equal(renewed.orders.length, 2);
});

test("旧卡和旧开卡接口保持科目范围，旧卡续购也可显式升级精确课程", () => {
  const legacy = issue(fixture(), { courseIds: undefined, classTypes: ["力量训练"] });assert.equal(Object.hasOwn(legacy.cards[0], "courseMode"), false);assert.equal(Object.hasOwn(legacy.cards[0], "courseRules"), false);assert.equal(matchesCardCourse(legacy.cards[0], legacy.classes.find(item => item.id === "ref-d")!), true);
  const base = { id: legacy.cards[0].id, name: "旧卡续购", total: 5, amount: 10000, expiresAt: "2027-11-29", scope: "home" };
  assert.equal(Object.hasOwn(applyAction(legacy, "hq", "card.renew", { ...base, classTypes: ["力量训练"] }, NOW).cards[0], "courseRules"), false);
  const upgraded = applyAction(legacy, "hq", "card.renew", { ...base, courseIds: ["ref-a"] }, NOW);assert.equal(matchesCardCourse(upgraded.cards[0], upgraded.classes.find(item => item.id === "ref-d")!), false);
});

test("不能伪造规则或科目扩大权益，失效越界重复及过量参考课程明确拒绝", () => {
  rejects(() => issue(fixture(), { courseRules: [{ name: "伪造", type: "力量训练" }] }), /自行指定/, 403);
  for (const courseMode of ["all", "selected", undefined, null]) rejects(() => issue(fixture(), { courseMode }), /自行指定/, 403);
  rejects(() => issue(fixture(), { classTypes: ["功能训练"] }), /不一致/);
  for (const courseIds of [null, "ref-a", {}, ["ref-a", "ref-a"], Array.from({ length: 21 }, (_, index) => `ref-${index}`)]) rejects(() => issue(fixture(), { courseIds }), /选择|重复/);
  for (const classTypes of [null, "力量训练", {}, [null]]) rejects(() => issue(fixture(), { courseIds: [], classTypes }), /不一致/);
  for (const classTypes of [null, "力量训练", {}, [], [null]]) rejects(() => issue(fixture(), { courseIds: undefined, classTypes }), /有效适用科目/);
  rejects(() => issue(fixture(), { courseIds: ["missing"] }), /不存在/, 404);rejects(() => issue(fixture(), { courseIds: ["ref-g"] }), /取消|无效/);
});

test("课程改名不重写课卡快照，也不再包含改名后的另一名称", () => {
  const issued = issue(), snapshot = structuredClone(issued.cards[0].courseRules);issued.classes[0].name = "新课程名称";
  assert.deepEqual(issued.cards[0].courseRules, snapshot);assert.equal(matchesCardCourse(issued.cards[0], issued.classes[0]), false);assert.equal(matchesCardCourse(issued.cards[0], issued.classes[1]), true);
});

test("独立空间课程目录和开卡无门店，不会混入原机构同tenant残留门店课次", () => {
  const data = fixture();data.tenants[0].mode = "solo";data.coaches[0].storeId = "";data.coaches[0].selfManaged = true;data.classes[0].storeId = "";
  const options = buildCardCourseOptions(data, { tenantId: "t1", storeId: "", scope: "all" });assert.equal(options.length, 1);assert.equal(options[0].sessionCount, 1);
  const owner = { ...getPersona("hq"), coachId: "c1", workspaceMode: "solo" };
  const issued = applyAction(data, owner, "card.issue", payload({ storeId: "", courseIds: ["ref-a"] }), NOW);assert.equal(issued.cards[0].storeId, "");assert.equal(issued.cards[0].courseRules!.length, 1);
});

test("适用课程选填，空选或缺省时无需已有课程即可开出明确全部课程卡", () => {
  const data = fixture();data.classes = [];
  assert.deepEqual(resolveCardCourses(data, { tenantId: "t1", storeId: "s1", scope: "home" }, []), { courseMode: "all", classTypes: [] });
  const omitted: Record<string, unknown> = payload();delete omitted.courseIds;
  for (const input of [payload({ courseIds: [] }), omitted]) {
    const issued = applyAction(data, "hq", "card.issue", input, NOW), card = issued.cards[0];
    assert.equal(card.courseMode, "all");assert.deepEqual(card.classTypes, []);assert.equal(Object.hasOwn(card, "courseRules"), false);assert.deepEqual(cardCourseLabels(card), ["全部课程"]);assert.equal(issued.orders.length, 1);assert.equal(issued.ledger[0].type, "issue");assertInvariants(issued);
  }
});

test("全部课程卡可预约日后新增的课程科目，原门店品牌有效期与余额限制仍生效", () => {
  const data = fixture(), reference = structuredClone(data.classes[0]);data.classes = [];
  const issued = issue(data, { courseIds: [] }), card = issued.cards[0];
  issued.coaches.find(coach => coach.id === "c1")!.specialty += "、功能训练";
  const future = { ...reference, id: "future-new-course", name: "开卡后新建的课程", type: "功能训练" };issued.classes.push(future);
  const book = (source: WorkspaceData, classId = future.id) => applyAction(source, "student", "booking.create", { classId, cardId: card.id, memberId: "m1" }, NOW);
  assert.equal(book(issued).cards[0].frozen, 1);
  const crossStore = { ...reference, id: "other-store", storeId: "s2", coachId: "c2" };issued.classes.push(crossStore);rejects(() => book(issued, crossStore.id), /开卡门店/);
  const crossTenant = { ...reference, id: "other-brand", tenantId: "t2", storeId: "s4" };issued.classes.push(crossTenant);rejects(() => book(issued, crossTenant.id), /品牌/, 403);
  const expired = structuredClone(issued);expired.cards[0].expiresAt = "2026-10-29";rejects(() => book(expired), /过期/);
  const insufficient = structuredClone(issued);insufficient.cards[0].remaining = 0;rejects(() => book(insufficient), /课时不足/);
  const frozen = structuredClone(issued);frozen.cards[0].status = "frozen";rejects(() => book(frozen), /冻结/);
  const universal = issue(fixture(), { courseIds: [], scope: "all" });assert.equal(applyAction(universal, "student", "booking.create", { classId: "ref-e", cardId: universal.cards[0].id, memberId: "m1" }, NOW).cards[0].frozen, 1);
});

test("清空指定课程是明确续购新全部课程卡，历史精确卡范围保持不变", () => {
  const issued = issue(), original = structuredClone(issued.cards[0]);
  const base = { id: original.id, name: "全部课程续购卡", total: 5, amount: 10000, expiresAt: "2027-11-29", scope: "home" };
  const renewed = applyAction(issued, "hq", "card.renew", { ...base, courseIds: [] }, NOW), card = renewed.cards[0];
  assert.equal(card.courseMode, "all");assert.deepEqual(card.classTypes, []);assert.equal(Object.hasOwn(card, "courseRules"), false);assert.equal(matchesCardCourse(card, renewed.classes.find(course => course.id === "ref-d")!), true);assert.equal(matchesCardCourse(original, renewed.classes.find(course => course.id === "ref-d")!), false);assert.deepEqual(renewed.cards.find(item => item.id === original.id), original);
  const again = applyAction(renewed, "hq", "card.renew", { ...base, id: card.id }, NOW);assert.equal(again.cards[0].courseMode, "all");assert.equal(Object.hasOwn(again.cards[0], "courseRules"), false);
});

test("全部模式必须完整合法，坏模式坏规则与无模式空科目绝不能扩大为全部课程", () => {
  const source = issue(fixture(), { courseIds: [] }), base = source.cards[0], course = source.classes[0];
  const configs: Record<string, unknown>[] = [
    { courseMode: undefined, classTypes: [] }, { courseMode: null, classTypes: [] }, { courseMode: "anything", classTypes: [] },
    { courseMode: "all", classTypes: ["力量训练"] }, { courseMode: "all", classTypes: null }, { courseMode: "selected", classTypes: ["力量训练"] },
    ...[[], null, undefined, [{ name: "Train A", type: "力量训练" }]].map(courseRules => ({ courseMode: "all", classTypes: [], courseRules })),
    { courseMode: "selected", classTypes: [], courseRules: [] },
  ];
  for (const config of configs) {
    const card = { ...base, ...config } as unknown as Card;
    assert.equal(matchesCardCourse(card, course), false);assert.deepEqual(cardCourseLabels(card), ["课程范围待核对"]);
    const invalid = structuredClone(source);invalid.cards[0] = card;rejects(() => assertInvariants(invalid), /课程|适用/, 409);
  }
  const legacy = { ...base };delete legacy.courseMode;assert.equal(matchesCardCourse(legacy, course), false);
  const brokenLegacy = { ...legacy, classTypes: ["力量训练"], courseRules: [] };assert.equal(matchesCardCourse(brokenLegacy, course), false);assert.deepEqual(cardCourseLabels(brokenLegacy), ["课程范围待核对"]);
});
