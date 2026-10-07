import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import { emailOutbox } from "../../src/server/auth-schema";
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
import { reassessAssignments } from "../../src/server/personnel";
import { deletedSeats } from "../../src/client/deleted-seats";
import type { AppState } from "../../src/client/types";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// A soldier deleted while a duty runs (ticket #34, decision 196). Synthetic people only.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let manager: Actor;
let secondManager: Actor;
let alon: Actor;
let bar: Actor;

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
  expectedVersion?: number
) {
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
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
    (item) => item.soldierId === person.soldierId
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
async function credits(person: Actor) {
  return db
    .select()
    .from(ledger)
    .where(
      and(
        eq(ledger.soldierId, person.soldierId!),
        eq(ledger.kind, "performance")
      )
    );
}

/** A published duty that started `startedHoursAgo` hours ago, at 4 points per 24 hours. */
async function runningDuty(
  seats: Actor[],
  { startedHoursAgo = 30, hours = 48 } = {}
) {
  const type = await command(manager, "dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode: "daily", base: 4 },
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
  for (const [index, person] of seats.entries())
    await command(
      manager,
      "duty.assign",
      {
        dutyId: duty.id,
        slotId: created.data.slots[index].id,
        soldierId: person.soldierId,
      },
      version++
    );
  await command(
    manager,
    "duty.publish",
    { id: duty.id, confirmed: true },
    version
  );
  const live = await dutyRow(duty.id);
  const shift =
    start - (Math.floor(Date.now() / HOUR) * HOUR - startedHoursAgo * HOUR);
  await db
    .update(duties)
    .set({
      data: {
        ...live.data,
        start: new Date(
          new Date(live.data.start).getTime() - shift
        ).toISOString(),
        end: new Date(new Date(live.data.end).getTime() - shift).toISOString(),
      },
    })
    .where(eq(duties.id, duty.id));
  return { ...(await dutyRow(duty.id)), slots: created.data.slots };
}
/** Moves the duty so that it ended `hoursAgo` hours ago. */
async function endDuty(dutyId: string, hoursAgo: number) {
  const live = await dutyRow(dutyId);
  const length =
    new Date(live.data.end).getTime() - new Date(live.data.start).getTime();
  const end = Math.floor(Date.now() / HOUR) * HOUR - hoursAgo * HOUR;
  await db
    .update(duties)
    .set({
      data: {
        ...live.data,
        start: new Date(end - length).toISOString(),
        end: new Date(end).toISOString(),
      },
    })
    .where(eq(duties.id, dutyId));
}
async function remove(person: Actor) {
  const [row] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, person.soldierId!));
  const impact = (await command(
    manager,
    "soldier.delete.preview",
    { id: person.soldierId },
    row.version
  )) as unknown as { previewToken: string };
  return command(
    manager,
    "soldier.delete",
    {
      id: person.soldierId,
      previewToken: impact.previewToken,
      reason: "שוחרר מהשירות",
      confirmed: true,
    },
    row.version
  );
}
type Seg = { soldierId: string | null; start: string; end: string };
function segments(
  duty: Awaited<ReturnType<typeof runningDuty>>,
  parts: [Actor | null, number][]
): Seg[] {
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
function payloadOf(
  duty: Awaited<ReturnType<typeof runningDuty>>,
  parts: Seg[]
) {
  return {
    dutyId: duty.id,
    slotId: duty.slots[0].id,
    segments: parts,
    reason: "החייל נמחק באמצע התורנות",
  };
}
async function save(
  duty: Awaited<ReturnType<typeof runningDuty>>,
  parts: Seg[]
) {
  const payload = payloadOf(duty, parts);
  const preview = await command(manager, "execution.preview", payload);
  const result = await command(manager, "execution.apply", {
    ...payload,
    token: preview.token,
  });
  return { preview, result };
}
async function waiting() {
  return deletedSeats((await readState(manager)) as unknown as AppState);
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("אחראי לבדיקה", "manager", "00402");
  secondManager = await invite("אחראי שני", "manager", "00403");
  alon = await invite("חייל שנמחק", "soldier", "00401");
  bar = await invite("חייל מחליף", "soldier", "00404");
});
afterAll(async () => pool.end());

describe("the seat of a soldier deleted while the duty runs", () => {
  it("stays on the deleted soldier, is not credited by itself, and is urgent for the managers by site and email", async () => {
    const duty = await runningDuty([alon]);
    await remove(alon);
    const row = await rowOf(duty.id, alon);
    expect(row.status).toBe("reserved");
    expect(row.data.needsAttention).toContain("deleted");
    expect(row.data.deletionDecidedAt).toBeUndefined();
    expect(await waiting()).toHaveLength(1);

    // The duty ends; the worker must not credit it.
    await endDuty(duty.id, 2);
    await unitTransaction((tx) => settleDue(tx));
    expect((await rowOf(duty.id, alon)).status).toBe("reserved");
    expect(await credits(alon)).toHaveLength(0);
    expect(await balance(alon)).toBe(0);

    for (const person of [manager, secondManager]) {
      const titles = (await readState(person)).notifications.map(
        (item) => (item as { title?: string }).title
      );
      expect(titles).toContain("נמחק חייל: נדרש טיפול במקומות פנויים");
    }
    const mail = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, "deletion"));
    expect(mail.map((item) => item.recipientAccountId).sort()).toEqual(
      [manager.id, secondManager.id].sort()
    );
    expect(mail.every((item) => item.status === "pending")).toBe(true);
    expect(mail[0]!.eventKey).toBe(
      `deletion:${alon.soldierId}:${mail[0]!.recipientAccountId}`
    );
  });

  it("is decided by recording the part performed, which is credited once, and a replacement for the rest", async () => {
    const duty = await runningDuty([alon]);
    await remove(alon);
    // Alon performed the first 18 hours; Bar covers the other 30.
    const { preview } = await save(
      duty,
      segments(duty, [
        [alon, 18],
        [bar, 48],
      ])
    );
    const changes = preview.changes as {
      soldierId: string;
      kind: string;
      eligibility?: unknown;
      price: { points: number };
    }[];
    const gone = changes.find((item) => item.soldierId === alon.soldierId)!;
    // A deleted soldier is never checked for eligibility; what they did is recorded as it was.
    expect(gone).toMatchObject({ kind: "late", price: { points: 3 } });
    expect(gone.eligibility).toBeUndefined();
    expect(
      changes.find((item) => item.soldierId === bar.soldierId)
    ).toMatchObject({ kind: "create", price: { points: 5 } });

    const row = await rowOf(duty.id, alon);
    expect(row.status).toBe("credited");
    expect(row.points).toBe(3);
    expect(row.data.deletionDecidedAt).toBeTruthy();
    expect(row.data.deletionDecidedBy).toBe(manager.id);
    expect(row.data.needsAttention).toEqual([]);
    expect(await balance(alon)).toBe(3);
    expect(await credits(alon)).toHaveLength(1);
    expect((await rowOf(duty.id, bar)).status).toBe("reserved");
    expect(await waiting()).toHaveLength(0);

    // The deletion's flag does not come back, and the worker adds nothing.
    await unitTransaction(async (tx) => {
      await reassessAssignments(tx, alon.soldierId);
      await settleDue(tx);
    });
    expect((await rowOf(duty.id, alon)).data.needsAttention).toEqual([]);
    expect(await credits(alon)).toHaveLength(1);
    expect(await balance(alon)).toBe(3);
    // Bar's part has not ended yet, so it stays stored.
    expect((await rowOf(duty.id, bar)).status).toBe("reserved");
    expect(await balance(bar)).toBe(0);
  });

  it("is decided by removing the soldier from the seat, so nothing is credited to them", async () => {
    const duty = await runningDuty([alon]);
    await remove(alon);
    const { preview } = await save(duty, segments(duty, [[bar, 48]]));
    const changes = preview.changes as { soldierId: string; kind: string }[];
    expect(
      changes.find((item) => item.soldierId === alon.soldierId)!.kind
    ).toBe("cancel");
    expect((await rowOf(duty.id, alon)).status).toBe("cancelled");
    expect(await credits(alon)).toHaveLength(0);
    expect(await balance(alon)).toBe(0);
    expect(await waiting()).toHaveLength(0);
    // The seat is Bar's for the whole duty.
    expect((await rowOf(duty.id, bar)).points).toBe(8);
  });

  it("is decided by confirming the recorded period unchanged, and then credited when the duty ends", async () => {
    const duty = await runningDuty([alon]);
    await remove(alon);
    // The same period would be "no change" for anyone else; for a seat awaiting a decision it is the decision.
    const { preview } = await save(duty, segments(duty, [[alon, 48]]));
    expect(
      (preview.changes as { kind: string }[]).map((item) => item.kind)
    ).toEqual(["keep"]);
    const decided = await rowOf(duty.id, alon);
    expect(decided.status).toBe("reserved");
    expect(decided.data.deletionDecidedAt).toBeTruthy();
    expect(decided.data.needsAttention).toEqual([]);
    expect(await waiting()).toHaveLength(0);
    await unitTransaction((tx) => reassessAssignments(tx, alon.soldierId));
    expect((await rowOf(duty.id, alon)).data.needsAttention).toEqual([]);

    // Not yet due: nothing is credited. Once the duty ends the worker credits it once.
    await unitTransaction((tx) => settleDue(tx));
    expect(await credits(alon)).toHaveLength(0);
    await endDuty(duty.id, 1);
    await unitTransaction((tx) => settleDue(tx));
    await unitTransaction((tx) => settleDue(tx));
    expect(await credits(alon)).toHaveLength(1);
    expect(await balance(alon)).toBe(8);
    // Once decided, the same period is "no change" again.
    const ended = { ...(await dutyRow(duty.id)), slots: duty.slots };
    const again = payloadOf(ended, segments(ended, [[alon, 48]]));
    const second = await command(manager, "execution.preview", again);
    await expect(
      command(manager, "execution.apply", { ...again, token: second.token })
    ).rejects.toMatchObject({ code: "no_change" });
  });

  it("lets a deleted soldier's period be shortened but not extended, and credits the shortened part once", async () => {
    // Before the deletion, Alon was recorded until hour 40 and Bar from then on; both ends are still ahead.
    const duty = await runningDuty([alon]);
    await save(
      duty,
      segments(duty, [
        [alon, 40],
        [bar, 48],
      ])
    );
    await remove(alon);
    expect(await waiting()).toHaveLength(1);

    // More time for a deleted soldier is refused: they are no longer eligible for it.
    const longer = payloadOf(
      duty,
      segments(duty, [
        [alon, 44],
        [bar, 48],
      ])
    );
    const refused = await command(manager, "execution.preview", longer);
    expect(refused.blocked).toBe(true);
    await expect(
      command(manager, "execution.apply", { ...longer, token: refused.token })
    ).rejects.toMatchObject({ code: "segment_ineligible" });
    expect((await rowOf(duty.id, alon)).data.deletionDecidedAt).toBeUndefined();

    // Less is the manager's decision. The period has not ended, so it stays stored and is credited at its end.
    const { preview } = await save(
      duty,
      segments(duty, [
        [alon, 35],
        [bar, 48],
      ])
    );
    expect(
      (preview.changes as { soldierId: string; kind: string }[]).find(
        (item) => item.soldierId === alon.soldierId
      )!.kind
    ).toBe("update");
    const row = await rowOf(duty.id, alon);
    expect(row.status).toBe("reserved");
    expect(row.data.deletionDecidedAt).toBeTruthy();
    expect(row.data.needsAttention).toEqual([]);
    expect(await waiting()).toHaveLength(0);
    expect(await credits(alon)).toHaveLength(0);
    const later = new Date(Date.now() + 12 * HOUR);
    await unitTransaction((tx) => settleDue(tx, later));
    await unitTransaction((tx) => settleDue(tx, later));
    expect(await credits(alon)).toHaveLength(1);
    expect((await rowOf(duty.id, alon)).status).toBe("credited");
  });

  it("never credits twice when the worker and the manager's decision race", async () => {
    const duty = await runningDuty([alon], { startedHoursAgo: 50 });
    await remove(alon);
    const payload = payloadOf(
      duty,
      segments(duty, [
        [alon, 18],
        [bar, 48],
      ])
    );
    const preview = await command(manager, "execution.preview", payload);
    await Promise.allSettled([
      unitTransaction((tx) => settleDue(tx)),
      command(manager, "execution.apply", { ...payload, token: preview.token }),
      unitTransaction((tx) => settleDue(tx)),
    ]);
    await unitTransaction((tx) => settleDue(tx));
    expect(await credits(alon)).toHaveLength(1);
    expect(await balance(alon)).toBe(3);
    expect(await credits(bar)).toHaveLength(1);
    expect(await balance(bar)).toBe(5);
    const entries = await db
      .select()
      .from(ledger)
      .where(eq(ledger.soldierId, alon.soldierId!));
    expect(new Set(entries.map((entry) => entry.sourceKey)).size).toBe(
      entries.length
    );
  });

  it("keeps closed what the deletion path does not open: a credited period, and a deleted soldier as a new performer", async () => {
    const duty = await runningDuty([alon], { startedHoursAgo: 50 });
    await remove(alon);
    await save(
      duty,
      segments(duty, [
        [alon, 18],
        [bar, 48],
      ])
    );
    // Alon's credited part changes only through the correction rules, closed for a deleted account.
    await expect(
      command(
        manager,
        "execution.preview",
        payloadOf(
          duty,
          segments(duty, [
            [alon, 12],
            [bar, 48],
          ])
        )
      )
    ).rejects.toMatchObject({ code: "deleted_soldier" });

    // After removal from another seat, a deleted soldier cannot be put into it.
    const other = await runningDuty([bar], { startedHoursAgo: 50 });
    await expect(
      command(
        manager,
        "execution.preview",
        payloadOf(
          other,
          segments(other, [
            [alon, 12],
            [bar, 48],
          ])
        )
      )
    ).rejects.toMatchObject({ code: "deleted_soldier" });
    expect(await credits(alon)).toHaveLength(1);
  });

  it("writes no notice to the deleted soldier and one to the replacement", async () => {
    const duty = await runningDuty([alon]);
    await remove(alon);
    await save(
      duty,
      segments(duty, [
        [alon, 18],
        [bar, 48],
      ])
    );
    const notices = await db
      .select()
      .from(records)
      .where(eq(records.kind, "notification"));
    expect(
      notices.filter((item) => item.data.accountId === alon.id)
    ).toHaveLength(0);
    expect(
      notices.filter(
        (item) =>
          item.data.accountId === bar.id &&
          item.data.title === "עדכון בביצוע תורנות"
      )
    ).toHaveLength(1);
  });
});
