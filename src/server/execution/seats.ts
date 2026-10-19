import { eq } from "drizzle-orm";
import Decimal from "decimal.js";
import type { DbTransaction } from "../db";
import { records } from "../schema";
import { loadDomain, type Workflow } from "../repository";
import { invariant } from "../errors";
import { executionPeriod, type ExecutionSegment } from "../../domain/execution";
import { instant } from "../../domain/time";
import type {
  Assignment,
  Duty,
  InstantRange,
  Performance,
} from "../../domain/types";
import { type FixedAllocation } from "./inputs";
import {
  ACTIVE,
  type Domain,
  type DutyRow,
  SEAT,
  type SeatRow,
  display,
  range,
} from "./model";
import { type ExecutionPlan } from "./plan";

export function currentPerformance(
  row: SeatRow,
  duty: DutyRow,
  credits: Map<string, number>
): Performance {
  if (row.performance) return row.performance;
  const period = executionPeriod(row, duty);
  const amount = credits.get(row.id) ?? row.points;
  return {
    performerId: row.soldierId,
    start: period.start,
    end: period.end,
    points: amount,
    reflected: { [row.soldierId]: amount },
    corrections: 0,
  };
}

/** Segments of a seat as recorded today, with the parts marked as not performed. */
export function seatSegments(
  state: Domain,
  duty: DutyRow,
  slotId: string,
  seatRecord?: Workflow
) {
  const rows = state.assignments.filter(
    (row) =>
      row.dutyId === duty.id &&
      row.slotId === slotId &&
      SEAT.includes(row.status)
  );
  const segments: (ExecutionSegment & { rowId?: string; credited: boolean })[] =
    rows.map((row) => ({
      ...range(executionPeriod(row, duty)),
      soldierId: row.performance?.performerId ?? row.soldierId,
      rowId: row.id,
      credited: row.status === "credited",
    }));
  for (const part of (seatRecord?.data.notPerformed ?? []) as InstantRange[])
    segments.push({ ...range(part), soldierId: null, credited: false });
  return {
    rows,
    segments: segments.sort(
      (a, b) => instant(a.start).toMillis() - instant(b.start).toMillis()
    ),
  };
}

export async function seatRecordOf(
  tx: DbTransaction,
  dutyId: string,
  slotId: string
) {
  const rows = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "seat_execution"));
  return rows.find(
    (row) => row.data.dutyId === dutyId && row.data.slotId === slotId
  );
}

/** The original fixed extra stays attached to the seat, even after a performer is removed. */
export function fixedExtraTotal(
  rows: SeatRow[],
  seatRecord?: Workflow
): string {
  if (seatRecord?.data.fixedExtraTotal !== undefined)
    return String(seatRecord.data.fixedExtraTotal);
  return rows
    .reduce(
      (sum, row) => sum.plus(new Decimal(row.extraPoints || "0")),
      new Decimal(0)
    )
    .toString();
}

export function allocationDraft(
  duty: Duty,
  target: Map<string, ExecutionSegment>,
  byPerformer: Map<string, SeatRow>,
  extraTotal: string
): FixedAllocation[] {
  const performers = [...target.keys()];
  const draft = performers.map((soldierId) => {
    const row = byPerformer.get(soldierId);
    return {
      soldierId,
      ...(duty.pricing.mode === "fixed" && {
        fixedBase:
          row?.fixedBaseAllocation ??
          (byPerformer.size === 1 && row ? duty.pricing.basePoints : "0"),
      }),
      fixedExtra: row?.extraPoints ?? "0",
    };
  });
  if (!draft.length) return draft;
  const extraRemainder = new Decimal(extraTotal).minus(
    draft.reduce((sum, item) => sum.plus(item.fixedExtra), new Decimal(0))
  );
  if (new Decimal(draft[0]!.fixedExtra).plus(extraRemainder).isNegative()) {
    draft.forEach((item) => {
      item.fixedExtra = "0";
    });
    draft[0]!.fixedExtra = extraTotal;
  } else {
    draft[0]!.fixedExtra = new Decimal(draft[0]!.fixedExtra)
      .plus(extraRemainder)
      .toString();
  }
  if (duty.pricing.mode === "fixed") {
    const baseRemainder = new Decimal(duty.pricing.basePoints).minus(
      draft.reduce(
        (sum, item) => sum.plus(item.fixedBase || "0"),
        new Decimal(0)
      )
    );
    if (
      new Decimal(draft[0]!.fixedBase || "0").plus(baseRemainder).isNegative()
    ) {
      draft.forEach((item) => {
        item.fixedBase = "0";
      });
      draft[0]!.fixedBase = String(duty.pricing.basePoints);
    } else {
      draft[0]!.fixedBase = new Decimal(draft[0]!.fixedBase || "0")
        .plus(baseRemainder)
        .toString();
    }
  }
  return draft;
}

/**
 * A seat of a soldier deleted while the duty ran waits for the manager's decision
 * (decision 196). Confirming the recorded period, without changing it, is one.
 */
export function deletionPending(plan: ExecutionPlan) {
  return plan.rows.some(
    (row) =>
      ACTIVE.includes(row.status) &&
      !row.deletionDecidedAt &&
      plan.state.soldiers.find(
        (person) =>
          person.id === (row.performance?.performerId ?? row.soldierId)
      )?.deletedAt
  );
}

/** A referred request lets the manager confirm the recorded periods without changing them. */
export async function pendingReferral(tx: DbTransaction, plan: ExecutionPlan) {
  const seatIds = new Set(plan.rows.map((row) => row.id));
  return (
    await tx.select().from(records).where(eq(records.kind, "request"))
  ).some(
    (row) =>
      row.data.type === "cancellation" &&
      row.data.status === "referred" &&
      !row.data.executionId &&
      seatIds.has(String(row.data.assignmentId))
  );
}

/**
 * The seat after a handover at `at`: the leaving soldier keeps the part before it and the
 * replacement covers the rest of that soldier's period (transfers and swaps after the start).
 */
export function handoverSegments(
  current: ExecutionSegment[],
  leavingId: string,
  replacementId: string,
  at: string
): ExecutionSegment[] {
  const own = current.find((segment) => segment.soldierId === leavingId);
  invariant(own, "not_found", "תקופת הביצוע של המוסר לא נמצאה", 404);
  const moment = instant(at).toMillis();
  invariant(
    moment > instant(own.start).toMillis() &&
      moment < instant(own.end).toMillis(),
    "invalid_handover",
    `מועד החילוף חייב להיות בתוך תקופת הביצוע של המוסר: ${display(own.start)} עד ${display(own.end)}`,
    422
  );
  const handover = instant(at).toISO()!;
  return current.flatMap((segment) =>
    segment === own
      ? [
          { soldierId: leavingId, start: own.start, end: handover },
          { soldierId: replacementId, start: handover, end: own.end },
        ]
      : [
          {
            soldierId: segment.soldierId,
            start: segment.start,
            end: segment.end,
          },
        ]
  );
}

/** The seat of an assignment and its current segments, for flows that move a started seat. */
export async function seatOf(tx: DbTransaction, assignment: Assignment) {
  const state = await loadDomain(tx);
  const duty = state.duties.find((row) => row.id === assignment.dutyId);
  invariant(duty, "not_found", "התורנות לא נמצאה", 404);
  const record = await seatRecordOf(tx, duty.id, assignment.slotId);
  return {
    duty,
    ...seatSegments(state, duty, assignment.slotId, record),
  };
}
