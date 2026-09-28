import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Settings } from "luxon";
import {
  dayOfMonth,
  dutyDays,
  localDay,
  monthGrid,
  monthOf,
  onBoard,
  overlapsMonth,
  segmentLabel,
  shiftMonth,
} from "../../src/client/calendar";
import { interval } from "../../src/domain/time";

const duty = (start: string, end: string, extra = {}) => ({
  id: "d",
  start,
  end,
  status: "published",
  ...extra,
});

describe("unit calendar in Asia/Jerusalem", () => {
  // Simulate a browser in another zone; results must not change.
  const original = Settings.defaultZone;
  beforeAll(() => {
    Settings.defaultZone = "America/Los_Angeles";
  });
  afterAll(() => {
    Settings.defaultZone = original;
  });

  it("assigns instants near midnight to the Israeli day and month", () => {
    expect(monthOf("2026-09-30T21:30:00Z")).toEqual({ year: 2026, month: 10 });
    expect(monthOf("2026-09-30T20:59:00Z")).toEqual({ year: 2026, month: 9 });
    expect(localDay("2026-12-31T22:30:00Z")).toBe("2027-01-01");
    expect(dayOfMonth("2026-09-30T21:30:00Z")).toBe(1);
  });
  it("builds a Sunday-first month grid and moves across years", () => {
    const september = monthGrid({ year: 2026, month: 9 });
    expect(september.slice(0, 3)).toEqual([null, null, "2026-09-01"]);
    expect(september).toHaveLength(35);
    expect(monthGrid({ year: 2026, month: 11 })[0]).toBe("2026-11-01");
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({
      year: 2027,
      month: 1,
    });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({
      year: 2025,
      month: 12,
    });
  });
  it("shows a duty crossing a month in both months, with start and end", () => {
    const crossing = duty(
      "2026-09-30T22:00:00+03:00",
      "2026-10-02T06:00:00+03:00"
    );
    expect(overlapsMonth(crossing, { year: 2026, month: 9 })).toBe(true);
    expect(overlapsMonth(crossing, { year: 2026, month: 10 })).toBe(true);
    expect(overlapsMonth(crossing, { year: 2026, month: 11 })).toBe(false);
    expect(dutyDays(crossing)).toEqual([
      { date: "2026-09-30", segment: "start" },
      { date: "2026-10-01", segment: "middle" },
      { date: "2026-10-02", segment: "end" },
    ]);
    expect(segmentLabel(crossing, "start")).toBe("התחלה 22:00");
    expect(segmentLabel(crossing, "middle")).toBe("ממשיכה");
    expect(segmentLabel(crossing, "end")).toBe("סיום 06:00");
  });
  it("keeps a duty ending exactly at midnight within its own day and month", () => {
    const toMidnight = duty(
      "2026-09-30T16:00:00+03:00",
      "2026-10-01T00:00:00+03:00"
    );
    expect(dutyDays(toMidnight)).toEqual([
      { date: "2026-09-30", segment: "single" },
    ]);
    expect(overlapsMonth(toMidnight, { year: 2026, month: 10 })).toBe(false);
    expect(segmentLabel(toMidnight, "single")).toBe("16:00–00:00");
  });
  it("lists every day of a week-long duty once", () => {
    const week = dutyDays(
      duty("2026-11-01T08:00:00+02:00", "2026-11-08T08:00:00+02:00")
    );
    expect(week).toHaveLength(8);
    expect(week.map((day) => day.segment)).toEqual([
      "start",
      ...Array(6).fill("middle"),
      "end",
    ]);
    expect(new Set(week.map((day) => day.date)).size).toBe(8);
  });
  it("uses local days across DST changes while the duration stays actual time", () => {
    const autumn = duty(
      "2026-10-24T22:00:00+03:00",
      "2026-10-25T06:00:00+02:00"
    );
    expect(dutyDays(autumn).map((day) => day.date)).toEqual([
      "2026-10-24",
      "2026-10-25",
    ]);
    const autumnSpan = interval(autumn);
    expect((autumnSpan.end - autumnSpan.start) / 3_600_000).toBe(9);
    const spring = duty(
      "2027-03-25T23:00:00+02:00",
      "2027-03-26T07:00:00+03:00"
    );
    expect(dutyDays(spring).map((day) => day.date)).toEqual([
      "2027-03-25",
      "2027-03-26",
    ]);
    const springSpan = interval(spring);
    expect((springSpan.end - springSpan.start) / 3_600_000).toBe(7);
    expect(monthGrid({ year: 2026, month: 10 })).toContain("2026-10-25");
  });
  it("keeps published and later-cancelled duties on the board only", () => {
    expect(onBoard({ id: "a", status: "published" })).toBe(true);
    expect(onBoard({ id: "b", status: "cancelled", wasPublished: true })).toBe(
      true
    );
    expect(onBoard({ id: "c", status: "cancelled" })).toBe(false);
    expect(onBoard({ id: "d", status: "draft" })).toBe(false);
  });
});
