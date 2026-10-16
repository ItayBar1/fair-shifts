import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import {
  assignments,
  duties,
  dutySlots,
  dutyTypes,
  records,
  soldiers,
} from "../../src/server/schema";
import { evaluateEligibility } from "../../src/domain/eligibility";
import type { Soldier } from "../../src/domain/types";
import { duty as dutyFixture, soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// Decision 226: personal hours limits became hours exemptions from the catalog.
// The migration moves data saved before it; synthetic records only.
const migration = readFileSync("drizzle/0021_hours_exemptions.sql", "utf8");
const migrate = () => pool.query(migration);

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, records, unit_lock cascade`
  );
});
afterAll(async () => pool.end());

const nights = [{ startTime: "22:00", endTime: "06:00", weekdays: [1, 7] }];
const days = [{ startTime: "08:00", endTime: "17:00", weekdays: [5] }];
// The database orders object keys its own way, so entries are told apart by a value.
const startOf = (data: Record<string, unknown>) =>
  (data.windows as { startTime: string }[])[0].startTime;

describe("the migration to hours exemptions", () => {
  it("gives each window set one catalog entry, moves every limit and its approvals, and runs again without change", async () => {
    const plain = randomUUID();
    const [first, second] = [randomUUID(), randomUUID()];
    const [firstLimit, secondLimit, dayLimit] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    // The stored shape before the decision: a separate allowedHours list.
    const legacy = (id: string, name: string, extra: object) =>
      ({
        ...soldier({ id, name }),
        exemptions: [{ exemptionId: plain }],
        ...extra,
      }) as unknown as Soldier;
    await db.insert(soldiers).values([
      {
        id: first,
        name: "חייל לילה",
        data: legacy(first, "חייל לילה", {
          allowedHours: [
            {
              id: firstLimit,
              start: "2026-06-01",
              end: "2026-06-30",
              windows: nights,
            },
            {
              id: dayLimit,
              start: "2026-07-01",
              end: "2026-07-31",
              windows: days,
            },
          ],
        }),
      },
      {
        id: second,
        name: "חייל לילה נוסף",
        data: legacy(second, "חייל לילה נוסף", {
          allowedHours: [
            {
              id: secondLimit,
              start: "2026-06-01",
              end: "2026-06-15",
              windows: nights,
            },
          ],
        }),
      },
    ]);
    await db.insert(records).values({
      id: plain,
      kind: "eligibility_catalog",
      data: { kind: "exemption", name: "פטור רגיל" },
    });
    const typeId = randomUUID();
    await db
      .insert(dutyTypes)
      .values({ id: typeId, name: "שמירה", data: { roles: [] } });
    const dutyId = randomUUID();
    const slotId = randomUUID();
    const instance = dutyFixture({
      id: dutyId,
      typeId,
      start: "2026-06-02T18:00:00+03:00",
      end: "2026-06-02T23:00:00+03:00",
      slots: [{ id: slotId, role: "תורן" }],
    });
    await db.insert(duties).values({
      id: dutyId,
      typeId,
      name: instance.name,
      data: { ...instance, location: "", instructions: "" },
    });
    await db.insert(dutySlots).values({ id: slotId, dutyId, data: {} });
    const approval = {
      kind: "allowed_hours",
      soldierId: first,
      dutyId,
      dutyVersion: 1,
      referenceId: firstLimit,
      reason: "חריג שאושר",
      approvedBy: "manager",
      approvedAt: "2026-06-01T10:00:00Z",
    };
    const assignmentId = randomUUID();
    await db.insert(assignments).values({
      id: assignmentId,
      dutyId,
      slotId,
      soldierId: first,
      status: "reserved",
      points: 4,
      data: {
        id: assignmentId,
        dutyId,
        slotId,
        soldierId: first,
        points: 4,
        status: "reserved",
        version: 1,
        approvals: [approval, { ...approval, kind: "rank", referenceId: "x" }],
      } as unknown as typeof assignments.$inferInsert.data,
    });

    await migrate();
    const catalog = (
      await db
        .select()
        .from(records)
        .where(eq(records.kind, "eligibility_catalog"))
    ).filter((row) => row.id !== plain);
    expect(catalog).toHaveLength(2);
    const nightEntry = catalog.find((row) => startOf(row.data) === "22:00")!;
    const dayEntry = catalog.find((row) => startOf(row.data) === "08:00")!;
    expect(nightEntry.data).toMatchObject({ kind: "exemption" });
    expect(String(nightEntry.data.name)).toMatch(/^הגבלת שעות \d$/);
    const stored = async (id: string) =>
      (await db.select().from(soldiers).where(eq(soldiers.id, id)))[0].data;
    const person = await stored(first);
    expect(person).not.toHaveProperty("allowedHours");
    expect(person.exemptions).toEqual([
      { exemptionId: plain },
      {
        exemptionId: nightEntry.id,
        start: "2026-06-01",
        end: "2026-06-30",
        windows: nights,
      },
      {
        exemptionId: dayEntry.id,
        start: "2026-07-01",
        end: "2026-07-31",
        windows: days,
      },
    ]);
    expect((await stored(second)).exemptions).toEqual([
      { exemptionId: plain },
      {
        exemptionId: nightEntry.id,
        start: "2026-06-01",
        end: "2026-06-15",
        windows: nights,
      },
    ]);
    // The approval follows the limit to its catalog entry; others stay.
    const [assigned] = await db.select().from(assignments);
    expect(assigned.data.approvals).toMatchObject([
      { kind: "allowed_hours", referenceId: nightEntry.id },
      { kind: "rank", referenceId: "x" },
    ]);
    // The evening duty is outside the night window, and the approval still counts.
    const result = evaluateEligibility(person, instance, instance.slots[0], {
      duties: [],
      assignments: [],
      mode: "manual",
      approvals: assigned.data.approvals,
    });
    expect(result.status).toBe("eligible");

    const before = await db.select().from(soldiers);
    await migrate();
    expect(await db.select().from(soldiers)).toEqual(before);
    expect(
      await db
        .select()
        .from(records)
        .where(eq(records.kind, "eligibility_catalog"))
    ).toHaveLength(3);
  });
});
