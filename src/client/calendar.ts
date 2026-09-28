import { DateTime } from "luxon";
import { UNIT_ZONE } from "@/domain/time";
import { type Row, str } from "./types";

// Every calendar computation uses the unit's zone, never the browser's.
export type MonthKey = { year: number; month: number };

const zoned = (iso: string) => DateTime.fromISO(iso, { zone: UNIT_ZONE });

export function monthOf(iso: string): MonthKey {
  const at = zoned(iso);
  return { year: at.year, month: at.month };
}
export function shiftMonth(key: MonthKey, delta: number): MonthKey {
  const at = DateTime.fromObject(
    { year: key.year, month: key.month, day: 1 },
    { zone: UNIT_ZONE }
  ).plus({ months: delta });
  return { year: at.year, month: at.month };
}
export function monthBounds(key: MonthKey) {
  const start = DateTime.fromObject(
    { year: key.year, month: key.month, day: 1 },
    { zone: UNIT_ZONE }
  );
  return { start, end: start.plus({ months: 1 }) };
}
export function monthLabel(key: MonthKey) {
  return monthBounds(key).start.setLocale("he").toFormat("LLLL yyyy");
}
export function localDay(iso: string) {
  return zoned(iso).toISODate()!;
}

/** Sunday-first grid; null cells pad the weeks outside the month. */
export function monthGrid(key: MonthKey): (string | null)[] {
  const { start } = monthBounds(key);
  const offset = start.weekday % 7;
  const days = start.daysInMonth!;
  const cells = Math.ceil((offset + days) / 7) * 7;
  return Array.from({ length: cells }, (_, index) => {
    const day = index - offset + 1;
    return day >= 1 && day <= days ? start.set({ day }).toISODate()! : null;
  });
}

export const isCancelled = (duty: Row) => str(duty.status) === "cancelled";
/** Published duties, and published duties that were later cancelled. */
export function onBoard(duty: Row) {
  const status = str(duty.status);
  return (
    status === "published" || (status === "cancelled" && !!duty.wasPublished)
  );
}

export function overlapsMonth(duty: Row, key: MonthKey) {
  const { start, end } = monthBounds(key);
  return zoned(str(duty.start)) < end && zoned(str(duty.end)) > start;
}

export type DaySegment = "single" | "start" | "middle" | "end";
/**
 * Local days a duty occupies. A duty ending exactly at midnight does not
 * occupy the following day.
 */
export function dutyDays(duty: Row): { date: string; segment: DaySegment }[] {
  const start = zoned(str(duty.start));
  const end = zoned(str(duty.end));
  if (!start.isValid || !end.isValid || end <= start) return [];
  const first = start.startOf("day");
  const lastInstant = end.minus({ milliseconds: 1 });
  const last = lastInstant.startOf("day");
  const days: { date: string; segment: DaySegment }[] = [];
  for (
    let day = first;
    day <= last;
    day = day.plus({ days: 1 }).startOf("day")
  ) {
    const date = day.toISODate()!;
    const segment: DaySegment =
      +day === +first && +day === +last
        ? "single"
        : +day === +first
          ? "start"
          : +day === +last
            ? "end"
            : "middle";
    days.push({ date, segment });
  }
  return days;
}
export function dayOfMonth(iso: string) {
  const at = zoned(iso);
  return at.isValid ? at.day : "—";
}
export function shortMonth(iso: string) {
  const at = zoned(iso);
  return at.isValid ? at.setLocale("he").toFormat("LLL") : "";
}
export function timeOf(iso: string) {
  return zoned(iso).toFormat("HH:mm");
}
export function segmentLabel(duty: Row, segment: DaySegment) {
  const start = timeOf(str(duty.start));
  const end = timeOf(str(duty.end));
  if (segment === "single") return `${start}–${end}`;
  if (segment === "start") return `התחלה ${start}`;
  if (segment === "end") return `סיום ${end}`;
  return "ממשיכה";
}
