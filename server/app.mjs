import { createServer } from "node:http";
import { createMySQLDatabase } from "./database.mjs";
import { backfillVenueCatalog } from "./venues-migration.mjs";
import { createWechatPhoneExchange, validateWechatPhoneResult } from "./wechat-phone.mjs";
import { createTeamCodeService, generateTeamCode, TEAM_MATCH_ERROR } from "./team-codes.mjs";
import { createStudentInviteService, generateStudentInvite, studentGrantState, studentMemberIds, STUDENT_INVITE_ERROR } from "./student-invites.mjs";
import { createHttpPolicy } from "./http-policy.mjs";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, extname, sep } from "node:path";

const require = createRequire(import.meta.url);
const { applyAction, projectWorkspace, previewSchedule } = require("../.local-runtime/lib/domain.js");
const coachStores=()=>require("../.local-runtime/lib/coach-stores.js");
const TABLES = ["tenants", "stores", "coaches", "members", "cards", "classes", "bookings", "settlements", "tasks", "audit", "announcements", "applications", "orders", "ledger", "followups", "feedback", "schedulePlans", "venues", "coachBills"];
const sqlTable = name => name === "schedulePlans" ? "schedule_plans" : name === "coachBills" ? "coach_bills" : name;
const APPEND_ONLY = new Set(["ledger", "audit", "feedback"]);
const COOKIE = "ldd_session";
const DAY = 86400000;
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const MAX_RECEIPT_REQUEST_BYTES = MAX_RECEIPT_BYTES + 64 * 1024;
const ROLE_LABELS = { platform: "平台管理员", hq: "品牌总部", manager: "门店店长", coach: "教练", student: "学员" };
class HttpError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function fail(message, status = 400) { throw new HttpError(message, status); }
function str(body, key, max = 200) { const value = typeof body[key] === "string" ? body[key].trim() : ""; if (!value || value.length > max) fail(`请填写有效的${({name:"姓名",account:"登录账号",password:"密码",tenantName:"品牌名称",storeName:"门店名称",code:"微信登录凭证"})[key] ?? key}。`); return value; }
function credentials(body) { const account = str(body, "account", 64).toLowerCase(); if (!/^[a-z0-9][a-z0-9_.@-]{2,63}$/.test(account)) fail("账号需为3至64位英文字母、数字或 . _ @ -。"); const password = typeof body.password === "string" ? body.password : ""; if (password.length < 10 || password.length > 128) fail("密码需为10至128个字符。"); return { account, password }; }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function passwordHash(password) { const salt = randomBytes(16).toString("hex"); return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`; }
function verifyPassword(password, encoded) { if(encoded==="!wechat-only")return false; const [salt, digest] = encoded.split(":"); const check = scryptSync(password, salt, 64); const expected = Buffer.from(digest, "hex"); return check.length === expected.length && timingSafeEqual(check, expected); }
function id(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
function emptyWorkspace(createdAt) { return {demo:false,createdAt,...Object.fromEntries(TABLES.map(table=>[table,[]])),accounts:[]}; }
function parseMembership(row) { return {id:row.id,userId:row.user_id,role:row.role,...(row.tenant_id?{tenantId:row.tenant_id}:{}),...(row.store_id?{storeId:row.store_id}:{}),...(row.coach_id?{coachId:row.coach_id}:{}),...(row.member_id?{memberId:row.member_id}:{}),...(row.member_ids?{memberIds:JSON.parse(row.member_ids)}:{}),label:row.label}; }
function userView(row) { return {id:row.id,name:row.name,account:row.account}; }
function personaOf(membership, user, workspace) { const tenant=workspace.tenants.find(t=>t.id===membership.tenantId),store=workspace.stores.find(s=>s.id===membership.storeId);return {id:membership.role,userId:user.id,membershipId:membership.id,role:membership.role,workspaceMode:membership.workspaceMode,label:membership.label,name:user.name,title:[tenant?.name,store?.name,ROLE_LABELS[membership.role]].filter(Boolean).join(" · "),tenantId:membership.tenantId,storeId:membership.storeId,coachId:membership.coachId,memberId:membership.memberId,memberIds:membership.memberIds}; }
function receiptMetadata(row){return {id:row.id,name:row.name,mime:row.mime,size:row.size};}
function safeReceiptName(name){
  if(typeof name!=="string"||!name.trim()||name.length>180||name!==name.trim()||[...name].some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)||/[\\/<>:"|?*]/.test(name)||/%(?:0[ad]|2f|5c)/i.test(name)||name==="."||name==="..")fail("凭证文件名无效，请使用不含路径或特殊控制字符的文件名。");
  return name;
}
function inspectReceipt(bytes,name,declaredMime){
  if(!bytes.length)fail("凭证文件不能为空。");if(bytes.length>MAX_RECEIPT_BYTES)fail("每份凭证不能超过10MB。",413);
  let mime,extensions;
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString("ascii",12,16)==="IHDR"){mime="image/png";extensions=[".png"];}
  else if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217){mime="image/jpeg";extensions=[".jpg",".jpeg"];}
  else if(bytes.length>=16&&bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP"&&["VP8 ","VP8L","VP8X"].includes(bytes.toString("ascii",12,16))&&bytes.readUInt32LE(4)+8===bytes.length){mime="image/webp";extensions=[".webp"];}
  else if(bytes.length>=12&&/^%PDF-(?:1\.[0-9]|2\.0)/.test(bytes.toString("ascii",0,8))&&/%%EOF\s*$/.test(bytes.subarray(-1024).toString("ascii"))){mime="application/pdf";extensions=[".pdf"];}
  else fail("仅支持内容有效的JPG、PNG、WebP图片或PDF凭证。");
  const declared=(declaredMime||"").toLowerCase();if(declared&&declared!=="application/octet-stream"&&declared!==mime)fail("凭证声明的文件类型与实际内容不一致。");
  safeReceiptName(name);const extension=extname(name).toLowerCase();if(extension&&!extensions.includes(extension))fail("凭证扩展名与实际文件内容不一致。");
  return {name:extension?name:`${name}${extensions[0]}`,mime,size:bytes.length};
}
async function receiptMultipart(request){
  const contentType=request.headers["content-type"]??"",boundary=/\bboundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if(!/^multipart\/form-data\s*;/i.test(contentType)||!boundary||!(boundary[1]??boundary[2])||[...(boundary[1]??boundary[2])].some(char=>char.charCodeAt(0)<32)||((boundary[1]??boundary[2]).length>70))fail("请使用有效的multipart表单上传凭证。",400);
  const length=Number(request.headers["content-length"]);if(Number.isFinite(length)&&length>MAX_RECEIPT_REQUEST_BYTES){request.resume();fail("每份凭证不能超过10MB。",413);}
  const bytes=await new Promise((resolve,reject)=>{
    let count=0,failed=false;const chunks=[];
    request.on("data",chunk=>{if(failed)return;count+=chunk.length;if(count>MAX_RECEIPT_REQUEST_BYTES){failed=true;chunks.length=0;reject(new HttpError("每份凭证不能超过10MB。",413));}else chunks.push(chunk);});
    request.on("end",()=>{if(!failed)resolve(Buffer.concat(chunks));});
    request.on("error",()=>{if(!failed){failed=true;reject(new HttpError("凭证上传中断，请重新上传。",400));}});
  });
  // formData()会去掉filename中的路径；先检查原始part头，避免危险路径被悄悄转换成合法文件名。
  const marker=Buffer.from(`--${boundary[1]??boundary[2]}`),nextMarker=Buffer.from(`\r\n--${boundary[1]??boundary[2]}`);let offset=0,parts=0;
  while(offset<bytes.length){
    if(!bytes.subarray(offset,offset+marker.length).equals(marker))fail("凭证上传表单格式不正确。");const start=offset+marker.length;if(bytes.toString("ascii",start,start+2)==="--")break;
    if(bytes.toString("ascii",start,start+2)!=="\r\n")fail("凭证上传表单格式不正确。");const end=bytes.indexOf("\r\n\r\n",start+2);if(end<0||end-start>8192||++parts>3)fail("凭证上传表单格式不正确。");
    const headers=bytes.toString("utf8",start+2,end);if(/filename\s*\*\s*=/i.test(headers))fail("请使用标准文件名上传凭证。");for(const filename of headers.matchAll(/\bfilename\s*=\s*(?:"([^"]*)"|([^;\r\n]*))/gi))safeReceiptName(filename[1]??filename[2]);
    const next=bytes.indexOf(nextMarker,end+4);if(next<0)fail("凭证上传表单格式不正确。");offset=next+2;
  }
  let form;try{form=await new Response(bytes,{headers:{"Content-Type":contentType}}).formData();}catch{fail("凭证上传表单格式不正确。");}
  if([...form.keys()].some(key=>!["file","memberId","storeId"].includes(key))||form.getAll("file").length!==1||form.getAll("memberId").length!==1||form.getAll("storeId").length>1)fail("每次请上传一份凭证，并指定学员。");
  const file=form.get("file"),memberId=form.get("memberId"),storeId=form.get("storeId");if(!file||typeof file==="string"||typeof memberId!=="string"||!memberId||memberId.length>200||(storeId!==null&&typeof storeId!=="string"))fail("请上传有效文件并选择学员。");
  const content=Buffer.from(await file.arrayBuffer()),metadata=inspectReceipt(content,file.name,file.type);return {memberId,storeId:storeId??undefined,content,...metadata};
}

export async function createLocalServer({database: injectedDatabase,databaseOptions,staticDir,clock = () => new Date(),wechatCodeExchange,wechatPhoneExchange,teamCodeGenerator=generateTeamCode,studentInviteGenerator=generateStudentInvite} = {}) {
  const httpPolicy = createHttpPolicy();
  const database=injectedDatabase??await createMySQLDatabase(databaseOptions);
  try { await backfillVenueCatalog(database, clock()); }
  catch (error) { if (!injectedDatabase) await database.close(); throw error; }
  const attempts=new Map(),phoneAttempts=new Map();
  const teamCodes=createTeamCodeService({database,clock,generateCode:teamCodeGenerator});
  const studentInvites=createStudentInviteService({database,clock,generateCode:studentInviteGenerator});
  let phoneExchange=wechatPhoneExchange;
  let closePromise;
  function transaction(run){return database.transaction(run);}
  // 停用或未知密码格式也保留初始化门槛；只有明确微信专用的账号不占用后台首次开通。
  async function passwordSetupComplete(){return !!(await database.prepare("SELECT id FROM users WHERE password_hash <> '!wechat-only' LIMIT 1").get());}
  async function version(){return Number((await database.prepare("SELECT value FROM meta WHERE `key`='version'").get()).value);}
  async function bump(){const value=await version()+1;await database.prepare("UPDATE meta SET value=? WHERE `key`='version'").run(String(value));return value;}
  async function load(){
    const createdAt=(await database.prepare("SELECT value FROM meta WHERE `key`='createdAt'").get())?.value??clock().toISOString(),data=emptyWorkspace(createdAt);
    for(const table of TABLES){const rows=await database.prepare(`SELECT data FROM ${sqlTable(table)} ORDER BY seq ${["audit","bookings","orders","feedback","followups","announcements","tasks"].includes(table)?"DESC":"ASC"}`).all();data[table]=rows.map(row=>JSON.parse(row.data));}
    return data;
  }
  async function persist(before,after){
    for(const table of TABLES){
      const previous=new Map(before[table].map(item=>[item.id,JSON.stringify(item)])),nextIds=new Set(after[table].map(item=>item.id));
      for(const item of after[table]){
        const encoded=JSON.stringify(item),old=previous.get(item.id);if(old===encoded)continue;if(old&&APPEND_ONLY.has(table))fail("账本与审计记录只能追加，不能修改。",409);
        if(old)await database.prepare(`UPDATE ${sqlTable(table)} SET tenant_id=?,store_id=?,data=? WHERE id=?`).run(item.tenantId??null,item.storeId??null,encoded,item.id);
        else await database.prepare(`INSERT INTO ${sqlTable(table)}(id,tenant_id,store_id,data) VALUES(?,?,?,?)`).run(item.id,item.tenantId??null,item.storeId??null,encoded);
      }
      for(const [key] of previous)if(!nextIds.has(key)){if(APPEND_ONLY.has(table))fail("历史账本不可删除。",409);await database.prepare(`DELETE FROM ${sqlTable(table)} WHERE id=?`).run(key);}
    }
  }
  async function insertMembership(userId,fields){
    const membershipId=id("membership");await database.prepare("INSERT INTO memberships(id,user_id,role,tenant_id,store_id,coach_id,member_id,member_ids,label) VALUES(?,?,?,?,?,?,?,?,?)").run(membershipId,userId,fields.role,fields.tenantId??null,fields.storeId||null,fields.coachId??null,fields.memberId??null,fields.memberIds?JSON.stringify(fields.memberIds):null,fields.label??ROLE_LABELS[fields.role]);return membershipId;
  }
  async function memberships(userId){
    const rows=await database.prepare("SELECT * FROM memberships WHERE user_id=? AND status='active' ORDER BY seq").all(userId),available=[];
    for(const row of rows){
      const membership=parseMembership(row),tenant=membership.tenantId?await database.prepare("SELECT data FROM tenants WHERE id=?").get(membership.tenantId):null;
      if(membership.role==="coach"&&membership.coachId&&!await validLinkedCoachMembership(membership,userId))continue;
      const storeRow=membership.tenantId&&membership.storeId?await database.prepare("SELECT data FROM stores WHERE id=? AND tenant_id=?").get(membership.storeId,membership.tenantId):null,store=storeRow?JSON.parse(storeRow.data):null;
      const location=store&&store.id===membership.storeId&&store.tenantId===membership.tenantId?{...(typeof store.name==="string"?{storeName:store.name}:{}),...(typeof store.address==="string"?{storeAddress:store.address}:{})}:{};
      available.push({...membership,...location,workspaceMode:tenant?JSON.parse(tenant.data).mode??"organization":"organization"});
    }
    return available;
  }
  async function newSession(userId,membershipId,loginMethod="password"){
    const token=randomBytes(32).toString("base64url"),now=clock();await database.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());await database.prepare("INSERT INTO sessions(token_hash,user_id,membership_id,created_at,expires_at,login_method) VALUES(?,?,?,?,?,?)").run(hash(token),userId,membershipId,now.toISOString(),new Date(now.getTime()+7*DAY).toISOString(),loginMethod);return token;
  }
  function tokenFrom(request){const bearer=request.headers.authorization;if(bearer?.startsWith("Bearer "))return bearer.slice(7).trim();const cookie=(request.headers.cookie??"").split(";").map(x=>x.trim()).find(x=>x.startsWith(`${COOKIE}=`));try{return cookie?decodeURIComponent(cookie.slice(COOKIE.length+1)):null;}catch{return null;}}
  async function authentication(request,required=true){
    const token=tokenFrom(request),session=token?await database.prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at>?").get(hash(token),clock().toISOString()):null,user=session?await database.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(session.user_id):null;
    if(!session||!user){if(required)fail("登录已失效，请重新登录。",401);return null;}
    const available=await memberships(user.id);let active=available.find(m=>m.id===session.membership_id);
    if(!active&&available.length){const previous=await database.prepare("SELECT role,coach_id FROM memberships WHERE id=? AND user_id=?").get(session.membership_id,user.id),link=previous?.role==="coach"&&previous.coach_id?await database.prepare("SELECT user_id FROM wechat_coach_links WHERE coach_id=?").get(previous.coach_id):null;if(link?.user_id===user.id){active=available.find(item=>item.role==="hq"&&item.workspaceMode==="solo")??available[0];await database.prepare("UPDATE sessions SET membership_id=? WHERE token_hash=?").run(active.id,hash(token));session.membership_id=active.id;}}
    if(!active)fail("当前组织授权已失效，请联系管理员。",403);return {token,session,user,memberships:available,activeMembership:active};
  }
  function sessionView(auth,token){return auth?{user:userView(auth.user),memberships:auth.memberships,activeMembership:auth.activeMembership,loginMethod:auth.session.login_method,...(token?{token}: {})}:{user:null,memberships:[],activeMembership:null};}
  function authForToken(token){return authentication({headers:{authorization:`Bearer ${token}`}});}
  function cookie(response,token,request){response.setHeader("Set-Cookie",`${COOKIE}=${token?encodeURIComponent(token):""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token?7*86400:0}${httpPolicy.secureCookie(request)?"; Secure":""}`);}
  async function accountViews(auth){
    if(!["platform","hq","manager"].includes(auth.activeMembership.role))return [];
    const own=auth.activeMembership,users=await database.prepare("SELECT id,name,account FROM users ORDER BY created_at,id").all(),accounts=[];
    for(const user of users){const available=(await memberships(user.id)).filter(m=>own.role==="platform"||(m.tenantId===own.tenantId&&(own.role!=="manager"||m.storeId===own.storeId)));if(available.length)accounts.push({...userView(user),memberships:available});}
    return accounts;
  }
  async function workspace(auth){
    const data=await load(),persona=personaOf(auth.activeMembership,auth.user,data);data.accounts=await accountViews(auth);const result=projectWorkspace(data,persona,await version());result.personas=auth.memberships.map(m=>personaOf(m,auth.user,data));
    for(const coach of result.data.coaches){delete coach.wxLinked;if(["hq","manager"].includes(persona.role))coach.wxLinked=!!(await database.prepare("SELECT coach_id FROM wechat_coach_links WHERE coach_id=?").get(coach.id));}
    for(const order of result.data.orders){
      delete order.receiptAttachments;
      if(["platform","hq","manager"].includes(persona.role)){
        if(order.receiptAttachmentIds?.length){const rows=await database.prepare("SELECT id,name,mime,size FROM receipt_attachments WHERE order_id=?").all(order.id),metadata=new Map(rows.map(row=>[row.id,receiptMetadata(row)]));order.receiptAttachments=order.receiptAttachmentIds.map(key=>metadata.get(key)).filter(Boolean);}
      }else delete order.receiptAttachmentIds;
    }
    return result;
  }
  function ensureActiveTenant(persona,data){if(persona.role==="platform")return;const tenant=data.tenants.find(t=>t.id===persona.tenantId),today=new Date(clock().getTime()+8*3600000).toISOString().slice(0,10);if(!tenant||tenant.status!=="active"||(tenant.mode!=="solo"&&tenant.expiresAt<today))fail(tenant?.mode==="solo"?"当前独立训练空间未启用，请联系本地服务维护者处理。":"品牌服务已暂停或到期，请联系平台处理。",403);}
  function receiptRole(auth,allowPlatform=false){if(!["hq","manager",...(allowPlatform?["platform"]:[])].includes(auth.activeMembership.role))fail("当前身份无权管理或查看收款凭证。",403);}
  function receiptScope(auth,tenantId,storeId,allowPlatform=false){receiptRole(auth,allowPlatform);const actor=auth.activeMembership;if(actor.role!=="platform"&&actor.tenantId!==tenantId)fail("无权访问其他品牌的收款凭证。",403);if(actor.role==="manager"&&actor.storeId!==storeId)fail("只能管理本门店的收款凭证。",403);}
  function receiptMemberScope(auth,data,memberId,requestedStoreId){
    receiptRole(auth);const member=data.members.find(item=>item.id===memberId);if(!member||member.tenantId!==auth.activeMembership.tenantId)fail("学员不存在或不属于可管理范围。",403);
    const tenant=data.tenants.find(item=>item.id===member.tenantId),storeId=requestedStoreId??member.storeId;
    receiptScope(auth,member.tenantId,storeId);if(auth.activeMembership.role==="manager"&&member.storeId!==auth.activeMembership.storeId)fail("仅能为本店归属学员上传或登记凭证。",403);
    ensureActiveTenant(personaOf(auth.activeMembership,auth.user,data),data);
    if(tenant.mode==="solo"){if(storeId!=="")fail("独立训练空间没有门店。",403);}else if(!data.stores.some(store=>store.id===storeId&&store.tenantId===member.tenantId&&store.status==="active"))fail("售卡门店不存在或当前未启用。",403);
    return {tenantId:member.tenantId,memberId:member.id,storeId};
  }
  async function receiptClaims(auth,before,action,payload){
    if(Object.hasOwn(payload,"receiptAttachments"))fail("凭证元数据由服务端生成，不能自行指定。",403);
    if(!["card.issue","card.renew"].includes(action))return [];
    const ids=payload.receiptAttachmentIds;if(ids===undefined)return [];
    if(!Array.isArray(ids)||ids.length>3||new Set(ids).size!==ids.length||ids.some(key=>typeof key!=="string"||!/^receipt-[A-Za-z0-9_-]{1,100}$/.test(key)))fail("每次开卡最多关联3份不同的有效凭证。");
    if(!ids.length)return [];
    receiptRole(auth);const previous=action==="card.renew"?before.cards.find(card=>card.id===payload.id):undefined;if(action==="card.renew"&&!previous)fail("原课卡不存在。",404);
    const memberId=previous?.memberId??payload.memberId,tenant=before.tenants.find(item=>item.id===auth.activeMembership.tenantId),storeId=previous?.storeId??(tenant?.mode==="solo"?"":payload.storeId),scope=receiptMemberScope(auth,before,memberId,storeId),claims=[];
    for(const key of ids){const row=await database.prepare("SELECT id,tenant_id,store_id,member_id,order_id FROM receipt_attachments WHERE id=? FOR UPDATE").get(key);if(!row||row.tenant_id!==scope.tenantId||row.member_id!==scope.memberId||row.store_id!==scope.storeId)fail("凭证不存在，或与当前学员、品牌及售卡门店不匹配。",403);if(row.order_id)fail("该凭证已关联其他订单，请勿重复使用。",409);claims.push(row);}
    return claims;
  }
  async function linkReceiptClaims(before,after,claims){
    if(!claims.length)return;const existing=new Set(before.orders.map(order=>order.id)),created=after.orders.filter(order=>!existing.has(order.id));if(created.length!==1)fail("没有生成可关联凭证的开卡订单。",409);const order=created[0];
    for(const row of claims){if(order.tenantId!==row.tenant_id||order.storeId!==row.store_id||order.memberId!==row.member_id||!order.receiptAttachmentIds?.includes(row.id))fail("凭证与新订单的学员或售卡门店不匹配。",403);const update=await database.prepare("UPDATE receipt_attachments SET order_id=? WHERE id=? AND order_id IS NULL").run(order.id,row.id);if(update.changes!==1)fail("凭证已被其他订单使用，请刷新后重试。",409);}
  }
  async function createAccount(auth,p,data){
    const actor=auth.activeMembership;if(!["platform","hq","manager"].includes(actor.role))fail("当前身份不能创建登录账号。",403);const role=p.role;if(!Object.hasOwn(ROLE_LABELS,role)||role==="platform")fail("不能创建该权限的账号。",403);if(actor.role==="manager"&&!["coach","student"].includes(role))fail("店长只能为本店教练和学员创建账号。",403);if(actor.role==="hq"&&role==="hq")fail("总部管理授权需要平台管理员开通。",403);
    const tenantId=actor.role==="platform"?str(p,"tenantId"):actor.tenantId;if(!data.tenants.some(t=>t.id===tenantId))fail("品牌不存在。");if(actor.role!=="platform"&&p.tenantId&&p.tenantId!==tenantId)fail("不能为其他品牌创建账号。",403);
    const solo=data.tenants.find(t=>t.id===tenantId)?.mode==="solo";if(solo&&role!=="student")fail("独立教练空间只能为学员开通账号，不能增加机构员工授权。",403);if(solo&&p.storeId!==undefined&&p.storeId!=="")fail("独立教练空间没有门店。",403);
    const storeId=role==="hq"?undefined:solo?"":str(p,"storeId"),store=storeId?data.stores.find(s=>s.id===storeId&&s.tenantId===tenantId):null;let coachId,memberId,memberIds;
    if(storeId&&!store)fail("门店不存在或不属于当前品牌。",403);if(actor.role==="manager"&&actor.storeId!==storeId)fail("只能创建本店账号。",403);
    if(role==="coach"){coachId=str(p,"coachId");if(!data.coaches.some(c=>c.id===coachId&&c.tenantId===tenantId&&coachStores().coachServesStore(c,storeId)))fail("教练档案与门店不匹配。",403);if(await database.prepare("SELECT coach_id FROM wechat_coach_links WHERE coach_id=?").get(coachId)||await database.prepare("SELECT id FROM memberships WHERE role='coach' AND coach_id=? LIMIT 1").get(coachId))fail("该教练已有账号授权，请使用关联已有教练追加门店，不能另建或合并账号。",409);}
    if(role==="student"){memberId=str(p,"memberId");memberIds=Array.isArray(p.memberIds)?[...new Set([memberId,...p.memberIds])]:[memberId];if(memberIds.length>10||!memberIds.every(mid=>typeof mid==="string"&&data.members.some(m=>m.id===mid&&m.tenantId===tenantId&&(actor.role!=="manager"||m.storeId===storeId))))fail("学员绑定对象不属于可管理范围。",403);if(!data.members.some(m=>m.id===memberId&&m.tenantId===tenantId&&m.storeId===storeId))fail("学员与归属门店不匹配。",403);}
    const {account,password}=credentials(p),name=str(p,"name",30);if(await database.prepare("SELECT id FROM users WHERE account=?").get(account))fail("该登录账号已存在，请换一个账号。");const userId=id("user");
    await database.prepare("INSERT INTO users(id,account,name,password_hash,status,created_at) VALUES(?,?,?,?,?,?)").run(userId,account,name,passwordHash(password),"active",clock().toISOString());
    await insertMembership(userId,{role,tenantId,storeId,coachId,memberId,memberIds,label:[data.tenants.find(t=>t.id===tenantId)?.name,store?.name,ROLE_LABELS[role]].filter(Boolean).join(" · ")});
    data.audit.unshift({id:id("audit"),tenantId,storeId,actor:auth.user.name,actorId:auth.user.id,action:"account.create",detail:`创建${ROLE_LABELS[role]}登录账号 ${account}`,createdAt:clock().toISOString()});
  }
  async function syncAttachedCoachMembership(auth,before,data,p){
    const coach=data.coaches.find(item=>item.id===p.coachId),store=data.stores.find(item=>item.id===p.storeId&&item.tenantId===coach?.tenantId);if(!coach||!store||!coachStores().coachServesStore(coach,store.id))fail("教练与目标门店关联异常。",409);
    const link=await database.prepare("SELECT user_id FROM wechat_coach_links WHERE coach_id=?").get(coach.id),rows=await database.prepare("SELECT id,user_id,tenant_id,store_id,status FROM memberships WHERE role='coach' AND coach_id=?").all(coach.id),owners=new Set(rows.filter(row=>row.status==="active").map(row=>row.user_id));if(link)owners.add(link.user_id);
    if(owners.size>1)fail("该教练存在多个账号授权，不能自动合并，请管理员先核对。",409);const userId=[...owners][0];
    if(!userId)return false;
    if(rows.some(row=>row.user_id!==userId))fail("该教练存在其他账号的历史授权，不能自动转移，请管理员核对。",409);
    const user=await database.prepare("SELECT id,status FROM users WHERE id=?").get(userId);if(!user||user.status!=="active")fail("教练账号当前停用，不能自动追加门店授权。",409);
    const existing=rows.find(row=>row.user_id===userId&&row.tenant_id===coach.tenantId&&row.store_id===store.id);if(existing){if(existing.status!=="active")fail("该教练在目标门店的账号授权已停用，不能通过关联重新激活。",409);return false;}
    const tenant=data.tenants.find(item=>item.id===coach.tenantId);await insertMembership(userId,{role:"coach",tenantId:coach.tenantId,storeId:store.id,coachId:coach.id,label:[tenant.name,store.name,ROLE_LABELS.coach].join(" · ")});
    if(data.audit.length===before.audit.length)data.audit.unshift({id:id("audit"),tenantId:coach.tenantId,storeId:store.id,actor:auth.user.name,actorId:auth.user.id,action:"coach.store.attach",detail:"为已关联的教练同步同账号门店授权，不合并或复活其他账号",createdAt:clock().toISOString()});
    return true;
  }
  function sameOrigin(request){const origin=request.headers.origin;if(!origin)return;const expected=httpPolicy.expectedOrigin(request);const allowed=(process.env.ALLOWED_ORIGINS??"").split(",").map(v=>v.trim()).filter(Boolean);if(origin!==expected&&!allowed.includes(origin))fail("请求来源不匹配，请从本应用重新操作。",403);}
  async function body(request){if(request.headers["content-type"]?.split(";")[0].trim().toLowerCase()!=="application/json")fail("请使用JSON格式提交请求。",415);let count=0;const chunks=[];for await(const chunk of request){count+=chunk.length;if(count>64000)fail("提交内容过大，请精简后重试。",413);chunks.push(chunk);}let value;try{value=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{fail("请求内容不是有效JSON。");}if(!value||typeof value!=="object"||Array.isArray(value))fail("请求参数格式不正确。");return value;}
  function checkLoginRate(request,account){const key=`${httpPolicy.clientIP(request)}:${String(account).toLowerCase()}`,now=clock().getTime(),current=attempts.get(key);if(current&&current.until>now&&current.count>=10)fail("登录尝试过多，请15分钟后再试。",429);if(!current||current.until<=now)attempts.set(key,{count:1,until:now+15*60000});else current.count++;if(attempts.size>5000)for(const[k,v]of attempts)if(v.until<now)attempts.delete(k);return key;}
  function wechatNamespace(){return process.env.WECHAT_APP_ID||"injected-test-app";}
  function wechatPhoneConfigured(){return process.env.WECHAT_PHONE_LOGIN_ENABLED?.toLowerCase()!=="false"&&(!!wechatPhoneExchange||!!(process.env.WECHAT_APP_ID&&process.env.WECHAT_APP_SECRET));}
  function normalizedCoachPhone(value){
    if(typeof value!=="string")return null;let phone=value.trim().replace(/[\s-]/g,"");if(phone.startsWith("+86"))phone=phone.slice(3);else if(phone.startsWith("0086"))phone=phone.slice(4);else if(phone.length===13&&phone.startsWith("86"))phone=phone.slice(2);return /^1[3-9]\d{9}$/.test(phone)?phone:null;
  }
  function phoneDigest(phone){return hash(`${wechatNamespace()}:phone:${phone}`);}
  function coachPhoneDigest(value){const phone=normalizedCoachPhone(value);return phone?phoneDigest(phone):null;}
  function validDate(value){return typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;}
  function coachLiveReason(data,coach,phoneHash,storeId=coach?.storeId){
    if(!coach)return "教练档案已不存在，请联系门店管理员。";
    const tenant=data.tenants.find(item=>item.id===coach.tenantId),store=data.stores.find(item=>item.id===storeId&&item.tenantId===coach.tenantId),today=new Date(clock().getTime()+8*3600000).toISOString().slice(0,10);
    if(!tenant||tenant.mode==="solo"||(tenant.mode!==undefined&&tenant.mode!=="organization")||coach.selfManaged)return "该档案不是可加入的连锁门店教练。";
    if(!coachStores().coachServesStore(coach,storeId))return "该教练尚未关联当前门店，请联系管理员。";
    if(coachPhoneDigest(coach.phone)!==phoneHash)return "后台教练手机号已变更，请重新授权手机号或联系管理员核对。";
    if(coach.status!=="approved")return coach.status==="rejected"?"教练审核未通过，请联系门店管理员。":"教练尚待审核通过，请联系门店管理员。";
    if(typeof coach.certificate!=="string"||!coach.certificate.trim()||!validDate(coach.certificateExpiresAt)||coach.certificateExpiresAt<today)return "教练资质未完善或证件已到期，请联系管理员更新。";
    if(tenant.status!=="active"||!validDate(tenant.expiresAt)||tenant.expiresAt<today)return "品牌当前未启用或服务已到期，请联系品牌管理员。";
    if(!store||store.status!=="active")return "门店当前未启用，请联系门店管理员。";
    return "";
  }
  async function validLinkedCoachMembership(membership,userId){
    const coachRow=await database.prepare("SELECT data FROM coaches WHERE id=?").get(membership.coachId),coach=coachRow?JSON.parse(coachRow.data):null;if(!coach||coach.tenantId!==membership.tenantId||!coachStores().coachServesStore(coach,membership.storeId))return false;
    const tenantRow=await database.prepare("SELECT data FROM tenants WHERE id=?").get(coach.tenantId),storeRow=await database.prepare("SELECT data FROM stores WHERE id=?").get(membership.storeId),tenant=tenantRow?JSON.parse(tenantRow.data):null,store=storeRow?JSON.parse(storeRow.data):null,today=new Date(clock().getTime()+8*3600000).toISOString().slice(0,10);
    if(!tenant||tenant.mode==="solo"||tenant.status!=="active"||!validDate(tenant.expiresAt)||tenant.expiresAt<today||!store||store.tenantId!==coach.tenantId||store.status!=="active")return false;
    const link=await database.prepare("SELECT user_id,phone_hash FROM wechat_coach_links WHERE coach_id=?").get(membership.coachId);if(!link)return true;if(link.user_id!==userId)return false;
    return !coachLiveReason({tenants:[tenant],stores:[store]},coach,link.phone_hash,membership.storeId);
  }
  function checkPhoneRate(request,principal){
    const now=clock().getTime(),keys=[[`openid:${principal.openidHash}`,10],[`ip:${httpPolicy.clientIP(request)}`,30]];
    for(const[key,limit]of keys){const current=phoneAttempts.get(key);if(current&&current.until>now&&current.count>=limit)fail("手机号授权过于频繁，请15分钟后再试。",429);}
    for(const[key]of keys){const current=phoneAttempts.get(key);if(!current||current.until<=now)phoneAttempts.set(key,{count:1,until:now+15*60000});else current.count++;}
    if(phoneAttempts.size>5000)for(const[key,current]of phoneAttempts)if(current.until<=now)phoneAttempts.delete(key);
  }
  function rejectPhoneInput(p,allowed){if(Object.keys(p).some(key=>!allowed.includes(key)))fail("手机号与身份由微信和服务端校验，不能自行指定。",403);}
  async function phonePrincipal(request,p,claim){
    if(tokenFrom(request)){
      const auth=await authentication(request);if(auth.session.login_method!=="wechat")fail("请先通过微信验证，再授权手机号加入门店。",403);const binding=await database.prepare("SELECT openid_hash FROM wechat_bindings WHERE user_id=?").get(auth.user.id);if(!binding)fail("当前账号没有有效微信绑定，请重新微信验证。",403);return {userId:auth.user.id,openidHash:binding.openid_hash,ticketHash:null,auth};
    }
    if(typeof p.onboardingToken!=="string"||!p.onboardingToken||p.onboardingToken.length>128)fail("请先完成微信验证，再授权手机号。",401);
    const ticketHash=hash(p.onboardingToken),ticket=await database.prepare("SELECT * FROM wechat_onboarding WHERE ticket_hash=? FOR UPDATE").get(ticketHash),stamp=clock().toISOString();if(!ticket)fail("微信验证凭证无效，请重新微信登录。",401);if(ticket.expires_at<=stamp)fail("微信验证已过期，请重新微信登录。",410);
    const binding=await database.prepare("SELECT user_id FROM wechat_bindings WHERE openid_hash=?").get(ticket.openid_hash),retry=!!(claim?.used_at&&(claim.coach_id||claim.member_id)&&claim.user_id&&claim.onboarding_ticket_hash===ticketHash&&claim.openid_hash===ticket.openid_hash&&binding?.user_id===claim.user_id);
    if(ticket.used_at&&!retry)fail("微信验证凭证已使用，请重新微信登录。",409);if(binding&&!retry)fail("该微信已有账号，请重新微信登录后加入门店。",409);
    if(retry&&!await database.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(binding.user_id))fail("当前微信账号不可用，请联系管理员。",403);
    return {userId:retry?binding.user_id:null,openidHash:ticket.openid_hash,ticketHash,ticket};
  }
  function assertClaimPrincipal(claim,principal){if(claim.openid_hash!==principal.openidHash||(claim.user_id&&claim.user_id!==principal.userId)||(!principal.auth&&claim.onboarding_ticket_hash!==principal.ticketHash))fail("手机号授权不属于当前微信身份，请重新授权。",403);}
  async function coachAvailability(data,coach,phoneHash,userId,storeId=coach?.storeId){
    const reason=coachLiveReason(data,coach,phoneHash,storeId);if(reason)return {canJoin:false,reason};
    const link=await database.prepare("SELECT user_id FROM wechat_coach_links WHERE coach_id=?").get(coach.id),owners=await database.prepare("SELECT user_id FROM memberships WHERE role='coach' AND coach_id=?").all(coach.id);
    if((link&&link.user_id!==userId)||owners.some(owner=>owner.user_id!==userId))return {canJoin:false,reason:"该教练档案已有账号授权，请联系管理员核对，不能自动合并或转移。",conflict:true};
    return {canJoin:true,reason:""};
  }
  function teamCodeStore(auth,data,requestedStoreId){
    const actor=auth.activeMembership;
    if(!["hq","manager"].includes(actor.role))fail("当前身份无权管理门店团队码。",403);
    const tenant=data.tenants.find(item=>item.id===actor.tenantId);
    if(!tenant||tenant.mode==="solo")fail("独立训练空间不使用门店团队码。",403);
    const store=data.stores.find(item=>item.id===requestedStoreId&&item.tenantId===actor.tenantId);
    if(!store||(actor.role==="manager"&&actor.storeId!==store.id))fail("只能管理已授权门店的团队码。",403);
    ensureActiveTenant(personaOf(actor,auth.user,data),data);
    return store;
  }
  async function manageTeamCode(request,url,reset){
    const keys=[...url.searchParams.keys()];
    if(keys.some(key=>key!=="storeId")||keys.some(key=>url.searchParams.getAll(key).length!==1)||(reset&&keys.length))fail("请使用有效的门店团队码请求，身份由服务端确定。",403);
    const p=reset?await body(request):{storeId:url.searchParams.get("storeId")};
    if(Object.keys(p).some(key=>key!=="storeId"))fail("只能指定已授权门店，团队码由服务端生成。",403);
    return transaction(async()=>{
      const auth=await authentication(request),before=await load(),store=teamCodeStore(auth,before,str(p,"storeId",191));
      if(!reset)return teamCodes.status(store.id);
      if(store.status!=="active")fail("请启用门店后再生成团队码。",403);
      const result=await teamCodes.reset({tenantId:store.tenantId,storeId:store.id,userId:auth.user.id});
      const after=structuredClone(before);after.audit.unshift({id:id("audit"),tenantId:store.tenantId,storeId:store.id,actor:auth.user.name,actorId:auth.user.id,action:"store.team-code.reset",detail:"生成或重置门店团队码，有效期7天；原团队码立即失效",createdAt:clock().toISOString()});
      await persist(before,after);await bump();return result;
    });
  }
  async function matchWechatTeam(request,p){
    rejectPhoneInput(p,["phone","teamCode","onboardingToken"]);
    const initial=await transaction(async()=>{const principal=await phonePrincipal(request,p);return {principal,allowed:await teamCodes.attempt({openidHash:principal.openidHash,ip:httpPolicy.clientIP(request)})};});
    if(!initial.allowed)fail("加入团队尝试过于频繁，请15分钟后再试。",429);
    const phone=normalizedCoachPhone(p.phone),teamCode=typeof p.teamCode==="string"?p.teamCode.trim():"";
    if(!phone||!/^\d{6}$/.test(teamCode))fail(TEAM_MATCH_ERROR);
    return transaction(async()=>{
      const principal=await phonePrincipal(request,p);
      if(principal.openidHash!==initial.principal.openidHash||principal.userId!==initial.principal.userId||principal.ticketHash!==initial.principal.ticketHash)fail("微信身份已变化，请重新验证微信。",403);
      const code=await teamCodes.find(teamCode);if(!code)fail(TEAM_MATCH_ERROR);
      const data=await load(),tenant=data.tenants.find(item=>item.id===code.tenant_id),store=data.stores.find(item=>item.id===code.store_id&&item.tenantId===code.tenant_id),today=new Date(clock().getTime()+8*3600000).toISOString().slice(0,10);
      if(!tenant||tenant.mode==="solo"||tenant.status!=="active"||!validDate(tenant.expiresAt)||tenant.expiresAt<today||!store||store.status!=="active")fail(TEAM_MATCH_ERROR);
      const phoneHash=phoneDigest(phone),matches=[];
      for(const coach of data.coaches){
        if(coach.tenantId!==tenant.id||!coachStores().coachServesStore(coach,store.id)||coach.selfManaged||coachPhoneDigest(coach.phone)!==phoneHash)continue;
        const available=await coachAvailability(data,coach,phoneHash,principal.userId,store.id),name=Array.from(coach.name||"教练");
        matches.push({coachId:coach.id,storeId:store.id,coachName:name.length>1?`${name[0]}${"*".repeat(Math.min(name.length-1,3))}`:"*",tenantName:tenant.name,storeName:store.name,canJoin:available.canJoin,reason:available.reason,status:coach.status});
      }
      if(!matches.length)fail(TEAM_MATCH_ERROR);
      const now=clock(),stamp=now.toISOString(),claimToken=randomBytes(32).toString("base64url"),expiresAt=new Date(Math.min(now.getTime()+5*60000,Date.parse(code.expires_at),principal.ticket?Date.parse(principal.ticket.expires_at):Infinity)).toISOString();
      await database.prepare("DELETE FROM wechat_phone_claims WHERE expires_at < ?").run(new Date(now.getTime()-DAY).toISOString());
      await database.prepare("INSERT INTO wechat_phone_claims(ticket_hash,user_id,openid_hash,onboarding_ticket_hash,phone_hash,created_at,expires_at,proof_method,team_store_id,team_tenant_id,team_generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(hash(claimToken),principal.userId,principal.openidHash,principal.ticketHash,phoneHash,stamp,expiresAt,"team_code",store.id,tenant.id,code.generation);
      return {claimToken,expiresAt,phoneMasked:`${phone.slice(0,3)}****${phone.slice(-4)}`,matches};
    });
  }
  function rejectStudentInviteInput(p,allowed){if(Object.keys(p).some(key=>!allowed.includes(key)))fail("邀请与微信身份由服务端校验，不能自行指定学员或组织。",403);}
  function studentTarget(data,memberId){
    const member=data.members.find(item=>item.id===memberId),tenant=member&&data.tenants.find(item=>item.id===member.tenantId),store=member&&data.stores.find(item=>item.id===member.storeId&&item.tenantId===member.tenantId),today=new Date(clock().getTime()+8*3600000).toISOString().slice(0,10);
    if(!member||!tenant||tenant.status!=="active"||(tenant.mode==="solo"?member.storeId!=="":!store||store.status!=="active"||!validDate(tenant.expiresAt)||tenant.expiresAt<today))return null;
    return {member,tenant,store};
  }
  function inviteMemberScope(auth,data,memberId){
    const actor=auth.activeMembership;if(!["hq","manager"].includes(actor.role))fail("当前身份无权管理学员微信邀请码。",403);
    const member=data.members.find(item=>item.id===memberId&&item.tenantId===actor.tenantId),tenant=data.tenants.find(item=>item.id===actor.tenantId);
    if(!member||!tenant||(actor.role==="manager"&&member.storeId!==actor.storeId))fail("学员不在当前可管理范围。",403);
    if(tenant.mode==="solo"&&(actor.role!=="hq"||member.storeId!==""||!data.coaches.some(item=>item.id===actor.coachId&&item.tenantId===tenant.id&&item.selfManaged)))fail("仅独立空间拥有者可邀请自己的学员。",403);
    ensureActiveTenant(personaOf(actor,auth.user,data),data);return member;
  }
  async function manageStudentInvite(request,url,reset){
    const keys=[...url.searchParams.keys()];if(keys.some(key=>key!=="memberId")||keys.some(key=>url.searchParams.getAll(key).length!==1)||(reset&&keys.length))fail("请使用有效的学员邀请码管理请求。",403);
    const p=reset?await body(request):{memberId:url.searchParams.get("memberId")};rejectStudentInviteInput(p,["memberId"]);
    return transaction(async()=>{
      const auth=await authentication(request),before=await load(),member=inviteMemberScope(auth,before,str(p,"memberId",191)),state=await studentGrantState(database,member),status=await studentInvites.status(member.id);
      if(!reset)return {...status,...(state.owners.size?{status:"claimed",...(state.link?.created_at?{claimedAt:state.link.created_at}:{})}:{}),existingPasswordAccess:state.existingPasswordAccess};
      if(state.owners.size)fail("该学员已有微信授权，不能通过邀请码转移给其他微信，请联系管理员核对。",409);
      if(!studentTarget(before,member.id))fail("学员所属空间或门店当前未启用，暂不能邀请。",403);
      const result=await studentInvites.reset({member,userId:auth.user.id}),after=structuredClone(before);
      after.audit.unshift({id:id("audit"),tenantId:member.tenantId,storeId:member.storeId,actor:auth.user.name,actorId:auth.user.id,action:"member.wechat-invite.reset",detail:`为学员「${member.name}」生成或重置7天单次微信邀请码${state.existingPasswordAccess?"，明确追加独立微信授权，原账密授权保留":""}`,createdAt:clock().toISOString()});
      await persist(before,after);await bump();return {...result,existingPasswordAccess:state.existingPasswordAccess};
    });
  }
  async function previewStudentInvite(request,p){
    rejectStudentInviteInput(p,["inviteCode","onboardingToken"]);
    const initial=await transaction(async()=>{const principal=await phonePrincipal(request,p);return {principal,allowed:await studentInvites.attempt({openidHash:principal.openidHash,ip:httpPolicy.clientIP(request)})};});
    if(!initial.allowed)fail("学员邀请码尝试过于频繁，请15分钟后再试。",429);
    const inviteCode=typeof p.inviteCode==="string"?p.inviteCode.trim():"";if(!/^\d{8}$/.test(inviteCode))fail(STUDENT_INVITE_ERROR);
    return transaction(async()=>{
      const principal=await phonePrincipal(request,p);if(principal.openidHash!==initial.principal.openidHash||principal.userId!==initial.principal.userId||principal.ticketHash!==initial.principal.ticketHash)fail("微信身份已变化，请重新微信验证。",403);
      const invite=await studentInvites.find(inviteCode);if(!invite)fail(STUDENT_INVITE_ERROR);
      const target=studentTarget(await load(),invite.member_id);if(!target||target.member.tenantId!==invite.tenant_id||target.member.storeId!==invite.store_id)fail(STUDENT_INVITE_ERROR);
      const state=await studentGrantState(database,target.member,principal.userId);if(state.otherWechatOwner||state.disabledOwn)fail(STUDENT_INVITE_ERROR);
      const now=clock(),stamp=now.toISOString(),claimToken=randomBytes(32).toString("base64url"),expiresAt=new Date(Math.min(now.getTime()+5*60000,Date.parse(invite.expires_at),principal.ticket?Date.parse(principal.ticket.expires_at):Infinity)).toISOString();
      await database.prepare("DELETE FROM wechat_student_claims WHERE expires_at < ?").run(new Date(now.getTime()-DAY).toISOString());
      await database.prepare("INSERT INTO wechat_student_claims(ticket_hash,user_id,openid_hash,onboarding_ticket_hash,member_id,tenant_id,store_id,generation,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(hash(claimToken),principal.userId,principal.openidHash,principal.ticketHash,target.member.id,target.member.tenantId,target.member.storeId,invite.generation,stamp,expiresAt);
      const name=Array.from(target.member.name||"学员");return {claimToken,expiresAt,member:{nameMasked:name.length>1?`${name[0]}${"*".repeat(Math.min(name.length-1,3))}`:"*",tenantName:target.tenant.name,storeName:target.tenant.mode==="solo"?"独立训练空间":target.store.name,alreadyJoined:!!state.activeOwn}};
    });
  }
  async function joinStudentInvite(request,p){
    rejectStudentInviteInput(p,["claimToken","onboardingToken"]);const claimToken=str(p,"claimToken",128);
    return transaction(async()=>{
      const claim=await database.prepare("SELECT * FROM wechat_student_claims WHERE ticket_hash=? FOR UPDATE").get(hash(claimToken)),now=clock(),stamp=now.toISOString();if(!claim)fail(STUDENT_INVITE_ERROR);if(claim.expires_at<=stamp)fail("学员确认凭证已过期，请重新输入邀请码。",410);
      const principal=await phonePrincipal(request,p,claim);assertClaimPrincipal(claim,principal);
      const before=await load(),target=studentTarget(before,claim.member_id);if(!target||target.member.tenantId!==claim.tenant_id||target.member.storeId!==claim.store_id)fail("学员邀请所属范围已变化或不可用，请联系管理员重新邀请。",410);
      const state=await studentGrantState(database,target.member,principal.userId);if(state.otherWechatOwner)fail("该学员已有其他微信授权，不能自动合并或转移。",409);if(state.disabledOwn)fail("当前学员授权已停用，请联系管理员核对，不能通过邀请码重新激活。",409);
      if(claim.used_at){if(!principal.userId||!state.activeOwn||state.link?.user_id!==principal.userId)fail("学员微信授权已失效，请联系管理员。",409);const token=await newSession(principal.userId,state.activeOwn.id,"wechat");return sessionView(await authForToken(token),token);}
      const invite=await database.prepare("SELECT * FROM member_wechat_invites WHERE member_id=? FOR UPDATE").get(claim.member_id);
      if(!invite||invite.generation!==claim.generation||invite.tenant_id!==claim.tenant_id||invite.store_id!==claim.store_id||invite.expires_at<=stamp)fail("学员邀请码已重置或失效，请重新输入邀请码。",410);
      if(invite.claimed_at)fail("学员邀请码已领取，请重新微信登录查看已有授权。",409);
      let userId=principal.userId;
      if(!userId){userId=id("user");await database.prepare("INSERT INTO users(id,account,name,password_hash,status,created_at) VALUES(?,?,?,?,?,?)").run(userId,`wx_${randomBytes(16).toString("hex")}`,target.member.name,"!wechat-only","active",stamp);await database.prepare("INSERT INTO wechat_bindings(openid_hash,user_id,created_at) VALUES(?,?,?)").run(principal.openidHash,userId,stamp);}
      const membershipId=state.activeOwn?.id??await insertMembership(userId,{role:"student",tenantId:target.member.tenantId,storeId:target.member.storeId,memberId:target.member.id,memberIds:[target.member.id],label:[target.tenant.name,target.store?.name||"独立训练空间",ROLE_LABELS.student].join(" · ")});
      if(!state.link)await database.prepare("INSERT INTO wechat_member_links(member_id,user_id,tenant_id,store_id,created_at) VALUES(?,?,?,?,?)").run(target.member.id,userId,target.member.tenantId,target.member.storeId,stamp);
      await database.prepare("UPDATE wechat_student_claims SET user_id=?,used_at=? WHERE ticket_hash=? AND used_at IS NULL").run(userId,stamp,hash(claimToken));
      await database.prepare("UPDATE member_wechat_invites SET claimed_at=?,claimed_user_id=? WHERE member_id=? AND generation=? AND claimed_at IS NULL").run(stamp,userId,target.member.id,claim.generation);
      if(principal.ticketHash)await database.prepare("UPDATE wechat_onboarding SET used_at=? WHERE openid_hash=? AND used_at IS NULL").run(stamp,principal.openidHash);
      const after=structuredClone(before);after.audit.unshift({id:id("audit"),tenantId:target.member.tenantId,storeId:target.member.storeId,actor:target.member.name,actorId:userId,action:"wechat.student-join",detail:"通过管理员单次邀请码确认学员微信授权；保留原有账号与组织身份，不按姓名或手机号合并",createdAt:stamp});await persist(before,after);await bump();
      const token=await newSession(userId,membershipId,"wechat");return sessionView(await authForToken(token),token);
    });
  }
  async function assertStudentWechatBinding(userId){
    const rows=await database.prepare("SELECT * FROM memberships WHERE user_id=? AND role='student'").all(userId),ids=new Set(rows.flatMap(studentMemberIds));
    for(const memberId of ids){const memberRow=await database.prepare("SELECT data FROM members WHERE id=?").get(memberId),member=memberRow?JSON.parse(memberRow.data):{id:memberId};if((await studentGrantState(database,member,userId)).otherWechatOwner)fail("账号中的学员已由其他微信授权，不能合并或转移，请联系管理员核对。",409);}
  }
  async function authorizeWechatPhone(request,p){
    rejectPhoneInput(p,["code","onboardingToken"]);if(!wechatPhoneConfigured())fail("微信手机号授权尚未配置或未启用，请联系服务维护者。",503);const code=str(p,"code",300);
    const initial=await transaction(async()=>{const principal=await phonePrincipal(request,p);checkPhoneRate(request,principal);const now=clock(),stamp=now.toISOString();await database.prepare("DELETE FROM wechat_phone_codes WHERE expires_at < ?").run(stamp);const claim=await database.prepare("INSERT IGNORE INTO wechat_phone_codes(code_hash,created_at,expires_at) VALUES(?,?,?)").run(hash(`${wechatNamespace()}:phone-code:${code}`),stamp,new Date(now.getTime()+DAY).toISOString());if(!claim.changes)fail("该手机号授权码已使用，请重新点击微信手机号授权。",409);return principal;});
    let phone;
    try{phoneExchange??=createWechatPhoneExchange({clock});const result=await phoneExchange(code);phone=validateWechatPhoneResult(result,{appId:wechatNamespace(),now:clock()});}
    catch(error){const status=[400,429,503].includes(error.status)?error.status:502;fail(status===400?"微信手机号授权码无效或已使用，请重新点击授权。":status===503?(error.message||"微信手机号授权尚未配置或未启用，请联系服务维护者。"):status===429?"微信手机号服务请求过于频繁，请稍后再试。":"微信手机号服务暂时不可用，请稍后重新授权。",status);}
    return transaction(async()=>{
      const principal=await phonePrincipal(request,p);if(principal.openidHash!==initial.openidHash||principal.userId!==initial.userId||principal.ticketHash!==initial.ticketHash)fail("微信身份已变化，请重新授权手机号。",403);
      const data=await load(),phoneHash=phoneDigest(phone),matches=[];
      for(const coach of data.coaches){const tenant=data.tenants.find(item=>item.id===coach.tenantId);if(coachPhoneDigest(coach.phone)!==phoneHash||coach.selfManaged||!tenant||tenant.mode==="solo"||(tenant.mode!==undefined&&tenant.mode!=="organization"))continue;const store=data.stores.find(item=>item.id===coach.storeId&&item.tenantId===coach.tenantId),available=await coachAvailability(data,coach,phoneHash,principal.userId);matches.push({coachId:coach.id,storeId:coach.storeId,coachName:coach.name||"教练",tenantName:tenant.name||"未命名品牌",storeName:store?.name||"未命名门店",canJoin:available.canJoin,reason:available.reason,status:coach.status});}
      const now=clock(),stamp=now.toISOString(),claimToken=randomBytes(32).toString("base64url"),expiresAt=new Date(Math.min(now.getTime()+5*60000,principal.ticket?Date.parse(principal.ticket.expires_at):Infinity)).toISOString();await database.prepare("DELETE FROM wechat_phone_claims WHERE expires_at < ?").run(new Date(now.getTime()-DAY).toISOString());await database.prepare("INSERT INTO wechat_phone_claims(ticket_hash,user_id,openid_hash,onboarding_ticket_hash,phone_hash,created_at,expires_at,used_at,coach_id) VALUES(?,?,?,?,?,?,?,NULL,NULL)").run(hash(claimToken),principal.userId,principal.openidHash,principal.ticketHash,phoneHash,stamp,expiresAt);return {claimToken,expiresAt,phoneMasked:`${phone.slice(0,3)}****${phone.slice(-4)}`,matches};
    });
  }
  async function joinWechatCoach(request,p){
    rejectPhoneInput(p,["claimToken","coachId","storeId","onboardingToken"]);const claimToken=str(p,"claimToken",128),coachId=str(p,"coachId",200);
    return transaction(async()=>{
      const claim=await database.prepare("SELECT * FROM wechat_phone_claims WHERE ticket_hash=? FOR UPDATE").get(hash(claimToken)),now=clock(),stamp=now.toISOString();if(!claim)fail("加入门店凭证无效，请重新验证。",400);if(claim.expires_at<=stamp)fail("加入门店凭证已过期，请重新验证。",410);const teamClaim=claim.proof_method==="team_code";if(!claim.used_at&&!teamClaim&&process.env.WECHAT_PHONE_LOGIN_ENABLED?.toLowerCase()==="false")fail("微信手机号加入门店暂未启用，请联系服务维护者。",503);
      const principal=await phonePrincipal(request,p,claim);assertClaimPrincipal(claim,principal);if(claim.used_at&&claim.coach_id!==coachId)fail("该手机号授权已用于其他教练档案，请重新授权。",409);
      const before=await load(),coach=before.coaches.find(item=>item.id===coachId);
      const targetStoreId=teamClaim?claim.team_store_id:coach?.storeId;
      if(p.storeId!==undefined&&(typeof p.storeId!=="string"||p.storeId!==targetStoreId))fail("所选门店与加入凭证不一致，请重新匹配门店。",403);
      if(teamClaim&&(!coach||!coachStores().coachServesStore(coach,targetStoreId)||coach.tenantId!==claim.team_tenant_id))fail(TEAM_MATCH_ERROR,403);
      if(teamClaim&&!claim.used_at&&!await teamCodes.currentClaim(claim))fail("团队码已重置或失效，请重新填写手机号和团队码。",410);
      const available=await coachAvailability(before,coach,claim.phone_hash,principal.userId,targetStoreId);if(!available.canJoin)fail(teamClaim?TEAM_MATCH_ERROR:available.reason,available.conflict?409:403);
      const tenant=before.tenants.find(item=>item.id===coach.tenantId),store=before.stores.find(item=>item.id===targetStoreId&&item.tenantId===coach.tenantId);let userId=principal.userId,changed=false;
      if(!userId){userId=id("user");await database.prepare("INSERT INTO users(id,account,name,password_hash,status,created_at) VALUES(?,?,?,?,?,?)").run(userId,`wx_${randomBytes(16).toString("hex")}`,coach.name,"!wechat-only","active",stamp);await database.prepare("INSERT INTO wechat_bindings(openid_hash,user_id,created_at) VALUES(?,?,?)").run(principal.openidHash,userId,stamp);changed=true;}
      const existing=(await database.prepare("SELECT id,tenant_id,store_id,status FROM memberships WHERE user_id=? AND role='coach' AND coach_id=? ORDER BY seq").all(userId,coachId)).filter(item=>item.tenant_id===coach.tenantId&&item.store_id===targetStoreId);let membership=existing.find(item=>item.status==="active");
      if(!membership&&existing.length)fail("该教练账号授权已停用或归属已变更，请管理员核对后重新开通。",409);
      if(claim.used_at&&!membership)fail("该教练授权已失效，请联系管理员。",409);
      if(!membership){membership={id:await insertMembership(userId,{role:"coach",tenantId:coach.tenantId,storeId:targetStoreId,coachId,label:[tenant.name,store.name,ROLE_LABELS.coach].join(" · ")})};changed=true;}
      const link=await database.prepare("SELECT user_id,phone_hash FROM wechat_coach_links WHERE coach_id=? FOR UPDATE").get(coachId);if(link&&link.user_id!==userId)fail("该教练档案已绑定其他账号，请联系管理员核对。",409);
      if(!link){if(claim.used_at)fail("该教练关联已失效，请重新授权。",409);await database.prepare("INSERT INTO wechat_coach_links(coach_id,user_id,phone_hash,created_at,join_method) VALUES(?,?,?,?,?)").run(coachId,userId,claim.phone_hash,stamp,teamClaim?"team_code":"wechat_phone");changed=true;}else if(link.phone_hash!==claim.phone_hash){if(claim.used_at)fail("手机号关联已变更，请重新授权。",409);await database.prepare("UPDATE wechat_coach_links SET phone_hash=?,join_method=? WHERE coach_id=? AND user_id=?").run(claim.phone_hash,teamClaim?"team_code":"wechat_phone",coachId,userId);changed=true;}
      if(!claim.used_at){await database.prepare("UPDATE wechat_phone_claims SET user_id=?,used_at=?,coach_id=? WHERE ticket_hash=? AND used_at IS NULL").run(userId,stamp,coachId,hash(claimToken));if(principal.ticketHash)await database.prepare("UPDATE wechat_onboarding SET used_at=? WHERE openid_hash=? AND used_at IS NULL").run(stamp,principal.openidHash);}
      if(changed){const after=structuredClone(before);after.audit.unshift({id:id("audit"),tenantId:coach.tenantId,storeId:targetStoreId,actor:coach.name,actorId:userId,action:"wechat.coach-join",detail:teamClaim?"微信身份使用门店团队码确认加入教练档案，手机号由用户填写":"微信验证手机号并确认加入该门店教练身份",createdAt:stamp});await persist(before,after);await bump();}
      const token=await newSession(userId,membership.id,"wechat");return sessionView(await authForToken(token),token);
    });
  }
  function wechatConfigured(){return !!wechatCodeExchange||!!(process.env.WECHAT_APP_ID&&process.env.WECHAT_APP_SECRET);}
  async function exchangeWechat(code){
    if(!wechatConfigured())fail("微信登录尚未配置，请在服务端 .env 填写 WECHAT_APP_ID 和 WECHAT_APP_SECRET。",503);
    const stamp=clock().toISOString(),namespace=process.env.WECHAT_APP_ID||"injected-test-app";
    // 先原子占用一次性code，再调用微信；网络等待期间不占用数据库事务。
    await transaction(async()=>{await database.prepare("DELETE FROM wechat_codes WHERE expires_at < ?").run(stamp);const claim=await database.prepare("INSERT IGNORE INTO wechat_codes(code_hash,expires_at) VALUES(?,?)").run(hash(`${namespace}:${code}`),new Date(clock().getTime()+DAY).toISOString());if(!claim.changes)fail("该微信登录凭证已使用，请重新发起微信登录。",409);});
    let result;
    try{
      if(wechatCodeExchange)result=await wechatCodeExchange(code);
      else{const url=new URL("https://api.weixin.qq.com/sns/jscode2session");url.search=new URLSearchParams({appid:process.env.WECHAT_APP_ID,secret:process.env.WECHAT_APP_SECRET,js_code:code,grant_type:"authorization_code"}).toString();const response=await fetch(url,{signal:AbortSignal.timeout(10000)});if(!response.ok)fail("微信登录服务暂时不可用，请稍后重新授权。",502);result=await response.json();}
    }catch(error){if(error instanceof HttpError)throw error;fail("微信登录服务暂时不可用，请稍后重新授权。",502);}
    if(!result||result.errcode||typeof result.openid!=="string"||!result.openid||result.openid.length>512)fail("微信登录凭证无效或已使用，请重新发起微信登录。",401);return hash(`${namespace}:${result.openid}`);
  }
  async function wechatLoginToken(userId){const user=await database.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(userId);if(!user)fail("该微信绑定的账号当前不可用，请联系管理员。",403);const available=await memberships(userId);if(!available.length)fail("账号无有效组织授权，请联系管理员。",403);return newSession(userId,(available.find(m=>m.role==="student")??available.find(m=>m.role!=="platform")??available[0]).id,"wechat");}
  async function issueOnboarding(openid){
    const now=clock(),ticket=randomBytes(32).toString("base64url"),expiresAt=new Date(now.getTime()+5*60000).toISOString();await database.prepare("DELETE FROM wechat_onboarding WHERE expires_at < ?").run(new Date(now.getTime()-DAY).toISOString());await database.prepare("INSERT INTO wechat_onboarding(ticket_hash,openid_hash,created_at,expires_at,used_at) VALUES(?,?,?,?,NULL)").run(hash(ticket),openid,now.toISOString(),expiresAt);return {needsOnboarding:true,onboardingToken:ticket,expiresAt};
  }
  async function registerWechat(p){
    const onboardingToken=str(p,"onboardingToken",128),name=str(p,"name",30),tenantName=p.tenantName?str(p,"tenantName",60):`${name}的训练空间`,specialty=p.specialty?str(p,"specialty",100):"综合训练";
    return transaction(async()=>{
      const now=clock(),stamp=now.toISOString(),ticket=await database.prepare("SELECT * FROM wechat_onboarding WHERE ticket_hash=? FOR UPDATE").get(hash(onboardingToken));if(!ticket)fail("微信开通凭证无效，请重新发起微信授权。",401);if(ticket.used_at)fail("该微信开通凭证已使用，请重新微信登录。",409);if(ticket.expires_at<=stamp)fail("微信开通凭证已过期，请重新发起微信授权。",410);
      if(await database.prepare("SELECT user_id FROM wechat_bindings WHERE openid_hash=?").get(ticket.openid_hash))fail("该微信已完成开通或绑定，请重新微信登录。",409);
      const before=await load(),data=structuredClone(before),tenantId=id("tenant"),coachId=id("coach"),userId=id("user"),account=`wx_${randomBytes(16).toString("hex")}`;
      data.tenants.push({id:tenantId,mode:"solo",name:tenantName,contact:name,phone:"",plan:"专业版",status:"active",expiresAt:"9999-12-31",createdAt:stamp});data.coaches.push({id:coachId,tenantId,storeId:"",name,specialty,phone:"",status:"approved",certificate:"",certificateExpiresAt:"",rating:0,selfManaged:true});data.audit.push({id:id("audit"),tenantId,actor:name,actorId:userId,action:"wechat.register",detail:"通过微信授权创建独立教练空间，无门店、本人自主管理训练服务",createdAt:stamp});
      await persist(before,data);await database.prepare("INSERT IGNORE INTO meta(`key`,value) VALUES('createdAt',?)").run(stamp);
      await database.prepare("INSERT INTO users(id,account,name,password_hash,status,created_at) VALUES(?,?,?,?,?,?)").run(userId,account,name,"!wechat-only","active",stamp);
      const membershipId=await insertMembership(userId,{role:"hq",tenantId,coachId,label:`${tenantName} · 独立教练`});await database.prepare("INSERT INTO wechat_bindings(openid_hash,user_id,created_at) VALUES(?,?,?)").run(ticket.openid_hash,userId,stamp);await database.prepare("UPDATE wechat_onboarding SET used_at=? WHERE openid_hash=? AND used_at IS NULL").run(stamp,ticket.openid_hash);await bump();return newSession(userId,membershipId,"wechat");
    });
  }
  const server=createServer(async(request,response)=>{
    response.setHeader("Cache-Control","no-store");response.setHeader("X-Content-Type-Options","nosniff");
    try{
      const url=new URL(request.url??"/",`http://${request.headers.host??"localhost"}`),path=url.pathname,method=request.method;if(path.startsWith("/api/")&&!["GET","POST"].includes(method))fail("不支持该请求方式。",405);if(method==="POST")sameOrigin(request);
      let result;
      if(path==="/api/setup"&&method==="GET"){const initialized=await passwordSetupComplete();result={initialized,setupTokenRequired:!initialized&&httpPolicy.setupTokenRequired,wechatConfigured:wechatConfigured(),wechatPhoneConfigured:wechatPhoneConfigured()};}
      else if(path==="/api/setup"&&method==="POST"){
        const p=await body(request);if(await passwordSetupComplete())fail("系统已完成初始化，请使用已有账号登录。",409);
        if(!httpPolicy.validSetupToken(request))fail("开通口令不正确或缺失，请联系部署管理员。",403);
        const {account,password}=credentials(p),name=str(p,"name",30),mode=p.mode??"organization";if(!["solo","organization"].includes(mode))fail("请选择独立教练或机构模式。");
        const tenantName=mode==="solo"?(p.tenantName?str(p,"tenantName",60):`${name}的训练空间`):str(p,"tenantName",60),storeName=mode==="organization"?str(p,"storeName",60):undefined,specialty=mode==="solo"?(p.specialty?str(p,"specialty",100):"综合训练"):undefined;
        const session=await transaction(async()=>{
          if(await passwordSetupComplete())fail("系统已初始化。",409);if(await database.prepare("SELECT id FROM users WHERE account=?").get(account))fail("该登录账号已存在，请换一个账号。");
          const existingUsers=!!(await database.prepare("SELECT id FROM users LIMIT 1").get()),now=clock(),stamp=now.toISOString(),before=await load(),data=structuredClone(before),tenantId=id("tenant"),storeId=mode==="organization"?id("store"):undefined,userId=id("user"),coachId=mode==="solo"?id("coach"):undefined;
          data.tenants.push({id:tenantId,mode,name:tenantName,contact:name,phone:"",plan:"专业版",status:"active",expiresAt:mode==="solo"?"9999-12-31":new Date(now.getTime()+365*DAY).toISOString().slice(0,10),createdAt:stamp});if(mode==="organization")data.stores.push({id:storeId,tenantId,name:storeName,address:"待完善",manager:name,phone:"",status:"active"});else data.coaches.push({id:coachId,tenantId,storeId:"",name,specialty,phone:"",status:"approved",certificate:"",certificateExpiresAt:"",rating:0,selfManaged:true});data.audit.push({id:id("audit"),tenantId,actor:name,actorId:userId,action:"setup",detail:mode==="solo"?"完成独立教练空间开通，无门店、本人自主管理训练服务":"完成本地系统开通，创建品牌与首家门店",createdAt:stamp});
          await persist(before,data);await database.prepare("INSERT IGNORE INTO meta(`key`,value) VALUES('createdAt',?)").run(stamp);await database.prepare("INSERT INTO users(id,account,name,password_hash,status,created_at) VALUES(?,?,?,?,?,?)").run(userId,account,name,passwordHash(password),"active",stamp);
          if(mode==="organization"&&!existingUsers)await insertMembership(userId,{role:"platform",label:"平台管理员"});const hq=await insertMembership(userId,{role:"hq",tenantId,coachId,label:`${tenantName} · ${mode==="solo"?"独立教练":"总部"}`});await bump();const token=await newSession(userId,hq);return sessionView(await authForToken(token),token);
        });cookie(response,session.token,request);result=session;
      }
      else if(path==="/api/auth/session"&&method==="GET")result=await transaction(async()=>sessionView(await authentication(request,false)));
      else if(path==="/api/auth/login"&&method==="POST"){
        const p=await body(request),{account,password}=credentials(p),rateKey=checkLoginRate(request,account);
        result=await transaction(async()=>{const user=await database.prepare("SELECT * FROM users WHERE account=? AND status='active'").get(account);if(!user||!verifyPassword(password,user.password_hash))fail("账号或密码不正确。",401);const available=await memberships(user.id);if(!available.length)fail("账号尚未分配有效组织授权。",403);const preferred=available.find(m=>m.role!=="platform")??available[0],token=await newSession(user.id,preferred.id);return sessionView(await authForToken(token),token);});attempts.delete(rateKey);cookie(response,result.token,request);
      }
      else if(path==="/api/auth/logout"&&method==="POST"){await body(request);await transaction(async()=>{const token=tokenFrom(request);if(token)await database.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));});cookie(response,null,request);result={ok:true};}
      else if(path==="/api/auth/context"&&method==="POST"){
        const p=await body(request);result=await transaction(async()=>{const auth=await authentication(request),membership=auth.memberships.find(m=>m.id===p.membershipId);if(!membership)fail("无权切换到该组织身份。",403);await database.prepare("UPDATE sessions SET membership_id=? WHERE token_hash=?").run(membership.id,hash(auth.token));return sessionView(await authForToken(auth.token));});
      }
      else if(path==="/api/auth/wechat"&&method==="POST"){
        const p=await body(request),openid=await exchangeWechat(str(p,"code",300));result=await transaction(async()=>{const binding=await database.prepare("SELECT user_id FROM wechat_bindings WHERE openid_hash=?").get(openid);if(!binding)return issueOnboarding(openid);const token=await wechatLoginToken(binding.user_id);return sessionView(await authForToken(token),token);});if(result.token)cookie(response,result.token,request);
      }
      else if(path==="/api/auth/wechat/register"&&method==="POST"){
        const p=await body(request);result=await transaction(async()=>{const token=await registerWechat(p);return sessionView(await authForToken(token),token);});cookie(response,result.token,request);
      }
      else if(path==="/api/auth/wechat/phone"&&method==="POST"){result=await authorizeWechatPhone(request,await body(request));}
      else if(path==="/api/auth/wechat/team-match"&&method==="POST"){result=await matchWechatTeam(request,await body(request));}
      else if(path==="/api/auth/wechat/student-preview"&&method==="POST"){result=await previewStudentInvite(request,await body(request));}
      else if(path==="/api/auth/wechat/student-join"&&method==="POST"){result=await joinStudentInvite(request,await body(request));cookie(response,result.token,request);}
      else if(path==="/api/auth/wechat/coach-join"&&method==="POST"){result=await joinWechatCoach(request,await body(request));cookie(response,result.token,request);}
      else if(path==="/api/store-team-code"&&["GET","POST"].includes(method)){result=await manageTeamCode(request,url,method==="POST");}
      else if(path==="/api/member-invite"&&["GET","POST"].includes(method)){result=await manageStudentInvite(request,url,method==="POST");}
      else if(path==="/api/auth/wechat/bind"&&method==="POST"){
        await transaction(async()=>authentication(request));const p=await body(request),openid=await exchangeWechat(str(p,"code",300));await transaction(async()=>{const auth=await authentication(request),existing=await database.prepare("SELECT user_id FROM wechat_bindings WHERE openid_hash=?").get(openid);if(existing&&existing.user_id!==auth.user.id)fail("该微信已绑定其他账号。",409);const current=await database.prepare("SELECT openid_hash FROM wechat_bindings WHERE user_id=?").get(auth.user.id);if(current&&current.openid_hash!==openid)fail("此账号已绑定其他微信，请联系管理员。",409);if(!existing){await assertStudentWechatBinding(auth.user.id);await database.prepare("INSERT INTO wechat_bindings(openid_hash,user_id,created_at) VALUES(?,?,?)").run(openid,auth.user.id,clock().toISOString());}});result={ok:true};
      }
      else if(path==="/api/receipt-attachments"&&method==="POST"){
        await transaction(async()=>receiptRole(await authentication(request)));const file=await receiptMultipart(request),attachmentId=id("receipt");
        result=await transaction(async()=>{const auth=await authentication(request),scope=receiptMemberScope(auth,await load(),file.memberId,file.storeId);await database.prepare("INSERT INTO receipt_attachments(id,tenant_id,store_id,member_id,uploader_id,name,mime,size,content,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(attachmentId,scope.tenantId,scope.storeId,scope.memberId,auth.user.id,file.name,file.mime,file.size,file.content,clock().toISOString());return{id:attachmentId,name:file.name,mime:file.mime,size:file.size};});
      }
      else if(/^\/api\/receipt-attachments\/receipt-[A-Za-z0-9_-]{1,100}$/.test(path)&&method==="GET"){
        const row=await transaction(async()=>{
          const auth=await authentication(request);receiptRole(auth,true);if(url.searchParams.has("token")||url.searchParams.has("access_token"))fail("请通过登录会话下载凭证，不要在链接中传递登录令牌。");const attachmentId=path.split("/").at(-1),attachment=await database.prepare("SELECT * FROM receipt_attachments WHERE id=?").get(attachmentId);if(!attachment)fail("凭证不存在或无权访问。",403);receiptScope(auth,attachment.tenant_id,attachment.store_id,true);
          if(attachment.order_id){const orderRow=await database.prepare("SELECT data FROM orders WHERE id=?").get(attachment.order_id),order=orderRow?JSON.parse(orderRow.data):null;if(!order||order.tenantId!==attachment.tenant_id||order.storeId!==attachment.store_id||order.memberId!==attachment.member_id||!order.receiptAttachmentIds?.includes(attachment.id))fail("凭证未关联有效订单。",403);receiptScope(auth,order.tenantId,order.storeId,true);}return attachment;
        });
        const fallback=row.name.replace(/[^A-Za-z0-9._-]/g,"_"),encoded=encodeURIComponent(row.name).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);response.setHeader("Cache-Control","private, no-store");response.setHeader("Content-Type",row.mime);response.setHeader("Content-Length",row.size);response.setHeader("Content-Disposition",`attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);response.end(Buffer.from(row.content));return;
      }
      else if(/^\/api\/receipt-attachments\/receipt-[A-Za-z0-9_-]{1,100}\/remove$/.test(path)&&method==="POST"){
        await body(request);const attachmentId=path.split("/").at(-2);result=await transaction(async()=>{const auth=await authentication(request);receiptRole(auth);const row=await database.prepare("SELECT id,tenant_id,store_id,uploader_id,order_id FROM receipt_attachments WHERE id=? FOR UPDATE").get(attachmentId);if(!row)fail("凭证不存在或无权删除。",403);receiptScope(auth,row.tenant_id,row.store_id);const data=await load();ensureActiveTenant(personaOf(auth.activeMembership,auth.user,data),data);if(row.uploader_id!==auth.user.id)fail("只能删除自己上传且尚未关联订单的凭证。",403);if(row.order_id)fail("凭证已关联订单，不能删除历史凭证。",409);await database.prepare("DELETE FROM receipt_attachments WHERE id=? AND order_id IS NULL AND uploader_id=?").run(row.id,auth.user.id);return{ok:true};});
      }
      else if(path==="/api/workspace"&&method==="GET"){
        result=await transaction(async()=>{const auth=await authentication(request);if(url.searchParams.has("persona"))fail("身份由登录授权确定，请通过组织切换接口操作。",403);return workspace(auth);});
      }
      else if(path==="/api/card-courses"&&method==="GET"){
        result=await transaction(async()=>{
          const auth=await authentication(request),actor=auth.activeMembership;
          if(!["hq","manager"].includes(actor.role))fail("当前身份无权为课包选择适用课程。",403);
          const keys=[...url.searchParams.keys()];if(keys.some(key=>!["storeId","scope"].includes(key))||keys.some(key=>url.searchParams.getAll(key).length!==1))fail("请使用有效的课程筛选范围，组织及身份由服务端确定。",403);
          const data=await load(),tenant=data.tenants.find(item=>item.id===actor.tenantId);
          if(!tenant)fail("当前训练空间不存在。",403);
          const scope=url.searchParams.get("scope")||"home";if(!["home","all"].includes(scope))fail("请选择有效的课包使用范围。");
          const requestedStore=url.searchParams.get("storeId");const storeId=tenant.mode==="solo"?"":requestedStore??actor.storeId;
          if(tenant.mode==="solo") {if(requestedStore!==null&&requestedStore!=="")fail("独立训练空间没有门店。",403);}
          else {
            if(!storeId)fail("请先选择售卡门店。");
            if(actor.role==="manager"&&storeId!==actor.storeId)fail("只能为本门店的课包选择课程。",403);
            if(!data.stores.some(item=>item.id===storeId&&item.tenantId===tenant.id))fail("售卡门店不属于当前训练空间。",403);
          }
          const {buildCardCourseOptions}=require("../.local-runtime/lib/card-courses.js");
          return {courses:buildCardCourseOptions(data,{tenantId:tenant.id,storeId,scope})};
        });
      }
      else if(path==="/api/coach-candidates"&&method==="GET"){
        result=await transaction(async()=>{
          const auth=await authentication(request),actor=auth.activeMembership;if(!["hq","manager"].includes(actor.role))fail("当前身份无权关联已有教练。",403);
          const keys=[...url.searchParams.keys()];if(keys.some(key=>key!=="storeId")||keys.some(key=>url.searchParams.getAll(key).length!==1))fail("请使用有效的目标门店范围。",403);
          const data=await load(),tenant=data.tenants.find(item=>item.id===actor.tenantId),storeId=url.searchParams.get("storeId"),store=data.stores.find(item=>item.id===storeId&&item.tenantId===actor.tenantId);
          if(!tenant||tenant.mode==="solo"||!store||store.status!=="active"||(actor.role==="manager"&&actor.storeId!==store.id))fail("只能为当前授权机构门店关联教练。",403);ensureActiveTenant(personaOf(actor,auth.user,data),data);
          const today=new Date(clock().getTime()+8*3600000).toISOString().slice(0,10),{coachStoreIds,coachServesStore,coachStoreNames}=coachStores();
          return {coaches:data.coaches.filter(coach=>coach.tenantId===tenant.id&&!coach.selfManaged&&coach.status==="approved"&&coach.certificate.trim()&&validDate(coach.certificateExpiresAt)&&coach.certificateExpiresAt>=today&&coachStoreIds(coach).length&&coachStoreIds(coach).length<20&&coachStoreIds(coach).every(id=>data.stores.some(item=>item.id===id&&item.tenantId===tenant.id))&&!coachServesStore(coach,store.id)).map(coach=>{const phone=normalizedCoachPhone(coach.phone);return {id:coach.id,name:coach.name,specialty:coach.specialty,phoneMasked:phone?`${phone.slice(0,3)}****${phone.slice(-4)}`:"",certificateExpiresAt:coach.certificateExpiresAt,storeNames:coachStoreNames(data,coach)};})};
        });
      }
      else if(path==="/api/coach-report"&&method==="GET"){
        result=await transaction(async()=>{
          const auth=await authentication(request),data=await load(),persona=personaOf(auth.activeMembership,auth.user,data);
          if(!["hq","manager","coach"].includes(persona.role))fail("当前身份无权查看教练账单报表。",403);
          const keys=[...url.searchParams.keys()];if(keys.some(key=>!["dateFrom","dateTo","storeId","coachId"].includes(key))||keys.some(key=>url.searchParams.getAll(key).length!==1))fail("请使用有效的报表筛选条件，身份及组织由服务端确定。",403);
          // Calculate from the full source, then authorise the derived report. A manager's
          // workspace intentionally omits sales ledgers belonging to another store.
          const {authorizedCoachBillingFilter,buildCoachBillingReport}=require("../.local-runtime/lib/coach-billing.js");
          return buildCoachBillingReport(data,authorizedCoachBillingFilter(data,persona,Object.fromEntries(url.searchParams),clock()),clock());
        });
      }
      else if(path==="/api/coach-bills/preview"&&method==="POST"){
        const p=await body(request);if(Object.keys(p).some(key=>key!=="payload")||!p.payload||typeof p.payload!=="object"||Array.isArray(p.payload))fail("请提交有效的教练账单规则，身份由服务端确定。",400);
        result=await transaction(async()=>{
          const auth=await authentication(request),data=await load(),persona=personaOf(auth.activeMembership,auth.user,data);
          if(!["hq","manager"].includes(persona.role))fail("当前身份无权生成或预览教练账单。",403);
          ensureActiveTenant(persona,data);
          const {authorizedCoachBillingFilter,previewCoachBill}=require("../.local-runtime/lib/coach-billing.js");
          return previewCoachBill(data,{...p.payload,...authorizedCoachBillingFilter(data,persona,p.payload,clock())},clock());
        });
      }
      else if(path==="/api/schedules/preview"&&method==="POST"){
        const p=await body(request);if(Object.keys(p).some(key=>!["payload"].includes(key))||!p.payload||typeof p.payload!=="object"||Array.isArray(p.payload))fail("请提交有效的排课规则，身份由服务端确定。",400);
        result=await transaction(async()=>{const auth=await authentication(request),data=await load(),persona=personaOf(auth.activeMembership,auth.user,data);ensureActiveTenant(persona,data);return previewSchedule(data,persona,p.payload,clock());});
      }
      else if(path==="/api/actions"&&method==="POST"){
        await transaction(async()=>authentication(request));const p=await body(request);if(Object.hasOwn(p,"persona")||Object.hasOwn(p,"owner"))fail("不能通过请求参数指定身份或数据拥有者。",403);if(!Number.isSafeInteger(p.version)||p.version<1)fail("缺少有效版本，请刷新后重试。",409);if(!p.payload||typeof p.payload!=="object"||Array.isArray(p.payload))fail("操作参数格式不正确。");if(Object.hasOwn(p.payload,"wxLinked"))fail("微信关联状态由服务端确定，不能自行指定。",403);
        result=await transaction(async()=>{if(await version()!==p.version)fail("数据已被其他人更新，请刷新后重试。",409);const auth=await authentication(request),before=await load(),persona=personaOf(auth.activeMembership,auth.user,before);ensureActiveTenant(persona,before);const claims=await receiptClaims(auth,before,p.action,p.payload);let after;if(p.action==="account.create"){after=structuredClone(before);await createAccount(auth,p.payload,after);}else after=applyAction(before,persona,p.action,p.payload,clock());if(p.action==="coach.store.attach")await syncAttachedCoachMembership(auth,before,after,p.payload);await persist(before,after);await linkReceiptClaims(before,after,claims);await bump();return workspace(await authentication(request));});
      }
      else if(path.startsWith("/api/"))fail("接口不存在。",404);
      else if(staticDir&&method==="GET"){
        const directory=resolve(staticDir),decoded=decodeURIComponent(path),candidate=resolve(directory,`.${decoded}`);if(candidate!==directory&&!candidate.startsWith(directory+sep))fail("文件路径无效。",403);const file=existsSync(candidate)&&statSync(candidate).isFile()?candidate:resolve(directory,"index.html");if(!existsSync(file))fail("前端尚未构建，请先运行构建命令。",503);response.setHeader("Content-Type",({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".json":"application/json"})[extname(file)]??"application/octet-stream");response.end(readFileSync(file));return;
      }else fail("页面不存在。",404);
      response.statusCode=200;response.setHeader("Content-Type","application/json; charset=utf-8");response.end(JSON.stringify(result));
    }catch(error){const status=Number.isInteger(error.status)?error.status:500;if(status>=500)console.error("Local API:",error.message);response.statusCode=status;response.setHeader("Content-Type","application/json; charset=utf-8");response.end(JSON.stringify({error:status===500?"服务暂时异常，请稍后重试。":error.message}));}
  });
  server.database=database;
  server.closeDatabase=()=>{closePromise??=Promise.resolve().then(()=>database.close());return closePromise;};
  return server;
}
