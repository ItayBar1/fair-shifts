import type { Soldier, Duty, Assignment } from "../src/domain/types";
/**
 * A fixed ID number for a soldier a test inserts (decision 222). The database
 * issues numbers from 1, so the offset keeps fixed ones apart from issued ones.
 */
export const testIdNumber = (key: string | number) =>
  1_000_000_000 + Number(key);
/**
 * The details a profile form requires (decision 222), from a test's full name:
 * the first word is the first name, the rest the last name.
 */
/** First and last name for an import row, from a test's full name. */
export function testNames(name: string) {
  const [firstName, ...rest] = name.split(" ");
  return { firstName, lastName: rest.join(" ") || firstName };
}
export function testProfile(name: string, phone = "0500000000") {
  const [firstName, ...rest] = name.split(" ");
  return {
    firstName,
    lastName: rest.join(" ") || firstName,
    gender: "other" as const,
    phone,
  };
}
export function soldier(overrides: Partial<Soldier> = {}): Soldier {
  return {
    id: "a",
    name: "חייל בדיקה",
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
