import { DateTime } from "luxon";
import type { DailyWindow, DateRange, InstantRange } from "./types";

export const UNIT_ZONE = "Asia/Jerusalem";

export function instant(value: string): DateTime {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new Error("למועד נדרש אזור זמן מפורש");
  const parsed = DateTime.fromISO(value, { zone: UNIT_ZONE });
  if (!parsed.isValid) throw new Error("מועד לא תקין");
  return parsed;
}

export function localDate(value: string): DateTime {
  const parsed = DateTime.fromISO(value, { zone: UNIT_ZONE });
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !parsed.isValid ||
    parsed.toISODate() !== value
  ) {
    throw new Error("תאריך לא תקין");
  }
  return parsed.startOf("day");
}

/** Reject DST gaps; ambiguous times must carry the user's explicit chosen offset. */
export function resolveLocalTime(
  date: string,
  time: string,
  offsetMinutes?: number
): string {
  localDate(date);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("שעה לא תקינה");
  const requested = `${date}T${time}`;
  const parsed = DateTime.fromISO(requested, { zone: UNIT_ZONE });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== requested) {
    throw new Error("השעה אינה קיימת במעבר לשעון קיץ");
  }
  const possibilities = parsed.getPossibleOffsets();
  if (possibilities.length > 1 && offsetMinutes === undefined)
    throw new Error("השעה מופיעה פעמיים; יש לבחור היסט זמן");
  const chosen =
    offsetMinutes === undefined
      ? parsed
      : possibilities.find((candidate) => candidate.offset === offsetMinutes);
  if (!chosen) throw new Error("היסט הזמן אינו מתאים למועד");
  return chosen.toISO()!;
}

export function interval(range: InstantRange): { start: number; end: number } {
  const start = instant(range.start).toMillis();
  const end = instant(range.end).toMillis();
  if (end <= start) throw new Error("מועד הסיום חייב להיות אחרי מועד ההתחלה");
  return { start, end };
}

export function datesToInstants(range: DateRange): {
  start: number;
  end: number;
} {
  const start = localDate(range.start).toMillis();
  const end = localDate(range.end).plus({ days: 1 }).toMillis();
  if (end <= start) throw new Error("טווח תאריכים לא תקין");
  return { start, end };
}

export function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number }
): boolean {
  return a.start < b.end && b.start < a.end;
}

export function graceEnd(arrivalDate: string): string {
  return localDate(arrivalDate).plus({ months: 1 }).toISODate()!;
}

export function releaseBoundary(releaseDate: string): string {
  return localDate(releaseDate).plus({ days: 1 }).toISO()!;
}

/**
 * Resolves a wall-clock window boundary without rejecting clock changes. A time
 * skipped when summer time starts maps to the moment of the change; a repeated
 * time maps to its first occurrence as a start and its second as an end, so the
 * window keeps its widest meaning.
 */
export function windowBoundary(
  date: string,
  time: string,
  side: "start" | "end"
): number {
  localDate(date);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("שעה לא תקינה");
  const requested = `${date}T${time}`;
  const parsed = DateTime.fromISO(requested, { zone: UNIT_ZONE });
  if (parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== requested)
    return parsed.startOf("hour").toMillis();
  const moments = parsed
    .getPossibleOffsets()
    .map((candidate) => candidate.toMillis());
  return side === "start" ? Math.min(...moments) : Math.max(...moments);
}

/** A window spanning midnight belongs to its starting date. Equal endpoints mean one full local day. */
export function dailyWindows(
  range: InstantRange,
  rule: DailyWindow,
  lenient = false
): { date: string; start: number; end: number }[] {
  const target = interval(range);
  const windows: { date: string; start: number; end: number }[] = [];
  let date = instant(range.start).startOf("day").minus({ days: 1 });
  const last = instant(range.end).startOf("day");
  while (date <= last) {
    if (!rule.weekdays || rule.weekdays.includes(date.weekday)) {
      const isoDate = date.toISODate()!;
      const endDate =
        rule.endTime <= rule.startTime
          ? date.plus({ days: 1 }).toISODate()!
          : isoDate;
      const start = lenient
        ? windowBoundary(isoDate, rule.startTime, "start")
        : instant(resolveLocalTime(isoDate, rule.startTime)).toMillis();
      const end = lenient
        ? windowBoundary(endDate, rule.endTime, "end")
        : instant(resolveLocalTime(endDate, rule.endTime)).toMillis();
      if (overlaps(target, { start, end }))
        windows.push({ date: isoDate, start, end });
    }
    date = date.plus({ days: 1 });
  }
  return windows;
}

export function coveredByRanges(
  target: { start: number; end: number },
  ranges: { start: number; end: number }[]
): boolean {
  let coveredUntil = target.start;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.start > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, range.end);
    if (coveredUntil >= target.end) return true;
  }
  return false;
}

/**
 * Whether a business effective time differs from when it was recorded. A date
 * differs when it is another Israel calendar day; a moment by a minute or more.
 */
export function effectiveDiffers(effective: string, recordedAt: string) {
  const recorded = DateTime.fromISO(recordedAt).setZone(UNIT_ZONE);
  if (!effective || !recorded.isValid) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(effective))
    return recorded.toISODate() !== effective;
  const at = DateTime.fromISO(effective);
  return at.isValid && Math.abs(at.diff(recorded).as("minutes")) >= 1;
}
