import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { draftsInRange, runDrafts } from "../../src/client/publish-drafts";

const now = DateTime.fromISO("2026-10-01T10:00:00+03:00").toMillis();
const row = (id: string, start: string, status = "draft") => ({
  id,
  version: 1,
  name: id,
  status,
  start,
});
const ids = (list: { id: string }[]) => list.map((item) => item.id);

describe("draftsInRange", () => {
  const duties = [
    row("late", "2026-10-03T22:00:00+03:00"),
    row("early", "2026-10-02T08:00:00+03:00"),
    row("outside", "2026-10-05T08:00:00+03:00"),
    row("published", "2026-10-02T09:00:00+03:00", "published"),
    row("cancelled", "2026-10-02T09:30:00+03:00", "cancelled"),
    row("started", "2026-10-01T09:00:00+03:00"),
  ];
  it("lists future drafts that start in the range, by start time", () => {
    expect(ids(draftsInRange(duties, "2026-10-02", "2026-10-03", now))).toEqual(
      ["early", "late"]
    );
  });
  it("takes both end dates whole, by Israel time, not UTC", () => {
    // 22:30 UTC on the 3rd is already 01:30 on the 4th in Israel.
    const edge = [
      row("last-minute", "2026-10-03T23:59:00+03:00"),
      row("after-midnight", "2026-10-04T00:00:00+03:00"),
      row("first-minute", "2026-10-02T00:00:00+03:00"),
      row("before", "2026-10-01T23:59:00+03:00"),
    ];
    expect(ids(draftsInRange(edge, "2026-10-02", "2026-10-03", now))).toEqual([
      "first-minute",
      "last-minute",
    ]);
  });
  it("never lists a draft that has already started", () => {
    expect(
      ids(draftsInRange(duties, "2026-10-01", "2026-10-02", now))
    ).not.toContain("started");
  });
  it("covers the day the clocks go back, which has 25 hours", () => {
    // Israel returns to standard time on 2026-10-25 at 02:00.
    const change = [
      row("evening-before", "2026-10-24T23:30:00+03:00"),
      row("first-hour", "2026-10-25T00:30:00+03:00"),
      row("repeated-hour", "2026-10-25T01:30:00+02:00"),
      row("last-hour", "2026-10-25T23:30:00+02:00"),
      row("next-day", "2026-10-26T00:00:00+02:00"),
    ];
    expect(ids(draftsInRange(change, "2026-10-25", "2026-10-25", now))).toEqual(
      ["first-hour", "repeated-hour", "last-hour"]
    );
    expect(ids(draftsInRange(change, "2026-10-24", "2026-10-26", now))).toEqual(
      ids(change)
    );
  });
  it("covers the day the clocks go forward, which has 23 hours", () => {
    // Israel moves to summer time on 2027-03-26 at 02:00.
    const springNow = DateTime.fromISO("2027-03-01T10:00:00+02:00").toMillis();
    const change = [
      row("last-hour", "2027-03-26T23:30:00+03:00"),
      row("first-hour", "2027-03-26T00:30:00+02:00"),
      row("next-day", "2027-03-27T00:00:00+03:00"),
    ];
    expect(
      ids(draftsInRange(change, "2027-03-26", "2027-03-26", springNow))
    ).toEqual(["first-hour", "last-hour"]);
  });
  it("lists nothing for a range that is empty, reversed or not a date", () => {
    expect(draftsInRange(duties, "2026-10-03", "2026-10-02", now)).toEqual([]);
    expect(draftsInRange(duties, "", "2026-10-03", now)).toEqual([]);
    expect(draftsInRange(duties, "2026-10-02", "soon", now)).toEqual([]);
  });
});

describe("runDrafts", () => {
  it("returns the run's drafts that can still be published", () => {
    const duties = [
      row("a", "2026-10-03T08:00:00+03:00"),
      row("b", "2026-10-02T08:00:00+03:00"),
      row("published", "2026-10-04T08:00:00+03:00", "published"),
      row("started", "2026-10-01T08:00:00+03:00"),
      row("other-run", "2026-10-06T08:00:00+03:00"),
    ];
    const run = {
      id: "r",
      dutyIds: ["a", "b", "published", "started", "missing"],
    };
    expect(ids(runDrafts(run, duties, now))).toEqual(["b", "a"]);
    expect(runDrafts({ id: "r" }, duties, now)).toEqual([]);
  });
});
