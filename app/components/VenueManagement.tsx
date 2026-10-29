"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, CalendarDays, Check, Clock3, DoorOpen, Info, MapPin, Pencil, Plus, Power, Store, Users, X } from "lucide-react";
import type { ActionName, ClassSession, Persona, Venue, WorkspaceData } from "@/lib/types";
import { ExperienceDatePicker } from "./ExperienceDatePicker";
import { ExperienceSelect } from "./ExperienceSelect";
import "./venue-management.css";

interface Props {
  data: WorkspaceData;
  persona: Persona;
  busy: boolean;
  act: (action: ActionName, payload: Record<string, unknown>, onError?: (message: string) => void) => Promise<boolean>;
  initialStoreId?: string;
  onReturnToSchedule?: () => void;
}
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const clock = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
const dayLabel = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "long" }).format(new Date(`${value}T12:00:00+08:00`));
const normalizedRoom = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
function belongsToVenue(course: ClassSession, venue: Venue) { return course.tenantId === venue.tenantId && course.storeId === venue.storeId && (course.venueId ? course.venueId === venue.id : normalizedRoom(course.room) === normalizedRoom(venue.name)); }
function occupancy(courses: ClassSession[], venue: Venue, date: string) {
  const start = Date.parse(`${date}T00:00:00+08:00`), end = start + 86400000;
  const groups = new Map<string, { key: string; name: string; startAt: string; endAt: string; coachIds: string[]; sessions: number }>();
  for (const course of courses) {
    if (course.status !== "scheduled" || !belongsToVenue(course, venue) || Date.parse(course.startAt) >= end || Date.parse(course.endAt) <= start) continue;
    const key = `${course.schedulePlanId || course.id}:${course.startAt}:${course.endAt}`;
    const group = groups.get(key);
    if (group) { if (!group.coachIds.includes(course.coachId)) group.coachIds.push(course.coachId); group.sessions += 1; }
    else groups.set(key, { key, name: course.name, startAt: course.startAt, endAt: course.endAt, coachIds: [course.coachId], sessions: 1 });
  }
  return [...groups.values()].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
}

function VenueEditor({ data, persona, solo, venue, storeId, busy, act, onClose }: Props & { solo: boolean; venue?: Venue; storeId: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [shared, setShared] = useState(venue?.allowShared || false);
  const stores = data.stores.filter(store => store.tenantId === persona.tenantId && store.status === "active");
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setError("");
    const form = new FormData(event.currentTarget);
    const payload = { name: String(form.get("name") || "").trim(), location: String(form.get("location") || "").trim(), description: String(form.get("description") || "").trim(), allowShared: shared };
    let failure = "";
    const ok = await act(venue ? "venue.update" : "venue.create", venue ? { id: venue.id, ...payload } : { ...payload, storeId: solo ? "" : String(form.get("storeId") || storeId) }, message => { failure = message; });
    if (ok) onClose(); else setError(failure || "场地尚未保存，请根据页面提示检查信息后重试。");
  }
  return <dialog ref={ref} className="venue-editor-dialog" aria-labelledby="venue-editor-title" onCancel={event => { if (event.currentTarget.querySelector('[data-exp-select-popup], [data-exp-date-popup], [data-exp-time-popup]')) event.preventDefault(); else onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="venue-editor-head"><div><span>TEACHING SPACE</span><h2 id="venue-editor-title">{venue ? "编辑教室 / 场地" : "添加教室 / 场地"}</h2></div><button type="button" className="venue-icon-button" aria-label="关闭场地编辑" onClick={onClose}><X size={18}/></button></div>
    <form onSubmit={save}>
      <fieldset disabled={busy} className="venue-editor-fields">
        {!venue && !solo && persona.role === "hq" ? <label>归属门店<ExperienceSelect name="storeId" aria-label="场地归属门店" required defaultValue={storeId && storeId !== "all" ? storeId : stores[0]?.id || ""} placeholder="请选择门店" emptyMessage="暂无正常营业的门店，请先建立或启用门店。" options={stores.map(store => ({ value: store.id, label: store.name, description: store.address }))}/></label> : <div className="venue-editor-context"><MapPin size={14}/>{solo ? "我的独立训练空间" : data.stores.find(store => store.id === (venue?.storeId || storeId))?.name || "当前门店"}</div>}
        <label>场地名称<input name="name" required maxLength={60} defaultValue={venue?.name || ""} placeholder="例如：A 区训练室、户外训练区"/></label>
        <label>具体位置（选填）<input name="location" maxLength={160} defaultValue={venue?.location || ""} placeholder="例如：2 楼东侧、体育公园南门"/></label>
        <label>场地说明（选填）<textarea name="description" maxLength={500} defaultValue={venue?.description || ""} placeholder="可填写设备、到达方式或使用说明" rows={3}/></label>
        <label className="venue-sharing-choice"><input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)}/><span><strong>允许同一计划内多教练同时授课</strong><small>开启后，排课时仍需再次确认共享使用。不同排课计划之间仍检查场地冲突。</small></span></label>
        <p className="venue-editor-note"><Info size={14}/><span>改名不会改变已发布课程中的场地名称记录。有未来共享课程时，请先调整课程再关闭共享。</span></p>
        {error && <p className="venue-form-error" role="alert">{error}</p>}
      </fieldset>
      <div className="venue-editor-actions"><button type="button" className="venue-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="venue-button primary" disabled={busy}>{busy ? "正在保存…" : venue ? "保存场地" : "添加场地"}<Check size={13}/></button></div>
    </form>
  </dialog>;
}

export function VenueManagement({ data, persona, busy, act, initialStoreId, onReturnToSchedule }: Props) {
  const solo = (persona.workspaceMode || data.tenants.find(tenant => tenant.id === persona.tenantId)?.mode) === "solo";
  const canManage = persona.role === "hq" || persona.role === "manager";
  const [storeFilter, setStoreFilter] = useState(initialStoreId || "all"), [date, setDate] = useState(today);
  const [editor, setEditor] = useState<{ venue?: Venue } | null>(null), [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  const stores = data.stores.filter(store => store.tenantId === persona.tenantId);
  const canCreate = solo || stores.some(store => store.status === "active" && (persona.role === "hq" || store.id === persona.storeId));
  const effectiveStore = solo ? "" : persona.role === "manager" ? persona.storeId || "" : storeFilter;
  const allVenues = (data.venues || []).filter(venue => venue.tenantId === persona.tenantId && (solo ? venue.storeId === "" : persona.role !== "manager" || venue.storeId === persona.storeId));
  const venues = allVenues.filter(venue => effectiveStore === "all" || venue.storeId === effectiveStore);
  const dayStart = Date.parse(`${date}T00:00:00+08:00`);
  const occupiedCount = venues.filter(venue => occupancy(data.classes, venue, date).length).length;
  async function toggle(venue: Venue) {
    if (busy) return; setError("");
    if (await act("venue.update", { id: venue.id, status: venue.status === "active" ? "inactive" : "active" })) return;
    setError(venue.status === "active" ? "停用未保存。如有未来课程，请先取消或调整该场地上的安排后重试。" : "启用未保存，请根据页面提示重试。");
  }
  if (!canManage) return <section className="venue-empty"><DoorOpen size={32}/><h2>场地由管理员维护</h2><p>教练可在排课时选择已启用的场地。</p></section>;
  return <div className="venue-root">
    <div className="venue-page-heading"><div><p>TEACHING SPACES</p><h1>为每一节课，留好空间</h1><span>{solo ? "管理自己的真实训练地点，自由安排每一次教学。" : "统一维护教室与训练区域，让场地和课程有序衔接。"}</span></div><div className="venue-heading-actions">{onReturnToSchedule && <button type="button" className="venue-button" onClick={onReturnToSchedule}><ArrowLeft size={14}/>返回继续排课</button>}<button type="button" className="venue-button primary" disabled={busy || !canCreate} onClick={() => { setError(""); setEditor({}); }}><Plus size={15}/>添加场地</button></div></div>
    {onReturnToSchedule && <div className="venue-resume-note"><CalendarDays size={16}/><span>排课草稿已保留。完成场地设置后，可返回继续安排。</span></div>}
    <div className="venue-summary"><div><DoorOpen size={19}/><span>已启用场地<strong>{venues.filter(venue => venue.status === "active").length}<small>处</small></strong></span></div><div><CalendarDays size={19}/><span>当日有课场地<strong>{occupiedCount}<small>处</small></strong></span></div><p><Info size={16}/><span>课程发布即占用场地时间，无需等待学员预约。取消课程后，对应时间释放。</span></p></div>
    <div className="venue-toolbar"><div><h2>教室 / 场地</h2><span>{dayLabel(date)} · {venues.length} 处场地</span></div><div className="venue-filters">{!solo && persona.role === "hq" && <ExperienceSelect aria-label="筛选场地门店" value={storeFilter} onValueChange={setStoreFilter} icon={<Store size={14}/>} options={[{ value: "all", label: "全部门店" }, ...stores.map(store => ({ value: store.id, label: store.name }))]}/>}<ExperienceDatePicker aria-label="场地占用日期" value={date} onValueChange={value => setDate(value || today())} required/></div></div>
    {error && <p className="venue-form-error" role="alert">{error}</p>}
    {venues.length ? <div className="venue-grid">{venues.map(venue => {
      const periods = occupancy(data.classes, venue, date);
      const future = data.classes.filter(course => course.status === "scheduled" && belongsToVenue(course, venue) && Date.parse(course.endAt) > now).length;
      return <article className={`venue-card ${venue.status === "inactive" ? "inactive" : ""}`} key={venue.id}>
        <div className="venue-card-top"><span className="venue-card-icon"><DoorOpen size={23}/></span><div><span className="venue-store-name">{solo ? "我的训练空间" : stores.find(store => store.id === venue.storeId)?.name || "所属门店"}</span><h3>{venue.name}</h3></div><span className={`venue-status ${venue.status}`}>{venue.status === "active" ? "使用中" : "已停用"}</span></div>
        <p className="venue-location"><MapPin size={13}/><span>{venue.location || "未填写具体位置"}</span></p>
        {venue.description && <p className="venue-description">{venue.description}</p>}
        <div className="venue-sharing-tag"><Users size={12}/>{venue.allowShared ? "支持同计划多教练共享" : "单教练独立使用"}</div>
        <div className="venue-occupancy-heading"><span><Clock3 size={13}/>当日占用</span><strong>{periods.length} 段时间</strong></div>
        <div className="venue-timeline" aria-label={`${venue.name}当日占用时间轴`}><div className="venue-timeline-track">{periods.map(period => { const start = Math.max(dayStart, Date.parse(period.startAt)), end = Math.min(dayStart + 86400000, Date.parse(period.endAt)); return <span key={period.key} style={{ left: `${(start - dayStart) / 864000}%`, width: `${Math.max(.4, (end - start) / 864000)}%` }} title={`${clock(period.startAt)}–${clock(period.endAt)} ${period.name}`}/>; })}</div><div className="venue-timeline-hours"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div></div>
        {periods.length ? <div className="venue-periods">{periods.map(period => <div className="venue-period" key={period.key}><span>{clock(period.startAt)}<small>{clock(period.endAt)}</small></span><div><strong>{period.name}</strong><p>{period.coachIds.map(id => data.coaches.find(coach => coach.id === id)?.name || "授课教练").join("、")}{period.sessions > 1 && <b> · {period.sessions} 位教练共享</b>}</p></div></div>)}</div> : <div className="venue-day-empty"><CalendarDays size={19}/><span>当天暂无课程占用</span><small>可选择其他日期查看历史或未来安排</small></div>}
        <div className="venue-card-actions"><button type="button" className="venue-button" disabled={busy} onClick={() => { setError(""); setEditor({ venue }); }}><Pencil size={13}/>编辑场地</button><button type="button" className={`venue-button ${venue.status === "inactive" ? "restore" : "subtle"}`} disabled={busy || venue.status === "active" && future > 0} title={venue.status === "active" && future ? "请先取消或调整该场地上未结束的课程" : undefined} onClick={() => void toggle(venue)}><Power size={13}/>{venue.status === "active" ? "停用场地" : "启用场地"}</button></div>
        {venue.status === "active" && future > 0 && <p className="venue-future-note">仍有 {future} 节未结束的授课安排，请先调整课程后再停用。</p>}
      </article>;
    })}</div> : <section className="venue-empty"><span><DoorOpen size={30}/></span><h2>先为训练安排一个真实场地</h2><p>{!solo && !stores.length ? "先建立门店，再添加教室或训练区域。" : "添加教室、户外训练区或其他真实地点，排课时直接选择，并查看每天的占用情况。"}</p><button type="button" className="venue-button primary" disabled={busy || !canCreate} onClick={() => setEditor({})}><Plus size={14}/>添加第一个场地</button></section>}
    {editor && <VenueEditor key={editor.venue?.id || "new"} data={data} persona={persona} solo={solo} venue={editor.venue} storeId={effectiveStore} busy={busy} act={act} onClose={() => setEditor(null)}/>}
  </div>;
}
