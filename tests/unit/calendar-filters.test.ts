import { describe, expect, it } from "vitest";
import {
  calendarBoard,
  selectCalendarCard,
  vacantSeats,
  type CalendarControls,
} from "../../src/client/calendar-filters";
import { type Row } from "../../src/client/types";

const duties: Row[] = [
  {
    id: "past",
    name: "שמירה עבר",
    status: "published",
    start: "2026-10-01T08:00:00+03:00",
    end: "2026-10-01T16:00:00+03:00",
    slots: [{ id: "past-seat" }],
  },
  {
    id: "mine",
    name: "שמירה שלי",
    status: "published",
    start: "2026-10-20T08:00:00+03:00",
    end: "2026-10-20T16:00:00+03:00",
    slots: [{ id: "mine-seat" }],
  },
  {
    id: "vacant",
    name: "מטווח",
    status: "published",
    start: "2026-10-21T08:00:00+03:00",
    end: "2026-10-21T16:00:00+03:00",
    slots: [{ id: "v1" }, { id: "v2" }, { id: "v3" }],
  },
  {
    id: "next",
    name: "שמירה הבאה",
    status: "published",
    start: "2026-11-02T08:00:00+02:00",
    end: "2026-11-02T16:00:00+02:00",
    slots: [{ id: "next-seat" }],
  },
  {
    id: "cancelled",
    name: "שמירה בוטלה",
    status: "cancelled",
    wasPublished: true,
    start: "2026-10-22T08:00:00+03:00",
    end: "2026-10-22T16:00:00+03:00",
    slots: [{ id: "cancelled-seat" }],
  },
  {
    id: "draft",
    name: "שמירה טיוטה",
    status: "draft",
    start: "2026-10-23T08:00:00+03:00",
    end: "2026-10-23T16:00:00+03:00",
    slots: [{ id: "draft-seat" }],
  },
];
const assignments: Row[] = [
  {
    id: "a1",
    dutyId: "mine",
    slotId: "mine-seat",
    soldierId: "me",
    status: "reserved",
  },
  {
    id: "a2",
    dutyId: "past",
    slotId: "past-seat",
    soldierId: "me",
    status: "credited",
  },
  {
    id: "a3",
    dutyId: "vacant",
    slotId: "v1",
    soldierId: "other",
    status: "reserved",
    performedStart: "2026-10-21T08:00:00+03:00",
  },
  {
    id: "a4",
    dutyId: "vacant",
    slotId: "v1",
    soldierId: "third",
    status: "reserved",
    performedStart: "2026-10-21T12:00:00+03:00",
  },
  {
    id: "a5",
    dutyId: "vacant",
    slotId: "v2",
    soldierId: "me",
    status: "cancelled",
  },
  {
    id: "a6",
    dutyId: "vacant",
    slotId: "v3",
    soldierId: "me",
    status: "transferred",
  },
];
const normal: CalendarControls = { mode: "month", onlyMine: false };
const board = (
  controls = normal,
  query = "",
  now = "2026-10-15T12:00:00+03:00",
  data = duties
) =>
  calendarBoard({
    duties: data,
    assignments,
    soldierId: "me",
    month: { year: 2026, month: 10 },
    query,
    controls,
    now,
  });
const ids = (result: ReturnType<typeof board>) =>
  result.displayed.map((d) => d.id);

describe("calendar summary cards", () => {
  it("counts exactly the selected month and keeps cancellations only in the regular view", () => {
    expect(board().counts).toEqual({
      month: 3,
      mine: 2,
      upcoming: 2,
      vacant: 2,
    });
    expect(ids(board())).toEqual(["past", "mine", "vacant", "cancelled"]);
    const monthly = board(selectCalendarCard(normal, "month"));
    expect(ids(monthly)).toEqual(["past", "mine", "vacant"]);
    expect(monthly.displayed).toHaveLength(monthly.counts.month);
  });
  it("uses the same search for cards and results, while the month card restores unit scope", () => {
    const mine = selectCalendarCard(normal, "mine");
    expect(ids(board(mine, "שמירה"))).toEqual(["past", "mine"]);
    expect(board(mine, "שמירה").counts.mine).toBe(2);
    const monthly = selectCalendarCard(mine, "month");
    expect(monthly.onlyMine).toBe(false);
    expect(ids(board(monthly, "מטווח"))).toEqual(["vacant"]);
    expect(board(monthly, "מטווח").counts.month).toBe(1);
  });
  it("upcoming honors personal scope and excludes a duty at its exact end", () => {
    const upcoming = selectCalendarCard(
      { mode: "list", onlyMine: true },
      "upcoming"
    );
    expect(ids(board(upcoming))).toEqual(["mine"]);
    expect(board(upcoming).counts.upcoming).toBe(1);
    expect(ids(board(upcoming, "", "2026-10-20T16:00:00+03:00"))).toEqual([]);
  });
  it("counts vacant seats once even when several execution periods share a seat", () => {
    expect(vacantSeats(duties[2], assignments)).toBe(2);
    const vacant = board(selectCalendarCard(normal, "vacant"));
    expect(ids(vacant)).toEqual(["vacant"]);
    expect(vacant.counts.vacant).toBe(2);
  });
  it("restores the original scope and view after repeated or switched cards", () => {
    const original: CalendarControls = { mode: "month", onlyMine: true };
    const monthly = selectCalendarCard(original, "month");
    expect(selectCalendarCard(monthly, "month")).toEqual(original);
    const upcoming = selectCalendarCard(monthly, "upcoming");
    expect(selectCalendarCard(upcoming, "upcoming")).toEqual(original);
  });
  it("returns matching zero counts for a search without results", () => {
    const empty = board(selectCalendarCard(normal, "mine"), "אין כזה");
    expect(empty.counts).toEqual({ month: 0, mine: 0, upcoming: 0, vacant: 0 });
    expect(empty.displayed).toEqual([]);
  });
  it("uses Israeli month boundaries for cards as well as the calendar", () => {
    const midnight = [
      {
        id: "boundary",
        name: "חצות",
        status: "published",
        start: "2026-09-30T21:00:00Z",
        end: "2026-09-30T22:00:00Z",
      },
    ];
    expect(
      board(normal, "", "2026-09-30T20:00:00Z", midnight).counts.month
    ).toBe(1);
    expect(
      board(normal, "", "2026-09-30T20:00:00Z", [
        {
          ...midnight[0],
          start: "2026-09-30T19:00:00Z",
          end: "2026-09-30T21:00:00Z",
        },
      ]).counts.month
    ).toBe(0);
  });
});
