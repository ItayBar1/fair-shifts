import { calculatePerformedPrice } from "./pricing";
import { instant, interval } from "./time";
import type {
  Assignment,
  Duty,
  InstantRange,
  PriceBreakdown,
  Pricing,
} from "./types";

// Execution periods of one seat (decision 183): who actually covered which part of the duty.

/**
 * The period an assignment covers: a credited performance as recorded, then an explicit
 * execution period, and otherwise the whole duty.
 */
export function executionPeriod(
  assignment: Pick<
    Assignment,
    "performedStart" | "performedEnd" | "performance"
  >,
  duty: InstantRange
): InstantRange {
  if (assignment.performance && !assignment.performance.removed)
    return {
      start: assignment.performance.start,
      end: assignment.performance.end,
    };
  return {
    start: assignment.performedStart ?? duty.start,
    end: assignment.performedEnd ?? duty.end,
  };
}

/** The duty as seen by one assignment, so rank, conditions and hours are checked for its own period. */
export function executionDuty<T extends Duty>(
  duty: T,
  assignment: Pick<
    Assignment,
    "performedStart" | "performedEnd" | "performance"
  >
): T {
  return { ...duty, ...executionPeriod(assignment, duty) };
}

/** One part of a seat: a performer, or `null` for a part recorded as not performed. */
export interface ExecutionSegment extends InstantRange {
  soldierId: string | null;
}

/**
 * Validates a complete execution plan for a seat. The segments must follow each other
 * without gaps or overlaps from the duty start to its end; every soldier covers one
 * continuous period, and neighbouring parts that were not performed are merged.
 */
export function normalizeSegments(
  duty: InstantRange,
  segments: ExecutionSegment[]
): ExecutionSegment[] {
  if (!segments.length) throw new Error("נדרשת לפחות תקופת ביצוע אחת");
  const range = interval(duty);
  const sorted = segments
    .map((segment) => ({ segment, ...interval(segment) }))
    .sort((a, b) => a.start - b.start);
  let cursor = range.start;
  for (const item of sorted) {
    if (item.start < cursor)
      throw new Error("תקופות הביצוע חופפות. כל רגע בתורנות שייך למבצע אחד");
    if (item.start > cursor)
      throw new Error(
        "יש זמן בתורנות שלא שויך לאיש. יש לשבץ לו מבצע או לסמן אותו ״לא בוצע״"
      );
    if (item.end > range.end)
      throw new Error("תקופת הביצוע חורגת ממועדי התורנות");
    cursor = item.end;
  }
  if (cursor !== range.end)
    throw new Error(
      "יש זמן בתורנות שלא שויך לאיש. יש לשבץ לו מבצע או לסמן אותו ״לא בוצע״"
    );
  const merged: ExecutionSegment[] = [];
  for (const { segment } of sorted) {
    const last = merged.at(-1);
    if (last && last.soldierId === segment.soldierId && last.soldierId === null)
      last.end = segment.end;
    else merged.push({ ...segment });
  }
  const performers = merged.flatMap((segment) =>
    segment.soldierId ? [segment.soldierId] : []
  );
  if (new Set(performers).size !== performers.length)
    throw new Error(
      "לכל חייל תקופת ביצוע רציפה אחת בתורנות. אי אפשר לשייך לו שתי תקופות נפרדות"
    );
  return merged;
}

export function samePeriod(a: InstantRange, b: InstantRange) {
  return (
    instant(a.start).toMillis() === instant(b.start).toMillis() &&
    instant(a.end).toMillis() === instant(b.end).toMillis()
  );
}

/** Whether `inner` adds no time beyond `outer`, so nothing new needs checking. */
export function within(inner: InstantRange, outer: InstantRange) {
  const a = interval(inner);
  const b = interval(outer);
  return a.start >= b.start && a.end <= b.end;
}

/**
 * The value of one performer's period in a daily-rate duty: the base in proportion to the
 * actual time, and each time extra by that performer's own overlap with its daily window.
 */
export function segmentPrice(
  pricing: Pricing,
  period: InstantRange
): PriceBreakdown {
  if (pricing.mode !== "daily")
    throw new Error(
      "חלוקת ביצוע בתעריף קבוע תתאפשר בהמשך (כרטיס #19). עד אז אפשר לתקן ביצוע של מבצע יחיד"
    );
  return calculatePerformedPrice(pricing, [period], "0");
}

/** Parts of the duty no current segment or recorded non-performance covers. */
export function uncovered(
  duty: InstantRange,
  covered: InstantRange[]
): InstantRange[] {
  const range = interval(duty);
  const gaps: InstantRange[] = [];
  let cursor = range.start;
  for (const item of covered
    .map((period) => ({ period, ...interval(period) }))
    .sort((a, b) => a.start - b.start)) {
    if (item.start > cursor)
      gaps.push({
        start: new Date(cursor).toISOString(),
        end: item.period.start,
      });
    cursor = Math.max(cursor, item.end);
  }
  if (cursor < range.end)
    gaps.push({ start: new Date(cursor).toISOString(), end: duty.end });
  return gaps;
}
