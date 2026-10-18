import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool } from "../../src/server/db";
import {
  balances,
  duties,
  dutyTypes,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import { defaultHoursRange } from "../../src/domain/default-hours";
import { soldier, testIdNumber } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// Default hours of a duty type (decision 229). Synthetic people only.
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
    idNumber: testIdNumber(personalNumber),
    data: soldier({ id, name }),
  });
  const email = `${personalNumber}@example.invalid`;
  await db.insert(soldierContacts).values({ soldierId: id, email });
  await db.insert(balances).values({ soldierId: id });
  const row = await createInvitedAccount({ name, role, email, soldierId: id });
  return { id: row.id, name, role, soldierId: id, securityEpoch: 1 };
}
async function command(
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number,
  actor = manager
) {
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as { id: string; version: number };
}
const day = (offset: number) =>
  DateTime.now().setZone("Asia/Jerusalem").plus({ days: offset }).toISODate()!;
const typeInput = (defaultHours?: unknown) => ({
  name: "שמירת יום",
  pricing: { mode: "fixed", base: 4 },
  roles: [{ name: "תורן", count: 1 }],
  ...(defaultHours !== undefined && { defaultHours }),
});
async function storedType(id: string) {
  return (await db.select().from(dutyTypes).where(eq(dutyTypes.id, id)))[0];
}
async function addExemption(soldierId: string, exemptionId: string) {
  const payload = {
    soldierId,
    kind: "exemption",
    value: exemptionId,
    startDate: day(0),
    endDate: day(30),
  };
  const preview = (await command(
    "soldier.timeline.preview",
    payload,
    1
  )) as unknown as { previewToken: string };
  await command(
    "soldier.timeline",
    { ...payload, confirmed: true, previewToken: preview.previewToken },
    1
  );
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, records, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("אחראי לבדיקה", "manager", "00002");
  member = await invite("חייל לבדיקה", "soldier", "00001");
  other = await invite("חייל נוסף", "soldier", "00004");
});
afterAll(async () => pool.end());

describe("default hours of a duty type", () => {
  it("saves and clears default hours, rejects invalid ones and sends them to managers only", async () => {
    const hours = { startTime: "08:00", endTime: "08:00", endDays: 1 };
    const type = await command("dutyType.save", typeInput(hours));
    expect((await storedType(type.id)).data.defaultHours).toEqual(hours);
    const [shown] = (await readState(manager)).dutyTypes as Record<
      string,
      unknown
    >[];
    expect(shown.defaultHours).toEqual(hours);
    expect((await readState(member)).dutyTypes).toEqual([]);

    for (const invalid of [
      { startTime: "08:00", endTime: "08:00", endDays: 0 },
      { startTime: "16:00", endTime: "08:00", endDays: 0 },
      { startTime: "25:00", endTime: "08:00", endDays: 1 },
      { startTime: "08:00", endTime: "16:00", endDays: -1 },
      { startTime: "08:00", endTime: "16:00", endDays: 32 },
    ])
      await expect(
        command("dutyType.save", { ...typeInput(invalid), id: type.id }, 1)
      ).rejects.toMatchObject({ code: "invalid_default_hours", status: 422 });
    expect((await storedType(type.id)).version).toBe(1);

    // An instance keeps its own moments when the type's hours change or go.
    const range = defaultHoursRange(day(5), hours);
    const created = await command("duty.create", {
      typeId: type.id,
      name: "מופע מהשעות",
      ...range,
    });
    const before = (
      await db.select().from(duties).where(eq(duties.id, created.id))
    )[0];
    await command("dutyType.save", { ...typeInput(null), id: type.id }, 1);
    const cleared = await storedType(type.id);
    expect(cleared.version).toBe(2);
    expect(cleared.data).not.toHaveProperty("defaultHours");
    const after = (
      await db.select().from(duties).where(eq(duties.id, created.id))
    )[0];
    expect(after).toEqual(before);
    expect(after.data).not.toHaveProperty("defaultHours");
    expect(
      DateTime.fromISO(after.data.end).diff(
        DateTime.fromISO(after.data.start),
        "hours"
      ).hours
    ).toBeGreaterThanOrEqual(23);
  });

  it("checks an instance created from the default hours against each soldier's hours exemption", async () => {
    const hours = { startTime: "08:00", endTime: "16:00", endDays: 0 };
    const type = await command("dutyType.save", typeInput(hours));
    const morning = await command("eligibility.catalog.save", {
      kind: "exemption",
      name: "פטור שעות בוקר",
      windows: [
        {
          startTime: "08:00",
          endTime: "14:00",
          weekdays: [1, 2, 3, 4, 5, 6, 7],
        },
      ],
    });
    const wide = await command("eligibility.catalog.save", {
      kind: "exemption",
      name: "פטור שעות רחב",
      windows: [
        {
          startTime: "06:00",
          endTime: "22:00",
          weekdays: [1, 2, 3, 4, 5, 6, 7],
        },
      ],
    });
    await addExemption(member.soldierId!, morning.id);
    await addExemption(other.soldierId!, wide.id);
    const created = await command("duty.create", {
      typeId: type.id,
      name: "מופע מהשעות",
      ...defaultHoursRange(day(5), hours),
    });
    const [row] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, created.id));
    const preview = async (soldierId: string) =>
      (await command(
        "duty.assignment.preview",
        { dutyId: row.id, slotId: row.data.slots[0].id, soldierId },
        row.version
      )) as unknown as {
        status: string;
        requirements: { code: string; referenceId?: string }[];
      };
    const blocked = await preview(member.soldierId!);
    expect(blocked.status).toBe("approval_required");
    expect(blocked.requirements).toMatchObject([
      { code: "allowed_hours", referenceId: morning.id },
    ]);
    expect((await preview(other.soldierId!)).status).toBe("eligible");
    // The lottery leaves out the soldier whose hours exemption the duty exceeds.
    await db
      .update(balances)
      .set({ current: 100 })
      .where(eq(balances.soldierId, other.soldierId!));
    const drawn = (await command(
      "duty.lottery",
      { dutyId: row.id, slotId: row.data.slots[0].id },
      row.version
    )) as unknown as { candidateId: string };
    expect(drawn.candidateId).toBe(other.soldierId);
  });
});
