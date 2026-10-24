"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, CalendarDays, Check, CheckCircle2, ChevronRight, Circle, CircleCheck, Clock3, CreditCard, Dumbbell, FileCheck2, Flame, Info, ListChecks, MapPin, Megaphone, Plus, Search, ShieldCheck, Sparkles, Ticket, User, UserCheck, UserPlus, Users, Waves, X } from "lucide-react";
import type { ActionName, Booking, Card, ClassSession, Coach, Persona, WorkspaceData } from "@/lib/types";
import "./experience.css";

export interface ExperienceProps {
  data: WorkspaceData;
  persona: Persona;
  act: (action: ActionName, payload: Record<string, unknown>) => Promise<boolean>;
  busy: boolean;
  notify: (message: string) => void;
}

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dayOf = (date: string) => date.length === 10 ? date : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(date));
const timeOf = (date: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(date));
const dateLabel = (date: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "long" }).format(new Date(`${dayOf(date)}T12:00:00+08:00`));
const shortDate = (date: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(new Date(`${dayOf(date)}T12:00:00+08:00`));
const offsetDay = (date: string, offset: number) => { const d = new Date(`${date}T12:00:00+08:00`); d.setUTCDate(d.getUTCDate() + offset); return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); };
const activeBooking = (booking: Booking) => booking.status !== "cancelled";
const statusText: Record<Booking["status"], string> = { reserved: "待上课", checked_in: "已签到", completed: "已完成", cancelled: "已取消" };
const statusTone: Record<Booking["status"], string> = { reserved: "", checked_in: "green", completed: "gray", cancelled: "gray" };

function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  return now;
}

function Badge({ children, tone = "" }: { children: ReactNode; tone?: string }) { return <span className={`exp-pill ${tone}`}>{children}</span>; }
function Empty({ title, children }: { title: string; children?: ReactNode }) { return <div className="exp-empty"><CalendarDays /><strong>{title}</strong><p>{children || "新的安排会出现在这里"}</p></div>; }
function Stat({ label, value, unit, note, icon }: { label: string; value: number; unit?: string; note: ReactNode; icon: ReactNode }) { return <div className="exp-stat">{icon}<p className="exp-stat-label">{label}</p><div className="exp-stat-number">{value}<small>{unit}</small></div><p className="exp-stat-foot">{note}</p></div>; }

function Modal({ title, children, footer, onClose, wide = false }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  const label = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const nodes = ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']");
        if (!nodes?.length) return;
        const first = nodes[0]; const last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keyHandler);
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", keyHandler); document.body.style.overflow = overflow; previous?.focus(); };
  }, [onClose]);
  return <div className="exp-modal-overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={label} className={`exp-modal ${wide ? "exp-wide" : ""}`}><div className="exp-modal-head"><h2 id={label}>{title}</h2><button className="exp-icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={19} /></button></div><div className="exp-modal-body">{children}</div>{footer && <div className="exp-modal-footer">{footer}</div>}</div></div>;
}

export function StoreExperience({ data, persona, act, busy, notify }: ExperienceProps) {
  const isCoach = persona.role === "coach";
  const now = useClock();
  const store = data.stores.find(item => item.id === persona.storeId);
  const [tab, setTab] = useState("overview");
  const activeTab = isCoach && tab === "coaches" ? "overview" : tab;
  const [date, setDate] = useState(today);
  const [query, setQuery] = useState("");
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [modal, setModal] = useState<"class" | "invite" | null>(null);
  const [review, setReview] = useState<{ coach: Coach; approved: boolean } | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [draftType, setDraftType] = useState("力量训练");
  const classes = data.classes.filter(item => item.storeId === persona.storeId && (!isCoach || item.coachId === persona.coachId));
  const dayClasses = classes.filter(item => dayOf(item.startAt) === date && item.status !== "cancelled").sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const classIds = new Set(classes.map(item => item.id));
  const bookings = data.bookings.filter(item => classIds.has(item.classId));
  const dayIds = new Set(dayClasses.map(item => item.id));
  const dayBookings = bookings.filter(item => dayIds.has(item.classId) && activeBooking(item));
  const coaches = data.coaches.filter(item => item.storeId === persona.storeId);
  const tasks = data.tasks.filter(item => item.storeId === persona.storeId);
  const pendingTasks = tasks.filter(item => item.status === "pending");
  const pendingCoaches = coaches.filter(item => item.status === "pending");
  const ownedMemberIds = new Set(bookings.filter(activeBooking).map(item => item.memberId));
  const members = data.members.filter(item => (isCoach ? ownedMemberIds.has(item.id) : item.storeId === persona.storeId || ownedMemberIds.has(item.id)) && `${item.name}${item.phone}`.includes(query));
  const currentClass = data.classes.find(item => item.id === selectedClassId);
  const canCheckin = !!currentClass && now >= Date.parse(currentClass.startAt) - 2 * 3600000 && now <= Date.parse(currentClass.endAt) + 2 * 3600000;
  const canComplete = !!currentClass && now >= Date.parse(currentClass.startAt);
  const currentBookings = bookings.filter(item => item.classId === selectedClassId && activeBooking(item));
  const approvedCoaches = coaches.filter(item => item.status === "approved" && !!item.certificate && item.certificateExpiresAt >= today());
  const courseTypes = [...new Set(approvedCoaches.flatMap(item => item.specialty.split(/[·、,，/]/).map(value => value.trim()).filter(Boolean)))];
  const effectiveDraftType = courseTypes.includes(draftType) ? draftType : courseTypes[0] || "";
  const qualifiedCoaches = approvedCoaches.filter(item => item.specialty.split(/[·、,，/]/).map(value => value.trim()).includes(effectiveDraftType));
  const closeModal = () => { setModal(null); setSubmitError(""); };

  async function createClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitError("");
    const form = new FormData(event.currentTarget);
    const startAt = `${form.get("date")}T${form.get("start")}+08:00`;
    const endAt = `${form.get("date")}T${form.get("end")}+08:00`;
    if (new Date(endAt) <= new Date(startAt)) { setSubmitError("结束时间需晚于开始时间，请检查课程时段。"); return; }
    const ok = await act("class.create", { name: form.get("name"), type: form.get("type"), storeId: persona.storeId, coachId: form.get("coachId"), startAt, endAt, capacity: Number(form.get("capacity")), credits: Number(form.get("credits")), price: Math.round(Number(form.get("price")) * 100), room: form.get("room") });
    if (ok) { closeModal(); setDate(String(form.get("date"))); setTab("schedule"); } else setSubmitError("排课未保存，请查看提示后调整；教练与场地不可时间冲突。");
  }
  async function inviteCoach(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitError(""); const form = new FormData(event.currentTarget);
    const certificate = String(form.get("certificate") || "").trim();
    const certificateExpiresAt = String(form.get("expiresAt") || "");
    if (certificate && !certificateExpiresAt) { setSubmitError("请按证书原文填写实际有效期，系统不会自动生成或延长证书有效期。"); return; }
    if (certificateExpiresAt && certificateExpiresAt < today()) { setSubmitError("该证书已过期，请提交真实有效的证书。"); return; }
    const ok = await act("coach.invite", { name: form.get("name"), phone: form.get("phone"), storeId: persona.storeId, specialty: form.get("specialty"), certificate, certificateExpiresAt });
    if (ok) { closeModal(); setTab("coaches"); } else setSubmitError("邀请未保存，请检查教练信息。");
  }

  const schedule = <div className="exp-panel"><div className="exp-panel-head"><div><h2>{isCoach ? "我的课表" : "门店课表"}</h2><p>{dateLabel(date)} · 共 {dayClasses.length} 节课程</p></div><input aria-label="课表日期" className="exp-select" type="date" value={date} onChange={event => setDate(event.target.value || today())} /></div>{dayClasses.length ? dayClasses.map(item => {
    const enrolled = bookings.filter(b => b.classId === item.id && activeBooking(b));
    const completed = enrolled.filter(b => b.status === "completed").length;
    const coach = data.coaches.find(c => c.id === item.coachId);
    return <div className="exp-session" key={item.id}><div className="exp-session-time">{timeOf(item.startAt)}<small>{timeOf(item.endAt)}</small></div><div className="exp-session-content"><div className="exp-session-title"><h3>{item.name}</h3><Badge tone={completed && completed === enrolled.length ? "gray" : ""}>{completed && completed === enrolled.length ? "已完成" : item.type}</Badge></div><div className="exp-session-meta"><span><User size={11} />{coach?.name || "待安排教练"}</span><span><MapPin size={11} />{item.room}</span><span><Users size={11} />{enrolled.length}/{item.capacity} 人</span></div></div><div className="exp-session-aside"><small>{enrolled.filter(b => b.status === "checked_in").length} 人已签到</small><button className="exp-button exp-small" onClick={() => setSelectedClassId(item.id)}>签到 / 消课<ChevronRight size={12} /></button></div></div>;
  }) : <Empty title="这一天还没有课程">{isCoach ? "选择其他日期查看你的安排" : "点击「新增排课」，为门店安排新课程"}</Empty>}</div>;

  return <div className="exp-root"><div className="exp-heading"><div><p className="exp-eyebrow">{isCoach ? "MY COACH WORKSPACE" : "STORE WORKSPACE"}</p><h1>{isCoach ? `${persona.name}，今天也要全力以赴` : "每一节好课，都从这里开始"}</h1><p>{store?.name || "我的门店"} · {isCoach ? "专注教学，陪伴每一次进步" : "课表、学员与团队，一站式有序协同"}</p></div><div className="exp-actions"><span className="exp-chip"><CalendarDays size={13} />{dateLabel(today())}</span>{!isCoach && <button className="exp-button exp-primary" onClick={() => setModal("class")}><Plus size={14} />新增排课</button>}</div></div>
    <div className="exp-stats"><Stat label={date === today() ? (isCoach ? "我的今日课程" : "今日课程") : "所选日期课程"} value={dayClasses.length} unit="节" note={<>覆盖 <b>{new Set(dayClasses.map(item => item.coachId)).size} 位教练</b></>} icon={<CalendarDays />} /><Stat label="课程预约" value={dayBookings.length} unit="人次" note={<>课程名额 <b>{dayClasses.reduce((sum, item) => sum + item.capacity, 0)} 个</b></>} icon={<Users />} /><Stat label="已到店签到" value={dayBookings.filter(item => ["checked_in", "completed"].includes(item.status)).length} unit="人次" note="签到后，可完成教学消课" icon={<UserCheck />} /><Stat label="待确认消课" value={dayBookings.filter(item => item.status === "checked_in").length} unit="笔" note={<>已完成 <b>{dayBookings.filter(item => item.status === "completed").length} 笔消课</b></>} icon={<ListChecks />} /></div>
    <div className="exp-tabs"><button className={activeTab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>工作台</button><button className={activeTab === "schedule" ? "active" : ""} onClick={() => setTab("schedule")}>{isCoach ? "我的课表" : "课程安排"}</button><button className={activeTab === "members" ? "active" : ""} onClick={() => setTab("members")}>{isCoach ? "我的学员" : "学员档案"}</button>{!isCoach && <button className={activeTab === "coaches" ? "active" : ""} onClick={() => setTab("coaches")}>教练团队{pendingCoaches.length > 0 && <span>{pendingCoaches.length}</span>}</button>}</div>

    {activeTab === "overview" && <div className="exp-columns"><div className="exp-stack">{schedule}<div className="exp-notice"><ShieldCheck size={16} /><span>预约先冻结课时，签到后由教练确认完成。消课记录将同步到学员课包，跨店课程自动生成内部结算单。</span></div></div><aside className="exp-stack">{!isCoach && <div className="exp-panel"><div className="exp-panel-head"><h2>总部协同</h2><Badge tone="amber">{pendingTasks.length} 项待办</Badge></div>{tasks.length ? tasks.slice(0, 5).map(item => <div className="exp-task" key={item.id}><div className="exp-task-title"><Megaphone size={14} /><strong>{item.title}</strong></div><p>{item.description}</p><div className="exp-task-footer"><span className="exp-muted exp-tiny">{shortDate(item.dueAt)} 截止</span>{item.status === "completed" ? <Badge tone="green"><Check size={10} />已完成</Badge> : <button disabled={busy} className="exp-button exp-small" onClick={() => void act("task.complete", { id: item.id })}>确认完成</button>}</div></div>) : <Empty title="所有任务已处理" />}</div>}<div className="exp-panel"><div className="exp-panel-head"><h2>{isCoach ? "教学提醒" : "团队动态"}</h2>{!isCoach && <button className="exp-icon-button" aria-label="查看教练团队" onClick={() => setTab("coaches")}><ArrowRight size={15} /></button>}</div><div className="exp-panel-body">{isCoach ? <><div className="exp-notice"><Info size={15} /><span>你可查看自己的课程与学员。课后请及时完成消课，学员即可查看最新课时余量。</span></div><div className="exp-person-row"><div className="exp-avatar">{persona.name.slice(-1)}</div><div><strong>{persona.name}</strong><p>{data.coaches.find(item => item.id === persona.coachId)?.specialty || "专属教练工作台"}</p></div><Badge tone="green">执教中</Badge></div></> : coaches.slice(0, 4).map((item, index) => <div className="exp-person-row" key={item.id}><div className={`exp-avatar ${index % 2 ? "mint" : ""}`}>{item.name.slice(-1)}</div><div><strong>{item.name}</strong><p>{item.specialty}</p></div><Badge tone={item.status === "approved" ? "green" : item.status === "pending" ? "amber" : "gray"}>{item.status === "approved" ? "已激活" : item.status === "pending" ? "待审核" : "已退回"}</Badge></div>)}</div></div></aside></div>}
    {activeTab === "schedule" && schedule}

    {activeTab === "members" && <div className="exp-panel"><div className="exp-panel-head"><div><h2>{isCoach ? "我的学员" : "学员档案"}</h2><p>查看学员上课记录与课时余量</p></div><label className="exp-search"><Search size={14} /><input aria-label="搜索学员姓名或手机号" placeholder="搜索姓名 / 手机号" value={query} onChange={event => setQuery(event.target.value)} /></label></div><div className="exp-table-wrap"><table className="exp-table"><thead><tr><th>学员</th><th>联系电话</th><th>可用课时</th><th>预约冻结</th><th>已完成课程</th><th>最近上课</th></tr></thead><tbody>{members.map(member => {
      const cards = data.cards.filter(card => card.memberId === member.id && card.status === "active");
      const history = bookings.filter(item => item.memberId === member.id && item.status === "completed");
      const last = history.map(b => data.classes.find(c => c.id === b.classId)).filter((item): item is ClassSession => !!item).sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt))[0];
      return <tr key={member.id}><td><div className="exp-inline"><div className="exp-avatar">{member.name.slice(-1)}</div><strong>{member.name}</strong></div></td><td>{member.phone}</td><td><strong>{cards.reduce((sum, card) => sum + card.remaining - card.frozen, 0)}</strong> 节</td><td>{cards.reduce((sum, card) => sum + card.frozen, 0)} 节</td><td>{history.length} 节</td><td>{last ? `${shortDate(last.startAt)} · ${last.name}` : "暂无消课记录"}</td></tr>;
    })}</tbody></table></div>{!members.length && <Empty title="没有找到匹配的学员">尝试其他姓名或手机号</Empty>}</div>}

    {activeTab === "coaches" && !isCoach && <><div className="exp-panel exp-onboard"><div className="exp-inline" style={{ justifyContent: "space-between" }}><div><h2>让好教练，加入你的团队</h2><p className="exp-muted exp-tiny" style={{ marginTop: 8 }}>统一资质要求，审核后激活排课权限</p></div><button className="exp-button exp-primary" onClick={() => setModal("invite")}><UserPlus size={14} />邀请教练</button></div><div className="exp-steps"><div className="exp-step done"><i><Check size={12} /></i>生成邀请 / 建立档案</div><ChevronRight size={15} /><div className="exp-step done"><i>02</i>完善身份信息</div><ChevronRight size={15} /><div className="exp-step"><i>03</i>门店审核资质</div><ChevronRight size={15} /><div className="exp-step"><i>04</i>激活排课上岗</div></div></div><div className="exp-team-grid">{coaches.map((item, index) => <div className="exp-panel exp-team-card" key={item.id}><div className="exp-team-top"><div className={`exp-avatar ${index % 2 ? "mint" : ""}`}>{item.name.slice(-1)}</div><div><h3>{item.name}</h3><span className="exp-muted exp-tiny">{item.specialty}</span></div><div style={{ marginLeft: "auto" }}><Badge tone={item.status === "approved" ? "green" : item.status === "pending" ? "amber" : "red"}>{item.status === "approved" ? "已激活" : item.status === "pending" ? "待审核" : "已退回"}</Badge></div></div><div className="exp-team-details"><p><span>联系电话</span><strong>{item.phone}</strong></p><p><span>教练资质</span><strong>{item.certificate || "待补充"}</strong></p><p><span>证书有效期</span><strong>{item.certificateExpiresAt || "待补充"}</strong></p>{item.inviteCode && <p><span>入驻邀请码</span><strong>{item.inviteCode}</strong></p>}<p><span>学员档案权限</span><strong>仅自己的学员</strong></p></div>{item.status === "pending" ? <div className="exp-actions"><button className="exp-button exp-primary exp-block" disabled={busy} onClick={() => setReview({ coach: item, approved: true })}><ShieldCheck size={13} />通过审核</button><button className="exp-button" disabled={busy} onClick={() => setReview({ coach: item, approved: false })}>退回</button></div> : <div className="exp-notice"><FileCheck2 size={14} /><span>{item.status === "approved" ? "资质已审核，教练已进入门店排课池。" : "资料已退回，审核通过前无法参与排课。"}</span></div>}</div>)}</div></>}

    {currentClass && <Modal title="预约签到与课后消课" onClose={() => setSelectedClassId(null)} wide><div className="exp-confirm-summary"><h3>{currentClass.name}</h3><p><CalendarDays size={13} />{dateLabel(currentClass.startAt)} · {timeOf(currentClass.startAt)}–{timeOf(currentClass.endAt)}</p><p><MapPin size={13} />{store?.name} · {currentClass.room}<span style={{ marginLeft: "auto" }}>{currentBookings.length}/{currentClass.capacity} 人</span></p></div><div className="exp-notice" style={{ marginBottom: 10 }}><Info size={15} /><span>学员到店后签到，完成授课后消课。确认消课会扣除课时卡中的 {currentClass.credits} 节冻结课时，此操作会写入审计记录。</span></div>{currentBookings.length ? currentBookings.map(item => { const member = data.members.find(m => m.id === item.memberId); const card = data.cards.find(c => c.id === item.cardId); return <div className="exp-attendance-row" key={item.id}><div className="exp-avatar">{member?.name.slice(-1) || "学"}</div><div><h3>{member?.name || "学员"}</h3><p>{card?.name || "课时卡"} · {item.credits} 节</p></div><div className="exp-actions"><Badge tone={statusTone[item.status]}>{statusText[item.status]}</Badge>{item.status === "reserved" && <button disabled={busy || !canCheckin} title="可在开课前 2 小时至课程结束后 2 小时内签到" className="exp-button exp-small exp-primary" onClick={() => void act("booking.checkin", { id: item.id })}><UserCheck size={12} />确认签到</button>}{item.status === "checked_in" && <button disabled={busy || !canComplete} title="课程开始后可确认教学完成" className="exp-button exp-small exp-primary" onClick={() => void act("booking.complete", { id: item.id })}><CheckCircle2 size={12} />完成消课</button>}</div></div>; }) : <Empty title="这节课还没有预约">学员预约后，可在这里签到和消课</Empty>}</Modal>}

    {modal === "class" && !isCoach && <Modal title="新增课程安排" onClose={closeModal} footer={<><button className="exp-button" onClick={closeModal}>取消</button><button disabled={busy || !approvedCoaches.length} className="exp-button exp-primary" type="submit" form="exp-class-form">{busy ? "保存中…" : "确认排课"}</button></>}><form id="exp-class-form" onSubmit={createClass} className="exp-form"><label className="exp-field full">课程名称<input name="name" placeholder="例如：力量与体能进阶" maxLength={40} required /></label><label className="exp-field">课程类型<select name="type" value={effectiveDraftType} onChange={event => setDraftType(event.target.value)} required>{courseTypes.map(value => <option key={value}>{value}</option>)}</select></label><label className="exp-field">授课教练<select key={effectiveDraftType} name="coachId" required defaultValue={qualifiedCoaches[0]?.id || ""}><option value="" disabled>选择已激活教练</option>{qualifiedCoaches.map(item => <option value={item.id} key={item.id}>{item.name} · {item.specialty}</option>)}</select></label><label className="exp-field full">上课日期<input name="date" type="date" required min={today()} defaultValue={date < today() ? today() : date} /></label><label className="exp-field">开始时间<input name="start" type="time" required defaultValue="18:00" /></label><label className="exp-field">结束时间<input name="end" type="time" required defaultValue="19:00" /></label><label className="exp-field">人数上限<input name="capacity" type="number" min="1" max="100" defaultValue="8" required /></label><label className="exp-field">抵扣课时 / 节<input name="credits" type="number" min="1" max="10" defaultValue="1" required /></label><label className="exp-field">单次展示价 / 元<input name="price" type="number" min="0" step="0.01" defaultValue="128" required /></label><label className="exp-field">教室 / 场地<input name="room" placeholder="例如：A 区训练室" required maxLength={30} /></label></form>{!approvedCoaches.length && <p className="exp-error">请先完成至少一位教练的资质审核，并确认其证书在有效期内。</p>}{submitError && <p role="alert" className="exp-error">{submitError}</p>}</Modal>}
    {modal === "invite" && !isCoach && <Modal title="邀请教练加入门店" onClose={closeModal} footer={<><button className="exp-button" onClick={closeModal}>取消</button><button disabled={busy} className="exp-button exp-primary" type="submit" form="exp-invite-form">{busy ? "保存中…" : "创建入驻申请"}</button></>}><div className="exp-notice" style={{ marginBottom: 20 }}><UserPlus size={15} /><span>建立教练入驻档案后，审核有效资质再激活排课。证书有效期请按原文如实填写，系统不会默认生成或自动延长。</span></div><form id="exp-invite-form" className="exp-form" onSubmit={inviteCoach}><label className="exp-field">教练姓名<input name="name" required maxLength={20} placeholder="输入姓名" /></label><label className="exp-field">手机号码<input name="phone" type="tel" required pattern="1[3-9][0-9]{9}" placeholder="11 位手机号码" /></label><label className="exp-field full">擅长领域<input name="specialty" required maxLength={40} placeholder="例如：力量训练 / 普拉提" /></label><label className="exp-field full">资质证书名称<input name="certificate" required maxLength={60} placeholder="例如：NASM 国际私人教练认证" /></label><label className="exp-field full">证书实际有效期（按证书原文填写）<input name="expiresAt" required type="date" min={today()} aria-describedby="exp-certificate-note" /><small id="exp-certificate-note">请与原始证书上的到期日期保持一致。</small></label></form>{submitError && <p className="exp-error" role="alert">{submitError}</p>}</Modal>}
    {review && !isCoach && <Modal title={review.approved ? "确认通过资质审核" : "退回教练申请"} onClose={() => setReview(null)} footer={<><button className="exp-button" onClick={() => setReview(null)}>取消</button><button disabled={busy} className={`exp-button ${review.approved ? "exp-primary" : "exp-danger"}`} onClick={async () => { if (await act("coach.review", { id: review.coach.id, approved: review.approved })) { setReview(null); notify(review.approved ? "资质已通过，教练可参与排课" : "申请已退回，请补齐有效资质"); } }}>{busy ? "处理中…" : review.approved ? "确认通过并激活" : "确认退回"}</button></>}><div className="exp-confirm-summary"><h3>{review.coach.name} · {review.coach.specialty}</h3><p><FileCheck2 size={14} />{review.coach.certificate}</p><p>有效期至 {review.coach.certificateExpiresAt}</p></div><div className="exp-notice"><ShieldCheck size={16} /><span>{review.approved ? "请核验资质真实性与有效期。通过后，教练将激活，仅可查看自己的学员与课表。" : "退回后，教练暂不能进入排课池。请联系教练补齐清晰、有效的资格材料。"}</span></div></Modal>}
  </div>;
}

function cardEligibility(card: Card, session: ClassSession) {
  if (card.status !== "active") return "课时卡已冻结";
  if (card.expiresAt.slice(0, 10) < dayOf(session.startAt)) return "课程日期超出有效期";
  if (card.scope === "home" && card.storeId !== session.storeId) return "仅限开卡门店使用";
  if (!card.classTypes.includes(session.type)) return "不适用该课程类型";
  if (card.remaining - card.frozen < session.credits) return "可用课时不足";
  return "";
}

export function StudentExperience({ data, persona, act, busy }: ExperienceProps) {
  const now = useClock();
  const [tab, setTab] = useState("discover");
  const [memberId, setMemberId] = useState(persona.memberId || "m1");
  const members = data.members.filter(item => (persona.memberIds || [persona.memberId]).includes(item.id));
  const member = members.find(item => item.id === memberId) || members[0];
  const actualMemberId = member?.id || memberId;
  const stores = data.stores.filter(item => item.status === "active");
  const [storeId, setStoreId] = useState(persona.storeId || stores[0]?.id || "");
  const selectedStore = stores.find(item => item.id === storeId) || stores[0];
  const actualStoreId = selectedStore?.id || storeId;
  const [date, setDate] = useState(() => { const next = data.classes.filter(item => item.storeId === (persona.storeId || data.stores[0]?.id) && item.status === "scheduled" && Date.parse(item.startAt) > Date.now()).sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))[0]; return next ? dayOf(next.startAt) : today(); });
  const [type, setType] = useState("全部课程");
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState("");
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [bookingFilter, setBookingFilter] = useState("upcoming");
  const [error, setError] = useState("");
  const cards = data.cards.filter(item => item.memberId === actualMemberId);
  const bookings = data.bookings.filter(item => item.memberId === actualMemberId).sort((a, b) => Date.parse(data.classes.find(c => c.id === b.classId)?.startAt || "1970-01-01") - Date.parse(data.classes.find(c => c.id === a.classId)?.startAt || "1970-01-01"));
  const active = bookings.filter(item => ["reserved", "checked_in"].includes(item.status));
  const availableCards = cards.filter(item => item.status === "active" && item.expiresAt.slice(0, 10) >= today());
  const availableCredits = availableCards.reduce((sum, item) => sum + Math.max(0, item.remaining - item.frozen), 0);
  const completed = bookings.filter(item => item.status === "completed");
  const courseTypes = ["全部课程", ...new Set(data.classes.filter(item => item.storeId === actualStoreId).map(item => item.type))];
  const classes = data.classes.filter(item => item.storeId === actualStoreId && dayOf(item.startAt) === date && item.status === "scheduled" && (type === "全部课程" || item.type === type)).sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const upcoming = active.map(item => ({ booking: item, session: data.classes.find(c => c.id === item.classId) })).filter((item): item is { booking: Booking; session: ClassSession } => !!item.session).sort((a, b) => Date.parse(a.session.startAt) - Date.parse(b.session.startAt));
  const walletCard = availableCards.find(item => item.scope === "all") || availableCards[0] || cards[0];
  const selectedClass = data.classes.find(item => item.id === selectedClassId);
  const cancelBooking = bookings.find(item => item.id === cancelId);
  const cancelSession = data.classes.find(item => item.id === cancelBooking?.classId);
  const filteredBookings = bookings.filter(item => bookingFilter === "all" || (bookingFilter === "upcoming" ? ["reserved", "checked_in"].includes(item.status) : bookingFilter === "completed" ? item.status === "completed" : item.status === "cancelled"));
  const closeBooking = () => { setSelectedClassId(null); setSelectedCardId(""); setError(""); };
  function chooseClass(session: ClassSession) { setSelectedClassId(session.id); setError(""); setSelectedCardId(cards.find(item => !cardEligibility(item, session))?.id || ""); }

  const wallet = (card: Card) => <div className="exp-wallet"><div className="exp-inline"><h3>{card.name}</h3><CreditCard size={17} /></div><div><strong>{card.status === "active" && card.expiresAt.slice(0, 10) >= today() ? Math.max(0, card.remaining - card.frozen) : 0}</strong><small>可用课时</small></div><div className="exp-wallet-footer"><span>{card.scope === "all" ? "品牌门店通用" : "开卡门店专享"}</span><span>有效至 {card.expiresAt.slice(0, 10)}</span></div></div>;

  return <div className="exp-root"><div className="exp-heading"><div><p className="exp-eyebrow">MY TRAINING CLUB</p><h1>热爱运动，让进步发生</h1><p>{data.tenants.find(item => item.id === persona.tenantId)?.name || "练多多运动俱乐部"} · 你的专属运动生活</p></div><span className="exp-chip"><ShieldCheck size={13} />品牌直营 · 专业陪伴</span></div><div className="exp-member-switch"><span>当前学员</span>{members.map((item, index) => <button key={item.id} onClick={() => { setMemberId(item.id); setSelectedClassId(null); }} className={actualMemberId === item.id ? "active" : ""}>{index === 0 ? <User size={12} /> : <Sparkles size={12} />}{item.name}<small>{item.id === persona.memberId ? "本人" : "家庭成员"}</small>{actualMemberId === item.id && <Check size={12} />}</button>)}</div>
    <div className="exp-student-hero"><div><p className="exp-eyebrow">MOVE MORE. BE MORE.</p><h2>{member?.name || "欢迎回来"}，每一次练习<br />都在靠近更好的自己</h2><p>自由选课 · 专业指导 · {stores.length} 家门店的运动时光</p></div><div className="exp-hero-stat"><div><strong>{availableCredits}</strong><span>可用课时</span></div><div><strong>{active.length}</strong><span>待上课程</span></div><div><strong>{completed.length}</strong><span>已完成训练</span></div></div></div>
    <div className="exp-tabs"><button className={tab === "discover" ? "active" : ""} onClick={() => setTab("discover")}><Dumbbell size={14} />发现课程</button><button className={tab === "bookings" ? "active" : ""} onClick={() => setTab("bookings")}><CalendarDays size={14} />我的预约{active.length > 0 && <span>{active.length}</span>}</button><button className={tab === "cards" ? "active" : ""} onClick={() => setTab("cards")}><CreditCard size={14} />我的课包</button></div>

    {tab === "discover" && <div className="exp-student-main"><div><div className="exp-panel"><div className="exp-panel-body"><div className="exp-inline" style={{ justifyContent: "space-between" }}><h2>选一家喜欢的门店</h2><span className="exp-muted exp-tiny">{stores.length} 家门店</span></div><div className="exp-store-choice">{stores.map(item => <button className={`exp-chip ${actualStoreId === item.id ? "active" : ""}`} key={item.id} onClick={() => { setStoreId(item.id); setType("全部课程"); }}><MapPin size={12} />{item.name}</button>)}</div><p className="exp-store-hint"><Info size={12} />{selectedStore?.address || "选择门店，发现适合你的课程"}</p></div></div><div className="exp-date-rail">{Array.from({ length: 7 }, (_, index) => offsetDay(today(), index)).map((day, index) => <button className={`exp-date ${date === day ? "active" : ""}`} key={day} onClick={() => setDate(day)}><span>{index === 0 ? "今天" : index === 1 ? "明天" : new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "Asia/Shanghai" }).format(new Date(`${day}T12:00:00+08:00`))}</span><b>{Number(day.slice(8, 10))}</b></button>)}</div><div className="exp-type-filters">{courseTypes.map(item => <button key={item} className={`exp-chip ${type === item ? "active" : ""}`} onClick={() => setType(item)}>{item}</button>)}<span>共 {classes.length} 节课程</span></div><div className="exp-course-grid">{classes.map((item, index) => {
      const coach = data.coaches.find(c => c.id === item.coachId);
      const booked = item.bookedCount ?? data.bookings.filter(b => b.classId === item.id && activeBooking(b)).length;
      const mine = bookings.some(b => b.classId === item.id && activeBooking(b));
      const ended = new Date(item.startAt).getTime() <= now;
      const full = booked >= item.capacity;
      const isSwim = item.type.includes("泳");
      return <article className="exp-course" key={item.id}><div className={`exp-course-art ${index % 3 === 1 ? "mint" : index % 3 === 2 ? "peach" : ""}`}><Badge>{item.type}</Badge>{isSwim ? <Waves /> : item.type.includes("少儿") ? <Sparkles /> : index % 2 ? <Flame /> : <Dumbbell />}</div><div className="exp-course-body"><div className="exp-course-title"><h3>{item.name}</h3><span>{Math.round((new Date(item.endAt).getTime() - new Date(item.startAt).getTime()) / 60000)} 分钟</span></div><div className="exp-course-coach"><span className="exp-avatar">{coach?.name.slice(-1)}</span>{coach?.name} · {coach?.specialty || "专业教练"}</div><div className="exp-course-info"><span><Clock3 size={11} />{timeOf(item.startAt)}–{timeOf(item.endAt)}</span><span><Users size={11} />{full ? "名额已满" : `余 ${item.capacity - booked} 位`}</span></div><div className="exp-course-footer"><span><b>{item.credits}</b>课时 / 次</span><button className={`exp-button exp-small ${mine || ended || full ? "" : "exp-primary"}`} disabled={mine || ended || full || busy} onClick={() => chooseClass(item)}>{mine ? "已预约" : ended ? "已开课" : full ? "已约满" : "预约课程"}</button></div></div></article>;
    })}</div>{!classes.length && <div className="exp-panel"><Empty title="这一天的课程正在准备中">试试其他日期或门店，找到下一次训练</Empty></div>}</div><aside className="exp-stack"><div className="exp-panel"><div className="exp-panel-head"><h2>我的课时卡</h2><button aria-label="查看全部课时卡" className="exp-icon-button" onClick={() => setTab("cards")}><ArrowRight size={14} /></button></div><div className="exp-panel-body">{walletCard ? <>{wallet(walletCard)}<div className="exp-person-row"><Ticket size={16} style={{ color: "#ab9ed0" }} /><div><strong style={{ fontSize: 11 }}>预约冻结 {walletCard.frozen} 节</strong><p>完成上课后才会实际扣除</p></div></div></> : <Empty title="还没有可用课时卡">请联系门店开通适合你的课包</Empty>}</div></div><div className="exp-panel"><div className="exp-panel-head"><h2>下一次运动</h2><Badge>{active.length} 次预约</Badge></div>{upcoming[0] ? <div className="exp-panel-body"><p className="exp-muted exp-tiny" style={{ marginBottom: 12 }}>{dateLabel(upcoming[0].session.startAt)}</p><h3>{upcoming[0].session.name}</h3><p className="exp-muted exp-tiny" style={{ marginTop: 9 }}>{timeOf(upcoming[0].session.startAt)}–{timeOf(upcoming[0].session.endAt)} · {data.stores.find(s => s.id === upcoming[0].session.storeId)?.name}</p><button className="exp-button exp-block" style={{ marginTop: 18 }} onClick={() => setTab("bookings")}>查看我的预约<ChevronRight size={12} /></button></div> : <Empty title="把运动加入你的日程">选择喜欢的课程，预约下一次进步</Empty>}</div><div className="exp-notice"><ShieldCheck size={15} /><span>品牌通用卡可跨店使用，系统自动核对课卡适用范围。预约前请确认上课学员。</span></div></aside></div>}

    {tab === "bookings" && <><div className="exp-panel"><div className="exp-panel-head"><div><h2>{member?.name}的课程预约</h2><p>预约、签到、完成，每一次进步都有记录</p></div></div><div className="exp-filterbar"><div className="exp-actions">{[["upcoming", "待上课"], ["completed", "已完成"], ["cancelled", "已取消"], ["all", "全部"]].map(([value, text]) => <button key={value} className={`exp-chip ${bookingFilter === value ? "active" : ""}`} onClick={() => setBookingFilter(value)}>{text}</button>)}</div><span className="exp-muted exp-tiny">{filteredBookings.length} 条记录</span></div>{filteredBookings.length ? filteredBookings.map(item => {
      const session = data.classes.find(c => c.id === item.classId); if (!session) return null;
      const cancellable = item.status === "reserved" && new Date(session.startAt).getTime() - now > 60 * 60000;
      return <div className="exp-booking" key={item.id}><div className="exp-booking-day"><small>{Number(dayOf(session.startAt).slice(5, 7))} 月</small><b>{Number(dayOf(session.startAt).slice(8, 10))}</b></div><div className="exp-booking-main"><h3>{session.name}</h3><p><span><Clock3 size={11} />{timeOf(session.startAt)}–{timeOf(session.endAt)}</span><span><User size={11} />{data.coaches.find(c => c.id === session.coachId)?.name}</span></p><p><span><MapPin size={11} />{data.stores.find(s => s.id === session.storeId)?.name}</span><span>{item.status === "completed" ? `已扣 ${item.credits} 节` : item.status === "cancelled" ? "课时已释放" : `冻结 ${item.credits} 节课时`}</span></p></div><div className="exp-booking-actions"><Badge tone={statusTone[item.status]}>{statusText[item.status]}</Badge>{item.status === "reserved" && <button disabled={!cancellable || busy} title={cancellable ? "取消后自动释放冻结课时" : "距开课不足 60 分钟，请联系门店"} className="exp-button exp-small" onClick={() => setCancelId(item.id)}>{cancellable ? "取消预约" : "请联系门店"}</button>}</div></div>;
    }) : <Empty title={bookingFilter === "upcoming" ? "还没有待上课程" : "这里还没有课程记录"}>在「发现课程」中，为自己安排一次运动</Empty>}</div><div className="exp-legend"><Info size={15} /><span>开课前 60 分钟可自行取消，冻结课时会自动释放。距开课不足 60 分钟，请联系门店协助处理。</span></div></>}

    {tab === "cards" && <><div className="exp-heading"><div><h2>{member?.name}的课时包</h2><p>已购课时 {cards.reduce((sum, card) => sum + card.total, 0)} 节 · 当前可用 {availableCredits} 节</p></div><Badge><ShieldCheck size={11} />课时账目清晰可查</Badge></div><div className="exp-wallet-grid">{cards.map(item => <div className="exp-panel exp-wallet-block" key={item.id}>{wallet(item)}<div className="exp-wallet-details"><p><span>持卡学员</span><b>{member?.name}</b></p><p><span>购入课时</span><b>{item.total} 节</b></p><p><span>剩余课时（含冻结）</span><b>{item.remaining} 节</b></p><p><span>预约冻结</span><b>{item.frozen} 节</b></p><p><span>适用课程</span><b>{item.classTypes.join(" / ") || "暂无适用课程"}</b></p><p><span>开卡门店</span><b>{data.stores.find(store => store.id === item.storeId)?.name}</b></p><p><span>课卡状态</span><Badge tone={item.status === "frozen" ? "amber" : item.expiresAt.slice(0, 10) < today() ? "gray" : "green"}>{item.status === "frozen" ? "已冻结" : item.expiresAt.slice(0, 10) < today() ? "已过期" : "使用中"}</Badge></p></div><div className="exp-progress" style={{ marginTop: 18 }}><span style={{ width: `${item.total ? Math.min(100, item.remaining / item.total * 100) : 0}%` }} /></div></div>)}</div>{!cards.length && <div className="exp-panel"><Empty title="这位学员还没有课时卡">请联系门店，为自己或家人开通课包</Empty></div>}<div className="exp-legend"><Info size={15} /><span>可用课时 = 剩余课时 − 预约冻结课时。取消预约会释放冻结课时；完成课程才会产生实际扣减。每位家庭成员独立持卡、独立记录。</span></div></>}

    {selectedClass && <Modal title="确认这一次，向前一步" onClose={closeBooking} footer={<><button className="exp-button" onClick={closeBooking}>再看看</button><button className="exp-button exp-primary" disabled={!selectedCardId || !cards.some(card => card.id === selectedCardId && !cardEligibility(card, selectedClass)) || busy} onClick={async () => { setError(""); if (await act("booking.create", { classId: selectedClass.id, cardId: selectedCardId, memberId: actualMemberId })) { closeBooking(); setTab("bookings"); setBookingFilter("upcoming"); } else setError("暂未完成预约，请根据提示核对课时卡和课程余位后重试。"); }}>{busy ? "预约中…" : `确认预约 · 冻结 ${selectedClass.credits} 节`}</button></>}><div className="exp-confirm-summary"><h3>{selectedClass.name}</h3><p><User size={13} />{member?.name} · {data.coaches.find(c => c.id === selectedClass.coachId)?.name} 教练</p><p><CalendarDays size={13} />{dateLabel(selectedClass.startAt)} {timeOf(selectedClass.startAt)}–{timeOf(selectedClass.endAt)}</p><p><MapPin size={13} />{selectedStore?.name} · {selectedClass.room}</p></div><p className="exp-confirm-label">选择抵扣课时卡</p>{cards.length ? cards.map(item => { const reason = cardEligibility(item, selectedClass); return <button disabled={!!reason} key={item.id} className={`exp-card-option ${selectedCardId === item.id ? "selected" : ""}`} onClick={() => setSelectedCardId(item.id)}>{selectedCardId === item.id ? <CircleCheck size={19} /> : <Circle size={19} />}<div><h3>{item.name}</h3><p>{reason || `${item.scope === "all" ? "品牌门店通用" : "开卡门店专享"} · 已冻结 ${item.frozen} 节`}</p></div><b>{Math.max(0, item.remaining - item.frozen)}<small style={{ fontSize: 10, marginLeft: 3 }}>节</small></b></button>; }) : <p className="exp-error">暂无课时卡，请联系门店开卡后再预约。</p>}<div className="exp-notice" style={{ marginTop: 19 }}><ShieldCheck size={15} /><span>本次预约冻结 {selectedClass.credits} 节，完成授课后才实际扣减。开课前 60 分钟可自行取消。{cards.find(item => item.id === selectedCardId)?.storeId !== selectedClass.storeId && selectedCardId ? "本次为跨店预约，课后将自动生成门店内部结算记录。" : ""}</span></div>{error && <p className="exp-error" role="alert">{error}</p>}</Modal>}
    {cancelBooking && cancelSession && <Modal title="确认取消课程预约" onClose={() => setCancelId(null)} footer={<><button className="exp-button" onClick={() => setCancelId(null)}>保留预约</button><button disabled={busy} className="exp-button exp-danger" onClick={async () => { if (await act("booking.cancel", { id: cancelBooking.id })) setCancelId(null); }}>{busy ? "处理中…" : "确认取消"}</button></>}><div className="exp-confirm-summary"><h3>{cancelSession.name}</h3><p><CalendarDays size={13} />{dateLabel(cancelSession.startAt)} · {timeOf(cancelSession.startAt)}</p></div><div className="exp-notice"><Ticket size={15} /><span>取消后，将释放 {cancelBooking.credits} 节冻结课时，可用于预约其他课程。</span></div></Modal>}
  </div>;
}
