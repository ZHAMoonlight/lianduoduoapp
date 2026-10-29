import type { ClassSession, Persona, Venue, WorkspaceData } from "./types";

export class VenueError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = "VenueError"; }
}
function fail(message: string, status = 400): never { throw new VenueError(message, status); }
/** Shared with schema migration; preserve display case while comparing normalised names. */
export function normalizeVenueName(name: string): string { return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(); }
function field(p: Record<string, unknown>, key: string, max: number, required = false): string {
  if (typeof p[key] !== "string") fail(`请填写有效的场地${key === "name" ? "名称" : key === "location" ? "位置" : "说明"}。`);
  let value = (p[key] as string).normalize("NFKC").trim();
  if (key === "name" || key === "room") value = value.replace(/\s+/g, " ");
  if (required && !value || value.length > max) fail(`场地${key === "name" ? "名称" : key === "location" ? "位置" : "说明"}须${required ? "填写且" : ""}不超过 ${max} 个字。`);
  return value;
}
function shared(p: Record<string, unknown>): boolean { if (typeof p.allowShared !== "boolean") fail("请选择场地是否允许并行授课。"); return p.allowShared; }
function scope(data: WorkspaceData, persona: Persona, storeId: string) {
  if (!["hq", "manager"].includes(persona.role) || !persona.tenantId) fail("当前身份无权管理场地。", 403);
  const solo = data.tenants.some(item => item.id === persona.tenantId && item.mode === "solo");
  if (solo) { if (storeId !== "") fail("独立训练空间没有门店。", 403); }
  else if (!data.stores.some(item => item.id === storeId && item.tenantId === persona.tenantId)) fail("请选择授权品牌内的门店。", 403);
  if (persona.role === "manager" && storeId !== persona.storeId) fail("只能管理本门店的场地。", 403);
}
type VenueReference = Pick<ClassSession, "tenantId" | "storeId" | "room" | "venueId">;
export function sameVenue(data: WorkspaceData, first: VenueReference, second: VenueReference): boolean {
  if (first.tenantId !== second.tenantId || first.storeId !== second.storeId) return false;
  if (first.venueId && second.venueId) return first.venueId === second.venueId;
  if (!first.venueId && !second.venueId) return normalizeVenueName(first.room) === normalizeVenueName(second.room);
  const managed = first.venueId ? first : second, legacy = first.venueId ? second : first;
  const venue = data.venues?.find(item => item.id === managed.venueId && item.tenantId === managed.tenantId && item.storeId === managed.storeId);
  return normalizeVenueName(legacy.room) === normalizeVenueName(managed.room) || !!venue && normalizeVenueName(legacy.room) === normalizeVenueName(venue.name);
}
/** Explicit IDs never fall back to room text. Old clients can resolve existing scoped names. */
export function resolveVenue(data: WorkspaceData, tenantId: string, storeId: string, p: Record<string, unknown>): { room: string; venueId?: string; venue?: Venue } {
  const venues = (data.venues ?? []).filter(item => item.tenantId === tenantId && item.storeId === storeId);
  let venue: Venue | undefined;
  if (p.venueId !== undefined) {
    if (typeof p.venueId !== "string" || !p.venueId.trim() || p.venueId.trim().length > 191) fail("请选择有效场地。");
    venue = data.venues?.find(item => item.id === (p.venueId as string).trim());
    if (!venue) fail("场地不存在或已失效。", 404);
    if (venue.tenantId !== tenantId || venue.storeId !== storeId) fail("只能选择当前训练空间或门店的场地。", 403);
  } else {
    const room = field(p, "room", 60, true);
    venue = venues.find(item => normalizeVenueName(item.name) === normalizeVenueName(room));
    if (!venue && venues.length) fail("请选择场地管理中已有的场地，不能自行填写未登记场地。");
    if (!venue) return { room };
  }
  if (venue.status !== "active") fail("该场地已停用，请选择其他场地。");
  return { room: venue.name, venueId: venue.id, venue };
}
function bindLegacy(data: WorkspaceData, venue: Venue) {
  for (const item of [...data.classes, ...(data.schedulePlans ?? [])]) {
    if (!item.venueId && item.tenantId === venue.tenantId && item.storeId === venue.storeId && normalizeVenueName(item.room) === normalizeVenueName(venue.name)) item.venueId = venue.id;
  }
}
function hasConcurrentCoaches(data: WorkspaceData, venue: Venue, now: Date): boolean {
  const occupied = data.classes.filter(cls => cls.status === "scheduled" && Date.parse(cls.endAt) > now.getTime() && sameVenue(data, cls, { ...venue, room: venue.name, venueId: venue.id }));
  return occupied.some((first, index) => occupied.slice(index + 1).some(second => first.coachId !== second.coachId && Date.parse(first.startAt) < Date.parse(second.endAt) && Date.parse(second.startAt) < Date.parse(first.endAt)));
}
export function executeVenueAction(data: WorkspaceData, persona: Persona, action: string, p: Record<string, unknown>, now: Date): Venue {
  const allowed = action === "venue.create" ? ["storeId", "name", "location", "description", "allowShared"] : ["id", "name", "location", "description", "allowShared", "status"];
  if (Object.keys(p).some(key => !allowed.includes(key))) fail("场地信息包含不能修改的字段。", 403);
  data.venues ??= [];
  let venue: Venue;
  if (action === "venue.create") {
    if (p.storeId !== undefined && typeof p.storeId !== "string") fail("请选择有效门店。");
    const storeId = typeof p.storeId === "string" ? p.storeId.trim() : persona.storeId ?? "";
    scope(data, persona, storeId);
    venue = { id: `venue-${crypto.randomUUID()}`, tenantId: persona.tenantId!, storeId, name: field(p, "name", 60, true), location: p.location === undefined ? "" : field(p, "location", 160), description: p.description === undefined ? "" : field(p, "description", 500), allowShared: p.allowShared === undefined ? false : shared(p), status: "active", createdAt: now.toISOString(), updatedAt: now.toISOString() };
  } else {
    const existing = data.venues.find(item => item.id === p.id);
    if (!existing) fail("场地不存在或已失效。", 404);
    if (existing.tenantId !== persona.tenantId) fail("无权修改其他品牌的场地。", 403);
    scope(data, persona, existing.storeId);
    venue = { ...existing, updatedAt: now.toISOString() };
    if (p.name !== undefined) venue.name = field(p, "name", 60, true);
    if (p.location !== undefined) venue.location = field(p, "location", 160);
    if (p.description !== undefined) venue.description = field(p, "description", 500);
    if (p.allowShared !== undefined) venue.allowShared = shared(p);
    if (p.status !== undefined) { if (p.status !== "active" && p.status !== "inactive") fail("场地状态无效。"); venue.status = p.status; }
    if (venue.status === "inactive" && data.classes.some(cls => cls.status === "scheduled" && Date.parse(cls.endAt) > now.getTime() && sameVenue(data, cls, { ...existing, room: existing.name, venueId: existing.id }))) fail("场地仍有未来或正在进行的课程，请先取消相关课程再停用。", 409);
    if (existing.allowShared && !venue.allowShared && hasConcurrentCoaches(data, existing, now)) fail("场地仍有未来或正在进行的多教练同时授课，请先调整或取消相关课程，再改为独占场地。", 409);
    bindLegacy(data, existing);
  }
  if (data.venues.some(item => item.id !== venue.id && item.tenantId === venue.tenantId && item.storeId === venue.storeId && normalizeVenueName(item.name) === normalizeVenueName(venue.name))) fail("同一训练空间或门店内已有同名场地。", 409);
  if (action === "venue.create") {
    if (!venue.allowShared && hasConcurrentCoaches(data, venue, now)) fail("该场地已有未来或正在进行的多教练同时授课，请允许共享或先调整相关课程，再登记为独占场地。", 409);
    data.venues.push(venue); bindLegacy(data, venue);
  }
  else data.venues[data.venues.findIndex(item => item.id === venue.id)] = venue;
  return venue;
}

export function assertVenueInvariants(data: WorkspaceData) {
  const ids = new Set<string>(), names = new Set<string>();
  for (const venue of data.venues ?? []) {
    const key = JSON.stringify([venue.tenantId, venue.storeId, normalizeVenueName(venue.name)]);
    if (!venue.id || ids.has(venue.id) || !venue.name.trim() || venue.name.length > 60 || names.has(key) || typeof venue.allowShared !== "boolean" || !["active", "inactive"].includes(venue.status) || typeof venue.location !== "string" || typeof venue.description !== "string" || !data.tenants.some(item => item.id === venue.tenantId) || !(venue.storeId === "" ? data.tenants.some(item => item.id === venue.tenantId && item.mode === "solo") : data.stores.some(item => item.id === venue.storeId && item.tenantId === venue.tenantId))) fail("场地信息或归属异常，操作已撤回。", 409);
    ids.add(venue.id); names.add(key);
  }
  for (const item of [...data.classes, ...(data.schedulePlans ?? [])]) {
    if (item.venueId && !data.venues?.some(venue => venue.id === item.venueId && venue.tenantId === item.tenantId && venue.storeId === item.storeId)) fail("课程或排课计划的场地归属异常，操作已撤回。", 409);
  }
}
