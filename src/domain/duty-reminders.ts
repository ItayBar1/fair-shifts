import { DateTime } from "luxon";
import { UNIT_ZONE } from "./time";

/**
 * Reminders before a published duty (decision 170). The schedule belongs to the
 * duty's start: a published change that keeps the start keeps the reminders already
 * sent, and a new start opens a new schedule. A reminder time that passed before the
 * soldier knew of the duty (publication, transfer, change, preference change) is
 * skipped. Times missed while the worker was down are merged into one reminder.
 */
const HOUR = 3_600_000;

export type ReminderWindow = {
  /** The duty's start, in milliseconds. */
  start: number;
  /** Reminder hours from the soldier's current preferences. */
  hours: readonly number[];
  /** The previous worker run: times up to it were already handled. */
  since: number;
  /** When the soldier learned of this schedule or last changed preferences. */
  knownAt: number;
  now: number;
};

/** Absolute hours before the start, so a DST night keeps "2 hours" as 2 hours. */
export function reminderDueAt(start: number, hours: number) {
  return start - hours * HOUR;
}

/**
 * The reminder to create now, or null. When several times became due together, one
 * reminder is sent for the closest one (the smallest number of hours).
 */
export function dueReminder(window: ReminderWindow) {
  if (window.now >= window.start) return null;
  const due = window.hours
    .filter((hours) => {
      const at = reminderDueAt(window.start, hours);
      return at > window.since && at <= window.now && at >= window.knownAt;
    })
    .sort((a, b) => a - b);
  return due.length ? { hours: due[0], merged: due.slice(1) } : null;
}

export function dutyReminderKey(
  dutyId: string,
  start: number,
  hours: number,
  accountId: string
) {
  return `reminder:${dutyId}:${start}:${hours}:${accountId}`;
}

export function parseDutyReminderKey(key: string) {
  const match = /^reminder:([0-9a-f-]{36}):(\d+):(\d+):(.+)$/.exec(key);
  return match
    ? {
        dutyId: match[1],
        start: Number(match[2]),
        hours: Number(match[3]),
        accountId: match[4],
      }
    : null;
}

/** Duty name and start in Israel time only: no location, other people or reasons. */
export function dutyReminderText(duty: { name: string; start: string }) {
  const at = DateTime.fromISO(duty.start, { zone: UNIT_ZONE }).toFormat(
    "dd.MM.yyyy HH:mm"
  );
  return {
    title: "תזכורת: תורנות מתקרבת",
    body: `התורנות ${duty.name} מתחילה ב־${at} (שעון ישראל).`,
  };
}
