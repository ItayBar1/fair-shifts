import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import {
  assignments,
  balances,
  duties,
  dutySlots,
  dutyTypes,
  ledger,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { HISTORY_DAYS, readHistory, readState } from "../../src/server/state";
import { assignment, duty, soldier, testIdNumber } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// A soldier's lists start 90 days back; earlier slices come on request
// (decision 235). Synthetic people and duties only.
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
let member: Actor;
let other: Actor;
let staff: Actor;
let typeId: string;
let serial = 0;

async function person(
  name: string,
  role: "soldier" | "manager"
): Promise<Actor> {
  const id = randomUUID();
  serial++;
  await db.insert(soldiers).values({
    id,
    name,
    idNumber: testIdNumber(500 + serial),
    data: soldier({ id, name }),
  });
  await db.insert(soldierContacts).values({
    soldierId: id,
    email: `history-${serial}@example.invalid`,
    phone: `05000000${serial}`,
  });
  await db.insert(balances).values({ soldierId: id, current: 5 });
  const account = await createInvitedAccount({
    name,
    role,
    email: `history-${serial}@example.invalid`,
    soldierId: id,
  });
  return { id: account.id, name, role, soldierId: id, securityEpoch: 1 };
}
/** A published duty that ended `endedDaysAgo` days ago, with the soldier's seat. */
async function pastDuty(
  name: string,
  endedDaysAgo: number,
  seat: { soldierId: string; status: string }
) {
  const id = randomUUID();
  const slotId = randomUUID();
  const end = ago(endedDaysAgo);
  const data = {
    ...duty({
      id,
      typeId,
      name,
      start: new Date(end.getTime() - 8 * 3_600_000).toISOString(),
      end: end.toISOString(),
      status: "published",
      slots: [{ id: slotId, role: "תורן" }],
    }),
    location: "מיקום סינתטי",
    instructions: "",
  };
  await db.insert(duties).values({ id, typeId, name, data });
  await db.insert(dutySlots).values({ id: slotId, dutyId: id, data: {} });
  const row = assignment({
    id: randomUUID(),
    dutyId: id,
    slotId,
    soldierId: seat.soldierId,
    status: seat.status as "credited",
  });
  await db.insert(assignments).values({ ...row, data: row });
  return id;
}
async function scoreAt(soldierId: string, daysAgo: number, amount: number) {
  await db.insert(ledger).values({
    id: randomUUID(),
    soldierId,
    sourceKey: `history:${randomUUID()}`,
    kind: "adjustment",
    before: 0,
    after: amount,
    amount,
    actorId: staff.id,
    reason: "סיבה של אחראי",
    effectiveAt: ago(daysAgo),
  });
}
async function noticeAt(accountId: string, daysAgo: number, title: string) {
  await db.insert(records).values({
    id: randomUUID(),
    kind: "notification",
    data: { accountId, title, body: "גוף" },
    createdAt: ago(daysAgo),
    updatedAt: ago(daysAgo),
  });
}
const names = (list: unknown[]) =>
  list.map(
    (row) =>
      (row as { name?: string; title?: string }).name ??
      (row as { title?: string }).title
  );

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  serial = 0;
  member = await person("חייל ההיסטוריה", "soldier");
  other = await person("חייל אחר", "soldier");
  staff = await person("אחראי ההיסטוריה", "manager");
  typeId = randomUUID();
  await db
    .insert(dutyTypes)
    .values({ id: typeId, name: "סוג סינתטי", data: {} });
});
afterAll(async () => pool.end());

describe("a soldier's history window (decision 235)", () => {
  it("shows the last 90 days, and says that more is available", async () => {
    await pastDuty("תורנות חדשה", 10, {
      soldierId: member.soldierId!,
      status: "credited",
    });
    await pastDuty("תורנות ישנה", HISTORY_DAYS + 10, {
      soldierId: member.soldierId!,
      status: "credited",
    });
    await scoreAt(member.soldierId!, 5, 3);
    await scoreAt(member.soldierId!, HISTORY_DAYS + 5, 7);
    await noticeAt(member.id, 3, "הודעה חדשה");
    await noticeAt(member.id, HISTORY_DAYS + 3, "הודעה ישנה");

    const state = await readState(member);
    expect(names(state.duties)).toEqual(["תורנות חדשה"]);
    expect(state.assignments).toHaveLength(1);
    expect(state.ledger.map((row) => row.amount)).toEqual([3]);
    expect(names(state.notifications)).toEqual(["הודעה חדשה"]);
    expect(state.history?.olderAvailable).toBe(true);
    const from = Date.parse(state.history!.from);
    expect(Math.abs(from - ago(HISTORY_DAYS).getTime())).toBeLessThan(60_000);
  });

  it("reads the earlier slice with the same view, and then says there is no more", async () => {
    await pastDuty("תורנות ישנה", HISTORY_DAYS + 10, {
      soldierId: member.soldierId!,
      status: "credited",
    });
    await scoreAt(member.soldierId!, HISTORY_DAYS + 5, 7);
    await noticeAt(member.id, HISTORY_DAYS + 3, "הודעה ישנה");
    await noticeAt(other.id, HISTORY_DAYS + 3, "הודעה של אחר");
    const state = await readState(member);
    const older = await readHistory(member, new Date(state.history!.from));
    expect(names(older.duties)).toEqual(["תורנות ישנה"]);
    expect(older.assignments).toHaveLength(1);
    expect(older.ledger).toEqual([
      expect.objectContaining({ amount: 7, soldierId: member.soldierId }),
    ]);
    // A soldier never gets a manager's reason, nor another account's notice.
    expect(JSON.stringify(older)).not.toContain("סיבה של אחראי");
    expect(names(older.notifications)).toEqual(["הודעה ישנה"]);
    expect(older.olderAvailable).toBe(false);
    // The slice ends where the next one starts.
    expect(Date.parse(older.from)).toBe(
      Date.parse(state.history!.from) - HISTORY_DAYS * DAY
    );
  });

  it("keeps a seat that still holds points, however long ago its duty ended", async () => {
    await pastDuty("תורנות שעדיין מחזיקה ניקוד", HISTORY_DAYS + 30, {
      soldierId: other.soldierId!,
      status: "held",
    });
    const state = await readState(member);
    expect(names(state.duties)).toEqual(["תורנות שעדיין מחזיקה ניקוד"]);
    const row = state.soldiers.find((item) => item.id === other.soldierId);
    expect(row?.futureScore).toBe(4);
  });

  it("gives a manager everything, with no window and nothing to load", async () => {
    await pastDuty("תורנות ישנה", HISTORY_DAYS + 10, {
      soldierId: member.soldierId!,
      status: "credited",
    });
    await scoreAt(member.soldierId!, HISTORY_DAYS + 5, 7);
    await noticeAt(member.id, 1, "הודעה של חייל");
    const state = await readState(staff);
    expect(names(state.duties)).toEqual(["תורנות ישנה"]);
    expect(state.ledger.map((row) => row.amount)).toEqual([7]);
    expect(state.history).toBeUndefined();
    // Another account's notices are not read for a manager either.
    expect(names(state.notifications)).toEqual([]);
    const older = await readHistory(staff, new Date());
    expect(older).toMatchObject({ duties: [], olderAvailable: false });
  });

  it("reads only the soldier's own contact details", async () => {
    const state = await readState(member);
    expect((state as { myProfile?: { phone?: string } }).myProfile?.phone).toBe(
      "050000001"
    );
    expect(JSON.stringify(state)).not.toContain("050000002");
  });

  it("refuses an account whose session changed, as the state does", async () => {
    await expect(
      readHistory({ ...member, securityEpoch: 9 }, new Date())
    ).rejects.toMatchObject({ status: 401 });
  });
});
