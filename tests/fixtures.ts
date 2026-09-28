import type { Soldier, Duty, Assignment } from "../src/domain/types";
export function soldier(overrides: Partial<Soldier> = {}): Soldier {
  return {
    id: "a",
    name: "חייל בדיקה",
    personalNumber: "00001",
    version: 1,
    currentScore: 0,
    service: {
      type: "mandatory",
      basePopulation: "mandatory",
      graceEligible: false,
    },
    populationHistory: [],
    rankHistory: [],
    qualifications: [],
    exemptions: [],
    inactivePeriods: [],
    constraints: [],
    ...overrides,
  };
}
export function duty(overrides: Partial<Duty> = {}): Duty {
  return {
    id: "d",
    typeId: "t",
    name: "בדיקה",
    version: 1,
    status: "draft",
    start: "2026-09-27T08:00:00+03:00",
    end: "2026-09-27T16:00:00+03:00",
    requirements: {},
    restBeforeMinutes: 0,
    restAfterMinutes: 0,
    pricing: { mode: "fixed", basePoints: "4", surcharges: [] },
    slots: [{ id: "s", role: "תורן" }],
    ...overrides,
  };
}
export function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: "as",
    dutyId: "d",
    slotId: "s",
    soldierId: "a",
    points: 4,
    status: "reserved",
    version: 1,
    ...overrides,
  };
}
