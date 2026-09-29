import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool, unitTransaction } from "../../src/server/db";
import { emailOutbox, session, user } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
  ledger,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  accountAvailable,
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { requestCode } from "../../src/server/auth/otp";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import { deliverNextEmail } from "../../src/server/operations/email";
import { settleDue } from "../../src/server/scoring";
import { refreshRankReminders } from "../../src/server/ranks";
import { announceDepartures } from "../../src/server/departures";
import type { Soldier } from "../../src/domain/types";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

let manager: Actor;
let secondManager: Actor;
let member: Actor;
let other: Actor;
const israelDate = (days = 0) =>
  DateTime.now().setZone("Asia/Jerusalem").plus({ days }).toISODate()!;

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
/** Writes stored service dates directly, as a date that has since passed would stand. */
async function setService(
  actor: Actor,
  service: Partial<Soldier["service"]>,
  extra: Partial<Soldier> = {}
) {
  const [row] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, actor.soldierId!));
  await db
    .update(soldiers)
    .set({
      data: {
        ...row.data,
        ...extra,
        service: { ...row.data.service, ...service },
      },
    })
    .where(eq(soldiers.id, row.id));
}
const announce = (now = new Date()) =>
  unitTransaction((tx) => announceDepartures(tx, now));
async function notices(actor: Actor) {
  const rows = (await readState(actor)).notifications as Record<
    string,
    unknown
  >[];
  return rows.filter((row) => row.title === "סיום שירות");
}
/** A published duty from tomorrow to the day after, held by member and other. */
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
async function memberAssignment(dutyId: string) {
  const [row] = await db
    .select()
    .from(assignments)
    .where(
      and(
        eq(assignments.dutyId, dutyId),
        eq(assignments.soldierId, member.soldierId!)
      )
    );
  return row;
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("אחראי ראשון", "manager", "00101");
  secondManager = await invite("אחראי שני", "manager", "00102");
  member = await invite("חייל משתחרר", "soldier", "00103");
  other = await invite("חייל אחר", "soldier", "00104");
});
afterAll(async () => pool.end());

describe("end of service", () => {
  it("refuses every request from the local midnight after the release day, before any worker run", async () => {
    await setService(member, { releaseDate: israelDate() });
    await expect(readState(member)).resolves.toBeDefined();
    await setService(member, { releaseDate: israelDate(-1) });
    await expect(readState(member)).rejects.toMatchObject({ status: 401 });
    await expect(
      command(member, "settings.save", {
        reminderHours: [2],
        email: {
          dutyReminder: true,
          roundOpening: true,
          roundClosing: true,
          publication: true,
          transfer: true,
          departure: true,
        },
      })
    ).rejects.toMatchObject({ status: 401 });
    // A new sign-in code is neither created nor mailed.
    await requestCode("00103@example.invalid");
    expect(
      await db
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.kind, "login-code"))
    ).toHaveLength(0);
    // Nothing was deleted, locked or announced yet.
    const [row] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, member.soldierId!));
    expect(row.deletedAt).toBeNull();
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.id, member.id));
    expect(account.lockedAt).toBeNull();
    expect(
      await db.select().from(records).where(eq(records.kind, "departure"))
    ).toHaveLength(0);
  });

  it("applies the boundary at 00:00 Israel time with an explicit clock", async () => {
    await setService(member, { releaseDate: "2027-06-30" });
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.id, member.id));
    expect(
      await accountAvailable(account, db, new Date("2027-06-30T20:59:59Z"))
    ).toBe(true);
    expect(
      await accountAvailable(account, db, new Date("2027-06-30T21:00:00Z"))
    ).toBe(false);
  });

  it("keeps access during an inactive period", async () => {
    await setService(
      member,
      {},
      { inactivePeriods: [{ start: israelDate(-1), end: israelDate(1) }] }
    );
    await expect(readState(member)).resolves.toBeDefined();
    const person = (await readState(manager)).soldiers.find(
      (row) => row.id === member.soldierId
    );
    expect(person).toMatchObject({ serviceStatus: "inactive_period" });
  });

  it("announces a departure once to each manager across repeated runs, races and downtime, without deleting", async () => {
    const dutyId = await publishedDuty();
    await db.insert(session).values({
      id: "member-session",
      userId: member.id,
      token: "synthetic-member",
      securityEpoch: 1,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await setService(member, { releaseDate: israelDate(-1) });
    // Not yet released, and a deleted record, are never announced.
    await setService(other, { releaseDate: israelDate(30) });
    const settled = await Promise.all([announce(), announce()]);
    expect(settled.sort()).toEqual([0, 1]);
    expect(await announce()).toBe(0);
    // A worker returning after days of downtime finds the earlier record.
    expect(await announce(new Date(Date.now() + 5 * 86_400_000))).toBe(0);

    for (const recipient of [manager, secondManager]) {
      const received = await notices(recipient);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ href: "/manage/soldiers" });
      expect(String(received[0].body)).toContain("חייל משתחרר");
      expect(String(received[0].body)).toContain("1 שיבוצים");
    }
    await expect(readState(member)).rejects.toMatchObject({ status: 401 });
    expect(await notices(other)).toHaveLength(0);
    const state = await readState(manager);
    expect(state.departures).toEqual([
      expect.objectContaining({
        subjectId: member.soldierId,
        releaseDate: israelDate(-1),
        flaggedAssignments: 1,
      }),
    ]);
    expect(
      state.soldiers.find((row) => row.id === member.soldierId)
    ).toMatchObject({ serviceStatus: "service_ended", deletedAt: undefined });
    expect(
      await db.select().from(session).where(eq(session.userId, member.id))
    ).toHaveLength(0);
    // The reservation past the boundary stays, flagged for a manager.
    const held = await memberAssignment(dutyId);
    expect(held.status).toBe("reserved");
    expect(held.data.needsAttention).toContain("released");
    // Other roles see neither the departure nor the notice.
    expect((await readState(other)).departures).toEqual([]);
  });

  it("emails each manager once, subject to the departure switch at delivery", async () => {
    // The first manager turns the switch off after the email was queued.
    await command(manager, "settings.save", {
      reminderHours: [24, 2],
      email: {
        dutyReminder: true,
        roundOpening: true,
        roundClosing: true,
        publication: true,
        transfer: true,
        departure: true,
      },
    });
    await setService(member, { releaseDate: israelDate(-1) });
    expect(await announce()).toBe(1);
    expect(await announce()).toBe(0);
    const queued = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, "departure"));
    expect(queued.map((row) => row.recipientAccountId).sort()).toEqual(
      [manager.id, secondManager.id].sort()
    );
    const [saved] = await db
      .select()
      .from(records)
      .where(eq(records.kind, "settings"));
    await command(
      manager,
      "settings.save",
      {
        reminderHours: [24, 2],
        email: {
          dutyReminder: true,
          roundOpening: true,
          roundClosing: true,
          publication: true,
          transfer: true,
          departure: false,
        },
      },
      saved.version
    );
    const sent: string[] = [];
    for (let index = 0; index < 5; index++) {
      const result = await deliverNextEmail(
        async (message) => {
          sent.push(message.eventKey);
          return `synthetic-${message.eventKey}`;
        },
        new Date(Date.now() + 1000)
      );
      if (result.status === "idle") break;
    }
    expect(sent.filter((key) => key.startsWith("departure:"))).toEqual([
      expect.stringContaining(secondManager.id),
    ]);
    const [off] = await db
      .select()
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.kind, "departure"),
          eq(emailOutbox.recipientAccountId, manager.id)
        )
      );
    expect(off).toMatchObject({
      status: "cancelled",
      error: "preference_disabled",
    });
    // The site notice stays for both managers.
    expect(await notices(manager)).toHaveLength(1);
    expect(await notices(secondManager)).toHaveLength(1);
  });

  it("announces again only for a new release date once that date passes", async () => {
    await setService(member, { releaseDate: israelDate(-2) });
    expect(await announce()).toBe(1);
    // Service extended: access returns and nothing is announced.
    await setService(member, { releaseDate: israelDate(60) });
    await expect(readState(member)).resolves.toBeDefined();
    expect(await announce()).toBe(0);
    expect(
      (await readState(manager)).soldiers.find(
        (row) => row.id === member.soldierId
      )
    ).toMatchObject({ serviceStatus: "active" });
    await setService(member, { releaseDate: israelDate(-1) });
    expect(await announce()).toBe(1);
    expect(await notices(manager)).toHaveLength(2);
  });

  it("does not announce a deleted soldier or tell a released manager about themselves", async () => {
    await setService(manager, { releaseDate: israelDate(-1) });
    await db
      .update(soldiers)
      .set({ deletedAt: new Date() })
      .where(eq(soldiers.id, other.soldierId!));
    await setService(other, { releaseDate: israelDate(-1) });
    expect(await announce()).toBe(1);
    expect(await notices(secondManager)).toHaveLength(1);
    const own = await db
      .select()
      .from(records)
      .where(eq(records.kind, "notification"));
    expect(own.filter((row) => row.data.accountId === manager.id)).toHaveLength(
      0
    );
  });
});

describe("service dates", () => {
  it("flags an affected reservation when a date changes, without deleting it", async () => {
    const dutyId = await publishedDuty();
    const [before] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, member.soldierId!));
    // The duty ends after tonight's boundary, so a release today affects it.
    await command(
      manager,
      "soldier.update",
      {
        id: member.soldierId,
        name: before.name,
        personalNumber: before.personalNumber,
        population: "mandatory",
        serviceType: "mandatory",
        releaseDate: israelDate(),
      },
      before.version
    );
    const held = await memberAssignment(dutyId);
    expect(held.status).toBe("reserved");
    expect(held.data.needsAttention).toEqual(["released"]);
    const [duty] = await db.select().from(duties).where(eq(duties.id, dutyId));
    expect(duty.data.status).toBe("published");
    // The member still has access until the end of the day.
    await expect(readState(member)).resolves.toBeDefined();
  });

  it("grants grace only when marked eligible and leaves the balance when it ends", async () => {
    const created = await command(manager, "soldier.create", {
      name: "חייל חדש",
      personalNumber: "00105",
      email: "00105@example.invalid",
      arrivalDate: israelDate(-3),
    });
    const fresh = (await readState(manager)).soldiers.find(
      (row) => row.id === created.id
    );
    expect(fresh).toMatchObject({
      graceEligible: false,
      serviceStatus: "active",
    });
    expect(
      (fresh as Record<string, unknown> | undefined)?.graceUntil
    ).toBeUndefined();

    await setService(member, {
      arrivalDate: israelDate(-3),
      graceEligible: true,
    });
    const arrival = DateTime.fromISO(israelDate(-3), {
      zone: "Asia/Jerusalem",
    });
    expect(
      (await readState(manager)).soldiers.find(
        (row) => row.id === member.soldierId
      )
    ).toMatchObject({
      serviceStatus: "grace",
      graceUntil: arrival.plus({ months: 1 }).toISODate(),
    });

    // A month that has ended changes nothing in the balance or the ledger.
    await db
      .update(balances)
      .set({ current: 3 })
      .where(eq(balances.soldierId, member.soldierId!));
    await setService(member, {
      arrivalDate: israelDate(-40),
      graceEligible: true,
    });
    await unitTransaction(async (tx) => {
      await settleDue(tx);
      await refreshRankReminders(tx);
      await announceDepartures(tx);
    });
    const [balance] = await db
      .select()
      .from(balances)
      .where(eq(balances.soldierId, member.soldierId!));
    expect(balance.current).toBe(3);
    expect(
      await db
        .select()
        .from(ledger)
        .where(eq(ledger.soldierId, member.soldierId!))
    ).toHaveLength(0);
    expect(
      (await readState(manager)).soldiers.find(
        (row) => row.id === member.soldierId
      )
    ).toMatchObject({ serviceStatus: "active" });
  });
});
