"use client";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Activity, CalendarDays, ChevronRight, ClipboardList, CreditCard, DoorOpen, Dumbbell, FileText, Globe2, LayoutDashboard, LogOut, ReceiptText, RefreshCw, ShieldCheck, Store, Users, Wallet } from "lucide-react";
import type { ActionName, WorkspaceResponse } from "../lib/types";
import { AuthGate, requestJSON, type AccountSession } from "./components/AuthGate";
import { Operations } from "./components/Operations";
import { StoreExperience, StudentExperience } from "./components/Experience";
import { ExperienceSelect } from "./components/ExperienceSelect";
import { VenueManagement } from "./components/VenueManagement";
import { GlobalToast } from "./components/GlobalToast";
const CoachBilling = lazy(() => import("./components/CoachBilling").then(module => ({ default: module.CoachBilling })));
import type { ScheduleDraft } from "./components/ScheduleEditor";
import "./components/operations.css";

const roleNames: Record<string, string> = { platform: "平台管理员", hq: "组织管理员", manager: "门店店长", coach: "授课教练", student: "学员" };
const sameWorkspaceContext = (first: WorkspaceResponse["persona"], second: WorkspaceResponse["persona"]) => first.userId === second.userId && first.membershipId === second.membershipId && first.tenantId === second.tenantId && first.role === second.role && first.storeId === second.storeId && first.coachId === second.coachId && first.workspaceMode === second.workspaceMode;
const baseNav = [{ id: "overview", title: "今日经营", icon: LayoutDashboard }, { id: "followups", title: "学员跟进", icon: ClipboardList }, { id: "members", title: "学员档案", icon: Users }, { id: "courses", title: "课程与团队", icon: CalendarDays }, { id: "venues", title: "教室 / 场地", icon: DoorOpen }, { id: "orders", title: "课包与订单", icon: CreditCard }, { id: "coach-billing", title: "教练账单", icon: ReceiptText }, { id: "stores", title: "门店管理", icon: Store }, { id: "accounts", title: "账号与授权", icon: ShieldCheck }, { id: "settlements", title: "跨店记账", icon: Wallet }, { id: "audit", title: "操作记录", icon: FileText }];
export default function Home() {
  const [setupTokenRequired, setSetupTokenRequired] = useState(false);
  const [initialized, setInitialized] = useState<boolean | null>(null), [session, setSession] = useState<AccountSession | null>(null), [w, setW] = useState<WorkspaceResponse | null>(null);
  const latestSession = useRef(session);
  useLayoutEffect(() => { latestSession.current = session; }, [session]);
  const [page, setPage] = useState("overview"), [storeId, setStoreId] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [toast, setToast] = useState<{ id: number; message: string; tone: "success" | "error" | "info" } | null>(null);
  const toastSequence = useRef(0);
  const [venueDraft, setVenueDraft] = useState<{ key: string; draft: ScheduleDraft } | null>(null);
  const clearVenueDraft = useCallback(() => setVenueDraft(null), []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissToast = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; setToast(null); }, []);
  const notify = useCallback((message: string, tone: "success" | "error" | "info" = "success") => { setToast({ id: ++toastSequence.current, message, tone }); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { timer.current = null; setToast(null); }, tone === "error" ? 10000 : 5500); }, []);
  const load = useCallback(async () => {
    try { const data = await requestJSON<WorkspaceResponse>("/api/workspace"); setW(data); setError(""); return true; }
    catch (error) { if ((error as { status?: number }).status === 401) { setSession(null); setW(null); } else setError(error instanceof Error ? error.message : "数据加载失败"); return false; }
  }, []);
  const refreshTeamWorkspace = useCallback(async (signal?: AbortSignal) => {
    const origin = w, originSession = latestSession.current;
    if (!origin || !originSession || signal?.aborted || origin.persona.userId && origin.persona.userId !== originSession.user.id || origin.persona.membershipId && origin.persona.membershipId !== originSession.activeMembership?.id || origin.persona.tenantId !== originSession.activeMembership?.tenantId) return false;
    try {
      const data = await requestJSON<WorkspaceResponse>("/api/workspace", { signal });
      if (signal?.aborted || latestSession.current !== originSession || !sameWorkspaceContext(data.persona, origin.persona)) return false;
      setW(current => signal?.aborted || latestSession.current !== originSession || !current || !sameWorkspaceContext(current.persona, data.persona) || data.version < current.version ? current : data);
      return true;
    } catch (issue) {
      if (signal?.aborted || latestSession.current !== originSession) return false;
      if ((issue as { status?: number }).status === 401) {
        setW(current => signal?.aborted || latestSession.current !== originSession || !current || !sameWorkspaceContext(current.persona, origin.persona) ? current : null);
        setSession(current => signal?.aborted || latestSession.current !== originSession || current !== originSession ? current : null);
      }
      return false;
    }
  }, [w]);
  const bootstrap = useCallback(async () => {
    setError("");
    try { const setup = await requestJSON<{ initialized: boolean; setupTokenRequired?: boolean }>("/api/setup"); setInitialized(setup.initialized); setSetupTokenRequired(!!setup.setupTokenRequired); if (setup.initialized) { try { const account = await requestJSON<AccountSession>("/api/auth/session"); if (account.user) setSession(account); } catch (error) { if ((error as { status?: number }).status !== 401) throw error; } } }
    catch (error) { setError(error instanceof Error ? error.message : "无法连接本地服务"); }
  }, []);
  useEffect(() => { requestJSON<{ initialized: boolean; setupTokenRequired?: boolean }>("/api/setup").then(async setup => { setInitialized(setup.initialized); setSetupTokenRequired(!!setup.setupTokenRequired); if (setup.initialized) { const account = await requestJSON<AccountSession>("/api/auth/session"); if (account.user) setSession(account); } }).catch(error => setError(error instanceof Error ? error.message : "无法连接本地服务")); return () => { if (timer.current) clearTimeout(timer.current); }; }, []);
  useEffect(() => { if (!session) return; const controller = new AbortController(); requestJSON<WorkspaceResponse>("/api/workspace", { signal: controller.signal }).then(data => { setW(data); setError(""); }).catch(error => { if (controller.signal.aborted) return; if (error.status === 401) { setSession(null); setW(null); } else setError(error.message || "数据加载失败"); }); return () => controller.abort(); }, [session]);
  const act = useCallback(async (action: string, payload: Record<string, unknown>, onError?: (message: string) => void) => {
    if (!w || busy) return false; setBusy(true);
    try { const result = await requestJSON<WorkspaceResponse>("/api/actions", { method: "POST", body: JSON.stringify({ action, payload, version: w.version }) }); setW(result); notify("操作成功，数据已保存"); return true; }
    catch (error) { const message = error instanceof Error ? error.message : "保存失败，请重试"; if ((error as { status?: number }).status === 409) await load(); onError?.(message); notify(message, "error"); return false; }
    finally { setBusy(false); }
  }, [w, busy, load, notify]);
  async function switchContext(membershipId: string) {
    if (busy || membershipId === session?.activeMembership?.id) return; setBusy(true);
    try { const result = await requestJSON<AccountSession>("/api/auth/context", { method: "POST", body: JSON.stringify({ membershipId }) }); setW(null); setSession(result); setPage("overview"); setStoreId(""); setVenueDraft(null); }
    catch (error) { notify(error instanceof Error ? error.message : "切换失败", "error"); }
    finally { setBusy(false); }
  }
  async function logout() { setBusy(true); try { await requestJSON("/api/auth/logout", { method: "POST", body: "{}" }); setSession(null); setW(null); setPage("overview"); setVenueDraft(null); } catch (error) { notify(error instanceof Error ? error.message : "退出失败", "error"); } finally { setBusy(false); } }
  if (!session) {
    if (error) return <div className="loading-state"><Activity size={32}/><h2>本地服务暂时无法连接</h2><p>{error}</p><button className="btn btn-primary" onClick={() => void bootstrap()}>重新连接</button></div>;
    if (initialized === null) return <div className="loading-state"><span className="loading-mark"><Dumbbell size={28}/></span><h2>正在连接工作空间</h2></div>;
    return <AuthGate initialized={initialized} setupTokenRequired={setupTokenRequired} onAuthenticated={account => { setInitialized(true); setSession(account); }}/>;
  }
  const role = w?.persona.role || session.activeMembership?.role || "hq";
  const tenant = w?.data.tenants.find(item => item.id === w.persona.tenantId);
  const solo = (w?.persona.workspaceMode || session.activeMembership?.workspaceMode || tenant?.mode) === "solo";
  const platform = !solo && role === "platform", learner = role === "student", coach = role === "coach";
  const soloNav = [{ id: "overview", title: "今日安排", icon: LayoutDashboard }, { id: "members", title: "我的学员", icon: Users }, { id: "courses", title: "我的课程", icon: CalendarDays }, { id: "venues", title: "教室 / 场地", icon: DoorOpen }, { id: "orders", title: "课包与收款", icon: CreditCard }, { id: "coach-billing", title: "授课账单", icon: ReceiptText }, { id: "followups", title: "学员跟进", icon: ClipboardList }, { id: "accounts", title: "学员账号", icon: ShieldCheck }, { id: "audit", title: "操作记录", icon: FileText }];
  const nav = solo && !learner ? soloNav.filter(item => item.id !== "venues" || role === "hq" || role === "manager") : platform ? [{ id: "overview", title: "平台概览", icon: LayoutDashboard }, { id: "tenants", title: "组织管理", icon: Globe2 }, { id: "accounts", title: "组织管理员", icon: ShieldCheck }, { id: "audit", title: "操作记录", icon: FileText }] : learner ? [{ id: "overview", title: "我的训练", icon: LayoutDashboard }] : coach ? baseNav.filter(item => ["courses", "followups", "members", "coach-billing"].includes(item.id)) : baseNav.filter(item => role !== "manager" || !["settlements"].includes(item.id));
  const activePage = coach && page === "overview" ? "courses" : page;
  const title = nav.find(item => item.id === activePage)?.title || "工作空间";
  const selectedStore = w?.data.stores.find(item => item.id === (w.persona.storeId || storeId)) || w?.data.stores[0];
  const canChooseStore = role === "hq" && !solo;
  const canManageVenues = role === "hq" || role === "manager";
  const scheduleContextKey = `${session.user.id}:${session.activeMembership?.id || ""}:${w?.persona.tenantId || ""}:${solo ? "" : selectedStore?.id || ""}`;
  const savedScheduleDraft = venueDraft?.key === scheduleContextKey ? venueDraft.draft : undefined;
  const contextLabel = platform ? "平台运营中心" : tenant?.name || session.activeMembership?.tenantName || (solo ? `${session.user.name}的私教空间` : "我的组织");
  const roleLabel = solo && !learner ? "独立教练" : roleNames[role];
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark"><Dumbbell size={23}/></span><span>练多多<small>LIANDUODUO</small></span><span className="brand-pro">PRO</span></div><div className="workspace-picker"><span className="workspace-avatar">{contextLabel.slice(0, 1)}</span><div><strong>{contextLabel}</strong><small>{roleLabel}</small></div></div><span className="nav-label">{platform ? "平台管理" : solo ? "我的教学与经营" : "经营工作空间"}</span><nav>{nav.map(item => <button key={item.id} className={`nav-item ${activePage === item.id ? "active" : ""}`} onClick={() => setPage(item.id)}><item.icon size={18}/>{item.title}</button>)}</nav><div className="sidebar-bottom"><div className="help-card"><ClipboardList size={20}/><strong>把每次反馈，变成下一步行动</strong><p>从真实课时、到课和沟通记录开始，安排今天需要跟进的学员。</p></div><button className="nav-item" disabled={busy} onClick={() => void logout()}><LogOut size={17}/>退出登录</button><div className="sidebar-version"><i/>{solo ? "我的数据持续保存" : "组织数据实时保存"}<span>服务正常</span></div></div></aside><div className="main-shell"><header className="topbar"><div className="breadcrumb"><span>{contextLabel}</span><ChevronRight size={13}/><b>{title}</b></div><div className="topbar-right"><button type="button" className="icon-btn" aria-label="刷新数据" title="刷新数据" disabled={busy} onClick={() => void load()}><RefreshCw size={17}/></button>{!solo && session.memberships.length > 1 && <div className="account-context"><ExperienceSelect aria-label="切换已授权工作空间" value={session.activeMembership?.id || ""} disabled={busy} onValueChange={value => void switchContext(value)} menuLabel="已授权工作空间" options={session.memberships.map(m => ({value:m.id,label:m.label || `${m.tenantName || (m.role === "platform" ? "平台" : "组织")} · ${m.storeName || roleNames[m.role] || m.role}`}))}/></div>}<div className="user-menu"><span className="user-avatar">{session.user.name?.slice(0, 1) || "我"}</span><span><b>{session.user.name}</b><small>{roleLabel}</small></span></div><button className="icon-btn" disabled={busy} aria-label="退出登录" onClick={() => void logout()}><LogOut size={17}/></button></div></header><main className="content"><div className="mobile-nav"><span>当前页面</span><ExperienceSelect aria-label="切换管理页面" value={activePage} onValueChange={setPage} options={nav.map(item => ({value:item.id,label:item.title}))}/></div>{error ? <div className="error-card"><Activity size={28}/><h2>数据暂时无法加载</h2><p>{error}</p><button className="btn btn-primary" onClick={() => void load()}><RefreshCw size={15}/>重新加载</button></div> : !w ? <div className="loading-state"><span className="loading-mark"><Dumbbell size={25}/></span><p>{solo ? "读取我的安排…" : "读取组织数据…"}</p></div> : <>{learner ? <StudentExperience data={w.data} persona={w.persona} busy={busy} act={act as (action: ActionName, payload: Record<string, unknown>) => Promise<boolean>} notify={notify}/> : activePage === "courses" ? <>{canChooseStore && <div className="filterbar"><div className="exp-store-picker"><ExperienceSelect aria-label="选择排课门店" value={selectedStore?.id || ""} onValueChange={setStoreId} icon={<Store size={15}/>} menuLabel="选择排课门店" options={w.data.stores.map(store => ({value:store.id,label:store.name,description:store.status === "active" ? store.address || "正常营业" : "门店已停用，无法新增课程"}))}/></div></div>}{solo || selectedStore ? <StoreExperience key={solo ? w.persona.tenantId : selectedStore?.id} data={w.data} persona={solo ? w.persona : { ...w.persona, storeId: selectedStore?.id }} act={act as (action: ActionName, payload: Record<string, unknown>) => Promise<boolean>} busy={busy} notify={notify} onTeamCodeChanged={refreshTeamWorkspace} initialScheduleDraft={savedScheduleDraft} onScheduleDraftConsumed={clearVenueDraft} onManageVenues={canManageVenues ? draft => { setVenueDraft({ key: scheduleContextKey, draft }); setPage("venues"); } : undefined}/> : <section className="card onboard-empty"><Store size={35}/><h2>先添加第一家门店</h2><p>建立门店后，即可添加教练与安排课程。</p><button className="btn btn-primary" onClick={() => setPage("stores")}>前往门店管理</button></section>}</> : activePage === "coach-billing" ? <Suspense fallback={<div className="loading-state"><ReceiptText size={25}/><p>正在读取教练账单…</p></div>}><CoachBilling key={`${session.user.id}:${session.activeMembership?.id || ""}`} data={w.data} persona={w.persona} busy={busy} act={act} notify={notify}/></Suspense> : activePage === "venues" ? <VenueManagement data={w.data} persona={w.persona} busy={busy} act={act} initialStoreId={solo ? "" : selectedStore?.id} onReturnToSchedule={savedScheduleDraft ? () => setPage("courses") : undefined}/> : <Operations data={w.data} persona={w.persona} page={activePage} title={title} act={act} busy={busy} notify={notify} navigate={setPage} onInviteChanged={refreshTeamWorkspace}/>}</>}<footer className="footer"><span>练多多 · 每一次训练，都值得认真经营</span><span>账号 {session.user.account}</span></footer></main></div>{toast && <GlobalToast key={toast.id} message={toast.message} tone={toast.tone} onDismiss={dismissToast}/>}</div>;
}
