"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Clock3, Copy, KeyRound, RefreshCw, ShieldCheck, UserRound, X } from "lucide-react";
import type { Member, Persona } from "@/lib/types";
import { requestJSON } from "./AuthGate";
import "./student-invite.css";

type InviteStatus = { memberId: string; status: "not_generated" | "active" | "expired" | "claimed"; expiresAt: string | null; claimedAt?: string; existingPasswordAccess?: boolean };
type Props = { member: Member; storeName: string; persona: Persona; busy?: boolean; notify?: (text: string, tone?: "success" | "error" | "info") => void; onChanged?: (signal?: AbortSignal) => Promise<boolean>; onClose: () => void };
const formatTime = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
function valid(value: InviteStatus, memberId: string) { return value.memberId === memberId && ["not_generated", "active", "expired", "claimed"].includes(value.status) && (value.status !== "active" || typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))); }

/** Plaintext is shown only for this member and this mounted administrator context. */
export function StudentInvite({ member, storeName, persona, busy = false, notify, onChanged, onClose }: Props) {
  const allowed = ["hq", "manager"].includes(persona.role) && persona.tenantId === member.tenantId && (persona.role !== "manager" || persona.storeId === member.storeId);
  const context = JSON.stringify([persona.userId, persona.membershipId, persona.tenantId, persona.role, persona.storeId, member.id, member.storeId, allowed]);
  const [retry, setRetry] = useState(0), [now, setNow] = useState(() => Date.now());
  const key = `${context}:${retry}`;
  const [snapshot, setSnapshot] = useState<{ key: string; value: InviteStatus; code?: string } | null>(null);
  const [issue, setIssue] = useState<{ key: string; text: string } | null>(null), [refreshIssue, setRefreshIssue] = useState<{ key: string; text: string } | null>(null);
  const [postingKey, setPostingKey] = useState<string | null>(null), [confirmation, setConfirmation] = useState<string | null>(null);
  const epoch = useRef(0), posting = useRef(false), dialog = useRef<HTMLDialogElement>(null), mutation = useRef<AbortController | null>(null);
  const current = snapshot?.key === key ? snapshot : null, error = issue?.key === key ? issue.text : "", refreshWarning = refreshIssue?.key === key ? refreshIssue.text : "";
  const submitting = postingKey === key, confirming = confirmation === context;
  const loading = allowed && !current && !error;
  const status = current?.value.status === "active" && current.value.expiresAt && Date.parse(current.value.expiresAt) <= now ? "expired" : current?.value.status;
  const code = status === "active" ? current?.code || "" : "";
  const claimed = status === "claimed";
  const title = confirming ? "重置这位学员的邀请码？" : "学员微信邀请码";
  useEffect(() => { if (!allowed) return; const element = dialog.current; element?.showModal(); return () => element?.close(); }, [allowed, context]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!allowed) return;
    const serial = ++epoch.current, controller = new AbortController();
    requestJSON<InviteStatus>(`/api/member-invite?${new URLSearchParams({ memberId: member.id })}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted || serial !== epoch.current) return;
      if (!valid(value, member.id)) throw new Error("邀请码状态返回不完整，请重新读取。");
      setSnapshot({ key, value });
    }).catch(error => { if (!controller.signal.aborted && serial === epoch.current) setIssue({ key, text: error instanceof Error ? error.message : "邀请码状态读取失败。" }); });
    return () => { epoch.current += 1; controller.abort(); mutation.current?.abort(); posting.current = false; };
  }, [allowed, key, member.id]);

  async function generate(reset: boolean) {
    if (!allowed || busy || posting.current || !current || loading || claimed || reset && !confirming) return;
    const serial = ++epoch.current, controller = new AbortController(); mutation.current = controller;
    posting.current = true; setPostingKey(key); setIssue(null); setRefreshIssue(null);
    try {
      const result = await requestJSON<InviteStatus & { inviteCode: string }>("/api/member-invite", { method: "POST", body: JSON.stringify({ memberId: member.id }), signal: controller.signal });
      if (controller.signal.aborted || serial !== epoch.current) return;
      if (!valid(result, member.id) || result.status !== "active" || !/^\d{8}$/.test(result.inviteCode)) throw new Error("未收到完整的邀请码，请先重新读取状态，再核对是否需要重置。");
      setSnapshot({ key, value: { memberId: result.memberId, status: result.status, expiresAt: result.expiresAt, existingPasswordAccess: result.existingPasswordAccess }, code: result.inviteCode });
      setConfirmation(null);
      notify?.(reset ? "学员邀请码已重置，原码已失效" : "学员邀请码已生成", "success");
      if (onChanged) {
        let refreshed = false;
        try { refreshed = await onChanged(controller.signal); } catch { /* The generated code remains available even if the list refresh fails. */ }
        if (!refreshed && !controller.signal.aborted && serial === epoch.current) setRefreshIssue({ key, text: "邀请码已生成并保留。列表同步暂未完成，无需重复生成；稍后刷新工作空间即可。" });
      }
    } catch (error) {
      if (!controller.signal.aborted && serial === epoch.current) {
        const status = (error as { status?: number }).status;
        if (!status || status >= 500 || status === 409) { setSnapshot(null); setConfirmation(null); }
        setIssue({ key, text: error instanceof Error ? error.message : "未确认生成结果，请重新读取状态后核对。" });
      }
    } finally { if (serial === epoch.current) { posting.current = false; setPostingKey(null); } }
  }
  async function copy() {
    if (!code || submitting) return;
    const serial = epoch.current;
    try { await navigator.clipboard.writeText(code); if (serial === epoch.current) notify?.("学员邀请码已复制", "success"); }
    catch { if (serial === epoch.current) setIssue({ key, text: "复制未完成，请手动选中邀请码复制。" }); }
  }
  if (!allowed) return null;
  return <dialog ref={dialog} className="student-invite-dialog" aria-labelledby="student-invite-title" onCancel={event => { if (submitting) event.preventDefault(); else if (confirming) { event.preventDefault(); setConfirmation(null); setIssue(null); } else onClose(); }} onClick={event => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
    <div className="si-header"><div><span className="si-eyebrow">A PLACE TO GROW</span><h2 id="student-invite-title">{title}</h2></div><button type="button" aria-label="关闭学员邀请码" disabled={submitting} onClick={onClose}><X size={19}/></button></div>
    <div className="si-body"><div className="si-member"><span className="si-avatar"><UserRound size={23}/></span><div><strong>{member.name}</strong><p>{storeName}</p></div><span className={`si-status ${claimed ? "si-status-claimed" : ""}`}>{loading ? "读取中" : claimed ? "已绑定微信" : status === "active" ? "待学员领取" : status === "expired" ? "已过期" : status === "not_generated" ? "尚未生成" : "暂不可读"}</span></div>
      {confirming ? <div className="si-reset"><span><RefreshCw size={25}/></span><h3>原邀请码将立即失效</h3><p>尚未完成的绑定确认也会失效。请将新码单独发给 <strong>{member.name}</strong>，新码仍为 7 天有效、仅可使用一次。</p></div> : claimed ? <div className="si-claimed"><span><Check size={29}/></span><h3>学员已连接自己的训练档案</h3><p>对方可在小程序「我的 → 当前业务身份」切换到学员视角。已有教练或其他授权会继续保留。</p>{current?.value.claimedAt && Number.isFinite(Date.parse(current.value.claimedAt)) && <small>绑定于 {formatTime(current.value.claimedAt)}（北京时间）</small>}</div> : <><p className="si-intro">把这位学员的专属邀请码发给本人，在小程序输入并确认，即可查看课程、预约和课包，无需设置账号密码。</p><div className={`si-code-panel ${code ? "si-has-code" : ""}`}><div className="si-code-label"><span>专属学员邀请码</span><small>8 位数字 · 单次使用</small></div><div className="si-digits" role="group" aria-label={code ? `学员邀请码 ${code.split("").join(" ")}` : status === "active" ? "已有有效邀请码，明文仅在生成当次显示" : "尚无可展示的邀请码"}>{Array.from({ length: 8 }, (_, index) => <span key={index} aria-hidden="true">{code ? code[index] : status === "active" ? "•" : "—"}</span>)}</div><p className="si-expiry"><Clock3 size={13}/>{current?.value.expiresAt && Number.isFinite(Date.parse(current.value.expiresAt)) ? `有效期至 ${formatTime(current.value.expiresAt)}（北京时间）` : "生成后 7 天内有效"}</p>{code ? <button type="button" className="si-copy" disabled={submitting} onClick={() => void copy()}><Copy size={14}/>复制邀请码</button> : <p className="si-code-note">{loading ? "正在读取当前邀请码状态…" : status === "active" ? "已有有效邀请码。明文只在生成当次显示，忘记后可重置。" : status === "expired" ? "原邀请码已过期，请重新生成后分享。" : "生成后即可分享给这位学员。"}</p>}</div><div className="si-flow"><span><i>01</i>生成并单独分享</span><b>›</b><span><i>02</i>微信确认绑定</span><b>›</b><span><i>03</i>切换学员视角</span></div></>}
      {current?.value.existingPasswordAccess && !claimed && <p className="si-note"><ShieldCheck size={15}/><span>该档案已有后台账号授权。本次只新增该学员档案的微信访问权限，原账号及其其他授权保持不变。</span></p>}
      {!claimed && <p className="si-note"><ShieldCheck size={15}/><span>一码只对应这位学员，请单独发送给本人。绑定后不移除对方已有的教练身份。</span></p>}
      {error && <p className="si-error" role="alert">{error}</p>}{refreshWarning && <p className="si-note" role="status"><Check size={15}/><span>{refreshWarning}</span></p>}
    </div>
    <div className="si-footer"><button type="button" disabled={submitting} onClick={() => { if (confirming) { setConfirmation(null); setIssue(null); } else onClose(); }}>{confirming ? "取消重置" : "关闭"}</button>{!current && error ? <button type="button" className="si-primary" disabled={submitting || busy} onClick={() => { setIssue(null); setRetry(value => value + 1); }}><RefreshCw size={14}/>重新读取状态</button> : !claimed && current && <button type="button" className="si-primary" disabled={submitting || busy || loading} onClick={() => { if (confirming) void generate(true); else if (status === "active") { setIssue(null); setConfirmation(context); } else void generate(false); }}>{submitting ? "正在生成…" : confirming ? "确认重置邀请码" : status === "active" ? <><RefreshCw size={14}/>重置邀请码</> : <><KeyRound size={14}/>生成学员邀请码</>}</button>}</div>
  </dialog>;
}
