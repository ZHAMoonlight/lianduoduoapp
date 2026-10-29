import type { Coach } from "./types";
import { coachServesStore } from "./coach-stores";

export interface SchedulingOptions {
  tenantId?: string;
  storeId?: string;
  type: string;
  /** Local course date (Asia/Shanghai), YYYY-MM-DD. */
  date: string;
  soloCoachId?: string;
}

export interface SchedulingCoach {
  coach: Coach;
  disabled: boolean;
  reason: string;
}

export interface SchedulingSelection {
  courseTypes: string[];
  effectiveType: string;
  coaches: SchedulingCoach[];
  available: Coach[];
}

function specialties(coach: Coach): string[] {
  return coach.specialty.split(/[·、,，/]/).map(value => value.trim()).filter(Boolean);
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function unavailableReason(coach: Coach, date: string, solo: boolean): string {
  if (coach.status === "pending") return "待审核，通过审核后可排课";
  if (coach.status !== "approved") return "资质审核未通过";
  if (!validDate(date)) return "请先选择有效的上课日期";
  if (solo) return "";
  if (!coach.certificate.trim()) return "尚未填写资质证书";
  if (!validDate(coach.certificateExpiresAt)) return "资质有效期未完善";
  if (coach.certificateExpiresAt < date) return "资质在上课日期已过期";
  return "";
}

/** UI availability mirrors domain qualification checks; the server still authorises every write. */
export function schedulingOptions(coaches: readonly Coach[], options: SchedulingOptions): SchedulingSelection {
  const solo = !!options.soloCoachId;
  // A missing scope must never turn into an all-store coach picker.
  const scoped = !options.tenantId || (!solo && !options.storeId) ? [] : coaches.filter(coach =>
    coach.tenantId === options.tenantId && (solo
      ? coach.id === options.soloCoachId && coach.selfManaged === true && coach.storeId === ""
      : coachServesStore(coach,options.storeId!)));
  const courseTypes = [...new Set(scoped.flatMap(specialties))];
  const requestedType = options.type.trim();
  const effectiveType = solo ? requestedType : courseTypes.includes(requestedType) ? requestedType : courseTypes[0] || "";
  const candidates = scoped.filter(coach => solo || specialties(coach).includes(effectiveType)).map(coach => {
    const reason = unavailableReason(coach, options.date, solo);
    return { coach, disabled: !!reason, reason };
  });
  return { courseTypes, effectiveType, coaches: candidates, available: candidates.filter(candidate => !candidate.disabled).map(candidate => candidate.coach) };
}
