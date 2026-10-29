import type { Persona, WorkspaceData, ActionName, Card, FollowupOutcome } from "./types";
import { CardCourseError, normalizeCourseText, resolveCardCourses } from "./card-courses";
import { coachServesStore } from "./coach-stores";

export class OperationError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
function fail(message: string, status = 400): never { throw new OperationError(message, status); }
function id(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }
function str(p: Record<string, unknown>, key: string, max = 200): string { const v = typeof p[key] === "string" ? p[key].trim() : ""; if (!v || v.length > max) fail(`请填写有效的${({ name: "名称", phone: "联系电话", address: "地址", manager: "负责人", receipt: "线下核验凭证", reason: "处理原因", title: "标题", content: "内容", result: "跟进结果" } as Record<string,string>)[key] ?? key}（最多${max}字）。`); return v; }
function phone(p:Record<string,unknown>) { const value=str(p,"phone",25); if(!/^[+\d][\d\s-]{5,24}$/.test(value)) fail("请填写有效联系电话。"); return value; }
function date(p: Record<string,unknown>, key: string) { const v = str(p,key,10); if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)!==v) fail("请填写有效日期。"); return v; }
function integer(p: Record<string,unknown>, key: string, min: number, max: number) { const v = p[key]; if (typeof v !== "number" || !Number.isSafeInteger(v) || v<min || v>max) fail(`${key}须为${min}至${max}的整数。`); return v; }
function optionalReceipt(p: Record<string, unknown>): string {
  if (p.receipt === undefined) return "";
  if (typeof p.receipt !== "string" || p.receipt.trim().length > 200) fail("线下收款凭证编号须为最多200字的文本，可留空。");
  return p.receipt.trim();
}
function receiptAttachmentIds(p: Record<string, unknown>): string[] {
  if (p.receiptAttachmentIds === undefined) return [];
  const ids = p.receiptAttachmentIds;
  if (!Array.isArray(ids) || ids.length > 3 || ids.some(value => typeof value !== "string" || !/^receipt-[A-Za-z0-9_-]{1,100}$/.test(value)) || new Set(ids).size !== ids.length) fail("请提供最多3个不重复的有效凭证附件ID。");
  // 这里只检查结构；附件存在、归属和订单关联须由存储事务校验。
  return [...ids];
}
function find<T extends {id:string}>(list:T[], key:unknown, label:string):T { const x=list.find(v=>v.id===key); if(!x) fail(`${label}不存在。`,404); return x; }
function scope(persona:Persona, tenantId:string, storeId?:string) { if(persona.role!=="platform" && persona.tenantId!==tenantId) fail("无权操作其他品牌的数据。",403); if((persona.role==="manager"||persona.role==="coach") && storeId && persona.storeId!==storeId) fail("当前身份只能操作本门店。",403); }
function day(now:Date) { return new Date(now.getTime()+8*3600000).toISOString().slice(0,10); }
function audit(data:WorkspaceData, persona:Persona, action:ActionName, detail:string, now:Date, storeId?:string,tenantId=persona.tenantId) { data.audit.unshift({id:id("audit"),tenantId,storeId,actor:persona.name,actorId:persona.userId,action,detail,createdAt:now.toISOString()}); }

function assignedCoach(data:WorkspaceData, value:unknown, tenantId:string, storeId:string) {
  if(value === undefined || value === "" || value === null) return undefined;
  const coach=data.coaches.find(c=>c.id===value&&c.tenantId===tenantId&&coachServesStore(c,storeId)&&c.status==="approved");
  if(!coach) fail("负责教练须为同品牌同门店已审核通过的教练。",403);
  return coach;
}
export const EXTRA_PERMISSIONS: Record<string,string[]> = {
  platform:["store.create","store.update","account.create"],
  hq:["store.create","store.update","member.create","member.update","account.create","card.issue","card.renew","order.refund","class.cancel","booking.no_show","booking.latecancel","followup.generate","followup.create","followup.update","followup.comment","followup.close","training.feedback"],
  manager:["store.update","member.create","member.update","account.create","card.issue","card.renew","order.refund","class.cancel","booking.no_show","booking.latecancel","followup.generate","followup.create","followup.update","followup.comment","followup.close","training.feedback"],
  coach:["training.feedback","followup.update","followup.comment","followup.close"], student:["training.feedback"],
};

export function executeExtended(data: WorkspaceData, persona: Persona, action: ActionName, p:Record<string,unknown>, now:Date): boolean {
  const stamp=now.toISOString(), today=day(now),solo=data.tenants.some(t=>t.id===persona.tenantId&&t.mode==="solo");
  switch(action) {
    case "store.create": {
      const tenantId=persona.tenantId ?? str(p,"tenantId"); find(data.tenants,tenantId,"品牌"); scope(persona,tenantId);
      const name=str(p,"name",60); if(data.stores.some(s=>s.tenantId===tenantId&&s.name===name)) fail("该品牌已有同名门店。");
      data.stores.push({id:id("store"),tenantId,name,address:str(p,"address"),manager:str(p,"manager",30),phone:phone(p),status:"active"}); audit(data,persona,action,`创建门店「${name}」`,now,undefined,tenantId); return true;
    }
    case "store.update": {
      const store=find(data.stores,p.id,"门店"); scope(persona,store.tenantId,store.id);
      for(const key of ["name","address","manager","phone"] as const) if(p[key]!==undefined) store[key]=key==="phone"?phone(p):str(p,key);
      if(p.status!==undefined) { if(!["active","inactive"].includes(String(p.status))) fail("门店状态无效。"); if(p.status==="inactive"&&data.classes.some(c=>c.storeId===store.id&&c.status==="scheduled"&&Date.parse(c.endAt)>now.getTime())) fail("请先取消未来课程，再停用门店。"); store.status=p.status as "active"; }
      audit(data,persona,action,`更新门店「${store.name}」`,now,store.id,store.tenantId); return true;
    }
    case "member.create": {
      const store=solo?undefined:find(data.stores,p.storeId,"门店"),tenantId=solo?persona.tenantId!:store!.tenantId,storeId=store?.id??""; scope(persona,tenantId,storeId); const name=str(p,"name",30), telephone=phone(p);
      if(data.members.some(m=>m.tenantId===tenantId&&m.phone===telephone&&m.name===name)) fail("同名同手机号学员已存在，请勿重复建档。");
      const coach=assignedCoach(data,solo?(p.coachId||persona.coachId):p.coachId,tenantId,storeId);
      data.members.push({id:id("member"),tenantId,storeId,name,phone:telephone,joinedAt:stamp,avatar:name.slice(0,1),coachId:coach?.id}); audit(data,persona,action,`建立学员「${name}」档案`,now,storeId); return true;
    }
    case "member.update": {
      const member=find(data.members,p.id,"学员"); scope(persona,member.tenantId,member.storeId);
      if(p.name!==undefined) {member.name=str(p,"name",30);member.avatar=member.name.slice(0,1);} if(p.phone!==undefined) member.phone=phone(p);
      if(Object.hasOwn(p,"coachId"))member.coachId=assignedCoach(data,solo?(p.coachId||persona.coachId):p.coachId,member.tenantId,member.storeId)?.id;
      audit(data,persona,action,`更新学员「${member.name}」档案`,now,member.storeId); return true;
    }
    case "card.issue": case "card.renew": {
      const previous=action==="card.renew"?find(data.cards,p.id,"原课卡"):undefined;
      const member=find(data.members,previous?.memberId??p.memberId,"学员"), store=solo?undefined:find(data.stores,previous?.storeId??p.storeId,"售卡门店"),storeId=store?.id??"",storeTenant=store?.tenantId??persona.tenantId; scope(persona,member.tenantId,storeId);
      if(persona.role==="manager"&&member.storeId!==persona.storeId) fail("仅能为本店归属学员开卡或续卡。",403);
      if(storeTenant!==member.tenantId || (store&&store.status!=="active")) fail("售卡门店不适用该学员。");
      if(p.scope!=="all"&&p.scope!=="home") fail("请选择课卡适用范围。");
      if(Object.hasOwn(p,"courseRules")) fail("课程适用范围须从已创建课程中选择，不能自行指定课程快照。",403);
      if(Object.hasOwn(p,"courseMode")) fail("课程适用模式由课程选择自动生成，不能自行指定。",403);
      let courseRules: Card["courseRules"], courseMode: Card["courseMode"], classTypes: string[];
      if(p.courseIds!==undefined){
        let resolved: ReturnType<typeof resolveCardCourses>;
        try{resolved=resolveCardCourses(data,{tenantId:member.tenantId,storeId,scope:p.scope},p.courseIds);}catch(error){if(error instanceof CardCourseError)fail(error.message,error.status);throw error;}
        courseMode=resolved.courseMode;courseRules=resolved.courseRules;classTypes=resolved.classTypes;
        if(p.classTypes!==undefined){
          if(!Array.isArray(p.classTypes)||p.classTypes.length>20||p.classTypes.some(value=>typeof value!=="string"||!value.trim()||value.length>40))fail("课程选择与科目信息不一致，请刷新后重新选择课程。");
          const supplied=[...new Set((p.classTypes as string[]).map(normalizeCourseText))].sort();
          const derived=[...new Set(classTypes.map(normalizeCourseText))].sort();
          if(supplied.length!==derived.length||supplied.some((value,index)=>value!==derived[index]))fail("课程选择与科目信息不一致，请刷新后重新选择课程。");
        }
      }else{
        if(previous&&(previous.courseMode==="selected"||Object.hasOwn(previous,"courseRules")))fail("这张课卡按指定课程适用，续购时请重新选择课程或明确清空为全部适用，不能退回科目范围。");
        if(p.classTypes===undefined){courseMode="all";classTypes=[];}
        else{
          if(!Array.isArray(p.classTypes)||!p.classTypes.length||p.classTypes.length>20||p.classTypes.some(value=>typeof value!=="string"||!value.trim()||value.length>40))fail("旧客户端需填写有效适用科目，或明确以空课程选择全部适用。");
          classTypes=(p.classTypes as string[]).map(value=>value.trim());
        }
      }
      const total=integer(p,"total",1,10000), amount=integer(p,"amount",1,100000000),expiresAt=date(p,"expiresAt"); if(expiresAt<today) fail("课卡有效期不能早于今天。"); const receipt=optionalReceipt(p), attachmentIds=receiptAttachmentIds(p);
      if(receipt&&data.orders.some(o=>o.tenantId===storeTenant&&o.receipt===receipt)) fail("该线下收款凭证已登记，请勿重复开卡。");
      const cardId=id("card"),orderId=id("order"); const card:Card={id:cardId,tenantId:member.tenantId,memberId:member.id,storeId,name:str(p,"name",60),total,remaining:total,frozen:0,expiresAt,scope:p.scope,classTypes,...(courseMode?{courseMode}:{}),...(courseRules?{courseRules}:{}),status:"active",unitValueCents:Math.floor(amount/total),orderId};
      data.cards.unshift(card); data.orders.unshift({id:orderId,tenantId:member.tenantId,storeId,memberId:member.id,cardId,amount,receipt,...(attachmentIds.length?{receiptAttachmentIds:attachmentIds}:{}),status:"paid",createdAt:stamp}); audit(data,persona,action,`${member.name}${previous?"续购新卡":"开卡"}，登记线下收款${receipt?`，凭证 ${receipt}`:""}${attachmentIds.length?`，${attachmentIds.length}个凭证附件`:""}`,now,storeId); return true;
    }
    case "order.refund": {
      const order=find(data.orders,p.id,"订单"); scope(persona,order.tenantId,order.storeId); if(order.status==="refunded") return true; const card=find(data.cards,order.cardId,"课卡");
      if(card.frozen!==0||card.remaining!==card.total||data.bookings.some(b=>b.cardId===card.id&&["completed","checked_in","reserved"].includes(b.status))) fail("仅无消课、无冻结课时的完整课包可以全额退款。");
      const receipt=str(p,"receipt",200),reason=str(p,"reason",500); order.status="refunded";order.refundedAt=stamp;order.refundReceipt=receipt;card.status="refunded";card.remaining=0; audit(data,persona,action,`登记线下全额退款 ${(order.amount/100).toFixed(2)} 元，凭证 ${receipt}；${reason}`,now,order.storeId); return true;
    }
    case "class.cancel": {
      const cls=find(data.classes,p.id,"课程"); scope(persona,cls.tenantId,cls.storeId); if(cls.status==="cancelled") return true; const reason=str(p,"reason",500);
      if(Date.parse(cls.startAt)<=now.getTime()||data.bookings.some(b=>b.classId===cls.id&&["checked_in","completed"].includes(b.status))) fail("已开课或已有签到履约的课程不能取消。");
      cls.status="cancelled"; for(const booking of data.bookings.filter(b=>b.classId===cls.id&&b.status==="reserved")){ const card=find(data.cards,booking.cardId,"课卡");card.frozen-=booking.credits;booking.status="cancelled";booking.cancelledAt=stamp; }
      audit(data,persona,action,`取消课程「${cls.name}」并释放预约课时：${reason}`,now,cls.storeId);return true;
    }
    case "booking.no_show": case "booking.latecancel": {
      const booking=find(data.bookings,p.id,"预约"),cls=find(data.classes,booking.classId,"课程");scope(persona,booking.tenantId,cls.storeId); const target=action==="booking.no_show"?"no_show":"late_cancelled"; if(booking.status===target)return true;
      if(booking.status!=="reserved")fail("仅未签到的有效预约可登记缺席或迟取消。");const reason=str(p,"reason",500);
      if(action==="booking.no_show"&&now.getTime()<Date.parse(cls.endAt))fail("课程结束后才能登记未到店。");
      if(action==="booking.latecancel"&&(now.getTime()<Date.parse(cls.startAt)-3600000||now.getTime()>Date.parse(cls.endAt)))fail("迟取消仅限开课前60分钟至课程结束。");
      find(data.cards,booking.cardId,"课卡").frozen-=booking.credits;booking.status=target;booking.cancelledAt=stamp;
      audit(data,persona,action,`${target==="no_show"?"登记未到店":"批准迟取消"}，释放${booking.credits}课时；${reason}`,now,cls.storeId);return true;
    }
    case "followup.generate": {
      const stores=data.stores.filter(s=>s.tenantId===persona.tenantId&&(!p.storeId||p.storeId===s.id)&&(persona.role!=="manager"||s.id===persona.storeId));
      if(p.storeId&&!stores.length)fail("无权为该门店生成跟进。",403);
      for(const member of data.members.filter(m=>solo?m.tenantId===persona.tenantId:stores.some(s=>s.id===m.storeId))){ const cards=data.cards.filter(c=>c.memberId===member.id&&c.status==="active"); const last=data.bookings.filter(b=>b.memberId===member.id&&b.completedAt).map(b=>Date.parse(b.completedAt!)).sort((a,b)=>b-a)[0]; const reason=cards.some(c=>c.remaining-c.frozen<=3)?"low_balance":cards.some(c=>c.expiresAt<=day(new Date(now.getTime()+14*86400000)))?"expiring":last&&now.getTime()-last>=30*86400000&&!data.bookings.some(b=>b.memberId===member.id&&["reserved","checked_in"].includes(b.status)&&data.classes.some(c=>c.id===b.classId&&Date.parse(c.endAt)>now.getTime()))?"inactive":null;
        if(!reason||data.followups.some(f=>f.memberId===member.id&&f.reason===reason&&f.status!=="closed"))continue;
        data.followups.unshift({id:id("followup"),tenantId:member.tenantId,storeId:member.storeId,memberId:member.id,title:`${member.name} · ${{low_balance:"课时余额关怀",expiring:"课卡到期提醒",inactive:"长期未到店回访"}[reason]}`,reason,status:"open",dueAt:today,assignee:data.coaches.find(c=>c.id===member.coachId)?.name??persona.name,assigneeCoachId:member.coachId,result:"",comments:[],createdAt:stamp,updatedAt:stamp}); }
      audit(data,persona,action,"按低余额、14天内到期、30天未到店规则生成去重跟进",now,persona.storeId);return true;
    }
    case "followup.create": {
      const member=find(data.members,p.memberId,"学员");scope(persona,member.tenantId,member.storeId);const dueAt=date(p,"dueAt"),coach=assignedCoach(data,solo?(p.assigneeCoachId||persona.coachId):(Object.hasOwn(p,"assigneeCoachId")?p.assigneeCoachId:member.coachId),member.tenantId,member.storeId);
      data.followups.unshift({id:id("followup"),tenantId:member.tenantId,storeId:member.storeId,memberId:member.id,title:str(p,"title",100),reason:"manual",status:"open",dueAt,assignee:coach?.name??(typeof p.assignee==="string"?p.assignee.slice(0,60):persona.name),assigneeCoachId:coach?.id,result:"",comments:[],createdAt:stamp,updatedAt:stamp});audit(data,persona,action,"创建学员跟进",now,member.storeId);return true;
    }
    case "followup.update":case "followup.comment":case "followup.close":{
      const followup=find(data.followups,p.id,"跟进任务");scope(persona,followup.tenantId,followup.storeId);
      if(persona.role==="coach"&&followup.assigneeCoachId!==persona.coachId)fail("只能处理明确分配给自己的学员跟进。",403);
      if(persona.role==="coach"&&action==="followup.update"&&["title","assignee","assigneeCoachId","memberId","storeId"].some(key=>Object.hasOwn(p,key)))fail("教练只能更新跟进状态和截止日期，不能修改负责人或任务内容。",403);
      if(followup.status==="closed")fail("该跟进已结案，不能再修改。");
      if(action==="followup.update"){if(p.title!==undefined)followup.title=str(p,"title",100);if(p.dueAt!==undefined)followup.dueAt=date(p,"dueAt");if(p.assignee!==undefined)followup.assignee=str(p,"assignee",60);if(Object.hasOwn(p,"assigneeCoachId")){const coach=assignedCoach(data,solo?(p.assigneeCoachId||persona.coachId):p.assigneeCoachId,followup.tenantId,followup.storeId);followup.assigneeCoachId=coach?.id;followup.assignee=coach?.name??(typeof p.assignee==="string"?p.assignee.slice(0,60):"未分配教练");}if(p.status!==undefined){if(!["open","contacted"].includes(String(p.status)))fail("跟进状态无效。");followup.status=p.status as "open";}}
      if(action==="followup.comment")followup.comments.push({id:id("comment"),author:persona.name,content:str(p,"content",2000),createdAt:stamp});
      if(action==="followup.close"){
        const outcome=p.outcome??"other";if(!["resumed","renewed","paused","declined","other"].includes(String(outcome)))fail("请选择有效的跟进结果类型。");
        if(outcome==="renewed"){
          if(typeof p.renewalOrderId!=="string"||!p.renewalOrderId)fail("请选择跟进创建后该学员的真实已付款续费订单。");
          const order=find(data.orders,p.renewalOrderId,"续费订单");
          if(order.memberId!==followup.memberId||order.tenantId!==followup.tenantId||order.status!=="paid"||Date.parse(order.createdAt)<Date.parse(followup.createdAt))fail("续费结案须引用跟进创建后该学员的有效已付款订单，不能仅凭文字确认成交。");
          followup.renewalOrderId=order.id;
        }else if(p.renewalOrderId)fail("只有续费结案可以关联续费订单。");
        followup.outcome=outcome as FollowupOutcome;followup.result=str(p,"result",2000);followup.status="closed";
      }followup.updatedAt=stamp;audit(data,persona,action,`更新跟进「${followup.title}」`,now,followup.storeId);return true;
    }
    case "training.feedback":{
      const booking=find(data.bookings,p.bookingId,"预约"),cls=find(data.classes,booking.classId,"课程");scope(persona,booking.tenantId,persona.role==="student"?undefined:cls.storeId);
      if(persona.role==="coach"&&persona.coachId!==cls.coachId)fail("只能填写自己授课的反馈。",403);
      if(persona.role==="student"&&!(persona.memberIds??[persona.memberId]).includes(booking.memberId))fail("只能评价本人及绑定孩子的课程。",403);
      if(booking.status!=="completed")fail("课程完成后才能填写训练反馈。");
      data.feedback.unshift({id:id("feedback"),tenantId:booking.tenantId,storeId:cls.storeId,bookingId:booking.id,memberId:booking.memberId,coachId:cls.coachId,author:persona.name,authorRole:persona.role,content:str(p,"content",2000),rating:integer(p,"rating",1,5),createdAt:stamp});audit(data,persona,action,"记录课后训练反馈",now,cls.storeId);return true;
    }
    case "account.create":fail("登录账号必须由账号服务创建。");
    default:return false;
  }
}

export function appendLedger(before:WorkspaceData,after:WorkspaceData,action:string,p:Record<string,unknown>,now:Date){
  for(const card of after.cards){const prev=before.cards.find(c=>c.id===card.id);if(prev&&prev.remaining===card.remaining&&prev.frozen===card.frozen)continue;
    const order=after.orders.find(o=>o.cardId===card.id);let type:"issue"|"freeze"|"release"|"consume"|"refund"="issue",credits=card.total,amount=order?.amount??0;
    if(prev){if(card.status==="refunded"){type="refund";credits=prev.remaining;amount=-(order?.amount??0);}else if(card.remaining<prev.remaining){type="consume";credits=prev.remaining-card.remaining;amount=-(order?Math.floor((card.total-card.remaining)*order.amount/card.total)-Math.floor((card.total-prev.remaining)*order.amount/card.total):credits*card.unitValueCents);}else if(card.frozen>prev.frozen){type="freeze";credits=card.frozen-prev.frozen;amount=0;}else{type="release";credits=prev.frozen-card.frozen;amount=0;}}
    after.ledger.push({id:id("ledger"),tenantId:card.tenantId,storeId:card.storeId,cardId:card.id,memberId:card.memberId,bookingId:action.startsWith("booking.")&&action!=="booking.create"?String(p.id):undefined,type,credits,remaining:card.remaining,frozen:card.frozen,amount,note:action,createdAt:now.toISOString()}); }
}
