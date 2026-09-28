import Decimal from "decimal.js";
import { roundPoints } from "./pricing";
import { instant } from "./time";
import type { Assignment, Duty, ScoreOperation, Soldier } from "./types";

export function schedulingScore(
  soldier: Soldier,
  assignments: Assignment[]
): number {
  return (
    soldier.currentScore +
    assignments
      .filter(
        (assignment) =>
          assignment.soldierId === soldier.id &&
          (assignment.status === "reserved" || assignment.status === "held")
      )
      .reduce((sum, assignment) => sum + assignment.points, 0)
  );
}

export function applyScoreOperation(
  balance: number,
  operation: ScoreOperation
): { before: number; after: number; delta: number; clamped: boolean } {
  if (
    !Number.isSafeInteger(balance) ||
    balance < 0 ||
    !Number.isFinite(operation.value)
  )
    throw new Error("ערך ניקוד לא תקין");
  if (
    operation.kind !== "reduce_percent" &&
    !Number.isSafeInteger(operation.value)
  )
    throw new Error("פעולת ניקוד דורשת מספר שלם");
  if (
    operation.kind === "reduce_percent" &&
    (operation.value < 0 || operation.value > 100)
  )
    throw new Error("אחוז ההפחתה חייב להיות בין אפס למאה");
  const raw =
    operation.kind === "add"
      ? new Decimal(balance).plus(operation.value)
      : operation.kind === "set"
        ? new Decimal(operation.value)
        : new Decimal(balance)
            .times(new Decimal(100).minus(operation.value))
            .dividedBy(100);
  const after = roundPoints(Decimal.max(0, raw));
  return { before: balance, after, delta: after - balance, clamped: raw.lt(0) };
}

export function rankFairness(
  soldiers: Soldier[]
): { soldierId: string; name: string; score: number; rank: number }[] {
  const sorted = soldiers
    .filter((soldier) => !soldier.deletedAt)
    .sort(
      (a, b) =>
        a.currentScore - b.currentScore ||
        a.name.localeCompare(b.name, "he") ||
        a.id.localeCompare(b.id)
    );
  let previousScore: number | undefined;
  let rank = 0;
  return sorted.map((soldier, index) => {
    if (soldier.currentScore !== previousScore) rank = index + 1;
    previousScore = soldier.currentScore;
    return {
      soldierId: soldier.id,
      name: soldier.name,
      score: soldier.currentScore,
      rank,
    };
  });
}

/** A ledger entry as seen by correction rules; `barrier` marks set, percent, clamped or group operations. */
export interface LedgerEvent {
  id: string;
  soldierId: string;
  kind: string;
  effectiveAt: string;
  recordedAt: string;
  barrier: boolean;
}

/** Barriers in effect from the performance onwards, in effective order, regardless of when they were recorded. */
export function correctionBarriers(
  soldierId: string,
  performedEnd: string,
  events: LedgerEvent[]
): LedgerEvent[] {
  const from = instant(performedEnd).toMillis();
  return events
    .filter(
      (event) =>
        event.soldierId === soldierId &&
        event.barrier &&
        instant(event.effectiveAt).toMillis() >= from
    )
    .sort(
      (a, b) =>
        instant(a.effectiveAt).toMillis() - instant(b.effectiveAt).toMillis() ||
        a.id.localeCompare(b.id)
    );
}

/**
 * The balance reflects `reflected` points of this performance. Without a barrier or an open decision
 * the difference to the corrected history is applied once with a zero floor; otherwise it waits for a manager.
 */
export function correctionEffect(input: {
  balance: number;
  reflected: number;
  corrected: number;
  barriers: LedgerEvent[];
  openDecision: boolean;
}):
  | {
      status: "automatic";
      delta: number;
      after: number;
      clamped: boolean;
    }
  | { status: "decision_required"; rawDelta: number } {
  if (
    ![input.balance, input.reflected, input.corrected].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )
  )
    throw new Error("ניקוד הביצוע חייב להיות שלם ולא שלילי");
  const rawDelta = input.corrected - input.reflected;
  if (input.barriers.length || input.openDecision)
    return { status: "decision_required", rawDelta };
  const raw = input.balance + rawDelta;
  const after = Math.max(0, raw);
  return {
    status: "automatic",
    delta: after - input.balance,
    after,
    clamped: raw < 0,
  };
}

export function dueCredits(
  duties: Duty[],
  assignments: Assignment[],
  now: string
): Assignment[] {
  return assignments
    .filter((assignment) => {
      const duty = duties.find(
        (candidate) => candidate.id === assignment.dutyId
      );
      return (
        assignment.status === "reserved" &&
        !assignment.creditedAt &&
        duty?.status === "published" &&
        instant(duty.end) <= instant(now)
      );
    })
    .sort((a, b) => {
      const first = duties.find((duty) => duty.id === a.dutyId)!;
      const second = duties.find((duty) => duty.id === b.dutyId)!;
      return (
        instant(first.end).toMillis() - instant(second.end).toMillis() ||
        a.id.localeCompare(b.id)
      );
    });
}
