import type { Card, CardCourseOption, CardCourseRule, ClassSession, WorkspaceData } from "./types";

export class CardCourseError extends Error { constructor(message: string, public status = 400) { super(message); this.name = "CardCourseError"; } }
export interface CardCourseContext { tenantId: string; storeId: string; scope: Card["scope"]; }
export function normalizeCourseText(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(); }
export function cardCourseKey(course: Pick<ClassSession, "name" | "type">): string { return JSON.stringify([normalizeCourseText(course.name), normalizeCourseText(course.type)]); }
function display(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/g, " "); }
function validCourse(course: unknown): course is CardCourseRule {
  if (!course || typeof course !== "object" || Array.isArray(course)) return false;
  const value = course as Record<string, unknown>;
  return typeof value.name === "string" && !!value.name.trim() && value.name.length <= 60 && typeof value.type === "string" && !!value.type.trim() && value.type.length <= 40;
}
export function validCardCourseRules(value: unknown): value is CardCourseRule[] { return Array.isArray(value) && value.length >= 1 && value.length <= 20 && value.every(validCourse) && new Set(value.map(cardCourseKey)).size === value.length; }
type CardCourseConfig = Pick<Card, "classTypes" | "courseMode" | "courseRules">;
function validAllCourses(card: CardCourseConfig): boolean { return Array.isArray(card.classTypes) && card.classTypes.length === 0 && !Object.hasOwn(card, "courseRules"); }
/** Explicit all-course mode never comes from a missing or damaged selected rule set. */
export function matchesCardCourse(card: CardCourseConfig, course: Pick<ClassSession, "name" | "type">): boolean {
  if (Object.hasOwn(card, "courseMode")) {
    if (card.courseMode === "all") return validAllCourses(card);
    if (card.courseMode !== "selected" || !Object.hasOwn(card, "courseRules")) return false;
  }
  if (Object.hasOwn(card, "courseRules")) return validCardCourseRules(card.courseRules) && validCourse(course) && card.courseRules.some(rule => cardCourseKey(rule) === cardCourseKey(course));
  return Array.isArray(card.classTypes) && card.classTypes.includes(course.type);
}
export function cardCourseLabels(card: CardCourseConfig): string[] {
  if (Object.hasOwn(card, "courseMode")) {
    if (card.courseMode === "all") return validAllCourses(card) ? ["全部课程"] : ["课程范围待核对"];
    if (card.courseMode !== "selected" || !Object.hasOwn(card, "courseRules")) return ["课程范围待核对"];
  }
  if (Object.hasOwn(card, "courseRules")) return validCardCourseRules(card.courseRules) ? card.courseRules.map(rule => `${rule.name} · ${rule.type}`) : ["课程范围待核对"];
  return Array.isArray(card.classTypes) ? card.classTypes : ["课程范围待核对"];
}
function inScope(data: WorkspaceData, course: ClassSession, context: CardCourseContext): boolean {
  if (course.tenantId !== context.tenantId) return false;
  const solo = data.tenants.some(tenant => tenant.id === context.tenantId && tenant.mode === "solo");
  return solo ? context.storeId === "" && course.storeId === "" : context.scope === "all" || course.storeId === context.storeId;
}
/** A course is its canonical name and subject across dates and coaches, within the card's store scope. */
export function buildCardCourseOptions(data: WorkspaceData, context: CardCourseContext): CardCourseOption[] {
  const groups = new Map<string, CardCourseOption>();
  for (const course of data.classes.filter(course => course.status === "scheduled" && inScope(data, course, context) && validCourse(course)).sort((a, b) => a.id.localeCompare(b.id))) {
    const key = cardCourseKey(course), storeName = course.storeId ? data.stores.find(store => store.id === course.storeId && store.tenantId === course.tenantId)?.name || "历史门店" : "独立训练空间";
    const existing = groups.get(key);
    if (existing) { existing.sessionCount++;if (!existing.storeNames.includes(storeName)) existing.storeNames.push(storeName); }
    else groups.set(key, { id: course.id, name: display(course.name), type: display(course.type), storeNames: [storeName], sessionCount: 1 });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type)).map(option => ({ ...option, storeNames: option.storeNames.sort((a, b) => a.localeCompare(b)) }));
}
/** Resolve reference IDs from full authoritative data. Client-supplied labels are never trusted. */
export function resolveCardCourses(data: WorkspaceData, context: CardCourseContext, input: unknown): { courseMode: "all"; classTypes: []; courseRules?: never } | { courseMode: "selected"; courseRules: CardCourseRule[]; classTypes: string[] } {
  if (!Array.isArray(input) || input.length > 20 || input.some(value => typeof value !== "string" || !value.trim() || value.trim().length > 191)) throw new CardCourseError("适用课程可留空，或选择最多 20 门已创建的课程。");
  if (!input.length) return { courseMode: "all", classTypes: [] };
  const ids = (input as string[]).map(value => value.trim());
  if (new Set(ids).size !== ids.length) throw new CardCourseError("不能重复选择同一课程记录。");
  const rules = new Map<string, CardCourseRule>();
  for (const id of ids) {
    const course = data.classes.find(item => item.id === id);
    if (!course) throw new CardCourseError("所选课程不存在，请刷新课程列表后重新选择。", 404);
    if (!inScope(data, course, context)) throw new CardCourseError("所选课程不属于当前品牌或课卡适用门店。", 403);
    if (course.status !== "scheduled" || !validCourse(course)) throw new CardCourseError("所选课程已取消或信息无效，请刷新后重新选择。");
    const rule = { name: display(course.name), type: display(course.type) };
    if (!validCourse(rule)) throw new CardCourseError("课程名称或科目规范化后过长，请先核对课程资料。");
    rules.set(cardCourseKey(course), rule);
  }
  const courseRules = [...rules.values()].sort((a, b) => cardCourseKey(a).localeCompare(cardCourseKey(b)));
  return { courseMode: "selected", courseRules, classTypes: [...new Set(courseRules.map(rule => rule.type))] };
}
