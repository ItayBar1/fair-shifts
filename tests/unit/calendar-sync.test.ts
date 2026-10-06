import { describe, expect, it } from "vitest";
import {
  CALENDAR_SCOPE,
  calendarState,
  eventBody,
  eventFingerprint,
  eventId,
  futureEvents,
  grantsCalendar,
  planIsEmpty,
  planSync,
  retryDelay,
  wantedEvents,
  type DutyView,
  type RecordedEvent,
  type SeatView,
  type WantedEvent,
} from "../../src/domain/calendar-sync";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-20T08:00:00Z");
const SITE = "https://shifts.example.invalid/";

function duty(overrides: Partial<DutyView> = {}): DutyView {
  return {
    id: "d1",
    name: "שמירה בשער",
    status: "published",
    start: new Date(NOW + 24 * HOUR).toISOString(),
    end: new Date(NOW + 32 * HOUR).toISOString(),
    location: "שער ראשי",
    instructions: "להגיע עם ציוד מלא",
    ...overrides,
  };
}
function seat(overrides: Partial<SeatView> = {}): SeatView {
  return {
    id: "s1",
    dutyId: "d1",
    soldierId: "soldier-1",
    status: "reserved",
    ...overrides,
  };
}
const wanted = (
  duties: DutyView[],
  seats: SeatView[],
  reminderHours: number[] = [24, 2]
) =>
  wantedEvents({
    now: NOW,
    duties: new Map(duties.map((row) => [row.id, row])),
    seats,
    reminderHours,
    siteUrl: SITE,
  });

describe("calendar switch state (decision 195)", () => {
  it("is blocked without a Google link, asks for the permission without one, and otherwise follows the soldier's switch", () => {
    expect(calendarState({ googleLinked: false })).toBe("blocked");
    // The sign-in code never gives a permission, even when a link row exists from before.
    expect(
      calendarState({
        googleLinked: false,
        link: { state: "active", enabled: true },
      })
    ).toBe("blocked");
    expect(calendarState({ googleLinked: true })).toBe("needs_permission");
    expect(
      calendarState({
        googleLinked: true,
        link: { state: "needs_permission", enabled: true },
      })
    ).toBe("needs_permission");
    expect(
      calendarState({
        googleLinked: true,
        link: { state: "active", enabled: true },
      })
    ).toBe("on");
    expect(
      calendarState({
        googleLinked: true,
        link: { state: "active", enabled: false },
      })
    ).toBe("off");
  });
  it("sees the calendar permission only in the scopes Google returned", () => {
    expect(grantsCalendar(["openid", "email", CALENDAR_SCOPE])).toBe(true);
    expect(grantsCalendar(["openid", "email", "profile"])).toBe(false);
    expect(grantsCalendar(undefined)).toBe(false);
    expect(grantsCalendar([])).toBe(false);
    // Only the calendars the application itself created.
    expect(CALENDAR_SCOPE).toBe(
      "https://www.googleapis.com/auth/calendar.app.created"
    );
  });
});

describe("the event of a duty", () => {
  it("keeps published instructions as text rather than Google description HTML", () => {
    const body = eventBody(
      duty({
        instructions: '<img src="https://example.invalid/pixel"> & להגיע',
      }),
      { start: duty().start, end: duty().end },
      [],
      SITE
    );
    expect(body.description).toContain(
      '&lt;img src="https://example.invalid/pixel"&gt; &amp; להגיע'
    );
    expect(body.description).not.toContain("<img");
  });
  it("holds the name, location, instructions, a link to the duty and no score or other people", () => {
    const body = eventBody(
      duty(),
      { start: duty().start, end: duty().end },
      [24, 2],
      SITE
    );
    expect(body.summary).toBe("שמירה בשער");
    expect(body.location).toBe("שער ראשי");
    expect(body.description).toBe(
      "להגיע עם ציוד מלא\n\nלפרטי התורנות: https://shifts.example.invalid/duties/d1"
    );
    expect(Object.keys(body).sort()).toEqual([
      "description",
      "end",
      "location",
      "reminders",
      "start",
      "summary",
    ]);
    // A duty without instructions or location keeps only the link; an empty field clears the old one.
    const bare = eventBody(
      duty({ instructions: undefined, location: undefined }),
      { start: duty().start, end: duty().end },
      [],
      SITE
    );
    expect(bare.description).toBe(
      "לפרטי התורנות: https://shifts.example.invalid/duties/d1"
    );
    expect(bare.location).toBe("");
  });
  it("keeps the real instants in Israel time across midnight, several days and a clock change", () => {
    const zone = "Asia/Jerusalem";
    // Across midnight.
    const night = eventBody(
      duty(),
      { start: "2026-10-20T19:00:00Z", end: "2026-10-21T04:00:00Z" },
      [],
      SITE
    );
    expect(night.start).toEqual({
      dateTime: "2026-10-20T19:00:00.000Z",
      timeZone: zone,
    });
    expect(night.end.dateTime).toBe("2026-10-21T04:00:00.000Z");
    // Several days.
    const week = eventBody(
      duty(),
      { start: "2026-10-20T05:00:00Z", end: "2026-10-27T05:00:00Z" },
      [],
      SITE
    );
    expect(
      Date.parse(week.end.dateTime) - Date.parse(week.start.dateTime)
    ).toBe(7 * 24 * HOUR);
    // The night the clocks go forward (Israel, 27.03.2026 at 02:00): a duty from 22:00 to 08:00
    // local time lasts nine hours, and the offsets given in the input give the same instants.
    const spring = eventBody(
      duty(),
      {
        start: "2026-03-26T22:00:00+02:00",
        end: "2026-03-27T08:00:00+03:00",
      },
      [],
      SITE
    );
    expect(
      Date.parse(spring.end.dateTime) - Date.parse(spring.start.dateTime)
    ).toBe(9 * HOUR);
    expect(spring.start.timeZone).toBe(zone);
    // The night they go back (25.10.2026 at 02:00): the same local hours last eleven hours.
    const autumn = eventBody(
      duty(),
      {
        start: "2026-10-24T22:00:00+03:00",
        end: "2026-10-25T08:00:00+02:00",
      },
      [],
      SITE
    );
    expect(
      Date.parse(autumn.end.dateTime) - Date.parse(autumn.start.dateTime)
    ).toBe(11 * HOUR);
  });
  it("adds a popup for every reminder marked for the calendar, as whole minutes before the start", () => {
    const body = eventBody(
      duty(),
      { start: duty().start, end: duty().end },
      [2, 24, 168],
      SITE
    );
    expect(body.reminders).toEqual({
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 10_080 },
        { method: "popup", minutes: 1_440 },
        { method: "popup", minutes: 120 },
      ],
    });
    expect(
      eventBody(duty(), { start: duty().start, end: duty().end }, [], SITE)
        .reminders.overrides
    ).toEqual([]);
  });
  it("changes its fingerprint exactly when something the soldier sees changes", () => {
    const period = { start: duty().start, end: duty().end };
    const base = eventFingerprint(eventBody(duty(), period, [24, 2], SITE));
    expect(eventFingerprint(eventBody(duty(), period, [2, 24], SITE))).toBe(
      base
    );
    for (const changed of [
      eventBody(duty({ name: "אחר" }), period, [24, 2], SITE),
      eventBody(duty({ location: "אחר" }), period, [24, 2], SITE),
      eventBody(duty({ instructions: "אחר" }), period, [24, 2], SITE),
      eventBody(
        duty(),
        { start: period.start, end: new Date(NOW + 33 * HOUR).toISOString() },
        [24, 2],
        SITE
      ),
      eventBody(duty(), period, [24], SITE),
    ])
      expect(eventFingerprint(changed)).not.toBe(base);
  });
  it("derives one stable id of the characters Google accepts, new for each generation", () => {
    const first = eventId("account-1", "duty-1", 0);
    expect(first).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(eventId("account-1", "duty-1", 0)).toBe(first);
    expect(eventId("account-1", "duty-1", 1)).not.toBe(first);
    expect(eventId("account-1", "duty-2", 0)).not.toBe(first);
    expect(eventId("account-2", "duty-1", 0)).not.toBe(first);
  });
});

describe("which events a soldier should have", () => {
  it("covers a held seat of a published duty that has not ended", () => {
    const events = wanted([duty()], [seat()]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      dutyId: "d1",
      startsAt: NOW + 24 * HOUR,
      endsAt: NOW + 32 * HOUR,
    });
    // A seat in progress counts, and so does a held seat.
    const running = duty({
      start: new Date(NOW - HOUR).toISOString(),
      end: new Date(NOW + HOUR).toISOString(),
    });
    expect(wanted([running], [seat({ status: "held" })])).toHaveLength(1);
  });
  it("leaves out drafts, cancelled duties, other seats, ended duties and duties not loaded", () => {
    expect(wanted([duty({ status: "draft" })], [seat()])).toEqual([]);
    expect(wanted([duty({ status: "cancelled" })], [seat()])).toEqual([]);
    for (const status of ["cancelled", "credited"] as const)
      expect(wanted([duty()], [seat({ status })])).toEqual([]);
    expect(
      wanted(
        [
          duty({
            start: new Date(NOW - 9 * HOUR).toISOString(),
            end: new Date(NOW - HOUR).toISOString(),
          }),
        ],
        [seat()]
      )
    ).toEqual([]);
    expect(wanted([], [seat()])).toEqual([]);
  });
  it("gives each performer of a split seat the period they perform (decision 183)", () => {
    // Two soldiers share one seat: each one's events are computed from that one's own seat.
    const first = wanted(
      [duty()],
      [
        seat({
          id: "first",
          soldierId: "soldier-1",
          performedStart: new Date(NOW + 24 * HOUR).toISOString(),
          performedEnd: new Date(NOW + 28 * HOUR).toISOString(),
        }),
      ]
    );
    const second = wanted(
      [duty()],
      [
        seat({
          id: "second",
          soldierId: "soldier-2",
          performedStart: new Date(NOW + 28 * HOUR).toISOString(),
          performedEnd: new Date(NOW + 32 * HOUR).toISOString(),
        }),
      ]
    );
    expect(first.map((event) => [event.startsAt, event.endsAt])).toEqual([
      [NOW + 24 * HOUR, NOW + 28 * HOUR],
    ]);
    expect(second.map((event) => [event.startsAt, event.endsAt])).toEqual([
      [NOW + 28 * HOUR, NOW + 32 * HOUR],
    ]);
    // A period that already ended is not added any more.
    expect(
      wanted(
        [duty()],
        [
          seat({
            performedStart: new Date(NOW - 5 * HOUR).toISOString(),
            performedEnd: new Date(NOW - HOUR).toISOString(),
          }),
        ]
      )
    ).toEqual([]);
  });
  it("makes one event per duty, whichever rows the seat has: a changed duty gets new assignment rows", () => {
    // Update and publish cancels the rows and makes new ones for the same soldier and duty.
    expect(
      wanted(
        [duty()],
        [
          seat({ id: "old", status: "cancelled" }),
          seat({ id: "new" }),
          seat({ id: "newer", status: "held" }),
        ]
      )
    ).toHaveLength(1);
  });
  it("orders by start so that a repeated run acts in the same order", () => {
    const later = duty({
      id: "d2",
      start: new Date(NOW + 48 * HOUR).toISOString(),
      end: new Date(NOW + 56 * HOUR).toISOString(),
    });
    const events = wanted(
      [later, duty()],
      [seat({ id: "b", dutyId: "d2" }), seat({ id: "a" })]
    );
    expect(events.map((event) => event.dutyId)).toEqual(["d1", "d2"]);
  });
});

describe("what to change in Google", () => {
  const event = (
    id: string,
    extra: Partial<WantedEvent> = {}
  ): WantedEvent => ({
    dutyId: id,
    body: eventBody(
      duty(),
      { start: duty().start, end: duty().end },
      [24],
      SITE
    ),
    fingerprint: `f-${id}`,
    startsAt: NOW + 24 * HOUR,
    endsAt: NOW + 32 * HOUR,
    ...extra,
  });
  const row = (
    id: string,
    extra: Partial<RecordedEvent> = {}
  ): RecordedEvent => ({
    dutyId: id,
    status: "synced",
    generation: 0,
    fingerprint: `f-${id}`,
    startsAt: NOW + 24 * HOUR,
    endsAt: NOW + 32 * HOUR,
    ...extra,
  });

  it("creates what is missing, updates what changed, and leaves the rest", () => {
    const plan = planSync(
      [event("new"), event("same"), event("changed", { fingerprint: "other" })],
      [row("same"), row("changed")],
      NOW
    );
    expect(plan.create.map((entry) => entry.event.dutyId)).toEqual(["new"]);
    expect(plan.create[0].generation).toBe(0);
    expect(plan.update.map((entry) => entry.dutyId)).toEqual(["changed"]);
    expect(plan.remove).toEqual([]);
    expect(planIsEmpty(planSync([event("same")], [row("same")], NOW))).toBe(
      true
    );
  });
  it("retries an uncertain insert under the same id, and deletes it if its duty no longer applies", () => {
    const pending = row("pending", { status: "pending", generation: 3 });
    expect(planSync([event("pending")], [pending], NOW).create).toMatchObject([
      { generation: 3 },
    ]);
    expect(planSync([], [pending], NOW).remove).toEqual([pending]);
    expect(futureEvents([pending], NOW)).toEqual([pending]);
  });
  it("removes an event that no longer applies, and leaves one that ended as history", () => {
    const plan = planSync(
      [],
      [row("gone"), row("over", { endsAt: NOW - HOUR })],
      NOW
    );
    expect(plan.remove.map((entry) => entry.dutyId)).toEqual(["gone"]);
    expect(
      planIsEmpty(planSync([], [row("over", { endsAt: NOW - HOUR })], NOW))
    ).toBe(true);
  });
  it("never brings back an event the soldier deleted, and only a new seat gets a new one (decision 195)", () => {
    const deleted = row("s1", {
      status: "removed_by_user",
      fingerprint: "old",
    });
    // The duty changed afterwards: still nothing.
    expect(
      planIsEmpty(
        planSync([event("s1", { fingerprint: "new" })], [deleted], NOW)
      )
    ).toBe(true);
    // The seat goes away: no call to Google for an event that is not there.
    expect(planSync([], [deleted], NOW).remove).toEqual([]);
    // A new seat is a new row.
    expect(
      planSync([event("s1"), event("s2")], [deleted], NOW).create.map(
        (entry) => entry.event.dutyId
      )
    ).toEqual(["s2"]);
  });
  it("creates an event we removed ourselves again under the next generation", () => {
    const removed = row("s1", { status: "removed", generation: 2 });
    expect(planSync([event("s1")], [removed], NOW).create).toMatchObject([
      { generation: 3 },
    ]);
    // Not wanted and still to come: the record stays, for the generation.
    const idle = planSync([], [removed], NOW);
    expect(planIsEmpty(idle)).toBe(true);
    // Ended records stay too: generation and deletion tombstones survive an extension.
    expect(
      planIsEmpty(planSync([], [{ ...removed, endsAt: NOW - HOUR }], NOW))
    ).toBe(true);
  });
  it("offers the removal button only the events that have not started", () => {
    const rows = [
      row("future"),
      row("running", { startsAt: NOW - HOUR }),
      row("over", { startsAt: NOW - 9 * HOUR, endsAt: NOW - HOUR }),
      row("deleted", { status: "removed_by_user" }),
    ];
    expect(futureEvents(rows, NOW).map((entry) => entry.dutyId)).toEqual([
      "future",
    ]);
  });
  it("waits a minute after the first failure, longer after each, up to six hours, and never less than Google asks", () => {
    expect(retryDelay(1)).toBe(60_000);
    expect(retryDelay(2)).toBe(5 * 60_000);
    expect(retryDelay(6)).toBe(6 * HOUR);
    expect(retryDelay(40)).toBe(6 * HOUR);
    expect(retryDelay(1, 30 * 60_000)).toBe(30 * 60_000);
    expect(retryDelay(0)).toBe(60_000);
  });
});
