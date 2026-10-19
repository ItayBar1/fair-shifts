"use client";
import { type AppState, type Row, str, rows } from "@/client/types";
import { dayOfMonth, localDay, shortMonth, timeOf } from "@/client/calendar";

export const dutyStart = (d: Row) => str(d.start ?? d.startsAt);
export const dutyEnd = (d: Row) => str(d.end ?? d.endsAt);
export const dutyStatus = (d: Row) => d.status ?? d.publicationStatus;
export const assignmentSoldier = (a: Row) => str(a.soldierId);
export const activeAssignments = (state: AppState, dutyId: string) =>
  state.assignments.filter(
    (a) =>
      a.dutyId === dutyId &&
      !["cancelled", "transferred"].includes(str(a.status))
  );
export const dutySlots = (d: Row) => rows(d.slots);
/** "08:00–16:00" within a day, with both dates when a duty crosses days. */
export function dutyRange(duty: Row) {
  const start = dutyStart(duty);
  const end = dutyEnd(duty);
  if (localDay(start) === localDay(end))
    return `${timeOf(start)}–${timeOf(end)}`;
  return `${dayOfMonth(start)} ${shortMonth(start)} ${timeOf(start)} – ${dayOfMonth(end)} ${shortMonth(end)} ${timeOf(end)}`;
}
