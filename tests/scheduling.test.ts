import assert from "node:assert/strict";
import test from "node:test";
import { schedulingOptions } from "../lib/scheduling";
import type { Coach } from "../lib/types";

function coach(id: string, changes: Partial<Coach> = {}): Coach {
  return { id, tenantId: "brand-a", storeId: "store-a", name: id, specialty: "力量", phone: "13900000000", status: "approved", certificate: "已核验资质", certificateExpiresAt: "2026-11-01", rating: 0, ...changes };
}
const scope = { tenantId: "brand-a", storeId: "store-a", type: "力量", date: "2026-10-28" };

test("待审核与未通过教练保留真实课程科目和受限候选，审核前不可排课", () => {
  const result = schedulingOptions([coach("pending", { status: "pending" }), coach("rejected", { status: "rejected", specialty: "普拉提 / 力量" })], scope);
  assert.deepEqual(result.courseTypes, ["力量", "普拉提"]);
  assert.equal(result.effectiveType, "力量");
  assert.equal(result.coaches.length, 2);
  assert.deepEqual(result.available, []);
  assert.equal(result.coaches.every(item => item.disabled), true);
  assert.match(result.coaches[0].reason, /待审核/);
  assert.match(result.coaches[1].reason, /未通过/);
});

test("证书有效期按所选开课日判断，到期当天有效，之后不可选", () => {
  const source = [coach("date-sensitive")];
  assert.deepEqual(schedulingOptions(source, { ...scope, date: "2026-11-01" }).available.map(item => item.id), ["date-sensitive"]);
  const later = schedulingOptions(source, { ...scope, date: "2026-11-02" });
  assert.deepEqual(later.courseTypes, ["力量"]);
  assert.deepEqual(later.available, []);
  assert.match(later.coaches[0].reason, /上课日期已过期/);
});

test("证书缺失及无效日期有明确不可用原因，不将批准状态当作有效资质", () => {
  const source = [coach("missing", { certificate: " " }), coach("empty-expiry", { certificateExpiresAt: "" }), coach("bad-expiry", { certificateExpiresAt: "2026-02-30" })];
  const result = schedulingOptions(source, scope);
  assert.equal(result.available.length, 0);
  assert.match(result.coaches[0].reason, /未填写资质/);
  assert.match(result.coaches[1].reason, /有效期未完善/);
  assert.match(result.coaches[2].reason, /有效期未完善/);
  const noDate = schedulingOptions([coach("ok")], { ...scope, date: "" });
  assert.equal(noDate.available.length, 0);
  assert.match(noDate.coaches[0].reason, /上课日期/);
});

test("切换课程类型联动对应教练，精确匹配登记科目，不虚构别名", () => {
  const source = [coach("strength"), coach("pilates", { specialty: "普拉提" }), coach("multiple", { specialty: " 力量 · 普拉提、体能，瑜伽/力量 " })];
  const result = schedulingOptions(source, { ...scope, type: "普拉提" });
  assert.deepEqual(result.courseTypes, ["力量", "普拉提", "体能", "瑜伽"]);
  assert.deepEqual(result.available.map(item => item.id), ["pilates", "multiple"]);
  const fallback = schedulingOptions(source, { ...scope, type: "力量训练" });
  assert.equal(fallback.effectiveType, "力量");
  assert.ok(!fallback.courseTypes.includes("力量训练"));
  const empty = schedulingOptions([], scope);
  assert.deepEqual(empty, { courseTypes: [], effectiveType: "", coaches: [], available: [] });
});

test("候选严格限定当前品牌与当前门店，缺少范围不会退回所有教练", () => {
  const source = [coach("own"), coach("other-store", { storeId: "store-b", specialty: "瑜伽" }), coach("other-brand", { tenantId: "brand-b", specialty: "体能" })];
  const result = schedulingOptions(source, scope);
  assert.deepEqual(result.courseTypes, ["力量"]);
  assert.deepEqual(result.available.map(item => item.id), ["own"]);
  assert.deepEqual(schedulingOptions(source, { ...scope, tenantId: undefined }).coaches, []);
  assert.deepEqual(schedulingOptions(source, { ...scope, storeId: undefined }).coaches, []);
  assert.deepEqual(schedulingOptions(source, { ...scope, storeId: "" }).coaches, []);
});

test("独立教练仅本人 selfManaged 档案，无证书也可自定科目，仍需批准且不混用门店教练", () => {
  const source = [coach("self", { storeId: "", selfManaged: true, certificate: "", certificateExpiresAt: "", specialty: "力量" }), coach("other-self", { storeId: "", selfManaged: true }), coach("organization"), coach("other-brand-self", { tenantId: "brand-b", storeId: "", selfManaged: true })];
  const soloScope = { ...scope, storeId: "", soloCoachId: "self", type: "自定义训练" };
  const result = schedulingOptions(source, soloScope);
  assert.equal(result.effectiveType, "自定义训练");
  assert.deepEqual(result.available.map(item => item.id), ["self"]);
  assert.deepEqual(schedulingOptions(source, { ...soloScope, soloCoachId: "organization" }).coaches, []);
  assert.deepEqual(schedulingOptions(source, { ...soloScope, soloCoachId: "other-brand-self" }).coaches, []);
  const pending = schedulingOptions([coach("self", { storeId: "", selfManaged: true, status: "pending" })], soloScope);
  assert.equal(pending.available.length, 0);
  assert.match(pending.coaches[0].reason, /待审核/);
});
