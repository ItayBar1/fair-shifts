export type AssignmentSnapshot = {
  name: string;
  role: string;
  start: string;
  end: string;
  location: string;
};
export type FeedEvent = {
  id: number;
  dutyId: string;
  kind: "new" | "updated" | "cancelled";
  snapshot: AssignmentSnapshot;
};
export type PersonalAssignment = AssignmentSnapshot & {
  dutyId: string;
  assignmentId: string;
};
export type AssignmentItem = PersonalAssignment & {
  badge?: "new" | "updated";
  inProgress: boolean;
  highlighted: boolean;
};
export type CancelledItem = AssignmentSnapshot & {
  dutyId: string;
  highlighted: boolean;
};

const israelDate = new Intl.DateTimeFormat("he-IL", {
  timeZone: "Asia/Jerusalem",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "shortOffset",
});
// Show the offset so the repeated hour on the autumn clock change is unambiguous.
export const assignmentDate = (iso: string) => israelDate.format(new Date(iso));

/** Pure projection: the first event after the previous visit keeps a newly
 * published assignment "new" even if its details changed in the same visit. */
export function personalAssignmentList(
  assignments: PersonalAssignment[],
  events: FeedEvent[],
  now: string,
  highlightedDutyIds: string[],
  mailHistory: FeedEvent[] = []
): { current: AssignmentItem[]; cancelled: CancelledItem[] } {
  const first = new Map<string, FeedEvent>();
  const latest = new Map<string, FeedEvent>();
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (!first.has(event.dutyId)) first.set(event.dutyId, event);
    latest.set(event.dutyId, event);
  }
  const nowMs = Date.parse(now);
  const highlight = new Set(highlightedDutyIds);
  const current = assignments
    .filter((row) => Date.parse(row.end) > nowMs)
    .map((row) => {
      const change = first.get(row.dutyId);
      return {
        ...row,
        badge: change
          ? change.kind === "new"
            ? ("new" as const)
            : ("updated" as const)
          : undefined,
        inProgress: Date.parse(row.start) <= nowMs,
        highlighted: highlight.has(row.dutyId),
      };
    })
    .sort(
      (a, b) =>
        Date.parse(a.start) - Date.parse(b.start) ||
        a.dutyId.localeCompare(b.dutyId) ||
        a.assignmentId.localeCompare(b.assignmentId)
    );
  const activeIds = new Set(current.map((row) => row.dutyId));
  const previousMail = new Map<string, FeedEvent>();
  for (const event of [...mailHistory].sort((a, b) => a.id - b.id))
    previousMail.set(event.dutyId, event);
  const cancelledEvents = new Map([...previousMail, ...latest]);
  const cancelled = [...cancelledEvents.values()]
    .filter(
      (event) => event.kind === "cancelled" && !activeIds.has(event.dutyId)
    )
    .map((event) => ({
      dutyId: event.dutyId,
      ...event.snapshot,
      highlighted: highlight.has(event.dutyId),
    }))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { current, cancelled };
}
