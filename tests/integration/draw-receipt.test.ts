import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool } from "../../src/server/db";
import {
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
import { soldier, testIdNumber } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// A soldier sees how their own seat was drawn, in numbers only (decision 240).
// Synthetic people and duties only.
let manager: Actor;
let serial = 40;

async function invite(
  name: string,
  role: "soldier" | "manager",
  balance: number
): Promise<Actor> {
  const id = randomUUID();
  const number = String(serial++).padStart(5, "0");
  await db.insert(soldiers).values({
    id,
    name,
    idNumber: testIdNumber(number),
    data: soldier({ id, name }),
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: `receipt-${number}@example.invalid` });
  await db.insert(balances).values({ soldierId: id, current: balance });
  const row = await createInvitedAccount({
    name,
    role,
    email: `receipt-${number}@example.invalid`,
    soldierId: id,
  });
  return { id: row.id, name, role, soldierId: id, securityEpoch: 1 };
}
async function command(
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) {
  return (await executeAction(manager, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as Record<string, unknown> & { id: string; version: number };
}
async function dutyRow(id: string) {
  const [row] = await db.select().from(duties).where(eq(duties.id, id));
  return row;
}
type Receipt = Record<string, unknown>;
async function receipts(actor: Actor) {
  const state = (await readState(actor)) as { drawReceipts?: Receipt[] };
  return state.drawReceipts ?? [];
}
/** A draft worth 4 points, ten days ahead, drawn once by the lottery. */
async function drawnDraft() {
  const type = await command("dutyType.save", {
    name: "שמירה בשווי 4",
    pricing: { mode: "fixed", base: 4 },
  });
  const start = DateTime.now()
    .setZone("Asia/Jerusalem")
    .startOf("day")
    .plus({ days: 10, hours: 8 });
  const created = await command("duty.create", {
    typeId: type.id,
    name: "שמירה מוגרלת",
    start: start.toISO(),
    end: start.plus({ hours: 8 }).toISO(),
    roles: [{ name: "תורן", count: 1 }],
  });
  const draft = await dutyRow(created.id);
  await command(
    "duty.lottery",
    { dutyId: draft.id, slotId: draft.data.slots[0].id },
    draft.version
  );
  return dutyRow(created.id);
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  serial = 40;
  manager = await invite("אחראי הקבלות", "manager", 0);
});
afterAll(async () => pool.end());

describe("draw receipt for the drawn soldier (decision 240)", () => {
  it("shows the drawn soldier the numbers of a published draw, and nothing about others", async () => {
    const drawn = await invite("חייל שהוגרל", "soldier", 3);
    const outside = await invite("חייל מחוץ לרצועה", "soldier", 20);
    const draft = await drawnDraft();
    // A draft never reaches a soldier, nor its draw.
    expect(await receipts(drawn)).toEqual([]);
    await command(
      "duty.publish",
      { id: draft.id, confirmed: true },
      draft.version
    );
    const [attempt] = await db
      .select()
      .from(records)
      .where(eq(records.kind, "lottery_attempt"));
    expect(attempt.data.candidateId).toBe(drawn.soldierId);
    const eligible = (attempt.data.candidates as { status: string }[]).filter(
      (row) => row.status !== "blocked"
    ).length;
    const own = await receipts(drawn);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      dutyId: draft.id,
      slotId: draft.data.slots[0].id,
      weight: 4,
      minimum: 3,
      bandSize: 1,
      eligible,
      score: 3,
    });
    expect(Object.keys(own[0]).sort()).toEqual(
      [
        "bandSize",
        "drawnAt",
        "dutyId",
        "eligible",
        "minimum",
        "score",
        "slotId",
        "weight",
      ].sort()
    );
    const text = JSON.stringify(own);
    expect(text).not.toContain(outside.soldierId!);
    expect(text).not.toContain("מחוץ לרצועה");
    expect(text).not.toMatch(/blockers|approvalsRequired|reason|candidates/);
  });
  it("gives another soldier no receipt for a seat that is not theirs", async () => {
    await invite("חייל שהוגרל", "soldier", 3);
    const outside = await invite("חייל מחוץ לרצועה", "soldier", 20);
    const draft = await drawnDraft();
    await command(
      "duty.publish",
      { id: draft.id, confirmed: true },
      draft.version
    );
    expect(await receipts(outside)).toEqual([]);
  });
  it("keeps the manager's full draw history and sends the manager no receipts", async () => {
    await invite("חייל שהוגרל", "soldier", 3);
    await invite("חייל מחוץ לרצועה", "soldier", 20);
    const draft = await drawnDraft();
    await command(
      "duty.publish",
      { id: draft.id, confirmed: true },
      draft.version
    );
    const state = (await readState(manager)) as {
      drawReceipts?: Receipt[];
      lotteryAttempts: Receipt[];
    };
    expect(state.drawReceipts).toEqual([]);
    expect(state.lotteryAttempts).toHaveLength(1);
  });
});
