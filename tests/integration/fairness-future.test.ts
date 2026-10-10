import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import {
  balances,
  duties,
  ledger,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// The fairness table's points ahead and a soldier's own ledger (card #165,
// decision 220). Synthetic people only.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let manager: Actor;
let alon: Actor;
let bar: Actor;
let serial = 10;

async function invite(
  name: string,
  role: "soldier" | "manager",
  balance = 0
): Promise<Actor> {
  const soldierId = randomUUID();
  const personalNumber = String(serial++).padStart(5, "0");
  await db.insert(soldiers).values({
    id: soldierId,
    name,
    personalNumber,
    data: soldier({ id: soldierId, name, personalNumber }),
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId, email: `${personalNumber}@example.invalid` });
  await db.insert(balances).values({ soldierId, current: balance });
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
  })) as { id: string; version: number } & Record<string, unknown>;
}
/** A duty `days` ahead worth 4 points, held by `holder`, published or left a draft. */
async function seat(holder: Actor, days: number, publish: boolean) {
  const kind = await command(manager, "dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 1 }],
  });
  const start = Math.floor(Date.now() / HOUR) * HOUR + days * DAY;
  const created = await command(manager, "duty.create", {
    typeId: kind.id,
    name: "תורנות לבדיקה",
    start: new Date(start).toISOString(),
    end: new Date(start + 8 * HOUR).toISOString(),
  });
  const [row] = await db.select().from(duties).where(eq(duties.id, created.id));
  await command(
    manager,
    "duty.assign",
    {
      dutyId: row.id,
      slotId: row.data.slots[0].id,
      soldierId: holder.soldierId,
    },
    row.version
  );
  if (publish)
    await command(
      manager,
      "duty.publish",
      { id: row.id, confirmed: true },
      row.version + 1
    );
}
const futureOf = (
  state: Awaited<ReturnType<typeof readState>>,
  person: Actor
) =>
  (state.soldiers as { id: string; futureScore?: number }[]).find(
    (row) => row.id === person.soldierId
  )?.futureScore;

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  serial = 10;
  manager = await invite("אחראי", "manager");
  alon = await invite("אלון", "soldier", 10);
  bar = await invite("בר", "soldier", 11);
});
afterAll(async () => pool.end());

describe("points ahead in the fairness table", () => {
  it("gives a manager every seat not yet credited, drafts included, and a soldier only published ones", async () => {
    await seat(alon, 4, true);
    await seat(alon, 6, false);
    await seat(bar, 5, false);

    const managing = await readState(manager);
    expect(futureOf(managing, alon)).toBe(8);
    expect(futureOf(managing, bar)).toBe(4);

    // A draft never reaches a soldier, not even as a sum (decision 220).
    for (const viewer of [alon, bar]) {
      const state = await readState(viewer);
      expect(futureOf(state, alon)).toBe(4);
      expect(futureOf(state, bar)).toBe(0);
    }
    // The current balance stays apart from the points ahead.
    const own = (await readState(bar)).soldiers.find(
      (row) => row.id === bar.soldierId
    );
    expect(own).toMatchObject({ currentScore: 11, futureScore: 0 });
  });

  it("shows a soldier their own ledger only, without the reasons", async () => {
    const preview = await command(manager, "score.preview", {
      soldierIds: [alon.soldierId, bar.soldierId],
      operation: "add",
      value: 2,
      reason: "נרמול סינתטי",
    });
    await command(manager, "score.apply", {
      soldierIds: [alon.soldierId, bar.soldierId],
      operation: "add",
      value: 2,
      reason: "נרמול סינתטי",
      token: preview.token,
    });
    expect(await db.select().from(ledger)).toHaveLength(2);
    const state = await readState(bar);
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      soldierId: bar.soldierId,
      kind: "normalization",
      before: 11,
      after: 13,
    });
    // The reason, who acted and the source stay with the managers (decision 168).
    expect(state.ledger[0]).not.toHaveProperty("reason");
    expect(state.ledger[0]).not.toHaveProperty("actorId");
    expect(state.ledger[0]).not.toHaveProperty("sourceKey");
    expect(JSON.stringify(state)).not.toContain("נרמול סינתטי");
  });
});
