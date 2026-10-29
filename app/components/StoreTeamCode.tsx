"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Clock3, Copy, KeyRound, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { Persona } from "@/lib/types";
import { requestJSON } from "./AuthGate";
import "./store-team-code.css";

interface TeamCodeStatus {
  storeId: string;
  status: "not_generated" | "active" | "expired";
  expiresAt: string | null;
}
interface GeneratedTeamCode extends TeamCodeStatus { teamCode: string; }
interface Props {
  storeId: string;
  storeName?: string;
  persona: Persona;
  workspaceMode?: "solo" | "organization";
  busy?: boolean;
  notify?: (message: string, tone?: "success" | "error" | "info") => void;
  onChanged?: (signal?: AbortSignal) => Promise<boolean>;
}
const formatExpiry = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
function validStatus(value: TeamCodeStatus, storeId: string) {
  return value.storeId === storeId && ["not_generated", "active", "expired"].includes(value.status) && (value.status !== "active" || typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt)));
}

function ResetConfirmation({ storeName, busy, error, onCancel, onConfirm }: { storeName: string; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="team-code-dialog" aria-labelledby="team-code-reset-title" onCancel={event => { if (busy) event.preventDefault(); else onCancel(); }}>
    <div className="team-code-dialog-head"><h2 id="team-code-reset-title">重置本店团队码？</h2><button type="button" disabled={busy} aria-label="关闭团队码重置确认" onClick={onCancel}><X size={18}/></button></div>
    <div className="team-code-dialog-body"><div className="team-code-reset-icon"><RefreshCw size={23}/></div><h3>{storeName}</h3><p>重置后，旧团队码和尚未完成的加入确认会立即失效。需要把新码发给尚未加入门店的教练。</p><div className="team-code-reset-note"><ShieldCheck size={15}/><span>已经正常加入门店的教练不受影响。新码有效期为 7 天。</span></div>{error && <p className="team-code-error" role="alert">{error}</p>}</div>
    <div className="team-code-dialog-actions"><button type="button" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="primary" disabled={busy} onClick={onConfirm}>{busy ? "正在重置…" : "确认重置团队码"}</button></div>
  </dialog>;
}

/** The plaintext exists only in this mounted store's React state after a successful generation. */
export function StoreTeamCode({ storeId, storeName = "当前门店", persona, workspaceMode, busy = false, notify, onChanged }: Props) {
  const allowed = workspaceMode !== "solo" && persona.workspaceMode !== "solo" && !!storeId && ["hq", "manager"].includes(persona.role) && (persona.role !== "manager" || persona.storeId === storeId);
  const context = JSON.stringify([persona.userId, persona.membershipId, persona.tenantId, persona.role, storeId, allowed]);
  const [retry, setRetry] = useState(0), [now, setNow] = useState(() => Date.now());
  const requestKey = `${context}:${retry}`;
  const [snapshot, setSnapshot] = useState<{ key: string; value: TeamCodeStatus; teamCode?: string } | null>(null);
  const [issue, setIssue] = useState<{ key: string; message: string } | null>(null), [refreshIssue, setRefreshIssue] = useState<{ key: string; message: string } | null>(null);
  const [postingKey, setPostingKey] = useState<string | null>(null), [confirmContext, setConfirmContext] = useState<string | null>(null);
  const epoch = useRef(0), posting = useRef(false), mutationController = useRef<AbortController | null>(null);
  const view = snapshot?.key === requestKey ? snapshot : null;
  const error = issue?.key === requestKey ? issue.message : "";
  const refreshWarning = refreshIssue?.key === requestKey ? refreshIssue.message : "";
  const submitting = postingKey === requestKey;
  const confirming = confirmContext === context;
  const loading = allowed && !view && !error;
  const expired = view?.value.status === "expired" || view?.value.status === "active" && !!view.value.expiresAt && Date.parse(view.value.expiresAt) <= now;
  const status = expired ? "expired" : view?.value.status;
  const code = status === "active" ? view?.teamCode || "" : "";

  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!allowed) return;
    const serial = ++epoch.current, controller = new AbortController();
    requestJSON<TeamCodeStatus>(`/api/store-team-code?${new URLSearchParams({ storeId })}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted || serial !== epoch.current) return;
      if (!validStatus(value, storeId)) throw new Error("团队码状态暂不完整，请重新读取。");
      setSnapshot({ key: requestKey, value });
    }).catch(error => { if (!controller.signal.aborted && serial === epoch.current) setIssue({ key: requestKey, message: error instanceof Error ? error.message : "团队码状态读取失败，请重试。" }); });
    return () => { epoch.current += 1; controller.abort(); mutationController.current?.abort(); posting.current = false; };
  }, [allowed, storeId, requestKey]);

  async function generate(reset: boolean) {
    if (!allowed || busy || posting.current || !view || loading || reset && !confirming) return;
    const serial = ++epoch.current, controller = new AbortController(); mutationController.current = controller;
    posting.current = true; setPostingKey(requestKey); setIssue(null); setRefreshIssue(null);
    try {
      const value = await requestJSON<GeneratedTeamCode>("/api/store-team-code", { method: "POST", body: JSON.stringify({ storeId }), signal: controller.signal });
      if (serial !== epoch.current || controller.signal.aborted) return;
      if (!validStatus(value, storeId) || value.status !== "active" || !/^\d{6}$/.test(value.teamCode)) throw new Error("未收到完整的新团队码，请重新读取状态后核对。");
      setSnapshot({ key: requestKey, value: { storeId: value.storeId, status: value.status, expiresAt: value.expiresAt }, teamCode: value.teamCode });
      setConfirmContext(null);
      notify?.(reset ? "团队码已重置，旧码已失效" : "团队码已生成，7 天内有效", "success");
      if (onChanged) {
        let refreshed = false;
        try { refreshed = await onChanged(controller.signal); } catch { /* Generation succeeded independently of the workspace refresh. */ }
        if (!refreshed && serial === epoch.current && !controller.signal.aborted) setRefreshIssue({ key: requestKey, message: "新团队码已生成并保留。列表同步暂未完成，请稍后刷新工作空间；无需再次生成或重置。" });
      }
    } catch (error) {
      if (serial === epoch.current && !controller.signal.aborted) setIssue({ key: requestKey, message: error instanceof Error ? error.message : "团队码生成未完成，请重试。" });
    } finally {
      if (serial === epoch.current) { posting.current = false; setPostingKey(null); }
    }
  }
  async function copy() {
    if (!code || submitting) return;
    const serial = epoch.current;
    try { await navigator.clipboard.writeText(code); if (serial === epoch.current) notify?.("团队码已复制", "success"); }
    catch { if (serial === epoch.current) setIssue({ key: requestKey, message: "复制未完成，请手动选中下方团队码复制。" }); }
  }
  if (!allowed) return null;
  return <section className="team-code-card" aria-label="本店教练团队码">
    <div className="team-code-copy"><div className="team-code-kicker"><span><KeyRound size={16}/></span>TEAM INVITATION<span className={`team-code-status ${status === "active" ? "active" : ""}`}>{loading ? "读取中" : status === "active" ? "有效期内" : status === "expired" ? "已过期" : status === "not_generated" ? "尚未生成" : "暂不可读"}</span></div><h2>一枚团队码，连接你的教练团队</h2><p>教练在小程序填写<strong>已建档手机号 + 本店团队码</strong>，匹配档案后加入门店。请先建立教练档案，再分享团队码。</p><div className="team-code-store"><ShieldCheck size={14}/><span>{storeName}专属 · 明文仅在生成当次显示</span></div><div className="team-code-flow"><span><i>01</i>建立教练档案</span><b>›</b><span><i>02</i>手机号 + 团队码加入</span></div></div>
    <div className={`team-code-panel ${code ? "has-code" : ""}`}><div className="team-code-panel-label"><span>门店团队码</span><small>{code ? "请保存或复制" : "6 位数字 · 7 天有效"}</small></div><div className="team-code-digits" role="group" aria-label={code ? `团队码 ${code.split("").join(" ")}` : status === "active" ? "当前有效码的明文未在本次会话显示" : "尚无可展示的团队码"}>{Array.from({ length: 6 }, (_, index) => <span key={index} aria-hidden="true">{code ? code[index] : status === "active" ? "•" : "—"}</span>)}</div><p className="team-code-expiry"><Clock3 size={12}/>{view?.value.expiresAt && Number.isFinite(Date.parse(view.value.expiresAt)) ? `有效期至 ${formatExpiry(view.value.expiresAt)}（北京时间）` : "生成后 7 天内有效"}</p>
      <p className="team-code-state-copy">{loading ? "正在读取当前门店的团队码状态…" : code ? "新团队码已准备好，可分享给已建档的教练。" : status === "active" ? "当前已有有效码，忘记请重置。" : status === "expired" ? "原团队码已过期，可重新生成。" : status === "not_generated" ? "生成团队码后，教练即可按档案信息加入门店。" : "读取成功后，可生成或管理本店团队码。"}</p>
      <div className="team-code-actions">{code && <button type="button" disabled={submitting} onClick={() => void copy()}><Copy size={13}/>复制团队码</button>}{view && <button type="button" className="primary" disabled={busy || submitting || loading} onClick={() => { if (status === "active") { setIssue(null); setConfirmContext(context); } else void generate(false); }}>{submitting ? <><RefreshCw size={13}/>正在生成…</> : status === "active" ? <><RefreshCw size={13}/>重置团队码</> : <><KeyRound size={13}/>生成团队码</>}</button>}{!view && error && <button type="button" disabled={busy || submitting} onClick={() => setRetry(value => value + 1)}><RefreshCw size={13}/>重新读取状态</button>}</div>
      {error && !confirming && <p className="team-code-error" role="alert">{error}</p>}{refreshWarning && <p className="team-code-refresh-note" role="status"><Check size={13}/><span>{refreshWarning}</span></p>}
    </div>
    {confirming && <ResetConfirmation storeName={storeName} busy={submitting} error={error} onCancel={() => { setConfirmContext(null); setIssue(null); }} onConfirm={() => void generate(true)}/>}
  </section>;
}
