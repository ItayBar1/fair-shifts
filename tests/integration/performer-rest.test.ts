import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import {
  assignments,
  balances,
  duties,
  dutySlots,
  dutyTypes,
  ledger,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { loadDomain } from "../../src/server/repository";
import { settleDue } from "../../src/server/scoring";
import { impactOf, reassessAssignments } from "../../src/server/personnel";
import { evaluateEligibility } from "../../src/domain/eligibility";
import { assignment, duty, soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");
const HOUR = 3_600_000;
let original: Actor;
let performer: Actor;
let manager: Actor;
let previous: ReturnType<typeof duty>;
let historical: ReturnType<typeof assignment>;

async function invite(
  number: string,
  role: "soldier" | "manager" = "soldier"
): Promise<Actor> {
  const soldierId = randomUUID();
  const name = `Synthetic ${number}`;
  await db.insert(soldiers).values({
    id: soldierId,
    name,
    personalNumber: number,
    data: soldier({ id: soldierId, name, personalNumber: number }),
  });
  await db.insert(balances).values({ soldierId });
  const account = await createInvitedAccount({
    name,
    role,
    email: `${number}@example.invalid`,
    soldierId,
  });
  return {
    id: account.id,
    name,
    role,
    soldierId,
    securityEpoch: account.securityEpoch,
  };
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
  })) as Record<string, unknown>;
}
async function insertDuty(data: ReturnType<typeof duty>) {
  await db.insert(duties).values({
    id: data.id,
    typeId: data.typeId,
    name: data.name,
    data: {
      ...data,
      location: data.location ?? "",
      instructions: data.instructions ?? "",
    },
  });
  await db.insert(dutySlots).values(
    data.slots.map((slot) => ({
      id: slot.id,
      dutyId: data.id,
      data: { ...slot },
    }))
  );
}
async function correct(
  performerId: string,
  start = previous.start,
  end = previous.end
) {
  const [row] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.id, historical.id));
  const input = {
    assignmentId: row.id,
    performerId,
    start,
    end,
    reason: "תיקון מבצע לבדיקה",
  };
  const preview = await command(
    "performance.correction.preview",
    input,
    row.version
  );
  await command(
    "performance.correction.apply",
    { ...input, token: preview.token },
    row.version
  );
}
async function state() {
  return unitTransaction((tx) => loadDomain(tx));
}
function next(overrides: Partial<ReturnType<typeof duty>> = {}) {
  return duty({
    id: randomUUID(),
    typeId: previous.typeId,
    start: new Date(Date.now() + HOUR).toISOString(),
    end: new Date(Date.now() + 2 * HOUR).toISOString(),
    slots: [{ id: randomUUID(), role: "Synthetic" }],
    ...overrides,
  });
}
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  original = await invite("990011");
  performer = await invite("990012");
  manager = await invite("990013", "manager");
  const typeId = randomUUID();
  await db
    .insert(dutyTypes)
    .values({ id: typeId, name: "Synthetic", data: {} });
  previous = duty({
    id: randomUUID(),
    typeId,
    status: "published",
    start: new Date(Date.now() - 3 * HOUR).toISOString(),
    end: new Date(Date.now() - HOUR).toISOString(),
    restAfterMinutes: 24 * 60,
    slots: [{ id: randomUUID(), role: "Synthetic" }],
  });
  await insertDuty(previous);
  historical = assignment({
    id: randomUUID(),
    dutyId: previous.id,
    slotId: previous.slots[0].id,
    soldierId: original.soldierId!,
  });
  await db.insert(assignments).values({ ...historical, data: historical });
  await unitTransaction((tx) => settleDue(tx));
  await correct(performer.soldierId!);
});
afterAll(() => pool.end());

describe("corrected actual performer availability (#116)", () => {
  it.each(["automatic", "manual", "volunteer"] as const)(
    "releases the original assignee in %s mode after correction",
    async (mode) => {
      const domain = await state();
      const target = next();
      const result = evaluateEligibility(
        domain.soldiers.find((p) => p.id === original.soldierId)!,
        target,
        target.slots[0],
        { ...domain, mode }
      );
      expect(result.status).toBe("eligible");
      expect(result.blockers).toEqual([]);
    }
  );
  it.each(["automatic", "manual", "volunteer"] as const)(
    "blocks the actual performer during rest in %s mode",
    async (mode) => {
      const domain = await state();
      const target = next();
      const result = evaluateEligibility(
        domain.soldiers.find((p) => p.id === performer.soldierId)!,
        target,
        target.slots[0],
        { ...domain, mode }
      );
      expect(result.status).toBe("blocked");
      expect(result.blockers).toContainEqual(
        expect.objectContaining({
          code: "overlap_or_rest",
          referenceId: historical.id,
        })
      );
    }
  );
  it.each(["automatic", "manual", "volunteer"] as const)(
    "moves overlap to the actual performer in %s mode",
    async (mode) => {
      const domain = await state();
      const target = next({ start: previous.start, end: previous.end });
      for (const [actor, blocked] of [
        [original, false],
        [performer, true],
      ] as const) {
        const result = evaluateEligibility(
          domain.soldiers.find((p) => p.id === actor.soldierId)!,
          target,
          target.slots[0],
          { ...domain, mode }
        );
        expect(result.blockers.some((b) => b.code === "overlap_or_rest")).toBe(
          blocked
        );
      }
    }
  );
  it("uses corrected times when the performer stays the same, retaining history and score", async () => {
    const start = new Date(Date.now() - 28 * HOUR).toISOString();
    const end = new Date(Date.now() - 26 * HOUR).toISOString();
    await correct(performer.soldierId!, start, end);
    const beforeSeats = await db.select().from(assignments);
    const beforeLedger = await db.select().from(ledger);
    const domain = await state();
    const target = next();
    expect(
      evaluateEligibility(
        domain.soldiers.find((p) => p.id === performer.soldierId)!,
        target,
        target.slots[0],
        { ...domain, mode: "manual" }
      ).status
    ).toBe("eligible");
    const overlapping = next({ start, end });
    expect(
      evaluateEligibility(
        domain.soldiers.find((p) => p.id === performer.soldierId)!,
        overlapping,
        overlapping.slots[0],
        { ...domain, mode: "manual" }
      ).status
    ).toBe("blocked");
    expect(beforeSeats[0]).toMatchObject({
      soldierId: original.soldierId,
      points: historical.points,
      data: { performance: { performerId: performer.soldierId } },
    });
    expect(new Date(beforeSeats[0].data.performance!.start).getTime()).toBe(
      new Date(start).getTime()
    );
    expect(new Date(beforeSeats[0].data.performance!.end).getTime()).toBe(
      new Date(end).getTime()
    );
    expect(await db.select().from(assignments)).toEqual(beforeSeats);
    expect(await db.select().from(ledger)).toEqual(beforeLedger);
  });
  it("reassesses reservations and impact using the actual performer's rest", async () => {
    await correct(original.soldierId!);
    for (const actor of [original, performer]) {
      const target = next();
      await insertDuty(target);
      const seat = assignment({
        id: randomUUID(),
        dutyId: target.id,
        slotId: target.slots[0].id,
        soldierId: actor.soldierId!,
      });
      await db.insert(assignments).values({ ...seat, data: seat });
    }
    await unitTransaction((tx) => reassessAssignments(tx));
    const before = await state();
    expect(
      before.assignments.find(
        (a) => a.status === "reserved" && a.soldierId === original.soldierId
      )!.needsAttention
    ).toContain("overlap_or_rest");
    await correct(performer.soldierId!);
    const domain = await state();
    for (const [actor, blocked] of [
      [original, false],
      [performer, true],
    ] as const) {
      const seat = domain.assignments.find(
        (a) => a.status === "reserved" && a.soldierId === actor.soldierId
      )!;
      expect(seat.needsAttention?.includes("overlap_or_rest") ?? false).toBe(
        blocked
      );
      const person = domain.soldiers.find((p) => p.id === actor.soldierId)!;
      const { impact } = impactOf(domain, person.id, person);
      expect(impact[0].reasons.some((r) => r.code === "overlap_or_rest")).toBe(
        blocked
      );
    }
  });
  it("allows the original assignee manually and excludes the performer from a lottery", async () => {
    const manual = next();
    await insertDuty(manual);
    await command(
      "duty.assign",
      {
        dutyId: manual.id,
        slotId: manual.slots[0].id,
        soldierId: original.soldierId,
      },
      1
    );
    const draw = next({
      start: new Date(Date.now() + 4 * HOUR).toISOString(),
      end: new Date(Date.now() + 5 * HOUR).toISOString(),
    });
    await insertDuty(draw);
    const result = await command(
      "duty.lottery",
      { dutyId: draw.id, slotId: draw.slots[0].id },
      1
    );
    expect(result).toMatchObject({
      status: "assigned",
      candidateId: original.soldierId,
    });
  });
  it.each(["transfer", "swap"] as const)(
    "checks corrected rest in a real %s offer and acceptance",
    async (kind) => {
      const donor = await invite("990014");
      const source = next({ status: "published" });
      await insertDuty(source);
      const seat = assignment({
        id: randomUUID(),
        dutyId: source.id,
        slotId: source.slots[0].id,
        soldierId: donor.soldierId!,
      });
      await db.insert(assignments).values({ ...seat, data: seat });
      const targets = new Map<string, string>();
      if (kind === "swap")
        for (const actor of [original, performer]) {
          const target = next({
            status: "published",
            start: new Date(Date.now() + 30 * HOUR).toISOString(),
            end: new Date(Date.now() + 31 * HOUR).toISOString(),
          });
          await insertDuty(target);
          const targetSeat = assignment({
            id: randomUUID(),
            dutyId: target.id,
            slotId: target.slots[0].id,
            soldierId: actor.soldierId!,
          });
          await db
            .insert(assignments)
            .values({ ...targetSeat, data: targetSeat });
          targets.set(actor.soldierId!, targetSeat.id);
        }
      const offer = (actor: Actor) =>
        executeAction(donor, {
          type: `${kind}.offer`,
          payload: {
            assignmentId: seat.id,
            ...(kind === "swap"
              ? { targetAssignmentIds: [targets.get(actor.soldierId!)] }
              : { candidateIds: [actor.soldierId] }),
          },
          expectedVersion: 1,
          idempotencyKey: randomUUID(),
        });
      await expect(offer(performer)).rejects.toMatchObject({
        code: "candidate_ineligible",
        status: 422,
      });
      const offered = (await offer(original)) as {
        id: string;
        version: number;
      };
      await expect(
        executeAction(original, {
          type: `${kind}.respond`,
          payload: {
            id: offered.id,
            decision: "accept",
            confirmed: true,
            ...(kind === "swap" && {
              assignmentId: targets.get(original.soldierId!),
            }),
          },
          expectedVersion: offered.version,
          idempotencyKey: randomUUID(),
        })
      ).resolves.toMatchObject({ status: "completed" });
    }
  );
});
