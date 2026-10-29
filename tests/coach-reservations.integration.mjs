import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../server/app.mjs';
import { createMysqlFixture } from './mysql.helpers.mjs';

test('真实MySQL：机构教练为授权学员代约、早取消与最小课包投影', async t => {
  const fixture=await createMysqlFixture();let server,base,now=new Date('2026-10-29T02:00:00Z');const password='Coach-Reserve-Fixture-2026!';
  async function start(){server=await createLocalServer({databaseOptions:fixture.options,clock:()=>now});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;}
  async function stop(){if(server){await new Promise(resolve=>server.close(resolve));await server.closeDatabase();server=null;}}
  t.after(async()=>{await stop();await fixture.dispose();});await start();
  async function request(path,body,token){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};}
  async function workspace(token){const result=await request('/api/workspace',undefined,token);assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
  async function action(token,action,payload,status=200){const before=await workspace(token),result=await request('/api/actions',{action,payload,version:before.version},token);assert.equal(result.status,status,JSON.stringify(result.data));return result.data;}
  const setup=await request('/api/setup',{account:'coach_reserve_owner',password,name:'代约管理员',tenantName:'代约测试品牌',storeName:'代约一店'});assert.equal(setup.status,200);const owner=setup.data.token;let w=await workspace(owner);const store=w.data.stores[0].id;
  w=await action(owner,'store.create',{name:'代约二店',address:'二店地址',manager:'二店管理员',phone:'13900000800'});const store2=w.data.stores.find(item=>item.id!==store).id;
  const coaches=[];for(const [index,storeId] of [store,store,store2].entries()){w=await action(owner,'coach.invite',{name:`代约教练${index}`,storeId,phone:`1390000081${index}`,specialty:'力量',certificate:'测试有效资质',certificateExpiresAt:'2099-12-31'});const coach=w.data.coaches.find(item=>item.name===`代约教练${index}`);coaches.push(coach.id);await action(owner,'coach.review',{id:coach.id,approved:true});}
  async function account(name,coachId,storeId){await action(owner,'account.create',{name,account:name,password,role:'coach',coachId,storeId});const result=await request('/api/auth/login',{account:name,password});assert.equal(result.status,200);return result.data.token;}
  const coachToken=await account('coach_reserve_self',coaches[0],store),otherToken=await account('coach_reserve_other',coaches[1],store);
  const venueIds={};for(const storeId of [store,store2]){w=await action(owner,'venue.create',{storeId,name:'代约测试训练区'});venueIds[storeId]=w.data.venues.find(item=>item.storeId===storeId).id;}
  const classes=[];for(const [index,coachId,storeId,date] of [[0,coaches[0],store,'2026-11-01'],[1,coaches[1],store,'2026-11-02'],[2,coaches[2],store2,'2026-11-03'],[3,coaches[0],store,'2026-11-04']]){w=await action(owner,'class.create',{name:`代约课程${index}`,type:'力量',coachId,storeId,startAt:`${date}T18:00:00+08:00`,endAt:`${date}T19:00:00+08:00`,capacity:6,credits:1,price:99999,venueId:venueIds[storeId],room:'代约测试训练区'});classes[index]=w.data.classes.find(item=>item.name===`代约课程${index}`).id;}
  const members=[],cards=[];for(const [index,storeId,coachId] of [[0,store,coaches[0]],[1,store,coaches[1]],[2,store2,coaches[2]],[3,store,coaches[1]]]){w=await action(owner,'member.create',{name:`代约学员${index}`,phone:`1380000080${index}`,storeId,coachId});const member=w.data.members.find(item=>item.name===`代约学员${index}`);members[index]=member.id;w=await action(owner,'card.issue',{memberId:member.id,storeId,name:`代约课包${index}`,total:10,amount:12347+index,expiresAt:'2099-12-31',scope:index===2?'all':'home',courseIds:[],receipt:`private-receipt-${index}`});cards[index]=w.data.cards.at(-1).id;}
  await action(owner,'followup.create',{memberId:members[1],title:'明确指派代约教练',dueAt:'2026-11-01',assigneeCoachId:coaches[0]});
  w=await action(owner,'booking.create',{memberId:members[2],cardId:cards[2],classId:classes[0]});await action(owner,'booking.cancel',{id:w.data.bookings.find(item=>item.memberId===members[2]).id});
  function booking(member=0,classIndex=0,card=member){return {memberId:members[member],classId:classes[classIndex],cardId:cards[card],coachId:classIndex===0||classIndex===3?coaches[0]:coaches[classIndex]};}
  function financialEmpty(data){for(const key of ['orders','ledger','settlements','audit','accounts'])assert.deepEqual(data[key],[]);for(const card of data.cards){assert.equal(Object.hasOwn(card,'unitValueCents'),false);assert.equal(Object.hasOwn(card,'orderId'),false);assert.equal(Object.hasOwn(card,'receiptAttachmentIds'),false);assert.equal(Object.hasOwn(card,'receiptAttachments'),false);}}
  let assignedBooking;

  await t.test('成员投影含负责、跟进、到访且课包仅有预约权益，无金额订单流水凭证',async()=>{
    const own=await workspace(coachToken);assert.deepEqual(new Set(own.data.members.map(item=>item.id)),new Set(members.slice(0,3)));assert.deepEqual(new Set(own.data.cards.map(item=>item.id)),new Set(cards.slice(0,3)));financialEmpty(own.data);assert.ok(own.data.classes.every(item=>item.coachId===coaches[0]));assert.ok((await workspace(owner)).data.cards.every(item=>Number.isInteger(item.unitValueCents)));
  });
  await t.test('负责、跟进、跨店到访学员均可代约本人课程，重复冻结幂等',async()=>{
    for(const index of [0,1,2]){const before=await workspace(owner);let result=await action(coachToken,'booking.create',booking(index));financialEmpty(result.data);const target=result.data.bookings.find(item=>item.memberId===members[index]&&item.status==='reserved');assert.ok(target);if(index===0)assignedBooking=target.id;const once=await workspace(owner);assert.equal(once.data.cards.find(item=>item.id===cards[index]).frozen,1);await action(coachToken,'booking.create',booking(index));const again=await workspace(owner);assert.deepEqual(again.data.ledger,once.data.ledger);assert.equal(again.data.bookings.length,once.data.bookings.length);assert.equal(once.data.ledger.length,before.data.ledger.length+1);}
  });
  await t.test('其他教练或门店课程、同店未授权学员及他人课卡猜测均拒绝且不写账',async()=>{
    const before=await workspace(owner);for(const payload of [booking(3),booking(0,1),booking(0,2),booking(0,3,3)])await action(coachToken,'booking.create',payload,403);const after=await workspace(owner);assert.deepEqual(after.data.cards,before.data.cards);assert.deepEqual(after.data.ledger,before.data.ledger);assert.deepEqual(after.data.bookings,before.data.bookings);
  });
  await t.test('退款卡保留禁选状态且无法预约，不扩大建档开卡权限',async()=>{
    w=await action(owner,'card.issue',{memberId:members[0],storeId:store,name:'已退款课包',total:2,amount:10000,expiresAt:'2099-12-31',scope:'home',courseIds:[]});const refunded=w.data.cards.at(-1),order=w.data.orders.find(item=>item.cardId===refunded.id);await action(owner,'order.refund',{id:order.id,receipt:'private-refund-ref',reason:'测试整卡退回'});
    const own=await workspace(coachToken);financialEmpty(own.data);assert.equal(own.data.cards.find(item=>item.id===refunded.id).status,'refunded');await action(coachToken,'booking.create',{...booking(0,3),cardId:refunded.id},400);
    await action(coachToken,'member.create',{name:'越权建档',phone:'13800000899',storeId:store},403);await action(coachToken,'card.issue',{memberId:members[0]},403);
  });
  await t.test('早取消原样释放并幂等，其他教练与60分钟内仍拒绝',async()=>{
    await action(otherToken,'booking.cancel',{id:assignedBooking},403);const cancelled=await action(coachToken,'booking.cancel',{id:assignedBooking});financialEmpty(cancelled.data);assert.equal(cancelled.data.cards.find(item=>item.id===cards[0]).frozen,0);const once=await workspace(owner);await action(coachToken,'booking.cancel',{id:assignedBooking});assert.deepEqual((await workspace(owner)).data.ledger,once.data.ledger);
    w=await action(coachToken,'booking.create',booking(0));assignedBooking=w.data.bookings.find(item=>item.memberId===members[0]&&item.status==='reserved').id;now=new Date('2026-11-01T09:00:00Z');await action(coachToken,'booking.cancel',{id:assignedBooking},400);
  });
  await t.test('重启保留预约与真实账本，教练响应持续不含财务字段',async()=>{
    const before=await workspace(owner);await stop();await start();const after=await workspace(owner);assert.deepEqual(after.data.cards,before.data.cards);assert.deepEqual(after.data.bookings,before.data.bookings);assert.deepEqual(after.data.ledger,before.data.ledger);assert.equal(after.version,before.version);financialEmpty((await workspace(coachToken)).data);
  });
});
