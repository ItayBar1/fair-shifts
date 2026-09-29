import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool, unitTransaction } from "../../src/server/db";
import { emailOutbox } from "../../src/server/auth-schema";
import {
  balances,
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
import {
  deliverNextEmail,
  enqueueEmail,
} from "../../src/server/operations/email";
import { refreshRoundNotices } from "../../src/server/round-notices";
import { roundEventKey } from "../../src/domain/round-notices";
import type { ServiceProfile } from "../../src/domain/types";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

const ZONE = "Asia/Jerusalem";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
let manager: Actor;
let secondManager: Actor;
let member: Actor;
let other: Actor;

async function person(
  name: string,
  personalNumber: string,
  service: Partial<ServiceProfile> = {}
) {
  const id = randomUUID();
  const base = soldier({ id, name, personalNumber });
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber,
    data: { ...base, service: { ...base.service, ...service } },
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: `${personalNumber}@example.invalid` });
  await db.insert(balances).values({ soldierId: id });
  return id;
}
async function invite(
  name: string,
  role: "soldier" | "manager",
  personalNumber: string,
  service: Partial<ServiceProfile> = {}
): Promise<Actor> {
  const soldierId = await person(name, personalNumber, service);
  const row = await createInvitedAccount({
    name,
    role,
    email: `${personalNumber}@example.invalid`,
    soldierId,
  });
  return { id: row.id, name, role, soldierId, securityEpoch: 1 };
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
const israelDate = (offsetDays: number) =>
  DateTime.now().setZone(ZONE).plus({ days: offsetDays }).toISODate()!;
async function openRound(
  opensAt: number,
  closesAt: number,
  target = { targetStart: israelDate(5), targetEnd: israelDate(10) }
) {
  return command(manager, "round.create", {
    name: "סבב סינתטי",
    opensAt: new Date(opensAt).toISOString(),
    closesAt: new Date(closesAt).toISOString(),
    ...target,
  });
}
const refresh = (now: number) =>
  unitTransaction((tx) => refreshRoundNotices(tx, new Date(now)));
async function roundRecord(id: string) {
  const [row] = await db.select().from(records).where(eq(records.id, id));
  return row;
}
/** Site notices of one round, as the subjects that received each kind. */
async function notices(roundId: string, notice: string) {
  const rows = await db
    .select()
    .from(records)
    .where(
      and(
        eq(records.kind, "notification"),
        sql`${records.data}->>'roundId' = ${roundId}`,
        sql`${records.data}->>'notice' = ${notice}`
      )
    );
  return rows;
}
const subjects = (rows: { subjectId: string | null }[]) =>
  rows.map((row) => row.subjectId).sort();
async function roundEmails(roundId: string) {
  return db
    .select()
    .from(emailOutbox)
    .where(like(emailOutbox.eventKey, `round:${roundId}:%`));
}
async function markers(roundId: string) {
  return (
    await db.select().from(records).where(eq(records.kind, "round_notice"))
  )
    .filter((row) => row.data.roundId === roundId)
    .map((row) => row.data);
}
/** Deliver everything due and return the event keys the provider received. */
async function deliverAll(now = Date.now() + 1000) {
  const sent: string[] = [];
  for (let index = 0; index < 30; index++) {
    const result = await deliverNextEmail(async (message) => {
      sent.push(message.eventKey);
      return `synthetic-${message.eventKey}`;
    }, new Date(now));
    if (result.status === "idle") break;
  }
  return sent.sort();
}
const sorted = (...values: (string | undefined)[]) => [...values].sort();
const allEmail = {
  dutyReminder: true,
  roundOpening: true,
  roundClosing: true,
  publication: true,
  transfer: true,
};

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  await createInvitedAccount({
    name: "טכני לבדיקה",
    role: "technical",
    email: "technical@example.invalid",
  });
  manager = await invite("אחראי לבדיקה", "manager", "00002");
  secondManager = await invite("אחראי נוסף", "manager", "00003");
  member = await invite("חייל לבדיקה", "soldier", "00001");
  other = await invite("חייל נוסף", "soldier", "00004");
});
afterAll(async () => pool.end());

describe("constraint round notices", () => {
  it("opens once for soldiers serving in the target period, by their preferences", async () => {
    const now = Date.now();
    const round = await openRound(now - 60_000, now + 3 * DAY);
    const withoutAccount = await person("חייל ללא חשבון", "00005");
    await invite("משתחרר לפני התקופה", "soldier", "00006", {
      releaseDate: israelDate(4),
    });
    await invite("מגיע אחרי התקופה", "soldier", "00007", {
      arrivalDate: israelDate(11),
    });
    const removed = await person("חייל שנמחק", "00008");
    await db
      .update(soldiers)
      .set({ deletedAt: new Date() })
      .where(eq(soldiers.id, removed));
    await command(member, "settings.save", {
      reminderHours: [24, 2],
      email: { ...allEmail, roundOpening: false },
    });

    // Before the window opens nothing is sent; repeated runs create one set.
    expect(await refresh(now - 120_000)).toBe(0);
    expect(await refresh(now)).toBe(1);
    expect(await refresh(now + 60_000)).toBe(0);
    const opening = await notices(round.id, "opening");
    expect(subjects(opening)).toEqual(
      sorted(
        manager.soldierId,
        secondManager.soldierId,
        member.soldierId,
        other.soldierId,
        withoutAccount
      )
    );
    expect(
      opening.find((row) => row.subjectId === withoutAccount)?.data.accountId
    ).toBeUndefined();
    const emails = await roundEmails(round.id);
    expect(emails.map((row) => row.recipientAccountId).sort()).toEqual(
      sorted(manager.id, secondManager.id, member.id, other.id)
    );
    expect(new Set(emails.map((row) => row.kind))).toEqual(
      new Set(["round-opening"])
    );
    expect(emails[0].expiresAt.toISOString()).toBe(
      new Date(now + 3 * DAY).toISOString()
    );

    // Preferences are read at delivery: the site notice stays, the email is cancelled.
    expect(await deliverAll()).toEqual(
      sorted(
        roundEventKey(round.id, 0, "opening", manager.id),
        roundEventKey(round.id, 0, "opening", secondManager.id),
        roundEventKey(round.id, 0, "opening", other.id)
      )
    );
    const [muted] = (await roundEmails(round.id)).filter(
      (row) => row.recipientAccountId === member.id
    );
    expect(muted).toMatchObject({
      status: "cancelled",
      error: "preference_disabled",
    });

    // A soldier sees only their own notice and none of the delivery bookkeeping.
    const soldierView = await readState(member);
    expect(soldierView.roundNotices).toEqual([]);
    expect(
      soldierView.notifications.filter(
        (row) => (row as Record<string, unknown>).roundId === round.id
      )
    ).toHaveLength(1);
    const managerView = await readState(manager);
    expect(managerView.roundNotices).toEqual([
      expect.objectContaining({
        roundId: round.id,
        generation: 0,
        phase: "start",
        notice: "opening",
        status: "sent",
        recipients: 5,
        emails: 4,
      }),
    ]);
  });

  it("reminds only soldiers who have not submitted, and rechecks at delivery", async () => {
    const now = Date.now();
    const closesAt = now + 2 * DAY;
    const round = await openRound(now - 60_000, closesAt);
    await refresh(now);
    await deliverAll();
    // "No constraints" completes the submission; a rejected item is still a submission.
    await command(member, "constraint.submit", {
      roundId: round.id,
      none: true,
    });
    const item = await command(other, "constraint.submit", {
      roundId: round.id,
      startDate: israelDate(6),
      endDate: israelDate(6),
      reason: "סיבה סינתטית",
    });
    await command(
      manager,
      "constraint.review",
      { id: item.id, decision: "rejected", reason: "דחייה סינתטית" },
      1
    );

    const due = DateTime.fromMillis(closesAt, { zone: ZONE })
      .minus({ days: 1 })
      .toMillis();
    expect(await refresh(due - 60_000)).toBe(0);
    expect(await refresh(due)).toBe(1);
    expect(await refresh(due + 60_000)).toBe(0);
    const closing = await notices(round.id, "closing");
    expect(subjects(closing)).toEqual(
      sorted(manager.soldierId, secondManager.soldierId)
    );
    expect(closing[0].data.body).toContain(
      DateTime.fromMillis(closesAt, { zone: ZONE }).toFormat("dd.MM.yyyy HH:mm")
    );

    // Submitting between queueing and delivery cancels that soldier's reminder.
    await command(secondManager, "constraint.submit", {
      roundId: round.id,
      none: true,
    });
    expect(await deliverAll()).toEqual([
      roundEventKey(round.id, 0, "closing", manager.id),
    ]);
    const [late] = (await roundEmails(round.id)).filter(
      (row) =>
        row.recipientAccountId === secondManager.id &&
        row.kind === "round-closing"
    );
    expect(late.status).toBe("cancelled");
  });

  it("cancels on closing and starts a new generation on reopening or extension", async () => {
    const now = Date.now();
    const round = await openRound(now - 60_000, now + 3 * DAY);
    await command(member, "constraint.submit", {
      roundId: round.id,
      none: true,
    });
    await refresh(now);
    await command(manager, "round.close", { id: round.id }, 1);
    expect(
      (await roundEmails(round.id)).every(
        (row) => row.status === "cancelled" && row.error === "superseded"
      )
    ).toBe(true);
    expect(await refresh(now + 60_000)).toBe(0);
    expect(await deliverAll()).toEqual([]);

    // Reopening a closed round: only soldiers who have not submitted.
    await command(
      manager,
      "round.reopen",
      { id: round.id, closesAt: new Date(now + 2 * DAY).toISOString() },
      2
    );
    expect((await roundRecord(round.id)).data).toMatchObject({
      reopenKind: "reopen",
      reopenCount: 1,
    });
    expect(await refresh(Date.now())).toBe(1);
    expect(subjects(await notices(round.id, "reopening"))).toEqual(
      sorted(manager.soldierId, secondManager.soldierId, other.soldierId)
    );

    // Extending an open round is also a new generation; the old one is cancelled.
    await command(
      manager,
      "round.reopen",
      { id: round.id, closesAt: new Date(now + 30 * HOUR).toISOString() },
      3
    );
    expect((await roundRecord(round.id)).data).toMatchObject({
      reopenKind: "extension",
      reopenCount: 2,
    });
    expect(
      (await roundEmails(round.id)).filter((row) => row.status === "pending")
    ).toEqual([]);
    expect(await refresh(Date.now())).toBe(1);
    expect(subjects(await notices(round.id, "extension"))).toEqual(
      sorted(manager.soldierId, secondManager.soldierId, other.soldierId)
    );
    // An email of an older generation is never delivered.
    await db.transaction((tx) =>
      enqueueEmail(tx, {
        recipientAccountId: other.id,
        eventKey: roundEventKey(round.id, 1, "closing", other.id),
        kind: "round-closing",
        title: "תזכורת ישנה",
        body: "תוכן סינתטי",
        expiresAt: new Date(now + DAY),
      })
    );
    const sent = await deliverAll();
    expect(sent).toHaveLength(3);
    expect(sent.every((key) => key.startsWith(`round:${round.id}:2:`))).toBe(
      true
    );
    const due = DateTime.fromMillis(now + 30 * HOUR, { zone: ZONE })
      .minus({ days: 1 })
      .toMillis();
    expect(await refresh(due)).toBe(1);
    expect(
      (await markers(round.id))
        .map(
          (row) => `${row.generation}:${row.phase}:${row.notice}:${row.status}`
        )
        .sort()
    ).toEqual(
      sorted(
        "0:start:opening:sent",
        "1:start:reopening:sent",
        "2:start:extension:sent",
        "2:closing:closing:sent"
      )
    );
  });

  it("skips stale notices after downtime and merges an overdue opening", async () => {
    const now = Date.now();
    // Down since before opening, back less than a day before closing.
    const late = await openRound(now - 3 * DAY, now + 12 * HOUR);
    await command(member, "constraint.submit", {
      roundId: late.id,
      none: true,
    });
    // Down until after closing, without an explicit close.
    const missed = await openRound(now - 3 * DAY, now - HOUR);
    expect(await refresh(now)).toBe(2);
    expect(await notices(late.id, "opening")).toEqual([]);
    expect(subjects(await notices(late.id, "closing"))).toEqual(
      sorted(manager.soldierId, secondManager.soldierId, other.soldierId)
    );
    expect(
      (await markers(late.id)).map((row) => `${row.phase}:${row.status}`).sort()
    ).toEqual(["closing:sent", "start:merged"]);
    expect(await markers(missed.id)).toEqual([]);
    expect(await deliverAll()).toHaveLength(3);

    // An email still queued when the window ends is skipped, not sent late.
    const short = await openRound(now - 60_000, now + HOUR);
    await refresh(now);
    expect(await deliverAll(now + 2 * HOUR)).toEqual([]);
    expect(
      (await roundEmails(short.id)).every((row) => row.status === "cancelled")
    ).toBe(true);
  });

  it("sends no closing reminder in a window shorter than a day", async () => {
    const now = Date.now();
    const round = await openRound(now - 60_000, now + 23 * HOUR);
    expect(await refresh(now)).toBe(1);
    expect(await refresh(now + 22 * HOUR)).toBe(0);
    expect((await markers(round.id)).map((row) => row.phase)).toEqual([
      "start",
    ]);
  });

  it("keeps one set of notices when workers run concurrently", async () => {
    const now = Date.now();
    const round = await openRound(now - 60_000, now + 3 * DAY);
    const results = await Promise.all([refresh(now), refresh(now)]);
    expect(results.sort()).toEqual([0, 1]);
    expect(await notices(round.id, "opening")).toHaveLength(4);
    expect(await roundEmails(round.id)).toHaveLength(4);
  });

  it("schedules by the Israeli calendar when winter time starts", async () => {
    // The next last Sunday of October, when Israel moves back to winter time.
    let year = DateTime.now().setZone(ZONE).year;
    let closes: DateTime;
    for (;;) {
      const lastDay = DateTime.fromObject(
        { year, month: 10, day: 31, hour: 10 },
        { zone: ZONE }
      );
      closes = lastDay.minus({ days: lastDay.weekday % 7 });
      if (closes.toMillis() - Date.now() > 3 * DAY) break;
      year++;
    }
    const round = await openRound(Date.now() - 60_000, closes.toMillis());
    const due = closes.minus({ days: 1 });
    expect(closes.toMillis() - due.toMillis()).toBe(25 * HOUR);
    await refresh(Date.now());
    expect(await refresh(due.toMillis() - 60_000)).toBe(0);
    expect(await refresh(due.toMillis())).toBe(1);
    const [reminder] = await notices(round.id, "closing");
    expect(reminder.data.body).toContain(
      closes.toFormat("dd.MM.yyyy") + " 10:00"
    );
  });
});
