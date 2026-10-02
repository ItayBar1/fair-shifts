import { describe, expect, it } from "vitest";
import { evaluateEligibility } from "../../src/domain/eligibility";
import { assignment, duty, soldier } from "../fixtures";
import type { Duty, EligibilityContext } from "../../src/domain/types";

// Rest before and after a duty (story 14, scenario 9). Instants [start, end): a
// duty that starts exactly when the other's rest ends does not collide.
const earlier = (over: Partial<Duty> = {}) =>
  duty({
    id: "earlier",
    start: "2026-09-27T04:00:00+03:00",
    end: "2026-09-27T06:00:00+03:00",
    ...over,
  });
const target = (over: Partial<Duty> = {}) =>
  duty({
    start: "2026-09-27T08:00:00+03:00",
    end: "2026-09-27T12:00:00+03:00",
    ...over,
  });
function check(
  held: Duty,
  mine: Duty,
  context: Partial<EligibilityContext> = {},
  held_assignment = assignment({ id: "held", dutyId: held.id })
) {
  return evaluateEligibility(soldier(), mine, mine.slots[0], {
    duties: [held],
    assignments: [held_assignment],
    mode: "automatic",
    ...context,
  });
}
const collides = (result: ReturnType<typeof check>) =>
  result.blockers.some((reason) => reason.code === "overlap_or_rest");

describe("rest after the earlier duty", () => {
  it.each([
    [119, false],
    [120, false],
    [121, true],
  ])("with %i minutes it collides: %s", (minutes, expected) =>
    expect(
      collides(check(earlier({ restAfterMinutes: minutes }), target()))
    ).toBe(expected)
  );
});

describe("rest before the later duty", () => {
  it.each([
    [119, false],
    [120, false],
    [121, true],
  ])("with %i minutes it collides: %s", (minutes, expected) =>
    expect(
      collides(check(earlier(), target({ restBeforeMinutes: minutes })))
    ).toBe(expected)
  );
  it("also holds when the soldier already has the later duty", () => {
    const later = target({ id: "later", restBeforeMinutes: 45 });
    const mine = (end: string) =>
      duty({ start: "2026-09-27T05:00:00+03:00", end });
    expect(collides(check(later, mine("2026-09-27T07:15:00+03:00")))).toBe(
      false
    );
    expect(collides(check(later, mine("2026-09-27T07:16:00+03:00")))).toBe(
      true
    );
  });
});

describe("rest after the duty being chosen", () => {
  it.each([
    [60, false],
    [61, true],
  ])(
    "with %i minutes it collides with a later duty: %s",
    (minutes, expected) => {
      const later = target({
        id: "later",
        start: "2026-09-27T10:00:00+03:00",
        end: "2026-09-27T12:00:00+03:00",
      });
      const mine = duty({
        start: "2026-09-27T07:00:00+03:00",
        end: "2026-09-27T09:00:00+03:00",
        restAfterMinutes: minutes,
      });
      expect(collides(check(later, mine))).toBe(expected);
    }
  );
});

describe("duties without rest", () => {
  it("allows a duty that starts the minute the other ends, and blocks one minute of overlap", () => {
    const back = earlier({ end: "2026-09-27T08:00:00+03:00" });
    expect(collides(check(back, target()))).toBe(false);
    expect(
      collides(check(back, target({ start: "2026-09-27T07:59:00+03:00" })))
    ).toBe(true);
  });
  it("lets a cancelled duty leave no rest window", () =>
    expect(
      collides(
        check(earlier({ restAfterMinutes: 600, status: "cancelled" }), target())
      )
    ).toBe(false));
});

describe("the same check whoever is choosing", () => {
  const tight = earlier({ restAfterMinutes: 180 });
  it.each(["automatic", "manual", "volunteer"] as const)(
    "blocks in %s mode, as it does for a consenting replacement",
    (mode) => expect(collides(check(tight, target(), { mode }))).toBe(true)
  );
  it("does not count the seat that is being given away", () =>
    expect(
      collides(check(tight, target(), { ignoreAssignmentIds: ["held"] }))
    ).toBe(false));
});

describe("rest follows what was actually performed", () => {
  it("counts it from the end of the soldier's period, not of the whole duty", () => {
    const long = earlier({
      start: "2026-09-27T04:00:00+03:00",
      end: "2026-09-27T10:00:00+03:00",
      restAfterMinutes: 60,
    });
    expect(
      collides(
        check(
          long,
          target({
            start: "2026-09-27T10:30:00+03:00",
            end: "2026-09-27T14:00:00+03:00",
          })
        )
      )
    ).toBe(true);
    const left = assignment({
      id: "held",
      dutyId: "earlier",
      performedStart: "2026-09-27T04:00:00+03:00",
      performedEnd: "2026-09-27T06:00:00+03:00",
    });
    expect(collides(check(long, target(), {}, left))).toBe(false);
  });
});

describe("rest in real minutes across the clock change", () => {
  // Israel moves to summer time on 2027-03-26 at 02:00. An hour and a half of
  // rest after 01:30 ends at 04:00 on the new clock, not at 03:00.
  const night = earlier({
    start: "2027-03-26T00:30:00+02:00",
    end: "2027-03-26T01:30:00+02:00",
    restAfterMinutes: 90,
  });
  const next = (start: string, end: string) => target({ start, end });
  it("still rests at 03:30 summer time", () =>
    expect(
      collides(
        check(
          night,
          next("2027-03-26T03:30:00+03:00", "2027-03-26T07:00:00+03:00")
        )
      )
    ).toBe(true));
  it("is free from 04:00 summer time", () =>
    expect(
      collides(
        check(
          night,
          next("2027-03-26T04:00:00+03:00", "2027-03-26T07:00:00+03:00")
        )
      )
    ).toBe(false));
});
