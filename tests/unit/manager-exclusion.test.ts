import { describe, expect, it } from "vitest";
import {
  MANAGER_BLOCKER_MESSAGE,
  evaluateEligibility,
} from "../../src/domain/eligibility";
import { drawCandidate } from "../../src/domain/scheduling";
import { rankFairness } from "../../src/domain/scoring";
import { duty, soldier } from "../fixtures";
import type { EligibilityContext } from "../../src/domain/types";

const modes = ["automatic", "manual", "volunteer"] as const;
const context = (mode: EligibilityContext["mode"]): EligibilityContext => ({
  duties: [],
  assignments: [],
  mode,
});

describe("a duty manager is never assigned (decision 192)", () => {
  it.each(modes)("blocks a manager in %s mode, with the reason", (mode) => {
    const result = evaluateEligibility(
      soldier({ isManager: true }),
      duty(),
      duty().slots[0],
      context(mode)
    );
    expect(result.status).toBe("blocked");
    expect(result.blockers).toEqual([
      { code: "manager", message: MANAGER_BLOCKER_MESSAGE },
    ]);
  });

  it("does not block a soldier who is not a manager", () => {
    for (const isManager of [undefined, false])
      expect(
        evaluateEligibility(
          soldier({ isManager }),
          duty(),
          duty().slots[0],
          context("manual")
        ).status
      ).toBe("eligible");
  });

  it("is not lifted by a specific approval", () => {
    const person = soldier({ isManager: true });
    const slot = duty().slots[0];
    const approvals = (
      [
        "exemption",
        "rank",
        "allowed_hours",
        "pending_constraint",
        "near_release",
      ] as const
    ).map((kind) => ({
      kind,
      soldierId: person.id,
      dutyId: duty().id,
      dutyVersion: duty().version,
      reason: "סיבה סינתטית",
      approvedBy: "m",
      approvedAt: "2026-09-27T00:00:00Z",
    }));
    expect(
      evaluateEligibility(person, duty(), slot, {
        ...context("manual"),
        approvals,
      }).status
    ).toBe("blocked");
  });

  it("reports the manager reason beside the other blockers", () => {
    const result = evaluateEligibility(
      soldier({ isManager: true, deletedAt: "2026-09-01T00:00:00Z" }),
      duty(),
      duty().slots[0],
      context("automatic")
    );
    expect(result.blockers.map((row) => row.code)).toEqual([
      "deleted",
      "manager",
    ]);
  });

  it("never draws a manager, even with the lowest score", () => {
    const manager = soldier({
      id: "manager",
      name: "אחראי",
      isManager: true,
      currentScore: 0,
    });
    const others = ["a", "b"].map((id) =>
      soldier({ id, name: id, currentScore: 100 })
    );
    const result = drawCandidate(
      [manager, ...others],
      duty(),
      duty().slots[0],
      4,
      context("automatic"),
      () => 0
    );
    expect(result.status).toBe("selected");
    if (result.status !== "selected") return;
    expect(result.selected.soldier.id).not.toBe("manager");
    expect(result.minimum).toBe(100);
    expect(result.band).not.toContain("manager");
  });

  it("keeps a manager out of the fairness ranking", () => {
    const table = rankFairness([
      soldier({ id: "a", name: "א", currentScore: 10 }),
      soldier({ id: "m", name: "אחראי", currentScore: 0, isManager: true }),
      soldier({ id: "b", name: "ב", currentScore: 20 }),
    ]);
    expect(table.map((row) => [row.soldierId, row.rank])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });
});
