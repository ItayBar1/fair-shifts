import { describe, expect, it } from "vitest";
import { calculatePrice, priceSplitExecution } from "../../src/domain/pricing";
import {
  evaluateEligibility,
  canAccessAfterService,
} from "../../src/domain/eligibility";
import { drawCandidate } from "../../src/domain/scheduling";
import {
  applyScoreOperation,
  correctionBarriers,
  correctionEffect,
  dueCredits,
  rankFairness,
  schedulingScore,
} from "../../src/domain/scoring";
import { graceEnd, resolveLocalTime } from "../../src/domain/time";
import { duty, soldier, assignment } from "../fixtures";
import type { EligibilityContext, Pricing } from "../../src/domain/types";
const context: EligibilityContext = {
  duties: [],
  assignments: [],
  mode: "automatic",
};
const base: Pricing = { mode: "daily", basePoints: "4", surcharges: [] };
describe("pricing and execution", () => {
  it("prices 36 actual hours at six points", () =>
    expect(
      calculatePrice(base, "2026-09-27T08:00:00Z", "2026-09-28T20:00:00Z")
        .points
    ).toBe(6));
  it("rounds only after all components have been added", () =>
    expect(
      calculatePrice(
        { mode: "fixed", basePoints: "0.25", surcharges: [] },
        duty().start,
        duty().end,
        "0.25"
      ).points
    ).toBe(1));
  it("counts an overnight window once and applies its minimum", () => {
    const pricing: Pricing = {
      ...base,
      surcharges: [
        {
          id: "night",
          name: "לילה",
          points: "2",
          window: { startTime: "22:00", endTime: "06:00" },
          threshold: { kind: "minimum_hours", hours: "4" },
          frequency: "per_window",
        },
      ],
    };
    const result = calculatePrice(
      pricing,
      "2026-09-27T23:00:00+03:00",
      "2026-09-28T05:00:00+03:00"
    );
    expect(result.surcharges[0]).toMatchObject({
      count: 1,
      windows: ["2026-09-27"],
    });
    expect(result.points).toBe(3);
    expect(
      calculatePrice(
        pricing,
        "2026-09-27T23:00:00+03:00",
        "2026-09-28T02:00:00+03:00"
      ).surcharges[0].count
    ).toBe(0);
  });
  it("splits actual daily time and never duplicates a fixed extra", () => {
    const period = {
      start: "2026-09-27T08:00:00Z",
      end: "2026-09-28T08:00:00Z",
    };
    const allocations = [
      {
        soldierId: "a",
        periods: [{ start: period.start, end: "2026-09-27T20:00:00Z" }],
        fixedExtra: "2",
      },
      {
        soldierId: "b",
        periods: [{ start: "2026-09-27T20:00:00Z", end: period.end }],
        fixedExtra: "0",
      },
    ];
    expect(
      priceSplitExecution(base, period, allocations, "2").map(
        (item) => item.price.points
      )
    ).toEqual([4, 2]);
    expect(() => priceSplitExecution(base, period, allocations, "1")).toThrow();
  });
});
describe("eligibility", () => {
  const target = duty();
  it("allows a volunteer near release without that approval alone", () => {
    const person = soldier({
      service: { ...soldier().service, releaseDate: "2026-10-01" },
    });
    expect(
      evaluateEligibility(person, target, target.slots[0], context).status
    ).toBe("approval_required");
    expect(
      evaluateEligibility(person, target, target.slots[0], {
        ...context,
        mode: "volunteer",
      }).status
    ).toBe("eligible");
    person.inactivePeriods = [{ start: "2026-09-27", end: "2026-09-27" }];
    expect(
      evaluateEligibility(person, target, target.slots[0], {
        ...context,
        mode: "volunteer",
      }).status
    ).toBe("blocked");
  });
  it("lets a consenting volunteer bypass pending constraints but not approved ones or release", () => {
    const volunteer = { ...context, mode: "volunteer" as const };
    const person = soldier({
      constraints: [
        {
          id: "c1",
          version: 1,
          status: "pending",
          start: "2026-09-27",
          end: "2026-09-27",
        },
      ],
    });
    expect(
      evaluateEligibility(person, target, target.slots[0], context).status
    ).toBe("approval_required");
    expect(
      evaluateEligibility(person, target, target.slots[0], volunteer).status
    ).toBe("eligible");
    person.constraints[0].status = "approved";
    expect(
      evaluateEligibility(person, target, target.slots[0], volunteer).blockers
    ).toEqual([expect.objectContaining({ code: "approved_constraint" })]);
    const leaving = soldier({
      service: { ...soldier().service, releaseDate: "2026-09-26" },
    });
    expect(
      evaluateEligibility(leaving, target, target.slots[0], volunteer).blockers
    ).toEqual([expect.objectContaining({ code: "released" })]);
  });
  it("routes a volunteer's exemption or rank exception to a manager instead of blocking", () => {
    const volunteer = { ...context, mode: "volunteer" as const };
    const guarded = duty({
      requirements: {
        blockingExemptionIds: ["e"],
        ranks: [{ trackId: "t", minOrder: 3 }],
      },
    });
    const person = soldier({
      exemptions: [
        { exemptionId: "e", start: "2026-09-01", end: "2026-09-30" },
      ],
      rankHistory: [
        { effectiveFrom: "2026-01-01", rankId: "r", trackId: "t", order: 1 },
      ],
    });
    expect(
      evaluateEligibility(person, guarded, guarded.slots[0], context).status
    ).toBe("blocked");
    const result = evaluateEligibility(
      person,
      guarded,
      guarded.slots[0],
      volunteer
    );
    expect(result.status).toBe("approval_required");
    expect(result.approvalsRequired.map((item) => item.code).sort()).toEqual([
      "exemption",
      "rank",
    ]);
  });
  it("checks qualification throughout the execution", () => {
    const long = duty({
      end: "2026-09-28T08:00:00+03:00",
      requirements: { qualificationIds: ["q"] },
    });
    const person = soldier({
      qualifications: [
        { qualificationId: "q", start: "2026-01-01", end: "2026-09-27" },
      ],
    });
    expect(
      evaluateEligibility(person, long, long.slots[0], context).blockers.map(
        (item) => item.code
      )
    ).toContain("qualification");
  });
  it("checks populations for the entire duty", () => {
    const long = duty({
      end: "2026-09-28T08:00:00+03:00",
      requirements: { populations: ["mandatory"] },
    });
    const person = soldier({
      populationHistory: [
        { effectiveFrom: "2026-09-28", population: "career" },
      ],
    });
    expect(
      evaluateEligibility(person, long, long.slots[0], context).status
    ).toBe("blocked");
  });
  it("does not treat overlapping rest buffers alone as conflicting", () => {
    const other = duty({
      id: "other",
      start: "2026-09-27T06:00:00+03:00",
      end: "2026-09-27T07:00:00+03:00",
      restAfterMinutes: 45,
    });
    const target = duty({ restBeforeMinutes: 45 });
    expect(
      evaluateEligibility(soldier(), target, target.slots[0], {
        ...context,
        duties: [other],
        assignments: [assignment({ dutyId: "other" })],
      }).status
    ).toBe("eligible");
  });
  it("global pending review approval does not waive the individual collision", () => {
    const person = soldier({
      constraints: [
        {
          id: "c",
          version: 2,
          start: "2026-09-27",
          end: "2026-09-27",
          status: "pending",
        },
      ],
    });
    const result = evaluateEligibility(person, target, target.slots[0], {
      ...context,
      pendingReviewConfirmed: true,
    });
    expect(result.approvalsRequired.map((reason) => reason.code)).toEqual([
      "pending_constraint",
    ]);
  });
  it("expires access after the local release day, independently of a worker", () => {
    const person = soldier({
      service: { ...soldier().service, releaseDate: "2026-09-27" },
    });
    expect(canAccessAfterService(person, "2026-09-27T23:59:59+03:00")).toBe(
      true
    );
    expect(canAccessAfterService(person, "2026-09-28T00:00:00+03:00")).toBe(
      false
    );
  });
});
describe("fair selection and score ledger rules", () => {
  it("filters before minimum and uses a strict upper bound", () => {
    const people = [
      soldier({ id: "blocked", currentScore: 0, deletedAt: duty().start }),
      soldier({ id: "a", currentScore: 10 }),
      soldier({ id: "b", currentScore: 13 }),
      soldier({ id: "c", currentScore: 14 }),
    ];
    const result = drawCandidate(
      people,
      duty(),
      duty().slots[0],
      4,
      context,
      () => 0.99
    );
    expect(result).toMatchObject({
      status: "selected",
      minimum: 10,
      band: ["a", "b"],
      selected: { soldier: { id: "b" } },
    });
  });
  it("counts draft reservations and forbids an automatic zero value selection", () => {
    expect(schedulingScore(soldier({ currentScore: 3 }), [assignment()])).toBe(
      7
    );
    expect(
      drawCandidate([soldier()], duty(), duty().slots[0], 0, context, () => 0)
        .status
    ).toBe("manual_only");
  });
  it("rounds a 20% reduction of 51 to 41 and clamps at zero", () => {
    expect(
      applyScoreOperation(51, { kind: "reduce_percent", value: 20 }).after
    ).toBe(41);
    expect(applyScoreOperation(5, { kind: "add", value: -7 })).toMatchObject({
      after: 0,
      clamped: true,
    });
  });
  it("shares rank at equal scores and only credits published duties", () => {
    expect(
      rankFairness([
        soldier(),
        soldier({ id: "b" }),
        soldier({ id: "c", currentScore: 1 }),
      ]).map((row) => row.rank)
    ).toEqual([1, 1, 3]);
    expect(
      dueCredits([duty()], [assignment()], "2026-09-28T00:00:00Z")
    ).toHaveLength(0);
    expect(
      dueCredits(
        [duty({ status: "published" })],
        [assignment()],
        "2026-09-28T00:00:00Z"
      )
    ).toHaveLength(1);
  });
});
describe("past performance corrections", () => {
  const event = (
    id: string,
    effectiveAt: string,
    barrier: boolean,
    recordedAt = effectiveAt
  ) => ({
    id,
    soldierId: "a",
    kind: barrier ? "normalization" : "adjustment",
    effectiveAt,
    recordedAt,
    barrier,
  });
  it("orders barriers by effective time, not by recording time", () => {
    const events = [
      event("late", "2026-09-20T10:00:00+03:00", true),
      // Recorded after the correction target but effective before the performance: not a barrier.
      event(
        "before",
        "2026-09-10T10:00:00+03:00",
        true,
        "2026-09-25T10:00:00Z"
      ),
      event("add", "2026-09-18T10:00:00+03:00", false),
      event("same", "2026-09-15T16:00:00+03:00", true),
      { ...event("other", "2026-09-20T10:00:00+03:00", true), soldierId: "b" },
    ];
    expect(
      correctionBarriers("a", "2026-09-15T13:00:00Z", events).map(
        (item) => item.id
      )
    ).toEqual(["same", "late"]);
  });
  it("applies the difference once with a zero floor when nothing intervenes", () => {
    expect(
      correctionEffect({
        balance: 10,
        reflected: 4,
        corrected: 6,
        barriers: [],
        openDecision: false,
      })
    ).toEqual({ status: "automatic", delta: 2, after: 12, clamped: false });
    expect(
      correctionEffect({
        balance: 3,
        reflected: 8,
        corrected: 0,
        barriers: [],
        openDecision: false,
      })
    ).toEqual({ status: "automatic", delta: -3, after: 0, clamped: true });
  });
  it("waits for a manager after a barrier or while a decision is open", () => {
    const barrier = event("n", "2026-09-20T10:00:00+03:00", true);
    expect(
      correctionEffect({
        balance: 10,
        reflected: 4,
        corrected: 6,
        barriers: [barrier],
        openDecision: false,
      })
    ).toEqual({ status: "decision_required", rawDelta: 2 });
    expect(
      correctionEffect({
        balance: 10,
        reflected: 4,
        corrected: 6,
        barriers: [],
        openDecision: true,
      }).status
    ).toBe("decision_required");
    expect(() =>
      correctionEffect({
        balance: 10,
        reflected: 4,
        corrected: 1.5,
        barriers: [],
        openDecision: false,
      })
    ).toThrow();
  });
});
describe("Israel time boundaries", () => {
  it("uses a calendar month for grace at month end", () =>
    expect(graceEnd("2026-01-31")).toBe("2026-02-28"));
  it("rejects a nonexistent daylight-saving time and requires disambiguation for a repeated time", () => {
    expect(() => resolveLocalTime("2026-03-27", "02:30")).toThrow();
    expect(() => resolveLocalTime("2026-10-25", "01:30")).toThrow();
    expect(resolveLocalTime("2026-10-25", "01:30", 180)).not.toBe(
      resolveLocalTime("2026-10-25", "01:30", 120)
    );
  });
});
