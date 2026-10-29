export type PersonaId = "platform" | "hq" | "manager" | "coach" | "student";
export type Role = "platform" | "hq" | "manager" | "coach" | "student";
export type WorkspaceMode = "solo" | "organization";
export interface Persona { id: PersonaId; role: Role; label: string; name: string; title: string; workspaceMode?: WorkspaceMode; userId?: string; membershipId?: string; tenantId?: string; storeId?: string; coachId?: string; memberId?: string; memberIds?: string[]; }
export interface Tenant { id: string; mode?: WorkspaceMode; name: string; contact: string; phone: string; plan: "基础版" | "专业版" | "旗舰版"; status: "active" | "suspended" | "expired"; expiresAt: string; createdAt: string; }
export interface Store { id: string; tenantId: string; name: string; address: string; manager: string; phone: string; status: "active" | "inactive"; }
export interface Venue { id: string; tenantId: string; storeId: string; name: string; location: string; description: string; allowShared: boolean; status: "active" | "inactive"; createdAt: string; updatedAt: string; }
export interface Coach { id: string; tenantId: string; /** Legacy primary store; a multi-store coach retains the same identity. */ storeId: string; storeIds?: string[]; name: string; specialty: string; phone: string; status: "pending" | "approved" | "rejected"; certificate: string; certificateExpiresAt: string; rating: number; inviteCode?: string; selfManaged?: boolean; readonly wxLinked?: boolean; }
export interface Member { id: string; tenantId: string; storeId: string; name: string; phone: string; joinedAt: string; avatar: string; coachId?: string; }
export interface CardCourseRule { name: string; type: string; }
export interface CardCourseOption extends CardCourseRule { /** A scheduled class used as the authoritative reference, not an entitlement bound to that date. */ id: string; storeNames: string[]; sessionCount: number; }
export interface Card { id: string; tenantId: string; memberId: string; storeId: string; name: string; total: number; remaining: number; frozen: number; expiresAt: string; scope: "all" | "home"; classTypes: string[]; /** New cards explicitly distinguish unrestricted courses from selected courses; legacy cards omit this field. */ courseMode?: "all" | "selected"; /** Present rules are always exact and never fall back to classTypes. All-course cards omit rules and have empty classTypes. */ courseRules?: CardCourseRule[]; status: "active" | "frozen" | "refunded"; orderId?: string; /** 每课时售卡分摊价值，整数分 */ unitValueCents: number; }
export type ScheduleMode = "recurring" | "availability";
export interface SchedulePlanPublishPayload { mode: ScheduleMode; name: string; type: string; storeId?: string; /** Legacy single-coach input; new clients send coachIds. */ coachId?: string; coachIds?: string[]; /** Explicit confirmation of parallel use within this plan only. */ sharedRoom?: boolean; startDate: string; endDate: string; /** ISO weekday: Monday=1, Sunday=7. */ weekdays: number[]; startTime: string; endTime: string; capacity?: number; durationMinutes?: number; gapMinutes?: number; credits: number; /** 展示价，整数分 */ price: number; venueId?: string; /** Legacy input; managed venues supply the name snapshot. */ room?: string; }
export interface SchedulePlan extends Omit<SchedulePlanPublishPayload, "storeId" | "coachId" | "room"> { id: string; tenantId: string; storeId: string; coachId: string; room: string; capacity: number; status: "active" | "cancelled"; createdAt: string; cancelledAt?: string; cancelReason?: string; }
export interface SchedulePreviewItem { date: string; startAt: string; endAt: string; coachId: string; coachName: string; venueId?: string; room: string; }
export interface SchedulePreview { mode: ScheduleMode; occurrenceCount: number; /** Distinct time intervals before multiplying the selected coaches. */ timeSlotCount: number; coachCount: number; /** Concrete, independently bookable coach sessions. */ slotCount: number; items: SchedulePreviewItem[]; conflicts: (SchedulePreviewItem & { reason: string })[]; }
export interface ClassSession { id: string; tenantId: string; storeId: string; coachId: string; name: string; type: string; startAt: string; endAt: string; capacity: number; credits: number; /** 展示价，整数分 */ price: number; venueId?: string; room: string; status: "scheduled" | "cancelled"; schedulePlanId?: string; bookingMode?: ScheduleMode; /** 服务端容量汇总，学员端不暴露他人预约 */ bookedCount?: number; }
export type BookingStatus = "reserved" | "checked_in" | "completed" | "cancelled" | "no_show" | "late_cancelled";
export interface Booking { id: string; tenantId: string; memberId: string; classId: string; /** Present for new reservations; legacy bookings resolve their coach from classId. */ coachId?: string; cardId: string; status: BookingStatus; credits: number; createdAt: string; checkedInAt?: string; completedAt?: string; cancelledAt?: string; }
export interface Settlement { id: string; tenantId: string; bookingId: string; fromStoreId: string; toStoreId: string; amount: number; unitValueCents?: number; credits?: number; status: "pending" | "confirmed"; createdAt: string; confirmedAt?: string; }
export interface Task { id: string; tenantId: string; storeId: string; title: string; description: string; dueAt: string; priority: "high" | "normal"; status: "pending" | "completed"; createdAt: string; completedAt?: string; }
export interface AuditEvent { id: string; tenantId?: string; storeId?: string; actor: string; actorId?: string; action: string; detail: string; createdAt: string; }
export interface Announcement { id: string; tenantId?: string; title: string; content: string; audience: "all" | "staff" | "students"; createdAt: string; author: string; }
export interface Application { id: string; name: string; contact: string; phone: string; stores: number; status: "pending" | "approved" | "rejected"; createdAt: string; note: string; }
export interface User { id: string; name: string; account: string; }
export interface Membership { id: string; userId: string; role: Role; workspaceMode?: WorkspaceMode; tenantId?: string; storeId?: string; /** 服务端补充的门店展示信息，不作为授权依据。 */ storeName?: string; storeAddress?: string; coachId?: string; memberId?: string; memberIds?: string[]; label: string; }
export interface AuthSession { user: User | null; memberships: Membership[]; activeMembership: Membership | null; token?: string; }
export interface AccountSummary extends User { memberships: Membership[]; }
export interface ReceiptAttachment { id: string; name: string; mime: string; size: number; }
export interface Order { id: string; tenantId: string; storeId: string; memberId: string; cardId: string; amount: number; receipt: string; receiptAttachmentIds?: string[]; /** 服务端按已授权附件记录补充，不接受客户端写入 */ receiptAttachments?: ReceiptAttachment[]; status: "paid" | "refunded"; createdAt: string; refundedAt?: string; refundReceipt?: string; }
export interface LedgerEntry { id: string; tenantId: string; storeId: string; cardId: string; memberId: string; bookingId?: string; type: "issue" | "freeze" | "release" | "consume" | "refund"; credits: number; remaining: number; frozen: number; amount: number; note: string; createdAt: string; }
export interface FollowupComment { id: string; author: string; content: string; createdAt: string; }
export type FollowupOutcome = "resumed" | "renewed" | "paused" | "declined" | "other";
export interface Followup { id: string; tenantId: string; storeId: string; memberId: string; title: string; reason: "low_balance" | "expiring" | "inactive" | "manual"; status: "open" | "contacted" | "closed"; dueAt: string; assignee: string; assigneeCoachId?: string; result: string; outcome?: FollowupOutcome; renewalOrderId?: string; /** 授权跟进的最小订单引用，不含金额/凭证 */ renewalCandidates?: { id: string; createdAt: string; cardName: string }[]; comments: FollowupComment[]; createdAt: string; updatedAt: string; }
export interface TrainingFeedback { id: string; tenantId: string; storeId: string; bookingId: string; memberId: string; coachId: string; author?: string; authorRole?: Role; content: string; rating: number; createdAt: string; }
export type CoachBillRule = { type: "flat_session"; sessionAmountCents: number } | { type: "revenue_share"; basisPoints: number };
export interface CoachBillingFilter { tenantId: string; dateFrom: string; dateTo: string; coachId?: string; storeId?: string; }
export interface CoachBillingTotals { sessionCount: number; completedCount: number; credits: number; durationMinutes: number; /** Sum of known amounts only; missingAmountCount must be displayed. */ consumedAmountCents: number; estimatedCount: number; missingAmountCount: number; ledgerCompletionCount: number; excludedCompletionCount: number; flatBlockedSessionCount: number; }
export interface CoachBillingRow { bookingId: string; classId: string; coachId: string; coachName: string; storeId: string; storeName: string; memberId: string; memberName: string; className: string; classType: string; startAt: string; endAt: string; completedAt: string; completionSource: "booking_completedAt" | "consume_ledger"; credits: number; consumedAmountCents: number | null; estimated: boolean; revenueSource: "consume_ledger" | "card_estimate" | "missing"; existingBillId?: string; existingBillStatus?: "unpaid" | "paid"; flatEligible: boolean; flatBlockedReason?: string; }
export interface CoachBillingReport { dateFrom: string; dateTo: string; coachId?: string; storeId?: string; rows: CoachBillingRow[]; totals: CoachBillingTotals; notes: string[]; }
export interface CoachBillSession { classId: string; className: string; startAt: string; endAt: string; durationMinutes: number; bookingIds: string[]; }
export interface CoachBillDetail extends CoachBillingRow { amountCents: number; }
export interface CoachBillPreview { tenantId: string; coachId: string; coachName: string; storeId: string; storeName: string; dateFrom: string; dateTo: string; rule: CoachBillRule; details: CoachBillDetail[]; sessions: CoachBillSession[]; totals: CoachBillingTotals; amountCents: number; /** Stale or empty previews cannot create a bill. */ blocking: string[]; notes: string[]; previewHash: string; }
export interface CoachBill extends CoachBillPreview { id: string; status: "unpaid" | "paid"; note: string; createdAt: string; createdBy: string; settledAt?: string; settledBy?: string; paidDate?: string; ref?: string; settleNote?: string; }
export interface CoachBillPreviewPayload { coachId: string; storeId?: string; dateFrom: string; dateTo: string; rule: CoachBillRule; note?: string; }
export interface CoachBillCreatePayload extends CoachBillPreviewPayload { expectedPreviewHash: string; }
export interface WorkspaceData { demo: boolean; createdAt: string; tenants: Tenant[]; stores: Store[]; /** Optional only for legacy snapshots; authorised staff responses normalise to []. */ venues?: Venue[]; /** Immutable settlement snapshots; legacy sources may omit the array. */ coachBills?: CoachBill[]; coaches: Coach[]; members: Member[]; cards: Card[]; classes: ClassSession[]; /** Optional only for compatibility with legacy snapshots; server responses normalise to []. */ schedulePlans?: SchedulePlan[]; bookings: Booking[]; settlements: Settlement[]; tasks: Task[]; audit: AuditEvent[]; announcements: Announcement[]; applications: Application[]; orders: Order[]; ledger: LedgerEntry[]; followups: Followup[]; feedback: TrainingFeedback[]; accounts: AccountSummary[]; }
export interface WorkspaceResponse { data: WorkspaceData; persona: Persona; personas: Persona[]; version: number; }
export interface ActionPayloadMap {
  "store.create": { name: string; address: string; manager: string; phone: string; tenantId?: string };
  "store.update": { id: string; name?: string; address?: string; manager?: string; phone?: string; status?: Store["status"] };
  "venue.create": { storeId?: string; name: string; location?: string; description?: string; allowShared?: boolean };
  "venue.update": { id: string; name?: string; location?: string; description?: string; allowShared?: boolean; status?: Venue["status"] };
  "coachBill.create": CoachBillCreatePayload;
  "coachBill.settle": { id: string; paidDate: string; ref?: string; note?: string };
  "member.create": { name: string; phone: string; storeId?: string; coachId?: string };
  "member.update": { id: string; name?: string; phone?: string; coachId?: string };
  "account.create": { name: string; account: string; password: string; role: Role; tenantId?: string; storeId?: string; coachId?: string; memberId?: string; memberIds?: string[] };
  "card.issue": { memberId: string; storeId?: string; name: string; total: number; amount: number; expiresAt: string; scope: Card["scope"]; courseIds?: string[]; classTypes?: string[]; receipt?: string; receiptAttachmentIds?: string[] };
  "card.renew": { id: string; name: string; total: number; amount: number; expiresAt: string; scope: Card["scope"]; courseIds?: string[]; classTypes?: string[]; receipt?: string; receiptAttachmentIds?: string[] };
  "order.refund": { id: string; receipt: string; reason: string };
  "class.cancel": { id: string; reason: string };
  "booking.no_show": { id: string; reason: string };
  "booking.latecancel": { id: string; reason: string };
  "followup.generate": { storeId?: string };
  "followup.create": { memberId: string; title: string; dueAt: string; assignee?: string; assigneeCoachId?: string };
  "followup.update": { id: string; title?: string; dueAt?: string; assignee?: string; assigneeCoachId?: string; status?: "open" | "contacted" };
  "followup.comment": { id: string; content: string };
  "followup.close": { id: string; result: string; outcome?: FollowupOutcome; renewalOrderId?: string };
  "training.feedback": { bookingId: string; content: string; rating: number };
  "tenant.create": { name: string; contact: string; phone: string; plan: Tenant["plan"]; expiresAt: string };
  "tenant.update": { id: string; name?: string; contact?: string; phone?: string; plan?: Tenant["plan"]; status?: Tenant["status"]; expiresAt?: string };
  "application.review": { id: string; approved: boolean; note?: string };
  "coach.review": { id: string; approved: boolean };
  "coach.invite": { name: string; phone: string; storeId: string; specialty: string; certificate?: string; certificateExpiresAt?: string };
  "coach.store.attach": { coachId: string; storeId: string };
  "class.create": { name: string; storeId?: string; coachId?: string; type: string; startAt: string; endAt: string; capacity: number; credits: number; price: number; venueId?: string; room?: string };
  "schedule.publish": SchedulePlanPublishPayload;
  "schedule.cancel": { id: string; reason: string };
  "booking.create": { classId: string; cardId: string; memberId?: string; coachId?: string };
  "booking.cancel": { id: string };
  "booking.checkin": { id: string };
  "booking.complete": { id: string };
  "settlement.confirm": { id: string };
  "task.create": { title: string; description: string; storeId: string; dueAt: string; priority?: Task["priority"] };
  "task.complete": { id: string };
  "announcement.create": { title: string; content: string; audience: Announcement["audience"] };
}
export type ActionName = keyof ActionPayloadMap;
export type ActionRequest = { persona?: PersonaId; action: ActionName; payload: Record<string, unknown>; version: number };
