import { PERSONAS, shanghaiDate } from "./seed";
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
function validateCoach(data: WorkspaceData, cls: Pick<ClassSession, "coachId" | "tenantId" | "type" | "startAt">) {
  const coach = find(data.coaches, cls.coachId, "教练");
  if (coach.tenantId !== cls.tenantId || coach.status !== "approved") fail("教练尚未通过资质审核，暂不能开课或预约。");
  if (!coach.certificate || coach.certificateExpiresAt < shanghaiDate(new Date(cls.startAt))) fail("教练资质在开课日已过期，请先更新资质。");
  if (!coach.specialty.split(/[·、,，/]/).map((x) => x.trim()).includes(cls.type)) fail("该教练未取得所选科目的教学资格。");
  return coach;
}
function validateCard(card: Card, cls: ClassSession, memberId: string) {
  if (card.memberId !== memberId || card.tenantId !== cls.tenantId) fail("课卡不属于该学员或该品牌。", 403);
  if (card.status !== "active") fail("这张课卡已冻结，请联系门店。");
  if (card.expiresAt < shanghaiDate(new Date(cls.startAt))) fail("课卡在开课日已过期，请选择其他课卡。");
  if (card.scope === "home" && card.storeId !== cls.storeId) fail("这张课卡仅适用于开卡门店，暂不支持该门店。");
  if (!card.classTypes.includes(cls.type)) fail("这张课卡不适用于当前课程科目。");
  if (card.remaining - card.frozen < cls.credits) fail("可用课时不足，请先充值或选择其他课卡。");
}
function addAudit(data: WorkspaceData, persona: Persona, action: ActionName, detail: string, now: Date, storeId?: string, tenantId = persona.tenantId) {
  data.audit.unshift({ id: uid("audit"), actor: persona.name, action, detail, tenantId, storeId, createdAt: now.toISOString() });
  data.audit = data.audit.slice(0, 500);
}

const PERMISSIONS: Record<PersonaId, string[]> = {
  platform: ["tenant.create", "tenant.update", "application.review", "announcement.create"],
  hq: ["coach.review", "coach.invite", "class.create", "booking.create", "booking.cancel", "booking.checkin", "booking.complete", "settlement.confirm", "task.create", "task.complete", "announcement.create"],
  manager: ["coach.review", "coach.invite", "class.create", "booking.create", "booking.cancel", "booking.checkin", "booking.complete", "task.complete"],
  coach: ["booking.checkin", "booking.complete"],
  student: ["booking.create", "booking.cancel"],
};

/** 纯领域事务：复制后校验和变更；调用者仅通过一次 CAS 持久化整个结果。 */
export function applyAction(source: WorkspaceData, personaId: unknown, actionInput: unknown, payload: unknown, now = new Date()): WorkspaceData {
  const persona = getPersona(personaId);
  if (typeof actionInput !== "string" || !PERMISSIONS[persona.id].includes(actionInput)) fail("当前身份无权执行此操作。", 403);
  const action = actionInput as ActionName;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("操作参数格式不正确。");
  const p = payload as Record<string, unknown>;
  const data = structuredClone(source);
  const today = shanghaiDate(now);
  if (persona.tenantId) {
    const tenant = find(data.tenants, persona.tenantId, "品牌");
    if (tenant.status !== "active" || tenant.expiresAt < today) fail("当前品牌服务已暂停或到期，可查看数据；请联系平台续期后再操作。", 403);
  }
  const stamp = now.toISOString();
  switch (action) {
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
      if (tenant.status === "active" && tenant.expiresAt < today) fail("请先将服务有效期延长至今天之后，再启用品牌。");
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
    case "coach.review": {
      const coach = find(data.coaches, p.id, "教练"); tenantScope(persona, coach.tenantId); storeScope(persona, coach.storeId); const approved = bool(p, "approved");
      if (coach.status !== "pending") { if ((coach.status === "approved") === approved) return data; fail("教练已完成审核，不能重复变更审核结果。"); }
      if (approved && (!coach.certificate || coach.certificateExpiresAt < today)) fail("请先补齐有效的教练资质后再通过审核。");
      coach.status = approved ? "approved" : "rejected";
      addAudit(data, persona, action, `${approved ? "通过" : "驳回"}教练「${coach.name}」资质`, now, coach.storeId); break;
    }
    case "class.create": {
      const store = find(data.stores, p.storeId, "门店"); tenantScope(persona, store.tenantId); storeScope(persona, store.id);
      if (store.status !== "active") fail("门店已停用，无法排课。");
      const startAt = datetime(p, "startAt"); const endAt = datetime(p, "endAt"); const start = Date.parse(startAt); const end = Date.parse(endAt);
      if (start <= now.getTime()) fail("开课时间必须晚于当前时间。");
      if (end <= start || end - start > 8 * 3_600_000) fail("课程结束时间须晚于开始时间，单节课程最长 8 小时。");
      const cls: ClassSession = { id: uid("class"), tenantId: store.tenantId, storeId: store.id, coachId: text(p, "coachId"), name: text(p, "name", 60), type: text(p, "type", 40), startAt, endAt, capacity: number(p, "capacity", 1, 200), credits: number(p, "credits", 1, 20), price: number(p, "price", 0, 10_000_000), room: text(p, "room", 60), status: "scheduled" };
      const coach = validateCoach(data, cls);
      if (coach.storeId !== store.id) fail("该教练归属其他门店，当前暂不支持跨店排课。");
      if (data.classes.some((other) => other.status === "scheduled" && Date.parse(other.startAt) < end && Date.parse(other.endAt) > start && (other.coachId === cls.coachId || (other.storeId === store.id && other.room === cls.room)))) fail("教练或所选场地在该时段已有课程，请调整排课时间。");
      data.classes.push(cls); addAudit(data, persona, action, `在${store.name}发布「${cls.name}」`, now, store.id); break;
    }
    case "booking.create": {
      const cls = find(data.classes, p.classId, "课程"); courseScope(persona, cls);
      const card = find(data.cards, p.cardId, "课卡"); const memberId = typeof p.memberId === "string" ? p.memberId : (persona.memberId ?? card.memberId);
      memberScope(persona, memberId); const member = find(data.members, memberId, "学员"); tenantScope(persona, member.tenantId);
      if (member.tenantId !== cls.tenantId) fail("不能跨品牌预约课程。", 403);
      // 同学员同场次请求幂等：已成功预约不再次冻结课时。
      if (data.bookings.some((b) => b.classId === cls.id && b.memberId === memberId && b.status !== "cancelled")) return data;
      if (cls.status !== "scheduled" || Date.parse(cls.startAt) <= now.getTime()) fail("课程已开始或已取消，请选择其他课程。");
      if (find(data.stores, cls.storeId, "门店").status !== "active") fail("门店已停用，暂不能预约。");
      validateCoach(data, cls); validateCard(card, cls, memberId);
      if (data.bookings.filter((b) => b.classId === cls.id && b.status !== "cancelled").length >= cls.capacity) fail("本节课程已约满，请选择其他场次。");
      if (data.bookings.some((b) => { if (b.memberId !== memberId || !["reserved", "checked_in"].includes(b.status)) return false; const other = data.classes.find((c) => c.id === b.classId); return other && Date.parse(other.startAt) < Date.parse(cls.endAt) && Date.parse(other.endAt) > Date.parse(cls.startAt); })) fail("该学员在此时段已有预约，请选择其他时间。");
      card.frozen += cls.credits;
      data.bookings.unshift({ id: uid("booking"), tenantId: cls.tenantId, memberId, classId: cls.id, cardId: card.id, credits: cls.credits, status: "reserved", createdAt: stamp });
      addAudit(data, persona, action, `${member.name}预约「${cls.name}」，冻结 ${cls.credits} 课时`, now, cls.storeId); break;
    }
    case "booking.cancel": {
      const { booking, cls, card } = bookingContext(data, persona, p);
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
      card.frozen -= booking.credits; card.remaining -= booking.credits; booking.status = "completed"; booking.completedAt = stamp;
      if (card.storeId !== cls.storeId && !data.settlements.some((s) => s.bookingId === booking.id)) data.settlements.unshift({ id: uid("settlement"), tenantId: booking.tenantId, bookingId: booking.id, fromStoreId: card.storeId, toStoreId: cls.storeId, amount: card.unitValueCents * booking.credits, status: "pending", createdAt: stamp });
      addAudit(data, persona, action, `「${cls.name}」完成消课，扣除 ${booking.credits} 课时${card.storeId !== cls.storeId ? "并生成跨店清分单" : ""}`, now, cls.storeId); break;
    }
    case "settlement.confirm": {
      const settlement = find(data.settlements, p.id, "清分单"); tenantScope(persona, settlement.tenantId);
      if (settlement.status === "confirmed") return data;
      const booking = find(data.bookings, settlement.bookingId, "预约"); const card = find(data.cards, booking.cardId, "课卡"); const cls = find(data.classes, booking.classId, "课程");
      if (booking.status !== "completed" || settlement.amount !== card.unitValueCents * booking.credits || settlement.fromStoreId !== card.storeId || settlement.toStoreId !== cls.storeId || card.storeId === cls.storeId) fail("清分单与消课记录不一致，无法确认。");
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
  assertInvariants(data);
  return data;
}

export function assertInvariants(data: WorkspaceData) {
  for (const card of data.cards) {
    const frozen = data.bookings.filter((b) => b.cardId === card.id && ["reserved", "checked_in"].includes(b.status)).reduce((n, b) => n + b.credits, 0);
    if (!Number.isSafeInteger(card.remaining) || !Number.isSafeInteger(card.frozen) || card.remaining < 0 || card.frozen < 0 || card.frozen > card.remaining || card.remaining > card.total || frozen !== card.frozen) fail("课卡余额核对失败，操作已撤回。", 409);
  }
  const activeKeys = new Set<string>();
  for (const booking of data.bookings.filter((b) => b.status !== "cancelled")) {
    const key = `${booking.memberId}:${booking.classId}`;
    if (activeKeys.has(key)) fail("同一学员的课程存在重复预约，操作已撤回。", 409);
    activeKeys.add(key);
  }
  for (const cls of data.classes) if (data.bookings.filter((b) => b.classId === cls.id && b.status !== "cancelled").length > cls.capacity) fail("课程预约人数超过容量，操作已撤回。", 409);
  const settled = new Set<string>();
  for (const settlement of data.settlements) { if (settled.has(settlement.bookingId) || !Number.isSafeInteger(settlement.amount) || settlement.amount < 0) fail("清分记录重复或金额异常，操作已撤回。", 409); settled.add(settlement.bookingId); }
}

/** 所有 GET 和动作响应都走同一投影，避免通过切端读取越权数据。 */
export function projectWorkspace(source: WorkspaceData, personaId: unknown, version: number): WorkspaceResponse {
  const persona = getPersona(personaId);
  const data = structuredClone(source);
  data.classes = data.classes.map((cls) => ({ ...cls, bookedCount: source.bookings.filter((b) => b.classId === cls.id && b.status !== "cancelled").length }));
  if (persona.role !== "platform") {
    const tenantId = persona.tenantId;
    data.tenants = data.tenants.filter((t) => t.id === tenantId);
    data.stores = data.stores.filter((s) => s.tenantId === tenantId);
    data.coaches = data.coaches.filter((c) => c.tenantId === tenantId);
    data.members = data.members.filter((m) => m.tenantId === tenantId);
    data.cards = data.cards.filter((c) => c.tenantId === tenantId);
    data.classes = data.classes.filter((c) => c.tenantId === tenantId);
    data.bookings = data.bookings.filter((b) => b.tenantId === tenantId);
    data.settlements = data.settlements.filter((s) => s.tenantId === tenantId);
    data.tasks = data.tasks.filter((t) => t.tenantId === tenantId);
    data.audit = data.audit.filter((a) => a.tenantId === tenantId);
    data.applications = [];
    data.announcements = data.announcements.filter((a) => !a.tenantId || a.tenantId === tenantId);
  }
  if (persona.role === "manager" || persona.role === "coach") {
    data.classes = data.classes.filter((c) => c.storeId === persona.storeId && (persona.role !== "coach" || c.coachId === persona.coachId));
    const classIds = new Set(data.classes.map((c) => c.id));
    data.bookings = data.bookings.filter((b) => classIds.has(b.classId));
    const visitingMembers = new Set(data.bookings.map((b) => b.memberId));
    data.members = data.members.filter((m) => visitingMembers.has(m.id) || (persona.role === "manager" && m.storeId === persona.storeId));
    const bookingCardIds = new Set(data.bookings.map((b) => b.cardId));
    data.cards = data.cards.filter((c) => c.storeId === persona.storeId || bookingCardIds.has(c.id));
    data.stores = data.stores.filter((s) => s.id === persona.storeId);
    data.coaches = data.coaches.filter((c) => c.storeId === persona.storeId);
    data.tasks = data.tasks.filter((t) => t.storeId === persona.storeId);
    data.settlements = data.settlements.filter((s) => s.fromStoreId === persona.storeId || s.toStoreId === persona.storeId);
    data.audit = data.audit.filter((a) => a.storeId === persona.storeId);
    if (persona.role === "coach") { data.cards = []; data.settlements = []; data.audit = []; data.tasks = []; }
  }
  if (persona.role === "student") {
    const memberIds = new Set(persona.memberIds ?? [persona.memberId]);
    data.members = data.members.filter((m) => memberIds.has(m.id));
    data.cards = data.cards.filter((c) => memberIds.has(c.memberId));
    data.bookings = data.bookings.filter((b) => memberIds.has(b.memberId));
    data.coaches = data.coaches.filter((c) => c.status === "approved").map((c) => ({ ...c, phone: "", certificate: "", inviteCode: undefined }));
    data.settlements = []; data.tasks = []; data.audit = [];
    data.announcements = data.announcements.filter((a) => a.audience !== "staff");
  } else data.announcements = data.announcements.filter((a) => a.audience !== "students" || persona.role === "hq" || persona.role === "platform");
  return { data, persona: structuredClone(persona), personas: structuredClone(PERSONAS), version };
}
