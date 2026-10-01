import { describe, expect, it } from "vitest";
import {
  deletedSeats,
  suggestDeletedSplit,
} from "../../src/client/deleted-seats";
import { assignableSoldiers, type AppState } from "../../src/client/types";

// A soldier deleted while a duty ran (decision 196). Synthetic data only.
const seat = (soldierId: string, extra: Record<string, unknown> = {}) => ({
  id: `seat-${soldierId}`,
  dutyId: "duty-1",
  soldierId,
  status: "reserved",
  ...extra,
});
const state = (
  soldiers: Record<string, unknown>[],
  assignments: Record<string, unknown>[]
) => ({ soldiers, assignments }) as unknown as AppState;

describe("seats waiting for a manager's decision after a deletion", () => {
  const people = [
    { id: "gone", deletedAt: "2026-10-01T10:00:00.000Z" },
    { id: "here" },
  ];
  it("lists a reserved seat of a deleted soldier until it is decided", () => {
    const data = state(people, [
      seat("gone"),
      seat("here"),
      seat("gone", {
        id: "decided",
        deletionDecidedAt: "2026-10-01T12:00:00Z",
      }),
      seat("gone", { id: "credited", status: "credited" }),
      seat("gone", { id: "cancelled", status: "cancelled" }),
    ]);
    expect(deletedSeats(data).map((row) => row.id)).toEqual(["seat-gone"]);
  });
  it("narrows to one duty", () => {
    const data = state(people, [
      seat("gone"),
      seat("gone", { id: "other", dutyId: "duty-2" }),
    ]);
    expect(deletedSeats(data, "duty-2").map((row) => row.id)).toEqual([
      "other",
    ]);
    expect(deletedSeats(data, "duty-3")).toEqual([]);
  });
});

describe("the split the periods editor offers", () => {
  const whole = {
    soldierId: "gone",
    start: "2026-10-01T06:00:00.000+03:00",
    end: "2026-10-02T06:00:00.000+03:00",
  };
  it("gives the soldier the part up to the deletion and leaves the rest to a replacement", () => {
    const parts = suggestDeletedSplit(whole, "2026-10-01T10:00:00.000Z");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ soldierId: "gone", start: whole.start });
    expect(parts[1]).toMatchObject({ soldierId: null, end: whole.end });
    // The two parts meet at the deletion moment, Israel time.
    expect(parts[0]!.end).toBe(parts[1]!.start);
    expect(new Date(parts[0]!.end).toISOString()).toBe(
      "2026-10-01T10:00:00.000Z"
    );
  });
  it("leaves nothing to a soldier deleted before the period began", () => {
    expect(suggestDeletedSplit(whole, "2026-10-01T02:00:00.000Z")).toEqual([
      { soldierId: null, start: whole.start, end: whole.end },
    ]);
    // At the very start, too.
    expect(suggestDeletedSplit(whole, "2026-10-01T03:00:00.000Z")).toEqual([
      { soldierId: null, start: whole.start, end: whole.end },
    ]);
  });
  it("changes nothing when the deletion came after the period ended, or is unknown", () => {
    expect(suggestDeletedSplit(whole, "2026-10-02T03:00:00.000Z")).toEqual([
      whole,
    ]);
    expect(suggestDeletedSplit(whole, "2026-10-05T00:00:00.000Z")).toEqual([
      whole,
    ]);
    expect(suggestDeletedSplit(whole, undefined)).toEqual([whole]);
    expect(
      suggestDeletedSplit({ ...whole, soldierId: null }, "2026-10-01T10:00:00Z")
    ).toEqual([{ ...whole, soldierId: null }]);
    expect(suggestDeletedSplit(whole, "not a time")).toEqual([whole]);
  });
  it("splits at the clock moment across the daylight-saving change", () => {
    const night = {
      soldierId: "gone",
      start: "2026-10-24T20:00:00.000+03:00",
      end: "2026-10-26T08:00:00.000+02:00",
    };
    // 25.10.2026 at 01:30 Israel time, after the clocks went back at 02:00.
    const parts = suggestDeletedSplit(night, "2026-10-24T23:30:00.000Z");
    expect(new Date(parts[0]!.end).toISOString()).toBe(
      "2026-10-24T23:30:00.000Z"
    );
    expect(parts[1]!.start).toBe(parts[0]!.end);
  });
});

describe("who the periods editor lists", () => {
  it("shows a deleted soldier only when the seat already records them", () => {
    const soldiers = [
      { id: "gone", deletedAt: "2026-10-01T10:00:00.000Z" },
      { id: "here" },
    ];
    expect(assignableSoldiers({ soldiers }).map((row) => row.id)).toEqual([
      "here",
    ]);
    // `keep` is for managers; only `keepDeleted` brings a deleted soldier back.
    expect(
      assignableSoldiers({ soldiers }, ["gone"]).map((row) => row.id)
    ).toEqual(["here"]);
    expect(
      assignableSoldiers({ soldiers }, [], ["gone"]).map((row) => row.id)
    ).toEqual(["gone", "here"]);
  });
});
