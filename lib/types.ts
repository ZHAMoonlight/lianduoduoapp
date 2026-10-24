export type PersonaId = "platform" | "hq" | "manager" | "coach" | "student";
export type Role = "platform" | "hq" | "manager" | "coach" | "student";
export interface Persona { id: PersonaId; role: Role; label: string; name: string; title: string; tenantId?: string; storeId?: string; coachId?: string; memberId?: string; memberIds?: string[]; }
export interface Tenant { id: string; name: string; contact: string; phone: string; plan: "基础版" | "专业版" | "旗舰版"; status: "active" | "suspended" | "expired"; expiresAt: string; createdAt: string; }
export interface Store { id: string; tenantId: string; name: string; address: string; manager: string; phone: string; status: "active" | "inactive"; }
export interface Coach { id: string; tenantId: string; storeId: string; name: string; specialty: string; phone: string; status: "pending" | "approved" | "rejected"; certificate: string; certificateExpiresAt: string; rating: number; inviteCode?: string; }
export interface Member { id: string; tenantId: string; storeId: string; name: string; phone: string; joinedAt: string; avatar: string; }
export interface Card { id: string; tenantId: string; memberId: string; storeId: string; name: string; total: number; remaining: number; frozen: number; expiresAt: string; scope: "all" | "home"; classTypes: string[]; status: "active" | "frozen"; /** 每课时售卡分摊价值，整数分 */ unitValueCents: number; }
export interface ClassSession { id: string; tenantId: string; storeId: string; coachId: string; name: string; type: string; startAt: string; endAt: string; capacity: number; credits: number; /** 展示价，整数分 */ price: number; room: string; status: "scheduled" | "cancelled"; /** 服务端容量汇总，学员端不暴露他人预约 */ bookedCount?: number; }
export type BookingStatus = "reserved" | "checked_in" | "completed" | "cancelled";
export interface Booking { id: string; tenantId: string; memberId: string; classId: string; cardId: string; status: BookingStatus; credits: number; createdAt: string; checkedInAt?: string; completedAt?: string; cancelledAt?: string; }
export interface Settlement { id: string; tenantId: string; bookingId: string; fromStoreId: string; toStoreId: string; amount: number; status: "pending" | "confirmed"; createdAt: string; confirmedAt?: string; }
export interface Task { id: string; tenantId: string; storeId: string; title: string; description: string; dueAt: string; priority: "high" | "normal"; status: "pending" | "completed"; createdAt: string; completedAt?: string; }
export interface AuditEvent { id: string; tenantId?: string; storeId?: string; actor: string; action: string; detail: string; createdAt: string; }
export interface Announcement { id: string; tenantId?: string; title: string; content: string; audience: "all" | "staff" | "students"; createdAt: string; author: string; }
export interface Application { id: string; name: string; contact: string; phone: string; stores: number; status: "pending" | "approved" | "rejected"; createdAt: string; note: string; }
export interface WorkspaceData { demo: true; createdAt: string; tenants: Tenant[]; stores: Store[]; coaches: Coach[]; members: Member[]; cards: Card[]; classes: ClassSession[]; bookings: Booking[]; settlements: Settlement[]; tasks: Task[]; audit: AuditEvent[]; announcements: Announcement[]; applications: Application[]; }
export interface WorkspaceResponse { data: WorkspaceData; persona: Persona; personas: Persona[]; version: number; }
export interface ActionPayloadMap {
  "tenant.create": { name: string; contact: string; phone: string; plan: Tenant["plan"]; expiresAt: string };
  "tenant.update": { id: string; name?: string; contact?: string; phone?: string; plan?: Tenant["plan"]; status?: Tenant["status"]; expiresAt?: string };
  "application.review": { id: string; approved: boolean; note?: string };
  "coach.review": { id: string; approved: boolean };
  "coach.invite": { name: string; phone: string; storeId: string; specialty: string; certificate?: string; certificateExpiresAt?: string };
  "class.create": { name: string; storeId: string; coachId: string; type: string; startAt: string; endAt: string; capacity: number; credits: number; price: number; room: string };
  "booking.create": { classId: string; cardId: string; memberId?: string };
  "booking.cancel": { id: string };
  "booking.checkin": { id: string };
  "booking.complete": { id: string };
  "settlement.confirm": { id: string };
  "task.create": { title: string; description: string; storeId: string; dueAt: string; priority?: Task["priority"] };
  "task.complete": { id: string };
  "announcement.create": { title: string; content: string; audience: Announcement["audience"] };
}
export type ActionName = keyof ActionPayloadMap;
export type ActionRequest = { persona: PersonaId; action: ActionName; payload: Record<string, unknown>; version: number };
