import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import {
  assignments,
  balances,
  duties,
  ledger,
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
import { settleDue } from "../../src/server/scoring";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// Execution periods and mid-duty handover at a daily rate (card #18, decision 183). Synthetic people only.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let manager: Actor;
let secondManager: Actor;
let alon: Actor;
let bar: Actor;
let chen: Actor;

async function invite(
  name: string,
  role: "soldier" | "manager",
  personalNumber: string
): Promise<Actor> {
  const soldierId = randomUUID();
  await db.insert(soldiers).values({
    id: soldierId,
    name,
    personalNumber,
    data: soldier({ id: soldierId, name, personalNumber }),
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId, email: `${personalNumber}@example.invalid` });
  await db.insert(balances).values({ soldierId });
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
  expectedVersion?: number,
  idempotencyKey: string = randomUUID()
) {
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey,
  })) as { id: string; version: number } & Record<string, unknown>;
}
async function dutyRow(id: string) {
  const [row] = await db.select().from(duties).where(eq(duties.id, id));
  return row;
}
async function seatRows(dutyId: string) {
  return db.select().from(assignments).where(eq(assignments.dutyId, dutyId));
}
async function rowOf(dutyId: string, person: Actor) {
  const row = (await seatRows(dutyId)).find(
    (item) => item.soldierId === person.soldierId && item.status !== "cancelled"
  );
  if (!row) throw new Error("row not found");
  return row;
}
async function balance(person: Actor) {
  const [row] = await db
    .select()
    .from(balances)
    .where(eq(balances.soldierId, person.soldierId!));
  return row.current;
}
const at = (offset: number) =>
  new Date(Math.floor(Date.now() / HOUR) * HOUR + offset).toISOString();

/**
 * A published duty that started `startedHoursAgo` hours ago and lasts `hours`, at a daily
 * rate of 4 per 24 hours unless `fixed`. It is created in the future, published, and then
 * moved back in whole hours, so its stored values keep matching its length.
 */
async function runningDuty(
  seats: (Actor | null)[],
  options: { startedHoursAgo?: number; hours?: number; fixed?: boolean } = {}
) {
  const { startedHoursAgo = 30, hours = 48, fixed = false } = options;
  const type = await command(manager, "dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode: fixed ? "fixed" : "daily", base: 4 },
    roles: [{ name: "תורן", count: seats.length }],
  });
  const start = Math.floor(Date.now() / HOUR) * HOUR + 3 * DAY;
  const duty = await command(manager, "duty.create", {
    typeId: type.id,
    name: "אבטחה ממושכת",
    start: new Date(start).toISOString(),
    end: new Date(start + hours * HOUR).toISOString(),
  });
  const created = await dutyRow(duty.id);
  let version = 1;
  for (const [index, person] of seats.entries()) {
    if (!person) continue;
    await command(
      manager,
      "duty.assign",
      {
        dutyId: duty.id,
        slotId: created.data.slots[index].id,
        soldierId: person.soldierId,
      },
      version
    );
    version++;
  }
  await command(
    manager,
    "duty.publish",
    { id: duty.id, confirmed: true },
    version
  );
  const live = await dutyRow(duty.id);
  const shift =
    start - (Math.floor(Date.now() / HOUR) * HOUR - startedHoursAgo * HOUR);
  const moved = {
    start: new Date(new Date(live.data.start).getTime() - shift).toISOString(),
    end: new Date(new Date(live.data.end).getTime() - shift).toISOString(),
  };
  await db
    .update(duties)
    .set({ data: { ...live.data, ...moved } })
    .where(eq(duties.id, duty.id));
  return { ...(await dutyRow(duty.id)), slots: created.data.slots };
}
type Seg = { soldierId: string | null; start: string; end: string };
function segments(
  duty: Awaited<ReturnType<typeof runningDuty>>,
  parts: [Actor | null, number][]
): Seg[] {
  // parts: performer and the hour (from the duty start) at which their period ends.
  const start = new Date(duty.data.start).getTime();
  let cursor = start;
  return parts.map(([person, endHour]) => {
    const segment = {
      soldierId: person?.soldierId ?? null,
      start: new Date(cursor).toISOString(),
      end: new Date(start + endHour * HOUR).toISOString(),
    };
    cursor = start + endHour * HOUR;
    return segment;
  });
}
async function save(
  actor: Actor,
  duty: Awaited<ReturnType<typeof runningDuty>>,
  parts: Seg[],
  extra: Record<string, unknown> = {},
  slotIndex = 0
) {
  const payload = {
    dutyId: duty.id,
    slotId: duty.slots[slotIndex].id,
    segments: parts,
    reason: "חייל חלה באמצע התורנות",
    ...extra,
  };
  const preview = await command(actor, "execution.preview", payload);
  const result = await command(actor, "execution.apply", {
    ...payload,
    token: preview.token,
  });
  return { preview, result };
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("אחראי לבדיקה", "manager", "00002");
  secondManager = await invite("אחראי שני", "manager", "00003");
  alon = await invite("חייל מקורי", "soldier", "00001");
  bar = await invite("חייל מחליף", "soldier", "00004");
  chen = await invite("חייל שלישי", "soldier", "00005");
});
afterAll(async () => pool.end());

describe("execution periods of a started seat", () => {
  it("splits the daily base by actual time, credits the ended part once and keeps the rest stored", async () => {
    // 48 hours at 4 per day: Alon holds a stored 8 until the handover.
    const duty = await runningDuty([alon]);
    const original = await rowOf(duty.id, alon);
    expect(original.points).toBe(8);
    // Only managers record execution; a soldier is refused on the server.
    await expect(
      command(alon, "execution.preview", {
        dutyId: duty.id,
        slotId: duty.slots[0].id,
        segments: segments(duty, [[alon, 48]]),
        reason: "x",
      })
    ).rejects.toThrow("לאחראי");

    // Alon covered the first 18 hours (3 points, already ended), Bar the other 30 (5 stored).
    const { preview } = await save(
      manager,
      duty,
      segments(duty, [
        [alon, 18],
        [bar, 48],
      ])
    );
    const changes = preview.changes as {
      soldierId: string;
      kind: string;
      price: { base: string; totalExact: string; points: number };
    }[];
    expect(changes.find((c) => c.soldierId === alon.soldierId)).toMatchObject({
      kind: "late",
      price: { base: "3", points: 3 },
    });
    expect(changes.find((c) => c.soldierId === bar.soldierId)).toMatchObject({
      kind: "create",
      price: { base: "5", points: 5 },
    });
    const rows = await seatRows(duty.id);
    const alonRow = rows.find((row) => row.soldierId === alon.soldierId)!;
    const barRow = rows.find((row) => row.soldierId === bar.soldierId)!;
    expect(alonRow).toMatchObject({ status: "credited", points: 3 });
    expect(alonRow.data.performance).toMatchObject({
      performerId: alon.soldierId,
      points: 3,
      reflected: { [alon.soldierId!]: 3 },
    });
    expect(barRow).toMatchObject({ status: "reserved", points: 5 });
    expect(barRow.data.performedStart).toBe(alonRow.data.performedEnd);
    expect(await balance(alon)).toBe(3);
    expect(await balance(bar)).toBe(0);
    // The ended part is credited at its actual end, once.
    const credits = await db
      .select()
      .from(ledger)
      .where(eq(ledger.sourceKey, `performance:${alonRow.id}`));
    expect(credits).toHaveLength(1);
    expect(credits[0].effectiveAt.getTime()).toBe(
      new Date(alonRow.data.performedEnd!).getTime()
    );

    // Bar's part is credited once when it ends, even with two workers racing.
    const after = new Date(new Date(duty.data.end).getTime() + 60_000);
    await Promise.all([
      unitTransaction((tx) => settleDue(tx, after)),
      unitTransaction((tx) => settleDue(tx, after)),
    ]);
    expect(await balance(bar)).toBe(5);
    expect((await rowOf(duty.id, bar)).status).toBe("credited");

    // The soldier view shows who covers which part; the manager also gets the history.
    const view = await readState(chen);
    const seen = (view.assignments as Record<string, unknown>[]).filter(
      (row) => row.dutyId === duty.id
    );
    expect(seen.map((row) => row.performedStart).sort()).toEqual(
      [alonRow.data.performedStart, barRow.data.performedStart].sort()
    );
    const managed = await readState(manager);
    expect((managed as Record<string, unknown>).executionChanges).toHaveLength(
      1
    );
    expect(JSON.stringify(view)).not.toContain("חייל חלה");
  });

  it("requires every moment to belong to one performer or to be marked as not performed", async () => {
    const duty = await runningDuty([alon, null]);
    const start = new Date(duty.data.start).getTime();
    const gap = [
      {
        soldierId: alon.soldierId!,
        start: duty.data.start,
        end: new Date(start + 10 * HOUR).toISOString(),
      },
      {
        soldierId: bar.soldierId!,
        start: new Date(start + 12 * HOUR).toISOString(),
        end: duty.data.end,
      },
    ];
    const payload = { dutyId: duty.id, slotId: duty.slots[0].id, reason: "x" };
    await expect(
      command(manager, "execution.preview", { ...payload, segments: gap })
    ).rejects.toThrow("לא שויך");
    const overlap = [
      { ...gap[0], end: new Date(start + 14 * HOUR).toISOString() },
      gap[1],
    ];
    await expect(
      command(manager, "execution.preview", { ...payload, segments: overlap })
    ).rejects.toThrow("חופפות");
    await expect(
      command(manager, "execution.preview", {
        ...payload,
        segments: segments(duty, [
          [alon, 10],
          [bar, 20],
          [alon, 48],
        ]),
      })
    ).rejects.toThrow("תקופת ביצוע רציפה אחת");

    // Alon left after 10 hours and nobody replaced him: the rest is recorded as not performed.
    await save(
      manager,
      duty,
      segments(duty, [
        [alon, 10],
        [null, 48],
      ])
    );
    const alonRow = await rowOf(duty.id, alon);
    expect(alonRow).toMatchObject({ status: "credited", points: 2 });
    expect(await balance(alon)).toBe(2);
    const [seat] = (
      await db.select().from(records).where(eq(records.kind, "seat_execution"))
    ).filter((row) => row.data.slotId === duty.slots[0].id);
    const parts = seat.data.notPerformed as { start: string; end: string }[];
    expect(
      parts.map((part) => [
        new Date(part.start).getTime(),
        new Date(part.end).getTime(),
      ])
    ).toEqual([
      [
        new Date(alonRow.data.performedEnd!).getTime(),
        new Date(duty.data.end).getTime(),
      ],
    ]);

    // An empty seat can be filled after the start: Chen covers the last 12 hours.
    await save(
      manager,
      duty,
      segments(duty, [
        [null, 36],
        [chen, 48],
      ]),
      {},
      1
    );
    expect(await rowOf(duty.id, chen)).toMatchObject({
      status: "reserved",
      points: 2,
    });
  });

  it("checks a replacement against their own period, and frees the leaving soldier after they left", async () => {
    const duty = await runningDuty([alon]);
    // Bar holds another duty in 12 hours; covering the rest of this one would overlap it.
    const other = await runningDuty([bar], { startedHoursAgo: -12, hours: 4 });
    const payload = {
      dutyId: duty.id,
      slotId: duty.slots[0].id,
      segments: segments(duty, [
        [alon, 18],
        [bar, 48],
      ]),
      reason: "x",
    };
    const blocked = await command(manager, "execution.preview", payload);
    expect(blocked.blocked).toBe(true);
    await expect(
      command(manager, "execution.apply", { ...payload, token: blocked.token })
    ).rejects.toThrow("אינו עומד בתנאי התורנות");
    // Bar covers up to 6 hours before his other duty; Chen covers the rest.
    await save(
      manager,
      duty,
      segments(duty, [
        [alon, 18],
        [bar, 36],
        [chen, 48],
      ])
    );
    expect((await rowOf(duty.id, bar)).status).toBe("reserved");
    // Alon left at hour 18, so a later draft that overlaps the rest of this duty fits him now.
    const type = await command(manager, "dutyType.save", {
      name: "סוג קצר",
      pricing: { mode: "fixed", base: 1 },
      roles: [{ name: "תורן", count: 1 }],
    });
    const later = await command(manager, "duty.create", {
      typeId: type.id,
      name: "תורנות קצרה",
      start: at(2 * HOUR),
      end: at(4 * HOUR),
    });
    const draft = await dutyRow(later.id);
    const check = await command(
      manager,
      "duty.assignment.preview",
      {
        dutyId: later.id,
        slotId: draft.data.slots[0].id,
        soldierId: alon.soldierId,
      },
      draft.version
    );
    expect(check.status).toBe("eligible");
    expect(other.id).toBeTruthy();
  });

  it("changes a credited period through the correction rules and waits for a manager after a normalization", async () => {
    const duty = await runningDuty([alon]);
    await save(
      manager,
      duty,
      segments(duty, [
        [alon, 18],
        [bar, 48],
      ])
    );
    expect(await balance(alon)).toBe(3);
    // Without an intervening operation the difference applies once: 24 hours are worth 4.
    await save(
      manager,
      duty,
      segments(duty, [
        [alon, 24],
        [bar, 48],
      ])
    );
    expect(await balance(alon)).toBe(4);
    expect((await rowOf(duty.id, bar)).points).toBe(4);
    const alonRow = await rowOf(duty.id, alon);
    expect(alonRow.data.performance).toMatchObject({
      points: 4,
      corrections: 1,
      reflected: { [alon.soldierId!]: 4 },
    });
    // After a balance is set, a later correction of that period waits for a decision.
    const input = {
      soldierIds: [alon.soldierId],
      operation: "set",
      value: 10,
      reason: "נרמול",
    };
    const score = await command(manager, "score.preview", input);
    await command(manager, "score.apply", { ...input, token: score.token });
    const { result } = await save(
      manager,
      duty,
      segments(duty, [
        [alon, 27],
        [bar, 48],
      ])
    );
    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          soldierId: alon.soldierId,
          status: "decision_required",
        }),
      ])
    );
    expect(await balance(alon)).toBe(10);
    const decisions = (
      await db.select().from(records).where(eq(records.kind, "score_decision"))
    ).filter((row) => row.data.status === "pending");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].data).toMatchObject({
      soldierId: alon.soldierId,
      historyPoints: 5,
      reflectedPoints: 4,
    });
    // A single-performer correction is refused on a split seat.
    const credited = await rowOf(duty.id, alon);
    await expect(
      command(
        manager,
        "performance.correction.preview",
        {
          assignmentId: credited.id,
          start: duty.data.start,
          end: at(-HOUR),
          reason: "x",
        },
        credited.version
      )
    ).rejects.toThrow("תקופות ביצוע");
  });

  it("lets only one of two competing saves pass and replays a retried save", async () => {
    const duty = await runningDuty([alon]);
    const payload = {
      dutyId: duty.id,
      slotId: duty.slots[0].id,
      segments: segments(duty, [
        [alon, 18],
        [bar, 48],
      ]),
      reason: "x",
    };
    const preview = await command(manager, "execution.preview", payload);
    const other = await command(secondManager, "execution.preview", {
      ...payload,
      segments: segments(duty, [
        [alon, 20],
        [chen, 48],
      ]),
    });
    const key = randomUUID();
    const outcomes = await Promise.allSettled([
      command(
        manager,
        "execution.apply",
        { ...payload, token: preview.token },
        undefined,
        key
      ),
      command(secondManager, "execution.apply", {
        ...payload,
        segments: segments(duty, [
          [alon, 20],
          [chen, 48],
        ]),
        token: other.token,
      }),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    const rejected = outcomes.find(
      (item) => item.status === "rejected"
    ) as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("השתנו");
    const credits = await db
      .select()
      .from(ledger)
      .where(eq(ledger.soldierId, alon.soldierId!));
    expect(credits).toHaveLength(1);
    if (outcomes[0].status === "fulfilled") {
      const replay = await command(
        manager,
        "execution.apply",
        { ...payload, token: preview.token },
        undefined,
        key
      );
      expect(replay.id).toBe(
        (outcomes[0] as PromiseFulfilledResult<{ id: string }>).value.id
      );
    }
    expect(
      (await seatRows(duty.id)).filter((row) => row.status !== "cancelled")
    ).toHaveLength(2);
  });

  it("does not split a fixed-rate seat until fixed shares are supported", async () => {
    const duty = await runningDuty([alon], { fixed: true });
    await expect(
      command(manager, "execution.preview", {
        dutyId: duty.id,
        slotId: duty.slots[0].id,
        segments: segments(duty, [
          [alon, 18],
          [bar, 48],
        ]),
        reason: "x",
      })
    ).rejects.toThrow("#19");
    const seat = await rowOf(duty.id, alon);
    await expect(
      command(
        alon,
        "transfer.offer",
        { assignmentId: seat.id, candidateIds: [bar.soldierId] },
        seat.version
      )
    ).rejects.toThrow("#19");
  });
});

describe("a replacement requested after the start", () => {
  it("goes to a manager, who sets the handover, and the original seat binds until then", async () => {
    const duty = await runningDuty([alon]);
    const seat = await rowOf(duty.id, alon);
    const offer = await command(
      alon,
      "transfer.offer",
      { assignmentId: seat.id, candidateIds: [bar.soldierId] },
      seat.version
    );
    const [request] = await db
      .select()
      .from(records)
      .where(eq(records.id, offer.id));
    await command(
      bar,
      "transfer.respond",
      { id: offer.id, decision: "accept", confirmed: true },
      request.version
    );
    const waiting = (
      await db.select().from(records).where(eq(records.id, offer.id))
    )[0];
    expect(waiting.data.status).toBe("awaiting_manager");
    // Until the decision the original seat and its stored value stand.
    expect(await rowOf(duty.id, alon)).toMatchObject({
      status: "reserved",
      points: 8,
    });
    const first = await command(
      manager,
      "transfer.review",
      { id: offer.id },
      waiting.version
    );
    expect(first).toMatchObject({ started: true, handoverRequired: true });
    const handoverAt = new Date(
      new Date(duty.data.start).getTime() + 18 * HOUR
    ).toISOString();
    await expect(
      command(
        manager,
        "transfer.review",
        { id: offer.id, handoverAt: duty.data.end },
        waiting.version
      )
    ).rejects.toThrow("מועד החילוף");
    const review = await command(
      manager,
      "transfer.review",
      { id: offer.id, handoverAt },
      waiting.version
    );
    expect(review.status).toBe("eligible");
    await command(
      manager,
      "transfer.decide",
      {
        id: offer.id,
        decision: "approve",
        confirmed: true,
        previewToken: review.previewToken,
        handoverAt,
      },
      waiting.version
    );
    const done = (
      await db.select().from(records).where(eq(records.id, offer.id))
    )[0];
    expect(done.data.status).toBe("completed");
    expect(new Date(String(done.data.handoverAt)).getTime()).toBe(
      new Date(handoverAt).getTime()
    );
    expect(await rowOf(duty.id, alon)).toMatchObject({
      status: "credited",
      points: 3,
    });
    expect(await rowOf(duty.id, bar)).toMatchObject({
      status: "reserved",
      points: 5,
    });
    expect(await balance(alon)).toBe(3);
    const notes = (await readState(bar)).notifications.map(
      (row) => (row as { title?: string }).title
    );
    expect(notes).toContain("קיבלת חלק מתורנות");
  });

  it("closes a referred cancellation request once the seat's periods are recorded", async () => {
    const duty = await runningDuty([alon]);
    const seat = await rowOf(duty.id, alon);
    // The request was filed before the start and referred after it.
    const request = await (async () => {
      const live = await dutyRow(duty.id);
      const future = {
        start: new Date(Date.now() + DAY).toISOString(),
        end: new Date(Date.now() + 3 * DAY).toISOString(),
      };
      await db
        .update(duties)
        .set({ data: { ...live.data, ...future } })
        .where(eq(duties.id, duty.id));
      const created = await command(
        alon,
        "cancellation.submit",
        { assignmentId: seat.id, kind: "cancel", reason: "פטור" },
        seat.version
      );
      await db
        .update(duties)
        .set({ data: live.data })
        .where(eq(duties.id, duty.id));
      return created;
    })();
    await command(
      manager,
      "cancellation.refer",
      { id: request.id, reason: "יתועד בתקופות הביצוע" },
      1
    );
    // Confirming the recorded periods is enough to close the referral.
    await save(manager, duty, segments(duty, [[alon, 48]]));
    const [row] = await db
      .select()
      .from(records)
      .where(and(eq(records.id, request.id), eq(records.kind, "request")));
    expect(row.data.executionId).toBeTruthy();
    expect(await rowOf(duty.id, alon)).toMatchObject({
      status: "reserved",
      points: 8,
    });
  });
});
