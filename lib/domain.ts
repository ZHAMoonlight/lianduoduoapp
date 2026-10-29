import { PERSONAS, shanghaiDate } from "./seed";
import { appendLedger, executeExtended, EXTRA_PERMISSIONS } from "./operations";
import { prepareSchedule, SchedulePlanError } from "./schedule-plans";
import { assertVenueInvariants, executeVenueAction, resolveVenue, sameVenue, VenueError } from "./venues";
import { assertCoachBillingInvariants, authorizedCoachBillingFilter, CoachBillingError, previewCoachBill } from "./coach-billing";
import { matchesCardCourse, normalizeCourseText, validCardCourseRules } from "./card-courses";
import { coachServesStore, coachStoreIds } from "./coach-stores";
import type { ActionName, Card, ClassSession, Persona, PersonaId, WorkspaceData, WorkspaceResponse } from "./types";

export class DomainError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = "DomainError"; this.status = status; }
}
export function getPersona(id: unknown): Persona {
  const persona = PERSONAS.find((item) => item.id === id);
  if (!persona) throw new DomainError("请选择有效的预置体验身份。", 400);
  return persona;
}
function trustedPersona(input: unknown): Persona {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const persona = input as Persona;
    if (!["platform", "hq", "manager", "coach", "student"].includes(persona.role) || (persona.role !== "platform" && !persona.tenantId)) throw new DomainError("组织授权无效。", 403);
    return persona;
  }
  return getPersona(input);
}
function scheduleInput(data: WorkspaceData, persona: Persona, payload: unknown, now: Date) {
  try { return prepareSchedule(data,persona,payload,now); }
  catch (error) { if (error instanceof SchedulePlanError || error instanceof VenueError) throw new DomainError(error.message,error.status); throw error; }
}
function venueInput<T>(run: () => T): T { try { return run(); } catch (error) { if (error instanceof VenueError) throw new DomainError(error.message, error.status); throw error; } }
function billingInput<T>(run: () => T): T { try { return run(); } catch (error) { if (error instanceof CoachBillingError) throw new DomainError(error.message, error.status); throw error; } }
function optionalBillingText(p: Record<string, unknown>, key: string): string { if (p[key] === undefined) return ""; if (typeof p[key] !== "string" || (p[key] as string).trim().length > 500) fail("账单备注或支付参考信息最多 500 字。"); return (p[key] as string).trim(); }
/** Read-only schedule validation and conflict preview; never materialises IDs or bookings. */
export function previewSchedule(data: WorkspaceData, personaId: unknown, payload: unknown, now = new Date()) {
  return scheduleInput(data,trustedPersona(personaId),payload,now).preview;
}
function fail(message: string, status = 400): never { throw new DomainError(message, status); }
function text(p: Record<string, unknown>, key: string, max = 200): string {
  const value = typeof p[key] === "string" ? p[key].trim() : "";
  if (!value) fail(`请填写${({ name: "名称", contact: "联系人", phone: "联系电话", title: "标题", content: "内容", description: "任务说明", specialty: "擅长科目", type: "课程科目", room: "上课场地" } as Record<string, string>)[key] ?? key}。`);
  if (value.length > max) fail(`填写内容不能超过 ${max} 个字。`);
  return value;
}
function number(p: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = p[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(`${({ capacity: "课程容量", credits: "课时数", price: "课程价格" } as Record<string, string>)[key] ?? key}须为 ${min} 至 ${max} 之间的整数。`);
  return value;
}
function bool(p: Record<string, unknown>, key: string): boolean {
  if (typeof p[key] !== "boolean") fail("请选择通过或驳回。");
  return p[key] as boolean;
}
function date(p: Record<string, unknown>, key: string): string {
  const value = text(p, key, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00+08:00`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail("请填写有效日期，格式为 YYYY-MM-DD。");
  return value;
}
function datetime(p: Record<string, unknown>, key: string): string {
  let value = text(p, key, 40);
  date({ day: value.slice(0, 10) }, "day");
  // datetime-local 控件以门店上海时间输入。
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) value += "+08:00";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) fail("请输入有效的课程日期和时间。");
  return new Date(value).toISOString();
}
function phone(p: Record<string, unknown>) {
  const value = text(p, "phone", 25);
  if (!/^[+\d][\d\s-]{5,24}$/.test(value)) fail("请填写有效联系电话。");
  return value;
}
function uid(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }
function find<T extends { id: string }>(items: T[], id: unknown, name: string): T {
  const value = items.find((item) => item.id === id);
  if (!value) fail(`${name}不存在或已失效。`, 404);
  return value;
}
function tenantScope(persona: Persona, tenantId: string) {
  if (persona.role !== "platform" && persona.tenantId !== tenantId) fail("无权操作其他品牌的数据。", 403);
}
function storeScope(persona: Persona, storeId: string) {
  if ((persona.role === "manager" || persona.role === "coach") && persona.storeId !== storeId) fail("当前身份只能操作本门店。", 403);
}
function memberScope(persona: Persona, memberId: string) {
  if (persona.role === "student" && !(persona.memberIds ?? [persona.memberId]).includes(memberId)) fail("只能操作本人或已绑定孩子的预约。", 403);
}
/** Exactly the coach's existing teaching, assignment and follow-up authorisations;
 * sharing a store alone never grants access to every member or their cards. */
function coachMemberIds(data: WorkspaceData, persona: Persona): Set<string> {
  if (!persona.coachId || !persona.tenantId || !persona.storeId) return new Set();
  const classes = new Set(data.classes.filter(cls => cls.tenantId === persona.tenantId && cls.storeId === persona.storeId && cls.coachId === persona.coachId).map(cls => cls.id));
  const visiting = new Set(data.bookings.filter(booking => booking.tenantId === persona.tenantId && classes.has(booking.classId)).map(booking => booking.memberId));
  const followed = new Set(data.followups.filter(item => item.tenantId === persona.tenantId && item.storeId === persona.storeId && item.assigneeCoachId === persona.coachId).map(item => item.memberId));
  return new Set(data.members.filter(member => member.tenantId === persona.tenantId && (member.storeId === persona.storeId && member.coachId === persona.coachId || visiting.has(member.id) || followed.has(member.id))).map(member => member.id));
}
function coachMemberScope(data: WorkspaceData, persona: Persona, memberId: string) {
  if (persona.role === "coach" && !coachMemberIds(data, persona).has(memberId)) fail("只能为本人负责、到访授课或已分配跟进的授权学员安排预约。",403);
}
/** Read-only reservation DTO. Full-source mutations retain financial fields. */
function coachBookingCard(card: Card): Card {
  const safe: Partial<Card> = { id:card.id,tenantId:card.tenantId,memberId:card.memberId,storeId:card.storeId,name:card.name,total:card.total,remaining:card.remaining,frozen:card.frozen,expiresAt:card.expiresAt,scope:card.scope,classTypes:card.classTypes,status:card.status };
  if(Object.hasOwn(card,"courseMode"))safe.courseMode=card.courseMode;
  if(Object.hasOwn(card,"courseRules"))safe.courseRules=card.courseRules;
  // WorkspaceData also models authoritative storage. This projection deliberately
  // omits unitValueCents/orderId rather than inventing a financial value of zero.
  return structuredClone(safe) as Card;
}
function courseScope(persona: Persona, cls: ClassSession) {
  tenantScope(persona, cls.tenantId); storeScope(persona, cls.storeId);
  if (persona.role === "coach" && cls.coachId !== persona.coachId) fail("当前教练只能操作自己的课程。", 403);
}
function bookingContext(data: WorkspaceData, persona: Persona, p: Record<string, unknown>) {
  const booking = find(data.bookings, p.id, "预约");
  tenantScope(persona, booking.tenantId); memberScope(persona, booking.memberId);
  const cls = find(data.classes, booking.classId, "课程"); courseScope(persona, cls);
  const card = find(data.cards, booking.cardId, "课卡");
  return { booking, cls, card };
}
function validateCoach(data: WorkspaceData, cls: Pick<ClassSession, "coachId" | "tenantId" | "storeId" | "type" | "startAt">) {
  const coach = find(data.coaches, cls.coachId, "教练");
  if (coach.tenantId !== cls.tenantId || coach.status !== "approved") fail("教练尚未通过资质审核，暂不能开课或预约。");
  if (!coachServesStore(coach,cls.storeId)) fail("该教练未关联当前授课门店。",403);
  const selfManaged = data.tenants.some(t=>t.id===cls.tenantId&&t.mode==="solo") && coach.selfManaged===true;
  if (!selfManaged && (!coach.certificate || coach.certificateExpiresAt < shanghaiDate(new Date(cls.startAt)))) fail("教练资质在开课日已过期，请先更新资质。");
  if (!selfManaged && !coach.specialty.split(/[·、,，/]/).map((x) => x.trim()).includes(cls.type)) fail("该教练未取得所选科目的教学资格。");
  return coach;
}
function validateCard(card: Card, cls: ClassSession, memberId: string) {
  if (card.memberId !== memberId || card.tenantId !== cls.tenantId) fail("课卡不属于该学员或该品牌。", 403);
  if (card.status !== "active") fail("这张课卡已冻结，请联系门店。");
  if (card.expiresAt < shanghaiDate(new Date(cls.startAt))) fail("课卡在开课日已过期，请选择其他课卡。");
  if (card.scope === "home" && card.storeId !== cls.storeId) fail("这张课卡仅适用于开卡门店，暂不支持该门店。");
  if (!matchesCardCourse(card, cls)) fail(Object.hasOwn(card, "courseRules") ? "这张课卡不适用于当前课程。" : "这张课卡不适用于当前课程科目。");
  if (card.remaining - card.frozen < cls.credits) fail("可用课时不足，请先充值或选择其他课卡。");
}
function addAudit(data: WorkspaceData, persona: Persona, action: ActionName, detail: string, now: Date, storeId?: string, tenantId = persona.tenantId) {
  data.audit.unshift({ id: uid("audit"), actor: persona.name, actorId:persona.userId, action, detail, tenantId, storeId, createdAt: now.toISOString() });

}

const PERMISSIONS: Record<PersonaId, string[]> = {
  platform: ["tenant.create", "tenant.update", "application.review", "announcement.create"],
  hq: ["coach.store.attach", "coachBill.create", "coachBill.settle", "venue.create", "venue.update", "coach.review", "coach.invite", "class.create", "schedule.publish", "schedule.cancel", "booking.create", "booking.cancel", "booking.checkin", "booking.complete", "settlement.confirm", "task.create", "task.complete", "announcement.create"],
  manager: ["coach.store.attach", "coachBill.create", "coachBill.settle", "venue.create", "venue.update", "coach.review", "coach.invite", "class.create", "schedule.publish", "schedule.cancel", "booking.create", "booking.cancel", "booking.checkin", "booking.complete", "task.complete"],
  coach: ["schedule.publish", "schedule.cancel", "booking.create", "booking.cancel", "booking.checkin", "booking.complete"],
  student: ["booking.create", "booking.cancel"],
};

/** 纯领域事务：复制后校验和变更；调用者仅通过一次 CAS 持久化整个结果。 */
export function applyAction(source: WorkspaceData, personaId: unknown, actionInput: unknown, payload: unknown, now = new Date()): WorkspaceData {
  const persona = trustedPersona(personaId);
  if (typeof actionInput !== "string" || ![...(PERMISSIONS[persona.role] ?? []), ...(EXTRA_PERMISSIONS[persona.role] ?? [])].includes(actionInput)) fail("当前身份无权执行此操作。", 403);
  const action = actionInput as ActionName;
  const solo=source.tenants.some(t=>t.id===persona.tenantId&&t.mode==="solo");
  if(solo&&["coach.store.attach","store.create","store.update","coach.invite","coach.review","task.create","task.complete","settlement.confirm"].includes(action))fail("独立教练空间不提供门店、机构教练审核或内部清分操作。",403);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("操作参数格式不正确。");
  const p = payload as Record<string, unknown>;
  if(solo&&p.storeId!==undefined&&p.storeId!=="")fail("独立教练空间没有门店，不能指定其他门店。",403);
  const data = structuredClone(source);
  data.schedulePlans ??= [];
  data.venues ??= [];
  data.coachBills ??= [];
  const today = shanghaiDate(now);
  if (persona.tenantId) {
    const tenant = find(data.tenants, persona.tenantId, "品牌");
    if (tenant.status !== "active" || (!solo && tenant.expiresAt < today)) fail(solo ? "当前独立训练空间未启用，请联系本地服务维护者处理。" : "当前品牌服务已暂停或到期，可查看数据；请联系平台续期后再操作。", 403);
  }
  const stamp = now.toISOString();
  if (executeExtended(data, persona, action, p, now)) { appendLedger(source, data, action, p, now); assertInvariants(data); return data; }
  switch (action) {
    case "coachBill.create": {
      const filter = billingInput(() => authorizedCoachBillingFilter(data, persona, p, now));
      const note = optionalBillingText(p, "note");
      const preview = billingInput(() => previewCoachBill(data, { ...filter, rule: p.rule }, now));
      if (preview.blocking.length) fail(preview.blocking.join(" "));
      if (typeof p.expectedPreviewHash !== "string" || !p.expectedPreviewHash) fail("请先预览教练账单并确认金额后再创建。");
      if (p.expectedPreviewHash !== preview.previewHash) fail("可结算履约或金额已变化，请重新预览教练账单后再创建。", 409);
      data.coachBills!.push({ ...preview, id: uid("coach-bill"), status: "unpaid", note, createdAt: stamp, createdBy: persona.userId || persona.name });
      addAudit(data, persona, action, `创建「${preview.coachName}」教练账单，${preview.totals.sessionCount} 节课、${preview.totals.completedCount} 完成人次，应付 ${preview.amountCents} 分，尚未付款`, now, preview.storeId);
      break;
    }
    case "coachBill.settle": {
      if (Object.keys(p).some(key => !["id", "paidDate", "ref", "note"].includes(key))) fail("结算登记包含不能修改的账单字段。", 403);
      const bill = find(data.coachBills!, p.id, "教练账单");tenantScope(persona, bill.tenantId);storeScope(persona, bill.storeId);
      const paidDate = date(p, "paidDate"), ref = optionalBillingText(p, "ref"), settleNote = optionalBillingText(p, "note");
      if (paidDate > today) fail("实际支付日期不能晚于今天。");
      if (bill.status === "paid") { if (bill.paidDate !== paidDate || (bill.ref || "") !== ref || (bill.settleNote || "") !== settleNote) fail("该教练账单已登记支付，不能修改原结算记录。", 409);break; }
      bill.status = "paid";bill.paidDate = paidDate;bill.ref = ref;bill.settleNote = settleNote;bill.settledAt = stamp;bill.settledBy = persona.userId || persona.name;
      addAudit(data, persona, action, `登记「${bill.coachName}」教练账单已线下支付 ${bill.amountCents} 分，实际支付日 ${paidDate}`, now, bill.storeId);
      break;
    }
    case "venue.create": case "venue.update": {
      const venue = venueInput(() => executeVenueAction(data, persona, action, p, now));
      addAudit(data, persona, action, `${action === "venue.create" ? "新增" : "更新"}场地「${venue.name}」`, now, venue.storeId);
      break;
    }
    case "schedule.publish": {
      const prepared = scheduleInput(data,persona,p,now);
      if (prepared.preview.conflicts.length) fail(`有 ${prepared.preview.conflicts.length} 个时段与已有安排冲突，请调整后重新发布。`,409);
      const plan = { ...prepared.plan,id:uid("schedule"),status:"active" as const,createdAt:stamp };
      data.schedulePlans!.push(plan);
      for (const item of prepared.preview.items) data.classes.push({id:uid("class"),tenantId:plan.tenantId,storeId:plan.storeId,coachId:item.coachId,name:plan.name,type:plan.type,startAt:item.startAt,endAt:item.endAt,capacity:plan.capacity,credits:plan.credits,price:plan.price,room:item.room,...(item.venueId ? {venueId:item.venueId} : {}),status:"scheduled",schedulePlanId:plan.id,bookingMode:plan.mode});
      addAudit(data,persona,action,`发布${plan.mode === "recurring" ? "固定循环课" : "开放可约时段"}「${plan.name}」，${prepared.preview.occurrenceCount} 天、${prepared.preview.coachCount} 位教练、${prepared.preview.slotCount} 个独立课次或预约时段`,now,plan.storeId);
      break;
    }
    case "schedule.cancel": {
      const plan = find(data.schedulePlans!,p.id,"排课计划");tenantScope(persona,plan.tenantId);storeScope(persona,plan.storeId);
      const planCoaches = plan.coachIds ?? [plan.coachId];
      if ((persona.role === "coach" || solo) && !planCoaches.includes(persona.coachId || "")) fail("只能停用自己的排课计划。",403);
      if ((persona.role === "coach" || solo) && planCoaches.length !== 1) fail("多教练计划涉及其他教练，请联系总部或门店管理员统一调整。",403);
      if (plan.status === "cancelled") break;
      const reason = text(p,"reason",500),future = data.classes.filter(item => item.schedulePlanId === plan.id && item.status === "scheduled" && Date.parse(item.startAt) > now.getTime());
      const futureIds = new Set(future.map(item => item.id));
      if (data.bookings.some(booking => futureIds.has(booking.classId) && ["checked_in","completed"].includes(booking.status))) fail("未来课次已有签到或履约，请先处理该课次后再停用计划。");
      for (const cls of future) executeExtended(data,persona,"class.cancel",{id:cls.id,reason},now);
      plan.status = "cancelled";plan.cancelledAt = stamp;plan.cancelReason = reason;
      addAudit(data,persona,action,`停用「${plan.name}」，取消 ${future.length} 个未来课次或可约时段并释放预约课时；${reason}`,now,plan.storeId);
      break;
    }
    case "tenant.create": {
      const name = text(p, "name", 60); const contact = text(p, "contact", 30); const telephone = phone(p); const expiresAt = date(p, "expiresAt");
      if (expiresAt < today) fail("服务到期日不能早于今天。");
      if (!["基础版", "专业版", "旗舰版"].includes(String(p.plan))) fail("请选择有效的服务版本。");
      if (data.tenants.some((t) => t.name === name)) fail("该品牌名称已存在。");
      const id = uid("tenant");
      data.tenants.push({ id, name, contact, phone: telephone, plan: p.plan as "基础版", status: "active", expiresAt, createdAt: stamp });
      addAudit(data, persona, action, `开通品牌「${name}」`, now, undefined, id); break;
    }
    case "tenant.update": {
      const tenant = find(data.tenants, p.id, "品牌");
      if (p.name !== undefined) { const name = text(p, "name", 60); if (data.tenants.some((t) => t.id !== tenant.id && t.name === name)) fail("该品牌名称已存在。"); tenant.name = name; }
      if (p.contact !== undefined) tenant.contact = text(p, "contact", 30);
      if (p.phone !== undefined) tenant.phone = phone(p);
      if (p.plan !== undefined) { if (!["基础版", "专业版", "旗舰版"].includes(String(p.plan))) fail("请选择有效的服务版本。"); tenant.plan = p.plan as "基础版"; }
      if (p.status !== undefined) { if (!["active", "suspended", "expired"].includes(String(p.status))) fail("请选择有效的品牌状态。"); tenant.status = p.status as "active"; }
      if (p.expiresAt !== undefined) tenant.expiresAt = date(p, "expiresAt");
      if (tenant.status === "active" && tenant.mode !== "solo" && tenant.expiresAt < today) fail("请先将服务有效期延长至今天之后，再启用品牌。");
      addAudit(data, persona, action, `更新品牌「${tenant.name}」服务配置`, now, undefined, tenant.id); break;
    }
    case "application.review": {
      const application = find(data.applications, p.id, "入驻申请"); const approved = bool(p, "approved");
      if (application.status !== "pending") { if ((application.status === "approved") === approved) return data; fail("该申请已处理，不能重复变更审核结果。"); }
      if (approved && data.tenants.some((t) => t.name === application.name)) fail("该品牌已存在，请检查后再审核。");
      application.status = approved ? "approved" : "rejected";
      application.note = typeof p.note === "string" ? p.note.slice(0, 500) : (approved ? "审核通过，已开通基础版一年服务" : "资料待完善，请重新提交");
      if (approved) data.tenants.push({ id: uid("tenant"), name: application.name, contact: application.contact, phone: application.phone, plan: "基础版", status: "active", expiresAt: shanghaiDate(now, 365), createdAt: stamp });
      addAudit(data, persona, action, `${approved ? "通过" : "驳回"}「${application.name}」入驻申请`, now); break;
    }
    case "coach.invite": {
      const store = find(data.stores, p.storeId, "门店"); tenantScope(persona, store.tenantId); storeScope(persona, store.id);
      if (store.status !== "active") fail("门店已停用，无法邀请教练。");
      const telephone = phone(p); if (data.coaches.some((c) => c.tenantId === store.tenantId && c.phone === telephone)) fail("该手机号已在品牌教练名单中。");
      const name = text(p, "name", 30); const specialty = text(p, "specialty", 100);
      const certificate = typeof p.certificate === "string" ? p.certificate.trim().slice(0, 100) : "";
      if (certificate && !p.certificateExpiresAt) fail("请填写证书实际有效期，系统不会自动延长资质有效期。");
      const certificateExpiresAt = p.certificateExpiresAt ? date(p, "certificateExpiresAt") : "";
      data.coaches.push({ id: uid("coach"), tenantId: store.tenantId, storeId: store.id, name, phone: telephone, specialty, certificate, certificateExpiresAt, status: "pending", rating: 0, inviteCode: crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase() });
      addAudit(data, persona, action, `已为「${name}」创建邀请码，等待资质审核`, now, store.id); break;
    }
    case "coach.store.attach": {
      const store=find(data.stores,p.storeId,"门店"),coach=find(data.coaches,p.coachId,"教练");tenantScope(persona,store.tenantId);storeScope(persona,store.id);
      if(coach.tenantId!==store.tenantId||coach.selfManaged||data.tenants.some(tenant=>tenant.id===coach.tenantId&&tenant.mode==="solo"))fail("只能关联同品牌的机构教练。",403);
      const expiry=Date.parse(coach.certificateExpiresAt+"T00:00:00Z");
      if(store.status!=="active"||coach.status!=="approved"||!coach.certificate.trim()||!/^\d{4}-\d{2}-\d{2}$/.test(coach.certificateExpiresAt)||!Number.isFinite(expiry)||new Date(expiry).toISOString().slice(0,10)!==coach.certificateExpiresAt||coach.certificateExpiresAt<today)fail("请先确认目标门店启用且教练审核与资质均有效。");
      const stores=coachStoreIds(coach);if(!stores.length)fail("教练门店关联数据异常，请管理员核对。",409);if(stores.includes(store.id))return data;if(stores.length>=20)fail("每位教练最多关联20家门店。");
      coach.storeIds=[...stores,store.id];addAudit(data,persona,action,`将同品牌教练「${coach.name}」关联至「${store.name}」，共用教练档案与资质`,now,store.id);break;
    }
    case "coach.review": {
      const coach = find(data.coaches, p.id, "教练"); tenantScope(persona, coach.tenantId); storeScope(persona, coach.storeId); const approved = bool(p, "approved");
      if (coach.status !== "pending") { if ((coach.status === "approved") === approved) return data; fail("教练已完成审核，不能重复变更审核结果。"); }
      if (approved && (!coach.certificate || coach.certificateExpiresAt < today)) fail("请先补齐有效的教练资质后再通过审核。");
      coach.status = approved ? "approved" : "rejected";
      addAudit(data, persona, action, `${approved ? "通过" : "驳回"}教练「${coach.name}」资质`, now, coach.storeId); break;
    }
    case "class.create": {
      const store = solo ? undefined : find(data.stores, p.storeId, "门店");
      const tenantId=solo?persona.tenantId!:store!.tenantId,storeId=store?.id??"";tenantScope(persona,tenantId);storeScope(persona,storeId);
      if (store && store.status !== "active") fail("门店已停用，无法排课。");
      const startAt = datetime(p, "startAt"); const endAt = datetime(p, "endAt"); const start = Date.parse(startAt); const end = Date.parse(endAt);
      if (start <= now.getTime()) fail("开课时间必须晚于当前时间。");
      if (end <= start || end - start > 8 * 3_600_000) fail("课程结束时间须晚于开始时间，单节课程最长 8 小时。");
      const venue = venueInput(() => resolveVenue(data, tenantId, storeId, p));
      const cls: ClassSession = { id: uid("class"), tenantId, storeId, coachId: solo&&!p.coachId?persona.coachId!:text(p, "coachId"), name: text(p, "name", 60), type: text(p, "type", 40), startAt, endAt, capacity: number(p, "capacity", 1, 200), credits: number(p, "credits", 1, 20), price: number(p, "price", 0, 10_000_000), room: venue.room, ...(venue.venueId ? {venueId:venue.venueId} : {}), status: "scheduled" };
      const coach = validateCoach(data, cls);
      if (!coachServesStore(coach,storeId)) fail("该教练尚未关联当前授课门店。",403);
      if (data.classes.some((other) => other.tenantId===tenantId && other.status === "scheduled" && Date.parse(other.startAt) < end && Date.parse(other.endAt) > start && (other.coachId === cls.coachId || sameVenue(data, other, cls)))) fail("教练或所选场地在该时段已有课程，请调整排课时间。");
      data.classes.push(cls); addAudit(data, persona, action, `在${store?.name??"独立训练空间"}发布「${cls.name}」`, now, storeId); break;
    }
    case "booking.create": {
      const cls = find(data.classes, p.classId, "课程"); courseScope(persona, cls);
      if (p.coachId !== undefined && p.coachId !== cls.coachId) fail("所选教练与当前课次不一致，请重新选择教练和时段。");
      const card = find(data.cards, p.cardId, "课卡"); const memberId = typeof p.memberId === "string" ? p.memberId : (persona.memberId ?? card.memberId);
      memberScope(persona, memberId); const member = find(data.members, memberId, "学员"); tenantScope(persona, member.tenantId);
      if (member.tenantId !== cls.tenantId) fail("不能跨品牌预约课程。", 403);
      coachMemberScope(data,persona,memberId);
      // 同学员同场次请求幂等：已成功预约不再次冻结课时。
      if (data.bookings.some((b) => b.classId === cls.id && b.memberId === memberId && ["reserved", "checked_in", "completed"].includes(b.status))) return data;
      if (cls.schedulePlanId && !data.schedulePlans?.some(plan => plan.id === cls.schedulePlanId && plan.status === "active")) fail("该排课计划已停用，请选择其他可约时段。");
      if (cls.status !== "scheduled" || Date.parse(cls.startAt) <= now.getTime()) fail("课程已开始或已取消，请选择其他课程。");
      if (!solo && find(data.stores, cls.storeId, "门店").status !== "active") fail("门店已停用，暂不能预约。");
      validateCoach(data, cls); validateCard(card, cls, memberId);
      if (data.bookings.filter((b) => b.classId === cls.id && ["reserved", "checked_in", "completed"].includes(b.status)).length >= cls.capacity) fail("本节课程已约满，请选择其他场次。");
      if (data.bookings.some((b) => { if (b.memberId !== memberId || !["reserved", "checked_in"].includes(b.status)) return false; const other = data.classes.find((c) => c.id === b.classId); return other && Date.parse(other.startAt) < Date.parse(cls.endAt) && Date.parse(other.endAt) > Date.parse(cls.startAt); })) fail("该学员在此时段已有预约，请选择其他时间。");
      card.frozen += cls.credits;
      data.bookings.unshift({ id: uid("booking"), tenantId: cls.tenantId, memberId, classId: cls.id, coachId: cls.coachId, cardId: card.id, credits: cls.credits, status: "reserved", createdAt: stamp });
      addAudit(data, persona, action, `${member.name}预约「${cls.name}」，冻结 ${cls.credits} 课时`, now, cls.storeId); break;
    }
    case "booking.cancel": {
      const { booking, cls, card } = bookingContext(data, persona, p);
      coachMemberScope(data,persona,booking.memberId);
      if (booking.status === "cancelled") return data;
      if (booking.status !== "reserved") fail("已签到或已完成的课程不能取消。");
      if (Date.parse(cls.startAt) - now.getTime() <= 60 * 60_000) fail("距开课已不足或等于 60 分钟，无法自助取消，请联系门店处理。");
      if (card.frozen < booking.credits) fail("课卡冻结余额异常，请联系总部核对。");
      card.frozen -= booking.credits; booking.status = "cancelled"; booking.cancelledAt = stamp;
      addAudit(data, persona, action, `取消「${cls.name}」预约，释放 ${booking.credits} 课时`, now, cls.storeId); break;
    }
    case "booking.checkin": {
      const { booking, cls } = bookingContext(data, persona, p);
      if (booking.status === "checked_in" || booking.status === "completed") return data;
      if (booking.status !== "reserved") fail("已取消的预约不能签到。");
      if (cls.status !== "scheduled") fail("已取消的课程不能签到。");
      if (now.getTime() < Date.parse(cls.startAt) - 2 * 3_600_000 || now.getTime() > Date.parse(cls.endAt) + 2 * 3_600_000) fail("请在开课前 2 小时至结束后 2 小时内签到。");
      booking.status = "checked_in"; booking.checkedInAt = stamp;
      addAudit(data, persona, action, `「${cls.name}」学员签到成功`, now, cls.storeId); break;
    }
    case "booking.complete": {
      const { booking, cls, card } = bookingContext(data, persona, p);
      if (booking.status === "completed") return data;
      if (booking.status !== "checked_in") fail("请先完成学员签到，再确认消课。");
      if (now.getTime() < Date.parse(cls.startAt)) fail("课程尚未开始，暂不能消课。");
      if (card.frozen < booking.credits || card.remaining < booking.credits) fail("课卡余额异常，请联系总部核对。");
      const soldOrder = data.orders.find((o) => o.cardId === card.id);
      const consumedBefore = card.total - card.remaining;
      const settledAmount = soldOrder ? Math.floor((consumedBefore + booking.credits) * soldOrder.amount / card.total) - Math.floor(consumedBefore * soldOrder.amount / card.total) : card.unitValueCents * booking.credits;
      card.frozen -= booking.credits; card.remaining -= booking.credits; booking.status = "completed"; booking.completedAt = stamp;
      if (card.storeId !== cls.storeId && !data.settlements.some((s) => s.bookingId === booking.id)) data.settlements.unshift({ id: uid("settlement"), tenantId: booking.tenantId, bookingId: booking.id, fromStoreId: card.storeId, toStoreId: cls.storeId, amount: settledAmount, unitValueCents: card.unitValueCents, credits: booking.credits, status: "pending", createdAt: stamp });
      addAudit(data, persona, action, `「${cls.name}」完成消课，扣除 ${booking.credits} 课时${card.storeId !== cls.storeId ? "并生成跨店清分单" : ""}`, now, cls.storeId); break;
    }
    case "settlement.confirm": {
      const settlement = find(data.settlements, p.id, "清分单"); tenantScope(persona, settlement.tenantId);
      if (settlement.status === "confirmed") return data;
      const booking = find(data.bookings, settlement.bookingId, "预约"); const card = find(data.cards, booking.cardId, "课卡"); const cls = find(data.classes, booking.classId, "课程");
      if (booking.status !== "completed" || !Number.isSafeInteger(settlement.amount) || settlement.amount < 0 || settlement.fromStoreId !== card.storeId || settlement.toStoreId !== cls.storeId || card.storeId === cls.storeId) fail("清分单与消课记录不一致，无法确认。");
      settlement.status = "confirmed"; settlement.confirmedAt = stamp;
      addAudit(data, persona, action, `确认内部清分 ${(settlement.amount / 100).toFixed(2)} 元（不触发资金支付）`, now); break;
    }
    case "task.create": {
      const store = find(data.stores, p.storeId, "门店"); tenantScope(persona, store.tenantId); const dueAt = date(p, "dueAt");
      if (dueAt < today) fail("任务截止日期不能早于今天。");
      if (p.priority !== undefined && !["high", "normal"].includes(String(p.priority))) fail("请选择有效优先级。");
      const title = text(p, "title", 100);
      data.tasks.unshift({ id: uid("task"), tenantId: store.tenantId, storeId: store.id, title, description: text(p, "description", 1000), dueAt, priority: p.priority === "high" ? "high" : "normal", status: "pending", createdAt: stamp });
      addAudit(data, persona, action, `向${store.name}下发任务「${title}」`, now, store.id); break;
    }
    case "task.complete": {
      const task = find(data.tasks, p.id, "任务"); tenantScope(persona, task.tenantId); storeScope(persona, task.storeId);
      if (task.status === "completed") return data;
      task.status = "completed"; task.completedAt = stamp;
      addAudit(data, persona, action, `完成任务「${task.title}」`, now, task.storeId); break;
    }
    case "announcement.create": {
      if (!["all", "staff", "students"].includes(String(p.audience))) fail("请选择公告受众。");
      const title = text(p, "title", 100);
      data.announcements.unshift({ id: uid("announcement"), tenantId: persona.tenantId, title, content: text(p, "content", 2000), audience: p.audience as "all", createdAt: stamp, author: persona.role === "platform" ? "连多多平台" : "力速健身总部" });
      addAudit(data, persona, action, `发布公告「${title}」`, now); break;
    }
  }
  appendLedger(source, data, action, p, now);
  assertInvariants(data);
  return data;
}

export function assertInvariants(data: WorkspaceData) {
  venueInput(() => assertVenueInvariants(data));
  billingInput(() => assertCoachBillingInvariants(data));
  for(const coach of data.coaches)if(Object.hasOwn(coach,"storeIds")){const ids=coachStoreIds(coach),solo=data.tenants.some(tenant=>tenant.id===coach.tenantId&&tenant.mode==="solo");if(!ids.length||ids.some(id=>solo?id!=="":!data.stores.some(store=>store.id===id&&store.tenantId===coach.tenantId)))fail("教练门店关联范围异常，操作已撤回。",409);}
  const plans = new Map((data.schedulePlans ?? []).map(plan => [plan.id,plan]));
  if (plans.size !== (data.schedulePlans ?? []).length) fail("排课计划重复，操作已撤回。",409);
  for (const plan of plans.values()) {
    const coachIds = plan.coachIds ?? [plan.coachId];
    if (!Array.isArray(coachIds) || !coachIds.length || coachIds.length > 20 || coachIds.some(id => typeof id !== "string" || !id) || coachIds[0] !== plan.coachId || new Set(coachIds).size !== coachIds.length || coachIds.length > 1 && plan.sharedRoom !== true) fail("排课计划的教练或共享场地确认信息异常，操作已撤回。",409);
  }
  for (const cls of data.classes.filter(item => item.schedulePlanId)) {
    const plan = plans.get(cls.schedulePlanId!);
    if (!plan || cls.tenantId !== plan.tenantId || cls.storeId !== plan.storeId || cls.venueId !== plan.venueId || !(plan.coachIds ?? [plan.coachId]).includes(cls.coachId) || cls.bookingMode !== plan.mode || (plan.mode === "availability" && cls.capacity !== 1)) fail("课次与排课计划不一致，操作已撤回。",409);
  }
  for (const booking of data.bookings) if (booking.coachId !== undefined && booking.coachId !== data.classes.find(cls => cls.id === booking.classId)?.coachId) fail("预约与所选教练不一致，操作已撤回。",409);
  for (const card of data.cards) {
    if (Object.hasOwn(card,"courseMode")) {
      if (card.courseMode!=="all"&&card.courseMode!=="selected") fail("课卡的课程适用模式异常，操作已撤回。",409);
      if (card.courseMode==="all"&&(!Array.isArray(card.classTypes)||card.classTypes.length!==0||Object.hasOwn(card,"courseRules"))) fail("全部课程课卡的适用范围异常，操作已撤回。",409);
      if (card.courseMode==="selected"&&!Object.hasOwn(card,"courseRules")) fail("课卡的指定课程范围异常，操作已撤回。",409);
    }
    if (Object.hasOwn(card,"courseRules")) {
      if (!validCardCourseRules(card.courseRules) || !Array.isArray(card.classTypes) || card.classTypes.some(type => typeof type !== "string" || !type.trim())) fail("课卡的指定课程范围异常，操作已撤回。",409);
      const derived = [...new Set(card.courseRules.map(rule => normalizeCourseText(rule.type)))].sort(), supplied = [...new Set(card.classTypes.map(normalizeCourseText))].sort();
      if (derived.length !== supplied.length || derived.some((type, index) => type !== supplied[index])) fail("课卡课程与派生科目不一致，操作已撤回。",409);
    }
    const frozen = data.bookings.filter((b) => b.cardId === card.id && ["reserved", "checked_in"].includes(b.status)).reduce((n, b) => n + b.credits, 0);
    if (!Number.isSafeInteger(card.remaining) || !Number.isSafeInteger(card.frozen) || card.remaining < 0 || card.frozen < 0 || card.frozen > card.remaining || card.remaining > card.total || frozen !== card.frozen) fail("课卡余额核对失败，操作已撤回。", 409);
  }
  const activeKeys = new Set<string>();
  for (const booking of data.bookings.filter((b) => ["reserved", "checked_in", "completed"].includes(b.status))) {
    const key = `${booking.memberId}:${booking.classId}`;
    if (activeKeys.has(key)) fail("同一学员的课程存在重复预约，操作已撤回。", 409);
    activeKeys.add(key);
  }
  for (const cls of data.classes) if (data.bookings.filter((b) => b.classId === cls.id && ["reserved", "checked_in", "completed"].includes(b.status)).length > cls.capacity) fail("课程预约人数超过容量，操作已撤回。", 409);
  const settled = new Set<string>();
  for (const settlement of data.settlements) { if (settled.has(settlement.bookingId) || !Number.isSafeInteger(settlement.amount) || settlement.amount < 0) fail("清分记录重复或金额异常，操作已撤回。", 409); settled.add(settlement.bookingId); }
}

/** 所有 GET 和动作响应都走同一投影，避免通过切端读取越权数据。 */
export function projectWorkspace(source: WorkspaceData, personaId: unknown, version: number): WorkspaceResponse {
  const persona = trustedPersona(personaId);
  const data = structuredClone(source);
  data.schedulePlans ??= [];
  data.venues ??= [];
  data.coachBills ??= [];
  data.classes = data.classes.map((cls) => ({ ...cls, bookedCount: source.bookings.filter((b) => b.classId === cls.id && ["reserved", "checked_in", "completed"].includes(b.status)).length }));
  if (persona.role !== "platform") {
    const tenantId = persona.tenantId;
    data.tenants = data.tenants.filter((t) => t.id === tenantId);
    data.stores = data.stores.filter((s) => s.tenantId === tenantId);
    data.venues = data.venues.filter(venue => venue.tenantId === tenantId);
    data.coachBills = data.coachBills.filter(bill => bill.tenantId === tenantId);
    data.coaches = data.coaches.filter((c) => c.tenantId === tenantId);
    data.members = data.members.filter((m) => m.tenantId === tenantId);
    data.cards = data.cards.filter((c) => c.tenantId === tenantId);
    data.classes = data.classes.filter((c) => c.tenantId === tenantId);
    data.schedulePlans = data.schedulePlans.filter(plan => plan.tenantId === tenantId);
    data.bookings = data.bookings.filter((b) => b.tenantId === tenantId);
    data.settlements = data.settlements.filter((s) => s.tenantId === tenantId);
    data.tasks = data.tasks.filter((t) => t.tenantId === tenantId);
    data.audit = data.audit.filter((a) => a.tenantId === tenantId);
    data.applications = [];
    data.announcements = data.announcements.filter((a) => !a.tenantId || a.tenantId === tenantId);
  }
  if (persona.role === "manager" || persona.role === "coach") {
    data.venues = data.venues.filter(venue => venue.storeId === persona.storeId);
    data.coachBills = data.coachBills.filter(bill => bill.storeId === persona.storeId && (persona.role !== "coach" || bill.coachId === persona.coachId));
    data.classes = data.classes.filter((c) => c.storeId === persona.storeId && (persona.role !== "coach" || c.coachId === persona.coachId));
    data.schedulePlans = data.schedulePlans.filter(plan => plan.storeId === persona.storeId && (persona.role !== "coach" || (plan.coachIds ?? [plan.coachId]).includes(persona.coachId || "")));
    const classIds = new Set(data.classes.map((c) => c.id));
    data.bookings = data.bookings.filter((b) => classIds.has(b.classId));
    const visitingMembers = new Set(data.bookings.map((b) => b.memberId));
    const authorisedCoachMembers = persona.role === "coach" ? coachMemberIds(source,persona) : new Set<string>();
    data.members = data.members.filter((m) => persona.role === "coach" ? authorisedCoachMembers.has(m.id) : visitingMembers.has(m.id) || m.storeId === persona.storeId);
    const bookingCardIds = new Set(data.bookings.map((b) => b.cardId));
    data.cards = data.cards.filter((c) => c.storeId === persona.storeId || bookingCardIds.has(c.id));
    data.stores = data.stores.filter((s) => s.id === persona.storeId);
    data.coaches = data.coaches.filter((c) => coachServesStore(c,persona.storeId||""));
    data.tasks = data.tasks.filter((t) => t.storeId === persona.storeId);
    data.settlements = data.settlements.filter((s) => s.fromStoreId === persona.storeId || s.toStoreId === persona.storeId);
    data.audit = data.audit.filter((a) => a.storeId === persona.storeId);
    if (persona.role === "coach") { data.cards = source.cards.filter(card => card.tenantId === persona.tenantId && authorisedCoachMembers.has(card.memberId) && (card.scope === "all" || card.storeId === persona.storeId)).map(coachBookingCard); data.settlements = []; data.audit = []; data.tasks = []; }
  }
  if (persona.role === "student") {
    data.venues = [];
    data.coachBills = [];
    data.schedulePlans = data.schedulePlans.filter(plan => plan.status === "active" && (data.stores.some(store => store.id === plan.storeId && store.status === "active") || data.tenants.some(tenant => tenant.id === plan.tenantId && tenant.mode === "solo")));
    const memberIds = new Set(persona.memberIds ?? [persona.memberId]);
    data.members = data.members.filter((m) => memberIds.has(m.id));
    data.cards = data.cards.filter((c) => memberIds.has(c.memberId));
    data.bookings = data.bookings.filter((b) => memberIds.has(b.memberId));
    data.coaches = data.coaches.filter((c) => c.status === "approved").map((c) => ({ ...c, phone: "", certificate: "", inviteCode: undefined }));
    data.settlements = []; data.tasks = []; data.audit = [];
    data.announcements = data.announcements.filter((a) => a.audience !== "staff");
  } else data.announcements = data.announcements.filter((a) => a.audience !== "students" || persona.role === "hq" || persona.role === "platform");
  const memberIds = new Set(data.members.map((m) => m.id));
  if(persona.role !== "platform") { for (const key of ["orders", "ledger", "followups", "feedback"] as const) data[key] = data[key].filter((item) => item.tenantId === persona.tenantId) as never; }
  if(persona.role === "manager") { data.orders=data.orders.filter(o=>o.storeId===persona.storeId); data.ledger=data.ledger.filter(l=>l.storeId===persona.storeId); data.followups=data.followups.filter(f=>f.storeId===persona.storeId); data.feedback=data.feedback.filter(f=>f.storeId===persona.storeId); }
  if(persona.role === "student") { data.orders=data.orders.filter(o=>memberIds.has(o.memberId)); data.ledger=data.ledger.filter(l=>memberIds.has(l.memberId)); data.followups=[]; data.feedback=data.feedback.filter(f=>memberIds.has(f.memberId)); data.accounts=[]; }
  if(persona.role === "coach") { data.orders=[];data.ledger=[];data.followups=data.followups.filter(f=>f.assigneeCoachId===persona.coachId&&f.storeId===persona.storeId); data.feedback=data.feedback.filter(f=>f.coachId===persona.coachId&&f.storeId===persona.storeId);data.accounts=[]; }
  data.followups=data.followups.map(f=>({...f,renewalCandidates:source.orders.filter(o=>o.memberId===f.memberId&&o.tenantId===f.tenantId&&o.status==="paid"&&Date.parse(o.createdAt)>=Date.parse(f.createdAt)).map(o=>({id:o.id,createdAt:o.createdAt,cardName:source.cards.find(c=>c.id===o.cardId)?.name??"续费课卡"}))}));
  if (persona.role === "platform") data.coachBills = [];
  return { data, persona: structuredClone(persona), personas: typeof personaId === "string" ? structuredClone(PERSONAS) : [structuredClone(persona)], version };
}
