import Decimal from "decimal.js";
import { roundPoints } from "./pricing";
import { instant } from "./time";
import type {
  Assignment,
  Duty,
  ScoreEvent,
  ScoreOperation,
  Soldier,
} from "./types";

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

/** A barrier changes the meaning of a raw historical delta, so history can change while current balance awaits a decision. */
export function correctionImpact(
  soldierId: string,
  performedAt: string,
  previousPoints: number,
  correctedPoints: number,
  events: ScoreEvent[]
):
  | { status: "automatic"; delta: number }
  | {
      status: "decision_required";
      barrierIds: string[];
      proposedDelta: number;
    } {
  if (
    ![previousPoints, correctedPoints].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )
  )
    throw new Error("ניקוד הביצוע חייב להיות שלם ולא שלילי");
  const barrierIds = events
    .filter(
      (event) =>
        event.soldierId === soldierId &&
        instant(event.effectiveAt) >= instant(performedAt) &&
        (event.kind === "normalization" ||
          event.kind === "set" ||
          event.kind === "reduce_percent" ||
          event.clamped)
    )
    .map((event) => event.id);
  return barrierIds.length
    ? {
        status: "decision_required",
        barrierIds,
        proposedDelta: correctedPoints - previousPoints,
      }
    : { status: "automatic", delta: correctedPoints - previousPoints };
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
