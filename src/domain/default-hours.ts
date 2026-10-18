import { DateTime } from "luxon";
import {
  UNIT_ZONE,
  coveredByRanges,
  dailyWindows,
  localDate,
  resolveLocalTime,
} from "./time";
import type { DailyWindow } from "./types";

/**
 * The usual hours of a duty type (decision 229): local start and end times and
 * how many calendar days after the start date it ends. They only prefill a new
 * instance; the instance keeps its own start and end.
 */
export interface DefaultHours {
  startTime: string;
  endTime: string;
  endDays: number;
}

export const MAX_END_DAYS = 31;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function assertDefaultHours(hours: DefaultHours): void {
  if (!TIME.test(hours.startTime) || !TIME.test(hours.endTime))
    throw new Error("שעה לא תקינה");
  if (
    !Number.isInteger(hours.endDays) ||
    hours.endDays < 0 ||
    hours.endDays > MAX_END_DAYS
  )
    throw new Error(`מספר הימים עד הסיום חייב להיות בין 0 ל־${MAX_END_DAYS}`);
  if (hours.endDays === 0 && hours.endTime <= hours.startTime)
    throw new Error("תורנות שמסתיימת באותו יום צריכה להסתיים אחרי שעת ההתחלה");
}

/** The local start and end, as a datetime-local field holds them, for a duty starting on `date`. */
export function defaultHoursRange(
  date: string,
  hours: DefaultHours
): { start: string; end: string } {
  const endDate = localDate(date).plus({ days: hours.endDays }).toISODate()!;
  return {
    start: `${date}T${hours.startTime}`,
    end: `${endDate}T${hours.endTime}`,
  };
}

/**
 * ISO weekdays on which a duty starting at the default hours falls outside an
 * hours exemption's windows, so a soldier holding it is not eligible. Measured
 * on a week without a clock change; the eligibility check of each instance
 * still decides on its real dates.
 */
export function hoursExemptionConflicts(
  hours: DefaultHours,
  windows: DailyWindow[]
): number[] {
  const sunday = DateTime.fromISO("2026-01-04", { zone: UNIT_ZONE });
  const conflicts: number[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const day = sunday.plus({ days: offset });
    const local = defaultHoursRange(day.toISODate()!, hours);
    const [startDate, startTime] = local.start.split("T");
    const [endDate, endTime] = local.end.split("T");
    const range = {
      start: resolveLocalTime(startDate, startTime),
      end: resolveLocalTime(endDate, endTime),
    };
    const target = {
      start: DateTime.fromISO(range.start).toMillis(),
      end: DateTime.fromISO(range.end).toMillis(),
    };
    const allowed = windows.flatMap((window) =>
      dailyWindows(range, window, true)
    );
    if (!coveredByRanges(target, allowed)) conflicts.push(day.weekday);
  }
  return conflicts;
}
