import { describe, expect, it } from "vitest";
import { fairnessTable } from "../../src/client/fairness";
import type { Row } from "../../src/client/types";

const row = (
  id: string,
  name: string,
  currentScore: number,
  extra: Record<string, unknown> = {}
): Row => ({ id, name, currentScore, ...extra });

// The shared table: equal balances share a rank; a manager holds no place (decision 192).
describe("fairness table", () => {
  it("ranks soldiers by balance, with equal balances sharing a rank", () => {
    const { ranked } = fairnessTable([
      row("c", "גדי", 12),
      row("a", "אבי", 5),
      row("b", "בני", 5),
      row("d", "דני", 20),
    ]);
    expect(ranked.map((item) => [item.id, item.rank])).toEqual([
      ["a", 1],
      ["b", 1],
      ["c", 3],
      ["d", 4],
    ]);
  });

  it("lists managers after the ranking, without a place, by name", () => {
    const { ranked, managers } = fairnessTable([
      row("m2", "תמר", 0, { isManager: true }),
      row("s1", "שי", 9),
      row("m1", "אורי", 40, { isManager: true }),
      row("s2", "רן", 3),
    ]);
    // A manager's low or high balance never moves a soldier's rank.
    expect(ranked.map((item) => [item.id, item.rank])).toEqual([
      ["s2", 1],
      ["s1", 2],
    ]);
    expect(managers.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(managers.every((item) => !("rank" in item))).toBe(true);
    // The frozen balance is kept as it stands.
    expect(managers.map((item) => item.currentScore)).toEqual([40, 0]);
  });

  it("leaves deleted soldiers and deleted managers out", () => {
    const { ranked, managers } = fairnessTable([
      row("s", "שי", 1),
      row("gone", "נמחק", 0, { deletedAt: "2026-09-01T00:00:00Z" }),
      row("gone-m", "אחראי שנמחק", 0, {
        deletedAt: "2026-09-01T00:00:00Z",
        isManager: true,
      }),
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["s"]);
    expect(managers).toEqual([]);
  });

  it("has no managers to list in a soldier's state", () => {
    const { ranked, managers } = fairnessTable([
      row("a", "אבי", 1),
      row("b", "בני", 2),
    ]);
    expect(ranked).toHaveLength(2);
    expect(managers).toEqual([]);
  });
});
