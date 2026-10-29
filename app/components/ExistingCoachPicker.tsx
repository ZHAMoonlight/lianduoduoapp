"use client";

import { useEffect, useRef, useState } from "react";
import { Check, MapPin, RefreshCw, Search, ShieldCheck, UserPlus, X } from "lucide-react";
import type { ActionName, Persona } from "@/lib/types";
import { requestJSON } from "./AuthGate";
import "./existing-coach-picker.css";

type Candidate = { id: string; name: string; specialty: string; phoneMasked: string; certificateExpiresAt: string; storeNames: string[] };
type Props = { persona: Persona; storeId: string; storeName: string; busy: boolean; act: (action: ActionName, payload: Record<string, unknown>, onError?: (message: string) => void) => Promise<boolean>; onClose: () => void };
function validCandidate(value: Candidate) { return value && typeof value.id === "string" && !!value.id && typeof value.name === "string" && !!value.name && typeof value.specialty === "string" && typeof value.phoneMasked === "string" && (!value.phoneMasked || value.phoneMasked.includes("*")) && typeof value.certificateExpiresAt === "string" && Array.isArray(value.storeNames) && value.storeNames.every(name => typeof name === "string"); }

export function ExistingCoachPicker({ persona, storeId, storeName, busy, act, onClose }: Props) {
  const allowed = persona.workspaceMode !== "solo" && ["hq", "manager"].includes(persona.role) && !!storeId && (persona.role !== "manager" || persona.storeId === storeId);
  const context = JSON.stringify([persona.userId, persona.membershipId, persona.tenantId, persona.role, storeId, allowed]);
  const [retry, setRetry] = useState(0), [selectedId, setSelectedId] = useState(""), [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<{ key: string; coaches: Candidate[] } | null>(null), [issue, setIssue] = useState<{ key: string; text: string } | null>(null), [postingKey, setPostingKey] = useState<string | null>(null);
  const key = `${context}:${retry}`, candidates = snapshot?.key === key ? snapshot.coaches : null;
  const error = issue?.key === key ? issue.text : "", posting = postingKey === key, loading = allowed && !candidates && !error;
  const chosen = candidates?.find(item => item.id === selectedId), filtered = candidates?.filter(item => `${item.name} ${item.specialty} ${item.phoneMasked} ${item.storeNames.join(" ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) || [];
  const modal = useRef<HTMLDialogElement>(null), epoch = useRef(0), submitting = useRef(false);
  useEffect(() => { if (!allowed) return; const element = modal.current; element?.showModal(); return () => element?.close(); }, [allowed, context]);
  useEffect(() => {
    if (!allowed) return;
    const serial = ++epoch.current, controller = new AbortController();
    requestJSON<{ coaches: Candidate[] }>(`/api/coach-candidates?${new URLSearchParams({ storeId })}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || serial !== epoch.current) return;
      if (!Array.isArray(result.coaches) || result.coaches.some(item => !validCandidate(item)) || new Set(result.coaches.map(item => item.id)).size !== result.coaches.length) throw new Error("教练列表返回不完整，请重新读取。");
      setSnapshot({ key, coaches: result.coaches });
    }).catch(error => { if (!controller.signal.aborted && serial === epoch.current) setIssue({ key, text: error instanceof Error ? error.message : "读取教练列表失败。" }); });
    return () => { epoch.current += 1; controller.abort(); submitting.current = false; };
  }, [allowed, key, storeId]);

  async function attach() {
    if (!allowed || busy || submitting.current || !chosen || loading) return;
    const serial = epoch.current, coachId = chosen.id;
    submitting.current = true; setPostingKey(key); setIssue(null);
    try {
      let message = "";
      if (await act("coach.store.attach", { coachId, storeId }, detail => { message = detail; })) { if (serial === epoch.current) onClose(); }
      else if (serial === epoch.current) setIssue({ key, text: message || "尚未关联成功，请核对页面提示。资质或门店状态变化时，可重新读取教练列表。" });
    } catch (error) { if (serial === epoch.current) setIssue({ key, text: error instanceof Error ? error.message : "关联未完成，请重试。" }); }
    finally { if (serial === epoch.current) { submitting.current = false; setPostingKey(null); } }
  }
  if (!allowed) return null;
  return <dialog className="existing-coach-dialog" ref={modal} aria-labelledby="existing-coach-title" onCancel={event => { if (posting || busy) event.preventDefault(); else onClose(); }} onClick={event => { if (event.target === event.currentTarget && !posting && !busy) onClose(); }}>
    <div className="ec-header"><div><span>ONE COACH, MORE CONNECTIONS</span><h2 id="existing-coach-title">添加已有教练</h2></div><button type="button" disabled={posting || busy} aria-label="关闭添加已有教练" onClick={onClose}><X size={19}/></button></div>
    <div className="ec-body"><div className="ec-destination"><span><MapPin size={18}/></span><div><small>关联到当前门店</small><strong>{storeName}</strong></div><span className="ec-brand-note">同品牌教练</span></div><p className="ec-intro">选择品牌内已通过审核的教练，共用原来的档案与资质。关联后，本店即可为这位教练排课、分配学员和核对授课账单。</p>
      <div className="ec-toolbar"><label><Search size={15}/><input aria-label="搜索已有教练" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索教练、科目或门店" disabled={posting || busy}/></label><button type="button" aria-label="重新读取教练列表" title="重新读取教练列表" disabled={loading || posting || busy} onClick={() => { setSelectedId(""); setIssue(null); setRetry(value => value + 1); }}><RefreshCw size={16}/></button></div>
      {loading ? <div className="ec-empty">正在读取可关联的教练…</div> : candidates && !candidates.length ? <div className="ec-empty"><UserPlus size={29}/><h3>还没有可关联的教练</h3><p>只显示资质有效且尚未加入本店的品牌教练。首次加入品牌的教练，请使用「新增教练档案」。</p></div> : candidates && !filtered.length ? <div className="ec-empty">没有找到匹配的教练，试试其他姓名或科目。</div> : <div className="ec-candidates">{filtered.map(item => <button type="button" key={item.id} className={`ec-candidate ${item.id === chosen?.id ? "selected" : ""}`} aria-pressed={item.id === chosen?.id} disabled={posting || busy} onClick={() => { setSelectedId(item.id); setIssue(null); }}><span className="ec-avatar">{item.name.slice(-1)}</span><span className="ec-candidate-copy"><span className="ec-candidate-name">{item.name}<small>{item.phoneMasked}</small></span><span className="ec-specialty">{item.specialty}</span><span className="ec-store-names">已服务：{item.storeNames.join("、") || "品牌内其他门店"}</span><span className="ec-certificate">资质有效至 {item.certificateExpiresAt}</span></span><span className="ec-radio">{item.id === chosen?.id && <Check size={12}/>}</span></button>)}</div>}
      <p className="ec-note"><ShieldCheck size={16}/><span>已关联微信的教练会自动获得本店工作身份；尚未绑定微信的教练，可使用本店团队码加入。排课会统一检查跨店时间冲突。</span></p>{error && <p className="ec-error" role="alert">{error}</p>}
    </div>
    <div className="ec-footer"><p>{chosen ? <>将 <strong>{chosen.name}</strong> 关联到 <strong>{storeName}</strong></> : "每次选择一位教练"}</p><div><button type="button" disabled={posting || busy} onClick={onClose}>取消</button><button type="button" className="ec-primary" disabled={posting || busy || !chosen} onClick={() => void attach()}>{posting ? "正在关联…" : "确认关联到本店"}</button></div></div>
  </dialog>;
}
