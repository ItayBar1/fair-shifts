import { invariant } from "../errors";
import { evaluateEligibility } from "../../domain/eligibility";
import type { Duty, Soldier } from "../../domain/types";
import { nameOf as soldierName, notifySoldier } from "../seat-requests";
import { type Domain } from "./types";

export function candidateEligibility(
  state: Domain,
  person: Soldier,
  duty: Duty,
  slotId: string,
  period?: { start: string; end: string }
) {
  const slot = duty.slots.find((row) => row.id === slotId);
  invariant(slot, "not_found", "המקום לא נמצא בתורנות", 404);
  return evaluateEligibility(
    person,
    period ? { ...duty, ...period } : duty,
    slot,
    {
      duties: state.duties,
      assignments: state.assignments,
      mode: "volunteer",
    }
  );
}
export function nameOf(state: Domain, soldierId: string) {
  return soldierName(state.soldiers, soldierId);
}
export const notify = notifySoldier;
