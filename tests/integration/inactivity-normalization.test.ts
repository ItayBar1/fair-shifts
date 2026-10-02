import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool } from "../../src/server/db";
import {
  balances,
  duties,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  accountAvailable,
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { errorResponse } from "../../src/server/http";
import { user } from "../../src/server/auth-schema";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// A normalization reaches a soldier who is inactive, and the balance is still
// there when the period ends (scenario 6). Synthetic people only.
const today = () => DateTime.now().setZone("Asia/Jerusalem").startOf("day");
const day = (offset: number) => today().plus({ days: offset }).toISODate()!;
let manager: Actor;
let away: Actor;
let present: Actor;

async function invite(
  name: string,
  role: "soldier" | "manager",
  number: string,
  balance: number,
  inactive: { start: string; end: string }[] = []
): Promise<Actor> {
  const soldierId = randomUUID();
  await db.insert(soldiers).values({
    id: soldierId,
    name,
    personalNumber: number,
    data: soldier({
      id: soldierId,
      name,
      personalNumber: number,
      inactivePeriods: inactive,
    }),
  });
  const email = `${number}@example.invalid`;
  await db.insert(soldierContacts).values({ soldierId, email });
  await db.insert(balances).values({ soldierId, current: balance });
  const row = await createInvitedAccount({ name, role, email, soldierId });
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
  })) as { id: string; version: number; token?: string };
}
async function balanceOf(person: Actor) {
  const [row] = await db
    .select()
    .from(balances)
    .where(eq(balances.soldierId, person.soldierId!));
  return row.current;
}
/** A draft a day or more ahead, from 08:00 for eight hours. */
async function draftOn(offset: number) {
  const kind = await command(manager, "dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 1 }],
  });
  const start = today().plus({ days: offset, hours: 8 });
  const created = await command(manager, "duty.create", {
    typeId: kind.id,
    name: "תורנות לבדיקה",
    start: start.toUTC().toISO(),
    end: start.plus({ hours: 8 }).toUTC().toISO(),
  });
  const [row] = await db.select().from(duties).where(eq(duties.id, created.id));
  return row;
}
const assignTo = (duty: Awaited<ReturnType<typeof draftOn>>, person: Actor) =>
  command(
    manager,
    "duty.assign",
    {
      dutyId: duty.id,
      slotId: duty.data.slots[0].id,
      soldierId: person.soldierId,
    },
    duty.version
  );
async function status(promise: Promise<unknown>) {
  try {
    await promise;
    return 200;
  } catch (error) {
    return errorResponse(error).status;
  }
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("אחראי לבדיקה", "manager", "0000001", 0);
  // Away from yesterday to the day after tomorrow, so a duty in two days still falls inside.
  away = await invite("חייל בקורס", "soldier", "0000002", 20, [
    { start: day(-1), end: day(3) },
  ]);
  present = await invite("חייל זמין", "soldier", "0000003", 70);
});
afterAll(async () => pool.end());

describe("a soldier in an inactive period", () => {
  it("cannot be given a duty that overlaps it, and can still sign in", async () => {
    const duty = await draftOn(2);
    expect(await status(assignTo(duty, away))).toBeGreaterThanOrEqual(400);
    const [account] = await db.select().from(user).where(eq(user.id, away.id));
    expect(await accountAvailable(account)).toBe(true);
    expect(await status(assignTo(duty, present))).toBe(200);
  });
  it("is reached by a normalization like everyone else", async () => {
    const input = {
      soldierIds: [away.soldierId, present.soldierId],
      operation: "percent",
      value: 50,
      reason: "נרמול סינתטי",
    };
    const preview = await command(manager, "score.preview", input);
    await command(manager, "score.apply", { ...input, token: preview.token });
    expect(await balanceOf(away)).toBe(10);
    expect(await balanceOf(present)).toBe(35);
  });
  it("keeps the normalized balance when the period ends, and is available again", async () => {
    const input = {
      soldierIds: [away.soldierId],
      operation: "percent",
      value: 50,
      reason: "נרמול סינתטי",
    };
    const preview = await command(manager, "score.preview", input);
    await command(manager, "score.apply", { ...input, token: preview.token });
    const [row] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, away.soldierId!));
    // The period ended before today.
    await db
      .update(soldiers)
      .set({
        data: {
          ...row.data,
          inactivePeriods: [{ start: day(-9), end: day(-2) }],
        },
      })
      .where(eq(soldiers.id, away.soldierId!));
    expect(await status(assignTo(await draftOn(2), away))).toBe(200);
    expect(await balanceOf(away)).toBe(10);
  });
});
