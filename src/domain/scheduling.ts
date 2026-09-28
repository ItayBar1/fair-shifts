import { evaluateEligibility } from "./eligibility";
import { schedulingScore } from "./scoring";
import type { Duty, DutySlot, EligibilityContext, Soldier } from "./types";

/** The caller persists each result and reloads the unit before selecting the next seat. */
export function drawCandidate(
  people: Soldier[],
  duty: Duty,
  slot: DutySlot,
  weight: number,
  context: EligibilityContext,
  random: (bandSize: number) => number
) {
  if (!Number.isSafeInteger(weight) || weight < 0)
    throw new Error("שווי התורנות אינו תקין");
  if (weight === 0) return { status: "manual_only" as const, candidates: [] };
  const evaluated = people.map((soldier) => ({
    soldier,
    eligibility: evaluateEligibility(soldier, duty, slot, context),
    score: schedulingScore(soldier, context.assignments),
  }));
  const available = evaluated.filter(
    (candidate) => candidate.eligibility.status !== "blocked"
  );
  if (!available.length)
    return { status: "unfilled" as const, candidates: evaluated };
  const minimum = Math.min(...available.map((candidate) => candidate.score));
  const band = available
    .filter((candidate) => candidate.score < minimum + weight)
    .sort((a, b) => a.soldier.id.localeCompare(b.soldier.id));
  const value = random(band.length);
  if (!(value >= 0 && value < 1))
    throw new Error("מקור האקראיות חייב להחזיר מספר בטווח [0,1)");
  const selected = band[Math.floor(value * band.length)];
  return {
    status:
      selected.eligibility.status === "approval_required"
        ? ("approval_required" as const)
        : ("selected" as const),
    selected,
    minimum,
    band: band.map((candidate) => candidate.soldier.id),
    candidates: evaluated,
  };
}
