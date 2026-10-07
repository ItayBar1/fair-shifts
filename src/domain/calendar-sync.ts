import { createHash } from "node:crypto";
import { executionPeriod } from "./execution";
import { UNIT_ZONE } from "./time";
import type { Assignment, Duty } from "./types";

/**
 * Duties in the soldier's Google calendar (decision 195). The rules here are pure:
 * the server reads the state, these functions say which events the soldier should
 * have, how each looks and what to change. The sync compares the wanted events with
 * the ones it recorded, so a repeated or concurrent run reaches the same result and
 * no path that changes a duty or a seat needs a hook of its own.
 */

/** The only permission requested: a secondary calendar the application creates and owns. */
export const CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.app.created";
export const CALENDAR_NAME = "תורנויות";
export const CALENDAR_ZONE = UNIT_ZONE;

/** A seat that still expects the soldier at the duty. */
export const ACTIVE_SEATS: readonly string[] = ["reserved", "held"];

export type CalendarState = "blocked" | "needs_permission" | "on" | "off";

/**
 * The state of the switch on the settings screen: blocked for an account that never
 * signed in with Google, a button to grant the permission when there is none, and
 * on or off once the permission is held.
 */
export function calendarState(input: {
  googleLinked: boolean;
  link?: { state: string; enabled: boolean } | null;
}): CalendarState {
  if (!input.googleLinked) return "blocked";
  if (!input.link || input.link.state !== "active") return "needs_permission";
  return input.link.enabled ? "on" : "off";
}

/** Whether the sign-in granted the calendar permission, from the scopes Google returned. */
export function grantsCalendar(scopes: readonly string[] | undefined | null) {
  return Boolean(scopes?.includes(CALENDAR_SCOPE));
}

export type DutyView = Pick<
  Duty,
  "id" | "name" | "status" | "start" | "end" | "location" | "instructions"
>;
export type SeatView = Pick<
  Assignment,
  "id" | "dutyId" | "soldierId" | "status" | "performedStart" | "performedEnd"
> &
  Partial<Pick<Assignment, "performance">>;

export type CalendarEventBody = {
  summary: string;
  description: string;
  location: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  reminders: {
    useDefault: false;
    overrides: { method: "popup"; minutes: number }[];
  };
};

/**
 * One event per soldier and duty. A duty that is updated and published gets new
 * assignment rows, so the seat cannot be told by its row: it is told by the duty,
 * and a soldier holds at most one active seat in a duty.
 */
export type WantedEvent = {
  dutyId: string;
  body: CalendarEventBody;
  fingerprint: string;
  startsAt: number;
  endsAt: number;
};

/**
 * What the soldier sees in the event: the duty name, the times in Israel time, the
 * location and the published instructions, a link to the duty page, and a popup for
 * every reminder marked for the calendar. No score, no other people (decision 195).
 */
export function eventBody(
  duty: DutyView,
  period: { start: string; end: string },
  reminderHours: readonly number[],
  siteUrl: string
): CalendarEventBody {
  const link = `${siteUrl.replace(/\/+$/, "")}/duties/${duty.id}`;
  // Google treats descriptions as HTML; published plain text must stay text there too.
  const text = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    summary: duty.name,
    description: [duty.instructions?.trim(), `לפרטי התורנות: ${link}`]
      .filter(Boolean)
      .map((value) => text(value!))
      .join("\n\n"),
    location: duty.location?.trim() ?? "",
    // Instants with the unit's zone: a duty across midnight or a clock change keeps its real length.
    start: {
      dateTime: new Date(period.start).toISOString(),
      timeZone: CALENDAR_ZONE,
    },
    end: {
      dateTime: new Date(period.end).toISOString(),
      timeZone: CALENDAR_ZONE,
    },
    reminders: {
      useDefault: false,
      overrides: [...reminderHours]
        .sort((a, b) => b - a)
        .map((hours) => ({ method: "popup" as const, minutes: hours * 60 })),
    },
  };
}

export function eventFingerprint(body: CalendarEventBody) {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/**
 * The id of the Google event of a soldier's duty. Google accepts ids of the characters
 * 0-9 and a-v, so the same duty always maps to the same id and a create that ran twice
 * is answered with a conflict instead of a second event. A generation separates an
 * event from one we removed earlier, because Google never reuses a deleted id.
 */
export function eventId(accountId: string, dutyId: string, generation: number) {
  return createHash("sha256")
    .update(`fair-shifts:${accountId}:${dutyId}:${generation}`)
    .digest("hex");
}

/**
 * The events a soldier should have: a seat held in a published duty that has not ended,
 * one per duty. A seat split into execution periods (decision 183) is the period its
 * holder performs. A draft, a cancelled duty or a seat that moved away has none.
 */
export function wantedEvents(input: {
  now: number;
  duties: ReadonlyMap<string, DutyView>;
  seats: readonly SeatView[];
  reminderHours: readonly number[];
  siteUrl: string;
  /** Only the reconciler uses this to finish an event it already created; never create a past one. */
  includeEnded?: boolean;
}): WantedEvent[] {
  const wanted = new Map<string, WantedEvent>();
  for (const seat of input.seats) {
    const duty = input.duties.get(seat.dutyId);
    if (
      !duty ||
      wanted.has(duty.id) ||
      duty.status !== "published" ||
      !(
        ACTIVE_SEATS.includes(seat.status) ||
        (input.includeEnded && seat.status === "credited")
      )
    )
      continue;
    const period = executionPeriod(seat, duty);
    const startsAt = Date.parse(period.start);
    const endsAt = Date.parse(period.end);
    if (!(endsAt > startsAt) || (!input.includeEnded && endsAt <= input.now))
      continue;
    const body = eventBody(duty, period, input.reminderHours, input.siteUrl);
    wanted.set(duty.id, {
      dutyId: duty.id,
      body,
      fingerprint: eventFingerprint(body),
      startsAt,
      endsAt,
    });
  }
  return [...wanted.values()].sort(
    (a, b) => a.startsAt - b.startsAt || a.dutyId.localeCompare(b.dutyId)
  );
}

/**
 * One recorded event: a live one, one the soldier deleted in Google, or one the sync
 * removed itself. The last two keep the id used, because Google never reuses a deleted
 * id, so a later event for the same seat takes the next generation.
 */
export type RecordedEvent = {
  dutyId: string;
  status: "pending" | "synced" | "removed_by_user" | "removed";
  generation: number;
  fingerprint: string;
  startsAt: number;
  endsAt: number;
};

export type SyncPlan = {
  create: { event: WantedEvent; generation: number }[];
  update: WantedEvent[];
  /** Events that no longer apply and have not ended: deleted in Google. */
  remove: RecordedEvent[];
};

/**
 * Compares what the soldier should have with what was recorded. An event the soldier
 * deleted stays deleted (decision 195): a duty changed and published again does not
 * bring it back, and only a new duty gets a new event. An event that ended is left in
 * the calendar as history.
 */
export function planSync(
  wanted: readonly WantedEvent[],
  recorded: readonly RecordedEvent[],
  now: number
): SyncPlan {
  const plan: SyncPlan = { create: [], update: [], remove: [] };
  const byDuty = new Map(recorded.map((row) => [row.dutyId, row]));
  const wantedIds = new Set(wanted.map((event) => event.dutyId));
  for (const event of wanted) {
    const row = byDuty.get(event.dutyId);
    if (!row) plan.create.push({ event, generation: 0 });
    else if (row.status === "pending")
      plan.create.push({ event, generation: row.generation });
    else if (row.status === "removed")
      plan.create.push({ event, generation: row.generation + 1 });
    else if (row.status === "synced" && row.fingerprint !== event.fingerprint)
      plan.update.push(event);
  }
  for (const row of recorded) {
    if (wantedIds.has(row.dutyId)) continue;
    if (
      row.endsAt > now &&
      (row.status === "synced" || row.status === "pending")
    )
      plan.remove.push(row);
  }
  return plan;
}

export function planIsEmpty(plan: SyncPlan) {
  return !plan.create.length && !plan.update.length && !plan.remove.length;
}

/**
 * The button "remove the future duties from the calendar" (decision 195): events that
 * have not started. One that is running stays, like the ones that ended.
 */
export function futureEvents<T extends { startsAt: number; status: string }>(
  recorded: readonly T[],
  now: number
) {
  return recorded.filter(
    (row) =>
      (row.status === "synced" || row.status === "pending") &&
      row.startsAt > now
  );
}

const RETRY_STEPS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 3_600_000,
  6 * 3_600_000,
];
/**
 * How long to wait after the given number of failed runs in a row: a minute at first,
 * growing to six hours. A provider that names a time (429 or 503) is never asked earlier.
 */
export function retryDelay(attempts: number, retryAfterMs = 0) {
  const step =
    RETRY_STEPS[Math.min(Math.max(attempts, 1), RETRY_STEPS.length) - 1];
  return Math.max(step, retryAfterMs);
}

/** The one site notice a soldier gets when the permission is gone (decision 195). */
export const permissionLostNotice = {
  title: "נדרשת הרשאה מחדש ליומן Google",
  body: "הוספת התורנויות ליומן Google הופסקה, כי ההרשאה בוטלה או פגה. אפשר לאשר אותה מחדש במסך ההעדפות, ואז התורנויות יחזרו ליומן.",
  href: "/settings",
};
