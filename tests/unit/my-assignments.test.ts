import { describe, expect, it } from "vitest";
import {
  assignmentDate,
  assignmentRange,
  personalAssignmentList,
  type FeedEvent,
  type PersonalAssignment,
} from "../../src/domain/my-assignments";

const row = (
  dutyId: string,
  start: string,
  end: string
): PersonalAssignment => ({
  dutyId,
  assignmentId: `assignment-${dutyId}`,
  name: dutyId,
  role: "תורן",
  location: "שער",
  start,
  end,
});
const event = (
  id: number,
  dutyId: string,
  kind: FeedEvent["kind"]
): FeedEvent => ({
  id,
  dutyId,
  kind,
  snapshot: row(dutyId, "2026-10-02T21:00:00Z", "2026-10-03T05:00:00Z"),
});
describe("personal assignment projection", () => {
  const now = "2026-10-02T20:00:00Z";
  it("shows only unfinished rows, sorted by their own execution period", () => {
    const list = personalAssignmentList(
      [
        row("later", "2026-10-04T08:00:00Z", "2026-10-04T16:00:00Z"),
        row("finished", "2026-10-01T08:00:00Z", "2026-10-01T16:00:00Z"),
        row("current", "2026-10-02T19:00:00Z", "2026-10-03T01:00:00Z"),
      ],
      [],
      now,
      ["current"]
    );
    expect(list.current.map((item) => item.dutyId)).toEqual([
      "current",
      "later",
    ]);
    expect(list.current[0]).toMatchObject({
      inProgress: true,
      highlighted: true,
    });
    expect(list.current[1]).toMatchObject({
      inProgress: false,
      highlighted: false,
    });
  });
  it("keeps a new badge through later updates and an updated badge on replacement", () => {
    const list = personalAssignmentList(
      [
        row("new", "2026-10-03T08:00:00Z", "2026-10-03T16:00:00Z"),
        row("replacement", "2026-10-03T09:00:00Z", "2026-10-03T16:00:00Z"),
      ],
      [
        event(1, "new", "new"),
        event(2, "new", "updated"),
        event(3, "replacement", "cancelled"),
        event(4, "replacement", "new"),
      ],
      now,
      []
    );
    expect(list.current.map((item) => [item.dutyId, item.badge])).toEqual([
      ["new", "new"],
      ["replacement", "updated"],
    ]);
    expect(list.cancelled).toEqual([]);
  });
  it("shows a removed assignment only until the next visit", () => {
    const list = personalAssignmentList(
      [],
      [event(1, "removed", "cancelled")],
      now,
      []
    );
    expect(list.cancelled.map((item) => item.dutyId)).toEqual(["removed"]);
    expect(personalAssignmentList([], [], now, []).cancelled).toEqual([]);
    expect(
      personalAssignmentList(
        [],
        [],
        now,
        ["removed"],
        [event(1, "removed", "cancelled")]
      ).cancelled
    ).toMatchObject([{ dutyId: "removed", highlighted: true }]);
  });
  it("uses Israel dates across midnight and distinguishes the repeated autumn hour", () => {
    expect(assignmentDate("2026-10-01T20:30:00Z")).toContain("01.10.2026");
    expect(assignmentDate("2026-10-01T21:30:00Z")).toContain("02.10.2026");
    const before = assignmentDate("2026-10-24T22:30:00Z");
    const after = assignmentDate("2026-10-24T23:30:00Z");
    expect(before).toContain("01:30");
    expect(after).toContain("01:30");
    expect(before).toContain("+3");
    expect(after).toContain("+2");
  });
  it("shows the offset only where the wall time is ambiguous", () => {
    // 08:00 Israel summer time, an ordinary hour.
    expect(assignmentDate("2026-10-09T05:00:00Z")).toBe("09.10.2026, 08:00");
    expect(assignmentDate("2026-10-09T05:00:00Z")).not.toContain("GMT");
    // 00:30 on the change night happens once: no offset.
    expect(assignmentDate("2026-10-24T21:30:00Z")).not.toContain("GMT");
  });
  it("names a one-day duty's date once and a longer one's twice", () => {
    expect(
      assignmentRange("2026-10-09T05:00:00Z", "2026-10-09T13:00:00Z")
    ).toBe("09.10.2026, 08:00–16:00");
    expect(
      assignmentRange("2026-10-09T15:00:00Z", "2026-10-10T05:00:00Z")
    ).toBe("09.10.2026, 18:00 – 10.10.2026, 08:00");
    // Across the repeated hour both ends carry their offsets.
    expect(
      assignmentRange("2026-10-24T22:30:00Z", "2026-10-24T23:30:00Z")
    ).toBe("25.10.2026, 01:30 (GMT+3) – 25.10.2026, 01:30 (GMT+2)");
  });
});
