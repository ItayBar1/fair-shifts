import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import {
  duties,
  dutySlots,
  dutyTypes,
  records,
  soldiers,
} from "../../src/server/schema";
import { evaluateEligibility } from "../../src/domain/eligibility";
import type { Duty, Soldier } from "../../src/domain/types";
import { duty as dutyFixture, soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// Decision 224: qualifications became capabilities with optional dates. The
// migration moves data saved before it; synthetic records only.
const statements = readFileSync("drizzle/0020_capability_validity.sql", "utf8")
  .split("--> statement-breakpoint")
  .map((part) => part.trim())
  .filter(Boolean);
const migrate = async () => {
  for (const statement of statements) await pool.query(statement);
};

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, records, unit_lock cascade`
  );
});
afterAll(async () => pool.end());

describe("the migration to dated capabilities", () => {
  it("keeps every soldier's qualifications and capabilities, the catalog and the conditions, and runs again without change", async () => {
    const qualification = randomUUID();
    const capability = randomUUID();
    const other = randomUUID();
    const personId = randomUUID();
    // The stored shape before the decision: dated qualifications, bare capability ids.
    const legacy = {
      ...soldier({ id: personId, name: "חייל ותיק" }),
      qualifications: [
        {
          qualificationId: qualification,
          start: "2026-01-01",
          end: "2026-12-31",
        },
      ],
      capabilities: [capability],
    } as unknown as Soldier;
    await db
      .insert(soldiers)
      .values({ id: personId, name: legacy.name, data: legacy });
    await db.insert(records).values([
      {
        id: qualification,
        kind: "eligibility_catalog",
        data: { kind: "qualification", name: "מטווח" },
      },
      {
        id: capability,
        kind: "eligibility_catalog",
        data: { kind: "capability", name: "נהיגה" },
      },
      {
        id: other,
        kind: "audit",
        data: { action: "dutyType.save", qualificationIds: [qualification] },
      },
    ]);
    const typeId = randomUUID();
    await db.insert(dutyTypes).values({
      id: typeId,
      name: "סיור",
      data: {
        qualificationIds: [qualification],
        capabilityIds: [capability],
        requirements: { qualificationIds: [qualification] },
        roles: [
          {
            name: "נהג",
            count: 1,
            requirements: {
              qualificationIds: [qualification],
              capabilityIds: [capability, qualification],
            },
          },
        ],
      },
    });
    const dutyId = randomUUID();
    const slotId = randomUUID();
    const instance = dutyFixture({
      id: dutyId,
      typeId,
      start: "2026-06-01T08:00:00+03:00",
      end: "2026-06-01T16:00:00+03:00",
      requirements: {
        qualificationIds: [qualification],
      } as Duty["requirements"],
      slots: [
        {
          id: slotId,
          role: "נהג",
          requirements: { qualificationIds: [qualification] },
        } as unknown as Duty["slots"][number],
      ],
    });
    await db.insert(duties).values({
      id: dutyId,
      typeId,
      name: "סיור בוקר",
      data: { ...instance, name: "סיור בוקר", location: "", instructions: "" },
    });
    await db.insert(dutySlots).values({
      id: slotId,
      dutyId,
      data: { requirements: { qualificationIds: [qualification] } },
    });

    await migrate();
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, personId));
    expect(person.data.capabilities).toEqual([
      { capabilityId: capability },
      { capabilityId: qualification, start: "2026-01-01", end: "2026-12-31" },
    ]);
    expect("qualifications" in person.data).toBe(false);
    const catalog = await db
      .select()
      .from(records)
      .where(eq(records.kind, "eligibility_catalog"));
    expect(catalog.map((row) => row.data.kind)).toEqual([
      "capability",
      "capability",
    ]);
    const [type] = await db.select().from(dutyTypes);
    expect(JSON.stringify(type.data)).not.toContain("qualificationIds");
    expect(type.data).toMatchObject({
      requirements: { capabilityIds: [qualification] },
      roles: [{ requirements: { capabilityIds: expect.any(Array) } }],
    });
    expect([...(type.data.capabilityIds as string[])].sort()).toEqual(
      [capability, qualification].sort()
    );
    const roles = type.data.roles as {
      requirements: { capabilityIds: string[] };
    }[];
    expect([...roles[0].requirements.capabilityIds].sort()).toEqual(
      [capability, qualification].sort()
    );
    const [stored] = await db.select().from(duties);
    expect(stored.data.requirements).toEqual({
      capabilityIds: [qualification],
    });
    expect(stored.data.slots[0].requirements).toEqual({
      capabilityIds: [qualification],
    });
    const [seat] = await db.select().from(dutySlots);
    expect(seat.data).toEqual({
      requirements: { capabilityIds: [qualification] },
    });
    // The audit trail keeps what was recorded.
    const [audit] = await db
      .select()
      .from(records)
      .where(eq(records.id, other));
    expect(audit.data.qualificationIds).toEqual([qualification]);

    // The dated capability still decides eligibility as the qualification did.
    const covered = evaluateEligibility(
      person.data,
      stored.data,
      stored.data.slots[0],
      { duties: [], assignments: [], mode: "automatic" }
    );
    expect(covered.blockers.map((item) => item.code)).not.toContain(
      "capability"
    );
    const late = {
      ...stored.data,
      start: "2027-02-01T08:00:00+02:00",
      end: "2027-02-01T16:00:00+02:00",
    };
    expect(
      evaluateEligibility(person.data, late, late.slots[0], {
        duties: [],
        assignments: [],
        mode: "automatic",
      }).blockers.map((item) => item.code)
    ).toContain("capability");

    const before = JSON.stringify([
      await db.select().from(soldiers),
      await db.select().from(dutyTypes),
      await db.select().from(duties),
    ]);
    await migrate();
    expect(
      JSON.stringify([
        await db.select().from(soldiers),
        await db.select().from(dutyTypes),
        await db.select().from(duties),
      ])
    ).toBe(before);
  });
});
