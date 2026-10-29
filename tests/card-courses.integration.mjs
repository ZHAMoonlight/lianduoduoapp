import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../server/app.mjs';
import { createMysqlFixture } from './mysql.helpers.mjs';

test('真实MySQL：课包课程多选、精确预约范围、续购及目录权限', async t => {
  const fixture=await createMysqlFixture();let server,base,token;
  const now=new Date('2026-10-29T01:00:00Z'),password='Card-Course-Test-Only-2026!';
  async function start(){server=await createLocalServer({databaseOptions:fixture.options,clock:()=>now});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;}
  async function stop(){if(server){await new Promise(r=>server.close(r));await server.closeDatabase();server=null;}}
  t.after(async()=>{await stop();await fixture.dispose();});await start();
  async function request(path,body,auth=token){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(auth?{Authorization:`Bearer ${auth}`} : {}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};}
  async function workspace(auth=token){const r=await request('/api/workspace',undefined,auth);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
  async function action(action,payload,auth=token,expected=200){const w=await workspace(auth),r=await request('/api/actions',{action,payload,version:w.version},auth);assert.equal(r.status,expected,JSON.stringify(r.data));return r.data;}
  const setup=await request('/api/setup',{mode:'organization',name:'选课管理员',account:'course_owner',password,tenantName:'课包选课测试',storeName:'一店'},null);assert.equal(setup.status,200);token=setup.data.token;
  let w=await workspace();const storeId=w.data.stores[0].id;
  w=await action('store.create',{name:'二店',address:'二店地址',manager:'二店店长',phone:'13900007800'});const secondStore=w.data.stores.find(s=>s.id!==storeId).id;
  const coaches=[];
  for(const [index,store] of [storeId,secondStore].entries()){w=await action('coach.invite',{name:`选课教练${index}`,phone:`1390000781${index}`,storeId:store,specialty:'力量、普拉提',certificate:'测试证书',certificateExpiresAt:'2099-12-31'});const id=w.data.coaches.find(c=>c.storeId===store).id;coaches.push(id);await action('coach.review',{id,approved:true});}
  const venueIds={};for(const store of [storeId,secondStore]){w=await action('venue.create',{storeId:store,name:'训练区'});venueIds[store]=w.data.venues.find(v=>v.storeId===store).id;}
  const classes={};
  for(const [key,name,type,store,coachId,date] of [
    ['basic','力量基础','力量',storeId,coaches[0],'2026-11-02'],
    ['repeat','力量基础','力量',storeId,coaches[0],'2026-11-03'],
    ['advanced','力量进阶','力量',storeId,coaches[0],'2026-11-04'],
    ['pilates','普拉提基础','普拉提',storeId,coaches[0],'2026-11-05'],
    ['other','二店专属课程','力量',secondStore,coaches[1],'2026-11-06']
  ]){w=await action('class.create',{name,type,storeId:store,coachId,startAt:`${date}T18:00:00+08:00`,endAt:`${date}T19:00:00+08:00`,capacity:4,credits:1,price:10000,venueId:venueIds[store],room:'训练区'});classes[key]=w.data.classes.find(c=>c.name===name&&c.startAt.startsWith(date)).id;}
  w=await action('member.create',{name:'选课学员',phone:'13800007800',storeId});const memberId=w.data.members[0].id;
  async function account(account,role,extra){await action('account.create',{account,name:account,password,role,...extra});const r=await request('/api/auth/login',{account,password},null);assert.equal(r.status,200);return r.data.token;}
  const manager=await account('course_manager','manager',{storeId}),coach=await account('course_coach','coach',{storeId,coachId:coaches[0]}),student=await account('course_student','student',{storeId,memberId});
  const issue={memberId,storeId,name:'多课程课包',total:12,amount:120000,expiresAt:'2099-12-31',scope:'home'};let strictCard;
  await t.test('目录来自已创建课程，循环课去重且读取不修改账本或版本',async()=>{
    const before=await workspace(),r=await request(`/api/card-courses?storeId=${storeId}&scope=home`);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.courses.length,3);const basic=r.data.courses.find(c=>c.name==='力量基础');assert.equal(basic.sessionCount,2);assert.equal(r.data.courses.filter(c=>c.type==='力量').length,2);assert.ok(r.data.courses.every(c=>!Object.hasOwn(c,'price')&&!Object.hasOwn(c,'bookings')));const after=await workspace();assert.equal(after.version,before.version);assert.deepEqual(after.data.ledger,before.data.ledger);
  });
  await t.test('多选保存精确课程，兼容字段由服务端派生',async()=>{
    w=await action('card.issue',{...issue,courseIds:[classes.basic,classes.pilates]});strictCard=w.data.cards[0];assert.deepEqual(new Set(strictCard.classTypes),new Set(['力量','普拉提']));assert.deepEqual(new Set(strictCard.courseRules.map(r=>r.name)),new Set(['力量基础','普拉提基础']));assert.equal(strictCard.courseRules.length,2);
    await action('booking.create',{memberId,cardId:strictCard.id,classId:classes.repeat},student);await action('booking.create',{memberId,cardId:strictCard.id,classId:classes.pilates},student);
    const before=await workspace();await action('booking.create',{memberId,cardId:strictCard.id,classId:classes.advanced},student,400);const after=await workspace();assert.deepEqual(after.data.ledger,before.data.ledger);assert.equal(after.data.cards.find(c=>c.id===strictCard.id).frozen,2);
  });
  await t.test('选填默认全部课程，包含后续新增但仍遵守售卡门店范围',async()=>{
    w=await action('card.issue',{...issue,name:'默认全部课程卡',courseIds:[]});const allCard=w.data.cards.at(-1);assert.equal(allCard.courseMode,'all');assert.deepEqual(allCard.classTypes,[]);assert.equal(Object.hasOwn(allCard,'courseRules'),false);
    await action('booking.create',{memberId,cardId:allCard.id,classId:classes.advanced},student);
    w=await action('class.create',{name:'后续新增力量专项',type:'力量',storeId,coachId:coaches[0],startAt:'2026-11-07T18:00:00+08:00',endAt:'2026-11-07T19:00:00+08:00',capacity:4,credits:1,price:10000,venueId:venueIds[storeId],room:'训练区'});const future=w.data.classes.find(c=>c.name==='后续新增力量专项').id;
    await action('booking.create',{memberId,cardId:strictCard.id,classId:future},student,400);await action('booking.create',{memberId,cardId:allCard.id,classId:future},student);
    await action('booking.create',{memberId,cardId:allCard.id,classId:classes.other},student,400);
    w=await action('card.issue',{...issue,name:'省略课程也默认全部'});const omitted=w.data.cards.at(-1);assert.equal(omitted.courseMode,'all');assert.deepEqual(omitted.classTypes,[]);assert.equal(Object.hasOwn(omitted,'courseRules'),false);
  });
  await t.test('非法课程、伪造权益、越店课程、取消课引用均拒绝',async()=>{
    await action('card.issue',{...issue,courseIds:null},token,400);await action('card.issue',{...issue,courseIds:['missing-course']},token,404);
    await action('card.issue',{...issue,courseIds:[],courseMode:'all'},token,403);
    await action('card.issue',{...issue,courseIds:[classes.other]},manager,403);await action('card.issue',{...issue,courseIds:[classes.basic],courseRules:[{name:'力量进阶',type:'力量'}]},token,403);
    await action('class.cancel',{id:classes.advanced,reason:'测试取消不可选课程'});await action('card.issue',{...issue,courseIds:[classes.advanced]},token,400);
  });
  await t.test('店长品牌通用卡可选同品牌课程摘要，不能指定其他售卡门店',async()=>{
    let r=await request(`/api/card-courses?storeId=${storeId}&scope=all`,undefined,manager);assert.equal(r.status,200);assert.ok(r.data.courses.some(c=>c.id===classes.other));r=await request(`/api/card-courses?storeId=${secondStore}&scope=all`,undefined,manager);assert.equal(r.status,403);
    w=await action('card.issue',{...issue,scope:'all',courseIds:[classes.other]},manager);assert.equal(w.data.cards.at(-1).courseRules[0].name,'二店专属课程');
    for(const auth of [coach,student]){r=await request(`/api/card-courses?storeId=${storeId}`,undefined,auth);assert.equal(r.status,403);}assert.equal((await request(`/api/card-courses?storeId=${storeId}&persona=hq`)).status,403);assert.equal((await request(`/api/card-courses?storeId=${storeId}`,undefined,null)).status,401);
  });
  await t.test('精确课包续购必须重新选课，原课包与预约权益保持',async()=>{
    await action('card.renew',{...issue,id:strictCard.id,classTypes:['力量','普拉提']},token,400);
    w=await action('card.renew',{...issue,id:strictCard.id,courseIds:[classes.basic]});const renewed=w.data.cards.at(-1);assert.notEqual(renewed.id,strictCard.id);assert.equal(renewed.courseMode,'selected');assert.equal(renewed.courseRules.length,1);assert.deepEqual(w.data.cards.find(c=>c.id===strictCard.id).courseRules,strictCard.courseRules);
    w=await action('card.renew',{...issue,id:strictCard.id,courseIds:[]});const allRenewed=w.data.cards.at(-1);assert.equal(allRenewed.courseMode,'all');assert.equal(Object.hasOwn(allRenewed,'courseRules'),false);assert.deepEqual(w.data.cards.find(c=>c.id===strictCard.id).courseRules,strictCard.courseRules);
  });
  await t.test('数据库重启保留课程权益快照和历史卡兼容',async()=>{
    w=await action('card.issue',{...issue,name:'历史科目卡',classTypes:['力量']});const old=w.data.cards.at(-1);assert.equal(Object.hasOwn(old,'courseRules'),false);const before=await workspace();await stop();await start();const after=await workspace();assert.deepEqual(after.data.cards,before.data.cards);assert.deepEqual(after.data.bookings,before.data.bookings);assert.equal(after.version,before.version);
  });
});
