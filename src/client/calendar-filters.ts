import { type MonthKey, isCancelled, onBoard, overlapsMonth } from "./calendar";
import { type Row, rows, str } from "./types";

export type CalendarSelection = "month" | "mine" | "upcoming" | "vacant";
type Display = { mode: "list" | "month"; onlyMine: boolean };
export type CalendarControls = Display & {
  selection?: CalendarSelection;
  previous?: Display;
};

/** A second press restores the view and scope from before the first card. */
export function selectCalendarCard(
  current: CalendarControls,
  selection: CalendarSelection
): CalendarControls {
  if (current.selection === selection)
    return current.previous ?? { mode: "month", onlyMine: false };
  return {
    mode: "list",
    onlyMine:
      selection === "month"
        ? false
        : selection === "mine"
          ? true
          : current.onlyMine,
    selection,
    previous: current.previous ?? {
      mode: current.mode,
      onlyMine: current.onlyMine,
    },
  };
}

const liveAssignment = (row: Row) =>
  !["cancelled", "transferred"].includes(str(row.status));

export function vacantSeats(duty: Row, assignments: Row[]) {
  const occupied = new Set(
    assignments
      .filter((a) => a.dutyId === duty.id && liveAssignment(a))
      .map((a) => str(a.slotId))
  );
  return rows(duty.slots).filter((slot) => !occupied.has(slot.id)).length;
}

/** Cards and list share the same month, search and assignment snapshot. */
export function calendarBoard({
  duties,
  assignments,
  soldierId,
  month,
  query,
  controls,
  now,
}: {
  duties: Row[];
  assignments: Row[];
  soldierId?: string;
  month: MonthKey;
  query: string;
  controls: CalendarControls;
  now: string;
}) {
  const ownIds = new Set(
    assignments
      .filter((a) => a.soldierId === soldierId && liveAssignment(a))
      .map((a) => str(a.dutyId))
  );
  const monthRows = duties
    .filter(
      (d) =>
        onBoard(d) && overlapsMonth(d, month) && str(d.name).includes(query)
    )
    .sort((a, b) => str(a.start).localeCompare(str(b.start)));
  const active = monthRows.filter((d) => !isCancelled(d));
  const inScope = (d: Row) => !controls.onlyMine || ownIds.has(d.id);
  const upcoming = active.filter(
    (d) => inScope(d) && Date.parse(str(d.end)) > Date.parse(now)
  );
  const vacant = active.filter(
    (d) => inScope(d) && vacantSeats(d, assignments) > 0
  );
  const counts = {
    month: active.length,
    mine: active.filter((d) => ownIds.has(d.id)).length,
    upcoming: upcoming.length,
    vacant: vacant.reduce((sum, d) => sum + vacantSeats(d, assignments), 0),
  };
  const displayed =
    controls.selection === "upcoming"
      ? upcoming
      : controls.selection === "vacant"
        ? vacant
        : controls.selection
          ? active.filter(inScope)
          : monthRows.filter(inScope);
  return { ownIds, counts, displayed };
}
