import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { emailOutbox, emailQuota } from "../../src/server/auth-schema";
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
import { createRecord } from "../../src/server/repository";
import {
  deliverNextEmail,
  enqueueEmail,
} from "../../src/server/operations/email";
import type { EmailKind } from "../../src/domain/notification-preferences";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

let manager: Actor;
let secondManager: Actor;
let technical: Actor;
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
  expectedVersion?: number,
  idempotencyKey = randomUUID()
) {
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey,
  })) as { id: string; version: number };
}
async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: { status?: number; code?: string; name?: string }) => error
  );
}
const allEmail = {
  dutyReminder: true,
  roundOpening: true,
  roundClosing: true,
  publication: true,
  transfer: true,
};
async function queue(
  actor: Actor,
  kind: EmailKind,
  eventKey: string,
  reminderHours?: number
) {
  await db.transaction((tx) =>
    enqueueEmail(tx, {
      recipientAccountId: actor.id,
      eventKey,
      kind,
      reminderHours,
      title: "הודעה סינתטית",
      body: "תוכן סינתטי",
      expiresAt: new Date(Date.now() + 3600_000),
    })
  );
}
/** Deliver everything due and return the event keys the provider received. */
async function deliverAll() {
  const sent: string[] = [];
  for (let index = 0; index < 20; index++) {
    const result = await deliverNextEmail(
      async (message) => {
        sent.push(message.eventKey);
        return `synthetic-${message.eventKey}`;
      },
      new Date(Date.now() + 1000)
    );
    if (result.status === "idle") break;
  }
  return sent.sort();
}
async function outbox(eventKey: string) {
  const [row] = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.eventKey, eventKey));
  return row;
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  const tech = await createInvitedAccount({
    name: "טכני לבדיקה",
    role: "technical",
    email: "technical@example.invalid",
  });
  technical = {
    id: tech.id,
    name: tech.name,
    role: "technical",
    securityEpoch: 1,
  };
  manager = await invite("אחראי לבדיקה", "manager", "00002");
  secondManager = await invite("אחראי נוסף", "manager", "00003");
  member = await invite("חייל לבדיקה", "soldier", "00001");
  other = await invite("חייל נוסף", "soldier", "00004");
});
afterAll(async () => pool.end());

describe("notification preferences and defaults", () => {
  it("applies changed unit defaults to inheriting accounts without overriding a saved personal form", async () => {
    expect((await readState(member)).settings).toMatchObject({
      source: "system",
      reminderHours: [24, 2],
      email: allEmail,
    });
    await command(other, "settings.save", {
      reminderHours: [48],
      email: allEmail,
    });
    const defaults = await command(manager, "notification.defaults.save", {
      reminderHours: [12],
      email: { ...allEmail, publication: false },
    });
    expect((await readState(member)).settings).toMatchObject({
      source: "unit",
      reminderHours: [12],
      email: { publication: false },
    });
    expect((await readState(other)).settings).toMatchObject({
      source: "personal",
      reminderHours: [48],
      email: { publication: true },
    });
    // The other manager sees the same unit defaults and edits them by version.
    expect((await readState(secondManager)).notificationDefaults).toMatchObject(
      { reminderHours: [12], version: defaults.version }
    );
    await command(
      secondManager,
      "notification.defaults.save",
      { reminderHours: [6, 1], email: { ...allEmail, publication: false } },
      defaults.version
    );
    expect((await readState(member)).settings).toMatchObject({
      reminderHours: [6, 1],
    });
    const [log] = await db
      .select()
      .from(records)
      .where(
        and(
          eq(records.kind, "audit"),
          sql`${records.data}->>'action' = 'notification.defaults.save'`,
          sql`${records.data}->>'actorId' = ${secondManager.id}`
        )
      );
    expect(log.data).toMatchObject({
      before: { reminderHours: [12] },
      after: { reminderHours: [6, 1] },
    });

    await queue(member, "publication", "member-publication");
    await queue(other, "publication", "other-publication");
    expect(await deliverAll()).toEqual(["other-publication"]);
    expect(await outbox("member-publication")).toMatchObject({
      status: "cancelled",
      error: "preference_disabled",
    });
    // A preference cancellation does not consume the shared daily quota.
    expect((await db.select().from(emailQuota))[0].used).toBe(1);
  });

  it("lets only managers set unit defaults and rejects a stale default edit", async () => {
    const payload = { reminderHours: [24], email: allEmail };
    for (const actor of [member, technical])
      expect(
        await rejection(command(actor, "notification.defaults.save", payload))
      ).toMatchObject({ status: 403 });
    const first = await command(manager, "notification.defaults.save", payload);
    const results = await Promise.allSettled([
      command(manager, "notification.defaults.save", payload, first.version),
      command(
        secondManager,
        "notification.defaults.save",
        { ...payload, reminderHours: [2] },
        first.version
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      await rejection(
        command(manager, "notification.defaults.save", payload, first.version)
      )
    ).toMatchObject({ status: 409 });
    expect(
      (
        await db
          .select()
          .from(records)
          .where(eq(records.kind, "notification_defaults"))
      ).length
    ).toBe(1);
  });

  it("gives each account access to its own preferences only", async () => {
    expect(
      await rejection(
        command(member, "settings.save", {
          accountId: other.id,
          reminderHours: [1],
          email: allEmail,
        })
      )
    ).toMatchObject({ name: "ZodError" });
    for (const reminderHours of [[0], [169], [1.5], [3, 3], [1, 2, 3, 4]])
      expect(
        await rejection(
          command(member, "settings.save", { reminderHours, email: allEmail })
        )
      ).toMatchObject({ name: "ZodError" });
    const saved = await command(member, "settings.save", {
      reminderHours: [],
      email: { ...allEmail, roundOpening: false },
    });
    expect((await readState(other)).settings).toMatchObject({
      source: "system",
      reminderHours: [24, 2],
    });
    expect((await readState(member)).settings).toMatchObject({
      source: "personal",
      reminderHours: [],
      email: { roundOpening: false },
      version: saved.version,
    });
    expect(JSON.stringify(await readState(member))).not.toContain(other.id);
    // A stale form, or a second first-time save racing the first, never overwrites silently.
    expect(
      await rejection(
        command(member, "settings.save", {
          reminderHours: [2],
          email: allEmail,
        })
      )
    ).toMatchObject({ status: 409 });
    const racing = await Promise.allSettled([
      command(other, "settings.save", { reminderHours: [1], email: allEmail }),
      command(other, "settings.save", { reminderHours: [2], email: allEmail }),
    ]);
    expect(racing.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    // The technical account keeps its own preferences, separate from the units' soldiers.
    await command(technical, "settings.save", {
      reminderHours: [5],
      email: allEmail,
    });
    expect((await readState(technical)).settings).toMatchObject({
      source: "personal",
      reminderHours: [5],
    });
    // Returning to the defaults makes later unit changes apply again.
    await command(member, "settings.reset", {}, saved.version);
    await command(manager, "notification.defaults.save", {
      reminderHours: [8],
      email: allEmail,
    });
    expect((await readState(member)).settings).toMatchObject({
      source: "unit",
      reminderHours: [8],
    });
  });

  it("rechecks type and timing preferences after scheduling and before delivery", async () => {
    await queue(member, "duty-reminder", "reminder-24", 24);
    await queue(member, "duty-reminder", "reminder-2", 2);
    await queue(member, "round-opening", "round-opening");
    await queue(member, "invitation", "invitation");
    const saved = await command(member, "settings.save", {
      reminderHours: [2],
      email: { ...allEmail, roundOpening: false, publication: false },
    });
    await queue(member, "publication", "publication-later");
    // Switching publication email back on before delivery sends the queued message.
    await command(
      member,
      "settings.save",
      {
        reminderHours: [2],
        email: { ...allEmail, roundOpening: false },
      },
      saved.version
    );
    expect(await deliverAll()).toEqual([
      "invitation",
      "publication-later",
      "reminder-2",
    ]);
    for (const key of ["reminder-24", "round-opening"])
      expect(await outbox(key)).toMatchObject({
        status: "cancelled",
        error: "preference_disabled",
      });
    expect((await db.select().from(emailQuota))[0].used).toBe(3);
  });
});

describe("site notifications, reading and hiding", () => {
  async function publishedDuty() {
    const type = await command(manager, "dutyType.save", {
      name: "שמירה סינתטית",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 2 }],
    });
    const duty = await command(manager, "duty.create", {
      typeId: type.id,
      name: "תורנות לבדיקה",
      start: new Date(Date.now() + 86_400_000).toISOString(),
      end: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    });
    const [row] = await db.select().from(duties).where(eq(duties.id, duty.id));
    let version = row.version;
    for (const [index, person] of [member, other].entries())
      await command(
        manager,
        "duty.assign",
        {
          dutyId: row.id,
          slotId: row.data.slots[index].id,
          soldierId: person.soldierId,
        },
        version++
      );
    await command(
      manager,
      "duty.publish",
      { id: row.id, confirmed: true },
      version
    );
    return row.id;
  }

  it("keeps the site notification when email is off and never treats delivery as reading", async () => {
    await command(member, "settings.save", {
      reminderHours: [24, 2],
      email: { ...allEmail, publication: false },
    });
    await publishedDuty();
    const sent = await deliverAll();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(other.id);
    for (const actor of [member, other]) {
      const state = await readState(actor);
      expect(state.notifications).toHaveLength(1);
      expect(state.notifications[0]).not.toHaveProperty("readAt");
    }
  });

  it("hides and reads only the recipient's copy without changing the duty, assignment or log", async () => {
    const dutyId = await publishedDuty();
    const snapshot = async () => ({
      duty: (await db.select().from(duties).where(eq(duties.id, dutyId)))[0]
        .version,
      assignments: (
        await db
          .select()
          .from(assignments)
          .where(eq(assignments.dutyId, dutyId))
      ).map((row) => [row.status, row.version]),
      audit: (await db.select().from(records).where(eq(records.kind, "audit")))
        .length,
    });
    const before = await snapshot();
    const [mine] = (await readState(member)).notifications;
    const [theirs] = (await readState(other)).notifications;

    for (const actor of [other, manager])
      expect(
        await rejection(
          command(actor, "notification.hide", { id: mine.id }, mine.version)
        )
      ).toMatchObject({ status: 403 });

    const read = await command(
      member,
      "notification.read",
      { id: mine.id },
      mine.version
    );
    // Repeating the action (another tab) keeps the first read time and is not a conflict.
    const again = await command(
      member,
      "notification.read",
      { id: mine.id },
      mine.version
    );
    expect(again.version).toBe(read.version);
    expect((await readState(member)).notifications[0]).toHaveProperty("readAt");

    await command(member, "notification.hide", { id: mine.id }, read.version);
    expect((await readState(member)).notifications).toHaveLength(0);
    const kept = (await readState(other)).notifications;
    expect(kept.map((row) => row.id)).toEqual([theirs.id]);
    expect(kept[0]).not.toHaveProperty("readAt");
    const [stored] = await db
      .select()
      .from(records)
      .where(eq(records.id, String(mine.id)));
    expect(stored.data.hiddenAt).toBeTruthy();
    expect(await snapshot()).toEqual(before);
  });

  it("shows a notification addressed to a manager only to that manager, even when it concerns a soldier", async () => {
    const notice = await db.transaction((tx) =>
      createRecord(
        tx,
        "notification",
        {
          accountId: manager.id,
          title: "מועד פז״ם לבדיקה",
          body: "יש לבדוק עדכון דרגה.",
          href: "/manage/ranks",
        },
        member.soldierId
      )
    );
    expect((await readState(member)).notifications).toHaveLength(0);
    expect(
      await rejection(
        command(member, "notification.read", { id: notice.id }, notice.version)
      )
    ).toMatchObject({ status: 403 });
    expect(
      (await readState(manager)).notifications.map((row) => row.id)
    ).toEqual([notice.id]);
    // A notification without an addressed account belongs to its subject's own account.
    const subjectOnly = await db.transaction((tx) =>
      createRecord(
        tx,
        "notification",
        { title: "האילוץ אושר", body: "סינתטי", href: "/constraints" },
        member.soldierId
      )
    );
    expect(
      (await readState(member)).notifications.map((row) => row.id)
    ).toEqual([subjectOnly.id]);
    expect(
      await rejection(
        command(
          manager,
          "notification.hide",
          { id: subjectOnly.id },
          subjectOnly.version
        )
      )
    ).toMatchObject({ status: 403 });
  });
});
