import assert from "node:assert/strict";
import test from "node:test";
import { applyAction, DomainError, getPersona, projectWorkspace } from "../lib/domain";
import { createSeed } from "../lib/seed";
import type { WorkspaceData } from "../lib/types";

const NOW = new Date("2026-10-29T02:00:00Z");
function fixture(): WorkspaceData {
  const data = createSeed(NOW);data.cards.forEach(card => { card.frozen=0;card.classTypes=["力量训练"];card.orderId=`private-order-${card.id}`; });
  data.bookings=[];data.ledger=[];data.audit=[];data.settlements=[];data.members.find(member=>member.id==="m1")!.coachId="c1";
  const cls=data.classes.find(item=>item.id==="cls-1")!;data.classes=[cls,{...cls,id:"other-coach",coachId:"c3"},{...cls,id:"other-store",storeId:"s2",coachId:"c2"}];
  data.bookings.push({id:"past-visit",tenantId:"t1",memberId:"m3",classId:cls.id,cardId:"card3",status:"cancelled",credits:1,createdAt:NOW.toISOString(),cancelledAt:NOW.toISOString()});
  data.followups=[{id:"assigned-followup",tenantId:"t1",storeId:"s1",memberId:"m2",title:"明确分配给本人",reason:"manual",status:"open",dueAt:"2026-11-01",assignee:"李昊",assigneeCoachId:"c1",result:"",comments:[],createdAt:NOW.toISOString(),updatedAt:NOW.toISOString()}];
  return data;
}
function reserve(data:WorkspaceData,memberId="m1",cardId="card1",classId="cls-1"){return applyAction(data,"coach","booking.create",{memberId,cardId,classId,coachId:classId==="cls-1"?"c1":undefined},NOW);}
function rejects(run:()=>unknown,pattern:RegExp,status=403){assert.throws(run,error=>error instanceof DomainError&&error.status===status&&pattern.test(error.message));}

test("教练代约投影与成员授权一致，仅给已授权学员的使用权益白名单",()=>{
  const data=fixture(),before=structuredClone(data),w=projectWorkspace(data,"coach",1).data;
  assert.deepEqual(new Set(w.members.map(member=>member.id)),new Set(["m1","m2","m3"]));assert.deepEqual(new Set(w.cards.map(card=>card.id)),new Set(["card1","card2","card3"]));
  for(const card of w.cards){assert.equal(Object.hasOwn(card,"unitValueCents"),false);assert.equal(Object.hasOwn(card,"orderId"),false);assert.equal(card.remaining,data.cards.find(item=>item.id===card.id)!.remaining);}
  for(const key of ["orders","ledger","settlements","audit","accounts"] as const)assert.deepEqual(w[key],[]);
  assert.deepEqual(data,before);assert.ok(data.cards[0].unitValueCents>0);
  w.cards[0].classTypes.push("不可污染源数据");assert.deepEqual(data,before);
  const malformed=projectWorkspace(data,{...getPersona("coach"),coachId:undefined},1).data;assert.deepEqual(malformed.members,[]);assert.deepEqual(malformed.cards,[]);
});

test("本人负责、本人课程到访和明确跟进学员均可代约，重复请求不重复冻结",()=>{
  for(const [memberId,cardId] of [["m1","card1"],["m2","card2"],["m3","card3"]]){
    const data=fixture(),result=reserve(data,memberId,cardId),card=result.cards.find(item=>item.id===cardId)!;assert.equal(card.frozen,1);
    const again=reserve(result,memberId,cardId);assert.deepEqual(again.bookings,result.bookings);assert.deepEqual(again.ledger,result.ledger);assert.equal(again.cards.find(item=>item.id===cardId)!.frozen,1);
  }
});

test("同店未授权成员、他人课卡、其他教练或门店课程不能用猜测ID代约",()=>{
  const source=fixture(),before=structuredClone(source);
  rejects(()=>reserve(source,"m4","card4"),/授权学员/);rejects(()=>reserve(source,"m1","card4"),/不属于/);
  rejects(()=>reserve(source,"m1","card1","other-coach"),/自己的课程/);rejects(()=>reserve(source,"m1","card1","other-store"),/本门店/);
  rejects(()=>reserve(source,"m5","card1"),/品牌/);assert.deepEqual(source,before);
});

test("退款冻结到期课包、课程精确范围和跨店home规则仍严格检验",()=>{
  for(const status of ["refunded","frozen"] as const){const data=fixture();data.cards[0].status=status;rejects(()=>reserve(data),/冻结/,400);}
  const expired=fixture();expired.cards[0].expiresAt="2026-10-29";rejects(()=>reserve(expired),/过期/,400);
  const empty=fixture();empty.cards[0].remaining=0;rejects(()=>reserve(empty),/课时不足/,400);
  const exact=fixture();exact.cards[0].courseMode="selected";exact.cards[0].courseRules=[{name:"另一个名称",type:"力量训练"}];rejects(()=>reserve(exact),/不适用于/,400);
  const home=fixture();home.cards.find(card=>card.id==="card3")!.scope="home";assert.ok(!projectWorkspace(home,"coach",1).data.cards.some(card=>card.id==="card3"));rejects(()=>reserve(home,"m3","card3"),/开卡门店/,400);
});

test("本人课程早取消原样释放课时且幂等，其他教练与60分钟边界仍拒绝",()=>{
  const reserved=reserve(fixture()),booking=reserved.bookings.find(item=>item.status==="reserved")!;
  const cancelled=applyAction(reserved,"coach","booking.cancel",{id:booking.id},NOW);assert.equal(cancelled.cards[0].frozen,0);assert.equal(cancelled.bookings.find(item=>item.id===booking.id)!.status,"cancelled");
  const again=applyAction(cancelled,"coach","booking.cancel",{id:booking.id},NOW);assert.deepEqual(again.ledger,cancelled.ledger);
  rejects(()=>applyAction(reserved,{...getPersona("coach"),coachId:"c3"},"booking.cancel",{id:booking.id},NOW),/自己的课程/);
  const starts=Date.parse(reserved.classes[0].startAt);rejects(()=>applyAction(reserved,"coach","booking.cancel",{id:booking.id},new Date(starts-3600000)),/60 分钟/,400);
});

test("代约权限不增加建档开卡和单节排课等机构管理权限",()=>{
  for(const action of ["member.create","card.issue","card.renew","class.create","order.refund"])rejects(()=>applyAction(fixture(),"coach",action,{},NOW),/无权/);
});
