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
export interface TimedQualification extends DateRange {
  qualificationId: string;
}
export interface TimedExemption extends DateRange {
  exemptionId: string;
}
export interface Constraint extends DateRange {
  id: string;
  version: number;
  status: "pending" | "approved" | "rejected";
}
export interface DailyWindow {
  startTime: string;
  endTime: string;
  weekdays?: number[];
}
export interface Soldier {
  id: string;
  name: string;
  personalNumber: string;
  version: number;
  deletedAt?: Instant;
  currentScore: number;
  service: ServiceProfile;
  populationHistory: EffectivePopulation[];
  rankHistory: EffectiveRank[];
  qualifications: TimedQualification[];
  exemptions: TimedExemption[];
  inactivePeriods: DateRange[];
  constraints: Constraint[];
  gender?: string;
  capabilities?: string[];
  allowedHours?: DailyWindow[];
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
  qualificationIds?: string[];
  blockingExemptionIds?: string[];
  genders?: string[];
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
  status: AssignmentStatus;
  version: number;
  creditedAt?: Instant;
  extraPoints?: string;
  approvals?: SpecificApproval[];
  pendingReviewConfirmed?: boolean;
}
export interface SpecificApproval {
  kind: "exemption" | "rank" | "pending_constraint" | "near_release";
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
}
