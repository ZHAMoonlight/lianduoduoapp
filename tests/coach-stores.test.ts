import test from "node:test";
import assert from "node:assert/strict";
import { applyAction, assertInvariants, DomainError, getPersona, previewSchedule, projectWorkspace } from "../lib/domain";
import { coachServesStore, coachStoreIds, coachStoreNames } from "../lib/coach-stores";
import { schedulingOptions } from "../lib/scheduling";
import { authorizedCoachBillingFilter, buildCoachBillingReport, previewCoachBill, CoachBillingError } from "../lib/coach-billing";
import { createSeed } from "../lib/seed";
import { OperationError } from "../lib/operations";
import type { Coach, WorkspaceData } from "../lib/types";

const NOW=new Date("2026-10-29T02:00:00Z"),managerB={...getPersona("manager"),storeId:"s2"},coachB={...getPersona("coach"),storeId:"s2"};
function source():WorkspaceData{const data=createSeed(NOW);data.bookings=[];data.classes=[];data.ledger=[];data.audit=[];data.settlements=[];data.followups=[];data.feedback=[];data.cards.forEach(card=>card.frozen=0);return data;}
function attached(){return applyAction(source(),"hq","coach.store.attach",{coachId:"c1",storeId:"s2"},NOW);}
function rejects(run:()=>unknown,pattern:RegExp,status=403){assert.throws(run,error=>(error instanceof DomainError||error instanceof CoachBillingError||error instanceof OperationError)&&error.status===status&&pattern.test(error.message));}
function cls(storeId="s2",extra:Record<string,unknown>={}){return {name:"多店力量",type:"力量训练",storeId,coachId:"c1",startAt:"2026-10-30T10:00:00+08:00",endAt:"2026-10-30T11:00:00+08:00",capacity:6,credits:1,price:10000,room:"多店区域",...extra};}
const plan={mode:"recurring",name:"多店循环课",type:"力量训练",storeId:"s2",coachIds:["c1"],sharedRoom:false,startDate:"2026-10-30",endDate:"2026-10-30",weekdays:[5],startTime:"10:00",endTime:"11:00",capacity:6,credits:1,price:10000,room:"多店区域"};

test("门店helper兼容主店、规范并集和solo，坏storeIds不回退扩权",()=>{
  const data=source(),coach=data.coaches[0];assert.deepEqual(coachStoreIds(coach),["s1"]);assert.deepEqual(coachStoreIds({...coach,storeIds:["s2"]}),["s1","s2"]);assert.deepEqual(coachStoreNames(data,{...coach,storeIds:["s1","s2"]}),["静安旗舰店","徐汇滨江店"]);
  for(const storeIds of [[],undefined,null,["s1","s1"],[" s1"],[""]])assert.deepEqual(coachStoreIds({...coach,storeIds} as Coach),[]);
  assert.deepEqual(coachStoreIds({...coach,storeId:""}),[""]);assert.equal(coachServesStore({...coach,storeIds:["s2"]},"s2"),true);
  const bad=source();bad.coaches[0].storeIds=["s1","s4"];rejects(()=>assertInvariants(bad),/关联范围/,409);
});
test("同品牌挂靠只扩教练storeIds，不复制教练或修改主店；目标店manager可关联且幂等",()=>{
  const original=source(),result=applyAction(original,managerB,"coach.store.attach",{coachId:"c1",storeId:"s2"},NOW);assert.equal(result.coaches.length,original.coaches.length);assert.equal(result.coaches[0].storeId,"s1");assert.deepEqual(result.coaches[0].storeIds,["s1","s2"]);assert.equal(result.audit[0].storeId,"s2");assert.equal(Object.hasOwn(original.coaches[0],"storeIds"),false);
  const again=applyAction(result,managerB,"coach.store.attach",{coachId:"c1",storeId:"s2"},NOW);assert.deepEqual(again,result);
});
test("跨品牌角色越店solo未审核过期均不可关联，共享资质仍仅主店审核",()=>{
  for(const actor of ["coach","student","platform","manager"])rejects(()=>applyAction(source(),actor,"coach.store.attach",{coachId:"c1",storeId:"s2"},NOW),/无权|本门店/);
  rejects(()=>applyAction(source(),"hq","coach.store.attach",{coachId:"c1",storeId:"s4"},NOW),/品牌/);
  for(const change of [{status:"pending"},{certificateExpiresAt:"2026-10-28"},{certificateExpiresAt:"invalid"}]){const data=source();Object.assign(data.coaches[0],change);rejects(()=>applyAction(data,"hq","coach.store.attach",{coachId:"c1",storeId:"s2"},NOW),/资质/,400);}
  const solo=source();solo.tenants[0].mode="solo";rejects(()=>applyAction(solo,{...getPersona("hq"),coachId:"c1"},"coach.store.attach",{coachId:"c1",storeId:"s2"},NOW),/独立教练/);
  rejects(()=>applyAction(attached(),managerB,"coach.review",{id:"c1",approved:true},NOW),/本门店/);
});
test("挂靠店可单课循环排课和分配成员，未关联历史错误课次预约仍拒绝",()=>{
  const data=attached(),selection=schedulingOptions(data.coaches,{tenantId:"t1",storeId:"s2",type:"力量训练",date:"2026-10-30"});assert.ok(selection.available.some(coach=>coach.id==="c1"));
  const single=applyAction(data,"hq","class.create",cls(),NOW);assert.equal(single.classes[0].coachId,"c1");assert.equal(single.classes[0].storeId,"s2");
  const recurring=applyAction(data,coachB,"schedule.publish",plan,NOW);assert.equal(recurring.classes.length,1);assert.equal(recurring.classes[0].storeId,"s2");
  const member=applyAction(data,"hq","member.create",{name:"多店负责学员",phone:"13900009901",storeId:"s2",coachId:"c1"},NOW);assert.equal(member.members.at(-1)!.coachId,"c1");
  const invalid=source();invalid.classes=single.classes;rejects(()=>applyAction(invalid,"hq","booking.create",{memberId:"m3",cardId:"card3",classId:single.classes[0].id},NOW),/未关联/);
});
test("同一coach跨店时段全局冲突，不能绕过主店已有课且失败不部分发布",()=>{
  const data=applyAction(attached(),"hq","class.create",cls("s1"),NOW),before=structuredClone(data),preview=previewSchedule(data,coachB,plan,NOW);assert.equal(preview.conflicts.length,1);rejects(()=>applyAction(data,coachB,"schedule.publish",plan,NOW),/冲突/,409);rejects(()=>applyAction(data,"hq","class.create",cls(),NOW),/已有课程/,400);assert.deepEqual(data,before);
});
test("同coach切店后成员课包跟进反馈按当前店隔离，不因同coachId串店",()=>{
  let data=attached();data.members.find(member=>member.id==="m1")!.coachId="c1";data.members.find(member=>member.id==="m3")!.coachId="c1";data=applyAction(data,"hq","class.create",cls(),NOW);
  for(const [id,storeId,memberId] of [["a","s1","m1"],["b","s2","m3"]]){data.followups.push({id,tenantId:"t1",storeId,memberId,title:id,reason:"manual",status:"open",dueAt:"2026-11-01",assignee:"同一教练",assigneeCoachId:"c1",result:"",comments:[],createdAt:NOW.toISOString(),updatedAt:NOW.toISOString()});data.feedback.push({id,tenantId:"t1",storeId,bookingId:id,memberId,coachId:"c1",author:"同一教练",authorRole:"coach",content:id,rating:5,createdAt:NOW.toISOString()});}
  const b=projectWorkspace(data,coachB,1).data;assert.deepEqual(b.members.map(member=>member.id),["m3"]);assert.deepEqual(b.cards.map(card=>card.id),["card3"]);assert.deepEqual(b.followups.map(item=>item.id),["b"]);assert.deepEqual(b.feedback.map(item=>item.id),["b"]);assert.ok(b.coaches.some(coach=>coach.id==="c1"));
  rejects(()=>applyAction(data,coachB,"booking.create",{memberId:"m1",cardId:"card1",classId:data.classes[0].id},NOW),/授权学员/);rejects(()=>applyAction(data,coachB,"followup.comment",{id:"a",content:"越店"},NOW),/本门店/);
});
test("同coach的结算按实际授课店分账，当前B店身份不能读取A店报表",()=>{
  const data=attached();for(const [index,storeId,memberId,cardId] of [[0,"s1","m1","card1"],[1,"s2","m3","card3"]] as const){const id=`bill-class-${index}`,bookingId=`bill-booking-${index}`;data.classes.push({id,tenantId:"t1",storeId,coachId:"c1",name:"历史授课",type:"力量训练",startAt:`2026-10-28T${index?"12":"10"}:00:00+08:00`,endAt:`2026-10-28T${index?"13":"11"}:00:00+08:00`,capacity:1,credits:1,price:99999,room:"历史",status:"scheduled"});data.bookings.push({id:bookingId,tenantId:"t1",memberId,cardId,classId:id,status:"completed",credits:1,createdAt:"2026-10-27T00:00:00Z",completedAt:"2026-10-28T06:00:00Z"});}
  const filter=authorizedCoachBillingFilter(data,coachB,{dateFrom:"2026-10-01",dateTo:"2026-10-29"},NOW),report=buildCoachBillingReport(data,filter,NOW);assert.equal(report.rows.length,1);assert.equal(report.rows[0].storeId,"s2");rejects(()=>authorizedCoachBillingFilter(data,coachB,{storeId:"s1"},NOW),/本门店/);
  const preview=previewCoachBill(data,{...filter,rule:{type:"flat_session",sessionAmountCents:12345}},NOW);assert.equal(preview.storeId,"s2");assert.equal(preview.amountCents,12345);
});
