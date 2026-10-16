import { describe, expect, it } from "vitest";
import {
  evaluateEligibility,
  genderCondition,
} from "../../src/domain/eligibility";
import { windowBoundary } from "../../src/domain/time";
import { duty, soldier } from "../fixtures";
import type {
  TimedExemption,
  Duty,
  EligibilityContext,
  Soldier,
  SpecificApproval,
} from "../../src/domain/types";

const automatic: EligibilityContext = {
  duties: [],
  assignments: [],
  mode: "automatic",
};
const manual: EligibilityContext = { ...automatic, mode: "manual" };
const codes = (person: Soldier, target: Duty, context = automatic) => {
  const result = evaluateEligibility(person, target, target.slots[0], context);
  return {
    status: result.status,
    blockers: result.blockers.map((item) => item.code),
    approvals: result.approvalsRequired.map((item) => item.code),
    messages: result.blockers.map((item) => item.message),
  };
};
// An hours exemption (decision 226): the windows travel with the soldier's entry.
const limit = (overrides: Partial<TimedExemption> = {}): TimedExemption => ({
  exemptionId: "limit",
  start: "2026-01-01",
  end: "2026-12-31",
  windows: [{ startTime: "08:00", endTime: "17:00" }],
  ...overrides,
});
// 27.09.2026 is a Sunday.
const at = (start: string, end: string, overrides: Partial<Duty> = {}) =>
  duty({ start, end, ...overrides });

describe("gender conditions", () => {
  const target = duty({ requirements: { genders: ["female"] } });
  it("blocks missing gender as missing information, in every mode", () => {
    const result = codes(soldier(), target, manual);
    expect(result.blockers).toEqual(["gender"]);
    expect(result.messages[0]).toContain("מידע חסר");
  });
  it("blocks a gender outside the list and accepts a listed one", () => {
    expect(codes(soldier({ gender: "male" }), target).blockers).toEqual([
      "gender",
    ]);
    expect(codes(soldier({ gender: "female" }), target).status).toBe(
      "eligible"
    );
  });
  it("applies a role condition only to that role", () => {
    const mixed = duty({
      slots: [
        { id: "s", role: "תורנית", requirements: { genders: ["female"] } },
        { id: "open", role: "תורן" },
      ],
    });
    const person = soldier({ gender: "other" });
    expect(
      evaluateEligibility(person, mixed, mixed.slots[0], automatic).status
    ).toBe("blocked");
    expect(
      evaluateEligibility(person, mixed, mixed.slots[1], automatic).status
    ).toBe("eligible");
  });
  it("ignores gender when the duty sets no gender condition", () =>
    expect(codes(soldier(), duty()).status).toBe("eligible"));
});

// Decision 198: every gender is no gender condition.
describe("a gender condition with every gender", () => {
  const everyone = ["male", "female", "other"] as const;
  it("reads an empty, missing or full list as no condition", () => {
    expect(genderCondition(undefined)).toBeUndefined();
    expect(genderCondition([])).toBeUndefined();
    expect(genderCondition([...everyone])).toBeUndefined();
    expect(
      genderCondition(["other", "male", "female", "male"])
    ).toBeUndefined();
  });
  it("keeps a partial list as a real condition", () => {
    expect(genderCondition(["male", "female"])).toEqual(["male", "female"]);
    expect(genderCondition(["female", "female"])).toEqual(["female"]);
  });
  it("does not block a soldier without a gender, in every mode", () => {
    const target = duty({ requirements: { genders: [...everyone] } });
    expect(codes(soldier(), target, automatic).status).toBe("eligible");
    expect(codes(soldier(), target, manual).status).toBe("eligible");
    expect(codes(soldier({ gender: "other" }), target).status).toBe("eligible");
  });
  it("does not block through a role with every gender either", () => {
    const target = duty({
      slots: [
        { id: "s", role: "תורן", requirements: { genders: [...everyone] } },
      ],
    });
    expect(codes(soldier(), target).status).toBe("eligible");
  });
  it("still blocks a soldier without a gender when two of three are listed", () => {
    const target = duty({ requirements: { genders: ["male", "female"] } });
    const result = codes(soldier(), target, manual);
    expect(result.blockers).toEqual(["gender"]);
    expect(result.messages[0]).toContain("מידע חסר");
    expect(codes(soldier({ gender: "other" }), target).blockers).toEqual([
      "gender",
    ]);
  });
  it("lets the role's own condition decide when the duty lists every gender", () => {
    const target = duty({
      requirements: { genders: [...everyone] },
      slots: [{ id: "s", role: "תורן", requirements: { genders: ["male"] } }],
    });
    expect(codes(soldier(), target).blockers).toEqual(["gender"]);
    expect(codes(soldier({ gender: "female" }), target).blockers).toEqual([
      "gender",
    ]);
    expect(codes(soldier({ gender: "male" }), target).status).toBe("eligible");
  });
});

describe("capability conditions", () => {
  const target = duty({ requirements: { capabilityIds: ["lift"] } });
  it("blocks a missing capability without a manual exception", () => {
    expect(codes(soldier(), target, manual)).toMatchObject({
      status: "blocked",
      blockers: ["capability"],
      approvals: [],
    });
  });
  it("needs every required capability; one without dates is permanent", () => {
    const both = duty({ requirements: { capabilityIds: ["lift", "drive"] } });
    expect(
      codes(soldier({ capabilities: [{ capabilityId: "lift" }] }), both)
        .blockers
    ).toEqual(["capability"]);
    expect(
      codes(
        soldier({
          capabilities: [{ capabilityId: "drive" }, { capabilityId: "lift" }],
        }),
        both
      ).status
    ).toBe("eligible");
  });
});

describe("hours exemptions", () => {
  const night = limit({ windows: [{ startTime: "22:00", endTime: "06:00" }] });
  it("accepts a night inside a window that crosses midnight", () =>
    expect(
      codes(
        soldier({ exemptions: [night] }),
        at("2026-09-27T23:00:00+03:00", "2026-09-28T05:00:00+03:00")
      ).status
    ).toBe("eligible"));
  it("checks the whole execution, not only its start", () => {
    const person = soldier({ exemptions: [night] });
    expect(
      codes(
        person,
        at("2026-09-27T21:00:00+03:00", "2026-09-28T05:00:00+03:00")
      ).blockers
    ).toEqual(["allowed_hours"]);
    expect(
      codes(
        person,
        at("2026-09-27T22:00:00+03:00", "2026-09-29T06:00:00+03:00")
      ).blockers
    ).toEqual(["allowed_hours"]);
  });
  it("respects the weekdays of each window", () => {
    const weekdays = limit({
      windows: [
        { startTime: "08:00", endTime: "17:00", weekdays: [7, 1, 2, 3, 4] },
      ],
    });
    const person = soldier({ exemptions: [weekdays] });
    expect(
      codes(
        person,
        at("2026-09-27T09:00:00+03:00", "2026-09-27T12:00:00+03:00")
      ).status
    ).toBe("eligible");
    expect(
      codes(
        person,
        at("2026-10-02T09:00:00+03:00", "2026-10-02T12:00:00+03:00")
      ).blockers
    ).toEqual(["allowed_hours"]);
  });
  it("limits only the part of a duty inside the validity dates", () => {
    const person = soldier({
      exemptions: [limit({ start: "2026-09-28", end: "2026-09-30" })],
    });
    expect(
      codes(
        person,
        at("2026-09-27T20:00:00+03:00", "2026-09-28T00:00:00+03:00")
      ).status
    ).toBe("eligible");
    expect(
      codes(
        person,
        at("2026-09-27T20:00:00+03:00", "2026-09-28T02:00:00+03:00")
      ).blockers
    ).toEqual(["allowed_hours"]);
    expect(
      codes(
        person,
        at("2026-10-01T00:00:00+03:00", "2026-10-01T23:00:00+03:00")
      ).status
    ).toBe("eligible");
  });
  it("requires every overlapping limit to be met", () => {
    const person = soldier({
      exemptions: [
        limit(),
        limit({
          exemptionId: "second",
          windows: [{ startTime: "12:00", endTime: "20:00" }],
        }),
      ],
    });
    expect(
      codes(
        person,
        at("2026-09-27T13:00:00+03:00", "2026-09-27T16:00:00+03:00")
      ).status
    ).toBe("eligible");
    expect(
      codes(
        person,
        at("2026-09-27T09:00:00+03:00", "2026-09-27T16:00:00+03:00")
      ).blockers
    ).toEqual(["allowed_hours"]);
  });
  it("blocks lottery and volunteers but allows a specific manual exception", () => {
    const person = soldier({ exemptions: [limit()] });
    const late = at("2026-09-27T18:00:00+03:00", "2026-09-27T23:00:00+03:00");
    expect(
      codes(person, late, { ...automatic, mode: "volunteer" }).status
    ).toBe("blocked");
    expect(codes(person, late, manual)).toMatchObject({
      status: "approval_required",
      approvals: ["allowed_hours"],
    });
    const approval: SpecificApproval = {
      kind: "allowed_hours",
      soldierId: person.id,
      dutyId: late.id,
      dutyVersion: late.version,
      soldierVersion: person.version,
      referenceId: "limit",
      reason: "אושר נקודתית",
      approvedBy: "manager",
      approvedAt: "2026-09-20T10:00:00Z",
    };
    expect(
      codes(person, late, { ...manual, approvals: [approval] }).status
    ).toBe("eligible");
    expect(
      codes(person, late, {
        ...manual,
        approvals: [{ ...approval, dutyId: "other" }],
      }).approvals
    ).toEqual(["allowed_hours"]);
    expect(
      codes(person, late, {
        ...manual,
        approvals: [{ ...approval, soldierVersion: person.version + 1 }],
      }).approvals
    ).toEqual(["allowed_hours"]);
  });
  it("does not let an hours exception bypass a capability", () => {
    const person = soldier({ exemptions: [limit()] });
    const target = at(
      "2026-09-27T18:00:00+03:00",
      "2026-09-27T23:00:00+03:00",
      {
        requirements: { capabilityIds: ["lift"] },
      }
    );
    expect(
      codes(person, target, {
        ...manual,
        approvals: [
          {
            kind: "allowed_hours",
            soldierId: person.id,
            dutyId: target.id,
            dutyVersion: target.version,
            referenceId: "limit",
            reason: "חריג",
            approvedBy: "manager",
            approvedAt: "2026-09-20T10:00:00Z",
          },
        ],
      }).blockers
    ).toEqual(["capability"]);
  });
});

describe("hours windows across Israeli clock changes", () => {
  it("maps a skipped time to the moment summer time starts", () => {
    expect(windowBoundary("2026-03-27", "02:30", "start")).toBe(
      Date.parse("2026-03-27T03:00:00+03:00")
    );
    const person = soldier({
      exemptions: [
        limit({ windows: [{ startTime: "02:30", endTime: "06:00" }] }),
      ],
    });
    expect(
      codes(
        person,
        at("2026-03-27T03:00:00+03:00", "2026-03-27T05:00:00+03:00")
      ).status
    ).toBe("eligible");
  });
  it("reads a repeated time as the widest window", () => {
    expect(windowBoundary("2026-10-25", "01:30", "start")).toBe(
      Date.parse("2026-10-25T01:30:00+03:00")
    );
    expect(windowBoundary("2026-10-25", "01:30", "end")).toBe(
      Date.parse("2026-10-25T01:30:00+02:00")
    );
    const person = soldier({
      exemptions: [
        limit({ windows: [{ startTime: "01:30", endTime: "03:00" }] }),
      ],
    });
    expect(
      codes(
        person,
        at("2026-10-25T01:30:00+03:00", "2026-10-25T02:30:00+02:00")
      ).status
    ).toBe("eligible");
  });
});

describe("an hours exemption beside duty-type exemptions", () => {
  it("never blocks a whole duty that lists it, and a plain exemption still does", () => {
    const listing = (exemptionId: string) =>
      at("2026-09-27T09:00:00+03:00", "2026-09-27T12:00:00+03:00", {
        requirements: { blockingExemptionIds: [exemptionId] },
      });
    expect(
      codes(soldier({ exemptions: [limit()] }), listing("limit")).status
    ).toBe("eligible");
    expect(
      codes(
        soldier({ exemptions: [{ exemptionId: "plain" }] }),
        listing("plain")
      ).blockers
    ).toEqual(["exemption"]);
  });
  it("applies with open dates, before and after", () =>
    expect(
      codes(
        soldier({ exemptions: [limit({ start: undefined, end: undefined })] }),
        at("2030-01-06T20:00:00+02:00", "2030-01-06T23:00:00+02:00")
      ).blockers
    ).toEqual(["allowed_hours"]));
});
