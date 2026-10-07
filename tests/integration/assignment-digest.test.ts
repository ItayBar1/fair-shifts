import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import {
  assignmentMailEvent,
  assignmentMailWindow,
  balances,
  duties,
  emailOutbox,
  emailQuota,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import { operationsState } from "../../src/server/auth-schema";
import {
  createInvitedAccount,
  deleteAccountAuth,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import { announceAssignment } from "../../src/server/assignment-mail";
import {
  deliverNextEmail,
  quotaDay,
  type MailMessage,
} from "../../src/server/operations/email";
import { DIGEST_KIND } from "../../src/domain/assignment-digest";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
let manager: Actor;
let member: Actor;
let other: Actor;
let typeId: string;

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
/** A one-seat duty held by the soldier, published now; it starts after `startsIn`. */
async function publishedDuty(name: string, startsIn: number, holder = member) {
  const start = Date.now() + startsIn;
  const duty = await command(manager, "duty.create", {
    typeId,
    name,
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
  const published = await command(
    manager,
    "duty.publish",
    { id: row.id, confirmed: true },
    2
  );
  return { id: row.id, version: published.version, start };
}
const cancelDuty = (id: string, version: number) =>
  command(
    manager,
    "duty.cancel",
    { id, reason: "ביטול סינתטי", confirmed: true },
    version
  );
const windows = () =>
  db
    .select()
    .from(assignmentMailWindow)
    .orderBy(asc(assignmentMailWindow.opensAt));
const digests = () =>
  db.select().from(emailOutbox).where(eq(emailOutbox.kind, DIGEST_KIND));
const eventsOf = (windowId: string) =>
  db
    .select()
    .from(assignmentMailEvent)
    .where(eq(assignmentMailEvent.windowId, windowId))
    .orderBy(asc(assignmentMailEvent.seq));
/** Mail delivered when the clock reads `at`. */
async function deliver(at: number) {
  const sent: MailMessage[] = [];
  for (let index = 0; index < 20; index++) {
    const result = await deliverNextEmail(async (message) => {
      sent.push(message);
      return `synthetic-${message.eventKey}`;
    }, new Date(at));
    if (result.status === "idle") break;
  }
  return sent;
}
const notices = async (actor: Actor) =>
  (await readState(actor)).notifications as unknown as {
    id: string;
    title: string;
    body: string;
    href?: string;
    readAt?: string;
  }[];
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
  typeId = (
    await command(manager, "dutyType.save", {
      name: "שמירה סינתטית",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 1 }],
    })
  ).id;
});
afterAll(async () => pool.end());

describe("one mail and one site notice for several assignments", () => {
  it("gathers publications of a window into one notice and one mail, sent when the window closes", async () => {
    const t0 = Date.now();
    const first = await publishedDuty("תורנות ראשונה", 3 * DAY);
    // The first announcement writes the notice at once, as a lone publication always did.
    expect(await notices(member)).toMatchObject([
      {
        title: "פורסם שיבוץ לתורנות",
        body: "שובצת לתורנות תורנות ראשונה",
        href: `/duties/${first.id}`,
      },
    ]);
    const second = await publishedDuty("תורנות שנייה", 4 * DAY);
    const third = await publishedDuty("תורנות שלישית", 5 * DAY);
    // One notice for the window, rewritten with the new count and a new target.
    expect(await notices(member)).toMatchObject([
      {
        title: "שובצת ל־3 תורנויות",
        href: "/my-assignments",
      },
    ]);
    const [window] = await windows();
    expect(await windows()).toHaveLength(1);
    expect(window.closesAt.getTime() - window.opensAt.getTime()).toBe(
      10 * MINUTE
    );
    expect((await eventsOf(window.id)).map((event) => event.dutyId)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
    // The mail waits for the window to close.
    const [queued] = await digests();
    expect(await digests()).toHaveLength(1);
    expect(queued).toMatchObject({
      id: window.id,
      eventKey: `digest:${window.id}`,
      status: "pending",
      recipientAccountId: member.id,
    });
    expect(queued.nextAttemptAt.getTime()).toBe(window.closesAt.getTime());
    expect(await deliver(t0 + 5 * MINUTE)).toEqual([]);

    const sent = await deliver(t0 + 11 * MINUTE);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "00001@example.invalid",
      subject: "שובצת ל־3 תורנויות",
    });
    for (const [duty, name] of [
      [first, "תורנות ראשונה"],
      [second, "תורנות שנייה"],
      [third, "תורנות שלישית"],
    ] as const) {
      expect(sent[0].text).toContain(`• ${name} — `);
      expect(sent[0].text).toContain(`/duties/${duty.id}`);
    }
    expect(sent[0].text).toContain(`לכל השיבוצים שלי (נדרשת כניסה): `);
    expect(sent[0].text).toContain(`/my-assignments?mail=${window.id}`);
    // Nothing of other soldiers, points or reasons.
    for (const hidden of ["חייל נוסף", "אחראי לבדיקה", "נקודות", "ביטול"])
      expect(sent[0].text).not.toContain(hidden);
    // The mail counts once, and the window is shut.
    expect(await digests()).toMatchObject([{ status: "sent" }]);
    expect((await digests())[0].dutyIds.sort()).toEqual(
      [first.id, second.id, third.id].sort()
    );
    const [quota] = await db
      .select()
      .from(emailQuota)
      .where(eq(emailQuota.day, quotaDay(new Date(t0 + 11 * MINUTE))));
    expect(quota.used).toBe(1);
    expect((await windows())[0].status).toBe("closed");
    // Run again, or by a second worker: the window is not sent twice.
    expect(await deliver(t0 + 12 * MINUTE)).toEqual([]);
  });

  it("sends a window of one duty in the structure of a lone publication mail", async () => {
    const t0 = Date.now();
    const only = await publishedDuty("תורנות יחידה", 3 * DAY);
    const sent = await deliver(t0 + 11 * MINUTE);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("פורסם שיבוץ לתורנות");
    expect(sent[0].text).toContain("שובצת לתורנות תורנות יחידה");
    expect(sent[0].text).toContain(`/duties/${only.id}`);
    expect(sent[0].text).not.toContain("/my-assignments");
    const [row] = await digests();
    expect(row).toMatchObject({
      title: "פורסם שיבוץ לתורנות",
      href: `/duties/${only.id}`,
    });
  });

  it("does not extend the window: an event after ten minutes opens a new window and a second mail", async () => {
    const t0 = Date.now();
    await publishedDuty("תורנות ראשונה", 3 * DAY);
    const later = await publishedDuty("תורנות שנייה", 4 * DAY);
    const [opened] = await windows();
    // Nine minutes in still joins the first window.
    const join = await publishedDuty("תורנות שלישית", 5 * DAY);
    await unitTransaction((tx) =>
      announceAssignment(
        tx,
        {
          soldierId: member.soldierId!,
          duty: {
            id: join.id,
            name: "תורנות שלישית",
            start: new Date(join.start).toISOString(),
            end: new Date(join.start + 8 * HOUR).toISOString(),
          },
          dutyVersion: 50,
          change: "updated",
        },
        new Date(t0 + 9 * MINUTE)
      )
    );
    expect(await windows()).toHaveLength(1);
    expect(await eventsOf(opened.id)).toHaveLength(4);
    // Eleven minutes in the window is over, whatever came in between.
    await unitTransaction((tx) =>
      announceAssignment(
        tx,
        {
          soldierId: member.soldierId!,
          duty: {
            id: later.id,
            name: "תורנות שנייה",
            start: new Date(later.start).toISOString(),
            end: new Date(later.start + 8 * HOUR).toISOString(),
          },
          dutyVersion: 51,
          change: "updated",
        },
        new Date(t0 + 11 * MINUTE)
      )
    );
    const all = await windows();
    expect(all).toHaveLength(2);
    expect(all[0].status).toBe("closed");
    expect(all[1].status).toBe("open");
    expect(all[1].opensAt.getTime()).toBe(t0 + 11 * MINUTE);
    expect(await eventsOf(all[1].id)).toHaveLength(1);
    const sent = await deliver(t0 + 12 * MINUTE);
    expect(sent.map((message) => message.eventKey)).toEqual([
      `digest:${all[0].id}`,
    ]);
    const next = await deliver(t0 + 22 * MINUTE);
    expect(next.map((message) => message.eventKey)).toEqual([
      `digest:${all[1].id}`,
    ]);
    expect(next[0].subject).toBe("עודכנה תורנות שפורסמה");
  });

  it("sends a duty starting within two hours at once and apart, and keeps the rest in the window", async () => {
    const t0 = Date.now();
    const soon = await publishedDuty("תורנות קרובה", HOUR);
    const far = await publishedDuty("תורנות רחוקה", 3 * DAY);
    const other2 = await publishedDuty("תורנות רחוקה נוספת", 4 * DAY);
    // The near duty has its own notice; the two far ones share the window's.
    const titles = (await notices(member)).map((row) => row.title).sort();
    expect(titles).toEqual(["פורסם שיבוץ לתורנות", "שובצת ל־2 תורנויות"]);
    const immediate = await db
      .select()
      .from(emailOutbox)
      .where(
        eq(
          emailOutbox.eventKey,
          `publish:${soon.id}:${soon.version}:${member.id}`
        )
      );
    expect(immediate).toMatchObject([
      { kind: "publication", status: "pending" },
    ]);
    const sent = await deliver(t0 + MINUTE);
    expect(sent.map((message) => message.eventKey)).toEqual([
      `publish:${soon.id}:${soon.version}:${member.id}`,
    ]);
    expect(sent[0].text).toContain("שובצת לתורנות תורנות קרובה");
    const window = (await windows())[0];
    expect((await eventsOf(window.id)).map((event) => event.dutyId)).toEqual([
      far.id,
      other2.id,
    ]);
    const rest = await deliver(t0 + 11 * MINUTE);
    expect(rest).toHaveLength(1);
    expect(rest[0].text).not.toContain("תורנות קרובה");
    expect(rest[0].text).toContain("תורנות רחוקה");
  });

  it("leaves out a duty published and cancelled in the same window, and sends nothing when none is left", async () => {
    const t0 = Date.now();
    const kept = await publishedDuty("תורנות נשמרת", 3 * DAY);
    const dropped = await publishedDuty("תורנות שבוטלה", 4 * DAY);
    await cancelDuty(dropped.id, dropped.version);
    // The notice keeps both: the cancellation is news to a soldier who saw the publication.
    expect(await notices(member)).toMatchObject([
      { title: "עדכונים ב־2 תורנויות שלך" },
    ]);
    expect((await notices(member))[0].body).toContain(
      "שיבוצים חדשים: 1 · בוטלו: 1"
    );
    const sent = await deliver(t0 + 11 * MINUTE);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("פורסם שיבוץ לתורנות");
    expect(sent[0].text).toContain("תורנות נשמרת");
    expect(sent[0].text).toContain(`/duties/${kept.id}`);
    expect(sent[0].text).not.toContain("תורנות שבוטלה");
    expect(
      (await digests()).find((mail) => mail.status === "sent")?.dutyIds
    ).toEqual([kept.id]);

    // A window with only the cancelled duty has nothing to say, and the mail is not sent.
    const lone = await publishedDuty("תורנות יחידה שבוטלה", 6 * DAY);
    await cancelDuty(lone.id, lone.version);
    expect(await deliver(t0 + 30 * MINUTE)).toEqual([]);
    expect(
      (await digests()).filter((row) => row.status === "cancelled")
    ).toMatchObject([{ error: "not_relevant" }]);
  });

  it("announces the cancellation of a duty the soldier already knew in a window of its own", async () => {
    const t0 = Date.now();
    const known = await publishedDuty("תורנות מוכרת", 3 * DAY);
    expect(await deliver(t0 + 11 * MINUTE)).toHaveLength(1);
    await cancelDuty(known.id, known.version);
    const all = await windows();
    expect(all).toHaveLength(2);
    expect(all[1].status).toBe("open");
    // A window of its own has its own notice, next to the one of the publication.
    const shown = await notices(member);
    expect(shown).toHaveLength(2);
    expect(shown).toContainEqual(
      expect.objectContaining({
        title: "התורנות בוטלה",
        body: "התורנות תורנות מוכרת בוטלה. השיבוץ שלך לתורנות זו אינו בתוקף.",
        href: `/duties/${known.id}`,
      })
    );
    const sent = await deliver(t0 + 25 * MINUTE);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("התורנות בוטלה");
    expect(sent[0].text).toContain(`/duties/${known.id}`);
  });

  it("shows a read or hidden notice again, unread, when an event joins its window", async () => {
    await publishedDuty("תורנות ראשונה", 3 * DAY);
    const [notice] = await notices(member);
    await command(member, "notification.read", { id: notice.id });
    await command(member, "notification.hide", { id: notice.id });
    expect(await notices(member)).toEqual([]);
    await publishedDuty("תורנות שנייה", 4 * DAY);
    const [again] = await notices(member);
    expect(again).toMatchObject({ id: notice.id, title: "שובצת ל־2 תורנויות" });
    expect(again.readAt).toBeUndefined();
    const [row] = await db
      .select()
      .from(records)
      .where(eq(records.id, notice.id));
    expect(row.data).not.toHaveProperty("hiddenAt");
    expect(row.data).not.toHaveProperty("readAt");
    // One notice only, in a window of two.
    expect(
      (await db.select().from(records)).filter(
        (item) =>
          item.kind === "notification" && item.subjectId === member.soldierId
      )
    ).toHaveLength(1);
  });

  it("does not mail a switched-off type, and still writes the notice", async () => {
    await command(member, "settings.save", {
      reminders: [{ hours: 2, email: true, calendar: true }],
      email: { ...allEmail, publication: false },
    });
    const t0 = Date.now();
    await publishedDuty("תורנות ראשונה", 3 * DAY);
    await publishedDuty("תורנות שנייה", 4 * DAY);
    expect(await notices(member)).toMatchObject([
      { title: "שובצת ל־2 תורנויות" },
    ]);
    expect(await deliver(t0 + 11 * MINUTE)).toEqual([]);
    expect(await digests()).toMatchObject([
      { status: "cancelled", error: "preference_disabled" },
    ]);
    const used = await db.select().from(emailQuota);
    expect(used.every((row) => row.used === 0)).toBe(true);
  });

  it("checks preferences at delivery, not when the window opened", async () => {
    const saved = await command(member, "settings.save", {
      reminders: [{ hours: 2, email: true, calendar: true }],
      email: { ...allEmail, publication: false },
    });
    const t0 = Date.now();
    await publishedDuty("תורנות ראשונה", 3 * DAY);
    await command(
      member,
      "settings.save",
      {
        reminders: [{ hours: 2, email: true, calendar: true }],
        email: allEmail,
      },
      saved.version
    );
    expect(await deliver(t0 + 11 * MINUTE)).toHaveLength(1);
  });

  it("keeps a window that closes while mail is paused and sends it when mail comes back", async () => {
    const t0 = Date.now();
    await publishedDuty("תורנות ראשונה", 3 * DAY);
    await publishedDuty("תורנות שנייה", 4 * DAY);
    await db.insert(operationsState).values({
      key: "mail",
      data: {
        pausedUntil: new Date(t0 + 3 * HOUR).toISOString(),
        pauseReason: "configuration",
      },
    });
    expect(await deliver(t0 + 11 * MINUTE)).toEqual([]);
    expect(await digests()).toMatchObject([{ status: "pending" }]);
    const sent = await deliver(t0 + 4 * HOUR);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("שובצת ל־2 תורנויות");
  });

  it("puts events of two announcements made at the same time into one window", async () => {
    const t0 = Date.now();
    const first = await publishedDuty("תורנות ראשונה", 3 * DAY, other);
    const second = await publishedDuty("תורנות שנייה", 4 * DAY, other);
    // Fresh windows for the member only, announced from two transactions at once.
    const input = (
      duty: { id: string; start: number },
      name: string,
      version: number
    ) => ({
      soldierId: member.soldierId!,
      duty: {
        id: duty.id,
        name,
        start: new Date(duty.start).toISOString(),
        end: new Date(duty.start + 8 * HOUR).toISOString(),
      },
      dutyVersion: version,
      change: "updated" as const,
    });
    await Promise.all([
      db.transaction((tx) =>
        announceAssignment(tx, input(first, "תורנות ראשונה", 70), new Date(t0))
      ),
      db.transaction((tx) =>
        announceAssignment(tx, input(second, "תורנות שנייה", 71), new Date(t0))
      ),
    ]);
    const mine = (await windows()).filter(
      (item) => item.recipientAccountId === member.id
    );
    expect(mine).toHaveLength(1);
    expect(await eventsOf(mine[0].id)).toHaveLength(2);
    expect(
      (await digests()).filter((row) => row.recipientAccountId === member.id)
    ).toHaveLength(1);
    // The same announcement made again changes nothing.
    await unitTransaction((tx) =>
      announceAssignment(tx, input(first, "תורנות ראשונה", 70), new Date(t0))
    );
    expect(await eventsOf(mine[0].id)).toHaveLength(2);
  });

  it("does not send a window twice when two workers claim at once", async () => {
    const t0 = Date.now();
    await publishedDuty("תורנות ראשונה", 3 * DAY);
    await publishedDuty("תורנות שנייה", 4 * DAY);
    const sent: MailMessage[] = [];
    const results = await Promise.all(
      [1, 2].map(() =>
        deliverNextEmail(
          async (message) => {
            sent.push(message);
            return "synthetic";
          },
          new Date(t0 + 11 * MINUTE)
        )
      )
    );
    expect(sent).toHaveLength(1);
    expect(results.filter((item) => item.status === "sent")).toHaveLength(1);
  });

  it("opens a new window when the mail of the open one is gone", async () => {
    const t0 = Date.now();
    await publishedDuty("תורנות ראשונה", 3 * DAY);
    // A restore cancels the queued mail; the window must not wait for it any more.
    await db
      .update(emailOutbox)
      .set({ status: "cancelled", error: "restored" });
    await publishedDuty("תורנות שנייה", 4 * DAY);
    const all = await windows();
    expect(all).toHaveLength(2);
    const sent = await deliver(t0 + 11 * MINUTE);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("פורסם שיבוץ לתורנות");
    expect(sent[0].text).toContain("תורנות שנייה");
  });

  it("closes the windows of a deleted account, sends it nothing and drops later announcements", async () => {
    const t0 = Date.now();
    const duty = await publishedDuty("תורנות ראשונה", 3 * DAY);
    await deleteAccountAuth(member.id);
    expect((await windows())[0].status).toBe("closed");
    expect(await deliver(t0 + 11 * MINUTE)).toEqual([]);
    await unitTransaction((tx) =>
      announceAssignment(tx, {
        soldierId: member.soldierId!,
        duty: {
          id: duty.id,
          name: "תורנות ראשונה",
          start: new Date(duty.start).toISOString(),
          end: new Date(duty.start + 8 * HOUR).toISOString(),
        },
        dutyVersion: 90,
        change: "updated",
      })
    );
    expect(await windows()).toHaveLength(1);
    expect(await eventsOf((await windows())[0].id)).toHaveLength(1);
  });
});
