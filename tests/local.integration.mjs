import assert from "node:assert/strict";
import nodeTest from "node:test";
import { createLocalServer } from "../server/app.mjs";
import { createMysqlFixture } from "./mysql.helpers.mjs";

function test(name, run) {
  return nodeTest(name, async context => {
    if (run.length < 2) return run(context);
    const fixture = await createMysqlFixture();
    try { await run(context, fixture); } finally { await fixture.dispose(); }
  });
}

test("真实MySQL：空库开通、共享组织授权、账号安全、卡课账本与运营闭环",async(t,fixture)=>{
  let now=new Date("2026-10-24T02:00:00Z");
  let server=(await createLocalServer({databaseOptions:fixture.options,clock:()=>now}));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  let base=`http://127.0.0.1:${server.address().port}`,adminToken,studentToken,managerToken,coachToken,coach1Token,coach1,tenantId,store1,store2,memberId,cardId,orderId,classId,bookingId,coach2;
  const password="Local-test-pass-2026";
  async function request(path,{method="GET",body,token=adminToken,headers={}}={}){const response=await fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body!==undefined?{"Content-Type":"application/json"}:{}),...headers},...(body!==undefined?{body:typeof body==="string"?body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json(),headers:response.headers};}
  async function workspace(token=adminToken){const result=await request("/api/workspace",{token});assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
  async function action(action,payload,token=adminToken,expected=200){const current=await workspace(token);const result=await request("/api/actions",{method:"POST",body:{action,payload,version:current.version},token});assert.equal(result.status,expected,`${action}: ${JSON.stringify(result.data)}`);return result.data;}
  async function login(account){const result=await request("/api/auth/login",{method:"POST",body:{account,password},token:null});assert.equal(result.status,200,JSON.stringify(result.data));return result.data.token;}
  try{
    await t.test("默认空业务库，外传owner/persona不授予访问权",async()=>{
      assert.equal((await request("/api/setup",{token:null})).data.initialized,false);
      assert.equal((await request("/api/auth/session",{token:null})).data.user,null);
      assert.equal((await request("/api/workspace",{token:null,headers:{"oai-authenticated-user-id":"owner-admin","x-owner":"admin"}})).status,401);
      const setup=await request("/api/setup",{method:"POST",body:{name:"本地管理员",account:"admin_test",password,tenantName:"真实测试品牌",storeName:"一店"},token:null});
      assert.equal(setup.status,200);adminToken=setup.data.token;assert.equal(setup.data.memberships.length,2);assert.equal(setup.data.activeMembership.role,"hq");
      const data=(await workspace()).data;tenantId=data.tenants[0].id;store1=data.stores[0].id;assert.equal(data.demo,false);assert.equal(data.members.length,0);assert.equal(data.classes.length,0);assert.equal(data.cards.length,0);
      assert.equal((await request("/api/setup",{method:"POST",body:{},token:null})).status,409);
      const user=(await server.database.prepare("SELECT * FROM users").get());assert.notEqual(user.password_hash,password);assert.match(user.password_hash,/^[a-f0-9]{32}:[a-f0-9]{128}$/);
      assert.equal((await server.database.prepare("SELECT token_hash FROM sessions").get()).token_hash.length,64);assert.notEqual((await server.database.prepare("SELECT token_hash FROM sessions").get()).token_hash,adminToken);
      assert.match(setup.headers.get("set-cookie"),/HttpOnly; SameSite=Lax/);
    });
    await t.test("同源校验、角色伪造和任意组织切换被拒绝",async()=>{
      const current=await workspace();assert.equal((await request("/api/actions",{method:"POST",body:{action:"task.create",payload:{},version:current.version,persona:"platform"}})).status,403);
      assert.equal((await request("/api/workspace?persona=platform")).status,403);
      assert.equal((await request("/api/auth/context",{method:"POST",body:{membershipId:"unknown"}})).status,403);
      assert.equal((await request("/api/auth/logout",{method:"POST",body:{},headers:{Origin:"https://other.invalid"}})).status,403);
      assert.equal((await request("/api/actions",{method:"POST",body:"{}",headers:{"Content-Type":"text/plain"}})).status,415);
      const cookieSession=await request("/api/auth/session",{token:null,headers:{Cookie:`ldd_session=${adminToken}`}});assert.equal(cookieSession.data.user.account,"admin_test");
      assert.equal((await request("/api/auth/wechat",{method:"POST",body:{code:"not-configured"},token:null})).status,503);
    });
    await t.test("真实建档、门店教练资质、独立账号共享组织数据且权限受限",async()=>{
      let result=await action("member.create",{name:"测试学员",phone:"13900000001",storeId:store1});memberId=result.data.members[0].id;
      result=await action("store.create",{name:"二店",address:"测试路2号",manager:"二店店长",phone:"021-00000002"});store2=result.data.stores.find(s=>s.id!==store1).id;
      result=await action("coach.invite",{name:"二店教练",phone:"13900000002",storeId:store2,specialty:"力量训练",certificate:"已核验教练证",certificateExpiresAt:"2027-10-24"});coach2=result.data.coaches[0].id;
      await action("coach.review",{id:coach2,approved:true});
      result=await action("coach.invite",{name:"一店负责教练",phone:"13900000004",storeId:store1,specialty:"力量训练",certificate:"已核验教练证",certificateExpiresAt:"2027-10-24"});coach1=result.data.coaches.find(c=>c.name==="一店负责教练").id;
      await action("coach.review",{id:coach1,approved:true});
      await action("member.update",{id:memberId,coachId:coach2},adminToken,403);
      await action("member.update",{id:memberId,coachId:coach1});
      await action("account.create",{name:"一店店长",account:"manager_test",password,role:"manager",storeId:store1});
      await action("account.create",{name:"测试学员",account:"student_test",password,role:"student",storeId:store1,memberId});
      await action("account.create",{name:"二店教练",account:"coach_test",password,role:"coach",storeId:store2,coachId:coach2});
      await action("account.create",{name:"一店负责教练",account:"coach1_test",password,role:"coach",storeId:store1,coachId:coach1});
      studentToken=await login("student_test");managerToken=await login("manager_test");coachToken=await login("coach_test");
      coach1Token=await login("coach1_test");
      assert.equal((await workspace(studentToken)).data.members[0].id,memberId);
      assert.equal((await workspace(managerToken)).data.members[0].id,memberId);
      assert.equal((await workspace(studentToken)).data.accounts.length,0);
      await action("account.create",{name:"伪造总部",account:"forged_hq",password,role:"hq",storeId:store1},managerToken,403);
      await action("store.update",{id:store2,name:"越权改名"},managerToken,403);
      assert.equal((await workspace()).data.stores.find(s=>s.id===store2).name,"二店");
    });
    await t.test("多品牌组织独立共享，未授权账号无法切换到其他人的membership",async()=>{
      const session=(await request("/api/auth/session")).data,platform=session.memberships.find(m=>m.role==="platform"),hq=session.memberships.find(m=>m.role==="hq");
      assert.equal((await request("/api/auth/context",{method:"POST",body:{membershipId:platform.id},token:studentToken})).status,403);
      assert.equal((await request("/api/auth/context",{method:"POST",body:{membershipId:platform.id}})).status,200);
      let result=await action("tenant.create",{name:"独立第二品牌",contact:"品牌二负责人",phone:"13900000003",plan:"专业版",expiresAt:"2027-10-24"});const otherTenant=result.data.tenants.find(v=>v.id!==tenantId);
      await action("store.create",{tenantId:otherTenant.id,name:"品牌二门店",address:"测试路3号",manager:"品牌二负责人",phone:"13900000003"});
      await action("account.create",{tenantId:otherTenant.id,name:"品牌二总部",account:"other_hq",password,role:"hq"});
      const otherToken=await login("other_hq"),otherWorkspace=await workspace(otherToken);assert.equal(otherWorkspace.data.tenants.length,1);assert.equal(otherWorkspace.data.tenants[0].id,otherTenant.id);assert.equal(otherWorkspace.data.members.length,0);
      await action("member.update",{id:memberId,name:"越权修改"},otherToken,403);
      assert.equal((await request("/api/auth/context",{method:"POST",body:{membershipId:hq.id}})).status,200);
      assert.equal((await workspace()).data.members.find(m=>m.id===memberId).name,"测试学员");
    });
    await t.test("线下凭证开卡、重复凭证阻断、排课约课与同版本并发事务",async()=>{
      let result=await action("card.issue",{memberId,storeId:store1,name:"全城训练卡",total:3,amount:10001,expiresAt:"2027-10-24",scope:"all",classTypes:["力量训练"],receipt:"offline-order-001"});cardId=result.data.cards[0].id;orderId=result.data.orders[0].id;
      await action("card.issue",{memberId,storeId:store1,name:"重复",total:3,amount:10001,expiresAt:"2027-10-24",scope:"all",classTypes:["力量训练"],receipt:"offline-order-001"},adminToken,400);
      result=await action("class.create",{name:"二店力量课",storeId:store2,coachId:coach2,type:"力量训练",startAt:"2026-10-24T10:30:00+08:00",endAt:"2026-10-24T11:30:00+08:00",capacity:1,credits:2,price:20000,room:"A室"});classId=result.data.classes[0].id;
      const current=await workspace(studentToken);const body={action:"booking.create",payload:{classId,cardId},version:current.version};const concurrent=await Promise.all([request("/api/actions",{method:"POST",body,token:studentToken}),request("/api/actions",{method:"POST",body,token:studentToken})]);
      assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
      result=await workspace(studentToken);assert.equal(result.data.cards[0].remaining,3);assert.equal(result.data.cards[0].frozen,2);assert.equal(result.data.bookings.length,1);bookingId=result.data.bookings[0].id;
      assert.deepEqual(result.data.ledger.map(l=>l.type),["issue","freeze"]);
      assert.equal((await workspace(managerToken)).data.bookings.length,0,"售卡门店不能管理异店课程签到");
      await action("booking.checkin",{id:bookingId},managerToken,403);
    });
    await t.test("签到消课、原子追加账本、跨店金额快照及训练反馈",async()=>{
      await action("booking.complete",{id:bookingId},coachToken,400);
      await action("booking.checkin",{id:bookingId},coachToken);
      await action("booking.complete",{id:bookingId},coachToken,400);
      now=new Date("2026-10-24T02:40:00Z");
      await action("booking.complete",{id:bookingId},coachToken);
      const result=await workspace();assert.equal(result.data.cards[0].remaining,1);assert.equal(result.data.cards[0].frozen,0);
      const settlement=result.data.settlements[0];assert.equal(settlement.amount,6667);assert.equal(settlement.credits,2);assert.equal(settlement.unitValueCents,3333);
      assert.deepEqual(result.data.ledger.map(l=>l.type),["issue","freeze","consume"]);
      assert.equal(result.data.ledger.at(-1).amount,-6667);
      await action("booking.complete",{id:bookingId},coachToken);assert.equal((await workspace()).data.ledger.length,3);
      await action("settlement.confirm",{id:settlement.id},managerToken,403);
      await action("settlement.confirm",{id:settlement.id});
      await action("training.feedback",{bookingId,content:"完成核心稳定性训练，下节逐步增加负荷。",rating:5},coachToken);
      await action("training.feedback",{bookingId,content:"训练后感觉良好。",rating:5},studentToken);
      assert.equal((await workspace(studentToken)).data.feedback.length,2);
      assert.equal((await workspace(coachToken)).data.ledger.length,0);
      await assert.rejects(async()=>(await server.database.prepare("UPDATE ledger SET data='{}'").run()),/append-only/);
      await assert.rejects(async()=>(await server.database.prepare("DELETE FROM ledger").run()),/append-only/);
    });
    await t.test("低余额跟进生成去重、联系记录和结案结果持久化",async()=>{
      let result=await action("followup.generate",{},managerToken);assert.equal(result.data.followups.length,1);const followup=result.data.followups[0];assert.equal(followup.reason,"low_balance");
      result=await action("followup.generate",{},managerToken);assert.equal(result.data.followups.length,1);
      await action("followup.comment",{id:followup.id,content:"已电话沟通，学员愿意继续训练。"},managerToken);
      await action("followup.update",{id:followup.id,status:"contacted"},managerToken);
      await action("followup.close",{id:followup.id,result:"已约定下周到店续课。"},managerToken);
      result=await workspace();assert.equal(result.data.followups[0].status,"closed");assert.equal(result.data.followups[0].comments.length,1);assert.equal(result.data.followups[0].result,"已约定下周到店续课。");
      assert.equal((await workspace(studentToken)).data.followups.length,0);
    });
    await t.test("负责教练仅能操作分配给自己的跟进，不能改分配或看财务",async()=>{
      let result=await action("followup.create",{memberId,title:"负责教练训练回访",dueAt:"2026-10-26"});const followup=result.data.followups.find(f=>f.title==="负责教练训练回访");assert.equal(followup.assigneeCoachId,coach1);
      const own=await workspace(coach1Token);assert.ok(own.data.members.some(m=>m.id===memberId));assert.ok(own.data.followups.some(f=>f.id===followup.id));assert.equal(own.data.orders.length,0);assert.equal(own.data.ledger.length,0);assert.equal(own.data.accounts.length,0);
      assert.ok(!(await workspace(coachToken)).data.followups.some(f=>f.id===followup.id));
      await action("followup.comment",{id:followup.id,content:"越权跟进"},coachToken,403);
      await action("followup.update",{id:followup.id,title:"改任务"},coach1Token,403);
      await action("followup.update",{id:followup.id,assigneeCoachId:""},coach1Token,403);
      await action("followup.generate",{},coach1Token,403);
      await action("followup.comment",{id:followup.id,content:"已了解训练恢复情况。"},coach1Token);
      await action("followup.update",{id:followup.id,status:"contacted",dueAt:"2026-10-27"},coach1Token);
      await action("followup.close",{id:followup.id,result:"学员暂缓训练。",outcome:"paused"},coach1Token);
      result=await workspace();assert.equal(result.data.followups.find(f=>f.id===followup.id).outcome,"paused");
    });
    await t.test("续卡创建新卡、取消课释放、整包线下退款与已消耗拒退",async()=>{
      let result=await action("card.renew",{id:cardId,name:"续购卡",total:10,amount:100000,expiresAt:"2027-11-24",scope:"all",classTypes:["力量训练"],receipt:"offline-order-002"});const newCard=result.data.cards.find(c=>c.id!==cardId),newOrder=result.data.orders.find(o=>o.cardId===newCard.id);
      assert.equal(result.data.cards.find(c=>c.id===cardId).unitValueCents,3333);assert.equal(newCard.remaining,10);
      await action("order.refund",{id:orderId,receipt:"refund-reject",reason:"测试"},adminToken,400);
      result=await action("class.create",{name:"未来训练课",storeId:store2,coachId:coach2,type:"力量训练",startAt:"2026-10-25T10:00:00+08:00",endAt:"2026-10-25T11:00:00+08:00",capacity:5,credits:1,price:20000,room:"A室"});const future=result.data.classes.find(c=>c.id!==classId);
      await action("booking.create",{classId:future.id,cardId:newCard.id},studentToken);
      await action("order.refund",{id:newOrder.id,receipt:"refund-before-release",reason:"测试"},adminToken,400);
      await action("class.cancel",{id:future.id,reason:"场馆设备维护"});
      result=await action("order.refund",{id:newOrder.id,receipt:"offline-refund-001",reason:"学员申请未使用课包全退"});assert.equal(result.data.cards.find(c=>c.id===newCard.id).status,"refunded");assert.equal(result.data.orders.find(o=>o.id===newOrder.id).status,"refunded");
      assert.deepEqual(result.data.ledger.filter(l=>l.cardId===newCard.id).map(l=>l.type),["issue","freeze","release","refund"]);
    });
    await t.test("迟取消与未到店须经员工校验，释放冻结并记不可改账本",async()=>{
      let result=await action("class.create",{name:"迟取消验证课",storeId:store2,coachId:coach2,type:"力量训练",startAt:"2026-10-24T12:00:00+08:00",endAt:"2026-10-24T13:00:00+08:00",capacity:3,credits:1,price:10000,room:"B室"});const lateClass=result.data.classes.find(c=>c.name==="迟取消验证课");
      result=await action("booking.create",{classId:lateClass.id,cardId},studentToken);let booking=result.data.bookings.find(b=>b.classId===lateClass.id);
      await action("booking.latecancel",{id:booking.id,reason:"提前操作"},adminToken,400);
      now=new Date("2026-10-24T03:30:00Z");
      await action("booking.cancel",{id:booking.id},studentToken,400);
      await action("booking.latecancel",{id:booking.id,reason:"学生请求绕过"},studentToken,403);
      await action("booking.latecancel",{id:booking.id,reason:"已核验紧急情况，批准本次迟取消"});
      result=await workspace(studentToken);assert.equal(result.data.cards.find(c=>c.id===cardId).remaining,1);assert.equal(result.data.cards.find(c=>c.id===cardId).frozen,0);
      result=await action("class.create",{name:"未到店验证课",storeId:store2,coachId:coach2,type:"力量训练",startAt:"2026-10-24T14:00:00+08:00",endAt:"2026-10-24T15:00:00+08:00",capacity:3,credits:1,price:10000,room:"B室"});const noShowClass=result.data.classes.find(c=>c.name==="未到店验证课");
      result=await action("booking.create",{classId:noShowClass.id,cardId},studentToken);booking=result.data.bookings.find(b=>b.classId===noShowClass.id);
      await action("booking.no_show",{id:booking.id,reason:"尚未结束"},adminToken,400);
      now=new Date("2026-10-24T07:10:00Z");await action("booking.no_show",{id:booking.id,reason:"已电话确认未到店"});
      const before=(await workspace()).data.ledger.length;await action("booking.no_show",{id:booking.id,reason:"重复提交"});result=await workspace();assert.equal(result.data.ledger.length,before);assert.equal(result.data.bookings.find(b=>b.id===booking.id).status,"no_show");assert.equal(result.data.cards.find(c=>c.id===cardId).remaining,1);
    });
    await t.test("续费结案必须核验真实订单引用，教练只获得无金额的候选项",async()=>{
      let result=await action("followup.create",{memberId,title:"续费核验回访",dueAt:"2026-10-27",assigneeCoachId:coach1});const followup=result.data.followups.find(f=>f.title==="续费核验回访");
      await action("followup.close",{id:followup.id,result:"已经续费",outcome:"renewed"},coach1Token,400);
      await action("followup.close",{id:followup.id,result:"使用历史售卡",outcome:"renewed",renewalOrderId:orderId},coach1Token,400);
      result=await action("card.renew",{id:cardId,name:"跟进后续购卡",total:10,amount:100000,expiresAt:"2027-11-24",scope:"all",classTypes:["力量训练"],receipt:"offline-order-followup"});const renewal=result.data.orders.find(o=>o.receipt==="offline-order-followup");
      const visible=(await workspace(coach1Token)).data.followups.find(f=>f.id===followup.id),candidate=visible.renewalCandidates.find(o=>o.id===renewal.id);assert.ok(candidate);assert.deepEqual(Object.keys(candidate).sort(),["cardName","createdAt","id"]);assert.equal((await workspace(coach1Token)).data.orders.length,0);
      await action("followup.close",{id:followup.id,result:"已核验续费订单，继续训练。",outcome:"renewed",renewalOrderId:renewal.id},coach1Token);
      result=await workspace();const closed=result.data.followups.find(f=>f.id===followup.id);assert.equal(closed.outcome,"renewed");assert.equal(closed.renewalOrderId,renewal.id);
    });
    await t.test("重启保留同一MySQL数据、过期会话和退出撤销token",async()=>{
      await new Promise(resolve=>server.close(resolve));(await server.closeDatabase());
      server=(await createLocalServer({databaseOptions:fixture.options,clock:()=>now}));await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${server.address().port}`;
      let result=await workspace();assert.equal(result.data.bookings.find(b=>b.id===bookingId).status,"completed");assert.equal(result.data.cards.find(c=>c.id===cardId).remaining,1);assert.equal(result.data.followups[0].status,"closed");assert.equal(result.data.settlements[0].status,"confirmed");
      await request("/api/auth/logout",{method:"POST",body:{},token:studentToken});assert.equal((await request("/api/workspace",{token:studentToken})).status,401);
      (await server.database.prepare("UPDATE sessions SET expires_at='2020-01-01T00:00:00.000Z'").run());assert.equal((await request("/api/workspace",{token:managerToken})).status,401);
    });
  }finally{await new Promise(resolve=>server.close(resolve));(await server.closeDatabase());}
});

test("独立教练：真正无门店空库、本人执教及学员自助闭环",async(t,fixture)=>{

  let now=new Date("2026-10-24T02:00:00Z");
  const server=(await createLocalServer({databaseOptions:fixture.options,clock:()=>now}));await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let ownerToken,studentToken,tenantId,coachId,memberId,otherMemberId,cardId,bookingId,classId,originalOrderId;
  const password="Solo-test-pass-2026";
  async function request(path,{method="GET",body,token=ownerToken}={}){const response=await fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body!==undefined?{"Content-Type":"application/json"}:{} )},...(body!==undefined?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json()};}
  async function workspace(token=ownerToken){const result=await request("/api/workspace",{token});assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
  async function action(name,payload,token=ownerToken,expected=200){const current=await workspace(token),result=await request("/api/actions",{method:"POST",token,body:{action:name,payload,version:current.version}});assert.equal(result.status,expected,`${name}: ${JSON.stringify(result.data)}`);return result.data;}
  try{
    await t.test("首次solo开通仅需账号姓名密码，没有Store或平台扩员权限",async()=>{
      const result=await request("/api/setup",{method:"POST",token:null,body:{mode:"solo",name:"独立教练",account:"solo_owner",password,specialty:"自主管理体能训练"}});assert.equal(result.status,200,JSON.stringify(result.data));ownerToken=result.data.token;assert.equal(result.data.memberships.length,1);assert.equal(result.data.activeMembership.role,"hq");assert.equal(result.data.activeMembership.workspaceMode,"solo");assert.ok(result.data.activeMembership.coachId);assert.equal(result.data.activeMembership.storeId,undefined);
      const current=await workspace();tenantId=current.data.tenants[0].id;coachId=current.persona.coachId;assert.equal(current.persona.tenantId,tenantId);assert.equal(current.persona.workspaceMode,"solo");assert.equal(current.data.tenants[0].mode,"solo");assert.equal(current.data.stores.length,0);assert.equal(current.data.coaches.length,1);assert.equal(current.data.coaches[0].storeId,"");assert.equal(current.data.coaches[0].selfManaged,true);assert.equal(current.data.coaches[0].certificate,"");assert.equal(current.data.members.length,0);
      assert.equal((await server.database.prepare("SELECT count(*) AS n FROM stores").get()).n,0);
      await action("store.create",{name:"伪造门店",address:"地址",manager:"我",phone:"13900000001"},ownerToken,403);
      await action("coach.invite",{name:"额外员工",phone:"13900000002",storeId:"",specialty:"训练"},ownerToken,403);
      await action("account.create",{name:"额外店长",account:"solo_manager",password,role:"manager",storeId:""},ownerToken,403);
      await action("account.create",{name:"额外教练",account:"solo_coach",password,role:"coach",storeId:"",coachId},ownerToken,403);
    });
    await t.test("无需建店或伪造机构资质，直接建学员、开卡、安排授课地点",async()=>{
      let result=await action("member.create",{name:"独立学员甲",phone:"13900000011"});memberId=result.data.members[0].id;assert.equal(result.data.members[0].storeId,"");assert.equal(result.data.members[0].coachId,coachId);
      result=await action("member.create",{name:"独立学员乙",phone:"13900000012",storeId:"",coachId});otherMemberId=result.data.members.find(m=>m.id!==memberId).id;
      result=await action("card.issue",{memberId,name:"个人训练课包",total:3,amount:10001,expiresAt:"2027-10-24",scope:"home",classTypes:["自由训练"],receipt:"solo-paid-001"});cardId=result.data.cards[0].id;originalOrderId=result.data.orders[0].id;assert.equal(result.data.cards[0].storeId,"");assert.equal(result.data.orders[0].storeId,"");assert.equal(result.data.ledger[0].storeId,"");
      result=await action("class.create",{name:"公园个人训练",type:"自由训练",startAt:"2026-10-24T12:00:00+08:00",endAt:"2026-10-24T13:00:00+08:00",capacity:1,credits:1,price:0,room:"公园东门集合点"});classId=result.data.classes[0].id;assert.equal(result.data.classes[0].coachId,coachId);assert.equal(result.data.classes[0].storeId,"");assert.equal(result.data.classes[0].room,"公园东门集合点");assert.equal(result.data.stores.length,0);
      result=await action("booking.create",{classId,cardId,memberId});bookingId=result.data.bookings[0].id;assert.equal(result.data.cards[0].frozen,1);
      await action("booking.cancel",{id:bookingId});result=await action("booking.create",{classId,cardId,memberId});bookingId=result.data.bookings.find(b=>b.status==="reserved").id;
      await action("booking.checkin",{id:bookingId});await action("booking.complete",{id:bookingId},ownerToken,400);now=new Date("2026-10-24T04:05:00Z");result=await action("booking.complete",{id:bookingId});assert.equal(result.data.cards[0].remaining,2);assert.equal(result.data.cards[0].frozen,0);assert.equal(result.data.settlements.length,0);assert.deepEqual(result.data.ledger.map(l=>l.type),["issue","freeze","release","freeze","consume"]);
      await action("training.feedback",{bookingId,content:"本人已完成训练指导，下一次继续增加稳定性训练。",rating:5});
      assert.equal((await server.database.prepare("SELECT count(*) AS n FROM stores").get()).n,0);
    });
    await t.test("独立教练跟进、续卡及未使用课包线下退款无需门店",async()=>{
      let result=await action("followup.generate",{});assert.equal(result.data.followups.length,1);const followup=result.data.followups[0];assert.equal(followup.storeId,"");assert.equal(followup.assigneeCoachId,coachId);
      await action("followup.comment",{id:followup.id,content:"已联系学员确认训练节奏。"});await action("followup.update",{id:followup.id,status:"contacted"});await action("followup.close",{id:followup.id,result:"恢复每周一次训练。",outcome:"resumed"});
      result=await action("card.renew",{id:cardId,name:"独立续购课包",total:5,amount:20000,expiresAt:"2027-11-24",scope:"home",classTypes:["自由训练"],receipt:"solo-paid-002"});const newCard=result.data.cards.find(c=>c.id!==cardId),order=result.data.orders.find(o=>o.cardId===newCard.id);assert.equal(newCard.storeId,"");assert.equal(result.data.cards.find(c=>c.id===cardId).unitValueCents,3333);
      await action("order.refund",{id:originalOrderId,receipt:"invalid-refund",reason:"已消课原卡"},ownerToken,400);result=await action("order.refund",{id:order.id,receipt:"solo-refund-001",reason:"学员确认未使用课包全退"});assert.equal(result.data.orders.find(o=>o.id===order.id).status,"refunded");assert.equal(result.data.ledger.at(-1).type,"refund");assert.equal(result.data.stores.length,0);
    });
    await t.test("可选学员账号具备本人约课取消反馈，不能查看他人或变更空间模式",async()=>{
      await action("account.create",{name:"独立学员甲",account:"solo_student",password,role:"student",storeId:"",memberId});const login=await request("/api/auth/login",{method:"POST",token:null,body:{account:"solo_student",password}});assert.equal(login.status,200);studentToken=login.data.token;assert.equal(login.data.activeMembership.workspaceMode,"solo");assert.equal(login.data.activeMembership.storeId,undefined);
      let result=await action("class.create",{name:"学员自助预约场次",storeId:"",coachId,type:"自由训练",startAt:"2026-10-25T12:00:00+08:00",endAt:"2026-10-25T13:00:00+08:00",capacity:2,credits:1,price:0,room:"公园南门"});const future=result.data.classes.find(c=>c.id!==classId);
      result=await workspace(studentToken);assert.equal(result.data.members.length,1);assert.equal(result.data.members[0].id,memberId);assert.ok(!result.data.members.some(m=>m.id===otherMemberId));assert.equal(result.data.followups.length,0);assert.equal(result.data.accounts.length,0);
      result=await action("booking.create",{classId:future.id,cardId},studentToken);const booking=result.data.bookings.find(b=>b.classId===future.id);await action("booking.cancel",{id:booking.id},studentToken);
      await action("training.feedback",{bookingId,content:"训练清晰，能够继续坚持。",rating:5},studentToken);
      await action("member.update",{id:otherMemberId,name:"越权修改",mode:"organization"},studentToken,403);
      await action("booking.create",{classId:future.id,cardId,memberId:otherMemberId},studentToken,403);
      await action("store.create",{mode:"organization",name:"模式绕过",address:"地址",manager:"我",phone:"13900000001"},ownerToken,403);
      await action("member.create",{name:"外部门店绕过",phone:"13900000013",mode:"organization",storeId:"forged-store"},ownerToken,403);
    });
    await t.test("同库其他独立空间隔离，空storeId不导致跨租户场地冲突",async()=>{
      // 只为独立临时测试库注入另一租户，不提供生产种子或越权创建接口。
      const stamp=now.toISOString(),otherTenant="fixture-other-solo",otherCoach="fixture-other-coach",otherMember="fixture-other-member";
      const insert=async(table,value)=>(await server.database.prepare(`INSERT INTO ${table}(id,tenant_id,store_id,data) VALUES(?,?,?,?)`).run(value.id,value.tenantId??null,value.storeId??null,JSON.stringify(value)));
      (await insert("tenants",{id:otherTenant,mode:"solo",name:"另一独立教练",contact:"另一个人",phone:"",plan:"专业版",status:"active",expiresAt:"2027-10-24",createdAt:stamp}));(await insert("coaches",{id:otherCoach,tenantId:otherTenant,storeId:"",name:"另一教练",specialty:"自由训练",phone:"",status:"approved",certificate:"",certificateExpiresAt:"",rating:0,selfManaged:true}));(await insert("members",{id:otherMember,tenantId:otherTenant,storeId:"",name:"其他租户私有学员",phone:"13900000014",joinedAt:stamp,avatar:"他",coachId:otherCoach}));(await insert("classes",{id:"fixture-other-class",tenantId:otherTenant,storeId:"",coachId:otherCoach,name:"其他空间同场地时段",type:"自由训练",startAt:"2026-10-26T12:00:00+08:00",endAt:"2026-10-26T13:00:00+08:00",capacity:1,credits:1,price:0,room:"公园东门",status:"scheduled"}));
      const result=await action("class.create",{name:"本人独立场次",type:"自由训练",startAt:"2026-10-26T12:00:00+08:00",endAt:"2026-10-26T13:00:00+08:00",capacity:1,credits:1,price:0,room:"公园东门"});assert.equal(result.data.tenants.length,1);assert.ok(!result.data.members.some(m=>m.id===otherMember));assert.ok(!result.data.classes.some(c=>c.id==="fixture-other-class"));
      await action("member.update",{id:otherMember,name:"越权"},ownerToken,403);await action("card.issue",{memberId:otherMember,name:"越权开卡",total:1,amount:1000,expiresAt:"2027-10-24",scope:"home",classTypes:["自由训练"],receipt:"cross-tenant-receipt"},ownerToken,403);
      assert.equal((await server.database.prepare("SELECT count(*) AS n FROM stores").get()).n,0);
      const current=await workspace();assert.equal(current.data.members.length,2);assert.ok(current.data.cards.every(c=>c.storeId===""));assert.ok(current.data.classes.every(c=>c.storeId===""));
    });
  }finally{await new Promise(resolve=>server.close(resolve));(await server.closeDatabase());}
});

test("本地独立教练长期使用不受机构订阅到期锁定，组织到期与暂停控制保留",async(t)=>{
  for(const mode of ["solo","organization"]){
    await t.test(`${mode} 开通366天后重新登录及历史有效期兼容`,async()=>{
      const fixture=await createMysqlFixture();
      let now=new Date("2026-10-24T02:00:00Z");

      const server=(await createLocalServer({databaseOptions:fixture.options,clock:()=>now}));await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const base=`http://127.0.0.1:${server.address().port}`;let token;
      async function request(path,body){const response=await fetch(base+path,{method:body?"POST":"GET",headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json()};}
      async function action(action,payload,expected){const current=await request("/api/workspace"),result=await request("/api/actions",{action,payload,version:current.data.version});assert.equal(result.status,expected,`${mode} ${action}: ${JSON.stringify(result.data)}`);return result.data;}
      try{
        const password="Long-local-pass-2026",account=`expiry_${mode}`;const setup=await request("/api/setup",{mode,name:"长期使用教练",account,password,...(mode==="organization"?{tenantName:"机构到期验证",storeName:"首店"}:{})});assert.equal(setup.status,200);token=setup.data.token;let current=(await request("/api/workspace")).data;
        assert.equal(current.data.tenants[0].expiresAt,mode==="solo"?"9999-12-31":"2027-10-24");
        now=new Date("2027-10-25T02:00:00Z");const login=await request("/api/auth/login",{account,password});assert.equal(login.status,200);token=login.data.token;
        if(mode==="solo"){
          // 模拟旧版本生成的一年有效期。仅更新独立测试库，不迁移或修改用户数据库。
          const tenant=current.data.tenants[0];tenant.expiresAt="2027-10-24";(await server.database.prepare("UPDATE tenants SET data=? WHERE id=?").run(JSON.stringify(tenant),tenant.id));
          current=await action("member.create",{name:"一年后新增学员",phone:"13900000031"},200);assert.equal(current.data.members.length,1);assert.equal(current.data.stores.length,0);
          current=await action("class.create",{name:"一年后的自主管理课程",type:"自由训练",startAt:"2027-10-26T10:00:00+08:00",endAt:"2027-10-26T11:00:00+08:00",capacity:1,credits:1,price:0,room:"公园"},200);assert.equal(current.data.classes.length,1);assert.equal(current.data.classes[0].storeId,"");
          tenant.status="suspended";(await server.database.prepare("UPDATE tenants SET data=? WHERE id=?").run(JSON.stringify(tenant),tenant.id));await action("member.create",{name:"暂停后不得写入",phone:"13900000032"},403);
        }else{
          await action("member.create",{name:"机构过期后不得写入",phone:"13900000033",storeId:current.data.stores[0].id},403);await action("class.create",{name:"机构过期后不得排课"},403);assert.equal((await request("/api/workspace")).data.data.members.length,0);
        }
      }finally{await new Promise(resolve=>server.close(resolve));await server.closeDatabase();await fixture.dispose();}
    });
  }
});

test("小程序微信免密HTTP：单用开通凭证、私有空间与失败回滚",async(t,fixture)=>{
  let now=new Date("2026-10-25T02:00:00Z");const exchanged=[];

  const server=(await createLocalServer({databaseOptions:fixture.options,clock:()=>now,wechatCodeExchange:async code=>{
    exchanged.push(code);if(code==="upstream-down")throw new Error("fixture unavailable");if(code==="invalid-code")return{errcode:40029};return{openid:`private-openid-${code.split(":")[0]}`,session_key:"never-return-this-key"};
  }}));await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const base=`http://127.0.0.1:${server.address().port}`;let pendingA,tokenA,tokenB,userA,tenantA,tenantB;
  async function request(path,body,token,extraHeaders={}){const response=await fetch(base+path,{method:body!==undefined?"POST":"GET",headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body!==undefined?{"Content-Type":"application/json"}:{}),...extraHeaders},...(body!==undefined?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json(),headers:response.headers};}
  const counts=async()=>Object.fromEntries(await Promise.all(["users","tenants","coaches","stores","wechat_bindings","sessions"].map(async table=>[table,(await server.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n])));
  async function workspace(token){const response=await request("/api/workspace",undefined,token);assert.equal(response.status,200,JSON.stringify(response.data));return response.data;}
  async function action(token,action,payload,expected=200){const current=await workspace(token),response=await request("/api/actions",{action,payload,version:current.version},token);assert.equal(response.status,expected,JSON.stringify(response.data));return response.data;}
  try{
    await t.test("未绑定微信只返回5分钟opaque ticket，不接管账号或提前创建数据",async()=>{
      const setup=await request("/api/setup");assert.equal(setup.data.initialized,false);assert.equal(setup.data.wechatConfigured,true);
      const first=await request("/api/auth/wechat",{code:"A:first"});assert.equal(first.status,200);pendingA=first.data;
      assert.deepEqual(Object.keys(pendingA).sort(),["expiresAt","needsOnboarding","onboardingToken"]);assert.equal(pendingA.needsOnboarding,true);assert.equal(Date.parse(pendingA.expiresAt)-now.getTime(),5*60000);
      assert.ok(!JSON.stringify(pendingA).includes("private-openid"));assert.ok(!JSON.stringify(pendingA).includes("session_key"));assert.deepEqual((await counts()),{users:0,tenants:0,coaches:0,stores:0,wechat_bindings:0,sessions:0});
      const stored=(await server.database.prepare("SELECT * FROM wechat_onboarding").get());assert.notEqual(stored.ticket_hash,pendingA.onboardingToken);assert.equal(stored.ticket_hash.length,64);assert.ok(!stored.openid_hash.includes("private-openid"));
      assert.equal((await request("/api/auth/wechat",{code:"A:first"})).status,409);assert.equal(exchanged.filter(code=>code==="A:first").length,1);
    });
    await t.test("开通事务失败整体回滚，修正后同ticket可完成一次真实solo开通",async()=>{
      assert.equal((await request("/api/auth/wechat/register",{onboardingToken:pendingA.onboardingToken,name:""})).status,400);
      (await server.database.exec("CREATE TRIGGER fail_wechat_registration BEFORE INSERT ON users FOR EACH ROW BEGIN IF NEW.name='Rollback QA' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional registration rollback'; END IF; END"));
      const failed=await request("/api/auth/wechat/register",{onboardingToken:pendingA.onboardingToken,name:"Rollback QA"});assert.equal(failed.status,500);assert.deepEqual((await counts()),{users:0,tenants:0,coaches:0,stores:0,wechat_bindings:0,sessions:0});assert.equal((await server.database.prepare("SELECT used_at FROM wechat_onboarding").get()).used_at,null);assert.equal((await server.database.prepare("SELECT value FROM meta WHERE `key`='version'").get()).value,"0");
      (await server.database.exec("DROP TRIGGER fail_wechat_registration;"));
      const registered=await request("/api/auth/wechat/register",{onboardingToken:pendingA.onboardingToken,name:"微信教练甲",tenantName:"甲的训练空间",specialty:"自由训练",role:"platform",tenantId:"forged-existing"});assert.equal(registered.status,200,JSON.stringify(registered.data));tokenA=registered.data.token;userA=registered.data.user;tenantA=registered.data.activeMembership.tenantId;
      assert.equal(registered.data.memberships.length,1);assert.equal(registered.data.activeMembership.role,"hq");assert.equal(registered.data.activeMembership.workspaceMode,"solo");assert.equal(registered.data.loginMethod,"wechat");assert.match(registered.headers.get("set-cookie"),/HttpOnly/);assert.equal((await server.database.prepare("SELECT password_hash FROM users WHERE id=?").get(userA.id)).password_hash,"!wechat-only");
      const current=await workspace(tokenA);assert.equal(current.data.stores.length,0);assert.equal(current.data.coaches.length,1);assert.equal(current.data.coaches[0].selfManaged,true);assert.equal(current.data.tenants[0].expiresAt,"9999-12-31");
      assert.equal((await request("/api/auth/login",{account:userA.account,password:"Unknown-random-password-2026"})).status,401);
      assert.equal((await request("/api/auth/wechat/register",{onboardingToken:pendingA.onboardingToken,name:"重复创建"})).status,409);assert.equal((await counts()).users,1);assert.equal((await counts()).tenants,1);
      const returning=await request("/api/auth/wechat",{code:"A:returning"});assert.equal(returning.status,200);assert.equal(returning.data.user.id,userA.id);assert.equal(returning.data.activeMembership.tenantId,tenantA);assert.equal(returning.data.needsOnboarding,undefined);
    });
    await t.test("同微信多个ticket并发只开通一次，不同新微信形成独立租户",async()=>{
      const ticket1=(await request("/api/auth/wechat",{code:"B:ticket-one"})).data,ticket2=(await request("/api/auth/wechat",{code:"B:ticket-two"})).data;
      const concurrent=await Promise.all([request("/api/auth/wechat/register",{onboardingToken:ticket1.onboardingToken,name:"微信教练乙"}),request("/api/auth/wechat/register",{onboardingToken:ticket2.onboardingToken,name:"微信教练乙"})]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);const success=concurrent.find(r=>r.status===200).data;tokenB=success.token;tenantB=success.activeMembership.tenantId;assert.notEqual(tenantB,tenantA);assert.equal((await counts()).users,2);assert.equal((await counts()).tenants,2);assert.equal((await counts()).stores,0);
      let ownA=await action(tokenA,"member.create",{name:"甲私有学员",phone:"13900000051"}),ownB=await action(tokenB,"member.create",{name:"乙私有学员",phone:"13900000052"});assert.equal(ownA.data.members.length,1);assert.equal(ownB.data.members.length,1);assert.notEqual(ownA.data.members[0].id,ownB.data.members[0].id);await action(tokenA,"member.update",{id:ownB.data.members[0].id,name:"越权接管"},403);assert.equal((await workspace(tokenA)).data.tenants[0].id,tenantA);
    });
    await t.test("ticket过期/伪造、微信失败及停用账号都不伪造成功或重复建户",async()=>{
      const pending=(await request("/api/auth/wechat",{code:"C:expires"})).data;now=new Date(now.getTime()+6*60000);const before=(await counts());assert.equal((await request("/api/auth/wechat/register",{onboardingToken:pending.onboardingToken,name:"过期开通"})).status,410);assert.equal((await request("/api/auth/wechat/register",{onboardingToken:"forged",name:"伪造开通"})).status,401);
      assert.equal((await request("/api/auth/wechat",{code:"invalid-code"})).status,401);assert.equal((await request("/api/auth/wechat",{code:"upstream-down"})).status,502);assert.deepEqual((await counts()),before);
      (await server.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(userA.id));assert.equal((await request("/api/auth/wechat",{code:"A:disabled"})).status,403);assert.equal((await counts()).users,2);(await server.database.prepare("UPDATE users SET status='active' WHERE id=?").run(userA.id));
    });
  }finally{await new Promise(resolve=>server.close(resolve));(await server.closeDatabase());}
});

test("微信未绑定不接管既有机构管理员，明确绑定后保持旧授权",async(context,fixture)=>{
  const server=await createLocalServer({databaseOptions:fixture.options,wechatCodeExchange:async code=>({openid:code.split(":")[0]})});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const base=`http://127.0.0.1:${server.address().port}`;let token;

  async function request(path,body,auth=token){const response=await fetch(base+path,{method:body?"POST":"GET",headers:{...(auth?{Authorization:`Bearer ${auth}`} : {}),...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json()};}
  try{
    const setup=await request("/api/setup",{name:"既有机构管理员",account:"legacy_wechat_admin",password:"Legacy-Wechat-2026!",tenantName:"既有机构",storeName:"已有门店"});assert.equal(setup.status,200);token=setup.data.token;const originalId=setup.data.user.id,originalTenant=setup.data.activeMembership.tenantId;
    const unknown=await request("/api/auth/wechat",{code:"new-unbound:first"},null);assert.equal(unknown.data.needsOnboarding,true);assert.equal(unknown.data.user,undefined);assert.equal((await server.database.prepare("SELECT count(*) AS n FROM users").get()).n,1);
    const newSolo=await request("/api/auth/wechat/register",{onboardingToken:unknown.data.onboardingToken,name:"新微信本人"},null);assert.equal(newSolo.status,200);assert.notEqual(newSolo.data.user.id,originalId);assert.notEqual(newSolo.data.activeMembership.tenantId,originalTenant);assert.equal(newSolo.data.activeMembership.workspaceMode,"solo");assert.equal(newSolo.data.memberships.length,1);
    assert.equal((await request("/api/auth/wechat/bind",{code:"legacy-bound:bind"})).status,200);const oldLogin=await request("/api/auth/wechat",{code:"legacy-bound:login"},null);assert.equal(oldLogin.status,200);assert.equal(oldLogin.data.user.id,originalId);assert.equal(oldLogin.data.activeMembership.tenantId,originalTenant);assert.equal(oldLogin.data.memberships.length,2);assert.equal(oldLogin.data.activeMembership.workspaceMode,"organization");assert.equal((await server.database.prepare("SELECT count(*) AS n FROM users").get()).n,2);
  }finally{await new Promise(resolve=>server.close(resolve));(await server.closeDatabase());}
});

test("微信先开通不占用后台首次初始化，后台仅获新空间授权",async(t,fixture)=>{
  let now=new Date("2026-10-25T02:00:00Z");
  const server=(await createLocalServer({databaseOptions:fixture.options,clock:()=>now,wechatCodeExchange:async code=>({openid:code.split(":")[0]})}));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const base=`http://127.0.0.1:${server.address().port}`;
  async function request(path,body,token){const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};}
  const adminPayload={name:"后来开通的后台管理员",account:"admin_after_wechat",password:"Admin-After-Wechat-2026!",tenantName:"独立后台机构",storeName:"后台一店"};
  const tableCounts=async()=>Object.fromEntries(await Promise.all(["users","tenants","stores","coaches","members","audit","memberships","sessions"].map(async table=>[table,(await server.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n])));
  let wechat,originalWorkspace,originalCounts,createdAt,admin;
  try{
    await t.test("微信私有空间与已有学员保留，后台初始化失败可完整回滚后重试",async()=>{
      const pending=await request("/api/auth/wechat",{code:"wechat-first:register"});
      const registration=await request("/api/auth/wechat/register",{onboardingToken:pending.data.onboardingToken,name:"微信原有教练"});assert.equal(registration.status,200);wechat=registration.data;
      const workspace=(await request("/api/workspace",undefined,wechat.token)).data;
      const member=await request("/api/actions",{action:"member.create",payload:{name:"微信原有学员",phone:"13900000071"},version:workspace.version},wechat.token);assert.equal(member.status,200,JSON.stringify(member.data));
      originalWorkspace=(await request("/api/workspace",undefined,wechat.token)).data;originalCounts=(await tableCounts());createdAt=(await server.database.prepare("SELECT value FROM meta WHERE `key`='createdAt'").get()).value;
      assert.equal((await request("/api/setup")).data.initialized,false);
      assert.equal((await request("/api/setup",{...adminPayload,account:wechat.user.account})).status,400);
      const oldVersion=originalWorkspace.version;
      (await server.database.exec("CREATE TRIGGER fail_admin_setup BEFORE INSERT ON users FOR EACH ROW BEGIN IF NEW.account='admin_after_wechat' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional admin setup rollback'; END IF; END"));
      assert.equal((await request("/api/setup",adminPayload)).status,500);assert.deepEqual((await tableCounts()),originalCounts);assert.equal((await request("/api/setup")).data.initialized,false);assert.equal((await request("/api/workspace",undefined,wechat.token)).data.version,oldVersion);
      (await server.database.exec("DROP TRIGGER fail_admin_setup;"));
    });
    await t.test("追加后台机构不覆盖微信数据或授予跨租户平台权限，账密登录仍正常",async()=>{
      now=new Date(now.getTime()+3600000);
      const setup=await request("/api/setup",adminPayload);assert.equal(setup.status,200,JSON.stringify(setup.data));admin=setup.data;
      assert.equal(admin.loginMethod,"password");assert.equal(admin.memberships.length,1);assert.equal(admin.activeMembership.role,"hq");assert.notEqual(admin.activeMembership.tenantId,wechat.activeMembership.tenantId);assert.ok(admin.memberships.every(item=>item.role!=="platform"));
      assert.equal((await request("/api/setup")).data.initialized,true);
      const counts=(await tableCounts());assert.equal(counts.users,originalCounts.users+1);assert.equal(counts.tenants,originalCounts.tenants+1);assert.equal(counts.stores,originalCounts.stores+1);assert.equal(counts.coaches,originalCounts.coaches);assert.equal(counts.members,originalCounts.members);assert.equal(counts.audit,originalCounts.audit+1);
      assert.equal((await server.database.prepare("SELECT value FROM meta WHERE `key`='createdAt'").get()).value,createdAt);
      assert.deepEqual((await request("/api/workspace",undefined,wechat.token)).data.data,originalWorkspace.data);
      const own=(await request("/api/workspace",undefined,admin.token)).data;assert.deepEqual(own.data.tenants.map(item=>item.id),[admin.activeMembership.tenantId]);assert.equal(own.data.members.length,0);assert.equal(own.data.coaches.length,0);assert.deepEqual(own.data.accounts.map(item=>item.id),[admin.user.id]);
      assert.equal((await request("/api/auth/context",{membershipId:wechat.activeMembership.id},admin.token)).status,403);
      const login=await request("/api/auth/login",{account:adminPayload.account,password:adminPayload.password});assert.equal(login.status,200);assert.equal(login.data.user.id,admin.user.id);assert.equal(login.data.memberships.length,1);
    });
    await t.test("原微信仍登录自己空间，重复初始化及停用或未知密码格式均不重开门槛",async()=>{
      const returning=await request("/api/auth/wechat",{code:"wechat-first:returning"});assert.equal(returning.status,200);assert.equal(returning.data.user.id,wechat.user.id);assert.equal(returning.data.activeMembership.tenantId,wechat.activeMembership.tenantId);assert.equal(returning.data.memberships.length,1);
      assert.equal((await request("/api/auth/context",{membershipId:admin.activeMembership.id},returning.data.token)).status,403);
      assert.equal((await request("/api/setup",adminPayload)).status,409);
      (await server.database.prepare("UPDATE users SET status='disabled',password_hash='!unrecognized' WHERE id=?").run(admin.user.id));
      assert.equal((await request("/api/setup")).data.initialized,true);assert.equal((await request("/api/setup",{})).status,409);assert.equal((await server.database.prepare("SELECT count(*) AS n FROM users").get()).n,2);
    });
  }finally{await new Promise(resolve=>server.close(resolve));(await server.closeDatabase());}
});

test("默认微信交换实现只在服务端调用官方code2Session，不向客户端泄露凭证",async(context,fixture)=>{
  const nativeFetch=globalThis.fetch,previousId=process.env.WECHAT_APP_ID,previousSecret=process.env.WECHAT_APP_SECRET,upstream=[];
  process.env.WECHAT_APP_ID="fixture-app-id";process.env.WECHAT_APP_SECRET="fixture-server-only-secret";
  globalThis.fetch=async(input,options)=>{
    const url=new URL(typeof input==="string"||input instanceof URL?input:input.url);
    if(url.hostname!=="api.weixin.qq.com")return nativeFetch(input,options);
    upstream.push(url);return url.searchParams.get("js_code")==="upstream-failure"?new Response("unavailable",{status:503}):Response.json({openid:"upstream-private-openid",session_key:"upstream-private-session-key",errcode:0});
  };
  const server=(await createLocalServer({databaseOptions:fixture.options}));await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const response=await nativeFetch(base+"/api/auth/wechat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"real-adapter-fixture"})});assert.equal(response.status,200);const data=await response.json();assert.equal(data.needsOnboarding,true);assert.equal(upstream.length,1);assert.equal(upstream[0].pathname,"/sns/jscode2session");assert.equal(upstream[0].searchParams.get("appid"),"fixture-app-id");assert.equal(upstream[0].searchParams.get("secret"),"fixture-server-only-secret");assert.equal(upstream[0].searchParams.get("grant_type"),"authorization_code");assert.ok(!/openid|session_key|fixture-server-only-secret/.test(JSON.stringify(data)));
    const failed=await nativeFetch(base+"/api/auth/wechat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"upstream-failure"})});assert.equal(failed.status,502);assert.equal((await server.database.prepare("SELECT count(*) AS n FROM users").get()).n,0);
  }finally{
    await new Promise(resolve=>server.close(resolve));(await server.closeDatabase());globalThis.fetch=nativeFetch;
    if(previousId===undefined)delete process.env.WECHAT_APP_ID;else process.env.WECHAT_APP_ID=previousId;
    if(previousSecret===undefined)delete process.env.WECHAT_APP_SECRET;else process.env.WECHAT_APP_SECRET=previousSecret;
  }
});

test("真实收款凭证附件：MySQL持久文件、财务授权及开卡原子关联",async(t,fixture)=>{
  const now=new Date("2026-10-28T02:00:00Z"),password="Receipt-Test-2026!";

  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAt0AAAAASUVORK5CYII=","base64"),pdf=Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  let server=(await createLocalServer({databaseOptions:fixture.options,clock:()=>now})),base,adminToken,managerToken,manager2Token,studentToken,coachToken,otherToken,tenantId,storeId,store2,memberId,member2,otherMember,linked,draft,otherAttachment;
  async function listen(){await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${server.address().port}`;}
  async function request(path,{body,token=adminToken,headers={},raw=false}={}){const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body!==undefined&&!raw?{"Content-Type":"application/json"}:{}),...headers},...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})});return{status:response.status,data:await response.json(),headers:response.headers};}
  async function workspace(token=adminToken){const result=await request("/api/workspace",{token});assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
  async function action(action,payload,token=adminToken,expected=200){const current=await workspace(token),result=await request("/api/actions",{token,body:{action,payload,version:current.version}});assert.equal(result.status,expected,JSON.stringify(result.data));return result.data;}
  async function login(account){const result=await request("/api/auth/login",{token:null,body:{account,password}});assert.equal(result.status,200,JSON.stringify(result.data));return result.data.token;}
  async function upload({content=png,name="收款截图.png",mime="image/png",member=memberId,store,token=adminToken}={}){const form=new FormData();form.append("file",new Blob([content],{type:mime}),name);form.append("memberId",member);if(store!==undefined)form.append("storeId",store);return request("/api/receipt-attachments",{token,body:form,raw:true});}
  async function download(attachmentId,token=adminToken,headers={}){return fetch(base+`/api/receipt-attachments/${attachmentId}`,{headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...headers}});}
  function issue(overrides={}){return{memberId,storeId,name:"凭证测试课包",total:5,amount:10000,expiresAt:"2027-10-28",scope:"all",classTypes:["力量训练"],...overrides};}
  async function transactionSnapshot(){return{version:(await server.database.prepare("SELECT value FROM meta WHERE `key`='version'").get()).value,...Object.fromEntries(await Promise.all(["cards","orders","ledger","audit"].map(async table=>[table,(await server.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n])))};}
  try{
    await listen();const setup=await request("/api/setup",{token:null,body:{name:"凭证管理员",account:"receipt_admin",password,tenantName:"凭证品牌",storeName:"凭证一店"}});assert.equal(setup.status,200);adminToken=setup.data.token;tenantId=setup.data.activeMembership.tenantId;storeId=(await workspace()).data.stores[0].id;
    let result=await action("store.create",{name:"凭证二店",address:"测试路2号",manager:"二店负责人",phone:"13900000081"});store2=result.data.stores.find(store=>store.id!==storeId).id;
    result=await action("member.create",{storeId,name:"凭证学员",phone:"13900000082"});memberId=result.data.members[0].id;
    result=await action("member.create",{storeId:store2,name:"二店学员",phone:"13900000083"});member2=result.data.members.find(member=>member.storeId===store2).id;
    result=await action("coach.invite",{storeId,name:"凭证教练",phone:"13900000084",specialty:"力量训练",certificate:"已核验",certificateExpiresAt:"2027-10-28"});const coachId=result.data.coaches[0].id;await action("coach.review",{id:coachId,approved:true});
    await action("account.create",{storeId,name:"凭证店长",account:"receipt_manager",password,role:"manager"});managerToken=await login("receipt_manager");
    await action("account.create",{storeId:store2,name:"二店店长",account:"receipt_manager2",password,role:"manager"});manager2Token=await login("receipt_manager2");
    await action("account.create",{storeId,name:"凭证学员",account:"receipt_student",password,role:"student",memberId});studentToken=await login("receipt_student");
    await action("account.create",{storeId,name:"凭证教练",account:"receipt_coach",password,role:"coach",coachId});coachToken=await login("receipt_coach");
    const platform=setup.data.memberships.find(m=>m.role==="platform"),hq=setup.data.activeMembership;await request("/api/auth/context",{body:{membershipId:platform.id}});
    result=await action("tenant.create",{name:"其他凭证品牌",contact:"其他总部",phone:"13900000085",plan:"专业版",expiresAt:"2027-10-28"});const otherTenant=result.data.tenants.find(tenant=>tenant.id!==tenantId).id;
    result=await action("store.create",{tenantId:otherTenant,name:"其他品牌店",address:"测试路3号",manager:"其他总部",phone:"13900000085"});const otherStore=result.data.stores.find(store=>store.tenantId===otherTenant).id;
    await action("account.create",{tenantId:otherTenant,name:"其他总部",account:"receipt_other",password,role:"hq"});otherToken=await login("receipt_other");result=await action("member.create",{storeId:otherStore,name:"其他品牌学员",phone:"13900000086"},otherToken);otherMember=result.data.members[0].id;await request("/api/auth/context",{body:{membershipId:hq.id}});

    await t.test("收款凭证选填，空值可重复开卡与续卡，非空凭证仍去重",async()=>{
      let own=await action("card.issue",issue());assert.equal(own.data.orders[0].receipt,"");const first=own.data.cards[0];
      own=await action("card.issue",issue({receipt:"  "}));assert.equal(own.data.orders[0].receipt,"");
      own=await action("card.renew",{...issue(),id:first.id});assert.equal(own.data.orders[0].receipt,"");
      await action("card.issue",issue({receipt:"offline-proof-unique"}));await action("card.issue",issue({receipt:" offline-proof-unique "}),adminToken,400);
    });
    await t.test("上传必须认证与财务范围，缺失或跨店跨品牌学员及停用品牌拒绝",async()=>{
      assert.equal((await upload({token:null})).status,401);assert.equal((await upload({token:studentToken})).status,403);assert.equal((await upload({token:coachToken})).status,403);
      assert.equal((await upload({member:"member-missing"})).status,403);assert.equal((await upload({member:otherMember})).status,403);assert.equal((await upload({member:member2,token:managerToken})).status,403);assert.equal((await upload({store:store2,token:managerToken})).status,403);
      const row=(await server.database.prepare("SELECT data FROM tenants WHERE id=?").get(tenantId)),tenant=JSON.parse(row.data);(await server.database.prepare("UPDATE tenants SET data=? WHERE id=?").run(JSON.stringify({...tenant,status:"paused"}),tenantId));
      assert.equal((await upload()).status,403);(await server.database.prepare("UPDATE tenants SET data=? WHERE id=?").run(row.data,tenantId));assert.equal((await server.database.prepare("SELECT count(*) AS n FROM receipt_attachments").get()).n,0);
    });
    await t.test("签名与声明及扩展名一致，支持微信默认MIME和无扩展名临时文件",async()=>{
      const result=await upload({mime:"application/octet-stream",name:"wx_tmp_receipt"});assert.equal(result.status,200,JSON.stringify(result.data));draft=result.data;assert.equal(draft.mime,"image/png");assert.equal(draft.name,"wx_tmp_receipt.png");assert.equal(draft.size,png.length);assert.deepEqual(Object.keys(draft).sort(),["id","mime","name","size"]);
      const validPDF=await upload({content:pdf,mime:"application/pdf",name:"转账凭证.pdf"});assert.equal(validPDF.status,200);assert.equal(validPDF.data.mime,"application/pdf");
      const jpeg=Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9","hex"),webp=Buffer.concat([Buffer.from("RIFF"),Buffer.from([12,0,0,0]),Buffer.from("WEBPVP8L"),Buffer.from([0,0,0,0])]);
      assert.equal((await upload({content:jpeg,mime:"image/jpeg",name:"收款.jpg"})).status,200);assert.equal((await upload({content:webp,mime:"image/webp",name:"收款.webp"})).status,200);
      const count=(await server.database.prepare("SELECT count(*) AS n FROM receipt_attachments").get()).n;
      for(const input of [{content:Buffer.alloc(0)},{content:Buffer.from("<svg><script>unsafe</script></svg>")},{mime:"application/pdf"},{name:"pretend.pdf"},{name:"receipt.exe"}])assert.equal((await upload(input)).status,400);
      const boundary="receipt-test-boundary",raw=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="memberId"\r\n\r\n${memberId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../escape.png"\r\nContent-Type: image/png\r\n\r\n`),png,Buffer.from(`\r\n--${boundary}--\r\n`)]);
      assert.equal((await request("/api/receipt-attachments",{body:raw,raw:true,headers:{"Content-Type":`multipart/form-data; boundary=${boundary}`}})).status,400);
      assert.equal((await request("/api/receipt-attachments",{body:Buffer.from("broken"),raw:true,headers:{"Content-Type":"multipart/form-data; boundary=broken"}})).status,400);
      assert.equal((await request("/api/receipt-attachments",{body:Buffer.from("broken"),raw:true,headers:{"Content-Type":"application/json"}})).status,400);
      assert.equal((await server.database.prepare("SELECT count(*) AS n FROM receipt_attachments").get()).n,count);
    });
    await t.test("10MB边界及总请求超限都返回413，错误请求不生成附件",async()=>{
      const exact=Buffer.alloc(10*1024*1024);png.copy(exact);const accepted=await upload({content:exact});assert.equal(accepted.status,200);assert.equal(accepted.data.size,exact.length);assert.equal((await request(`/api/receipt-attachments/${accepted.data.id}/remove`,{body:{}})).status,200);
      const count=(await server.database.prepare("SELECT count(*) AS n FROM receipt_attachments").get()).n;
      const above=Buffer.alloc(exact.length+1);png.copy(above);assert.equal((await upload({content:above})).status,413);
      assert.equal((await upload({content:Buffer.alloc(exact.length+65537)})).status,413);assert.equal((await server.database.prepare("SELECT count(*) AS n FROM receipt_attachments").get()).n,count);
    });
    await t.test("仅附件可开卡，最多3个唯一且同学员同店同租户草稿，禁止伪造元数据",async()=>{
      const proof=(await upload()).data,other=(await upload({member:member2})).data;otherAttachment=(await upload({member:otherMember,token:otherToken})).data;
      await action("card.issue",issue({receiptAttachmentIds:["receipt-missing"]}),adminToken,403);
      await action("card.issue",issue({receiptAttachmentIds:[other.id]}),adminToken,403);await action("card.issue",issue({receiptAttachmentIds:[otherAttachment.id]}),adminToken,403);
      await action("card.issue",issue({storeId:store2,receiptAttachmentIds:[proof.id]}),adminToken,403);await action("card.issue",issue({receiptAttachmentIds:[proof.id]}),studentToken,403);
      await action("card.issue",issue({receiptAttachmentIds:[proof.id,proof.id]}),adminToken,400);await action("card.issue",issue({receiptAttachmentIds:[proof.id,draft.id,other.id,otherAttachment.id]}),adminToken,400);
      await action("card.issue",issue({receiptAttachments:[{id:proof.id,name:"forged",mime:"image/png",size:1}]}),adminToken,403);
      const second=(await upload({content:pdf,name:"汇款证明.pdf",mime:"application/pdf"})).data,third=(await upload()).data;
      const own=await action("card.issue",issue({receiptAttachmentIds:[proof.id,second.id,third.id]}));const order=own.data.orders[0];linked={...proof,orderId:order.id};assert.equal(order.receipt,"");assert.deepEqual(order.receiptAttachments,[proof,second,third]);assert.deepEqual(order.receiptAttachmentIds,[proof.id,second.id,third.id]);
      assert.equal((await server.database.prepare("SELECT order_id FROM receipt_attachments WHERE id=?").get(proof.id)).order_id,order.id);assert.ok(!/content|uploader_id|BLOB/.test(JSON.stringify(order.receiptAttachments)));
      const student=(await workspace(studentToken)).data.orders.find(item=>item.id===order.id);assert.ok(student);assert.equal(student.receiptAttachments,undefined);assert.equal(student.receiptAttachmentIds,undefined);assert.equal((await workspace(coachToken)).data.orders.length,0);
      await action("card.issue",issue({receiptAttachmentIds:[proof.id]}),adminToken,409);
    });
    await t.test("下载要求财务范围并返回原始内容与安全响应头，不接受查询参数令牌",async()=>{
      const response=await download(linked.id);assert.equal(response.status,200);assert.equal(response.headers.get("Content-Type"),"image/png");assert.equal(response.headers.get("X-Content-Type-Options"),"nosniff");assert.equal(response.headers.get("Cache-Control"),"private, no-store");assert.match(response.headers.get("Content-Disposition"),/attachment; filename=/);assert.match(response.headers.get("Content-Disposition"),/filename\*=UTF-8''/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
      assert.equal((await download(linked.id,managerToken)).status,200);assert.equal((await download(linked.id,null,{Cookie:`ldd_session=${adminToken}`})).status,200);
      for(const token of [manager2Token,otherToken,studentToken,coachToken])assert.equal((await download(linked.id,token)).status,403);
      assert.equal((await download(linked.id,null)).status,401);assert.equal((await download("receipt-missing")).status,403);
      assert.equal((await fetch(base+`/api/receipt-attachments/${linked.id}?token=${adminToken}`)).status,401);assert.equal((await fetch(base+`/api/receipt-attachments/${linked.id}?token=ignored`,{headers:{Authorization:`Bearer ${adminToken}`}})).status,400);
    });
    await t.test("仅上传者可删未关联草稿，历史已关联凭证不可删改",async()=>{
      const own=(await upload({token:managerToken})).data;assert.equal((await request(`/api/receipt-attachments/${own.id}/remove`,{body:{}})).status,403);
      assert.equal((await request(`/api/receipt-attachments/${own.id}/remove`,{body:{},token:managerToken})).status,200);assert.equal((await download(own.id)).status,403);
      assert.equal((await request(`/api/receipt-attachments/${draft.id}/remove`,{body:{}})).status,200);assert.equal((await download(draft.id)).status,403);
      assert.equal((await request(`/api/receipt-attachments/${linked.id}/remove`,{body:{}})).status,409);assert.equal((await request(`/api/receipt-attachments/${linked.id}/remove`,{body:{},token:studentToken})).status,403);
      await assert.rejects(async()=>(await server.database.prepare("DELETE FROM receipt_attachments WHERE id=?").run(linked.id)),/linked receipt/);await assert.rejects(async()=>(await server.database.prepare("UPDATE receipt_attachments SET name='changed.png' WHERE id=?").run(linked.id)),/immutable/);
    });
    await t.test("后置关联失败整体回滚，同版本并发只建一单且不会半关联",async()=>{
      const first=(await upload()).data,second=(await upload()).data,before=(await transactionSnapshot());(await server.database.exec(`CREATE TRIGGER fail_receipt_link BEFORE UPDATE ON receipt_attachments FOR EACH ROW BEGIN IF NEW.id='${second.id}' AND NOT (NEW.order_id <=> OLD.order_id) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional receipt link rollback'; END IF; END`));
      await action("card.issue",issue({receiptAttachmentIds:[first.id,second.id]}),adminToken,500);assert.deepEqual((await transactionSnapshot()),before);for(const proof of [first,second])assert.equal((await server.database.prepare("SELECT order_id FROM receipt_attachments WHERE id=?").get(proof.id)).order_id,null);
      (await server.database.exec("DROP TRIGGER fail_receipt_link;"));const own=await workspace(),payload={action:"card.issue",payload:issue({receiptAttachmentIds:[first.id,second.id]}),version:own.version},concurrent=await Promise.all([request("/api/actions",{body:payload}),request("/api/actions",{body:payload})]);assert.deepEqual(concurrent.map(result=>result.status).sort(),[200,409]);
      const order=concurrent.find(result=>result.status===200).data.data.orders[0];for(const proof of [first,second])assert.equal((await server.database.prepare("SELECT order_id FROM receipt_attachments WHERE id=?").get(proof.id)).order_id,order.id);const after=(await transactionSnapshot());assert.equal(after.cards,before.cards+1);assert.equal(after.orders,before.orders+1);assert.equal(after.ledger,before.ledger+1);
      const renewalProof=(await upload()).data;const renewed=await action("card.renew",{...issue({receiptAttachmentIds:[renewalProof.id]}),id:order.cardId});assert.equal(renewed.data.orders[0].receiptAttachments[0].id,renewalProof.id);
    });
    await t.test("服务器重启后同MySQL保留原始文件及关联与登录权限",async()=>{
      await new Promise(resolve=>server.close(resolve));(await server.closeDatabase());server=(await createLocalServer({databaseOptions:fixture.options,clock:()=>now}));await listen();const response=await download(linked.id);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
      const order=(await workspace()).data.orders.find(order=>order.id===linked.orderId);assert.equal(order.receiptAttachments[0].id,linked.id);assert.equal((await download(linked.id,otherToken)).status,403);assert.equal((await request(`/api/receipt-attachments/${linked.id}/remove`,{body:{}})).status,409);
    });
  }finally{await new Promise(resolve=>server.close(resolve));(await server.closeDatabase());}
});

test("独立教练无门店：凭证上传到开卡与续卡关联不依赖虚拟Store",async(context,fixture)=>{
  const server=(await createLocalServer({databaseOptions:fixture.options,clock:()=>new Date("2026-10-28T02:00:00Z")}));await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const base=`http://127.0.0.1:${server.address().port}`;let token;
  async function request(path,body,raw=false){const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body===undefined||raw?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};}
  async function action(action,payload){const workspace=await request("/api/workspace"),result=await request("/api/actions",{action,payload,version:workspace.data.version});assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
  async function upload(memberId){const form=new FormData();form.append("memberId",memberId);form.append("file",new Blob(["%PDF-1.7\nsolo receipt\n%%EOF\n"],{type:"application/octet-stream"}),"wx_solo_tmp");const result=await request("/api/receipt-attachments",form,true);assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
  try{
    const setup=await request("/api/setup",{mode:"solo",name:"独立凭证教练",account:"solo_receipts",password:"Solo-Receipts-2026!"});assert.equal(setup.status,200);token=setup.data.token;
    const created=await action("member.create",{name:"独立凭证学员",phone:"13900000087"}),memberId=created.data.members[0].id,proof=await upload(memberId),payload={memberId,storeId:"",name:"独立课卡",total:3,amount:9000,expiresAt:"2027-10-28",scope:"all",classTypes:["自由训练"]};
    let result=await action("card.issue",{...payload,receiptAttachmentIds:[proof.id]});assert.equal(result.data.orders[0].receipt,"");assert.deepEqual(result.data.orders[0].receiptAttachments,[proof]);assert.equal(result.data.orders[0].storeId,"");const cardId=result.data.cards[0].id;
    const renewalProof=await upload(memberId);result=await action("card.renew",{...payload,id:cardId,receiptAttachmentIds:[renewalProof.id]});assert.deepEqual(result.data.orders[0].receiptAttachments,[renewalProof]);assert.equal(result.data.stores.length,0);assert.equal((await server.database.prepare("SELECT count(*) AS n FROM stores").get()).n,0);assert.equal((await server.database.prepare("SELECT count(*) AS n FROM receipt_attachments WHERE store_id='' AND order_id IS NOT NULL").get()).n,2);
    const response=await fetch(base+`/api/receipt-attachments/${proof.id}`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(response.status,200);assert.equal(response.headers.get("Content-Type"),"application/pdf");assert.equal(await response.text(),"%PDF-1.7\nsolo receipt\n%%EOF\n");
  }finally{await new Promise(resolve=>server.close(resolve));(await server.closeDatabase());}
});

test("MySQL存储层：NULL授权唯一性、账号大小写、不可改账本与事务回滚",async(context,fixture)=>{
  const server=await createLocalServer({databaseOptions:fixture.options});
  const database=server.database,stamp="2026-10-28T02:00:00.000Z";
  try {
    const engine=await database.prepare("SELECT @@version_comment AS product").get();assert.match(engine.product,/MySQL/i);
    await database.prepare("INSERT INTO users(id,account,name,password_hash,status,created_at) VALUES(?,?,?,?,?,?)").run("schema-user","schema_user","约束验证","!wechat-only","active",stamp);
    await assert.rejects(()=>database.prepare("INSERT INTO users(id,account,name,password_hash,status,created_at) VALUES(?,?,?,?,?,?)").run("schema-user-duplicate","SCHEMA_USER","重复账号","!wechat-only","active",stamp),{code:"ER_DUP_ENTRY"});
    await database.prepare("INSERT INTO tenants(id,tenant_id,store_id,data) VALUES(?,?,?,?)").run("schema-tenant",null,null,JSON.stringify({id:"schema-tenant",mode:"solo"}));
    const membership=["schema-user","hq","schema-tenant",null,null,null,null,"约束验证","active"];
    await database.prepare("INSERT INTO memberships(id,user_id,role,tenant_id,store_id,coach_id,member_id,member_ids,label,status) VALUES(?,?,?,?,?,?,?,?,?,?)").run("schema-membership",...membership);
    await assert.rejects(()=>database.prepare("INSERT INTO memberships(id,user_id,role,tenant_id,store_id,coach_id,member_id,member_ids,label,status) VALUES(?,?,?,?,?,?,?,?,?,?)").run("schema-membership-duplicate",...membership),{code:"ER_DUP_ENTRY"});
    assert.equal((await database.prepare("SELECT count(*) AS n FROM memberships").get()).n,1);
    for(const table of ["ledger","audit","feedback"]){
      const id=`schema-${table}`;await database.prepare(`INSERT INTO ${table}(id,tenant_id,store_id,data) VALUES(?,?,?,?)`).run(id,"schema-tenant",null,JSON.stringify({id}));
      await assert.rejects(()=>database.prepare(`UPDATE ${table} SET data='{}' WHERE id=?`).run(id),/append-only/);
      await assert.rejects(()=>database.prepare(`DELETE FROM ${table} WHERE id=?`).run(id),/append-only/);
    }
    await assert.rejects(()=>database.transaction(async()=>{
      await database.prepare("INSERT INTO members(id,tenant_id,store_id,data) VALUES(?,?,?,?)").run("schema-rolled-back","schema-tenant",null,JSON.stringify({id:"schema-rolled-back"}));
      await database.transaction(async()=>{await database.prepare("UPDATE meta SET value='99' WHERE `key`='version'").run();});
      throw new Error("intentional database rollback");
    }),/intentional database rollback/);
    assert.equal((await database.prepare("SELECT count(*) AS n FROM members").get()).n,0);
    assert.equal((await database.prepare("SELECT value FROM meta WHERE `key`='version'").get()).value,"0");
  } finally { await server.closeDatabase(); }
});
