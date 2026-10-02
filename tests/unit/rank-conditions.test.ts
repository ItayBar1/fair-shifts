import { describe, expect, it } from "vitest";
import { evaluateEligibility, matchesRank } from "../../src/domain/eligibility";
import { duty, soldier } from "../fixtures";
import type {
  EffectiveRank,
  EligibilityContext,
  RankClause,
  Requirements,
} from "../../src/domain/types";

// Rank conditions of a duty or a role (stories 56 and 58, scenarios 36 and 37).
// The ranks are synthetic: two tracks, ordered within each.
const automatic: EligibilityContext = {
  duties: [],
  assignments: [],
  mode: "automatic",
};
const rank = (rankId: string, order: number, trackId = "career") =>
  ({ effectiveFrom: "2020-01-01", rankId, trackId, order }) as EffectiveRank;
const sergeant = rank("sergeant", 10);
const staff = rank("staff", 20);
const master = rank("master", 30);
const major = rank("major", 40);
const ladder = [sergeant, staff, master, major];
const accepted = (clause: RankClause) =>
  ladder.map((item) => matchesRank(item, [clause]));
function check(
  person: EffectiveRank | undefined,
  duties: Requirements,
  role?: Requirements,
  context: EligibilityContext = automatic
) {
  const target = duty({
    requirements: duties,
    slots: [{ id: "s", role: "תורן", requirements: role }],
  });
  return evaluateEligibility(
    soldier({ rankHistory: person ? [person] : [] }),
    target,
    target.slots[0],
    context
  );
}

describe("rank clauses", () => {
  it("accepts an exact rank and no other", () =>
    expect(accepted({ trackId: "career", rankIds: ["master"] })).toEqual([
      false,
      false,
      true,
      false,
    ]));
  it("accepts any rank in a list", () =>
    expect(
      accepted({ trackId: "career", rankIds: ["staff", "major"] })
    ).toEqual([false, true, false, true]));
  it("accepts a minimum, the rank itself included", () =>
    expect(accepted({ trackId: "career", minOrder: 30 })).toEqual([
      false,
      false,
      true,
      true,
    ]));
  it("accepts a maximum, the rank itself included", () =>
    expect(accepted({ trackId: "career", maxOrder: 20 })).toEqual([
      true,
      true,
      false,
      false,
    ]));
  it("accepts a range with both ends included", () =>
    expect(accepted({ trackId: "career", minOrder: 20, maxOrder: 30 })).toEqual(
      [false, true, true, false]
    ));
  it("does not treat the same order on another track as equivalent", () => {
    const other = rank("master", 30, "other");
    expect(matchesRank(other, [{ trackId: "career", minOrder: 30 }])).toBe(
      false
    );
    expect(matchesRank(other, [{ trackId: "other", minOrder: 30 }])).toBe(true);
  });
  it("takes several clauses as alternatives", () => {
    const clauses: RankClause[] = [
      { trackId: "career", rankIds: ["sergeant"] },
      { trackId: "other", minOrder: 30 },
    ];
    expect(matchesRank(sergeant, clauses)).toBe(true);
    expect(matchesRank(rank("x", 35, "other"), clauses)).toBe(true);
    expect(matchesRank(staff, clauses)).toBe(false);
  });
});

describe("a duty with a rank condition", () => {
  const exactMaster: Requirements = {
    ranks: [{ trackId: "career", rankIds: ["master"] }],
  };
  it("blocks another rank in an automatic draw, whatever the score", () => {
    const result = check(staff, exactMaster);
    expect(result.status).toBe("blocked");
    expect(result.blockers).toMatchObject([
      { code: "rank", message: "הדרגה בתחילת התורנות אינה מתאימה" },
    ]);
    expect(check(master, exactMaster).status).toBe("eligible");
  });
  it("blocks a missing rank as missing information", () => {
    const result = check(undefined, exactMaster);
    expect(result.status).toBe("blocked");
    expect(result.blockers[0]).toMatchObject({ code: "rank" });
    expect(result.blockers[0].message).toContain("מידע חסר");
  });
  it("does not block a soldier with no rank when the duty asks for none", () => {
    expect(check(undefined, {}).status).toBe("eligible");
    expect(check(undefined, { populations: ["mandatory"] }).status).toBe(
      "eligible"
    );
  });
  it("leaves a manual selection to an explicit exception instead of blocking", () => {
    const result = check(staff, exactMaster, undefined, {
      ...automatic,
      mode: "manual",
    });
    expect(result.status).toBe("approval_required");
    expect(result.approvalsRequired).toMatchObject([{ code: "rank" }]);
  });
  it("asks the role's condition as well as the duty's", () => {
    const atLeastMaster: Requirements = {
      ranks: [{ trackId: "career", minOrder: 30 }],
    };
    const onlyMajor: Requirements = {
      ranks: [{ trackId: "career", rankIds: ["major"] }],
    };
    expect(check(major, atLeastMaster, onlyMajor).status).toBe("eligible");
    expect(check(master, atLeastMaster, onlyMajor).status).toBe("blocked");
    expect(check(staff, atLeastMaster, onlyMajor).blockers).toHaveLength(2);
  });
});
