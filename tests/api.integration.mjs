// 仅访问本机构建后的 Worker（npm run start），使用随机私有 owner。
// Vinext 开发服务器的 mockAuth 会剥离认证头，因此不能用于该集成测试。
// LIANDUODUO_TEST_URL=http://127.0.0.1:3000 node --test tests/api.integration.mjs
import assert from "node:assert/strict";
import test from "node:test";

const base = process.env.LIANDUODUO_TEST_URL ?? "http://127.0.0.1:3000";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname), "该测试只允许本机预览地址");
const owner = `integration-${crypto.randomUUID()}`;
const headers = { "oai-authenticated-user-id": owner, "Content-Type": "application/json" };
const get = async (persona = "hq", user = owner) => {
  const response = await fetch(`${base}/api/workspace?persona=${persona}`, { headers: { "oai-authenticated-user-id": user } });
  assert.equal(response.status, 200); return response.json();
};
const post = async (persona, action, payload, version, extraHeaders = {}) => {
  const response = await fetch(`${base}/api/actions`, { method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ persona, action, payload, version }) });
  return { status: response.status, body: await response.json() };
};

test("D1 API：私有空间、角色过滤、CAS、冻结扣课清分完整闭环", async () => {
  // 在任何写操作前确认运行环境会保留可信认证头。开发服务器会拒绝此探测，
  // 防止被剥离身份头后意外修改页面正在使用的 local-demo 空间。
  const authProbe = await fetch(`${base}/api/workspace?persona=hq`, { headers: { "oai-authenticated-user-id": owner, Host: "workspace-integration.invalid" } });
  assert.equal(authProbe.status, 200, "请使用 npm run start 的本机构建预览；开发服务器会剥离测试身份头，测试已在写入前停止");
  const initial = await get();
  assert.equal(initial.version, 1); assert.equal(initial.data.demo, true);
  assert.equal(initial.persona.id, "hq"); assert.equal(initial.data.tenants.length, 1);
  assert.equal((await get("platform")).data.tenants.length, 3);
  const student = await get("student");
  assert.ok(student.data.members.every((m) => ["m1", "m2"].includes(m.id)));
  assert.equal(student.data.classes.find((c) => c.id === "cls-live").bookedCount, 2);

  const csrf = await post("student", "booking.create", { classId: "cls-2", cardId: "card1" }, 1, { Origin: "https://unrelated.example" });
  assert.equal(csrf.status, 403);
  const plain = await post("student", "booking.create", { classId: "cls-2", cardId: "card1" }, 1, { "Content-Type": "text/plain" });
  assert.equal(plain.status, 415);
  const forged = await post("student", "booking.create", { classId: "cls-2", cardId: "card3", memberId: "m3" }, 1);
  assert.equal(forged.status, 403);

  const concurrent = await Promise.all([
    post("student", "booking.create", { classId: "cls-2", cardId: "card1" }, 1),
    post("student", "booking.create", { classId: "cls-2", cardId: "card1" }, 1),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  let current = await get("student");
  assert.equal(current.version, 2);
  assert.equal(current.data.cards.find((c) => c.id === "card1").frozen, 3);
  assert.equal(current.data.cards.find((c) => c.id === "card1").remaining, 24);
  assert.equal(current.data.bookings.filter((b) => b.classId === "cls-2" && b.status !== "cancelled").length, 1);

  const booking = current.data.bookings.find((b) => b.classId === "cls-2");
  const cancelled = await post("student", "booking.cancel", { id: booking.id }, current.version);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.cards.find((c) => c.id === "card1").frozen, 2);

  current = await get("manager");
  assert.equal((await post("manager", "booking.complete", { id: "b1" }, current.version)).status, 400);
  const checked = await post("manager", "booking.checkin", { id: "b1" }, current.version);
  assert.equal(checked.status, 200);
  const consumed = await post("coach", "booking.complete", { id: "b1" }, checked.body.version);
  assert.equal(consumed.status, 200);
  const retry = await post("coach", "booking.complete", { id: "b1" }, consumed.body.version);
  assert.equal(retry.status, 200);
  current = await get("student");
  assert.equal(current.data.cards.find((c) => c.id === "card1").remaining, 23);
  assert.equal(current.data.cards.find((c) => c.id === "card1").frozen, 1);

  const cross = await post("coach", "booking.complete", { id: "b4" }, current.version);
  assert.equal(cross.status, 200);
  current = await get("hq");
  const settlement = current.data.settlements.find((s) => s.bookingId === "b4");
  assert.equal(settlement.amount, 16800); assert.equal(settlement.status, "pending");
  assert.equal((await post("manager", "settlement.confirm", { id: settlement.id }, current.version)).status, 403);
  const confirm = await post("hq", "settlement.confirm", { id: settlement.id }, current.version);
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.data.settlements.find((s) => s.id === settlement.id).status, "confirmed");

  const isolated = await get("student", `integration-isolated-${crypto.randomUUID()}`);
  assert.equal(isolated.version, 1);
  assert.equal(isolated.data.cards.find((c) => c.id === "card1").remaining, 24);
  assert.equal(isolated.data.bookings.find((b) => b.id === "b1").status, "reserved");
  const paused = await post("platform", "tenant.update", { id: "t1", status: "suspended" }, confirm.body.version);
  assert.equal(paused.status, 200);
  const blocked = await post("student", "booking.create", { classId: "cls-4", cardId: "card1" }, paused.body.version);
  assert.equal(blocked.status, 403);
  assert.equal((await get("student")).data.cards.find((c) => c.id === "card1").remaining, 23);
});
