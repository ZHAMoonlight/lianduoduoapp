import type { Booking, CoachBillPreview, CoachBillRule, CoachBillSession, CoachBillingFilter, CoachBillingReport, CoachBillingRow, CoachBillingTotals, Persona, WorkspaceData } from "./types";

export class CoachBillingError extends Error { constructor(message: string, public status = 400) { super(message); this.name = "CoachBillingError"; } }
function fail(message: string, status = 400): never { throw new CoachBillingError(message, status); }
function dateISO(now: Date): string { return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10); }
function validDate(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
export function coachBillingMonthRange(now = new Date()): { dateFrom: string; dateTo: string } {
  const day = dateISO(now), year = Number(day.slice(0, 4)), month = Number(day.slice(5, 7));
  return { dateFrom: `${day.slice(0, 7)}-01`, dateTo: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) };
}
function range(input: Record<string, unknown>, now: Date) {
  const defaults = coachBillingMonthRange(now), dateFrom = input.dateFrom ?? defaults.dateFrom, dateTo = input.dateTo ?? defaults.dateTo;
  if (!validDate(dateFrom) || !validDate(dateTo) || dateFrom > dateTo || Date.parse(dateTo) - Date.parse(dateFrom) > 365 * 86400000) fail("请选择不超过 366 天的有效账期，开始日期不能晚于结束日期。");
  return { dateFrom, dateTo };
}
function id(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim() || value.trim().length > 191) fail(`请选择有效的${name}。`); return value.trim(); }
/** Authorise against the teaching store, not the coach's current approval or assignment. */
export function authorizedCoachBillingFilter(data: WorkspaceData, persona: Persona, input: unknown, now = new Date()): CoachBillingFilter {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("报表参数无效。");
  const p = input as Record<string, unknown>;
  if (Object.keys(p).some(key => !["coachId", "storeId", "dateFrom", "dateTo", "rule", "note", "expectedPreviewHash"].includes(key))) fail("报表包含不能自行指定的范围或字段。", 403);
  if (!["hq", "manager", "coach"].includes(persona.role) || !persona.tenantId) fail("当前身份无权查看教练账单报表。", 403);
  const tenant = data.tenants.find(item => item.id === persona.tenantId);
  if (!tenant) fail("训练空间不存在。", 403);
  let coachId = p.coachId === undefined ? undefined : id(p.coachId, "教练");
  if (persona.role === "coach") { if (coachId && coachId !== persona.coachId) fail("只能查看本人的教练报表。", 403); coachId = persona.coachId; if (!coachId) fail("教练授权无效。", 403); }
  if (coachId && !data.coaches.some(coach => coach.id === coachId && coach.tenantId === tenant.id)) fail("教练不属于当前训练空间。", 403);
  let storeId: string | undefined;
  if (p.storeId !== undefined) { if (typeof p.storeId !== "string" || p.storeId.length > 191) fail("请选择有效授课门店。"); storeId = p.storeId.trim(); }
  if (tenant.mode === "solo") { if (storeId !== undefined && storeId !== "") fail("独立训练空间没有门店。", 403); storeId = ""; }
  else {
    if (persona.role === "manager" || persona.role === "coach") { if (storeId !== undefined && storeId !== persona.storeId) fail("只能查看本门店的授课报表。", 403); storeId = persona.storeId; if (!storeId) fail("门店授权无效。", 403); }
    if (storeId !== undefined && !data.stores.some(store => store.id === storeId && store.tenantId === tenant.id)) fail("只能查看当前品牌内的授课门店。", 403);
  }
  return { tenantId: tenant.id, ...range(p, now), ...(coachId ? { coachId } : {}), ...(storeId !== undefined ? { storeId } : {}) };
}
function validStamp(value: unknown): value is string { return typeof value === "string" && validDate(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value)); }
function completion(data: WorkspaceData, booking: Booking, startAt: string, now: Date): { at: string; source: CoachBillingRow["completionSource"] } | undefined {
  const valid = (value: unknown): value is string => validStamp(value) && Date.parse(value) >= Date.parse(startAt) && Date.parse(value) <= now.getTime();
  if (booking.completedAt !== undefined && booking.completedAt !== "") return valid(booking.completedAt) ? { at: booking.completedAt, source: "booking_completedAt" } : undefined;
  const ledger = data.ledger.filter(entry => entry.type === "consume" && entry.note === "booking.complete" && entry.bookingId === booking.id && entry.tenantId === booking.tenantId && entry.memberId === booking.memberId && entry.cardId === booking.cardId && valid(entry.createdAt)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return ledger ? { at: ledger.createdAt, source: "consume_ledger" } : undefined;
}
function safe(value: number): number { if (!Number.isSafeInteger(value) || value < 0) fail("金额或统计数量超出可安全计算范围，请缩小账期。"); return value; }
function revenue(data: WorkspaceData, booking: Booking): { amount: number | null; source: CoachBillingRow["revenueSource"]; estimated: boolean } {
  const ledger = data.ledger.filter(entry => entry.type === "consume" && entry.bookingId === booking.id && entry.tenantId === booking.tenantId && entry.memberId === booking.memberId && entry.cardId === booking.cardId && !["booking.no_show", "booking.latecancel"].includes(entry.note));
  if (ledger.length) return ledger.every(entry => Number.isSafeInteger(entry.amount)) ? { amount: safe(ledger.reduce((sum, entry) => sum + Math.abs(entry.amount), 0)), source: "consume_ledger", estimated: false } : { amount: null, source: "missing", estimated: false };
  const card = data.cards.find(item => item.id === booking.cardId && item.tenantId === booking.tenantId && item.memberId === booking.memberId);
  if (!card || !Number.isSafeInteger(card.unitValueCents) || card.unitValueCents < 0) return { amount: null, source: "missing", estimated: false };
  return { amount: safe(card.unitValueCents * booking.credits), source: "card_estimate", estimated: true };
}
function sessions(rows: CoachBillingRow[]): CoachBillSession[] {
  const groups = new Map<string, CoachBillSession>();
  for (const row of rows) {
    let item = groups.get(row.classId);
    if (!item) { item = { classId: row.classId, className: row.className, startAt: row.startAt, endAt: row.endAt, durationMinutes: (Date.parse(row.endAt) - Date.parse(row.startAt)) / 60000, bookingIds: [] }; groups.set(row.classId, item); }
    item.bookingIds.push(row.bookingId);
  }
  return [...groups.values()];
}
function totals(rows: CoachBillingRow[], excludedCompletionCount = 0): CoachBillingTotals {
  return { sessionCount: new Set(rows.map(row => row.classId)).size, completedCount: rows.length, credits: safe(rows.reduce((sum, row) => sum + row.credits, 0)), durationMinutes: Math.round(sessions(rows).reduce((sum, item) => sum + item.durationMinutes, 0) * 100) / 100, consumedAmountCents: safe(rows.reduce((sum, row) => sum + (row.consumedAmountCents ?? 0), 0)), estimatedCount: rows.filter(row => row.estimated).length, missingAmountCount: rows.filter(row => row.consumedAmountCents === null).length, ledgerCompletionCount: rows.filter(row => row.completionSource === "consume_ledger").length, excludedCompletionCount, flatBlockedSessionCount: new Set(rows.filter(row => !row.flatEligible).map(row => row.classId)).size };
}
export function buildCoachBillingReport(data: WorkspaceData, filter: CoachBillingFilter, now = new Date()): CoachBillingReport {
  const dates = range(filter as unknown as Record<string, unknown>, now), rows: CoachBillingRow[] = [];
  const classes = new Map(data.classes.map(cls => [cls.id, cls]));
  let excluded = 0;
  for (const booking of data.bookings) {
    const cls = classes.get(booking.classId);
    if (booking.status !== "completed" || !cls || booking.tenantId !== filter.tenantId || cls.tenantId !== filter.tenantId || filter.coachId && cls.coachId !== filter.coachId || filter.storeId !== undefined && cls.storeId !== filter.storeId || !validStamp(cls.startAt) || !validStamp(cls.endAt) || Date.parse(cls.endAt) <= Date.parse(cls.startAt)) continue;
    const day = dateISO(new Date(cls.startAt));if (day < dates.dateFrom || day > dates.dateTo) continue;
    const completed = completion(data, booking, cls.startAt, now);
    if (!completed || !Number.isSafeInteger(booking.credits) || booking.credits <= 0) { excluded++; continue; }
    const booked = (data.coachBills ?? []).find(bill => bill.tenantId === filter.tenantId && bill.details.some(detail => detail.bookingId === booking.id));
    const classBilled = (data.coachBills ?? []).some(bill => bill.tenantId === filter.tenantId && bill.sessions.some(session => session.classId === cls.id));
    const related = data.bookings.filter(item => item.classId === cls.id && item.tenantId === cls.tenantId);
    const pending = related.some(item => ["reserved", "checked_in"].includes(item.status));
    const invalidCompletion = related.some(item => item.status === "completed" && !completion(data, item, cls.startAt, now));
    const reason = classBilled ? "该课次已入账，不能重复计固定课酬" : pending ? "该课次仍有待处理预约，处理完成后才能计固定课酬" : invalidCompletion ? "该课次有完成时间待核对的记录，暂不能计固定课酬" : undefined;
    const value = revenue(data, booking);
    rows.push({ bookingId: booking.id, classId: cls.id, coachId: cls.coachId, coachName: data.coaches.find(coach => coach.id === cls.coachId)?.name || "历史教练", storeId: cls.storeId, storeName: cls.storeId ? data.stores.find(store => store.id === cls.storeId)?.name || "历史门店" : "独立训练空间", memberId: booking.memberId, memberName: data.members.find(member => member.id === booking.memberId)?.name || "历史学员", className: cls.name, classType: cls.type, startAt: cls.startAt, endAt: cls.endAt, completedAt: completed.at, completionSource: completed.source, credits: booking.credits, consumedAmountCents: value.amount, estimated: value.estimated, revenueSource: value.source, ...(booked ? { existingBillId: booked.id, existingBillStatus: booked.status } : {}), flatEligible: !reason, ...(reason ? { flatBlockedReason: reason } : {}) });
  }
  rows.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || a.coachId.localeCompare(b.coachId) || a.bookingId.localeCompare(b.bookingId));
  const summary = totals(rows, excluded), notes: string[] = [];
  if (excluded) notes.push(`${excluded} 条已标记完成的记录缺少可靠完成时间、时间异常或课时异常，已排除并需核对。`);
  if (summary.ledgerCompletionCount) notes.push(`${summary.ledgerCompletionCount} 条历史记录以明确消课流水时间作为完成依据。`);
  if (summary.estimatedCount) notes.push(`${summary.estimatedCount} 条消课金额按课卡单位价值估算，不是实际收款流水。`);
  if (summary.missingAmountCount) notes.push(`${summary.missingAmountCount} 条记录缺少可核对的消课金额；金额合计仅包含已知金额，未知金额不能用于提成。`);
  const pendingCount = new Set(rows.filter(row => row.flatBlockedReason?.includes("待处理预约")).map(row => row.classId)).size;
  if (pendingCount) notes.push(`${pendingCount} 节课仍有待处理预约，暂不能计固定课酬。`);
  return { ...dates, ...(filter.coachId ? { coachId: filter.coachId } : {}), ...(filter.storeId !== undefined ? { storeId: filter.storeId } : {}), rows, totals: summary, notes };
}
function ruleOf(value: unknown): CoachBillRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("请选择有效的教练课酬规则。");
  const rule = value as Record<string, unknown>;
  if (rule.type === "flat_session" && Object.keys(rule).every(key => ["type", "sessionAmountCents"].includes(key)) && Number.isSafeInteger(rule.sessionAmountCents) && Number(rule.sessionAmountCents) >= 1 && Number(rule.sessionAmountCents) <= 100_000_000) return { type: "flat_session", sessionAmountCents: Number(rule.sessionAmountCents) };
  if (rule.type === "revenue_share" && Object.keys(rule).every(key => ["type", "basisPoints"].includes(key)) && Number.isSafeInteger(rule.basisPoints) && Number(rule.basisPoints) >= 1 && Number(rule.basisPoints) <= 10000) return { type: "revenue_share", basisPoints: Number(rule.basisPoints) };
  fail("固定课酬须为 1–100000000 整数分，提成比例须为 1–10000 整数基点。");
}
/** Deterministic change fingerprint, not an authentication token. No Node dependency. */
function fingerprint(text: string): string {
  const mask = (BigInt(1) << BigInt(64)) - BigInt(1);let first = BigInt("14695981039346656037"), second = BigInt("7809847782465536322");
  for (const letter of text) { const code = BigInt(letter.codePointAt(0)!); first = ((first ^ code) * BigInt("1099511628211")) & mask;second = ((second ^ code) * BigInt("14029467366897019727")) & mask; }
  return first.toString(16).padStart(16, "0") + second.toString(16).padStart(16, "0");
}
function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJSON(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function previewCoachBill(data: WorkspaceData, input: CoachBillingFilter & { rule: unknown }, now = new Date()): CoachBillPreview {
  if (!input.coachId) fail("创建账单前请选择一位教练。");
  const coach = data.coaches.find(item => item.id === input.coachId && item.tenantId === input.tenantId);if (!coach) fail("教练不属于当前训练空间。", 403);
  const storeId = input.storeId ?? coach.storeId, rule = ruleOf(input.rule);
  if (storeId !== "" && !data.stores.some(store => store.id === storeId && store.tenantId === input.tenantId) || storeId === "" && !data.tenants.some(tenant => tenant.id === input.tenantId && tenant.mode === "solo")) fail("请选择当前品牌内的授课门店。", 403);
  const report = buildCoachBillingReport(data, { ...input, storeId }, now), notes = [...report.notes];
  const eligible = report.rows.filter(row => !row.existingBillId && (rule.type === "flat_session" ? row.flatEligible : row.consumedAmountCents !== null));
  const blockedClasses = new Map(report.rows.filter(row => !row.existingBillId && !row.flatEligible).map(row => [row.classId, row]));
  if (rule.type === "flat_session") for (const row of blockedClasses.values()) notes.push(`${row.className}：${row.flatBlockedReason}。`);
  const details = eligible.map(row => ({ ...row, amountCents: 0 })), grouped = sessions(details);
  let amountCents = 0;
  if (rule.type === "flat_session") {
    amountCents = safe(grouped.length * rule.sessionAmountCents);
    for (const session of grouped) details.find(row => row.bookingId === session.bookingIds[0])!.amountCents = rule.sessionAmountCents;
    notes.push("固定课酬按独立课次计算，每节课的费用仅列在该课第一条明细，学员人次不重复计费。");
  } else {
    const products = details.map((row, index) => ({ index, product: BigInt(row.consumedAmountCents!) * BigInt(rule.basisPoints) }));
    const totalProduct = products.reduce((sum, item) => sum + item.product, BigInt(0));amountCents = safe(Number((totalProduct + BigInt(5000)) / BigInt(10000)));
    for (const item of products) details[item.index].amountCents = Number(item.product / BigInt(10000));
    let remainder = amountCents - details.reduce((sum, row) => sum + row.amountCents, 0);
    for (const item of products.sort((a, b) => Number(b.product % BigInt(10000) - a.product % BigInt(10000)) || a.index - b.index)) { if (!remainder) break;details[item.index].amountCents++;remainder--; }
    notes.push("提成按消课金额合计四舍五入到分，明细按最大余数分配，合计与应付金额一致。");
  }
  const preview = { tenantId: input.tenantId, coachId: coach.id, coachName: coach.name, storeId, storeName: storeId ? data.stores.find(store => store.id === storeId)?.name || "历史门店" : "独立训练空间", dateFrom: report.dateFrom, dateTo: report.dateTo, rule, details, sessions: grouped, totals: totals(details, report.totals.excludedCompletionCount), amountCents, blocking: details.length ? [] : ["该账期没有符合当前规则且尚未入账的履约记录，请核对待处理预约、完成依据或已有账单。"], notes };
  return { ...preview, previewHash: fingerprint(stableJSON(preview)) };
}

export function assertCoachBillingInvariants(data: WorkspaceData) {
  const ids = new Set<string>(), bookings = new Set<string>(), flatClasses = new Set<string>();
  for (const bill of data.coachBills ?? []) {
    if (ids.has(bill.id) || !bill.id || !["unpaid", "paid"].includes(bill.status) || !Array.isArray(bill.details) || !bill.details.length || !Array.isArray(bill.sessions) || !bill.sessions.length || bill.blocking.length || !Number.isSafeInteger(bill.amountCents) || bill.amountCents < 0) fail("教练账单快照异常，操作已撤回。", 409);
    ids.add(bill.id);
    const { id: billId, status, note, createdAt, createdBy, settledAt, settledBy, paidDate, ref, settleNote, previewHash, ...snapshot } = bill;
    void billId; void note; void createdBy; void settledBy; void ref; void settleNote;
    if (fingerprint(stableJSON(snapshot)) !== previewHash || !validStamp(createdAt) || (status === "paid" && (!validDate(paidDate) || !validStamp(settledAt)))) fail("教练账单快照或结算记录异常，操作已撤回。", 409);
    if (!data.coaches.some(coach => coach.id === bill.coachId && coach.tenantId === bill.tenantId) || !(bill.storeId === "" ? data.tenants.some(tenant => tenant.id === bill.tenantId && tenant.mode === "solo") : data.stores.some(store => store.id === bill.storeId && store.tenantId === bill.tenantId))) fail("教练账单归属异常，操作已撤回。", 409);
    if (bill.details.some(row => row.coachId !== bill.coachId || row.storeId !== bill.storeId || !Number.isSafeInteger(row.amountCents) || row.amountCents < 0) || safe(bill.details.reduce((sum, row) => sum + row.amountCents, 0)) !== bill.amountCents) fail("教练账单明细金额异常，操作已撤回。", 409);
    for (const row of bill.details) { if (bookings.has(row.bookingId)) fail("同一履约重复入教练账单，操作已撤回。", 409);bookings.add(row.bookingId); }
    if (bill.rule.type === "flat_session") for (const session of bill.sessions) { if (flatClasses.has(session.classId)) fail("同一课次重复计固定课酬，操作已撤回。", 409);flatClasses.add(session.classId); }
  }
}
