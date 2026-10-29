"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, CalendarDays, Check, CheckCircle2, Clock3, Info, MapPin, Repeat2, ShieldCheck, Sparkles, User } from "lucide-react";
import type { ActionName, Persona, WorkspaceData } from "@/lib/types";
import { schedulingOptions } from "@/lib/scheduling";
import { requestJSON } from "./AuthGate";
import { ExperienceSelect } from "./ExperienceSelect";
import { ExperienceMultiSelect } from "./ExperienceMultiSelect";
import { ExperienceDatePicker } from "./ExperienceDatePicker";
import { ExperienceTimePicker } from "./ExperienceTimePicker";
import "./schedule-editor.css";

export type ScheduleMode = "recurring" | "availability";
export interface ScheduleDraft {
  mode: ScheduleMode; repeat: boolean; name: string; type: string; coachIds: string[]; coachId?: string; sharedRoom: boolean;
  startDate: string; endDate: string; weekdays: number[]; startTime: string; endTime: string;
  durationMinutes: number; gapMinutes: number; capacity: string; credits: string; price: string; room: string; venueId?: string;
  venueAdjustmentNotice?: string;
}
interface Preview {
  mode: ScheduleMode; occurrenceCount: number; slotCount: number; coachCount?: number; timeSlotCount?: number;
  items: { date: string; startAt: string; endAt: string; coachId?: string; coachName?: string; room?: string }[];
  conflicts: { date: string; startAt: string; endAt: string; reason: string; coachId?: string; coachName?: string; room?: string }[];
}
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const addDays = (date: string, count: number) => { const d = new Date(`${date}T12:00:00+08:00`); d.setUTCDate(d.getUTCDate() + count); return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); };
const weekday = (date: string) => new Date(`${date}T12:00:00+08:00`).getUTCDay() || 7;
const time = (date: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(date));
const dayTitle = (date: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", weekday: "short" }).format(new Date(`${date}T12:00:00+08:00`));
const normalizedRoom = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
function datesFor(draft: ScheduleDraft) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate) || !Number.isFinite(Date.parse(draft.startDate))) return [];
  if (draft.mode === "availability" && !draft.repeat) return [draft.startDate];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.endDate) || draft.endDate < draft.startDate) return [];
  const result: string[] = [];
  for (let day = draft.startDate, i = 0; day <= draft.endDate && i < 90; day = addDays(day, 1), i++) if (draft.weekdays.includes(weekday(day))) result.push(day);
  return result;
}
export function createScheduleDraft(date: string, mode: ScheduleMode = "recurring", type = "", coachId = ""): ScheduleDraft {
  const startDate = date <= localDate() ? addDays(localDate(), 1) : date;
  return { mode, repeat: mode === "recurring", name: "", type, coachIds: coachId ? [coachId] : [], sharedRoom: false, startDate, endDate: addDays(startDate, 27), weekdays: [weekday(startDate)], startTime: mode === "availability" ? "09:00" : "18:00", endTime: mode === "availability" ? "18:00" : "19:00", durationMinutes: 60, gapMinutes: 0, capacity: "8", credits: "1", price: "128", room: "" };
}
interface Props {
  data: WorkspaceData; persona: Persona; draft: ScheduleDraft; onChange: (value: ScheduleDraft) => void;
  busy: boolean; act: (action: ActionName, payload: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void; onPublished: (date: string) => void; onReview: () => void; onManageVenues?: () => void;
}
export function ScheduleEditor({ data, persona, draft, onChange, busy, act, onClose, onPublished, onReview, onManageVenues }: Props) {
  const solo = (persona.workspaceMode || data.tenants.find(tenant => tenant.id === persona.tenantId)?.mode) === "solo";
  const ownOnly = solo || persona.role === "coach";
  const candidates = ownOnly ? data.coaches.filter(coach => coach.id === persona.coachId || (solo && !persona.coachId && coach.selfManaged)) : data.coaches;
  const dates = datesFor(draft);
  const selectionDate = dates[dates.length - 1] || draft.startDate;
  const owner = candidates.find(coach => coach.id === persona.coachId) || (solo ? candidates.find(coach => coach.selfManaged) : undefined);
  const selection = schedulingOptions(candidates, { tenantId: persona.tenantId, storeId: solo ? "" : persona.storeId, type: draft.type, date: selectionDate, ...(solo ? { soloCoachId: owner?.id } : {}) });
  const type = selection.effectiveType;
  const requestedCoachIds = draft.coachIds || (draft.coachId ? [draft.coachId] : []);
  const activeVenues = (data.venues || []).filter(venue => venue.tenantId === persona.tenantId && venue.storeId === (solo ? "" : persona.storeId) && venue.status === "active");
  const venue = activeVenues.find(item => item.id === draft.venueId) || (!draft.venueId ? activeVenues.find(item => normalizedRoom(item.name) === normalizedRoom(draft.room)) : undefined);
  const allowMultiple = !ownOnly && venue?.allowShared === true && draft.sharedRoom === true;
  const canManageVenues = persona.role === "hq" || persona.role === "manager";
  const coachIds = ownOnly ? (owner ? [owner.id] : []) : allowMultiple ? requestedCoachIds : requestedCoachIds.slice(0, 1);
  const selectedCoaches = selection.coaches.filter(item => coachIds.includes(item.coach.id));
  const store = data.stores.find(item => item.id === persona.storeId);
  const validTimes = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.startTime) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.endTime);
  const minutes = (value: string) => { const [h, m] = value.split(":").map(Number); return h * 60 + m; };
  const windowMinutes = validTimes ? minutes(draft.endTime) - minutes(draft.startTime) : 0;
  const timeRangeError = !validTimes ? "请选择有效的开始和结束时间。" : windowMinutes <= 0 ? "结束时间须晚于开始时间；跨日安排请分开设置。" : draft.mode === "recurring" && windowMinutes > 480 ? "单节循环课程最长为 8 小时，请调整起止时间。" : draft.mode === "availability" && windowMinutes < draft.durationMinutes ? "空闲区间不足以容纳一次完整训练，请调整区间或单次时长。" : "";
  const qualificationReady = !!type && coachIds.length > 0 && coachIds.every(id => selection.available.some(coach => coach.id === id)) && (solo || store?.status === "active");
  const coachCountReady = coachIds.length <= (allowMultiple ? 20 : 1);
  const canPreview = qualificationReady && coachCountReady && !!venue && !timeRangeError;
  const payload = { mode: draft.mode, name: draft.name.trim(), type, storeId: solo ? "" : persona.storeId, coachIds, sharedRoom: allowMultiple, startDate: draft.startDate, endDate: draft.mode === "availability" && !draft.repeat ? draft.startDate : draft.endDate, weekdays: draft.mode === "availability" && !draft.repeat ? [weekday(draft.startDate)] : [...draft.weekdays].sort((a, b) => a - b), startTime: draft.startTime, endTime: draft.endTime, capacity: draft.mode === "availability" ? 1 : Number(draft.capacity), durationMinutes: draft.mode === "availability" ? draft.durationMinutes : undefined, gapMinutes: draft.mode === "availability" ? draft.gapMinutes : undefined, credits: Number(draft.credits), price: Math.round(Number(draft.price) * 100), venueId: venue?.id || "", room: venue?.name || draft.room.trim() };
  const payloadKey = JSON.stringify({ payload, requestedCoachIds, sharingRequested: draft.sharedRoom, venueAllowsShared: venue?.allowShared });
  const [checking, setChecking] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [checked, setChecked] = useState<{ key: string; source: WorkspaceData; result: Preview } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [selectionNotice, setSelectionNotice] = useState("");
  const previewEpoch = useRef(0);
  const preview = checked?.key === payloadKey && checked.source === data ? checked.result : null;
  const patch = (value: Partial<ScheduleDraft>) => {
    const next = { ...draft, venueAdjustmentNotice: undefined, ...value };
    if (ownOnly || !next.sharedRoom) next.coachIds = (value.coachIds || coachIds).slice(0, 1);
    previewEpoch.current += 1; setChecked(null); setError(null);
    onChange(next);
  };
  const retainedName = (id: string) => data.coaches.find(coach => coach.id === id)?.name || "第一位教练";
  const requiresNormalization = !allowMultiple && (draft.sharedRoom === true || requestedCoachIds.length > 1);
  const venueAvailable = !!venue, venueAllowsShared = venue?.allowShared === true, ownerId = owner?.id;
  useEffect(() => {
    if (!requiresNormalization || busy || publishing) return;
    const requested = draft.coachIds || (draft.coachId ? [draft.coachId] : []);
    const kept = ownOnly ? ownerId ? [ownerId] : [] : requested.slice(0, 1);
    const name = data.coaches.find(coach => coach.id === kept[0])?.name || "第一位教练";
    const reason = ownOnly ? "当前身份仅能安排本人授课" : !venueAvailable ? "原场地不可用" : !venueAllowsShared ? "场地已改为独立使用" : "当前未开启同时授课";
    previewEpoch.current += 1;
    onChange({ ...draft, sharedRoom: false, coachIds: kept, coachId: undefined, venueAdjustmentNotice: `${reason}，已关闭同时授课${kept.length ? `并保留${name}` : ""}。其余教练已移除，请确认后重新预览。` });
  }, [requiresNormalization, busy, publishing, draft, ownOnly, ownerId, venueAvailable, venueAllowsShared, data.coaches, onChange]);
  function setSharing(enabled: boolean) {
    if (enabled && !venue?.allowShared) return;
    setSelectionNotice(!enabled && coachIds.length > 1 ? `已保留${retainedName(coachIds[0])}，其余教练已移除。请确认授课教练后重新预览。` : "");
    patch({ sharedRoom: enabled, coachIds: enabled ? coachIds : coachIds.slice(0, 1), coachId: undefined });
  }
  function setVenue(venueId: string) {
    if (venueId === venue?.id) return;
    const nextVenue = activeVenues.find(item => item.id === venueId);
    if (allowMultiple || requestedCoachIds.length > 1) setSelectionNotice(coachIds.length > 1 ? `场地已变更，已切回单教练并保留${retainedName(coachIds[0])}。如需多教练同时授课，请重新勾选。` : "场地已变更，已撤销同时授课确认；如需多选教练，请重新勾选。");
    patch({ venueId, room: nextVenue?.name || "", sharedRoom: false, coachIds: coachIds.slice(0, 1), coachId: undefined });
  }
  const setMode = (mode: ScheduleMode) => patch({ mode, repeat: mode === "recurring", startTime: mode === "availability" ? "09:00" : "18:00", endTime: mode === "availability" ? "18:00" : "19:00" });
  const dailySlots = draft.mode === "availability" ? Math.max(0, Math.floor((windowMinutes + draft.gapMinutes) / (draft.durationMinutes + draft.gapMinutes))) : 1;

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || checking || !canPreview) return;
    if (!dates.length) { setError({ key: payloadKey, message: "请选择有效日期范围，并至少选择一个上课日。" }); return; }
    const epoch = ++previewEpoch.current;
    setChecking(true); setError(null); setChecked(null);
    try {
      const result = await requestJSON<Preview>("/api/schedules/preview", { method: "POST", body: JSON.stringify({ payload }) });
      if (!result || !Array.isArray(result.items) || !Array.isArray(result.conflicts) || !Number.isInteger(result.slotCount)) throw new Error("服务端没有返回完整的时间预览，请重新检查。");
      if (epoch === previewEpoch.current) setChecked({ key: payloadKey, source: data, result });
    } catch (issue) { if (epoch === previewEpoch.current) setError({ key: payloadKey, message: issue instanceof Error ? issue.message : "预览暂时未完成，请重试。" }); }
    finally { setChecking(false); }
  }
  async function publish() {
    if (!canPreview || !preview || preview.conflicts.length || !preview.slotCount || busy || publishing) return;
    setPublishing(true); setError(null);
    try {
      if (await act("schedule.publish", payload)) onPublished(preview.items[0]?.date || draft.startDate);
      else { setChecked(null); setError({ key: payloadKey, message: "计划未发布，请根据页面提示调整后重新预览。" }); }
    } finally { setPublishing(false); }
  }

  return <form className="sp-editor" onSubmit={check} aria-busy={checking || publishing}>
    <fieldset className="sp-fields" disabled={busy || publishing} aria-label="排课设置">
    <div className="sp-context"><span><MapPin size={14}/>{solo ? "我的独立训练空间" : store?.name || "当前门店"}</span><span>按北京时间安排</span></div>
    <div className="sp-modes" role="group" aria-label="排课方式">
      <button type="button" className={`sp-mode ${draft.mode === "recurring" ? "selected" : ""}`} aria-pressed={draft.mode === "recurring"} onClick={() => setMode("recurring")}><span className="sp-mode-icon"><Repeat2 size={21}/></span><span><strong>固定循环课</strong><small>每周固定时间，规律开课</small></span><span className="sp-mode-check">{draft.mode === "recurring" && <Check size={13}/>}</span></button>
      <button type="button" className={`sp-mode ${draft.mode === "availability" ? "selected" : ""}`} aria-pressed={draft.mode === "availability"} onClick={() => setMode("availability")}><span className="sp-mode-icon"><Clock3 size={21}/></span><span><strong>开放可约时段</strong><small>设定空闲区间，让学员选时预约</small></span><span className="sp-mode-check">{draft.mode === "availability" && <Check size={13}/>}</span></button>
    </div>

    {!qualificationReady && <div className="sp-guidance" role="status"><ShieldCheck size={19}/><div><strong>{!solo && store?.status !== "active" ? "当前门店暂不可排课" : !coachIds.length ? "选择参加这次安排的教练" : "所选教练的资质需完善"}</strong><p>{ownOnly ? "资质需审核通过，并覆盖计划中最后一次授课日期。机构教练可联系门店管理员核对。" : !coachIds.length ? "在下方选择授课教练；需要多选时，先开启场地同时授课。" : "每位所选教练都需审核通过，且资质覆盖计划中最后一次授课日期。"}</p>{!ownOnly && store?.status === "active" && !selection.available.length && <button type="button" onClick={onReview}>前往教练团队<ArrowRight size={13}/></button>}</div></div>}

    <section className="sp-section"><div className="sp-section-title"><span>01</span><h3>{draft.mode === "availability" ? "预约服务" : "课程与教练"}</h3></div><div className="exp-form">
      <label className="exp-field full">{draft.mode === "availability" ? "服务名称" : "课程名称"}<input name="name" required maxLength={60} value={draft.name} onChange={event => patch({ name: event.target.value })} placeholder={draft.mode === "availability" ? "例如：60 分钟私人训练" : "例如：每周力量小班"}/></label>
      {solo ? <label className="exp-field">课程科目<input name="type" required maxLength={40} value={draft.type} onChange={event => patch({ type: event.target.value })} placeholder="例如：力量训练"/></label> : <div className="exp-field"><label htmlFor="sp-course-type">课程科目</label><ExperienceSelect id="sp-course-type" aria-label="课程科目" value={type} onValueChange={value => { setSelectionNotice(""); patch({ type: value, coachIds: [], coachId: undefined, sharedRoom: false }); }} options={selection.courseTypes.map(value => ({ value, label: value }))} disabled={!selection.courseTypes.length} placeholder="暂无已登记科目"/><small className="exp-field-hint">来自当前门店教练的擅长科目</small></div>}
      <div className="exp-field"><label htmlFor="sp-venue">{solo ? "上课地点" : "教室 / 场地"}</label><ExperienceSelect id="sp-venue" name="venueId" aria-label={solo ? "上课地点" : "教室 / 场地"} required value={venue?.id || ""} onValueChange={setVenue} placeholder={draft.venueId ? "原场地不可用，请重新选择" : "请选择已启用的场地"} emptyMessage={canManageVenues ? "暂无已启用场地，请先前往场地管理添加。" : "暂无已启用场地，请联系管理员添加。"} options={activeVenues.map(item => ({ value: item.id, label: item.name, description: `${item.location || ""}${item.location ? " · " : ""}${item.allowShared ? "支持同计划多教练共享" : "单教练独立使用"}` }))}/><small className="exp-field-hint">课程发布即占用场地，无需等待学员预约</small></div>
      {!ownOnly && <label className="sp-shared-room sp-sharing-mode"><input type="checkbox" checked={allowMultiple} disabled={!venue?.allowShared} onChange={event => setSharing(event.target.checked)}/><span><strong>此训练区域允许多教练同时授课</strong><small>{!venue ? "请先选择场地，再确认是否允许同时授课。" : !venue.allowShared ? "该场地设为独立使用；请由管理员在场地管理中开启共享后再选择多位教练。" : allowMultiple ? "已开启：可多选教练，每位教练独立开放名额。" : "未开启：本次仅安排 1 位教练，可在下方选择或更换。"}</small></span></label>}
      {(!activeVenues.length || canManageVenues && onManageVenues) && <div className="exp-field full"><div className="sp-selection-notice" role="status"><MapPin size={14}/><span>{!activeVenues.length ? canManageVenues ? "先添加真实场地，再继续安排。跳转后会保留这份排课草稿。" : "当前暂无可用场地，请联系管理员添加或启用。" : "需要新增场地或调整共享规则？草稿会为你保留。"}</span>{canManageVenues && onManageVenues && <button type="button" className="exp-button exp-small" disabled={busy || publishing} onClick={onManageVenues}>管理教室 / 场地<ArrowRight size={12}/></button>}</div></div>}
      {ownOnly ? <div className="exp-field full"><label>授课教练</label><div className="sp-own-coach"><User size={15}/><span>{owner?.name || persona.name}</span><small>本人授课</small></div></div> : <div className="exp-field full"><label htmlFor="sp-course-coach">授课教练</label>{allowMultiple ? <ExperienceMultiSelect id="sp-course-coach" aria-label="授课教练" values={coachIds} onValuesChange={values => { setSelectionNotice(""); patch({ coachIds: values, coachId: undefined }); }} maxValues={20} placeholder="选择一位或多位教练" menuLabel="选择参与排课的教练" options={selection.coaches.map(({ coach, disabled, reason }) => ({ value: coach.id, label: coach.name, disabled, description: disabled ? reason : `资质有效至 ${coach.certificateExpiresAt}` }))} disabled={!selection.coaches.length}/> : <ExperienceSelect id="sp-course-coach" aria-label="授课教练" value={coachIds[0] || ""} onValueChange={value => { setSelectionNotice(""); patch({ coachIds: [value], coachId: undefined }); }} required placeholder="请选择 1 位教练" menuLabel="选择一位授课教练" emptyMessage="暂无该科目的教练，请先完善教练档案。" options={selection.coaches.map(({ coach, disabled, reason }) => ({ value: coach.id, label: coach.name, disabled, description: disabled ? reason : `资质有效至 ${coach.certificateExpiresAt}` }))} disabled={!selection.coaches.length}/>}<small className="exp-field-hint">{allowMultiple ? "每次最多选择 20 位；每位教练独立开课和计算名额" : "当前为单教练安排；只有勾选上方同时授课后才能多选"}</small></div>}
      {(selectionNotice || draft.venueAdjustmentNotice || !ownOnly && !allowMultiple && requestedCoachIds.length > 1) && <p className="sp-selection-notice" role="status"><Info size={14}/><span>{selectionNotice || draft.venueAdjustmentNotice || `当前未开启同时授课，已保留${retainedName(coachIds[0])}，其余教练已移除。请确认后重新预览。`}</span></p>}
    </div>{!coachCountReady && <p className="sp-coach-warning" role="status">每次最多安排 20 位教练，请移除多余教练后重新预览。</p>}{selectedCoaches.some(item => item.disabled) && <p className="sp-coach-warning" role="status">{selectedCoaches.filter(item => item.disabled).map(item => `${item.coach.name}：${item.reason}`).join("；")}。请调整日期或移除该教练后重新预览。</p>}</section>

    <section className="sp-section"><div className="sp-section-title"><span>02</span><h3>{draft.mode === "availability" ? "什么时候可以约" : "每周上课规则"}</h3></div>
      {draft.mode === "availability" && <div className="sp-repeat-choice" role="group" aria-label="开放频率"><button type="button" aria-pressed={!draft.repeat} className={!draft.repeat ? "selected" : ""} onClick={() => patch({ repeat: false })}>仅这一天</button><button type="button" aria-pressed={draft.repeat} className={draft.repeat ? "selected" : ""} onClick={() => patch({ repeat: true })}>每周重复</button></div>}
      <div className="exp-form"><label className={`exp-field ${draft.mode === "availability" && !draft.repeat ? "full" : ""}`}>{draft.mode === "availability" && !draft.repeat ? "开放日期" : "开始日期"}<ExperienceDatePicker name="startDate" aria-label={draft.mode === "availability" && !draft.repeat ? "开放日期" : "开始日期"} min={localDate()} required value={draft.startDate} onValueChange={value => patch({ startDate: value, ...(value && draft.endDate < value ? { endDate: addDays(value, 27) } : {}) })}/></label>{(draft.mode === "recurring" || draft.repeat) && <label className="exp-field">重复至<ExperienceDatePicker name="endDate" aria-label="重复至" min={draft.startDate} max={draft.startDate ? addDays(draft.startDate, 89) : undefined} required value={draft.endDate} onValueChange={value => patch({ endDate: value })}/></label>}
      {(draft.mode === "recurring" || draft.repeat) && <div className="exp-field full"><span>每周哪几天</span><div className="sp-weekdays" role="group" aria-label="每周上课日">{weekdays.map((label, index) => <button type="button" key={label} aria-pressed={draft.weekdays.includes(index + 1)} className={draft.weekdays.includes(index + 1) ? "selected" : ""} onClick={() => patch({ weekdays: draft.weekdays.includes(index + 1) ? draft.weekdays.filter(value => value !== index + 1) : [...draft.weekdays, index + 1] })}>{label}</button>)}</div></div>}
      <label className="exp-field">{draft.mode === "availability" ? "空闲区间开始" : "上课时间"}<ExperienceTimePicker name="startTime" aria-label={draft.mode === "availability" ? "空闲区间开始" : "上课时间"} required value={draft.startTime} onValueChange={value => patch({ startTime: value })} disabled={busy || publishing}/></label><label className="exp-field">{draft.mode === "availability" ? "空闲区间结束" : "下课时间"}<ExperienceTimePicker name="endTime" aria-label={draft.mode === "availability" ? "空闲区间结束" : "下课时间"} required value={draft.endTime} onValueChange={value => patch({ endTime: value })} disabled={busy || publishing}/></label>
      {draft.mode === "availability" && <><div className="exp-field"><label htmlFor="sp-duration">单次训练时长</label><ExperienceSelect id="sp-duration" aria-label="单次训练时长" value={String(draft.durationMinutes)} onValueChange={value => patch({ durationMinutes: Number(value) })} options={[15, 30, 45, 60, 90, 120, 180].map(value => ({ value: String(value), label: `${value} 分钟` }))}/></div><div className="exp-field"><label htmlFor="sp-gap">同计划的时段间隔</label><ExperienceSelect id="sp-gap" aria-label="同计划的时段间隔" value={String(draft.gapMinutes)} onValueChange={value => patch({ gapMinutes: Number(value) })} options={[0, 5, 10, 15, 30, 60].map(value => ({ value: String(value), label: value ? `${value} 分钟` : "连续开放，无间隔" }))}/></div></>}
      </div>
      {timeRangeError && <p className="sp-coach-warning" role="status">{timeRangeError}</p>}
      <div className="sp-time-summary"><CalendarDays size={17}/><div><strong>{dates.length ? `${dates.length} 个开放日期` : "请选择至少一个上课日"}{dates.length && dailySlots > 0 ? ` · ${coachIds.length} 位教练 × ${dates.length * dailySlots} 个时间 = ${coachIds.length * dates.length * dailySlots} ${draft.mode === "availability" ? "个可约时段" : "节课程"}` : ""}</strong><p>{draft.mode === "availability" ? `每位教练每次 ${draft.durationMinutes} 分钟，一对一预约${draft.gapMinutes ? `，同一计划内相邻时段间隔 ${draft.gapMinutes} 分钟` : ""}。尾段不足完整时长时不开放。` : `${[...draft.weekdays].sort((a, b) => a - b).map(value => weekdays[value - 1]).join("、") || "未选星期"}，${draft.startTime}–${draft.endTime}；学员选定教练后独立预约。`}</p></div></div>
    </section>

    <section className="sp-section"><div className="sp-section-title"><span>03</span><h3>预约与上课安排</h3></div><div className="exp-form">
      {draft.mode === "recurring" ? <label className="exp-field">每位教练每节人数上限<input name="capacity" type="number" min={1} max={200} required value={draft.capacity} onChange={event => patch({ capacity: event.target.value })}/></label> : <div className="exp-field"><span>每位教练每个时段的名额</span><div className="sp-fixed-value"><User size={14}/>1 人 / 教练 · 一对一</div></div>}
      <label className="exp-field">每次抵扣课时<input name="credits" type="number" min={1} max={20} required value={draft.credits} onChange={event => patch({ credits: event.target.value })}/></label><label className="exp-field">单次展示价 / 元<input name="price" type="number" min={0} max={100000} step="0.01" required value={draft.price} onChange={event => patch({ price: event.target.value })}/></label>
    </div><p className="sp-booking-note"><Info size={13}/>学员预约时冻结课时，实际完成教学才扣课；符合取消规则时释放名额与冻结课时。</p></section>

    {error?.key === payloadKey && <p className="exp-error" role="alert">{error.message}</p>}
    {preview && <section className={`sp-preview ${preview.conflicts.length ? "has-conflicts" : ""}`} aria-label="排课预览"><div className="sp-preview-head">{preview.conflicts.length ? <Info size={20}/> : <CheckCircle2 size={20}/>}<div><strong>{preview.conflicts.length ? `发现 ${preview.conflicts.length} 处时间冲突` : `检查通过，${preview.coachCount || coachIds.length} 位教练、${preview.occurrenceCount} 天、共 ${preview.slotCount} 个${draft.mode === "availability" ? "可约时段" : "课次"}`}</strong><p>{preview.conflicts.length ? "请调整教练、时间或场地后重新预览，当前计划尚未发布。" : "确认教练与时间后发布，学员可自主选择教练并预约。"}</p></div></div><div className="sp-preview-items">{preview.conflicts.length ? preview.conflicts.map((item, index) => <div key={`${item.startAt}-${item.coachId}-${index}`}><span>{dayTitle(item.date)}</span><strong>{time(item.startAt)}–{time(item.endAt)}</strong><span className="sp-preview-coach">{item.coachName || data.coaches.find(coach=>coach.id===item.coachId)?.name || "授课教练"}</span><small>{item.reason}</small></div>) : preview.items.map((item, index) => <div key={`${item.startAt}-${item.coachId}-${index}`}><span>{dayTitle(item.date)}</span><strong>{time(item.startAt)}–{time(item.endAt)}</strong><span className="sp-preview-coach">{item.coachName || data.coaches.find(coach=>coach.id===item.coachId)?.name || selectedCoaches[0]?.coach.name || "授课教练"}</span><small>{draft.mode === "availability" ? "1 人可约" : `${draft.capacity} 个独立名额`}</small></div>)}</div></section>}
    {!preview && <p className="sp-preview-hint"><Sparkles size={14}/>先预览并检查时间，再正式发布。每次最多安排 90 天、256 个时段。</p>}
    <div className="sp-footer"><button type="button" className="exp-button" disabled={publishing || busy} onClick={onClose}>取消</button><button type="submit" className="exp-button" disabled={!canPreview || checking || publishing || busy}>{checking ? "正在检查…" : preview ? "重新检查" : "预览时间安排"}</button><button type="button" className="exp-button exp-primary" disabled={!canPreview || !preview || !!preview.conflicts.length || !preview.slotCount || busy || checking || publishing} onClick={() => void publish()}>{publishing || busy ? "正在发布…" : preview && !preview.conflicts.length ? `${draft.mode === "availability" ? "开放" : "发布"} ${preview.slotCount} ${draft.mode === "availability" ? "个时段" : "节课程"}` : draft.mode === "availability" ? "确认开放预约" : "确认发布循环课"}</button></div>
    </fieldset>
  </form>;
}
