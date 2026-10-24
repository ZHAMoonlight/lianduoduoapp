import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { workspaces } from "../db/schema";
import { applyAction, DomainError, getPersona, projectWorkspace } from "./domain";
import { createSeed } from "./seed";
import { resolveOwner } from "./request-auth";
import type { WorkspaceData, WorkspaceResponse } from "./types";

async function readOrCreate(owner: string) {
  const db = getDb();
  let [row] = await db.select().from(workspaces).where(eq(workspaces.owner, owner)).limit(1);
  if (!row) {
    const now = new Date();
    await db.insert(workspaces).values({ owner, data: createSeed(now), version: 1, updatedAt: now.toISOString() }).onConflictDoNothing({ target: workspaces.owner });
    [row] = await db.select().from(workspaces).where(eq(workspaces.owner, owner)).limit(1);
  }
  if (!row) throw new DomainError("体验空间初始化失败，请重试。", 503);
  return { db, row };
}

export async function loadWorkspace(request: Request): Promise<WorkspaceResponse> {
  const owner = resolveOwner(request);
  const persona = new URL(request.url).searchParams.get("persona") ?? "hq";
  getPersona(persona);
  const { row } = await readOrCreate(owner);
  return projectWorkspace(row.data as WorkspaceData, persona, row.version);
}

export async function mutateWorkspace(request: Request): Promise<WorkspaceResponse> {
  const owner = resolveOwner(request);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) throw new DomainError("请求来源不匹配，请从应用页面重新操作。", 403);
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new DomainError("请使用 JSON 格式提交操作。", 415);
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > 64_000) throw new DomainError("请求内容过长，请精简后重试。", 413);
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 64_000) throw new DomainError("请求内容过长，请精简后重试。", 413);
    body = JSON.parse(raw);
  } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError("请求内容须为有效 JSON。", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new DomainError("操作请求格式不正确。");
  getPersona(body.persona);
  if (typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 1) throw new DomainError("缺少有效数据版本，请刷新后再操作。", 409);
  const { db, row } = await readOrCreate(owner);
  if (row.version !== body.version) throw new DomainError("数据刚刚发生变化，请刷新后重试。", 409);
  const now = new Date();
  const data = applyAction(row.data as WorkspaceData, body.persona, body.action, body.payload, now);
  // D1 单条 UPDATE 是原子事务。并发请求只能有一个命中相同版本。
  const rows = await db.update(workspaces).set({ data, version: row.version + 1, updatedAt: now.toISOString() }).where(and(eq(workspaces.owner, owner), eq(workspaces.version, row.version))).returning({ version: workspaces.version });
  if (rows.length !== 1) throw new DomainError("另一项操作已先完成，请刷新数据后重试。", 409);
  return projectWorkspace(data, body.persona, rows[0].version);
}

export function apiError(error: unknown) {
  if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  console.error("Workspace request failed", error instanceof Error ? error.message : "unknown error");
  return Response.json({ error: "服务暂时不可用，请稍后重试。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
