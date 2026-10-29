"use client";
import { useState, type FormEvent } from "react";
import { ArrowRight, Dumbbell, ShieldCheck, Store, UserRound } from "lucide-react";

export interface SessionMembership { id: string; role: string; tenantId?: string; storeId?: string; coachId?: string; memberId?: string; memberIds?: string[]; tenantName?: string; storeName?: string; label?: string; workspaceMode?: "solo" | "organization"; }
export interface AccountSession { user: { id: string; name: string; account: string }; memberships: SessionMembership[]; activeMembership: SessionMembership | null; }
export async function requestJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", cache: "no-store", ...options, headers: { ...(options?.body ? { "Content-Type": "application/json" } : {}), ...options?.headers } });
  const data = await response.json().catch(() => ({ error: "服务暂时无法响应，请稍后重试或联系管理员。" })) as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(data.error || "请求失败，请重试。"), { status: response.status });
  return data as T;
}
export function AuthGate({ initialized, setupTokenRequired = false, onAuthenticated }: { initialized: boolean; setupTokenRequired?: boolean; onAuthenticated: (session: AccountSession) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [mode, setMode] = useState<"solo" | "organization">("solo");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const setupToken = String(values.setupToken || "").trim(); delete values.setupToken;
    try {
      const session = await requestJSON<AccountSession>(initialized ? "/api/auth/login" : "/api/setup", { method: "POST", headers: !initialized && setupTokenRequired ? { "X-Setup-Token": setupToken } : undefined, body: JSON.stringify(values) });
      onAuthenticated(session);
    } catch (error) { setError(error instanceof Error ? error.message : "暂时无法登录，请重试。"); }
    finally { setBusy(false); }
  }
  return <main className="auth-screen"><section className="auth-story"><div className="brand"><span className="brand-mark"><Dumbbell size={23}/></span><span>练多多<small>LIANDUODUO</small></span></div><div><p className="eyebrow">EVERY CLASS MATTERS</p><h1>把心思留给教学，<br/>把安排交给练多多。</h1><p>从一个人的私教课程开始，<br/>管理学员、课包、上课地点与每次跟进。</p><div className="auth-points"><span>灵活安排上课地点</span><span>清楚记录课时收款</span><span>认真跟进每位学员</span></div></div><p className="auth-footnote">独立教练与机构均可使用 · 真实账号 · 数据持续保存</p></section><section className="auth-panel"><form onSubmit={submit}><span className="auth-lock"><ShieldCheck size={24}/></span><h2>{initialized ? "欢迎回到练多多" : "开始你的教学工作空间"}</h2><p>{initialized ? "使用你的账号登录，继续今天的安排" : mode === "solo" ? "一个人也能开始，无需门店或团队。" : "为组织建立门店、员工与共享业务空间。"}</p>{!initialized && <><fieldset className="auth-mode-choice"><legend>你如何使用练多多</legend><label className={mode === "solo" ? "selected" : ""}><input type="radio" name="mode" value="solo" checked={mode === "solo"} onChange={() => setMode("solo")}/><UserRound size={19}/><span><strong>独立教练</strong><small>自己管理学员和课程</small></span></label><label className={mode === "organization" ? "selected" : ""}><input type="radio" name="mode" value="organization" checked={mode === "organization"} onChange={() => setMode("organization")}/><Store size={19}/><span><strong>机构门店</strong><small>多角色与团队协作</small></span></label></fieldset><label>{mode === "solo" ? "你的姓名" : "管理员姓名"}<input name="name" required maxLength={30} autoComplete="name" placeholder="你的姓名"/></label>{mode === "solo" ? <><label>工作空间名称（可选）<input name="tenantName" maxLength={60} placeholder="例如：小林的私教空间"/></label><label>擅长科目（可选）<input name="specialty" maxLength={100} placeholder="例如：力量训练、功能训练"/></label></> : <div className="form-grid"><label>组织名称<input name="tenantName" required maxLength={60} placeholder="例如：力行私教工作室"/></label><label>首家门店<input name="storeName" required maxLength={60} placeholder="例如：中心店"/></label></div>}</>}{!initialized && setupTokenRequired && <label>首次开通码<input name="setupToken" type="password" required maxLength={256} autoComplete="off" placeholder="从部署配置中获取，仅首次开通需要"/></label>}<label>登录账号<input name="account" required minLength={3} maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,63}" autoComplete="username" placeholder="手机号或自定义账号"/></label><label>登录密码<input name="password" type="password" required minLength={10} maxLength={128} autoComplete={initialized ? "current-password" : "new-password"} placeholder="至少 10 位密码"/></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="btn btn-primary auth-submit" disabled={busy}>{busy ? "正在处理…" : initialized ? "登录工作空间" : "创建并开始使用"}<ArrowRight size={16}/></button><p className="auth-small">{initialized ? "请使用开通时保存的账号密码，或向为你开通账号的教练或管理员咨询。" : mode === "solo" ? "保存好账号密码，创建后即可添加学员、登记课包和安排课程。" : "请保存管理员账号密码，后续可在账号管理中开通员工与学员账号。"}</p></form></section></main>;
}
