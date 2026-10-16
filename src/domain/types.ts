/** Persistable domain contracts. Date ranges are inclusive; instant ranges are [start,end). */
export type LocalDate = string;
export type Instant = string;
export type Population = "mandatory" | "career" | "academic";
export type AssignmentStatus = "reserved" | "credited" | "cancelled" | "held";
export interface DateRange {
  start: LocalDate;
  end: LocalDate;
}
export interface InstantRange {
  start: Instant;
  end: Instant;
}
export interface EffectivePopulation {
  effectiveFrom: LocalDate;
  population: Population;
}
export interface EffectiveRank {
  effectiveFrom: LocalDate;
  rankId: string;
  trackId: string;
  order: number;
}
export interface ServiceProfile {
  type: "mandatory" | "career";
  basePopulation: Population;
  arrivalDate?: LocalDate;
  enlistmentDate?: LocalDate;
  graceEligible: boolean;
  permanentFrom?: LocalDate;
  officerFrom?: LocalDate;
  releaseDate?: LocalDate;
}
/**
 * Validity of a capability or exemption (decision 224). A missing start means
 * it applies from always, a missing end means it is permanent; both are inclusive.
 */
export interface OpenDateRange {
  start?: LocalDate;
  end?: LocalDate;
}
export interface TimedCapability extends OpenDateRange {
  capabilityId: string;
}
export interface TimedExemption extends OpenDateRange {
  exemptionId: string;
  /**
   * An hours exemption (decision 226): copied from its catalog entry, it limits
   * every duty to these windows instead of blocking the duty types that list it.
   */
  windows?: DailyWindow[];
}
export interface Constraint extends DateRange {
  id: string;
  version: number;
  status: "pending" | "approved" | "rejected";
}
/** Weekdays use ISO numbering: 1 = Monday … 7 = Sunday. */
export interface DailyWindow {
  startTime: string;
  endTime: string;
  weekdays?: number[];
}
export type Gender = "male" | "female" | "other";
export interface Soldier {
  id: string;
  /** Full name for display: first and last name joined (decision 222). */
  name: string;
  firstName?: string;
  lastName?: string;
  /**
   * Issued by the database when the soldier is created and never changed; it
   * comes from the row, not from the stored profile (decision 222).
   */
  idNumber?: number;
  version: number;
  deletedAt?: Instant;
  /**
   * Derived from the account role when the unit is loaded, never stored in the
   * soldier's data: a duty manager is never assigned to a duty (decision 192).
   */
  isManager?: boolean;
  currentScore: number;
  service: ServiceProfile;
  populationHistory: EffectivePopulation[];
  rankHistory: EffectiveRank[];
  exemptions: TimedExemption[];
  inactivePeriods: DateRange[];
  constraints: Constraint[];
  gender?: Gender;
  /** Capabilities from the catalog, with or without an end date (decision 224). */
  capabilities?: TimedCapability[];
}
export interface RankClause {
  trackId: string;
  rankIds?: string[];
  minOrder?: number;
  maxOrder?: number;
}
/** Clauses are alternatives; duty and slot requirements are both mandatory. */
export interface Requirements {
  populations?: Population[];
  ranks?: RankClause[];
  blockingExemptionIds?: string[];
  genders?: Gender[];
  capabilityIds?: string[];
}
export interface TimeSurcharge {
  id: string;
  name: string;
  points: string;
  window: DailyWindow;
  threshold: { kind: "any_overlap" } | { kind: "minimum_hours"; hours: string };
  frequency: "once" | "per_window";
}
export interface Pricing {
  mode: "fixed" | "daily";
  basePoints: string;
  surcharges: TimeSurcharge[];
  /**
   * A saved call-up amount the system suggests. It never applies by itself:
   * the manager marks a call-up and approves or changes the amount per seat.
   */
  callUpPoints?: string;
}
export interface DutySlot {
  id: string;
  role: string;
  requirements?: Requirements;
  extraPoints?: string;
}
export interface Duty extends InstantRange {
  id: string;
  typeId: string;
  name: string;
  version: number;
  rulesVersion?: number;
  status: "draft" | "published" | "cancelled";
  wasPublished?: boolean;
  /** First publication; duty reminders skip times that passed before it. */
  publishedAt?: string;
  location?: string;
  instructions?: string;
  requirements: Requirements;
  restBeforeMinutes: number;
  restAfterMinutes: number;
  pricing: Pricing;
  slots: DutySlot[];
}
export interface Assignment {
  id: string;
  dutyId: string;
  slotId: string;
  soldierId: string;
  points: number;
  /** Value before execution allocations; the current reserved value may change. */
  originalPoints?: number;
  status: AssignmentStatus;
  version: number;
  creditedAt?: Instant;
  extraPoints?: string;
  /** Manager-approved share of the fixed base after a seat is split. */
  fixedBaseAllocation?: string;
  approvals?: SpecificApproval[];
  pendingReviewConfirmed?: boolean;
  /**
   * The part of the duty this assignment covers once a seat is split into
   * execution periods. Absent means the whole duty.
   */
  performedStart?: Instant;
  performedEnd?: Instant;
  performance?: Performance;
  /**
   * Set when a manager decided the seat of a soldier who was deleted while the
   * duty ran (decision 196). Until then the seat is not credited automatically.
   */
  deletionDecidedAt?: Instant;
  deletionDecidedBy?: string;
}
export interface SpecificApproval {
  kind:
    | "exemption"
    | "rank"
    | "allowed_hours"
    | "pending_constraint"
    | "near_release";
  soldierId: string;
  dutyId: string;
  dutyVersion: number;
  soldierVersion?: number;
  referenceId?: string;
  referenceVersion?: number;
  reason: string;
  approvedBy: string;
  approvedAt: Instant;
}
export interface EligibilityContext {
  duties: Duty[];
  assignments: Assignment[];
  mode: "automatic" | "manual" | "volunteer";
  approvals?: SpecificApproval[];
  ignoreAssignmentIds?: string[];
  pendingReviewConfirmed?: boolean;
}
export interface EligibilityReason {
  code: string;
  message: string;
  referenceId?: string;
  referenceVersion?: number;
}
export interface EligibilityResult {
  status: "eligible" | "blocked" | "approval_required";
  blockers: EligibilityReason[];
  approvalsRequired: EligibilityReason[];
}
export interface PriceBreakdown {
  base: string;
  extras: string;
  surcharges: {
    id: string;
    windows: string[];
    count: number;
    subtotal: string;
  }[];
  totalExact: string;
  points: number;
}
export interface ScoreOperation {
  kind: "add" | "set" | "reduce_percent";
  value: number;
}
/** The performance recorded for a credited assignment and the part of it each balance reflects. */
export interface Performance {
  performerId: string;
  start: Instant;
  end: Instant;
  points: number;
  reflected: Record<string, number>;
  corrections: number;
  /** A credited execution period later recorded as not performed by anyone. */
  removed?: boolean;
}
