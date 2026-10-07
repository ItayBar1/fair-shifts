import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
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
import type { Gender } from "../../src/domain/types";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// A gender condition with every gender is no condition (card #98, decision 198).
// Synthetic people only; the soldiers have no gender recorded.
const everyone: Gender[] = ["male", "female", "other"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let manager: Actor;
let alon: Actor;
let bar: Actor;
let serial = 10;

async function invite(
  name: string,
  role: "soldier" | "manager"
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
  await db.insert(balances).values({ soldierId, current: 100 });
  const row = await createInvitedAccount({
    name,
    role,
    email: `${personalNumber}@example.invalid`,
    soldierId,
  });
  return { id: row.id, name, role, soldierId, securityEpoch: 1 };
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
  })) as { id: string; version: number } & Record<string, unknown>;
}
async function typeRow(id: string) {
  const [row] = await db.select().from(dutyTypes).where(eq(dutyTypes.id, id));
  return row;
}
async function dutyRow(id: string) {
  const [row] = await db.select().from(duties).where(eq(duties.id, id));
  return row;
}
/** A draft duty from a type with the given conditions; its seats are `slots`. */
async function draftFrom(
  genders: Gender[],
  roles: { name: string; count: number; requirements?: object }[] = [
    { name: "תורן", count: 1 },
  ]
) {
  const kind = await command("dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode: "fixed", base: 4 },
    genders,
    roles,
  });
  const start = Math.floor(Date.now() / HOUR) * HOUR + 3 * DAY;
  const created = await command("duty.create", {
    typeId: kind.id,
    name: "תורנות לבדיקה",
    start: new Date(start).toISOString(),
    end: new Date(start + 8 * HOUR).toISOString(),
  });
  return { kind, duty: await dutyRow(created.id) };
}
function assignTo(
  duty: { id: string; version: number; data: { slots: { id: string }[] } },
  person: Actor,
  index = 0
) {
  return command(
    "duty.assign",
    {
      dutyId: duty.id,
      slotId: duty.data.slots[index]!.id,
      soldierId: person.soldierId,
    },
    duty.version
  );
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  serial = 10;
  manager = await invite("אחראי ראשון", "manager");
  alon = await invite("אלון", "soldier");
  bar = await invite("בר", "soldier");
});
afterAll(async () => pool.end());

describe("saving a gender condition", () => {
  it("stores every gender as an empty list in the type, its roles and the duty made from it", async () => {
    const { kind, duty } = await draftFrom(everyone, [
      { name: "תורן", count: 1, requirements: { genders: everyone } },
      { name: "מפקד", count: 1, requirements: { genders: ["male"] } },
    ]);
    const stored = await typeRow(kind.id);
    expect(stored.data.genders).toEqual([]);
    expect((stored.data.requirements as { genders: string[] }).genders).toEqual(
      []
    );
    const roles = stored.data.roles as {
      requirements: { genders: string[] };
    }[];
    expect(roles[0]!.requirements.genders).toEqual([]);
    expect(roles[1]!.requirements.genders).toEqual(["male"]);
    expect(duty.data.requirements.genders).toEqual([]);
    expect(duty.data.slots.map((slot) => slot.requirements?.genders)).toEqual([
      [],
      ["male"],
    ]);
  });
  it("keeps a partial list", async () => {
    const { kind } = await draftFrom(["male", "female"]);
    expect((await typeRow(kind.id)).data.genders).toEqual(["male", "female"]);
  });
  it("saves a role of one instance with every gender as no condition", async () => {
    const { duty } = await draftFrom([]);
    const change = await command(
      "duty.change.create",
      { dutyId: duty.id, reason: "הרכב למופע" },
      duty.version
    );
    await command(
      "duty.change.rules",
      {
        id: change.id,
        roles: [
          { name: "תורן", count: 1, requirements: { genders: everyone } },
        ],
        pricing: { mode: "fixed", basePoints: "4", surcharges: [] },
        restBeforeMinutes: 0,
        restAfterMinutes: 0,
      },
      1
    );
    const [row] = await db
      .select()
      .from(records)
      .where(eq(records.id, change.id));
    const proposed = (
      row!.data as {
        proposed: { slots: { requirements?: { genders?: string[] } }[] };
      }
    ).proposed;
    expect(proposed.slots[0]!.requirements?.genders).toEqual([]);
  });
});

describe("a soldier without a recorded gender", () => {
  it("is assignable by hand, and a draw offers them, when every gender is allowed", async () => {
    const { duty } = await draftFrom(everyone);
    const preview = (await command(
      "duty.assignment.preview",
      {
        dutyId: duty.id,
        slotId: duty.data.slots[0]!.id,
        soldierId: alon.soldierId,
      },
      duty.version
    )) as unknown as { status: string; blockers: unknown[] };
    expect(preview).toMatchObject({ status: "eligible", blockers: [] });
    await command(
      "duty.lottery",
      { dutyId: duty.id, slotId: duty.data.slots[0]!.id },
      duty.version
    );
    const [attempt] = await db
      .select()
      .from(records)
      .where(eq(records.kind, "lottery_attempt"));
    const ids = (attempt!.data.candidates as { id: string }[]).map(
      (row) => row.id
    );
    expect(ids.sort()).toEqual([alon.soldierId, bar.soldierId].sort());
  });
  it("is still blocked as missing information when two of three genders are allowed", async () => {
    const { duty } = await draftFrom(["male", "female"]);
    const preview = (await command(
      "duty.assignment.preview",
      {
        dutyId: duty.id,
        slotId: duty.data.slots[0]!.id,
        soldierId: alon.soldierId,
      },
      duty.version
    )) as unknown as { status: string; blockers: { code: string }[] };
    expect(preview.status).toBe("blocked");
    expect(preview.blockers.map((row) => row.code)).toEqual(["gender"]);
    await expect(assignTo(duty, alon)).rejects.toMatchObject({
      code: "blocked",
    });
  });
  it("is not blocked by a full list that was saved before the fix", async () => {
    const { duty } = await draftFrom([]);
    // The state a database holds before the migration ran: the full list on the duty and its seat.
    await db
      .update(duties)
      .set({
        data: {
          ...duty.data,
          requirements: { ...duty.data.requirements, genders: everyone },
          slots: duty.data.slots.map((slot) => ({
            ...slot,
            requirements: { genders: everyone },
          })),
        },
      })
      .where(eq(duties.id, duty.id));
    const live = await dutyRow(duty.id);
    await assignTo(live, alon);
    const rows = await db.select().from(assignments);
    expect(rows.map((row) => row.status)).toEqual(["reserved"]);
  });
});

describe("the migration that normalizes saved lists", () => {
  const statements = readFileSync(
    "drizzle/0009_normalize_all_genders.sql",
    "utf8"
  )
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean);
  const migrate = async () => {
    for (const statement of statements) await pool.query(statement);
  };
  const flagged = async () =>
    Object.fromEntries(
      (await db.select().from(assignments)).map((row) => [
        row.soldierId,
        { marks: row.data.needsAttention ?? [], version: row.version },
      ])
    );
  const audits = async () =>
    (await db.select().from(records).where(eq(records.kind, "audit"))).filter(
      (row) => row.data.action === "assignment.gender_flag.clear"
    );

  /** Two duties in the state before the fix, each with a seat flagged "gender". */
  async function seed() {
    const open = (await draftFrom([])).duty;
    const partial = (
      await draftFrom(
        [],
        [{ name: "תורן", count: 1, requirements: { genders: ["male"] } }]
      )
    ).duty;
    // Both duties keep the full list on the duty itself, as old data did.
    for (const duty of [open, partial])
      await db
        .update(duties)
        .set({
          data: {
            ...duty.data,
            requirements: { ...duty.data.requirements, genders: everyone },
          },
        })
        .where(eq(duties.id, duty.id));
    // No gender condition is left on the first duty: its flag came from the bug.
    await assignTo(open, alon);
    const [seat] = await db.select().from(assignments);
    await db
      .update(assignments)
      .set({
        data: { ...seat!.data, needsAttention: ["gender", "capability"] },
      })
      .where(eq(assignments.id, seat!.id));
    // The second duty's role still limits to male: its flag is real.
    const slotId = partial.data.slots[0]!.id;
    await db.insert(assignments).values({
      id: randomUUID(),
      dutyId: partial.id,
      slotId,
      soldierId: bar.soldierId!,
      status: "reserved",
      points: 4,
      data: {
        id: "seat",
        dutyId: partial.id,
        slotId,
        soldierId: bar.soldierId!,
        points: 4,
        status: "reserved",
        version: 1,
        needsAttention: ["gender"],
      },
    });
    return { open, partial };
  }

  it("normalizes full lists everywhere, leaves partial ones and keeps duty versions", async () => {
    const { open, partial } = await seed();
    const before = [await dutyRow(open.id), await dutyRow(partial.id)];
    await migrate();
    const after = [await dutyRow(open.id), await dutyRow(partial.id)];
    expect(after[0]!.data.requirements.genders).toEqual([]);
    expect(after[1]!.data.requirements.genders).toEqual([]);
    expect(after[1]!.data.slots[0]!.requirements?.genders).toEqual(["male"]);
    expect(after.map((row) => row.version)).toEqual(
      before.map((row) => row.version)
    );
    expect(after.map((row) => row.data.rulesVersion)).toEqual(
      before.map((row) => row.data.rulesVersion)
    );
  });
  it("clears the gender mark only where no gender condition is left, and logs it as a system action", async () => {
    const { open } = await seed();
    await migrate();
    const marks = await flagged();
    // No condition left: only the gender reason goes.
    expect(marks[alon.soldierId!]!.marks).toEqual(["capability"]);
    // The role still limits to male: the mark stays.
    expect(marks[bar.soldierId!]!.marks).toEqual(["gender"]);
    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0]!.data).toMatchObject({
      actorId: "system",
      dutyId: open.id,
      soldierId: alon.soldierId,
    });
  });
  it("changes nothing when it runs again", async () => {
    await seed();
    await migrate();
    const once = await flagged();
    const snapshot = JSON.stringify(
      (await db.select().from(duties)).map((row) => [row.id, row.data])
    );
    await migrate();
    expect(await flagged()).toEqual(once);
    expect(await audits()).toHaveLength(1);
    expect(
      JSON.stringify(
        (await db.select().from(duties)).map((row) => [row.id, row.data])
      )
    ).toBe(snapshot);
  });
});
