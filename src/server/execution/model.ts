import { loadDomain } from "../repository";
import { instant } from "../../domain/time";
import type {
  EligibilityReason,
  InstantRange,
  PriceBreakdown,
} from "../../domain/types";
import { type FixedAllocation } from "./inputs";

export type Domain = Awaited<ReturnType<typeof loadDomain>>;
export type SeatRow = Domain["assignments"][number];
export type DutyRow = Domain["duties"][number];

export const ACTIVE = ["reserved", "held"];
export const SEAT = [...ACTIVE, "credited"];

type ChangeKind =
  "keep" | "update" | "create" | "cancel" | "late" | "correct" | "remove";

interface Effect {
  status: "automatic" | "decision_required";
  soldierId: string;
  historyBefore: number;
  historyAfter: number;
  reflected: number;
  balance: number;
  balanceVersion: number;
  delta?: number;
  after?: number;
  clamped?: boolean;
  rawDelta?: number;
  barrierIds: string[];
  barriers: { id: string; reason: string; effectiveAt: string }[];
  from: string;
  decisionId?: string;
  decisionVersion?: number;
}

export interface Change {
  kind: ChangeKind;
  soldierId: string;
  name: string;
  row?: SeatRow;
  /** The row this change writes; a new id when the performer had no row. */
  rowId: string;
  from?: InstantRange;
  to?: InstantRange;
  price?: PriceBreakdown;
  allocation?: FixedAllocation;
  /** Points before the change: stored for an open row, recorded for a credited one. */
  pointsBefore: number;
  effect?: Effect;
  eligibility?: {
    status: string;
    blockers: EligibilityReason[];
    requirements: (EligibilityReason & { key: string })[];
    /** Pending constraints exist and continuing before their review was not confirmed. */
    pendingReview: boolean;
  };
  findings: { code: string; message: string }[];
}

export interface ExecutionPlanOptions {
  mode: "manual" | "volunteer";
  reviewPending?: boolean;
  approvalKeys?: string[];
  allocations?: FixedAllocation[];
  /** Assignments of other seats as they will be after the same operation (a swap moves two). */
  overrides?: SeatRow[];
}

export const range = (value: InstantRange) => ({
  start: value.start,
  end: value.end,
});

export const display = (value: string) =>
  instant(value).toFormat("dd.MM.yyyy HH:mm");
