import { describe, expect, it } from "vitest";
import {
  dueReminder,
  dutyReminderKey,
  dutyReminderText,
  parseDutyReminderKey,
  reminderDueAt,
} from "../../src/domain/duty-reminders";

const HOUR = 3_600_000;
const start = Date.parse("2026-10-20T08:00:00+03:00");
const window = (now: number, overrides = {}) => ({
  start,
  hours: [24, 2],
  since: now - 60_000,
  knownAt: start - 72 * HOUR,
  now,
  ...overrides,
});

describe("duty reminder rules", () => {
  it("sends each default time once, when it becomes due", () => {
    expect(dueReminder(window(start - 25 * HOUR))).toBeNull();
    expect(dueReminder(window(start - 24 * HOUR))).toEqual({
      hours: 24,
      merged: [],
    });
    // The next run starts after the previous one, so the time is not repeated.
    expect(
      dueReminder(
        window(start - 24 * HOUR + 60_000, { since: start - 24 * HOUR })
      )
    ).toBeNull();
    expect(dueReminder(window(start - 2 * HOUR + 30_000))).toEqual({
      hours: 2,
      merged: [],
    });
  });

  it("merges times missed during downtime into the closest one", () => {
    expect(
      dueReminder(window(start - HOUR, { since: start - 30 * HOUR }))
    ).toEqual({ hours: 2, merged: [24] });
  });

  it("skips a started duty even after downtime", () => {
    expect(dueReminder(window(start, { since: start - 30 * HOUR }))).toBeNull();
    expect(
      dueReminder(window(start + HOUR, { since: start - 30 * HOUR }))
    ).toBeNull();
  });

  it("skips times that passed before the soldier knew of the schedule", () => {
    // Published (or transferred, or rescheduled) 10 hours before the start.
    const knownAt = start - 10 * HOUR;
    expect(
      dueReminder(
        window(start - 9 * HOUR, { since: start - 30 * HOUR, knownAt })
      )
    ).toBeNull();
    expect(dueReminder(window(start - 2 * HOUR, { knownAt }))).toEqual({
      hours: 2,
      merged: [],
    });
  });

  it("uses the soldier's hours and sends nothing for an empty list", () => {
    expect(dueReminder(window(start - 48 * HOUR, { hours: [48, 6] }))).toEqual({
      hours: 48,
      merged: [],
    });
    expect(dueReminder(window(start - 24 * HOUR, { hours: [] }))).toBeNull();
  });

  it("counts absolute hours across a daylight saving change", () => {
    // Israel returns to winter time on 25.10.2026 at 02:00.
    const dutyStart = Date.parse("2026-10-25T08:00:00+02:00");
    expect(new Date(reminderDueAt(dutyStart, 24)).toISOString()).toBe(
      "2026-10-24T06:00:00.000Z"
    );
  });

  it("round-trips the event key and keeps the email free of personal details", () => {
    const dutyId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const key = dutyReminderKey(dutyId, start, 2, "account-1");
    expect(parseDutyReminderKey(key)).toEqual({
      dutyId,
      start,
      hours: 2,
      accountId: "account-1",
    });
    expect(parseDutyReminderKey("round:x")).toBeNull();
    expect(
      dutyReminderText({ name: "שמירה", start: "2026-10-20T08:00:00+03:00" })
    ).toEqual({
      title: "תזכורת: תורנות מתקרבת",
      body: "התורנות שמירה מתחילה ב־20.10.2026 08:00 (שעון ישראל).",
    });
  });
});
