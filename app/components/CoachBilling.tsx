"use client";

import { Fragment, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDownToLine, CalendarDays, Check, ChevronDown, ChevronRight, ClipboardList, FileText, Info, Plus, RefreshCw, Users, Wallet, X } from "lucide-react";
import type { ActionName, CoachBill, CoachBillDetail, CoachBillPreview, CoachBillPreviewPayload, CoachBillingReport, CoachBillingRow, Persona, WorkspaceData } from "@/lib/types";
import { coachBillingMonthRange } from "@/lib/coach-billing";
import { requestJSON } from "./AuthGate";
import { coachServesStore } from "@/lib/coach-stores";
import { ExperienceDatePicker } from "./ExperienceDatePicker";
import { ExperienceSelect } from "./ExperienceSelect";
import "./coach-billing.css";

interface Props {
  data: WorkspaceData;
  persona: Persona;
  busy: boolean;
  act: (action: ActionName, payload: Record<string, unknown>, onError?: (message: string) => void) => Promise<boolean>;
  notify?: (message: string, tone?: "success" | "error" | "info") => void;
}
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dateOf = (value: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
const clock = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
const money = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? "待核对" : `¥${(value / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ruleLabel = (rule: CoachBillPreview["rule"]) => rule.type === "flat_session" ? `${money(rule.sessionAmountCents)} / 节` : `消课价值 × ${(rule.basisPoints / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
function coachChoices(data: WorkspaceData, tenantId: string | undefined, storeId: string, reportRows: CoachBillingRow[] = []) {
  const ids = new Set(data.coaches.filter(coach => coach.tenantId === tenantId && (storeId === "all" || coachServesStore(coach, storeId))).map(coach => coach.id));
  for (const course of data.classes) if (course.tenantId === tenantId && (storeId === "all" || course.storeId === storeId)) ids.add(course.coachId);
  for (const row of reportRows) if (storeId === "all" || row.storeId === storeId) ids.add(row.coachId);
  for (const bill of data.coachBills || []) if (bill.tenantId === tenantId && (storeId === "all" || bill.storeId === storeId)) ids.add(bill.coachId);
  return [...ids].map(id => {
    const coach = data.coaches.find(item => item.id === id), row = reportRows.find(item => item.coachId === id), bill = data.coachBills?.find(item => item.coachId === id);
    return { id, name: coach?.name || row?.coachName || bill?.coachName || `历史授课教练 · ${id}`, specialty: coach?.specialty || "有该范围的真实授课或账单记录" };
  });
}
function csvCell(value: string | number | null) {
  let text = value === null ? "待核对" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function downloadCSV(filename: string, headings: string[], rows: (string | number | null)[][]) {
  const blob = new Blob(["\ufeff", [headings, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
function exportRows(rows: CoachBillingRow[], filename: string) {
  downloadCSV(filename, ["授课日期（北京时间）", "开始", "结束", "教练", "门店", "课程", "学员", "完成课时", "消课价值（元）", "金额依据", "履约时间依据", "入账状态", "账单编号"], rows.map(row => [dateOf(row.startAt), clock(row.startAt), clock(row.endAt), row.coachName, row.storeName, row.className, row.memberName, row.credits, row.consumedAmountCents === null ? null : (row.consumedAmountCents / 100).toFixed(2), row.revenueSource === "consume_ledger" ? "实际消课流水" : row.revenueSource === "card_estimate" ? "课包课时价值估算" : "金额缺失待核对", row.completionSource === "consume_ledger" ? "历史消课流水时间" : "完成教学时间", row.existingBillId ? row.existingBillStatus === "paid" ? "已结算" : "已入待结账单" : "未入账", row.existingBillId || ""]));
}
function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="cb-empty"><ClipboardList size={28}/><h3>{title}</h3><p>{children}</p></div>; }
function Notes({ notes }: { notes: string[] }) { return notes.length ? <div className="cb-notice"><Info size={16}/><div>{notes.map((note, index) => <p key={index} style={{ margin: index ? "6px 0 0" : 0 }}>{note}</p>)}</div></div> : null; }
function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="cb-dialog" aria-labelledby={id} onCancel={event => { if (event.currentTarget.querySelector('[data-exp-select-popup], [data-exp-date-popup], [data-exp-time-popup]')) event.preventDefault(); else onClose(); }}><div className="cb-dialog-head"><h2 id={id}>{title}</h2><button type="button" className="cb-close" aria-label="关闭账单弹窗" onClick={onClose}><X size={19}/></button></div><div className="cb-dialog-body">{children}</div>{footer && <div className="cb-dialog-actions">{footer}</div>}</dialog>;
}
function DetailTable({ rows, payment = false }: { rows: CoachBillingRow[] | CoachBillDetail[]; payment?: boolean }) {
  return <div className="cb-table-scroll"><table className="cb-table"><thead><tr><th>授课时间</th><th>课程 / 学员</th><th>完成课时</th><th>消课价值</th><th>{payment ? "分摊课酬" : "入账状态"}</th></tr></thead><tbody>{rows.map(row => <tr key={row.bookingId}><td>{dateOf(row.startAt)}<small className="cb-cell-sub">{clock(row.startAt)}–{clock(row.endAt)}</small>{row.completionSource === "consume_ledger" && <small className="cb-cell-sub">按历史消课流水核验履约</small>}</td><td><strong>{row.className}</strong><small className="cb-cell-sub">{row.memberName} · {row.coachName} · {row.storeName}</small></td><td>{row.credits}</td><td>{money(row.consumedAmountCents)}{row.estimated && <small className="cb-cell-sub cb-value-warning">课包价值估算</small>}{row.consumedAmountCents === null && <small className="cb-cell-sub cb-value-warning">原始金额缺失</small>}</td><td>{payment ? money((row as CoachBillDetail).amountCents) : row.existingBillId ? <span className={`cb-pill ${row.existingBillStatus}`}>{row.existingBillStatus === "paid" ? "已结算" : "已入待结账单"}</span> : <><span className="cb-pill">未入账</span>{!row.flatEligible && row.flatBlockedReason && <small className="cb-cell-sub">{row.flatBlockedReason}</small>}</>}</td></tr>)}</tbody></table></div>;
}

function CreateBill({ data, persona, busy, act, initialFrom, initialTo, initialCoach, initialStore, reportRows, onClose, onCreated }: Props & { initialFrom: string; initialTo: string; initialCoach: string; initialStore: string; reportRows: CoachBillingRow[]; onClose: () => void; onCreated: () => void }) {
  const solo = (persona.workspaceMode || data.tenants.find(tenant => tenant.id === persona.tenantId)?.mode) === "solo";
  const [coachId, setCoach] = useState(initialCoach === "all" ? "" : initialCoach), [storeId, setStore] = useState(solo ? "" : persona.role === "manager" ? persona.storeId || "" : initialStore === "all" ? "" : initialStore);
  const [dateFrom, setFrom] = useState(initialFrom), [dateTo, setTo] = useState(initialTo), [ruleType, setRule] = useState<"flat_session" | "revenue_share">("flat_session"), [rate, setRate] = useState(""), [note, setNote] = useState("");
  const [checked, setChecked] = useState<{ key: string; source: WorkspaceData; value: CoachBillPreview } | null>(null), [error, setError] = useState(""), [checking, setChecking] = useState(false), [saving, setSaving] = useState(false);
  const epoch = useRef(0), controller = useRef<AbortController | null>(null);
  const stores = data.stores.filter(store => store.tenantId === persona.tenantId);
  const coaches = coachChoices(data, persona.tenantId, solo ? "" : storeId || "all", reportRows);
  const rateValid = /^\d+(?:\.\d{1,2})?$/.test(rate) && Number(rate) > 0 && Number(rate) <= (ruleType === "revenue_share" ? 100 : 1000000);
  const payload: CoachBillPreviewPayload = { coachId, storeId: solo ? "" : storeId, dateFrom, dateTo, rule: ruleType === "flat_session" ? { type: "flat_session", sessionAmountCents: Math.round(Number(rate) * 100) } : { type: "revenue_share", basisPoints: Math.round(Number(rate) * 100) }, note: note.trim() };
  const key = JSON.stringify(payload), preview = checked?.key === key && checked.source === data ? checked.value : null;
  const ready = !!coachId && (solo || !!storeId) && !!dateFrom && !!dateTo && dateFrom <= dateTo && rateValid;
  function change(update: () => void) { epoch.current += 1; controller.current?.abort(); setChecking(false); setChecked(null); setError(""); update(); }
  useEffect(() => () => { epoch.current += 1; controller.current?.abort(); }, []);
  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!ready || busy || saving) return;
    const serial = ++epoch.current; controller.current?.abort(); controller.current = new AbortController();
    setChecking(true); setChecked(null); setError("");
    try { const result = await requestJSON<CoachBillPreview>("/api/coach-bills/preview", { method: "POST", body: JSON.stringify({ payload }), signal: controller.current.signal }); if (serial === epoch.current) setChecked({ key, source: data, value: result }); }
    catch (issue) { if (serial === epoch.current && !controller.current?.signal.aborted) setError(issue instanceof Error ? issue.message : "预览暂未完成，请重试。"); }
    finally { if (serial === epoch.current) setChecking(false); }
  }
  async function create() {
    if (!preview || preview.blocking.length || !preview.details.length || busy || saving || checking) return;
    setSaving(true); setError(""); let reason = "";
    try { if (await act("coachBill.create", { ...payload, expectedPreviewHash: preview.previewHash }, message => { reason = message; setError(message); })) onCreated(); else { setChecked(null); if (!reason) setError("账单尚未生成，请重新预览后重试。"); } } finally { setSaving(false); }
  }
  return <Dialog title="生成教练结算账单" onClose={onClose} footer={<><button type="button" className="cb-button" disabled={busy || saving} onClick={onClose}>取消</button><button type="submit" form="cb-create-form" className="cb-button" disabled={!ready || busy || saving || checking}>{checking ? "正在核验…" : "预览完整账单"}</button><button type="button" className="cb-button primary" disabled={!preview || !!preview.blocking.length || !preview.details.length || busy || saving || checking} onClick={() => void create()}>{saving ? "正在生成…" : "确认生成账单"}<Check size={13}/></button></>}>
    <div className="cb-notice"><Info size={16}/><span>请按实际约定填写课酬规则。预览仅包含尚未入账的已完成教学记录，确认后保留完整快照；此操作不会发起支付。</span></div>
    <form id="cb-create-form" onSubmit={check}><fieldset className="cb-form-fields" disabled={busy || saving}><div className="cb-form-grid">
      {!solo && <div className="cb-field"><label>结算门店</label>{persona.role === "manager" ? <strong>{stores.find(store => store.id === storeId)?.name || "本门店"}</strong> : <ExperienceSelect aria-label="账单结算门店" required value={storeId} onValueChange={value => change(() => { setStore(value); setCoach(""); })} placeholder="选择一个门店" emptyMessage="暂无门店，无法生成门店账单。" options={stores.map(store => ({ value: store.id, label: store.name }))}/>}</div>}
      <div className={`cb-field ${solo ? "full" : ""}`}><label>结算教练</label><ExperienceSelect aria-label="账单结算教练" required value={coachId} onValueChange={value => change(() => setCoach(value))} placeholder="选择一位教练" emptyMessage="该范围暂无教练档案。" options={coaches.map(coach => ({ value: coach.id, label: coach.name, description: coach.specialty }))}/></div>
      <label className="cb-field">授课开始日期<ExperienceDatePicker aria-label="账单授课开始日期" required value={dateFrom} onValueChange={value => change(() => setFrom(value))}/></label><label className="cb-field">授课结束日期<ExperienceDatePicker aria-label="账单授课结束日期" required value={dateTo} onValueChange={value => change(() => setTo(value))}/></label>
    </div><div className="cb-rule-choice" role="group" aria-label="课酬计算规则"><button type="button" aria-pressed={ruleType === "flat_session"} className={ruleType === "flat_session" ? "selected" : ""} onClick={() => change(() => { setRule("flat_session"); setRate(""); })}><CalendarDays size={16}/>每节固定课酬</button><button type="button" aria-pressed={ruleType === "revenue_share"} className={ruleType === "revenue_share" ? "selected" : ""} onClick={() => change(() => { setRule("revenue_share"); setRate(""); })}><Wallet size={16}/>已消课金额提成</button></div>
    <label className="cb-field">{ruleType === "flat_session" ? "每节课酬（元 / 节）" : "消课金额提成比例（%）"}<input required inputMode="decimal" type="number" min="0.01" max={ruleType === "flat_session" ? 1000000 : 100} step="0.01" value={rate} placeholder={ruleType === "flat_session" ? "例如：100.00，按实际约定填写" : "例如：30，表示消课价值的 30%"} onChange={event => change(() => setRate(event.target.value))}/><small>{ruleType === "flat_session" ? "同一课次有多位完成学员时，只计一节固定课酬。" : "按已完成教学对应的消课价值计提；金额缺失的记录不能参与提成计算。"}</small></label><label className="cb-field">账单备注（选填）<textarea value={note} maxLength={500} rows={2} placeholder="可填写本次课酬约定或核对说明" onChange={event => change(() => setNote(event.target.value))}/></label>
    </fieldset></form>
    {dateFrom && dateTo && dateFrom > dateTo && <p className="cb-error">结束日期不能早于开始日期。</p>}{error && <p className="cb-error" role="alert">{error}</p>}
    {checked && checked.source !== data && <div className="cb-notice"><Info size={16}/><span>数据已更新，请重新预览核对后再生成账单。</span></div>}
    {preview && <><div className="cb-preview-total"><div><span>本次应付课酬 · {preview.coachName}</span><strong>{money(preview.amountCents)}</strong></div><p>{ruleLabel(preview.rule)}<br/>{preview.sessions.length} 节课 · {preview.details.length} 完成人次<br/>已入账记录自动排除；以下是本次完整快照。</p></div><Notes notes={preview.notes}/>{preview.blocking.length > 0 && <p className="cb-error" role="alert">{preview.blocking.join("；")}</p>}<div className="cb-preview-table"><DetailTable rows={preview.details} payment/></div></>}
  </Dialog>;
}

function BillDetail({ bill, canManage, busy, act, onClose }: { bill: CoachBill; canManage: boolean; busy: boolean; act: Props["act"]; onClose: () => void }) {
  const [error, setError] = useState(""), [saving, setSaving] = useState(false);
  async function settle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || saving || bill.status !== "unpaid" || !canManage) return;
    const form = new FormData(event.currentTarget); setSaving(true); setError(""); let reason = "";
    try { if (await act("coachBill.settle", { id: bill.id, paidDate: String(form.get("paidDate") || ""), ref: String(form.get("ref") || "").trim(), note: String(form.get("note") || "").trim() }, message => { reason = message; setError(message); })) onClose(); else if (!reason) setError("结算状态尚未保存，请根据页面提示重试。"); } finally { setSaving(false); }
  }
  return <Dialog title="教练结算账单详情" onClose={onClose} footer={<><button type="button" className="cb-button" onClick={() => downloadCSV(`教练账单_${bill.id}.csv`, ["账单编号", "教练", "授课日期", "课程", "学员", "消课价值（元）", "课酬分摊（元）", "金额依据", "课酬规则", "分摊口径"], bill.details.map(row => [bill.id, bill.coachName, dateOf(row.startAt), row.className, row.memberName, row.consumedAmountCents === null ? null : (row.consumedAmountCents / 100).toFixed(2), (row.amountCents / 100).toFixed(2), row.estimated ? "估算" : row.revenueSource === "missing" ? "金额缺失" : "消课流水", ruleLabel(bill.rule), bill.rule.type === "flat_session" ? "同课次固定课酬只计一节，首条明细承载该课金额，其余为0；不能按完成人次累加固定金额" : "按该明细消课价值和提成比例计算"]))}><ArrowDownToLine size={13}/>导出明细</button><button type="button" className="cb-button" disabled={saving} onClick={onClose}>关闭</button>{canManage && bill.status === "unpaid" && <button type="submit" form="cb-settle-form" className="cb-button primary" disabled={busy || saving}>{saving ? "正在登记…" : "登记已结算"}<Check size={13}/></button>}</>}>
    <div className="cb-preview-total"><div><span>{bill.coachName} · {bill.status === "paid" ? "已结算课酬" : "待结算课酬"}</span><strong>{money(bill.amountCents)}</strong></div><p>{bill.storeName || "独立训练空间"}<br/>{bill.dateFrom} 至 {bill.dateTo}<br/>{ruleLabel(bill.rule)}</p></div>
    <div className="cb-bill-meta"><div><span>账单编号</span><strong>{bill.id}</strong></div><div><span>生成日期</span><strong>{dateOf(bill.createdAt)}</strong></div><div><span>完整快照</span><strong>{bill.sessions.length} 节课程 · {bill.details.length} 完成人次</strong></div><div><span>账单状态</span><span className={`cb-pill ${bill.status}`}>{bill.status === "paid" ? "已登记线下结算" : "待结算"}</span></div>{bill.note && <div><span>账单备注</span><strong>{bill.note}</strong></div>}</div>
    <Notes notes={bill.notes}/><div className="cb-preview-table"><DetailTable rows={bill.details} payment/></div>
    {bill.status === "paid" ? <div className="cb-bill-meta"><div><span>实际结算日期</span><strong>{bill.paidDate || "未记录"}</strong></div><div><span>转账参考</span><strong>{bill.ref || "未填写"}</strong></div>{bill.settleNote && <div><span>结算备注</span><strong>{bill.settleNote}</strong></div>}</div> : canManage ? <form id="cb-settle-form" className="cb-settlement-form" onSubmit={settle}><h3>登记已在线下完成的结算</h3><div className="cb-notice"><Info size={16}/><span>请先完成实际支付，再登记结算日期。这里只保存已支付事实，不会发起转账或支付。</span></div><fieldset className="cb-form-fields" disabled={busy || saving}><div className="cb-form-grid"><label className="cb-field">实际结算日期<ExperienceDatePicker name="paidDate" aria-label="实际结算日期" required max={today()} defaultValue={today()}/></label><label className="cb-field">转账参考 / 流水号（选填）<input name="ref" maxLength={200} placeholder="可填写实际转账流水号"/></label><label className="cb-field full">结算备注（选填）<textarea name="note" maxLength={500} rows={2} placeholder="可记录实际结算说明"/></label></div></fieldset>{error && <p className="cb-error" role="alert">{error}</p>}</form> : <div className="cb-notice"><Info size={16}/><span>此账单尚未登记结算，请联系管理员核对实际支付情况。</span></div>}
  </Dialog>;
}

export function CoachBilling({ data, persona, busy, act, notify }: Props) {
  const solo = (persona.workspaceMode || data.tenants.find(tenant => tenant.id === persona.tenantId)?.mode) === "solo";
  const isCoach = persona.role === "coach", canManage = persona.role === "hq" || persona.role === "manager";
  const [range, setRange] = useState(() => coachBillingMonthRange()), [storeFilter, setStore] = useState("all"), [coachFilter, setCoach] = useState("all"), [tab, setTab] = useState("report");
  const [expanded, setExpanded] = useState<string | null>(null), [createOpen, setCreateOpen] = useState(false), [billId, setBillId] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{ key: string; source: WorkspaceData; value: CoachBillingReport } | null>(null), [loadError, setLoadError] = useState<{ key: string; source: WorkspaceData; message: string } | null>(null);
  const storeId = solo ? "" : persona.role === "manager" ? persona.storeId || "" : storeFilter;
  const coachId = isCoach ? persona.coachId || "" : coachFilter;
  const stores = data.stores.filter(store => store.tenantId === persona.tenantId && (persona.role !== "manager" || store.id === persona.storeId));
  const coaches = coachChoices(data, persona.tenantId, storeId, response?.source === data ? response.value.rows : []).filter(coach => !isCoach || coach.id === persona.coachId);
  const query = new URLSearchParams({ dateFrom: range.dateFrom, dateTo: range.dateTo });
  if (storeId !== "all") query.set("storeId", storeId); if (coachId !== "all") query.set("coachId", coachId);
  const queryString = query.toString(), requestKey = `${queryString}:${retry}`;
  const validRange = !!range.dateFrom && !!range.dateTo && range.dateFrom <= range.dateTo;
  const report = response?.key === requestKey && response.source === data ? response.value : null;
  const error = !validRange ? "请选择有效的授课日期范围，结束日期不能早于开始日期。" : loadError?.key === requestKey && loadError.source === data ? loadError.message : "";
  const loading = validRange && !report && !error;
  useEffect(() => {
    if (!validRange || !["hq", "manager", "coach"].includes(persona.role)) return;
    const controller = new AbortController();
    requestJSON<CoachBillingReport>(`/api/coach-report?${queryString}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setResponse({ key: requestKey, source: data, value }); }).catch(issue => { if (!controller.signal.aborted) setLoadError({ key: requestKey, source: data, message: issue instanceof Error ? issue.message : "授课报表暂时无法读取，请重试。" }); });
    return () => controller.abort();
  }, [requestKey, queryString, data, validRange, persona.role]);
  const bills = (data.coachBills || []).filter(bill => bill.tenantId === persona.tenantId && (!isCoach || bill.coachId === persona.coachId) && (storeId === "all" || bill.storeId === storeId) && (coachId === "all" || bill.coachId === coachId) && bill.dateFrom <= range.dateTo && bill.dateTo >= range.dateFrom).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const unpaid = bills.filter(bill => bill.status === "unpaid"), paid = bills.filter(bill => bill.status === "paid"), selectedBill = (data.coachBills || []).find(bill => bill.id === billId);
  const groups = new Map<string, CoachBillingRow[]>(); for (const row of report?.rows || []) groups.set(row.coachId, [...(groups.get(row.coachId) || []), row]);
  function quickMonth(previous = false) { const current = coachBillingMonthRange(); setRange(previous ? coachBillingMonthRange(new Date(Date.parse(`${current.dateFrom}T12:00:00+08:00`) - 86400000)) : current); setExpanded(null); }
  if (!canManage && !isCoach) return <Empty title="此页面仅向教学与结算人员开放">请切换到具有授权的工作空间。</Empty>;
  return <div className="cb-root"><div className="cb-heading"><div><p className="cb-eyebrow">COACHING & SETTLEMENT</p><h1>{isCoach ? "我的授课与课酬账单" : "每一次教学，都有清楚的账"}</h1><p>按真实完成教学核对课次、消课价值与约定课酬。</p></div><div className="cb-actions"><button type="button" className="cb-button" disabled={!report?.rows.length || loading} onClick={() => { if (report) { exportRows(report.rows, `教练授课报表_${range.dateFrom}_${range.dateTo}.csv`); notify?.("报表已导出，估算与缺失金额已在明细中标明。", "info"); } }}><ArrowDownToLine size={14}/>导出授课明细</button>{canManage && <button type="button" className="cb-button primary" disabled={busy || !validRange} onClick={() => setCreateOpen(true)}><Plus size={14}/>生成结算账单</button>}</div></div>
    <div className="cb-filters"><div className="cb-filter range"><label>授课日期范围 · 北京时间</label><div className="cb-range"><ExperienceDatePicker aria-label="报表授课开始日期" required value={range.dateFrom} onValueChange={value => setRange(current => ({ ...current, dateFrom: value }))}/><span>至</span><ExperienceDatePicker aria-label="报表授课结束日期" required value={range.dateTo} onValueChange={value => setRange(current => ({ ...current, dateTo: value }))}/></div></div>{!solo && persona.role === "hq" && <div className="cb-filter"><label>门店</label><ExperienceSelect aria-label="报表门店筛选" value={storeFilter} onValueChange={value => { setStore(value); setCoach("all"); setExpanded(null); }} options={[{ value: "all", label: "全部门店" }, ...stores.map(store => ({ value: store.id, label: store.name }))]}/></div>}{!isCoach && <div className="cb-filter"><label>教练</label><ExperienceSelect aria-label="报表教练筛选" value={coachFilter} onValueChange={value => { setCoach(value); setExpanded(null); }} options={[{ value: "all", label: "全部教练" }, ...coaches.map(coach => ({ value: coach.id, label: coach.name }))]}/></div>}<div className="cb-shortcuts"><button type="button" onClick={() => quickMonth()}>本月</button><button type="button" onClick={() => quickMonth(true)}>上月</button><button type="button" aria-label="刷新教练报表" onClick={() => setRetry(value => value + 1)}><RefreshCw size={13}/></button></div></div>
    <div className="cb-stats"><div className="cb-stat"><div>已授课次<CalendarDays size={17}/></div><strong>{report ? report.totals.sessionCount : "—"}<small>节</small></strong><p>同一课程多位完成学员，只计一节</p></div><div className="cb-stat"><div>完成教学人次<Users size={17}/></div><strong>{report ? report.totals.completedCount : "—"}<small>人次</small></strong><p>{report ? `${report.totals.credits} 个已完成课时` : "仅统计已完成教学的预约"}</p></div><div className="cb-stat"><div>{report?.totals.missingAmountCount ? "已知消课价值" : "消课价值"}<FileText size={17}/></div><strong>{report ? report.totals.completedCount > 0 && report.totals.missingAmountCount === report.totals.completedCount ? "待核实" : money(report.totals.consumedAmountCents) : "—"}</strong><p>{report?.totals.missingAmountCount ? `另有 ${report.totals.missingAmountCount} 条金额待核对` : "课包消耗价值，不能直接作为工资"}</p></div><div className="cb-stat accent"><div>已生成账单待结课酬<Wallet size={17}/></div><strong>{bills.length ? money(unpaid.reduce((sum, bill) => sum + bill.amountCents, 0)) : report?.rows.length ? "待核定" : "暂无账单"}</strong><p>符合筛选的整单 · 已结 {money(paid.reduce((sum, bill) => sum + bill.amountCents, 0))}</p></div></div>
    <div className="cb-notice"><Info size={16}/><span>消课价值与教练课酬分开核对。尚未生成账单的教学记录，需要先按实际约定选择固定课酬或提成规则，才能确定应付金额。</span></div>
    {report && (report.totals.estimatedCount > 0 || report.totals.missingAmountCount > 0 || report.totals.ledgerCompletionCount > 0 || report.totals.excludedCompletionCount > 0) && <div className="cb-notice cb-warning"><Info size={16}/><span>{report.totals.estimatedCount > 0 && `${report.totals.estimatedCount} 条记录按课包课时价值估算，非原始消课流水金额。`}{report.totals.missingAmountCount > 0 && `${report.totals.missingAmountCount} 条原始金额缺失，未按零元处理，提成不能使用这些记录。`}{report.totals.ledgerCompletionCount > 0 && `${report.totals.ledgerCompletionCount} 条历史履约时间由消课流水核验。`}{report.totals.excludedCompletionCount > 0 && `${report.totals.excludedCompletionCount} 条缺少可靠完成依据的历史记录已排除。`}</span></div>}
    {report && <Notes notes={report.notes}/>}<div className="cb-tabs"><button type="button" className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}><CalendarDays size={14}/>授课报表</button><button type="button" className={tab === "bills" ? "active" : ""} onClick={() => setTab("bills")}><ClipboardList size={14}/>结算账单</button></div>
    {tab === "report" ? <section className="cb-panel"><div className="cb-panel-heading"><div><h2>教练授课汇总</h2><p>按上海授课日期统计，仅纳入已完成教学；点击教练展开全部明细。</p></div><span className="cb-pill">{groups.size} 位教练</span></div>{error ? <div style={{ padding: 20 }}><p className="cb-error" role="alert">{error}</p><button type="button" className="cb-button" onClick={() => setRetry(value => value + 1)}>重新读取</button></div> : loading ? <Empty title="正在核对真实授课记录">报表由服务端根据完整履约和消课流水计算。</Empty> : groups.size ? <div className="cb-table-scroll"><table className="cb-table"><thead><tr><th>教练</th><th>已授课</th><th>完成人次</th><th>消课价值</th><th>结算情况</th><th>明细</th></tr></thead><tbody>{[...groups].map(([id, rows]) => { const related = bills.filter(bill => bill.coachId === id), pending = related.filter(bill => bill.status === "unpaid"), unbilled = rows.filter(row => !row.existingBillId).length, missing = rows.filter(row => row.consumedAmountCents === null).length; return <Fragment key={id}><tr><td><button type="button" className="cb-coach-name" onClick={() => setExpanded(expanded === id ? null : id)} aria-expanded={expanded === id}><span className="cb-avatar">{rows[0].coachName.slice(-1)}</span><strong>{rows[0].coachName}</strong></button></td><td>{new Set(rows.map(row => row.classId)).size} 节</td><td>{rows.length} 人次</td><td>{missing === rows.length ? "待核实" : money(rows.reduce((sum, row) => sum + (row.consumedAmountCents ?? 0), 0))}{missing > 0 && <small className="cb-cell-sub cb-value-warning">仅已知金额，另 {missing} 条待核对</small>}</td><td>{!related.length ? <span className="cb-pill">未生成账单 · 待核定</span> : <><strong>{money(pending.reduce((sum, bill) => sum + bill.amountCents, 0))}</strong><small className="cb-cell-sub">相关整单待结 · {related.length} 张账单</small>{unbilled > 0 && <small className="cb-cell-sub">另 {unbilled} 人次未入账，课酬待核定</small>}</>}</td><td><button type="button" className="cb-text-button" onClick={() => setExpanded(expanded === id ? null : id)}>{expanded === id ? "收起" : "查看明细"}{expanded === id ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}</button></td></tr>{expanded === id && <tr className="cb-detail-row"><td colSpan={6}><DetailTable rows={rows}/></td></tr>}</Fragment>; })}</tbody></table></div> : <Empty title="所选日期还没有完成教学记录">完成签到与实际教学后，再确认消课。仅排课、预约或签到不会计入授课账单。</Empty>}</section> : <section className="cb-panel"><div className="cb-panel-heading"><div><h2>{isCoach ? "我的结算账单" : "课酬结算账单"}</h2><p>按授课周期相交检索，金额为整单金额；已生成账单保留原始快照。</p></div><span className="cb-pill">{bills.length} 张账单</span></div>{bills.length ? <div className="cb-table-scroll"><table className="cb-table"><thead><tr><th>教练 / 门店</th><th>授课周期</th><th>课酬规则</th><th>整单应付课酬</th><th>状态</th><th>操作</th></tr></thead><tbody>{bills.map(bill => <tr key={bill.id}><td><strong>{bill.coachName}</strong><small className="cb-cell-sub">{bill.storeName || "独立训练空间"}</small></td><td>{bill.dateFrom}<small className="cb-cell-sub">至 {bill.dateTo}</small></td><td>{ruleLabel(bill.rule)}<small className="cb-cell-sub">{bill.sessions.length} 节 · {bill.details.length} 完成人次</small></td><td><strong>{money(bill.amountCents)}</strong></td><td><span className={`cb-pill ${bill.status}`}>{bill.status === "paid" ? "已结算" : "待结算"}</span></td><td><button type="button" className="cb-text-button" onClick={() => setBillId(bill.id)}>查看账单<ChevronRight size={12}/></button></td></tr>)}</tbody></table></div> : <Empty title="暂无符合日期与教练筛选的账单">{canManage ? "先核对授课明细，按实际课酬约定预览并生成账单，再登记已在线下完成的结算。" : "管理员核对授课记录并生成账单后，可在这里查看课酬与结算进度。"}</Empty>}</section>}
    <p className="cb-export-note">导出采用 UTF-8 CSV，包含估算 / 缺失金额说明；姓名、课程名等文本已进行电子表格公式防护。</p>
    {createOpen && canManage && <CreateBill data={data} persona={persona} busy={busy} act={act} initialFrom={range.dateFrom} initialTo={range.dateTo} initialCoach={coachId} initialStore={storeId} reportRows={report?.rows || []} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); setTab("bills"); }}/>} {selectedBill && <BillDetail key={selectedBill.id} bill={selectedBill} canManage={canManage} busy={busy} act={act} onClose={() => setBillId(null)}/>}
  </div>;
}
