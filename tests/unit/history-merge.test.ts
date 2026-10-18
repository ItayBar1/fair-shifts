import { describe, expect, it } from "vitest";
import { withHistory, type HistorySlice } from "../../src/client/history";
import type { AppState } from "../../src/client/types";

const state = {
  actor: { id: "a", name: "חייל", role: "soldier" },
  duties: [{ id: "d1", name: "חדשה", version: 2 }],
  assignments: [],
  requests: [],
  notifications: [],
  ledger: [{ id: "l1" }],
  history: { from: "2026-07-20T00:00:00.000Z", olderAvailable: true },
} as unknown as AppState;
const slice = (from: string, more: boolean, ids: string[]): HistorySlice => ({
  from,
  olderAvailable: more,
  duties: ids.map((id) => ({ id, name: `ישנה ${id}`, version: 1 })),
  assignments: [],
  requests: [],
  notifications: [],
  ledger: [{ id: `old-${ids[0]}` }],
});

describe("earlier history slices in the browser (decision 235)", () => {
  it("leaves the state as it is without slices", () => {
    expect(withHistory(state, [])).toBe(state);
  });
  it("adds older rows under the fresh ones, the fresh copy winning, and moves the window back", () => {
    const merged = withHistory(state, [
      slice("2026-04-21T00:00:00.000Z", true, ["d0", "d1"]),
      slice("2026-01-21T00:00:00.000Z", false, ["d-1"]),
    ]);
    expect(merged.duties).toEqual([
      { id: "d1", name: "חדשה", version: 2 },
      { id: "d0", name: "ישנה d0", version: 1 },
      { id: "d-1", name: "ישנה d-1", version: 1 },
    ]);
    expect(merged.ledger.map((row) => row.id)).toEqual([
      "l1",
      "old-d0",
      "old-d-1",
    ]);
    expect(merged.history).toEqual({
      from: "2026-01-21T00:00:00.000Z",
      olderAvailable: false,
    });
  });
});
