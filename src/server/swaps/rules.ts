import type { DbTransaction } from "../db";
import { invariant } from "../errors";
import { evaluateEligibility } from "../../domain/eligibility";
import { instant } from "../../domain/time";
import type { Assignment, Duty, SpecificApproval } from "../../domain/types";
import { executionPeriod } from "../../domain/execution";
import {
  notifySoldier,
  dutyRulesVersion,
  remainingPeriod,
} from "../seat-requests";
import { type Domain, type SwapData, type SwapEntry } from "./types";

export const rulesVersion = dutyRulesVersion;
export const hasStarted = (duty: Duty) =>
  instant(duty.start).toMillis() <= Date.now();
export const notify = (
  tx: DbTransaction,
  soldierId: string,
  input: Omit<Parameters<typeof notifySoldier>[2], "scope">
) => notifySoldier(tx, soldierId, { ...input, scope: "swap" });

/**
 * Eligibility of `soldierId` for `seat` as it would stand after the swap: the soldier's own
 * source seat is ignored, so the two seats never conflict with each other.
 */
export function afterSwap(
  state: Domain,
  soldierId: string,
  seat: Assignment,
  leaving: string,
  approvals: SpecificApproval[] = [],
  now = Date.now()
) {
  const person = state.soldiers.find((row) => row.id === soldierId);
  const duty = state.duties.find((row) => row.id === seat.dutyId);
  invariant(person && duty, "not_found", "החייל או התורנות לא נמצאו", 404);
  const slot = duty.slots.find((row) => row.id === seat.slotId);
  invariant(slot, "not_found", "המקום לא נמצא בתורנות", 404);
  // A seat that started can only be taken over for what is left of it (decision 183).
  const rest = remainingPeriod(seat, duty, now);
  return evaluateEligibility(person, rest ? { ...duty, ...rest } : duty, slot, {
    duties: state.duties,
    assignments: state.assignments,
    // Both soldiers consented, so both are volunteers (decision 163).
    mode: "volunteer",
    ignoreAssignmentIds: [leaving],
    approvals,
  });
}

/** A seat can be offered until its own period ends; after the start only if it can be split. */
export function movable(seat: Assignment, duty: Duty, whose: string) {
  invariant(
    instant(executionPeriod(seat, duty).end).toMillis() > Date.now(),
    "performance_ended",
    `הביצוע בתורנות ${whose} כבר הסתיים. תיקון ביצוע נעשה בידי אחראי`,
    409
  );
  if (!hasStarted(duty)) return;
}

export function sides(
  state: Domain,
  data: SwapData,
  entry: SwapEntry,
  seat: Assignment,
  target: Assignment,
  approvals: SpecificApproval[] = []
) {
  return [
    {
      soldierId: entry.soldierId,
      dutyName: data.dutyName,
      eligibility: afterSwap(
        state,
        entry.soldierId,
        seat,
        target.id,
        approvals
      ),
    },
    {
      soldierId: data.fromSoldierId,
      dutyName: entry.dutyName,
      eligibility: afterSwap(
        state,
        data.fromSoldierId,
        target,
        seat.id,
        approvals
      ),
    },
  ];
}
