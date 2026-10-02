import { localDate } from "@/domain/time";
import { type Row, str } from "./types";

/**
 * The drafts a manager can pick to publish together (decision 197): drafts that
 * have not started and start on a day in the range, by Israel time. The server
 * checks readiness; this only finds the candidates.
 */
export function draftsInRange(
  duties: Row[],
  start: string,
  end: string,
  now: number
): Row[] {
  let from: number;
  let to: number;
  try {
    from = localDate(start).toMillis();
    // A calendar day after the last day, so a 23- or 25-hour day still ends at midnight.
    to = localDate(end).plus({ days: 1 }).startOf("day").toMillis();
  } catch {
    return [];
  }
  return duties
    .filter((duty) => {
      const at = new Date(str(duty.start)).getTime();
      return duty.status === "draft" && at > now && at >= from && at < to;
    })
    .sort(
      (a, b) =>
        new Date(str(a.start)).getTime() - new Date(str(b.start)).getTime() ||
        str(a.id).localeCompare(str(b.id))
    );
}

/** The drafts a finished planning run covered that can still be published. */
export function runDrafts(run: Row, duties: Row[], now: number): Row[] {
  const ids = Array.isArray(run.dutyIds) ? run.dutyIds.map(String) : [];
  return duties
    .filter(
      (duty) =>
        ids.includes(str(duty.id)) &&
        duty.status === "draft" &&
        new Date(str(duty.start)).getTime() > now
    )
    .sort(
      (a, b) =>
        new Date(str(a.start)).getTime() - new Date(str(b.start)).getTime() ||
        str(a.id).localeCompare(str(b.id))
    );
}
