import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import { emailOutbox } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import { deliverNextEmail } from "../../src/server/operations/email";
import { refreshDutyReminders } from "../../src/server/duty-reminders";
import { dutyReminderKey } from "../../src/domain/duty-reminders";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

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
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as { id: string; version: number };
}
/** A published one-seat duty for the member, starting after the given delay. */
async function publishedDuty(startsIn: number, holder = member) {
  const type = await command(manager, "dutyType.save", {
    name: "שמירה סינתטית",
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 1 }],
  });
  const start = Date.now() + startsIn;
  const duty = await command(manager, "duty.create", {
    typeId: type.id,
    name: "תורנות סינתטית",
    start: new Date(start).toISOString(),
    end: new Date(start + 8 * HOUR).toISOString(),
  });
  const [row] = await db.select().from(duties).where(eq(duties.id, duty.id));
  await command(
    manager,
    "duty.assign",
    {
      dutyId: row.id,
      slotId: row.data.slots[0].id,
      soldierId: holder.soldierId,
    },
    1
  );
  await command(manager, "duty.publish", { id: row.id, confirmed: true }, 2);
  return {
    id: row.id,
    start: Date.parse(row.data.start),
    slot: row.data.slots[0].id,
  };
}
const refresh = (now: number) =>
  unitTransaction((tx) => refreshDutyReminders(tx, new Date(now)));
/** Site reminders of a duty, as [soldier, hours] pairs. */
async function reminders(dutyId: string) {
  const rows = await db
    .select()
    .from(records)
    .where(
      and(
        eq(records.kind, "notification"),
        sql`${records.data}->>'dutyId' = ${dutyId}`,
        sql`${records.data} ? 'reminderHours'`
      )
    );
  // In creation order: each worker run commits in its own transaction.
  return rows
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => ({
      subjectId: row.subjectId,
      hours: Number(row.data.reminderHours),
      merged: row.data.mergedHours,
    }));
}
async function reminderEmails(dutyId: string) {
  return db
    .select()
    .from(emailOutbox)
    .where(like(emailOutbox.eventKey, `reminder:${dutyId}:%`));
}
/** Deliver everything due at the given time; returns the reminder keys sent. */
async function deliverAll(now: number) {
  const sent: string[] = [];
  for (let index = 0; index < 20; index++) {
    const result = await deliverNextEmail(async (message) => {
      sent.push(message.eventKey);
      return `synthetic-${message.eventKey}`;
    }, new Date(now));
    if (result.status === "idle") break;
  }
  return sent.filter((key) => key.startsWith("reminder:")).sort();
}
const allEmail = {
  roundOpening: true,
  roundClosing: true,
  publication: true,
  transfer: true,
  departure: true,
};

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("אחראי לבדיקה", "manager", "00002");
  member = await invite("חייל לבדיקה", "soldier", "00001");
  other = await invite("חייל נוסף", "soldier", "00004");
});
afterAll(async () => pool.end());

describe("duty reminders", () => {
  it("sends the default 24 and 2 hour reminders once on both channels and nothing after the start", async () => {
    const duty = await publishedDuty(25 * HOUR);
    await refresh(Date.now());
    expect(await reminders(duty.id)).toEqual([]);
    const first = duty.start - 24 * HOUR + MINUTE;
    await refresh(first);
    await refresh(first + 30_000);
    expect(await reminders(duty.id)).toMatchObject([
      { subjectId: member.soldierId, hours: 24 },
    ]);
    // The email carries the duty name and start in Israel time only.
    const [queued] = await reminderEmails(duty.id);
    expect(queued).toMatchObject({
      eventKey: dutyReminderKey(duty.id, duty.start, 24, member.id),
      kind: "duty-reminder",
      reminderHours: 24,
      href: `/duties/${duty.id}`,
    });
    expect(queued.body).toContain("תורנות סינתטית");
    expect(queued.body).not.toContain("example.invalid");
    expect(await deliverAll(first + MINUTE)).toEqual([queued.eventKey]);
    const second = duty.start - 2 * HOUR + MINUTE;
    await refresh(second);
    expect((await reminders(duty.id)).map((row) => row.hours)).toEqual([24, 2]);
    expect(await deliverAll(second + MINUTE)).toEqual([
      dutyReminderKey(duty.id, duty.start, 2, member.id),
    ]);
    // The member sees both reminders; the other soldier sees none.
    expect(
      (await readState(member)).notifications.filter(
        (row) => (row as { href?: string }).href === `/duties/${duty.id}`
      )
    ).toHaveLength(3);
    expect(
      JSON.stringify((await readState(other)).notifications)
    ).not.toContain(duty.id);
    await refresh(duty.start + MINUTE);
    expect(await reminders(duty.id)).toHaveLength(2);
  });

  it("does not send a draft reminder and skips times that passed before publication", async () => {
    const type = await command(manager, "dutyType.save", {
      name: "שמירה סינתטית",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 1 }],
    });
    const start = Date.now() + 10 * HOUR;
    const draft = await command(manager, "duty.create", {
      typeId: type.id,
      name: "טיוטה",
      start: new Date(start).toISOString(),
      end: new Date(start + HOUR).toISOString(),
    });
    const [row] = await db.select().from(duties).where(eq(duties.id, draft.id));
    await command(
      manager,
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: member.soldierId,
      },
      1
    );
    const unpublished = await command(manager, "duty.create", {
      typeId: type.id,
      name: "טיוטה שנשארת",
      start: new Date(start).toISOString(),
      end: new Date(start + HOUR).toISOString(),
    });
    const [kept] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, unpublished.id));
    await command(
      manager,
      "duty.assign",
      {
        dutyId: kept.id,
        slotId: kept.data.slots[0].id,
        soldierId: other.soldierId,
      },
      1
    );
    // The last run was before the 24 hour time; the worker returns after publication.
    await refresh(Date.now() - 20 * HOUR);
    await command(manager, "duty.publish", { id: row.id, confirmed: true }, 2);
    await refresh(Date.now() + MINUTE);
    expect(await reminders(row.id)).toEqual([]);
    await refresh(start - 2 * HOUR + MINUTE);
    expect((await reminders(row.id)).map((item) => item.hours)).toEqual([2]);
    expect(await reminders(kept.id)).toEqual([]);
  });

  it("merges times missed while the worker was down into one reminder and skips a duty that started", async () => {
    const duty = await publishedDuty(25 * HOUR);
    const started = await publishedDuty(3 * HOUR, other);
    await refresh(Date.now());
    const back = duty.start - HOUR;
    await refresh(back);
    expect(await reminders(duty.id)).toMatchObject([
      { subjectId: member.soldierId, hours: 2, merged: [24] },
    ]);
    expect(await reminders(started.id)).toEqual([]);
    const emails = await reminderEmails(duty.id);
    expect(emails.map((row) => row.reminderHours)).toEqual([2]);
    await refresh(back + MINUTE);
    expect(await reminders(duty.id)).toHaveLength(1);
  });

  it("follows current preferences on both channels and rechecks them before delivery", async () => {
    const saved = await command(member, "settings.save", {
      reminders: [{ hours: 5, email: false, calendar: true }],
      email: allEmail,
    });
    const duty = await publishedDuty(25 * HOUR);
    await refresh(Date.now());
    await refresh(duty.start - 24 * HOUR + MINUTE);
    expect(await reminders(duty.id)).toEqual([]);
    const due = duty.start - 5 * HOUR + MINUTE;
    await refresh(due);
    expect((await reminders(duty.id)).map((row) => row.hours)).toEqual([5]);
    // The site notice stays; the email switch cancels the email.
    expect(await deliverAll(due + MINUTE)).toEqual([]);
    expect((await reminderEmails(duty.id))[0]).toMatchObject({
      status: "cancelled",
      error: "preference_disabled",
    });
    // Returning to the defaults brings back the 2 hour reminder by email.
    const reset = await command(member, "settings.reset", {}, saved.version);
    const later = duty.start - 2 * HOUR + MINUTE;
    await refresh(later);
    await command(
      member,
      "settings.save",
      {
        reminders: [{ hours: 24, email: true, calendar: true }],
        email: allEmail,
      },
      reset.version
    );
    // Two hours were removed after scheduling: the queued email is not sent.
    expect(await deliverAll(later + MINUTE)).toEqual([]);
    expect(
      (await reminderEmails(duty.id)).find((row) => row.reminderHours === 2)
    ).toMatchObject({ status: "cancelled", error: "preference_disabled" });
  });

  it("keeps the schedule when a published change keeps the start and replaces it when the start moves", async () => {
    const duty = await publishedDuty(25 * HOUR);
    await refresh(Date.now());
    const first = duty.start - 24 * HOUR + MINUTE;
    await refresh(first);
    const [row] = await db.select().from(duties).where(eq(duties.id, duty.id));
    async function publishChange(
      version: number,
      values: Record<string, unknown>
    ) {
      const [live] = await db
        .select()
        .from(duties)
        .where(eq(duties.id, duty.id));
      const change = await command(
        manager,
        "duty.change.create",
        { dutyId: duty.id, reason: "עדכון סינתטי" },
        version
      );
      await command(
        manager,
        "duty.change.save",
        {
          ...live.data,
          ...values,
          id: change.id,
          seats: [
            { slotId: duty.slot, soldierId: member.soldierId, extraPoints: 0 },
          ],
          reason: "עדכון מפורש",
        },
        1
      );
      const preview = (await executeAction(manager, {
        type: "duty.change.preview",
        payload: { id: change.id },
        expectedVersion: 2,
        idempotencyKey: randomUUID(),
      })) as { previewToken: string };
      await command(
        manager,
        "duty.change.publish",
        { id: change.id, confirmed: true, previewToken: preview.previewToken },
        2
      );
    }
    // Only the location changes: the queued reminder stays valid and nothing repeats.
    await publishChange(row.version, { location: "שער צפוני" });
    const [kept] = await reminderEmails(duty.id);
    expect(kept.status).toBe("pending");
    await refresh(first + MINUTE);
    expect(await reminders(duty.id)).toHaveLength(1);
    expect(await deliverAll(first + 2 * MINUTE)).toEqual([kept.eventKey]);
    // The start moves one hour later: the old schedule is replaced.
    const [live] = await db.select().from(duties).where(eq(duties.id, duty.id));
    const moved = duty.start + HOUR;
    await publishChange(live.version, {
      start: new Date(moved).toISOString(),
      end: new Date(moved + 8 * HOUR).toISOString(),
    });
    await refresh(moved - 24 * HOUR + MINUTE);
    expect(await reminders(duty.id)).toHaveLength(2);
    // The old start's 2 hour time is not a reminder any more.
    await refresh(duty.start - 2 * HOUR + MINUTE);
    expect(await reminders(duty.id)).toHaveLength(2);
    await refresh(moved - 2 * HOUR + MINUTE);
    expect((await reminders(duty.id)).map((item) => item.hours)).toEqual([
      24, 24, 2,
    ]);
    const keys = (await reminderEmails(duty.id)).map((item) => item.eventKey);
    expect(keys.sort()).toEqual(
      [
        dutyReminderKey(duty.id, duty.start, 24, member.id),
        dutyReminderKey(duty.id, moved, 24, member.id),
        dutyReminderKey(duty.id, moved, 2, member.id),
      ].sort()
    );
  });

  it("cancels queued reminders of an old start or a cancelled duty before delivery", async () => {
    const duty = await publishedDuty(25 * HOUR);
    await refresh(Date.now());
    const first = duty.start - 24 * HOUR + MINUTE;
    await refresh(first);
    const [live] = await db.select().from(duties).where(eq(duties.id, duty.id));
    await command(
      manager,
      "duty.cancel",
      { id: duty.id, reason: "ביטול סינתטי", confirmed: true },
      live.version
    );
    expect((await reminderEmails(duty.id))[0]).toMatchObject({
      status: "cancelled",
      error: "superseded",
    });
    expect(await deliverAll(first + MINUTE)).toEqual([]);
    await refresh(duty.start - 2 * HOUR + MINUTE);
    expect(await reminders(duty.id)).toHaveLength(1);
  });

  it("moves reminders to the replacement after a transfer", async () => {
    const duty = await publishedDuty(25 * HOUR);
    await refresh(Date.now());
    const first = duty.start - 24 * HOUR + MINUTE;
    await refresh(first);
    const [seat] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.dutyId, duty.id));
    const offer = await command(
      member,
      "transfer.offer",
      { assignmentId: seat.id, candidateIds: [other.soldierId] },
      1
    );
    await command(
      other,
      "transfer.respond",
      { id: offer.id, decision: "accept", confirmed: true },
      1
    );
    expect(
      (await reminderEmails(duty.id)).find(
        (row) => row.recipientAccountId === member.id
      )
    ).toMatchObject({ status: "cancelled", error: "superseded" });
    await refresh(first + MINUTE);
    const second = duty.start - 2 * HOUR + MINUTE;
    await refresh(second);
    expect(await reminders(duty.id)).toMatchObject([
      { subjectId: member.soldierId, hours: 24 },
      { subjectId: other.soldierId, hours: 2 },
    ]);
    expect(await deliverAll(second + MINUTE)).toEqual([
      dutyReminderKey(duty.id, duty.start, 2, other.id),
    ]);
  });

  it("does not deliver to a soldier who lost access after scheduling", async () => {
    const duty = await publishedDuty(25 * HOUR);
    await refresh(Date.now());
    const first = duty.start - 24 * HOUR + MINUTE;
    await refresh(first);
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, member.soldierId!));
    // Release date yesterday: past the release boundary and no grace access.
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await db
      .update(soldiers)
      .set({
        data: {
          ...person.data,
          service: { ...person.data.service, releaseDate: yesterday },
        },
      })
      .where(eq(soldiers.id, member.soldierId!));
    expect(await deliverAll(first + MINUTE)).toEqual([]);
    expect((await reminderEmails(duty.id))[0].status).toBe("cancelled");
    await refresh(duty.start - 2 * HOUR + MINUTE);
    expect(await reminders(duty.id)).toHaveLength(1);
  });

  it("creates one set of reminders when workers run concurrently", async () => {
    const duty = await publishedDuty(25 * HOUR);
    await refresh(Date.now());
    const first = duty.start - 24 * HOUR + MINUTE;
    await Promise.all([refresh(first), refresh(first), refresh(first + 1000)]);
    expect(await reminders(duty.id)).toHaveLength(1);
    expect(await reminderEmails(duty.id)).toHaveLength(1);
  });
});
