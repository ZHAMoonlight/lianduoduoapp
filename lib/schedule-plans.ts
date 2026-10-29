import type { Persona, SchedulePlan, SchedulePreview, SchedulePreviewItem, WorkspaceData } from "./types";
import { resolveVenue, sameVenue } from "./venues";
import { coachServesStore } from "./coach-stores";

export class SchedulePlanError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = "SchedulePlanError"; }
}
function fail(message: string, status = 400): never { throw new SchedulePlanError(message, status); }
const DAY = 86400000;
const ALLOWED = new Set(["mode", "name", "type", "storeId", "coachId", "coachIds", "sharedRoom", "startDate", "endDate", "weekdays", "startTime", "endTime", "capacity", "durationMinutes", "gapMinutes", "credits", "price", "venueId", "room"]);
function text(p: Record<string, unknown>, key: string, max: number): string {
  const value = typeof p[key] === "string" ? p[key].trim() : "";
  if (!value || value.length > max) fail(`请填写有效的${({name:"课程名称",type:"课程科目",room:"上课地点"} as Record<string,string>)[key] || key}。`);
  return value;
}
function integer(p: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = p[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(`${({capacity:"人数上限",durationMinutes:"单次时长",gapMinutes:"间隔时长",credits:"抵扣课时",price:"展示价格"} as Record<string,string>)[key] || key}须为 ${min} 至 ${max} 的整数。`);
  return value;
}
function date(p: Record<string, unknown>, key: string): string {
  const value = text(p, key, 10);
  if (!validDate(value)) fail("请选择有效的开始和结束日期。");
  return value;
}
function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value; }
function time(p: Record<string, unknown>, key: string): { value: string; minutes: number } {
  const value = text(p, key, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail("请选择有效时间，格式为 HH:mm。");
  return { value, minutes: Number(value.slice(0,2)) * 60 + Number(value.slice(3)) };
}
function stamp(day: string, minutes: number): string { return new Date(`${day}T${String(Math.floor(minutes / 60)).padStart(2,"0")}:${String(minutes % 60).padStart(2,"0")}:00+08:00`).toISOString(); }
function today(now: Date): string { return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0,10); }

export interface PreparedSchedule { plan: Omit<SchedulePlan, "id" | "createdAt" | "status"> & { coachIds: string[]; sharedRoom: boolean }; preview: SchedulePreview; }

/** Generate bounded concrete sessions; validation is also used by the read-only preview. */
export function prepareSchedule(data: WorkspaceData, persona: Persona, input: unknown, now = new Date()): PreparedSchedule {
  if (!["hq", "manager", "coach"].includes(persona.role) || !persona.tenantId) fail("当前身份无权发布或预览排课计划。",403);
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("排课参数无效。");
  const p = input as Record<string,unknown>;
  if (Object.keys(p).some(key => !ALLOWED.has(key))) fail("排课计划包含不能自行指定的字段。",403);
  if (p.mode !== "recurring" && p.mode !== "availability") fail("请选择固定循环课或开放可约时段。");
  const tenant = data.tenants.find(item => item.id === persona.tenantId);
  const solo = tenant?.mode === "solo";
  if (!tenant || tenant.status !== "active" || (!solo && tenant.expiresAt < today(now))) fail("当前训练空间或品牌服务未启用。",403);
  const storeId = solo ? "" : text(p,"storeId",191);
  if (solo && p.storeId !== undefined && p.storeId !== "") fail("独立训练空间没有门店。",403);
  if (!solo && !data.stores.some(item => item.id === storeId && item.tenantId === tenant.id && item.status === "active")) fail("请选择当前品牌正常营业的门店。",403);
  if (!solo && (persona.role === "manager" || persona.role === "coach") && persona.storeId !== storeId) fail("只能管理自己所在门店的排课计划。",403);
  let coachIds: string[];
  if (p.coachIds !== undefined) {
    if (!Array.isArray(p.coachIds) || !p.coachIds.length || p.coachIds.length > 20 || p.coachIds.some(value => typeof value !== "string" || !value.trim() || value.trim().length > 191)) fail("请选择 1 至 20 位有效的授课教练。");
    coachIds = (p.coachIds as string[]).map(value => value.trim());
    if (new Set(coachIds).size !== coachIds.length) fail("授课教练不能重复选择。");
    if (p.coachId !== undefined && (typeof p.coachId !== "string" || p.coachId.trim() !== coachIds[0])) fail("单选与多选教练信息不一致，请重新选择。");
  } else {
    const legacyId = solo && p.coachId === undefined ? persona.coachId : text(p,"coachId",191);
    if (!legacyId) fail("请选择授课教练。");
    coachIds = [legacyId];
  }
  const coaches = coachIds.map(coachId => {
    const coach = data.coaches.find(item => item.id === coachId && item.tenantId === tenant.id && coachServesStore(item,storeId));
    if (!coach || (persona.role === "coach" && coach.id !== persona.coachId) || (solo && (coach.id !== persona.coachId || !coach.selfManaged))) fail("只能为授权门店内的教练安排课程，教练本人只能安排自己的时间。",403);
    if (coach.status !== "approved") fail(`教练「${coach.name}」尚未通过资质审核，请先完成审核。`);
    return coach;
  });
  if ((persona.role === "coach" || solo) && coachIds.length !== 1) fail("教练本人和独立空间只能安排自己的时间。",403);
  if (p.sharedRoom !== undefined && typeof p.sharedRoom !== "boolean") fail("共享训练区域的确认值无效。");
  const sharedRoom = p.sharedRoom === true;
  if (coaches.length > 1 && !sharedRoom) fail("多位教练同时授课，请先确认此训练区域允许同计划内多教练并行使用，或分别安排场地。");
  const name = text(p,"name",60), type = text(p,"type",40);
  const venue = resolveVenue(data, tenant.id, storeId, p), room = venue.room;
  if (coaches.length > 1 && venue.venue && !venue.venue.allowShared) fail("该场地不允许多位教练同时授课，请选择允许并行授课的场地或仅选择一位教练。");
  for (const coach of coaches) if (!solo && !coach.specialty.split(/[·、,，/]/).map(value => value.trim()).includes(type)) fail(`教练「${coach.name}」未取得所选科目的教学资格。`);
  const startDate = date(p,"startDate"), endDate = date(p,"endDate");
  const first = Date.parse(`${startDate}T00:00:00Z`), last = Date.parse(`${endDate}T00:00:00Z`);
  if (last < first || (last - first) / DAY + 1 > 90) fail("请选择不超过 90 天的有效日期范围。");
  if (!Array.isArray(p.weekdays) || !p.weekdays.length || p.weekdays.some(value => !Number.isInteger(value) || value < 1 || value > 7) || new Set(p.weekdays).size !== p.weekdays.length) fail("请至少选择一个不重复的每周上课日（周一至周日）。");
  const weekdays = [...p.weekdays as number[]].sort((a,b) => a-b);
  const startTime = time(p,"startTime"), endTime = time(p,"endTime");
  if (endTime.minutes <= startTime.minutes) fail("结束时间须晚于开始时间；跨日时段请分开设置。");
  const capacity = p.mode === "availability" ? 1 : integer(p,"capacity",1,200);
  if (p.mode === "availability" && p.capacity !== undefined && p.capacity !== 1) fail("开放可约时段为一对一预约，每个时段仅允许 1 位学员。");
  const durationMinutes = p.mode === "availability" ? integer(p,"durationMinutes",15,180) : endTime.minutes - startTime.minutes;
  const gapMinutes = p.mode === "availability" ? integer({gapMinutes:p.gapMinutes ?? 0},"gapMinutes",0,60) : 0;
  if (p.mode === "availability" && (durationMinutes % 15 || gapMinutes % 5)) fail("单次时长以 15 分钟递增，间隔以 5 分钟递增。");
  if (p.mode === "recurring" && durationMinutes > 480) fail("单节循环课程最长为 8 小时。");
  if (durationMinutes > endTime.minutes - startTime.minutes) fail("空闲区间不足以容纳一次完整训练，请调整单次时长或区间。");
  const credits = integer(p,"credits",1,20), price = integer(p,"price",0,10000000);
  const items: SchedulePreviewItem[] = [];
  let occurrenceCount = 0, timeSlotCount = 0;
  for (let day = first; day <= last; day += DAY) {
    const current = new Date(day), weekday = current.getUTCDay() || 7;
    if (!weekdays.includes(weekday)) continue;
    const value = current.toISOString().slice(0,10);
    occurrenceCount++;
    for (let minutes = startTime.minutes; minutes + durationMinutes <= endTime.minutes; minutes += durationMinutes + gapMinutes) {
      const startAt = stamp(value,minutes), endAt = stamp(value,minutes + durationMinutes);
      if (Date.parse(startAt) <= now.getTime()) fail("计划中包含已开始或过去的课次，请调整日期范围或开始时间。");
      timeSlotCount++;
      for (const coach of coaches) {
        if (!solo && (!coach.certificate.trim() || !validDate(coach.certificateExpiresAt) || coach.certificateExpiresAt < value)) fail(`教练「${coach.name}」资质不能覆盖 ${value} 的课程，请调整计划或更新资质。`);
        items.push({ date:value,startAt,endAt,coachId:coach.id,coachName:coach.name,room,...(venue.venueId ? {venueId:venue.venueId} : {}) });
        if (items.length > 256) fail("单次最多发布 256 个教练课次或预约时段，请减少教练或缩短范围。");
      }
      if (p.mode === "recurring") break;
    }
  }
  if (!items.length) fail("所选日期范围内没有匹配的上课日，请调整每周重复规则。");
  const conflicts = items.flatMap(item => {
    const collision = data.classes.some(other => other.tenantId === tenant.id && other.status === "scheduled" && Date.parse(other.startAt) < Date.parse(item.endAt) && Date.parse(other.endAt) > Date.parse(item.startAt) && (other.coachId === item.coachId || sameVenue(data, other, { tenantId:tenant.id,storeId,room,venueId:venue.venueId })));
    return collision ? [{...item,reason:"教练或所选场地在该时段已有安排"}] : [];
  });
  const plan: PreparedSchedule["plan"] = { mode:p.mode,name,type,tenantId:tenant.id,storeId,coachId:coachIds[0],coachIds,sharedRoom,startDate,endDate,weekdays,startTime:startTime.value,endTime:endTime.value,capacity,credits,price,room,...(venue.venueId ? {venueId:venue.venueId} : {}),...(p.mode === "availability" ? {durationMinutes,gapMinutes} : {}) };
  return { plan, preview:{mode:p.mode,occurrenceCount,timeSlotCount,coachCount:coaches.length,slotCount:items.length,items,conflicts} };
}
