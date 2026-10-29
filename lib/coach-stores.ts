import type { Coach, WorkspaceData } from "./types";

/** A single coach identity retains its legacy primary store across assignments. */
export function coachStoreIds(coach: Pick<Coach,"storeId"|"storeIds">): string[] {
  if(typeof coach.storeId!=="string")return [];
  if(!Object.hasOwn(coach,"storeIds"))return [coach.storeId];
  const ids=coach.storeIds;
  if(!Array.isArray(ids)||!ids.length||ids.length>20||ids.some(id=>typeof id!=="string"||id!==id.trim()||!id&&coach.storeId!=="")||new Set(ids).size!==ids.length)return [];
  if(coach.storeId==="")return ids.length===1&&ids[0]===""?[""]:[];
  const all=[...new Set([coach.storeId,...ids])];return all.length<=20&&!all.includes("")?all:[];
}
export function coachServesStore(coach: Pick<Coach,"storeId"|"storeIds">,storeId:string): boolean { return coachStoreIds(coach).includes(storeId); }
export function coachStoreNames(data:Pick<WorkspaceData,"stores">,coach:Pick<Coach,"tenantId"|"storeId"|"storeIds">):string[]{return coachStoreIds(coach).map(id=>id?data.stores.find(store=>store.id===id&&store.tenantId===coach.tenantId)?.name||"历史门店":"独立训练空间");}
