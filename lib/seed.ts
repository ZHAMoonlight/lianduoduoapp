import type { Persona, WorkspaceData } from "./types";

export const PERSONAS: Persona[] = [
  { id: "platform", role: "platform", label: "平台管理端", name: "林予安", title: "平台运营管理员" },
  { id: "hq", role: "hq", label: "品牌总部端", name: "许知远", title: "力速健身 · 运营总监", tenantId: "t1" },
  { id: "manager", role: "manager", label: "门店工作台", name: "沈悦", title: "静安旗舰店 · 店长", tenantId: "t1", storeId: "s1" },
  { id: "coach", role: "coach", label: "教练工作台", name: "李昊", title: "静安旗舰店 · 认证教练", tenantId: "t1", storeId: "s1", coachId: "c1" },
  { id: "student", role: "student", label: "学员小程序", name: "陈晨", title: "力速健身 · 尊享会员", tenantId: "t1", memberId: "m1", memberIds: ["m1", "m2"] },
];

/** 服务器上海时间的 YYYY-MM-DD，可注入时间以便重现业务测试。 */
export function shanghaiDate(now: Date, offset = 0): string {
  return new Date(now.getTime() + (8 * 60 + offset * 24 * 60) * 60_000).toISOString().slice(0, 10);
}
function at(now: Date, offset: number, time: string) { return `${shanghaiDate(now, offset)}T${time}:00+08:00`; }

export function createSeed(now = new Date()): WorkspaceData {
  const stamp = now.toISOString();
  const expiry = shanghaiDate(now, 180);
  return {
    demo: true, createdAt: stamp, orders: [], ledger: [], followups: [], feedback: [], accounts: [],
    tenants: [
      { id: "t1", name: "力速健身", contact: "许知远", phone: "13800138001", plan: "专业版", status: "active", expiresAt: shanghaiDate(now, 300), createdAt: at(now, -150, "09:00") },
      { id: "t2", name: "星河艺术", contact: "周芸", phone: "13900139001", plan: "基础版", status: "active", expiresAt: shanghaiDate(now, 90), createdAt: at(now, -40, "09:00") },
      { id: "t3", name: "跃动运动馆", contact: "方泽", phone: "13700137001", plan: "基础版", status: "expired", expiresAt: shanghaiDate(now, -5), createdAt: at(now, -370, "09:00") },
    ],
    stores: [
      { id: "s1", tenantId: "t1", name: "静安旗舰店", address: "上海市静安区南京西路 1266 号", manager: "沈悦", phone: "021-62881266", status: "active" },
      { id: "s2", tenantId: "t1", name: "徐汇滨江店", address: "上海市徐汇区龙腾大道 2879 号", manager: "周然", phone: "021-64502879", status: "active" },
      { id: "s3", tenantId: "t1", name: "浦东世纪店", address: "上海市浦东新区锦绣路 888 号", manager: "顾宁", phone: "021-58801888", status: "active" },
      { id: "s4", tenantId: "t2", name: "星河艺术中心", address: "上海市长宁区仙霞路 88 号", manager: "周芸", phone: "021-62001888", status: "active" },
    ],
    coaches: [
      { id: "c1", tenantId: "t1", storeId: "s1", name: "李昊", specialty: "力量训练 · 功能训练", phone: "13800138011", status: "approved", certificate: "NSCA-CPT 私人教练认证", certificateExpiresAt: expiry, rating: 4.9 },
      { id: "c2", tenantId: "t1", storeId: "s2", name: "林可", specialty: "瑜伽普拉提", phone: "13800138012", status: "approved", certificate: "RYT 200 瑜伽导师认证", certificateExpiresAt: expiry, rating: 4.9 },
      { id: "c3", tenantId: "t1", storeId: "s1", name: "赵屿", specialty: "少儿体能", phone: "13800138013", status: "approved", certificate: "少儿体适能高级教练", certificateExpiresAt: expiry, rating: 4.8 },
      { id: "c4", tenantId: "t1", storeId: "s3", name: "陈一诺", specialty: "功能训练", phone: "13800138014", status: "pending", certificate: "ACE 国际私人教练认证", certificateExpiresAt: expiry, rating: 0 },
      { id: "c5", tenantId: "t1", storeId: "s3", name: "王翊", specialty: "力量训练 · 功能训练", phone: "13800138015", status: "approved", certificate: "ACE 国际私人教练认证", certificateExpiresAt: expiry, rating: 4.8 },
    ],
    members: [
      { id: "m1", tenantId: "t1", storeId: "s1", name: "陈晨", phone: "13800138021", joinedAt: at(now, -120, "10:00"), avatar: "陈" },
      { id: "m2", tenantId: "t1", storeId: "s1", name: "陈小满", phone: "13800138021", joinedAt: at(now, -80, "10:00"), avatar: "满" },
      { id: "m3", tenantId: "t1", storeId: "s2", name: "宋佳", phone: "13800138023", joinedAt: at(now, -60, "10:00"), avatar: "宋" },
      { id: "m4", tenantId: "t1", storeId: "s1", name: "顾子涵", phone: "13800138024", joinedAt: at(now, -45, "10:00"), avatar: "顾" },
      { id: "m5", tenantId: "t2", storeId: "s4", name: "周楚", phone: "13800138025", joinedAt: at(now, -20, "10:00"), avatar: "周" },
    ],
    cards: [
      { id: "card1", tenantId: "t1", memberId: "m1", storeId: "s1", name: "全城通练 · 36 次卡", total: 36, remaining: 24, frozen: 2, expiresAt: expiry, scope: "all", classTypes: ["力量训练", "功能训练", "瑜伽普拉提"], status: "active", unitValueCents: 16800 },
      { id: "card2", tenantId: "t1", memberId: "m2", storeId: "s1", name: "少儿体能 · 24 次卡", total: 24, remaining: 18, frozen: 1, expiresAt: expiry, scope: "home", classTypes: ["少儿体能"], status: "active", unitValueCents: 12800 },
      { id: "card3", tenantId: "t1", memberId: "m3", storeId: "s2", name: "全城通练 · 36 次卡", total: 36, remaining: 12, frozen: 1, expiresAt: expiry, scope: "all", classTypes: ["力量训练", "功能训练", "瑜伽普拉提"], status: "active", unitValueCents: 16800 },
      { id: "card4", tenantId: "t1", memberId: "m4", storeId: "s1", name: "静安专属 · 12 次卡", total: 12, remaining: 8, frozen: 0, expiresAt: expiry, scope: "home", classTypes: ["力量训练", "功能训练"], status: "active", unitValueCents: 19800 },
    ],
    classes: [
      { id: "cls-live", tenantId: "t1", storeId: "s1", coachId: "c1", name: "燃力 · 全身塑形", type: "力量训练", startAt: new Date(now.getTime() - 30 * 60_000).toISOString(), endAt: new Date(now.getTime() + 30 * 60_000).toISOString(), capacity: 8, credits: 1, price: 19800, room: "A 区 · 力量训练室", status: "scheduled" },
      { id: "cls-past", tenantId: "t1", storeId: "s2", coachId: "c2", name: "晨间流动瑜伽", type: "瑜伽普拉提", startAt: at(now, -1, "09:00"), endAt: at(now, -1, "10:00"), capacity: 12, credits: 1, price: 19800, room: "瑜伽室", status: "scheduled" },
      { id: "cls-1", tenantId: "t1", storeId: "s1", coachId: "c1", name: "燃力 · 全身塑形", type: "力量训练", startAt: at(now, 1, "10:00"), endAt: at(now, 1, "11:00"), capacity: 8, credits: 1, price: 19800, room: "A 区 · 力量训练室", status: "scheduled" },
      { id: "cls-2", tenantId: "t1", storeId: "s2", coachId: "c2", name: "舒展 · 流动瑜伽", type: "瑜伽普拉提", startAt: at(now, 1, "14:00"), endAt: at(now, 1, "15:00"), capacity: 12, credits: 1, price: 19800, room: "阳光瑜伽室", status: "scheduled" },
      { id: "cls-3", tenantId: "t1", storeId: "s1", coachId: "c3", name: "小小运动家 · 平衡探索", type: "少儿体能", startAt: at(now, 1, "16:00"), endAt: at(now, 1, "17:00"), capacity: 10, credits: 1, price: 16800, room: "少儿运动空间", status: "scheduled" },
      { id: "cls-4", tenantId: "t1", storeId: "s1", coachId: "c1", name: "进阶 · 功能性训练", type: "功能训练", startAt: at(now, 2, "19:00"), endAt: at(now, 2, "20:00"), capacity: 6, credits: 1, price: 19800, room: "B 区 · 综合训练室", status: "scheduled" },
      { id: "cls-5", tenantId: "t1", storeId: "s3", coachId: "c5", name: "轻燃 · 核心训练", type: "功能训练", startAt: at(now, 2, "12:00"), endAt: at(now, 2, "13:00"), capacity: 8, credits: 1, price: 19800, room: "核心训练室", status: "scheduled" },
      { id: "cls-6", tenantId: "t1", storeId: "s2", coachId: "c2", name: "平衡 · 普拉提基础", type: "瑜伽普拉提", startAt: at(now, 3, "10:00"), endAt: at(now, 3, "11:00"), capacity: 10, credits: 1, price: 19800, room: "阳光瑜伽室", status: "scheduled" },
    ],
    bookings: [
      { id: "b1", tenantId: "t1", memberId: "m1", classId: "cls-live", cardId: "card1", status: "reserved", credits: 1, createdAt: at(now, -1, "16:00") },
      { id: "b2", tenantId: "t1", memberId: "m1", classId: "cls-past", cardId: "card1", status: "completed", credits: 1, createdAt: at(now, -2, "16:00"), checkedInAt: at(now, -1, "08:55"), completedAt: at(now, -1, "10:00") },
      { id: "b3", tenantId: "t1", memberId: "m2", classId: "cls-3", cardId: "card2", status: "reserved", credits: 1, createdAt: at(now, 0, "08:00") },
      { id: "b4", tenantId: "t1", memberId: "m3", classId: "cls-live", cardId: "card3", status: "checked_in", credits: 1, createdAt: at(now, -1, "17:00"), checkedInAt: new Date(now.getTime() - 35 * 60_000).toISOString() },
      { id: "b5", tenantId: "t1", memberId: "m1", classId: "cls-1", cardId: "card1", status: "reserved", credits: 1, createdAt: at(now, 0, "08:00") },
    ],
    settlements: [{ id: "st1", tenantId: "t1", bookingId: "b2", fromStoreId: "s1", toStoreId: "s2", amount: 16800, status: "pending", createdAt: at(now, -1, "10:00") }],
    tasks: [
      { id: "task1", tenantId: "t1", storeId: "s1", title: "完成本周场馆安全巡检", description: "检查器械维护、急救用品和消防通道，完成后在此确认。", dueAt: shanghaiDate(now, 1), priority: "high", status: "pending", createdAt: at(now, -1, "09:00") },
      { id: "task2", tenantId: "t1", storeId: "s2", title: "秋季会员关怀回访", description: "联系近 30 天未到店会员并了解训练需求。", dueAt: shanghaiDate(now, 3), priority: "normal", status: "pending", createdAt: at(now, -1, "09:00") },
      { id: "task3", tenantId: "t1", storeId: "s1", title: "更新教练资质档案", description: "核对本月新增教练认证有效期。", dueAt: shanghaiDate(now, -1), priority: "normal", status: "completed", createdAt: at(now, -3, "09:00"), completedAt: at(now, -1, "15:00") },
    ],
    audit: [{ id: "audit1", tenantId: "t1", storeId: "s2", actor: "林可", action: "booking.complete", detail: "陈晨完成晨间流动瑜伽，扣除 1 课时并生成跨店清分单", createdAt: at(now, -1, "10:00") }],
    announcements: [
      { id: "ann1", tenantId: "t1", title: "一起开启秋日训练计划", content: "全城通练卡支持力速健身各门店预约。预约后课时暂时冻结，完成课程后正式扣除；如需取消，请提前 60 分钟操作。", audience: "all", createdAt: at(now, -1, "09:00"), author: "力速健身总部" },
      { id: "ann2", tenantId: "t1", title: "本周服务与安全提醒", content: "课前确认会员状态与出勤，课后及时完成消课。跨店服务由总部统一确认内部清分。", audience: "staff", createdAt: at(now, -2, "09:00"), author: "品牌运营中心" },
      { id: "ann3", title: "平台服务升级通知", content: "多品牌、总部、门店与学员业务已串联。本空间全部为示例数据，可切换预置身份体验。", audience: "all", createdAt: at(now, -2, "09:00"), author: "连多多平台" },
    ],
    applications: [
      { id: "ap1", name: "青禾少儿运动", contact: "杨青", phone: "13600136001", stores: 3, status: "pending", createdAt: at(now, -1, "14:00"), note: "希望统一管理 3 家少儿运动中心" },
      { id: "ap2", name: "一间普拉提", contact: "何悦", phone: "13600136002", stores: 2, status: "pending", createdAt: at(now, -2, "10:00"), note: "咨询跨店约课与课时管理" },
    ],
  };
}
