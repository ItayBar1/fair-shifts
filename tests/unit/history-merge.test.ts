import { afterEach, describe, expect, it, vi } from "vitest";
import {
  refreshOlder,
  withHistory,
  type HistorySlice,
} from "../../src/client/history";
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
  describe("reading the loaded slices again with a fresh state", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("reads as many slices as were loaded, each before the last, from the fresh window", async () => {
      const asked: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        const before = new URL(url, "http://local").searchParams.get("before")!;
        asked.push(before);
        const from = `before-${before}`;
        return new Response(JSON.stringify(slice(from, true, [before])), {
          status: 200,
        });
      });
      const slices = await refreshOlder(state, 2);
      expect(asked).toEqual([
        "2026-07-20T00:00:00.000Z",
        "before-2026-07-20T00:00:00.000Z",
      ]);
      expect(slices).toHaveLength(2);
    });
    it("stops when nothing earlier is left, and reads nothing without a window", async () => {
      const fetcher = vi.fn(
        async () =>
          new Response(
            JSON.stringify(slice("2026-04-21T00:00:00.000Z", false, ["d0"])),
            {
              status: 200,
            }
          )
      );
      vi.stubGlobal("fetch", fetcher);
      expect(await refreshOlder(state, 3)).toHaveLength(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(
        await refreshOlder({ ...state, history: undefined } as AppState, 2)
      ).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });
});
