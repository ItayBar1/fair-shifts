import {
  assertDefaultHours,
  hoursExemptionConflicts,
  type DefaultHours,
} from "@/domain/default-hours";
import type { DailyWindow } from "@/domain/types";
import { type Row, num, obj, rows, str } from "./types";

/** The default hours saved on a duty type, if it has them (decision 229). */
export function defaultHoursOf(
  type: Row | undefined
): DefaultHours | undefined {
  const hours = obj(type?.defaultHours);
  return str(hours.startTime) && str(hours.endTime)
    ? {
        startTime: str(hours.startTime),
        endTime: str(hours.endTime),
        endDays: num(hours.endDays),
      }
    : undefined;
}

/**
 * Reads the catalog form's three fields. Both times empty means no default
 * hours; one time alone, or an end that is not after the start, is an error.
 */
export function readDefaultHours(
  startTime: string,
  endTime: string,
  endDays: string
): { hours: DefaultHours | null; error?: string } {
  if (!startTime && !endTime) return { hours: null };
  if (!startTime || !endTime)
    return { hours: null, error: "יש להזין גם שעת התחלה וגם שעת סיום" };
  const hours = { startTime, endTime, endDays: Number(endDays || 0) };
  try {
    assertDefaultHours(hours);
  } catch (error) {
    return { hours: null, error: (error as Error).message };
  }
  return { hours };
}

export function describeDefaultHours(hours: DefaultHours) {
  const end =
    hours.endDays === 0
      ? hours.endTime
      : hours.endDays === 1
        ? `${hours.endTime} למחרת`
        : `${hours.endTime} אחרי ${hours.endDays} ימים`;
  return `${hours.startTime}–${end}`;
}

/**
 * The hours exemptions in the catalog that the default hours do not fit, with
 * the start weekdays on which they block. A soldier holding one is not eligible
 * for such an instance; the server decides on each instance's real dates.
 */
export function relevantHoursExemptions(
  hours: DefaultHours,
  catalog: Row[]
): { id: string; name: string; weekdays: number[] }[] {
  return catalog
    .filter((entry) => entry.kind === "exemption" && rows(entry.windows).length)
    .map((entry) => ({
      id: str(entry.id),
      name: str(entry.name),
      weekdays: hoursExemptionConflicts(
        hours,
        rows(entry.windows) as unknown as DailyWindow[]
      ),
    }))
    .filter((entry) => entry.weekdays.length);
}
