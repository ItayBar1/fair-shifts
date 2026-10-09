import { describe, expect, it } from "vitest";
import {
  fairnessTable,
  ledgerView,
  nextSort,
  noLedgerFilter,
  sortFairness,
  sortRows,
  type LedgerColumn,
  type LedgerFilter,
  type Sort,
} from "../../src/client/fairness";
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

// The unified table: points ahead, spreadsheet sorting and the ledger (decision 220).
describe("fairness table with the points ahead", () => {
  const people = [
    row("g", "גל", 8, { futureScore: 4 }),
    row("a", "אלון", 10, { futureScore: 4 }),
    row("b", "בר", 11, { futureScore: 0 }),
  ];

  it("ranks by the current balance while the switch is off", () => {
    const { ranked } = fairnessTable(people);
    expect(ranked.map((item) => [item.id, item.rank, item.shown])).toEqual([
      ["g", 1, 8],
      ["a", 2, 10],
      ["b", 3, 11],
    ]);
  });

  it("ranks by the balance plus the points ahead while it is on", () => {
    const { ranked } = fairnessTable(people, true);
    expect(ranked.map((item) => [item.id, item.rank, item.shown])).toEqual([
      ["b", 1, 11],
      ["g", 2, 12],
      ["a", 3, 14],
    ]);
  });

  it("keeps a manager's frozen balance outside the ranking either way", () => {
    const { ranked, managers } = fairnessTable(
      [...people, row("m", "מנהל", 0, { isManager: true, futureScore: 4 })],
      true
    );
    expect(ranked).toHaveLength(3);
    expect(managers.map((item) => [item.id, item.shown])).toEqual([["m", 4]]);
  });

  it("sorts by a column and turns it around on a second click", () => {
    const { ranked } = fairnessTable(people);
    const byName = { key: "name" as const, direction: "asc" as const };
    expect(sortFairness(ranked, byName).map((item) => item.id)).toEqual([
      "a",
      "b",
      "g",
    ]);
    const back = nextSort(byName, "name");
    expect(back).toEqual({ key: "name", direction: "desc" });
    expect(sortFairness(ranked, back).map((item) => item.id)).toEqual([
      "g",
      "b",
      "a",
    ]);
    expect(nextSort(back, "rank")).toEqual({ key: "rank", direction: "asc" });
  });

  it("puts empty values last in both directions and keeps ties in order", () => {
    const items = [
      { id: "1", v: "" },
      { id: "2", v: "ב" },
      { id: "3", v: "א" },
      { id: "4", v: "ב" },
    ];
    const ids = (direction: "asc" | "desc") =>
      sortRows(items, (item) => item.v, direction).map((item) => item.id);
    expect(ids("asc")).toEqual(["3", "2", "4", "1"]);
    expect(ids("desc")).toEqual(["2", "4", "3", "1"]);
  });
});

describe("score ledger view", () => {
  const names: Record<string, string> = { s1: "אלון", s2: "בר" };
  const entries: Row[] = [
    {
      id: "e1",
      soldierId: "s1",
      kind: "performance",
      amount: 4,
      after: 14,
      reason: "תורנות שבוצעה",
      effectiveAt: "2026-10-01T21:30:00Z",
    },
    {
      id: "e2",
      soldierId: "s2",
      kind: "normalization",
      amount: -3,
      after: 8,
      reason: "נרמול רבעוני",
      effectiveAt: "2026-10-05T08:00:00Z",
    },
    {
      id: "e3",
      soldierId: "s1",
      kind: "adjustment",
      amount: 2,
      after: 16,
      reason: "תיקון ידני",
      effectiveAt: "2026-10-07T08:00:00Z",
    },
  ];
  const view = (
    filter: LedgerFilter = noLedgerFilter,
    sort: Sort<LedgerColumn> = { key: "effectiveAt", direction: "desc" }
  ) =>
    ledgerView(entries, (id) => names[String(id)] ?? "", filter, sort).map(
      (row) => row.id
    );

  it("lists the latest first by default", () => {
    expect(view()).toEqual(["e3", "e2", "e1"]);
  });

  it("finds words in the soldier's name or the reason", () => {
    expect(view({ ...noLedgerFilter, text: "בר" })).toEqual(["e2"]);
    expect(view({ ...noLedgerFilter, text: "תיקון" })).toEqual(["e3"]);
  });

  it("filters by kind and by Israel calendar day of the effective time", () => {
    expect(view({ ...noLedgerFilter, kind: "זיכוי ביצוע" })).toEqual(["e1"]);
    // 21:30 UTC on 1 October is already 2 October in Israel.
    expect(
      view({ ...noLedgerFilter, from: "2026-10-02", to: "2026-10-05" })
    ).toEqual(["e2", "e1"]);
    expect(view({ ...noLedgerFilter, to: "2026-10-01" })).toEqual([]);
  });

  it("sorts by any column", () => {
    expect(view(noLedgerFilter, { key: "amount", direction: "asc" })).toEqual([
      "e2",
      "e3",
      "e1",
    ]);
    expect(view(noLedgerFilter, { key: "soldier", direction: "asc" })).toEqual([
      "e1",
      "e3",
      "e2",
    ]);
  });
});
