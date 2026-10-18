import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  assertDefaultHours,
  defaultHoursRange,
  hoursExemptionConflicts,
  type DefaultHours,
} from "../../src/domain/default-hours";
import {
  defaultHoursOf,
  describeDefaultHours,
  readDefaultHours,
  relevantHoursExemptions,
} from "../../src/client/default-hours";
import { resolveLocalTime } from "../../src/domain/time";

// Default hours of a duty type (decision 229).
const hours = (
  startTime: string,
  endTime: string,
  endDays = 0
): DefaultHours => ({ startTime, endTime, endDays });
const everyDay = [1, 2, 3, 4, 5, 6, 7];
// The order the conflicts come in: Sunday first, as the Israeli week runs.
const week = [7, 1, 2, 3, 4, 5, 6];

describe("default hours of a duty type", () => {
  it("accepts an end after the start on the same day or any end on a later day", () => {
    for (const valid of [
      hours("08:00", "16:00"),
      hours("08:00", "08:00", 1),
      hours("22:00", "06:00", 1),
      hours("00:00", "23:59"),
      hours("08:00", "08:00", 31),
    ])
      expect(() => assertDefaultHours(valid)).not.toThrow();
  });

  it("rejects an end not after the start on the same day, a bad time and a day count out of range", () => {
    for (const invalid of [
      hours("08:00", "08:00"),
      hours("16:00", "08:00"),
      hours("8:00", "16:00"),
      hours("08:00", "24:00", 1),
      hours("08:00", "16:00", -1),
      hours("08:00", "16:00", 32),
      hours("08:00", "16:00", 1.5),
    ])
      expect(() => assertDefaultHours(invalid)).toThrow();
  });

  it("fills local start and end from a start date across a month, a year and the night of a clock change", () => {
    expect(defaultHoursRange("2026-10-31", hours("08:00", "08:00", 1))).toEqual(
      { start: "2026-10-31T08:00", end: "2026-11-01T08:00" }
    );
    expect(defaultHoursRange("2026-12-31", hours("20:00", "06:00", 1))).toEqual(
      { start: "2026-12-31T20:00", end: "2027-01-01T06:00" }
    );
    expect(defaultHoursRange("2026-03-01", hours("08:00", "17:00", 7))).toEqual(
      { start: "2026-03-01T08:00", end: "2026-03-08T17:00" }
    );
    // Wall-clock hours are kept; the night the clock goes back is an hour longer.
    const night = defaultHoursRange("2026-10-24", hours("20:00", "08:00", 1));
    expect(night).toEqual({
      start: "2026-10-24T20:00",
      end: "2026-10-25T08:00",
    });
    const [start, end] = [night.start, night.end].map((moment) =>
      DateTime.fromISO(
        resolveLocalTime(moment.slice(0, 10), moment.slice(11))
      ).toMillis()
    );
    expect((end - start) / 3_600_000).toBe(13);
    expect(() =>
      defaultHoursRange("2026-02-30", hours("08:00", "16:00"))
    ).toThrow();
  });

  it("finds the start weekdays on which the hours fall outside an hours exemption", () => {
    const morning = [
      { startTime: "08:00", endTime: "14:00", weekdays: everyDay },
    ];
    expect(hoursExemptionConflicts(hours("08:00", "16:00"), morning)).toEqual(
      week
    );
    expect(hoursExemptionConflicts(hours("09:00", "13:00"), morning)).toEqual(
      []
    );
    // Windows only on Sunday to Thursday block a duty that starts on Friday or Saturday.
    const workdays = [
      { startTime: "08:00", endTime: "17:00", weekdays: [7, 1, 2, 3, 4] },
    ];
    expect(hoursExemptionConflicts(hours("08:00", "16:00"), workdays)).toEqual([
      5, 6,
    ]);
    // Adjacent windows together cover the duty.
    const split = [
      { startTime: "08:00", endTime: "12:00", weekdays: everyDay },
      { startTime: "12:00", endTime: "20:00", weekdays: everyDay },
    ];
    expect(hoursExemptionConflicts(hours("08:00", "20:00"), split)).toEqual([]);
    // A full-day window on every day covers a duty that runs a day and a night.
    const fullDays = [
      { startTime: "00:00", endTime: "00:00", weekdays: everyDay },
    ];
    expect(
      hoursExemptionConflicts(hours("08:00", "08:00", 1), fullDays)
    ).toEqual([]);
  });

  it("measures a window that crosses midnight from the day it starts", () => {
    const nights = [
      { startTime: "22:00", endTime: "06:00", weekdays: everyDay },
    ];
    expect(hoursExemptionConflicts(hours("23:00", "05:00", 1), nights)).toEqual(
      []
    );
    expect(hoursExemptionConflicts(hours("20:00", "02:00", 1), nights)).toEqual(
      week
    );
    // Sunday night only: the same night duty fits when it starts on Sunday.
    const sunday = [{ startTime: "22:00", endTime: "06:00", weekdays: [7] }];
    expect(hoursExemptionConflicts(hours("23:00", "05:00", 1), sunday)).toEqual(
      [1, 2, 3, 4, 5, 6]
    );
  });

  it("reads the catalog form: no hours, one time alone, an invalid range and a valid one", () => {
    expect(readDefaultHours("", "", "0")).toEqual({ hours: null });
    expect(readDefaultHours("08:00", "", "0")).toMatchObject({
      hours: null,
      error: "יש להזין גם שעת התחלה וגם שעת סיום",
    });
    expect(readDefaultHours("", "16:00", "0").error).toBeTruthy();
    expect(readDefaultHours("08:00", "08:00", "0")).toMatchObject({
      hours: null,
      error: expect.stringContaining("אחרי שעת ההתחלה"),
    });
    expect(readDefaultHours("08:00", "16:00", "40").error).toBeTruthy();
    expect(readDefaultHours("08:00", "08:00", "1")).toEqual({
      hours: hours("08:00", "08:00", 1),
    });
    expect(readDefaultHours("08:00", "16:00", "")).toEqual({
      hours: hours("08:00", "16:00"),
    });
  });

  it("reads a type's saved hours and describes them", () => {
    expect(defaultHoursOf(undefined)).toBeUndefined();
    expect(defaultHoursOf({ id: "a", name: "בלי שעות" })).toBeUndefined();
    expect(
      defaultHoursOf({
        id: "b",
        defaultHours: { startTime: "08:00", endTime: "08:00", endDays: 1 },
      })
    ).toEqual(hours("08:00", "08:00", 1));
    expect(describeDefaultHours(hours("08:00", "16:00"))).toBe("08:00–16:00");
    expect(describeDefaultHours(hours("08:00", "08:00", 1))).toBe(
      "08:00–08:00 למחרת"
    );
    expect(describeDefaultHours(hours("08:00", "17:00", 7))).toBe(
      "08:00–17:00 אחרי 7 ימים"
    );
  });

  it("lists only the hours exemptions the hours do not fit", () => {
    const catalog = [
      { id: "plain", kind: "exemption", name: "פטור רגיל" },
      { id: "skill", kind: "capability", name: "נהיגה" },
      {
        id: "morning",
        kind: "exemption",
        name: "פטור שעות בוקר",
        windows: [{ startTime: "08:00", endTime: "14:00", weekdays: everyDay }],
      },
      {
        id: "weekdays",
        kind: "exemption",
        name: "פטור ימי חול",
        windows: [
          { startTime: "06:00", endTime: "22:00", weekdays: [7, 1, 2, 3, 4] },
        ],
      },
      {
        id: "wide",
        kind: "exemption",
        name: "פטור שעות רחב",
        windows: [{ startTime: "06:00", endTime: "22:00", weekdays: everyDay }],
      },
    ];
    expect(relevantHoursExemptions(hours("08:00", "16:00"), catalog)).toEqual([
      { id: "morning", name: "פטור שעות בוקר", weekdays: week },
      { id: "weekdays", name: "פטור ימי חול", weekdays: [5, 6] },
    ]);
  });
});
