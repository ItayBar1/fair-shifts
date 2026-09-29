import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool } from "../../src/server/db";
import { emailOutbox } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
  dutyTypes,
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
import type { Duty, PriceBreakdown } from "../../src/domain/types";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

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
/** A 36-hour instance from 20:00 Israel time, two weeks ahead, without a clock change. */
function thirtySixHours() {
  let start = DateTime.now()
    .setZone("Asia/Jerusalem")
    .plus({ days: 14 })
    .set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
  while (start.offset !== start.plus({ hours: 36 }).offset)
    start = start.plus({ days: 1 });
  return { start: start.toISO()!, end: start.plus({ hours: 36 }).toISO()! };
}
async function dutyType(roles: { name: string; count: number }[]) {
  return command("dutyType.save", {
    name: "סוג לבדיקת מופע",
    pricing: { mode: "fixed", base: 4 },
    roles,
  });
}
async function instance(typeId: string, name = "מופע לבדיקה") {
  const created = await command("duty.create", {
    typeId,
    name,
    ...thirtySixHours(),
  });
  const [row] = await db.select().from(duties).where(eq(duties.id, created.id));
  return row;
}
async function proposal(changeId: string) {
  const [row] = await db.select().from(records).where(eq(records.id, changeId));
  return row.data as {
    proposed: Duty & { location?: string; instructions?: string };
    seats: { slotId: string; soldierId: string | null; extraPoints: string }[];
  };
}
async function preview(changeId: string, version: number) {
  return (await command(
    "duty.change.preview",
    { id: changeId },
    version
  )) as unknown as {
    previewToken: string;
    seatPrices: {
      slotId: string;
      role: string;
      soldierId: string | null;
      price: PriceBreakdown;
    }[];
    checks: { status: string }[];
    affected: { soldierId: string; before: unknown[]; after: unknown[] }[];
  };
}
const nightAndEvening = {
  mode: "daily",
  basePoints: "4",
  surcharges: [
    {
      name: "לילה",
      points: "0.25",
      window: { startTime: "22:00", endTime: "06:00" },
      threshold: { kind: "any_overlap" },
      frequency: "per_window",
    },
    {
      name: "ערב ארוך",
      points: "0.25",
      window: { startTime: "18:00", endTime: "21:00" },
      threshold: { kind: "minimum_hours", hours: "2" },
      frequency: "per_window",
    },
  ],
};

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("אחראי לבדיקה", "manager", "00002");
  member = await invite("חייל לבדיקה", "soldier", "00001");
  other = await invite("חייל נוסף", "soldier", "00004");
});
afterAll(async () => pool.end());

describe("local composition and pricing of one instance", () => {
  it("edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone", async () => {
    const type = await dutyType([{ name: "תורן", count: 1 }]);
    const duty = await instance(type.id);
    const sibling = await instance(type.id, "מופע אחר מאותו סוג");
    await command(
      "duty.assign",
      {
        dutyId: duty.id,
        slotId: duty.data.slots[0]!.id,
        soldierId: member.soldierId,
      },
      1
    );
    const change = await command(
      "duty.change.create",
      { dutyId: duty.id, reason: "הרכב ותמחור למופע" },
      2
    );
    await command(
      "duty.change.rules",
      {
        id: change.id,
        roles: [
          { name: "תורן", count: 2 },
          { name: "מפקד", count: 1 },
        ],
        pricing: nightAndEvening,
        restBeforeMinutes: 60,
        restAfterMinutes: 90,
      },
      1
    );
    const { proposed, seats } = await proposal(change.id);
    expect(proposed.slots.map((slot) => slot.role)).toEqual([
      "תורן",
      "תורן",
      "מפקד",
    ]);
    expect(proposed.slots[0]!.id).toBe(duty.data.slots[0]!.id);
    expect(seats[0]!.soldierId).toBe(member.soldierId);
    await command(
      "duty.change.save",
      {
        id: change.id,
        name: proposed.name,
        start: proposed.start,
        end: proposed.end,
        location: "",
        instructions: "",
        reason: "הזנקה למקום השני בלבד",
        seats: proposed.slots.map((slot, index) => ({
          slotId: slot.id,
          soldierId: [member.soldierId, other.soldierId, null][index],
          extraPoints: index === 1 ? 1 : 0,
        })),
      },
      2
    );
    const checked = await preview(change.id, 3);
    // 36 hours at 4 per 24 hours = 6; two nights and one qualifying evening add 0.75.
    expect(checked.seatPrices.map((seat) => seat.price.points)).toEqual([
      7, 8, 7,
    ]);
    expect(checked.seatPrices[0]!.price).toMatchObject({
      base: "6",
      totalExact: "6.75",
      surcharges: [{ count: 2 }, { count: 1 }],
    });
    expect(checked.seatPrices[1]!.price.totalExact).toBe("7.75");
    expect(checked.seatPrices[2]!.soldierId).toBeNull();
    await command(
      "duty.change.apply",
      { id: change.id, confirmed: true, previewToken: checked.previewToken },
      3
    );
    const reserved = (await db.select().from(assignments))
      .filter((row) => row.status === "reserved")
      .map((row) => [row.soldierId, row.points]);
    expect(reserved).toEqual(
      expect.arrayContaining([
        [member.soldierId, 7],
        [other.soldierId, 8],
      ])
    );
    expect(reserved).toHaveLength(2);
    const [updated] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, duty.id));
    expect(updated.data).toMatchObject({
      status: "draft",
      restBeforeMinutes: 60,
      restAfterMinutes: 90,
      pricing: { mode: "daily", basePoints: "4" },
    });
    const [catalog] = await db
      .select()
      .from(dutyTypes)
      .where(eq(dutyTypes.id, type.id));
    expect(catalog.data.roles).toEqual([{ name: "תורן", count: 1 }]);
    expect(catalog.data.pricing).toMatchObject({
      mode: "fixed",
      basePoints: "4",
    });
    const [untouched] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, sibling.id));
    expect(untouched.data).toEqual(sibling.data);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
    expect((await readState(member)).duties).toHaveLength(0);
  });
  it("releases an occupied seat of a published instance only when it is chosen explicitly, and only on update and publish", async () => {
    const type = await dutyType([{ name: "תורן", count: 2 }]);
    const duty = await instance(type.id);
    const [first, second] = duty.data.slots;
    await command(
      "duty.assign",
      { dutyId: duty.id, slotId: first!.id, soldierId: member.soldierId },
      1
    );
    await command(
      "duty.assign",
      { dutyId: duty.id, slotId: second!.id, soldierId: other.soldierId },
      2
    );
    await command("duty.publish", { id: duty.id, confirmed: true }, 3);
    const change = await command(
      "duty.change.create",
      { dutyId: duty.id, reason: "הפחתת מכסה" },
      4
    );
    const rules = {
      id: change.id,
      roles: [{ name: "תורן", count: 1 }],
      pricing: { mode: "fixed", basePoints: "4", surcharges: [] },
      restBeforeMinutes: 0,
      restAfterMinutes: 0,
    };
    await expect(command("duty.change.rules", rules, 1)).rejects.toMatchObject({
      code: "occupied_reduction",
      status: 409,
      details: [
        { slotId: first!.id, soldierId: member.soldierId },
        { slotId: second!.id, soldierId: other.soldierId },
      ],
    });
    await expect(
      command(
        "duty.change.rules",
        { ...rules, releaseSlotIds: [randomUUID()] },
        1
      )
    ).rejects.toMatchObject({ code: "invalid_release" });
    await command(
      "duty.change.rules",
      { ...rules, releaseSlotIds: [second!.id] },
      1
    );
    const before = await readState(other);
    expect(
      before.assignments.filter(
        (row) => row.status === "reserved" && row.soldierId === other.soldierId
      )
    ).toHaveLength(1);
    const checked = await preview(change.id, 2);
    expect(
      checked.affected.find((row) => row.soldierId === other.soldierId)
    ).toMatchObject({ before: [{ slotId: second!.id }], after: [] });
    await command(
      "duty.change.publish",
      { id: change.id, confirmed: true, previewToken: checked.previewToken },
      2
    );
    const after = await readState(other);
    expect(
      after.assignments.filter(
        (row) => row.status === "reserved" && row.soldierId === other.soldierId
      )
    ).toHaveLength(0);
    expect(
      after.notifications.map((row) => (row as { body?: string }).body)
    ).toEqual(expect.arrayContaining([expect.stringContaining("הוסר")]));
    const [published] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, duty.id));
    expect(published.data.slots.map((slot) => slot.id)).toEqual([first!.id]);
    const [catalog] = await db
      .select()
      .from(dutyTypes)
      .where(eq(dutyTypes.id, type.id));
    expect(catalog.data.roles).toEqual([{ name: "תורן", count: 2 }]);
  });
  it("keeps occupied seats before vacant ones when a catalog quota is applied", async () => {
    const type = await dutyType([{ name: "תורן", count: 3 }]);
    const duty = await instance(type.id);
    const occupied = duty.data.slots[2]!;
    await command(
      "duty.assign",
      { dutyId: duty.id, slotId: occupied.id, soldierId: member.soldierId },
      1
    );
    await command(
      "dutyType.save",
      {
        id: type.id,
        name: "סוג לבדיקת מופע",
        pricing: { mode: "fixed", base: 4 },
        roles: [{ name: "תורן", count: 1 }],
      },
      1
    );
    const impact = (await command(
      "dutyType.impact.preview",
      { id: type.id },
      2
    )) as unknown as {
      duties: { afterSlots: number; checks: { removed: boolean }[] }[];
    };
    expect(impact.duties[0]).toMatchObject({
      afterSlots: 1,
      checks: [{ removed: false }],
    });
    const change = await command(
      "duty.change.create",
      { dutyId: duty.id, reason: "החלת קטלוג", applyCatalog: true },
      2
    );
    const { proposed, seats } = await proposal(change.id);
    expect(proposed.slots.map((slot) => slot.id)).toEqual([occupied.id]);
    expect(seats[0]!.soldierId).toBe(member.soldierId);
  });
  it("rejects stale or competing edits, invalid rules and soldiers", async () => {
    const type = await dutyType([{ name: "תורן", count: 1 }]);
    const duty = await instance(type.id);
    const change = await command(
      "duty.change.create",
      { dutyId: duty.id, reason: "בדיקת גרסאות" },
      1
    );
    const rules = {
      id: change.id,
      roles: [{ name: "תורן", count: 2 }],
      pricing: { mode: "fixed", basePoints: "5", surcharges: [] },
      restBeforeMinutes: 0,
      restAfterMinutes: 0,
    };
    await expect(
      command("duty.change.rules", rules, 1, member)
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      command(
        "duty.change.rules",
        {
          ...rules,
          roles: [
            {
              name: "תורן",
              count: 1,
              requirements: { capabilityIds: [randomUUID()] },
            },
          ],
        },
        1
      )
    ).rejects.toMatchObject({ code: "invalid_requirement" });
    await expect(
      command(
        "duty.change.rules",
        {
          ...rules,
          roles: [
            { name: "תורן", count: 1 },
            { name: "תורן", count: 1 },
          ],
        },
        1
      )
    ).rejects.toMatchObject({ code: "duplicate_role" });
    const checked = await preview(change.id, 1);
    const results = await Promise.allSettled([
      command("duty.change.rules", rules, 1),
      command(
        "duty.change.rules",
        { ...rules, roles: [{ name: "תורן", count: 3 }] },
        1
      ),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    await expect(
      command(
        "duty.change.apply",
        { id: change.id, confirmed: true, previewToken: checked.previewToken },
        2
      )
    ).rejects.toMatchObject({ code: "stale_preview", status: 409 });
    const [live] = await db.select().from(duties).where(eq(duties.id, duty.id));
    expect(live.data.slots).toHaveLength(1);
    expect(live.data.pricing.basePoints).toBe("4");
  });
});
