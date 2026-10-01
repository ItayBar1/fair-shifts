import { DateTime } from "luxon";
import { type AppState, str } from "./types";

// The seat of a soldier deleted while a duty ran (decision 196): it stays on
// the deleted soldier until a manager records the periods, and it is not
// credited automatically meanwhile.

const ZONE = "Asia/Jerusalem";

/** Reserved seats of deleted soldiers that no manager has decided yet. */
export function deletedSeats(
  state: Pick<AppState, "soldiers" | "assignments">,
  dutyId?: string
) {
  const gone = new Set(
    state.soldiers.filter((s) => s.deletedAt).map((s) => s.id)
  );
  return state.assignments.filter(
    (row) =>
      ["reserved", "held"].includes(str(row.status)) &&
      gone.has(str(row.soldierId)) &&
      !row.deletionDecidedAt &&
      (!dutyId || row.dutyId === dutyId)
  );
}

type Segment = { soldierId: string | null; start: string; end: string };

/**
 * What the periods editor offers for a deleted soldier's recorded period: the
 * part up to the deletion stays theirs and the rest waits for a replacement.
 * The manager may change either. A deletion before the period began leaves
 * nothing to the soldier, and one after it ended changes nothing.
 */
export function suggestDeletedSplit(
  segment: Segment,
  deletedAt: string | undefined
): Segment[] {
  if (!segment.soldierId || !deletedAt) return [segment];
  const at = DateTime.fromISO(deletedAt, { zone: ZONE });
  const start = DateTime.fromISO(segment.start, { zone: ZONE });
  const end = DateTime.fromISO(segment.end, { zone: ZONE });
  if (!at.isValid || !start.isValid || !end.isValid || at >= end)
    return [segment];
  if (at <= start)
    return [{ soldierId: null, start: segment.start, end: segment.end }];
  const iso = at.toISO()!;
  return [
    { soldierId: segment.soldierId, start: segment.start, end: iso },
    { soldierId: null, start: iso, end: segment.end },
  ];
}
