import { describe, expect, it } from "vitest";
import {
  executionPeriod,
  normalizeSegments,
  segmentPrice,
  within,
} from "../../src/domain/execution";
import type { Pricing } from "../../src/domain/types";

// Execution periods of a seat (card #18, decision 183).
const duty = {
  start: "2026-09-27T20:00:00+03:00",
  end: "2026-09-29T20:00:00+03:00",
};
const daily: Pricing = { mode: "daily", basePoints: "4", surcharges: [] };
const night = (threshold: Pricing["surcharges"][number]["threshold"]) => ({
  ...daily,
  surcharges: [
    {
      id: "night",
      name: "לילה",
      points: "1",
      window: { startTime: "22:00", endTime: "06:00" },
      threshold,
      frequency: "per_window" as const,
    },
  ],
});

describe("normalizeSegments", () => {
  it("accepts parts that follow each other from start to end and merges adjacent non-performance", () => {
    expect(
      normalizeSegments(duty, [
        { soldierId: "b", start: "2026-09-28T06:00:00+03:00", end: duty.end },
        {
          soldierId: null,
          start: "2026-09-28T02:00:00+03:00",
          end: "2026-09-28T04:00:00+03:00",
        },
        {
          soldierId: null,
          start: "2026-09-28T04:00:00+03:00",
          end: "2026-09-28T06:00:00+03:00",
        },
        {
          soldierId: "a",
          start: duty.start,
          end: "2026-09-28T02:00:00+03:00",
        },
      ])
    ).toEqual([
      { soldierId: "a", start: duty.start, end: "2026-09-28T02:00:00+03:00" },
      {
        soldierId: null,
        start: "2026-09-28T02:00:00+03:00",
        end: "2026-09-28T06:00:00+03:00",
      },
      { soldierId: "b", start: "2026-09-28T06:00:00+03:00", end: duty.end },
    ]);
  });
  it("rejects a gap, an overlap, time outside the duty and two periods of one soldier", () => {
    const at = (hour: string) => `2026-09-28T${hour}:00:00+03:00`;
    expect(() =>
      normalizeSegments(duty, [
        { soldierId: "a", start: duty.start, end: at("02") },
        { soldierId: "b", start: at("03"), end: duty.end },
      ])
    ).toThrow("לא שויך");
    expect(() =>
      normalizeSegments(duty, [
        { soldierId: "a", start: duty.start, end: at("04") },
        { soldierId: "b", start: at("03"), end: duty.end },
      ])
    ).toThrow("חופפות");
    expect(() =>
      normalizeSegments(duty, [
        { soldierId: "a", start: duty.start, end: "2026-09-30T20:00:00+03:00" },
      ])
    ).toThrow("חורגת");
    expect(() =>
      normalizeSegments(duty, [
        { soldierId: "a", start: duty.start, end: at("02") },
        { soldierId: "b", start: at("02"), end: at("10") },
        { soldierId: "a", start: at("10"), end: duty.end },
      ])
    ).toThrow("רציפה אחת");
    // The same moment written with another offset is the same boundary.
    expect(
      normalizeSegments(duty, [
        { soldierId: "a", start: duty.start, end: "2026-09-27T23:00:00Z" },
        { soldierId: "b", start: at("02"), end: duty.end },
      ])
    ).toHaveLength(2);
  });
});

describe("segmentPrice", () => {
  it("gives each performer the daily base in proportion to actual time, rounded once at the end", () => {
    // 36 hours at 4 per day are worth 6 to each full performer (scenario 20).
    expect(
      segmentPrice(daily, {
        start: duty.start,
        end: "2026-09-29T08:00:00+03:00",
      }).points
    ).toBe(6);
    // 21 hours are 3.5 and round half up to 4; 9 hours are 1.5 and round to 2.
    const long = segmentPrice(daily, {
      start: duty.start,
      end: "2026-09-28T17:00:00+03:00",
    });
    expect(long).toMatchObject({ base: "3.5", points: 4 });
    expect(
      segmentPrice(daily, {
        start: "2026-09-28T17:00:00+03:00",
        end: "2026-09-29T02:00:00+03:00",
      }).points
    ).toBe(2);
  });
  it("tests each time extra against the performer's own overlap with its daily window", () => {
    const before = { start: duty.start, end: "2026-09-28T02:00:00+03:00" };
    const after = { start: "2026-09-28T02:00:00+03:00", end: duty.end };
    // Any overlap: both performers touched the first night, so each gets it once.
    const any = night({ kind: "any_overlap" });
    expect(segmentPrice(any, before).surcharges[0]).toMatchObject({
      windows: ["2026-09-27"],
      count: 1,
    });
    expect(segmentPrice(any, after).surcharges[0]).toMatchObject({
      windows: ["2026-09-27", "2026-09-28"],
      count: 2,
    });
    // At least five hours: four hours each of the first night qualify for nobody.
    const minimum = night({ kind: "minimum_hours", hours: "5" });
    expect(segmentPrice(minimum, before).surcharges[0].count).toBe(0);
    expect(segmentPrice(minimum, after).surcharges[0]).toMatchObject({
      windows: ["2026-09-28"],
      count: 1,
    });
    // 6 hours base 1 + no night; 42 hours base 7 + one night.
    expect(segmentPrice(minimum, before).points).toBe(1);
    expect(segmentPrice(minimum, after).points).toBe(8);
  });
  it("measures real hours across the end of summer time in Israel", () => {
    // 25 October 2026: 02:00 returns to 01:00, so this calendar day lasts 25 hours.
    const period = {
      start: "2026-10-24T20:00:00+03:00",
      end: "2026-10-25T20:00:00+02:00",
    };
    const price = segmentPrice(
      night({ kind: "minimum_hours", hours: "8.5" }),
      period
    );
    // 25 hours at 4 per 24 hours, kept exact until the final rounding.
    expect(Number(price.base)).toBeCloseTo(25 / 6, 12);
    // The night of 24 October lasts nine real hours and meets the minimum.
    expect(price.surcharges[0]).toMatchObject({
      windows: ["2026-10-24"],
      count: 1,
    });
    expect(Number(price.totalExact)).toBeCloseTo(31 / 6, 12);
    expect(price.points).toBe(5);
  });
  it("refuses a fixed rate until fixed shares are supported", () => {
    expect(() => segmentPrice({ ...daily, mode: "fixed" }, duty)).toThrow(
      "#19"
    );
  });
});

describe("executionPeriod", () => {
  it("prefers a credited performance, then an explicit period, then the whole duty", () => {
    expect(executionPeriod({}, duty)).toEqual(duty);
    const explicit = {
      performedStart: duty.start,
      performedEnd: "2026-09-28T02:00:00+03:00",
    };
    expect(executionPeriod(explicit, duty)).toEqual({
      start: duty.start,
      end: "2026-09-28T02:00:00+03:00",
    });
    const performance = {
      performerId: "a",
      start: duty.start,
      end: "2026-09-28T04:00:00+03:00",
      points: 1,
      reflected: {},
      corrections: 1,
    };
    expect(executionPeriod({ ...explicit, performance }, duty).end).toBe(
      "2026-09-28T04:00:00+03:00"
    );
    expect(
      executionPeriod(
        { ...explicit, performance: { ...performance, removed: true } },
        duty
      ).end
    ).toBe("2026-09-28T02:00:00+03:00");
    expect(
      within(
        { start: explicit.performedStart, end: explicit.performedEnd },
        duty
      )
    ).toBe(true);
  });
});
