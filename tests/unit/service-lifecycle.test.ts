import { describe, expect, it } from "vitest";
import {
  canAccessAfterService,
  evaluateEligibility,
  isNearRelease,
  serviceSummary,
} from "../../src/domain/eligibility";
import { duty, soldier } from "../fixtures";
import type { EligibilityContext, Soldier } from "../../src/domain/types";

const context: EligibilityContext = {
  duties: [],
  assignments: [],
  mode: "automatic",
};
function service(overrides: Partial<Soldier["service"]>) {
  return soldier({ service: { ...soldier().service, ...overrides } });
}
const codes = (person: Soldier, target = duty()) =>
  evaluateEligibility(person, target, target.slots[0], context).blockers.map(
    (item) => item.code
  );

describe("release boundary in Israel time", () => {
  const person = service({ releaseDate: "2027-06-30" });
  it("allows access through the last day and refuses it from local midnight", () => {
    expect(canAccessAfterService(person, "2027-06-30T23:59:59+03:00")).toBe(
      true
    );
    // 20:59:59Z is still the release day in Israel; 21:00Z is 1 July 00:00.
    expect(canAccessAfterService(person, "2027-06-30T20:59:59Z")).toBe(true);
    expect(canAccessAfterService(person, "2027-06-30T21:00:00Z")).toBe(false);
    expect(serviceSummary(person, "2027-06-30T21:00:00Z").status).toBe(
      "service_ended"
    );
  });
  it("uses the winter offset for a release in winter", () => {
    const winter = service({ releaseDate: "2027-01-15" });
    expect(canAccessAfterService(winter, "2027-01-15T21:59:59Z")).toBe(true);
    expect(canAccessAfterService(winter, "2027-01-15T22:00:00Z")).toBe(false);
  });
  it("allows a duty that ends exactly at the boundary and blocks one that runs past it", () => {
    const ending = duty({
      start: "2027-06-30T16:00:00+03:00",
      end: "2027-07-01T00:00:00+03:00",
    });
    expect(codes(person, ending)).not.toContain("released");
    const beyond = duty({
      start: "2027-06-30T16:00:00+03:00",
      end: "2027-07-01T00:01:00+03:00",
    });
    expect(codes(person, beyond)).toContain("released");
  });
  it("starts the month before release on the same calendar day, or the last day of a shorter month", () => {
    expect(serviceSummary(person, "2027-05-29T12:00:00+03:00")).toEqual({
      status: "active",
      preReleaseFrom: "2027-05-30",
    });
    expect(serviceSummary(person, "2027-05-30T00:00:00+03:00").status).toBe(
      "pre_release"
    );
    const march = service({ releaseDate: "2027-03-31" });
    expect(serviceSummary(march, "2027-01-01T12:00:00+02:00")).toMatchObject({
      preReleaseFrom: "2027-02-28",
    });
    const started = duty({
      start: "2027-02-27T20:00:00+02:00",
      end: "2027-02-28T08:00:00+02:00",
    });
    expect(isNearRelease(march, started)).toBe(false);
    expect(
      isNearRelease(
        march,
        duty({
          start: "2027-02-28T00:00:00+02:00",
          end: "2027-02-28T08:00:00+02:00",
        })
      )
    ).toBe(true);
  });
});

describe("grace month", () => {
  const arrival = "2027-01-31";
  it("applies only to an explicitly eligible soldier", () => {
    const early = duty({
      start: "2027-02-01T08:00:00+02:00",
      end: "2027-02-01T16:00:00+02:00",
    });
    expect(codes(service({ arrivalDate: arrival }), early)).not.toContain(
      "grace"
    );
    expect(
      codes(service({ arrivalDate: arrival, graceEligible: true }), early)
    ).toContain("grace");
    expect(
      serviceSummary(service({ arrivalDate: arrival }), early.start)
    ).toEqual({ status: "active" });
  });
  it("ends on the last day of a shorter month, which is itself available", () => {
    const person = service({ arrivalDate: arrival, graceEligible: true });
    expect(serviceSummary(person, "2027-02-27T23:59:00+02:00")).toEqual({
      status: "grace",
      graceUntil: "2027-02-28",
    });
    expect(serviceSummary(person, "2027-02-28T00:00:00+02:00").status).toBe(
      "active"
    );
    expect(
      codes(
        person,
        duty({
          start: "2027-02-27T20:00:00+02:00",
          end: "2027-02-28T04:00:00+02:00",
        })
      )
    ).toContain("grace");
    expect(
      codes(
        person,
        duty({
          start: "2027-02-28T00:00:00+02:00",
          end: "2027-02-28T08:00:00+02:00",
        })
      )
    ).not.toContain("grace");
  });
});

describe("population and rank during a duty", () => {
  const overnight = (requirements: object) =>
    duty({
      start: "2027-03-09T20:00:00+02:00",
      end: "2027-03-10T08:00:00+02:00",
      requirements,
    });
  const officer = service({ officerFrom: "2027-03-10" });
  it("requires the duty to fit the population on both sides of a switch", () => {
    expect(codes(officer, overnight({ populations: ["mandatory"] }))).toContain(
      "population"
    );
    expect(codes(officer, overnight({ populations: ["career"] }))).toContain(
      "population"
    );
    expect(
      codes(officer, overnight({ populations: ["mandatory", "career"] }))
    ).not.toContain("population");
  });
  it("checks rank at the start only", () => {
    const promoted = soldier({
      rankHistory: [
        {
          effectiveFrom: "2027-01-01",
          rankId: "r1",
          trackId: "t",
          order: 1,
        },
        {
          effectiveFrom: "2027-03-10",
          rankId: "r2",
          trackId: "t",
          order: 2,
        },
      ],
    });
    expect(
      codes(promoted, overnight({ ranks: [{ trackId: "t", minOrder: 2 }] }))
    ).toContain("rank");
    expect(
      codes(promoted, overnight({ ranks: [{ trackId: "t", maxOrder: 1 }] }))
    ).not.toContain("rank");
  });
});

describe("inactive period", () => {
  it("limits assignment but is not an access state", () => {
    const person = soldier({
      inactivePeriods: [{ start: "2027-03-01", end: "2027-03-31" }],
    });
    const now = "2027-03-15T12:00:00+02:00";
    expect(canAccessAfterService(person, now)).toBe(true);
    expect(serviceSummary(person, now).status).toBe("inactive_period");
    expect(serviceSummary(person, "2027-04-01T00:00:00+03:00").status).toBe(
      "active"
    );
  });
});
