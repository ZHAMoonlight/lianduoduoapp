import assert from "node:assert/strict";
import test from "node:test";
import { applyAction, assertInvariants, DomainError, getPersona, previewSchedule, projectWorkspace } from "../lib/domain";
import { createSeed } from "../lib/seed";
import type { Persona, SchedulePlanPublishPayload, WorkspaceData } from "../lib/types";

const NOW = new Date("2026-10-28T02:00:00Z");
function fixture(): WorkspaceData {
  const data = createSeed(NOW);data.classes=[];data.bookings=[];data.settlements=[];data.ledger=[];data.audit=[];
  for (const card of data.cards) card.frozen=0;
  return data;
}
function payload(overrides: Partial<SchedulePlanPublishPayload> = {}): SchedulePlanPublishPayload {
  return {mode:"recurring",name:"每周力量课",type:"力量训练",storeId:"s1",coachId:"c1",startDate:"2026-10-29",endDate:"2026-11-12",weekdays:[4],startTime:"10:00",endTime:"11:00",capacity:8,credits:1,price:19800,room:"A区",...overrides};
}
function availability(overrides: Partial<SchedulePlanPublishPayload> = {}) { return payload({mode:"availability",name:"私教可约时间",startDate:"2026-10-29",endDate:"2026-10-29",startTime:"09:00",endTime:"12:00",capacity:1,durationMinutes:60,gapMinutes:15,...overrides}); }
function publish(data: WorkspaceData, p = payload(), persona: Persona | string = "hq") { return applyAction(data,persona,"schedule.publish",p,NOW); }
function rejects(fn: () => unknown, message: RegExp, status = 400) { assert.throws(fn,(error: unknown) => error instanceof DomainError && error.status===status && message.test(error.message)); }
const memberFour: Persona = {...getPersona("student"),memberId:"m4",memberIds:["m4"]};

test("每周循环规则生成具体未来课次，预览不改变原数据且上海时区准确", () => {
  const data=fixture(),before=structuredClone(data),preview=previewSchedule(data,"hq",payload(),NOW);
  assert.equal(preview.mode,"recurring");assert.equal(preview.occurrenceCount,3);assert.equal(preview.slotCount,3);assert.deepEqual(preview.conflicts,[]);
  assert.deepEqual(preview.items.map(item=>item.date),["2026-10-29","2026-11-05","2026-11-12"]);assert.equal(preview.items[0].startAt,"2026-10-29T02:00:00.000Z");assert.deepEqual(data,before);
  const result=publish(data);assert.equal(result.schedulePlans?.length,1);assert.equal(result.classes.length,3);
  assert.ok(result.classes.every(item=>item.schedulePlanId===result.schedulePlans![0].id&&item.bookingMode==="recurring"&&item.capacity===8));assertInvariants(result);
});

test("开放空闲区间按时长和间隔切片，余尾不足不生成且每段容量固定为1", () => {
  const result=publish(fixture(),availability());assert.equal(result.classes.length,2);assert.equal(result.schedulePlans![0].mode,"availability");
  assert.deepEqual(result.classes.map(item=>[item.startAt,item.endAt]),[["2026-10-29T01:00:00.000Z","2026-10-29T02:00:00.000Z"],["2026-10-29T02:15:00.000Z","2026-10-29T03:15:00.000Z"]]);
  assert.ok(result.classes.every(item=>item.capacity===1));
  assert.equal(previewSchedule(fixture(),"hq",availability({endTime:"11:15"}),NOW).slotCount,2,"结束边界完整容纳的最后一段保留");
  rejects(()=>publish(fixture(),availability({capacity:2})),/一对一/);
});

test("规则拒绝空周期、重复或无效weekday、跨日、过短、过去时间及过大发布范围", () => {
  for (const p of [payload({weekdays:[]}),payload({weekdays:[4,4]}),payload({weekdays:[0]}),payload({startDate:"2026-02-30"}),payload({endDate:"2027-02-01"}),payload({endTime:"09:00"}),payload({startTime:"24:00"}),payload({startDate:"2026-10-29",endDate:"2026-10-29",weekdays:[1]}),availability({durationMinutes:55}),availability({gapMinutes:7}),availability({durationMinutes:180,endTime:"10:00"})]) rejects(()=>publish(fixture(),p),/请选择|重复|有效|90 天|结束时间|跨日|递增|不足|上课日/);
  rejects(()=>publish(fixture(),payload({startDate:"2026-10-28",endDate:"2026-10-29",weekdays:[3,4],startTime:"09:00",endTime:"10:00"})),/已开始|过去/);
  rejects(()=>publish(fixture(),availability({startDate:"2026-10-29",endDate:"2026-12-01",weekdays:[1,2,3,4,5,6,7],startTime:"08:00",endTime:"20:00",durationMinutes:15,gapMinutes:0})),/256/);
});

test("任一后续课次冲突使整个计划拒绝，取消过的场次不占用时段", () => {
  const first=publish(fixture(),payload({startDate:"2026-11-05",endDate:"2026-11-05"})),before=structuredClone(first);
  const preview=previewSchedule(first,"hq",payload(),NOW);assert.equal(preview.conflicts.length,1);assert.equal(preview.conflicts[0].date,"2026-11-05");
  rejects(()=>publish(first),/冲突/,409);assert.deepEqual(first,before);
  const cancelled=applyAction(first,"hq","class.cancel",{id:first.classes[0].id,reason:"调整课次"},NOW);assert.equal(previewSchedule(cancelled,"hq",payload(),NOW).conflicts.length,0);
});

test("教练或场地交叠都产生冲突，首尾相接与另一门店场地不会误判", () => {
  const data=publish(fixture(),payload({endDate:"2026-10-29"}));
  const room=payload({coachId:"c3",type:"少儿体能",endDate:"2026-10-29"});assert.equal(previewSchedule(data,"hq",room,NOW).conflicts.length,1);
  assert.equal(previewSchedule(data,"hq",payload({endDate:"2026-10-29",startTime:"11:00",endTime:"12:00"}),NOW).conflicts.length,0);
  assert.equal(previewSchedule(data,"hq",payload({coachId:"c2",type:"瑜伽普拉提",storeId:"s2",endDate:"2026-10-29"}),NOW).conflicts.length,0);
});

test("资质必须覆盖每一个实际课次，证书到期日当天有效且科目不能伪造", () => {
  const data=fixture(),coach=data.coaches.find(item=>item.id==="c1")!;coach.certificateExpiresAt="2026-11-05";
  assert.equal(previewSchedule(data,"hq",payload({endDate:"2026-11-05"}),NOW).slotCount,2);
  rejects(()=>publish(data),/2026-11-12|资质/);assert.equal(data.schedulePlans,undefined);assert.equal(data.classes.length,0);
  rejects(()=>publish(data,payload({type:"未授权科目"})),/教学资格/);
  coach.certificateExpiresAt="2030-02-30";rejects(()=>publish(data),/资质/);
  coach.status="pending";rejects(()=>publish(data),/尚未通过/);
});

test("教练可设置本人时间，店长品牌门店范围和学生权限不能被payload绕过", () => {
  assert.equal(publish(fixture(),availability(),"coach").classes.length,2);
  rejects(()=>publish(fixture(),payload({coachId:"c3",type:"少儿体能"}),"coach"),/自己|授权/,403);
  rejects(()=>publish(fixture(),payload({storeId:"s2",coachId:"c2",type:"瑜伽普拉提"}),"manager"),/所在门店/,403);
  rejects(()=>publish(fixture(),payload({storeId:"s4"})),/当前品牌/,403);
  rejects(()=>publish(fixture(),payload(),"student"),/无权/,403);
  rejects(()=>previewSchedule(fixture(),"student",payload(),NOW),/无权/,403);
  rejects(()=>previewSchedule(fixture(),"hq",{...payload(),tenantId:"t2"},NOW),/自行指定/,403);
  const stopped=fixture();stopped.stores[0].status="inactive";rejects(()=>publish(stopped),/正常营业/,403);
});

test("独立教练无门店、无需机构证书、可自定科目，但只能安排本人", () => {
  const data=fixture(),tenant=data.tenants[0],coach=data.coaches[0];tenant.mode="solo";tenant.expiresAt="2025-01-01";coach.storeId="";coach.selfManaged=true;coach.certificate="";coach.certificateExpiresAt="";
  const persona: Persona={...getPersona("hq"),workspaceMode:"solo",coachId:coach.id};
  const p=availability({storeId:"",coachId:coach.id,type:"自由训练"});const result=publish(data,p,persona);assert.equal(result.classes[0].storeId,"");assert.equal(result.classes[0].type,"自由训练");
  rejects(()=>publish(data,{...p,storeId:"s1"},persona),/没有门店/,403);
  rejects(()=>publish(data,{...p,coachId:"c3"},persona),/自己|授权/,403);
});

test("学员直接预约空闲slot容量为1，重复预约幂等，取消释放后其他学员可预约", () => {
  const published=publish(fixture(),availability()),slot=published.classes[0];
  const reserved=applyAction(published,"student","booking.create",{classId:slot.id,cardId:"card1",memberId:"m1"},NOW);assert.equal(reserved.cards[0].frozen,1);assert.equal(reserved.cards[0].remaining,24);
  const retry=applyAction(reserved,"student","booking.create",{classId:slot.id,cardId:"card1",memberId:"m1"},NOW);assert.equal(retry.bookings.length,1);
  rejects(()=>applyAction(reserved,memberFour,"booking.create",{classId:slot.id,cardId:"card4",memberId:"m4"},NOW),/已约满/);
  const cancelled=applyAction(reserved,"student","booking.cancel",{id:reserved.bookings[0].id},NOW);assert.equal(cancelled.cards[0].frozen,0);assert.equal(cancelled.classes[0].status,"scheduled");
  const other=applyAction(cancelled,memberFour,"booking.create",{classId:slot.id,cardId:"card4",memberId:"m4"},NOW);assert.equal(other.bookings.filter(item=>item.status==="reserved").length,1);assert.equal(other.cards.find(item=>item.id==="card4")!.frozen,1);
});

test("停用计划释放未来预约并保留完整审计账本，重复停用不重复释放", () => {
  let data=publish(fixture(),availability());for(const slot of data.classes) data=applyAction(data,"student","booking.create",{classId:slot.id,cardId:"card1",memberId:"m1"},NOW);
  assert.equal(data.cards[0].frozen,2);const stopped=applyAction(data,"coach","schedule.cancel",{id:data.schedulePlans![0].id,reason:"临时调整"},NOW);
  assert.equal(stopped.schedulePlans![0].status,"cancelled");assert.ok(stopped.classes.every(item=>item.status==="cancelled"));assert.ok(stopped.bookings.every(item=>item.status==="cancelled"));assert.equal(stopped.cards[0].frozen,0);assert.equal(stopped.cards[0].remaining,24);
  assert.ok(stopped.ledger.some(item=>item.type==="release"&&item.credits===2));assert.ok(stopped.audit.some(item=>item.action==="schedule.cancel"));assert.ok(stopped.audit.some(item=>item.action==="class.cancel"));
  const retry=applyAction(stopped,"coach","schedule.cancel",{id:stopped.schedulePlans![0].id,reason:"重复点击"},NOW);assert.equal(retry.ledger.length,stopped.ledger.length);assert.equal(retry.audit.length,stopped.audit.length);
  rejects(()=>applyAction(stopped,"student","booking.create",{classId:stopped.classes[0].id,cardId:"card1",memberId:"m1"},NOW),/已停用/);
});

test("已有未来签到时整批停用失败，不能被其他教练或门店停用", () => {
  let data=publish(fixture(),availability());data=applyAction(data,"student","booking.create",{classId:data.classes[1].id,cardId:"card1",memberId:"m1"},NOW);
  const at=new Date(Date.parse(data.classes[1].startAt)-30*60000);data=applyAction(data,"coach","booking.checkin",{id:data.bookings[0].id},at);const original=structuredClone(data);
  rejects(()=>applyAction(data,"coach","schedule.cancel",{id:data.schedulePlans![0].id,reason:"调整"},at),/签到|履约/);assert.deepEqual(data,original);
  rejects(()=>applyAction(data,{...getPersona("coach"),coachId:"c3"},"schedule.cancel",{id:data.schedulePlans![0].id,reason:"越权"},NOW),/自己/,403);
  rejects(()=>applyAction(data,{...getPersona("manager"),storeId:"s2"},"schedule.cancel",{id:data.schedulePlans![0].id,reason:"越权"},NOW),/本门店/,403);
});

test("停用未来循环保留已完成履约、已开始课次和已消费课时", () => {
  let data=publish(fixture(),availability());const first=data.classes[0],second=data.classes[1];
  for (const slot of [first,second]) data=applyAction(data,"student","booking.create",{classId:slot.id,cardId:"card1",memberId:"m1"},NOW);
  const booking=data.bookings.find(item=>item.classId===first.id)!;
  data=applyAction(data,"coach","booking.checkin",{id:booking.id},new Date(Date.parse(first.startAt)-60000));data=applyAction(data,"coach","booking.complete",{id:booking.id},new Date(first.startAt));
  const stopped=applyAction(data,"hq","schedule.cancel",{id:data.schedulePlans![0].id,reason:"关闭余下开放时段"},new Date(Date.parse(first.endAt)+60000));
  assert.equal(stopped.classes.find(item=>item.id===first.id)!.status,"scheduled");assert.equal(stopped.bookings.find(item=>item.id===booking.id)!.status,"completed");assert.equal(stopped.classes.find(item=>item.id===second.id)!.status,"cancelled");assert.equal(stopped.cards[0].remaining,23);assert.equal(stopped.cards[0].frozen,0);assertInvariants(stopped);
});

test("计划投影按品牌门店与本人隔离，学生只见活跃规则且不含他人预约", () => {
  const first=publish(fixture(),availability()),second=publish(first,payload({storeId:"s2",coachId:"c2",type:"瑜伽普拉提"}));
  const staff=projectWorkspace(second,"coach",1);assert.equal(staff.data.schedulePlans!.length,1);assert.equal(staff.data.schedulePlans![0].coachId,"c1");
  const student=projectWorkspace(second,"student",1);assert.equal(student.data.schedulePlans!.length,2);assert.deepEqual(student.data.bookings,[]);assert.ok(student.data.schedulePlans!.every(plan=>!("memberId" in plan)));
  const stopped=applyAction(second,"hq","schedule.cancel",{id:second.schedulePlans![0].id,reason:"暂停"},NOW);assert.equal(projectWorkspace(stopped,"student",2).data.schedulePlans!.length,1);
  const foreign=projectWorkspace(second,{...getPersona("hq"),tenantId:"t2"},1);assert.equal(foreign.data.schedulePlans!.length,0);
});

test("旧单次课程和缺少schedulePlans的旧数据保持兼容，新关联不可伪造", () => {
  const data=fixture();assert.equal(data.schedulePlans,undefined);assert.deepEqual(projectWorkspace(data,"hq",1).data.schedulePlans,[]);
  const once=applyAction(data,"hq","class.create",{name:"原单次课",storeId:"s1",coachId:"c1",type:"力量训练",startAt:"2026-10-30T10:00:00+08:00",endAt:"2026-10-30T11:00:00+08:00",capacity:5,credits:1,price:10000,room:"A区"},NOW);assert.equal(once.classes.length,1);assert.equal(once.classes[0].schedulePlanId,undefined);assertInvariants(once);
  const changed=publish(fixture(),availability());changed.classes[0].coachId="c3";rejects(()=>assertInvariants(changed),/计划不一致/,409);
});
