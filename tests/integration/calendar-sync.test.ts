import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import { account, operationsState, user } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  calendarEvent,
  calendarLink,
  duties,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  applyVerifiedEmailChange,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import { openSecret } from "../../src/server/operations/email";
import {
  recordGoogleGrant,
  settleCalendarCleanups,
  scheduleCalendarCleanup,
  type CalendarCleanup,
} from "../../src/server/calendar/link";
import { runCalendarSync } from "../../src/server/calendar/sync";
import { eraseSoldier } from "../../src/server/soldier-deletion";
import {
  CALENDAR_SCOPE,
  permissionLostNotice,
} from "../../src/domain/calendar-sync";
import { FakeGoogle } from "../google-fake";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

process.env.GOOGLE_CALENDAR_SYNC = "true";
const google = new FakeGoogle();
google.install();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
let manager: Actor;
let member: Actor;
let other: Actor;

async function invite(
  name: string,
  role: "soldier" | "manager",
  personalNumber: string
): Promise<Actor> {
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber,
    data: soldier({ id, name, personalNumber }),
  });
  const email = `${personalNumber}@example.invalid`;
  await db.insert(soldierContacts).values({ soldierId: id, email });
  await db.insert(balances).values({ soldierId: id });
  const row = await createInvitedAccount({ name, role, email, soldierId: id });
  return { id: row.id, name, role, soldierId: id, securityEpoch: 1 };
}
async function command(
  actor: Actor,
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) {
  if (type.startsWith("calendar.") && expectedVersion === undefined) {
    expectedVersion = (
      await db
        .select()
        .from(calendarLink)
        .where(eq(calendarLink.accountId, actor.id))
    )[0]?.version;
  }
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as { id: string; version: number } & Record<string, unknown>;
}
const dutyRow = async (id: string) =>
  (await db.select().from(duties).where(eq(duties.id, id)))[0];
const recordRow = async (id: string) =>
  (await db.select().from(records).where(eq(records.id, id)))[0];

/** A published duty with the given holders, one seat each, starting after `startsIn`. */
async function publishedDuty(
  holders: Actor[],
  options: {
    startsIn?: number;
    hours?: number;
    name?: string;
    location?: string;
    instructions?: string;
    publish?: boolean;
    /** Priced by the day, as a seat that is split into periods must be. */
    daily?: boolean;
  } = {}
) {
  const type = await command(manager, "dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode: options.daily ? "daily" : "fixed", base: 4 },
    roles: [{ name: "תורן", count: holders.length }],
  });
  const start = Date.now() + (options.startsIn ?? 24 * HOUR);
  const duty = await command(manager, "duty.create", {
    typeId: type.id,
    name: options.name ?? "שמירה סינתטית",
    location: options.location ?? "שער ראשי",
    instructions: options.instructions ?? "להגיע עם ציוד מלא",
    start: new Date(start).toISOString(),
    end: new Date(start + (options.hours ?? 8) * HOUR).toISOString(),
  });
  const row = await dutyRow(duty.id);
  let version = 1;
  for (const [index, holder] of holders.entries())
    await command(
      manager,
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[index].id,
        soldierId: holder.soldierId,
      },
      version++
    );
  if (options.publish !== false)
    await command(
      manager,
      "duty.publish",
      { id: row.id, confirmed: true },
      version
    );
  return { id: row.id, start, slots: row.data.slots.map((slot) => slot.id) };
}

/** "Update and publish": the published duty gets the given fields. */
async function updateAndPublish(
  dutyId: string,
  changes: Record<string, unknown>
) {
  const row = await dutyRow(dutyId);
  const change = await command(
    manager,
    "duty.change.create",
    { dutyId, reason: "עדכון סינתטי" },
    row.version
  );
  const proposal = await recordRow(change.id);
  await command(
    manager,
    "duty.change.save",
    {
      id: change.id,
      name: row.data.name,
      start: row.data.start,
      end: row.data.end,
      location: row.data.location,
      instructions: row.data.instructions,
      reason: "עדכון סינתטי",
      seats: proposal.data.seats,
      ...changes,
    },
    proposal.version
  );
  const saved = await recordRow(change.id);
  const preview = await command(
    manager,
    "duty.change.preview",
    { id: change.id },
    saved.version
  );
  await command(
    manager,
    "duty.change.publish",
    { id: change.id, confirmed: true, previewToken: preview.previewToken },
    (await recordRow(change.id)).version
  );
}

/** The soldier signed in with Google and granted the calendar permission. */
async function connect(
  actor: Actor,
  token = `refresh-${actor.id.slice(0, 8)}`
) {
  await db.insert(account).values({
    id: randomUUID(),
    userId: actor.id,
    accountId: `sub-${actor.id}`,
    providerId: "google",
    proofEpoch: actor.securityEpoch,
    googleLinkGeneration: 1,
    needsEmailVerification: false,
  });
  google.grant(token);
  await recordGoogleGrant(actor.id, {
    scopes: ["openid", "email", CALENDAR_SCOPE],
    refreshToken: token,
  });
  return token;
}
/** The soldier granted it again: a new sign-in with Google, which brings a new refresh token. */
async function connectAgain(actor: Actor, token: string) {
  google.grant(token);
  await recordGoogleGrant(actor.id, {
    scopes: ["openid", "email", CALENDAR_SCOPE],
    refreshToken: token,
  });
  return token;
}
const link = async (actor: Actor) =>
  (
    await db
      .select()
      .from(calendarLink)
      .where(eq(calendarLink.accountId, actor.id))
  )[0];
const recorded = (actor: Actor) =>
  db.select().from(calendarEvent).where(eq(calendarEvent.accountId, actor.id));
type EventView = {
  id: string;
  summary: string;
  location: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  reminders: {
    useDefault: boolean;
    overrides: { method: string; minutes: number }[];
  };
};
/** The live events in the soldier's own calendar. */
async function eventsOf(actor: Actor) {
  const row = await link(actor);
  return (row?.calendarId
    ? google.live(row.calendarId)
    : []) as unknown as EventView[];
}
/** A run a few seconds ahead: the schedule columns use the database clock. */
const sync = (ahead = 5_000) => runCalendarSync(new Date(Date.now() + ahead));
const noticesOf = async (actor: Actor) =>
  (
    await db.select().from(records).where(eq(records.kind, "notification"))
  ).filter(
    (row) =>
      row.data.accountId === actor.id &&
      row.data.title === permissionLostNotice.title
  );

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  google.reset();
  process.env.GOOGLE_CALENDAR_SYNC = "true";
  delete process.env.RESTORE_MODE;
  manager = await invite("אחראי לבדיקה", "manager", "00902");
  member = await invite("חייל לבדיקה", "soldier", "00901");
  other = await invite("חייל נוסף", "soldier", "00903");
});
afterEach(async () => {
  await settleCalendarCleanups();
  vi.restoreAllMocks();
});
afterAll(async () => pool.end());

describe("duties in the soldier's calendar", () => {
  it("creates the calendar once, and one event per published seat with only what the soldier sees", async () => {
    const duty = await publishedDuty([member, other], {
      location: "שער ראשי",
      instructions: "להגיע עם ציוד מלא",
    });
    // A draft the soldier is assigned to is not an event: the soldier cannot see drafts.
    await publishedDuty([member], {
      publish: false,
      name: "טיוטה סינתטית",
      startsIn: 72 * HOUR,
    });
    await connect(member);

    const result = await sync();
    expect(result).toMatchObject({ accounts: 1, created: 1 });
    expect(google.calendars.size).toBe(1);
    expect(google.calendar()).toMatchObject({
      summary: "תורנויות",
      timeZone: "Asia/Jerusalem",
    });
    const events = await eventsOf(member);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      summary: "שמירה סינתטית",
      location: "שער ראשי",
      start: {
        dateTime: new Date(duty.start).toISOString(),
        timeZone: "Asia/Jerusalem",
      },
      end: {
        dateTime: new Date(duty.start + 8 * HOUR).toISOString(),
        timeZone: "Asia/Jerusalem",
      },
    });
    expect(event.description).toContain("להגיע עם ציוד מלא");
    expect(event.description).toContain(
      `http://localhost:3000/duties/${duty.id}`
    );
    // No score and no other person: the other soldier holds the second seat of this duty.
    const text = JSON.stringify(event);
    expect(text).not.toContain(other.name);
    expect(text).not.toContain(other.soldierId!);
    expect(text).not.toContain("points");
    expect(await recorded(member)).toMatchObject([
      { status: "synced", dutyId: duty.id },
    ]);

    // A second run only checks permission/calendar health; it changes no event.
    const calls = google.calls.length;
    expect(await sync()).toMatchObject({ accounts: 0 });
    expect(
      google.calls
        .slice(calls)
        .every((call) => ["refresh", "getCalendar"].includes(call.kind))
    ).toBe(true);
  });

  it("has nothing for a soldier who never granted the permission, a duty manager, or a draft", async () => {
    await publishedDuty([member]);
    expect(await sync()).toMatchObject({ accounts: 0 });
    expect(google.calls).toHaveLength(0);
    // A manager takes no seat (decision 192), so no link is made for one.
    await recordGoogleGrant(manager.id, {
      scopes: [CALENDAR_SCOPE],
      refreshToken: "refresh-manager",
    });
    expect(await link(manager)).toBeUndefined();
  });

  it("updates the event when the duty is updated and published, and removes it when the duty is cancelled", async () => {
    const duty = await publishedDuty([member]);
    await connect(member);
    await sync();
    const [first] = await eventsOf(member);
    expect(google.calls.filter((call) => call.kind === "get")).toHaveLength(0);

    await updateAndPublish(duty.id, {
      location: "מוצב צפוני",
      instructions: "הנחיות מעודכנות",
    });
    expect(await sync()).toMatchObject({ updated: 1, created: 0 });
    const events = await eventsOf(member);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: first.id,
      location: "מוצב צפוני",
    });
    expect(String(events[0].description)).toContain("הנחיות מעודכנות");
    // The soldier's own deletion is looked for before an update writes.
    expect(google.count("get")).toBe(1);

    await command(
      manager,
      "duty.cancel",
      { id: duty.id, reason: "ביטול סינתטי", confirmed: true },
      (await dutyRow(duty.id)).version
    );
    expect(await sync()).toMatchObject({ removed: 1 });
    expect(await eventsOf(member)).toEqual([]);
    expect(await recorded(member)).toMatchObject([{ status: "removed" }]);
  });

  it("moves the event with the seat when the duty is transferred by consent", async () => {
    const duty = await publishedDuty([member]);
    await connect(member);
    await connect(other);
    await sync();
    expect(await eventsOf(member)).toHaveLength(1);
    expect(await eventsOf(other)).toEqual([]);

    const [seat] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.dutyId, duty.id));
    const offer = await command(
      member,
      "transfer.offer",
      { assignmentId: seat.id, candidateIds: [other.soldierId] },
      seat.version
    );
    await command(
      other,
      "transfer.respond",
      { id: offer.id, decision: "accept", confirmed: true },
      offer.version
    );
    expect(await sync()).toMatchObject({ created: 1, removed: 1 });
    expect(await eventsOf(member)).toEqual([]);
    expect(await eventsOf(other)).toHaveLength(1);
    // Two soldiers, two calendars: nothing of one is in the other.
    expect(google.calendars.size).toBe(2);
  });

  it("swaps the events of two soldiers when their duties are swapped by consent", async () => {
    const first = await publishedDuty([member], { name: "ראשונה" });
    const second = await publishedDuty([other], {
      name: "שנייה",
      startsIn: 48 * HOUR,
    });
    await connect(member);
    await connect(other);
    await sync();
    const names = async (actor: Actor) =>
      (await eventsOf(actor)).map((event) => event.summary);
    expect(await names(member)).toEqual(["ראשונה"]);
    expect(await names(other)).toEqual(["שנייה"]);

    const [seatA] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.dutyId, first.id));
    const [seatB] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.dutyId, second.id));
    const offer = await command(
      member,
      "swap.offer",
      { assignmentId: seatA.id, targetAssignmentIds: [seatB.id] },
      seatA.version
    );
    // The original seats stand until the swap is complete, and so do the events.
    await sync();
    expect(await names(member)).toEqual(["ראשונה"]);
    await command(
      other,
      "swap.respond",
      {
        id: offer.id,
        assignmentId: seatB.id,
        decision: "accept",
        confirmed: true,
      },
      (await recordRow(offer.id)).version
    );
    expect(await sync()).toMatchObject({ created: 2, removed: 2 });
    expect(await names(member)).toEqual(["שנייה"]);
    expect(await names(other)).toEqual(["ראשונה"]);
  });

  it("gives each performer of a seat split into execution periods the event of their own period", async () => {
    const duty = await publishedDuty([member], {
      startsIn: 2 * HOUR,
      hours: 10,
      daily: true,
    });
    await connect(member);
    await connect(other);
    // The duty is running: it began an hour ago and the first part ends in four hours.
    const row = await dutyRow(duty.id);
    const start = Date.now() - HOUR;
    const end = Date.parse(row.data.end);
    await db
      .update(duties)
      .set({ data: { ...row.data, start: new Date(start).toISOString() } })
      .where(eq(duties.id, duty.id));
    const handover = Date.now() + 4 * HOUR;
    const payload = {
      dutyId: duty.id,
      slotId: duty.slots[0],
      reason: "חילוף באמצע התורנות",
      segments: [
        {
          soldierId: member.soldierId,
          start: new Date(start).toISOString(),
          end: new Date(handover).toISOString(),
        },
        {
          soldierId: other.soldierId,
          start: new Date(handover).toISOString(),
          end: new Date(end).toISOString(),
        },
      ],
    };
    const preview = await command(manager, "execution.preview", payload);
    await command(manager, "execution.apply", {
      ...payload,
      token: preview.token,
    });

    await sync();
    const [first] = await eventsOf(member);
    const [second] = await eventsOf(other);
    expect(Date.parse(first.start.dateTime)).toBe(start);
    expect(Date.parse(first.end.dateTime)).toBe(handover);
    expect(Date.parse(second.start.dateTime)).toBe(handover);
    expect(Date.parse(second.end.dateTime)).toBe(end);
  });

  it("shortens an existing event to a completed execution period and keeps it as history after an immediate handover", async () => {
    const duty = await publishedDuty([member], {
      startsIn: 2 * HOUR,
      hours: 10,
      daily: true,
    });
    await connect(member);
    await connect(other);
    const row = await dutyRow(duty.id);
    const start = Date.now() - HOUR;
    await db
      .update(duties)
      .set({ data: { ...row.data, start: new Date(start).toISOString() } })
      .where(eq(duties.id, duty.id));
    await sync();
    const [original] = await eventsOf(member);
    const handover = Date.now() - MINUTE;
    const payload = {
      dutyId: duty.id,
      slotId: duty.slots[0],
      reason: "חילוף מיידי סינתטי",
      segments: [
        {
          soldierId: member.soldierId,
          start: new Date(start).toISOString(),
          end: new Date(handover).toISOString(),
        },
        {
          soldierId: other.soldierId,
          start: new Date(handover).toISOString(),
          end: row.data.end,
        },
      ],
    };
    const preview = await command(manager, "execution.preview", payload);
    await command(manager, "execution.apply", {
      ...payload,
      token: preview.token,
    });
    await sync();
    expect(await eventsOf(member)).toHaveLength(1);
    expect((await eventsOf(member))[0].id).toBe(original.id);
    expect(Date.parse((await eventsOf(member))[0].end.dateTime)).toBe(handover);
    expect(Date.parse((await eventsOf(other))[0].start.dateTime)).toBe(
      handover
    );
    await sync();
    expect(await recorded(member)).toMatchObject([{ status: "synced" }]);
    expect(google.count("delete")).toBe(0);
  });

  it("follows the calendar slots of the reminders: one popup per marked reminder, and a change of preferences updates the event", async () => {
    await publishedDuty([member]);
    await connect(member);
    await sync();
    // The unit default marks both reminders for the calendar.
    expect((await eventsOf(member))[0].reminders).toEqual({
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 1_440 },
        { method: "popup", minutes: 120 },
      ],
    });
    await command(member, "settings.save", {
      reminders: [
        { hours: 24, email: true, calendar: false },
        { hours: 6, email: false, calendar: true },
        { hours: 2, email: true, calendar: true },
      ],
      email: {
        roundOpening: true,
        roundClosing: true,
        publication: true,
        transfer: true,
        departure: true,
        operations: true,
        deletion: true,
        restore: true,
      },
    });
    expect(await sync()).toMatchObject({ updated: 1 });
    expect((await eventsOf(member))[0].reminders).toEqual({
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 360 },
        { method: "popup", minutes: 120 },
      ],
    });
  });

  it("removes the events of a soldier who was made a duty manager, and adds none for the role", async () => {
    await publishedDuty([member]);
    await connect(member);
    await sync();
    expect(await eventsOf(member)).toHaveLength(1);
    await db
      .update(user)
      .set({ role: "manager" })
      .where(eq(user.id, member.id));
    expect(await sync()).toMatchObject({ removed: 1 });
    expect(await eventsOf(member)).toEqual([]);
  });
});

describe("the switch and the button that removes the future duties", () => {
  it("rejects one of two concurrent calendar preference commands from the same version", async () => {
    await connect(member);
    const version = (await link(member)).version;
    const results = await Promise.allSettled([
      command(member, "calendar.switch", { enabled: false }, version),
      command(member, "calendar.switch", { enabled: false }, version),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected")
    ).toMatchObject({ status: "rejected", reason: { status: 409 } });
  });
  it("stops adding and updating as soon as the switch is off, removes nothing, and catches up when it is on again", async () => {
    const first = await publishedDuty([member], { name: "ראשונה" });
    await connect(member);
    await sync();
    await command(member, "calendar.switch", { enabled: false });

    await publishedDuty([member], { name: "שנייה", startsIn: 48 * HOUR });
    await updateAndPublish(first.id, { location: "מקום חדש" });
    const calls = google.calls.length;
    expect(await sync()).toMatchObject({ accounts: 0 });
    expect(google.calls).toHaveLength(calls);
    const kept = await eventsOf(member);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ summary: "ראשונה", location: "שער ראשי" });

    await command(member, "calendar.switch", { enabled: true });
    expect(await sync()).toMatchObject({ created: 1, updated: 1 });
    const events = await eventsOf(member);
    expect(events.map((event) => event.summary).sort()).toEqual([
      "ראשונה",
      "שנייה",
    ]);
    expect(events.find((event) => event.summary === "ראשונה")).toMatchObject({
      location: "מקום חדש",
    });
  });

  it("removes only the future events on request, and a later switch-on creates them again under new ids", async () => {
    // One duty already running and one in a day.
    const running = await publishedDuty([member], {
      name: "מתבצעת",
      startsIn: 2 * HOUR,
      hours: 10,
    });
    const future = await publishedDuty([member], {
      name: "עתידית",
      startsIn: 48 * HOUR,
    });
    const row = await dutyRow(running.id);
    await db
      .update(duties)
      .set({
        data: { ...row.data, start: new Date(Date.now() - HOUR).toISOString() },
      })
      .where(eq(duties.id, running.id));
    await connect(member);
    await sync();
    const [futureEvent] = await db
      .select()
      .from(calendarEvent)
      .where(eq(calendarEvent.dutyId, future.id));
    expect(await eventsOf(member)).toHaveLength(2);

    // The button needs the switch to be off first, or the next run would add them back.
    await expect(
      command(member, "calendar.remove.future", {})
    ).rejects.toMatchObject({ code: "calendar_still_on", status: 409 });
    await command(member, "calendar.switch", { enabled: false });
    // Switching off alone removes nothing.
    await sync();
    expect(await eventsOf(member)).toHaveLength(2);

    await command(member, "calendar.remove.future", {});
    expect((await readState(member)).calendar).toMatchObject({
      state: "off",
      removing: true,
    });
    expect(await sync()).toMatchObject({ removed: 1 });
    expect((await eventsOf(member)).map((event) => event.summary)).toEqual([
      "מתבצעת",
    ]);
    expect((await link(member)).removeRequestedAt).toBeNull();
    expect((await readState(member)).calendar).toMatchObject({
      removing: false,
    });

    // Nothing more happens while it is off; switching on creates the removed one anew.
    await sync();
    expect(await eventsOf(member)).toHaveLength(1);
    await command(member, "calendar.switch", { enabled: true });
    expect(await sync()).toMatchObject({ created: 1 });
    expect(await eventsOf(member)).toHaveLength(2);
    const [again] = await db
      .select()
      .from(calendarEvent)
      .where(eq(calendarEvent.dutyId, future.id));
    expect(again.googleEventId).not.toBe(futureEvent.googleEventId);
    expect(again.generation).toBe(1);
  });

  it("refuses the switch and the button for anyone without a usable permission, and for a manager, even by a direct call", async () => {
    // Signed in with a code only: no Google link at all.
    await expect(
      command(member, "calendar.switch", { enabled: true })
    ).rejects.toMatchObject({ code: "calendar_permission_required" });
    expect((await readState(member)).calendar).toMatchObject({
      available: true,
      state: "blocked",
    });
    // A Google link without the permission.
    await db.insert(account).values({
      id: randomUUID(),
      userId: member.id,
      accountId: "sub-member",
      providerId: "google",
      proofEpoch: member.securityEpoch,
      googleLinkGeneration: 1,
      needsEmailVerification: false,
    });
    expect((await readState(member)).calendar).toMatchObject({
      state: "needs_permission",
    });
    await expect(
      command(member, "calendar.switch", { enabled: true })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      command(member, "calendar.remove.future", {})
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      command(manager, "calendar.switch", { enabled: true })
    ).rejects.toMatchObject({ status: 403 });
    // The role is checked before the payload (decision 203), so a manager learns nothing from a bad one.
    await expect(command(manager, "calendar.switch", {})).rejects.toMatchObject(
      { status: 403 }
    );
    await expect(
      command(manager, "calendar.remove.future", {})
    ).rejects.toMatchObject({ status: 403 });
    // The managers' screen has no calendar option of their own, but shows the slot in the unit defaults.
    expect((await readState(manager)).calendar).toEqual({ available: true });
    await expect(
      command(member, "calendar.switch", { enabled: "yes" })
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("shows the four states of the switch", async () => {
    const state = async () => (await readState(member)).calendar;
    expect(await state()).toMatchObject({ state: "blocked" });
    await connect(member);
    expect(await state()).toMatchObject({ state: "on" });
    await command(member, "calendar.switch", { enabled: false });
    expect(await state()).toMatchObject({ state: "off" });
    await db
      .update(calendarLink)
      .set({ state: "needs_permission" })
      .where(eq(calendarLink.accountId, member.id));
    expect(await state()).toMatchObject({ state: "needs_permission" });
    // Without the deployment switch nothing is offered, and nothing is sent to Google.
    process.env.GOOGLE_CALENDAR_SYNC = "false";
    expect((await readState(member)).calendar).toEqual({ available: false });
  });
});

describe("what the soldier does in Google", () => {
  it("never brings back an event the soldier deleted, but creates one for a new seat", async () => {
    const duty = await publishedDuty([member]);
    await connect(member);
    await sync();
    const [created] = await eventsOf(member);
    const calendarId = (await link(member)).calendarId!;
    google.userDeletesEvent(calendarId, String(created.id));

    await updateAndPublish(duty.id, { location: "מקום אחר" });
    expect(await sync()).toMatchObject({ updated: 0 });
    expect(await eventsOf(member)).toEqual([]);
    expect(google.count("replace")).toBe(0);
    expect(await recorded(member)).toMatchObject([
      { status: "removed_by_user" },
    ]);
    // A further run, and a cancelled duty, never call Google for it either.
    const calls = google.calls.length;
    await sync();
    expect(
      google.calls
        .slice(calls)
        .every((call) => ["refresh", "getCalendar"].includes(call.kind))
    ).toBe(true);

    await publishedDuty([member], { name: "חדשה", startsIn: 72 * HOUR });
    expect(await sync()).toMatchObject({ created: 1 });
    expect((await eventsOf(member)).map((event) => event.summary)).toEqual([
      "חדשה",
    ]);
  });

  it("starts over in a new calendar when the calendar itself was deleted", async () => {
    await publishedDuty([member]);
    await connect(member);
    await sync();
    google.userDeletesCalendar((await link(member)).calendarId!);
    await publishedDuty([member], { name: "נוספת", startsIn: 48 * HOUR });
    await sync();
    // The next run creates a new calendar with the events that apply.
    await sync();
    expect(google.calendars.size).toBe(1);
    expect(await eventsOf(member)).toHaveLength(2);
  });
});

describe("when the permission is gone", () => {
  it('stops without an error, returns to "permission needed" and sends one site notice, until it is granted again', async () => {
    const duty = await publishedDuty([member]);
    const token = await connect(member);
    await sync();
    google.revoke(token);
    await updateAndPublish(duty.id, { location: "מקום אחר" });

    expect(await sync()).toMatchObject({ accounts: 0 });
    expect(await link(member)).toMatchObject({
      state: "needs_permission",
      refreshToken: null,
      errorCode: "permission_lost",
    });
    expect((await readState(member)).calendar).toMatchObject({
      state: "needs_permission",
    });
    const notices = await noticesOf(member);
    expect(notices).toHaveLength(1);
    expect(notices[0].data).toMatchObject({ href: "/settings" });
    // The notice is for this soldier only.
    expect(notices[0].subjectId).toBe(member.soldierId);

    // Later runs do nothing and say nothing more.
    const calls = google.calls.length;
    await sync();
    await sync();
    expect(google.calls).toHaveLength(calls);
    expect(await noticesOf(member)).toHaveLength(1);

    // Granting again makes the link usable and updates the event that was left behind.
    const fresh = await connectAgain(member, "refresh-new");
    expect(await link(member)).toMatchObject({
      state: "active",
      permissionNoticeAt: null,
    });
    expect(openSecret((await link(member)).refreshToken!)).toBe(fresh);
    expect(await sync()).toMatchObject({ updated: 1 });
    expect((await eventsOf(member))[0]).toMatchObject({ location: "מקום אחר" });
    // Losing it a second time is a new notice.
    google.revoke(fresh);
    await updateAndPublish(duty.id, { location: "ושוב" });
    await sync();
    expect(await noticesOf(member)).toHaveLength(2);
  });

  it("treats an access error of the Calendar API like a lost permission, and a quota error like a pause", async () => {
    await publishedDuty([member]);
    await connect(member);
    google.fail((call) => call.kind === "insert", 403, {
      body: { error: { errors: [{ reason: "insufficientPermissions" }] } },
    });
    await sync();
    expect(await link(member)).toMatchObject({ state: "needs_permission" });

    await connectAgain(member, "refresh-again");
    google.fail((call) => call.kind === "insert", 403, {
      body: { error: { errors: [{ reason: "userRateLimitExceeded" }] } },
    });
    await sync();
    expect(await link(member)).toMatchObject({
      state: "active",
      errorCode: "rate",
      attempts: 1,
    });
  });

  it("keeps only the permission and a sealed token, never a plain one", async () => {
    const token = await connect(member, "refresh-secret-value");
    const row = await link(member);
    expect(row.refreshToken).not.toContain(token);
    expect(openSecret(row.refreshToken!)).toBe(token);
    const dump = JSON.stringify(
      await db.execute(sql`select * from calendar_link`)
    );
    expect(dump).not.toContain(token);
  });
});

describe("reliability", () => {
  it("does not insert a later duty that finished while earlier provider calls were running", async () => {
    await publishedDuty([member], { startsIn: MINUTE, hours: 0.01 });
    await publishedDuty([member], { startsIn: 2 * MINUTE, hours: 0.01 });
    await connect(member);
    const initial = Date.now();
    google.onCall = async (call) => {
      if (call.kind !== "insert") return;
      google.onCall = undefined;
      vi.spyOn(Date, "now").mockReturnValue(initial + 3 * MINUTE);
    };
    await sync();
    expect(google.count("insert")).toBe(1);
  });

  it("removes a late old-identity event when an email change purged its pending record", async () => {
    await publishedDuty([member]);
    await connect(member);
    const cleanups: CalendarCleanup[] = [];
    google.onCall = async (call) => {
      if (call.kind !== "insert") return;
      google.onCall = undefined;
      await unitTransaction((tx) =>
        applyVerifiedEmailChange(
          tx,
          member.id,
          "updated@example.invalid",
          cleanups
        )
      );
    };
    await sync();
    expect(await link(member)).toBeUndefined();
    expect(await recorded(member)).toEqual([]);
    expect(google.live()).toEqual([]);
    expect(google.count("delete")).toBe(1);
    await scheduleCalendarCleanup(cleanups[0]);
  });

  it("attempts late identity compensation even when cleanup already deleted the pending id and revoked its token", async () => {
    await publishedDuty([member]);
    await connect(member);
    google.onCall = async (call) => {
      if (call.kind !== "insert") return;
      google.onCall = undefined;
      const cleanups: CalendarCleanup[] = [];
      await unitTransaction((tx) =>
        applyVerifiedEmailChange(
          tx,
          member.id,
          "updated@example.invalid",
          cleanups
        )
      );
      await scheduleCalendarCleanup(cleanups[0]);
    };
    await sync();
    // The request was authorized before revocation. A late accepted write is compensated
    // even for an active account; Google may refuse that DELETE after revocation.
    expect(google.count("delete")).toBe(2);
    expect(await link(member)).toBeUndefined();
    expect(await recorded(member)).toEqual([]);
    expect(
      (await db.select().from(user).where(eq(user.id, member.id)))[0]
    ).toMatchObject({ deletedAt: null, email: "updated@example.invalid" });
  });

  it("fences an expired worker while its successor recovers the same pending event", async () => {
    await publishedDuty([member]);
    await connect(member);
    google.onCall = async (call) => {
      if (call.kind !== "insert") return;
      google.onCall = undefined;
      await db
        .update(calendarLink)
        .set({ leaseUntil: new Date(Date.now() - MINUTE) })
        .where(eq(calendarLink.accountId, member.id));
      expect(await sync()).toMatchObject({ created: 1 });
    };
    await sync();
    expect(google.calendars.size).toBe(1);
    expect(await eventsOf(member)).toHaveLength(1);
    expect(await recorded(member)).toMatchObject([
      { status: "synced", generation: 0 },
    ]);
    expect(await link(member)).toMatchObject({ leaseToken: null, attempts: 0 });
  });

  it("adopts an in-flight calendar creation across a fresh grant without creating another calendar", async () => {
    await publishedDuty([member]);
    await connect(member);
    google.onCall = async (call) => {
      if (call.kind !== "createCalendar") return;
      google.onCall = undefined;
      await connectAgain(member, "new-grant-during-create");
      await sync();
    };
    await sync();
    expect(google.calendars.size).toBe(1);
    expect(await link(member)).toMatchObject({
      calendarId: google.calendar()!.id,
      errorCode: null,
    });
    await sync();
    expect(google.count("createCalendar")).toBe(1);
    expect(await eventsOf(member)).toHaveLength(1);
  });

  it("pauses an uncertain calendar creation instead of creating another secondary calendar", async () => {
    await publishedDuty([member]);
    await connect(member);
    google.loseResponse = "createCalendar";
    await sync();
    expect(google.calendars.size).toBe(1);
    expect(await link(member)).toMatchObject({
      calendarId: null,
      errorCode: "calendar_creation_uncertain",
      leaseToken: null,
    });
    const calls = google.calls.length;
    await sync(10 * MINUTE);
    expect(google.calls).toHaveLength(calls);
    expect(google.count("createCalendar")).toBe(1);
  });

  it("tracks uncertain event creation and removes it if the duty was cancelled before retry", async () => {
    const duty = await publishedDuty([member]);
    await connect(member);
    google.loseResponse = "insert";
    await sync();
    expect(await recorded(member)).toMatchObject([{ status: "pending" }]);
    expect(await eventsOf(member)).toHaveLength(1);
    await command(
      manager,
      "duty.cancel",
      { id: duty.id, reason: "ביטול סינתטי", confirmed: true },
      (await dutyRow(duty.id)).version
    );
    expect(await sync(2 * MINUTE)).toMatchObject({ removed: 1 });
    expect(await eventsOf(member)).toEqual([]);
  });

  it("compensates a successful insert when the duty was cancelled while Google processed it", async () => {
    const duty = await publishedDuty([member]);
    await connect(member);
    google.onCall = async (call) => {
      if (call.kind !== "insert") return;
      google.onCall = undefined;
      await command(
        manager,
        "duty.cancel",
        { id: duty.id, reason: "ביטול סינתטי", confirmed: true },
        (await dutyRow(duty.id)).version
      );
    };
    await sync();
    expect(await eventsOf(member)).toEqual([]);
    expect(await recorded(member)).toMatchObject([{ status: "removed" }]);
  });

  it("does not update after the switch was turned off while an event was being read", async () => {
    const duty = await publishedDuty([member]);
    await connect(member);
    await sync();
    await updateAndPublish(duty.id, { location: "לא יישלח" });
    google.onCall = async (call) => {
      if (call.kind !== "get") return;
      google.onCall = undefined;
      await command(member, "calendar.switch", { enabled: false });
    };
    await sync();
    expect(google.count("replace")).toBe(0);
    expect((await eventsOf(member))[0].location).toBe("שער ראשי");
  });

  it("uses the provider etag when the soldier deletes an event between its read and update", async () => {
    const duty = await publishedDuty([member]);
    await connect(member);
    await sync();
    await updateAndPublish(duty.id, { location: "לא יקום מחדש" });
    google.onCall = async (call) => {
      if (call.kind !== "replace") return;
      google.onCall = undefined;
      google.userDeletesEvent(call.calendar!, call.event!);
    };
    await sync();
    expect(await eventsOf(member)).toEqual([]);
    await sync(2 * MINUTE);
    expect(await recorded(member)).toMatchObject([
      { status: "removed_by_user" },
    ]);
    expect(google.count("insert")).toBe(1);
  });

  it("does not revoke a fresh grant when an older worker reports permission loss", async () => {
    await publishedDuty([member]);
    await connect(member);
    google.onCall = async (call) => {
      if (call.kind !== "refresh") return;
      google.onCall = undefined;
      await connectAgain(member, "fresh-racing-grant");
    };
    google.fail((call) => call.kind === "refresh", 400, {
      body: { error: "invalid_grant" },
    });
    await sync();
    expect(await link(member)).toMatchObject({
      state: "active",
      errorCode: null,
    });
    expect(await noticesOf(member)).toEqual([]);
    await sync();
    expect(await eventsOf(member)).toHaveLength(1);
  });

  it("recovers a wholly deleted calendar even when no duty has changed", async () => {
    await publishedDuty([member]);
    await connect(member);
    await sync();
    google.userDeletesCalendar((await link(member)).calendarId!);
    await sync();
    await sync();
    expect(google.calendars.size).toBe(1);
    expect(await eventsOf(member)).toHaveLength(1);
  });

  it("retains a user-deletion tombstone after completion and never recreates it when the same duty is extended", async () => {
    const duty = await publishedDuty([member]);
    await connect(member);
    await sync();
    const [created] = await eventsOf(member);
    google.userDeletesEvent((await link(member)).calendarId!, created.id);
    await updateAndPublish(duty.id, { location: "שינוי לפני סיום" });
    await sync();
    const row = await dutyRow(duty.id);
    const pastStart = new Date(Date.now() - 3 * HOUR);
    const pastEnd = new Date(Date.now() - HOUR);
    await db
      .update(duties)
      .set({
        data: {
          ...row.data,
          start: pastStart.toISOString(),
          end: pastEnd.toISOString(),
        },
      })
      .where(eq(duties.id, duty.id));
    await db
      .update(calendarEvent)
      .set({ startsAt: pastStart, endsAt: pastEnd })
      .where(eq(calendarEvent.dutyId, duty.id));
    await sync();
    expect(await recorded(member)).toMatchObject([
      { status: "removed_by_user", generation: 0 },
    ]);
    await db
      .update(duties)
      .set({
        data: {
          ...row.data,
          start: pastStart.toISOString(),
          end: new Date(Date.now() + HOUR).toISOString(),
        },
      })
      .where(eq(duties.id, duty.id));
    await sync();
    expect(google.count("insert")).toBe(1);
    expect(await eventsOf(member)).toEqual([]);
  });

  it("waits after a temporary failure with growing delays and then completes without duplicates", async () => {
    await publishedDuty([member], { name: "ראשונה" });
    await publishedDuty([member], { name: "שנייה", startsIn: 48 * HOUR });
    await connect(member);
    let inserts = 0;
    // The second event fails once: a server error from Google.
    google.fail((call) => call.kind === "insert" && ++inserts === 2, 503);
    await sync();
    let state = await link(member);
    expect(state).toMatchObject({ attempts: 1, errorCode: "transient" });
    expect(await eventsOf(member)).toHaveLength(1);
    expect(state.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Not due yet: no call at all.
    const calls = google.calls.length;
    await sync(10_000);
    expect(google.calls).toHaveLength(calls);

    // After the wait it creates only what is missing, and the counters reset.
    await sync(2 * MINUTE);
    expect(await eventsOf(member)).toHaveLength(2);
    expect(google.count("insert")).toBe(3);
    state = await link(member);
    expect(state).toMatchObject({ attempts: 0, errorCode: null });
  });

  it("never asks Google sooner than it said, and grows the wait with each failure", async () => {
    await publishedDuty([member]);
    await connect(member);
    google.fail((call) => call.kind === "insert", 429, {
      headers: { "retry-after": "1800" },
    });
    await sync();
    const first = await link(member);
    expect(first).toMatchObject({ attempts: 1, errorCode: "rate" });
    expect(first.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      Date.now() + 1800_000 - 10_000
    );
    // Failing again after the wait waits longer still.
    google.fail((call) => call.kind === "insert", 500);
    await sync(31 * MINUTE);
    const second = await link(member);
    expect(second.attempts).toBe(2);
    expect(second.nextAttemptAt.getTime()).toBeGreaterThan(
      Date.now() + 31 * MINUTE + 4 * MINUTE
    );
  });

  it("recovers an event that Google created before the run could record it, without a second one", async () => {
    const duty = await publishedDuty([member]);
    await connect(member);
    // A first run died after Google accepted the event: the calendar and the event exist, no record does.
    await sync();
    const [created] = await eventsOf(member);
    await db
      .delete(calendarEvent)
      .where(eq(calendarEvent.accountId, member.id));
    expect(duty.id).toBeTruthy();
    await sync();
    expect(await eventsOf(member)).toHaveLength(1);
    expect((await eventsOf(member))[0].id).toBe(created.id);
    expect(await recorded(member)).toMatchObject([{ status: "synced" }]);
  });

  it("creates each event once when two runs overlap", async () => {
    await publishedDuty([member]);
    await connect(member);
    await Promise.all([sync(), sync()]);
    expect(google.calendars.size).toBe(1);
    expect(await eventsOf(member)).toHaveLength(1);
    expect(google.count("createCalendar")).toBe(1);
  });

  it("does not run while a restore keeps the system closed, or when the deployment has it off", async () => {
    await publishedDuty([member]);
    await connect(member);
    process.env.RESTORE_MODE = "true";
    expect(await sync()).toMatchObject({ accounts: 0 });
    delete process.env.RESTORE_MODE;
    await db
      .insert(operationsState)
      .values({ key: "restore", data: { blocked: true } });
    expect(await sync()).toMatchObject({ accounts: 0 });
    await db.execute(sql`delete from operations_state where key = 'restore'`);
    process.env.GOOGLE_CALENDAR_SYNC = "false";
    expect(await sync()).toMatchObject({ accounts: 0 });
    expect(google.calls).toHaveLength(0);
    process.env.GOOGLE_CALENDAR_SYNC = "true";
    expect(await sync()).toMatchObject({ created: 1 });
  });
});

describe("deleting a soldier", () => {
  async function deleteViaAction(actor: Actor) {
    const [row] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    const preview = await command(
      manager,
      "soldier.delete.preview",
      { id: actor.soldierId },
      row.version
    );
    return command(
      manager,
      "soldier.delete",
      {
        id: actor.soldierId,
        previewToken: preview.previewToken,
        confirmed: true,
        reason: "מחיקה סינתטית",
      },
      row.version
    );
  }

  it("removes the permission, the token and the event records at once, then revokes the token and removes the future events in Google", async () => {
    await publishedDuty([member], { name: "עתידית", startsIn: 48 * HOUR });
    const token = await connect(member);
    await sync();
    expect(await eventsOf(member)).toHaveLength(1);

    await deleteViaAction(member);
    // Nothing is left here, before Google is even asked.
    expect(await link(member)).toBeUndefined();
    expect(await recorded(member)).toEqual([]);
    expect(
      await db.select().from(account).where(eq(account.userId, member.id))
    ).toEqual([]);
    await settleCalendarCleanups();
    expect(google.revoked).toEqual([token]);
    expect(google.tokens.get(token)).toBe("revoked");
    // The calendar and what already happened stay the soldier's; the future duty is gone.
    expect(google.calendars.size).toBe(1);
    expect(google.live()).toEqual([]);
    // A sync after that finds nothing to do for the deleted account.
    expect(await sync()).toMatchObject({ accounts: 0 });
  });

  it("deletes a soldier even when Google cannot be reached, and a restore applying the deletion again never calls Google", async () => {
    await publishedDuty([member, other], { startsIn: 48 * HOUR });
    await connect(member);
    await connect(other);
    await sync();
    google.fail(() => true, 503, { times: 1000 });
    await deleteViaAction(member);
    await settleCalendarCleanups();
    expect(await link(member)).toBeUndefined();
    // The events stay in Google because it could not be reached: that is all "tries" promises.
    google.reset();

    // The restore of a backup applies a logged deletion: rows go, no call is made.
    await unitTransaction((tx) =>
      eraseSoldier(tx, manager, other.soldierId!, {
        reason: "הוחל מחדש אחרי שחזור",
        restored: { at: new Date().toISOString() },
      })
    );
    await settleCalendarCleanups();
    expect(await link(other)).toBeUndefined();
    expect(await recorded(other)).toEqual([]);
    expect(google.calls).toHaveLength(0);
  });

  it("does not make a link for an account that is already deleted", async () => {
    await publishedDuty([member], { startsIn: 48 * HOUR });
    await deleteViaAction(member);
    await recordGoogleGrant(member.id, {
      scopes: [CALENDAR_SCOPE],
      refreshToken: "late-token",
    });
    expect(await link(member)).toBeUndefined();
  });
});
