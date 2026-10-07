import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import { emailOutbox } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
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

// Mutual swap by consent (card #16, decisions 108-109, 181). Synthetic people only.
const DAY = 86_400_000;
let manager: Actor;
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
type Entry = { assignmentId: string; status: string };
async function requestRow(id: string) {
  const [row] = await db.select().from(records).where(eq(records.id, id));
  return row as typeof row & {
    data: { candidates: Entry[]; managerReasons: { code: string }[] };
  };
}
async function reserved(dutyId: string) {
  return (
    await db.select().from(assignments).where(eq(assignments.dutyId, dutyId))
  ).filter((row) => row.status === "reserved");
}
async function seatOf(dutyId: string, person: Actor) {
  const seat = (await reserved(dutyId)).find(
    (row) => row.soldierId === person.soldierId
  );
  if (!seat) throw new Error("seat not found");
  return seat;
}
/** A published duty with one seat per person, each with an optional call-up bonus. */
async function publishedDuty(
  seats: { person: Actor; bonus?: number }[],
  startInDays = 2,
  name = "תורנות לבדיקה"
) {
  const type = await command(manager, "dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: seats.length }],
  });
  const duty = await command(manager, "duty.create", {
    typeId: type.id,
    name,
    start: new Date(Date.now() + startInDays * DAY).toISOString(),
    end: new Date(Date.now() + (startInDays + 1) * DAY).toISOString(),
  });
  const created = await dutyRow(duty.id);
  let version = 1;
  for (const [index, { person, bonus }] of seats.entries()) {
    await command(
      manager,
      "duty.assign",
      {
        dutyId: duty.id,
        slotId: created.data.slots[index].id,
        soldierId: person.soldierId,
        callUpBonus: bonus ?? 0,
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
  return dutyRow(duty.id);
}
async function offer(from: Actor, dutyId: string, targets: string[]) {
  const seat = await seatOf(dutyId, from);
  return command(
    from,
    "swap.offer",
    { assignmentId: seat.id, targetAssignmentIds: targets },
    seat.version
  );
}
async function accept(
  person: Actor,
  requestId: string,
  assignmentId: string,
  key?: string,
  version?: number
) {
  const row = await requestRow(requestId);
  return command(
    person,
    "swap.respond",
    { id: requestId, assignmentId, decision: "accept", confirmed: true },
    version ?? row.version,
    key
  );
}
async function titles(person: Actor) {
  return (await readState(person)).notifications.map(
    (item) => (item as { title?: string }).title
  );
}
async function startNow(dutyId: string) {
  const row = await dutyRow(dutyId);
  await db
    .update(duties)
    .set({
      data: { ...row.data, start: new Date(Date.now() - 60_000).toISOString() },
    })
    .where(eq(duties.id, dutyId));
}
async function withExemption(person: Actor, dutyId: string) {
  const exemptionId = randomUUID();
  const [row] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, person.soldierId!));
  await db
    .update(soldiers)
    .set({
      data: {
        ...row.data,
        exemptions: [{ exemptionId, start: "2026-01-01", end: "2030-12-31" }],
      },
    })
    .where(eq(soldiers.id, person.soldierId!));
  const live = await dutyRow(dutyId);
  await db
    .update(duties)
    .set({
      data: {
        ...live.data,
        requirements: {
          ...live.data.requirements,
          blockingExemptionIds: [exemptionId],
        },
      },
    })
    .where(eq(duties.id, dutyId));
  return exemptionId;
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("אחראי לבדיקה", "manager", "00002");
  alon = await invite("חייל מציע", "soldier", "00001");
  bar = await invite("חייל שני", "soldier", "00004");
  chen = await invite("חייל שלישי", "soldier", "00005");
});
afterAll(async () => pool.end());

describe("mutual swap by consent before the start", () => {
  it("swaps both seats together with their full value, without a score check, and completes once when two acceptances race", async () => {
    // Alon's seat is worth 4 + 3 call-up bonus; the others are worth 4.
    const first = await publishedDuty([{ person: alon, bonus: 3 }], 2, "שמירה");
    const second = await publishedDuty([{ person: bar }], 4, "מטבח");
    const third = await publishedDuty([{ person: chen }], 5, "סיור");
    const seatA = await seatOf(first.id, alon);
    const seatB = await seatOf(second.id, bar);
    const seatC = await seatOf(third.id, chen);
    expect(seatA.points).toBe(7);
    for (const person of [bar, chen])
      await db
        .update(balances)
        .set({ current: 90 })
        .where(eq(balances.soldierId, person.soldierId!));

    await expect(
      command(
        bar,
        "swap.offer",
        { assignmentId: seatA.id, targetAssignmentIds: [seatB.id] },
        seatA.version
      )
    ).rejects.toThrow("בעל השיבוץ");
    const swap = await offer(alon, first.id, [seatB.id, seatC.id]);
    await expect(offer(alon, first.id, [seatB.id])).rejects.toThrow(
      "כבר קיימת"
    );
    // One open offer per seat: a transfer of the same seat is refused too.
    await expect(
      command(
        alon,
        "transfer.offer",
        { assignmentId: seatA.id, candidateIds: [bar.soldierId] },
        seatA.version
      )
    ).rejects.toThrow("כבר קיימת");
    // Until completion the original seats stand.
    expect((await reserved(first.id)).map((row) => row.soldierId)).toEqual([
      alon.soldierId,
    ]);
    const barView = (await readState(bar)).requests.filter(
      (row) => row.type === "swap"
    );
    expect(barView).toHaveLength(1);
    expect(barView[0]).toMatchObject({
      status: "awaiting_consent",
      candidates: [{ assignmentId: seatB.id, status: "pending" }],
    });
    expect(JSON.stringify(barView)).not.toContain(chen.soldierId);
    expect(
      (await readState(alon)).requests.find((row) => row.id === swap.id)
        ?.candidates
    ).toHaveLength(2);
    const outsider = await invite("חייל אחר", "soldier", "00006");
    expect(
      (await readState(outsider)).requests.filter((row) => row.type === "swap")
    ).toHaveLength(0);
    // A soldier cannot answer for another soldier's seat.
    await expect(accept(bar, swap.id, seatC.id)).rejects.toThrow("אינה מיועדת");

    const key = randomUUID();
    const { version } = await requestRow(swap.id);
    const outcomes = await Promise.allSettled([
      accept(bar, swap.id, seatB.id, key, version),
      accept(chen, swap.id, seatC.id),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    const done = await requestRow(swap.id);
    expect(done.data.status).toBe("completed");
    const winner = done.data.acceptedBy === bar.soldierId ? bar : chen;
    const loser = winner === bar ? chen : bar;
    const winnerDuty = winner === bar ? second : third;
    const loserDuty = winner === bar ? third : second;
    const winnerSeat = winner === bar ? seatB : seatC;
    // Retrying the winning request is idempotent.
    if (winner === bar)
      expect(await accept(bar, swap.id, seatB.id, key, version)).toMatchObject({
        status: "completed",
      });
    // The offerer's seat, with its bonus, moved to the winner; the winner's seat to the offerer.
    expect(await reserved(first.id)).toEqual([
      expect.objectContaining({
        soldierId: winner.soldierId,
        slotId: seatA.slotId,
        points: 7,
        data: expect.objectContaining({ extraPoints: "3" }),
      }),
    ]);
    expect(await reserved(winnerDuty.id)).toEqual([
      expect.objectContaining({
        soldierId: alon.soldierId,
        slotId: winnerSeat.slotId,
        points: 4,
      }),
    ]);
    // The loser's own seat is untouched and nobody holds a seat twice.
    expect(await reserved(loserDuty.id)).toEqual([
      expect.objectContaining({ soldierId: loser.soldierId }),
    ]);
    for (const original of [seatA, winnerSeat]) {
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, original.id));
      expect(row.status).toBe("cancelled");
      expect(row.data).toMatchObject({
        endedBy: { kind: "swap", requestId: swap.id },
      });
    }
    const loserView = (await readState(loser)).requests.find(
      (row) => row.id === swap.id
    );
    expect(loserView?.status).toBe("closed");
    expect(await titles(alon)).toContain("ההחלפה הושלמה");
    expect(await titles(winner)).toContain("ההחלפה הושלמה");
    expect(await titles(loser)).toContain("הצעת ההחלפה נסגרה");
    expect(await titles(manager)).toContain("הושלמה החלפת תורנויות");
    const mail = await db
      .select()
      .from(emailOutbox)
      .where(like(emailOutbox.eventKey, `swap:${swap.id}:%`));
    expect(mail.every((item) => item.kind === "transfer")).toBe(true);
    expect(mail.map((item) => item.eventKey.split(":")[2]).sort()).toEqual([
      "completed",
      "completed",
      "offer",
      "offer",
    ]);
    // Points go to whoever performs, with the full value of their new seat.
    const end = new Date(Date.now() + 10 * DAY);
    await unitTransaction((tx) => settleDue(tx, end));
    const scores = await db.select().from(balances);
    const score = (person: Actor) =>
      scores.find((item) => item.soldierId === person.soldierId)?.current;
    expect(score(winner)).toBe(97);
    expect(score(alon)).toBe(4);
    expect(score(loser)).toBe(94);
  });

  it("checks the state after the swap, so overlapping source duties and seats in one duty are not a self-conflict", async () => {
    // Both duties run at the same time: each soldier leaves one and takes the other.
    const first = await publishedDuty([{ person: alon }], 2, "שמירה");
    const second = await publishedDuty([{ person: bar }], 2, "מטבח");
    const swap = await offer(alon, first.id, [
      (await seatOf(second.id, bar)).id,
    ]);
    expect(
      await accept(bar, swap.id, (await seatOf(second.id, bar)).id)
    ).toMatchObject({ status: "completed" });
    expect((await seatOf(first.id, bar)).points).toBe(4);
    expect((await seatOf(second.id, alon)).points).toBe(4);

    // Two seats in the same duty, with different values, swap places.
    const shared = await publishedDuty(
      [{ person: alon }, { person: chen, bonus: 2 }],
      6,
      "תורנות משותפת"
    );
    const before = await dutyRow(shared.id);
    const seatA = await seatOf(shared.id, alon);
    const seatC = await seatOf(shared.id, chen);
    const inPlace = await offer(alon, shared.id, [seatC.id]);
    await accept(chen, inPlace.id, seatC.id);
    const after = await seatOf(shared.id, alon);
    expect(after).toMatchObject({ slotId: seatC.slotId, points: 6 });
    expect(await seatOf(shared.id, chen)).toMatchObject({
      slotId: seatA.slotId,
      points: 4,
    });
    expect((await reserved(shared.id)).length).toBe(2);
    expect((await dutyRow(shared.id)).version).toBe(before.version + 1);
  });

  it("rechecks both sides at acceptance and keeps both seats when one side no longer fits, without revealing the offerer's reason", async () => {
    const first = await publishedDuty([{ person: alon }], 2, "שמירה");
    const second = await publishedDuty([{ person: bar }], 4, "מטבח");
    const third = await publishedDuty([{ person: chen }], 6, "סיור");
    const seatB = await seatOf(second.id, bar);
    const seatC = await seatOf(third.id, chen);
    const swap = await offer(alon, first.id, [seatB.id, seatC.id]);

    // Bar was given another duty overlapping Alon's after the offer: Bar no longer fits.
    const clash = await publishedDuty([{ person: bar }], 2, "חפיפה לבר");
    const refused = accept(bar, swap.id, seatB.id);
    await expect(refused).rejects.toThrow("אינך עומד כעת");
    expect((await requestRow(swap.id)).data.status).toBe("awaiting_consent");

    // Alon was given a duty overlapping Chen's: Alon no longer fits Chen's seat.
    await publishedDuty([{ person: alon }], 6, "חפיפה לאלון");
    const closed = accept(chen, swap.id, seatC.id);
    await expect(closed).rejects.toThrow("המציע אינו עומד");
    const error = await closed.catch((reason: Error) => reason.message);
    expect(error).not.toContain("חפיפה");
    const row = await requestRow(swap.id);
    expect(
      row.data.candidates.find((item) => item.assignmentId === seatC.id)?.status
    ).toBe("closed");
    // Bar's entry is still open, so the offer as a whole is.
    expect(row.data.status).toBe("awaiting_consent");
    expect(await titles(alon)).toContain("ההחלפה לא הושלמה");
    // Nothing moved.
    for (const [dutyId, person] of [
      [first.id, alon],
      [second.id, bar],
      [third.id, chen],
      [clash.id, bar],
    ] as const)
      expect((await reserved(dutyId)).map((item) => item.soldierId)).toEqual([
        person.soldierId,
      ]);
  });

  it("closes the entries of seats that moved or of a duty that changed, and competing moves of a seat end in one outcome", async () => {
    const first = await publishedDuty([{ person: alon }], 2, "שמירה");
    const second = await publishedDuty([{ person: bar }], 4, "מטבח");
    const third = await publishedDuty([{ person: chen }], 6, "סיור");
    const seatB = await seatOf(second.id, bar);
    const seatC = await seatOf(third.id, chen);
    const swap = await offer(alon, first.id, [seatB.id, seatC.id]);
    // Bar offers the same seat to Chen as a transfer; Bar's swap and Chen's transfer race.
    const transfer = await command(
      bar,
      "transfer.offer",
      { assignmentId: seatB.id, candidateIds: [chen.soldierId] },
      seatB.version
    );
    const transferRow = await requestRow(transfer.id);
    const outcomes = await Promise.allSettled([
      accept(bar, swap.id, seatB.id),
      command(
        chen,
        "transfer.respond",
        { id: transfer.id, decision: "accept", confirmed: true },
        transferRow.version
      ),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    const holders = [
      ...(await reserved(first.id)),
      ...(await reserved(second.id)),
      ...(await reserved(third.id)),
    ];
    expect(holders).toHaveLength(3);
    const swapRow = await requestRow(swap.id);
    const transferAfter = await requestRow(transfer.id);
    if (swapRow.data.status === "completed") {
      // The swap moved Bar's seat, so the transfer that rested on it closed.
      expect(transferAfter.data.status).toBe("expired");
      expect((await seatOf(second.id, alon)).soldierId).toBe(alon.soldierId);
    } else {
      // The transfer moved Bar's seat: its swap entry closed, Chen's stays open.
      expect(transferAfter.data.status).toBe("completed");
      expect(swapRow.data.status).toBe("awaiting_consent");
      expect(
        swapRow.data.candidates.map((item) => [item.assignmentId, item.status])
      ).toEqual([
        [seatB.id, "closed"],
        [seatC.id, "pending"],
      ]);
      expect((await seatOf(first.id, alon)).soldierId).toBe(alon.soldierId);
      // Cancelling the other duty closes the last entry, and the offer with it.
      const live = await dutyRow(third.id);
      await command(
        manager,
        "duty.cancel",
        { id: third.id, reason: "ביטול לבדיקה", confirmed: true },
        live.version
      );
      expect((await requestRow(swap.id)).data.status).toBe("expired");
    }
  });

  it("sends a swap whose duty started to a manager, who needs a handover time to approve it and may reject it with a visible reason", async () => {
    const first = await publishedDuty([{ person: alon }], 2, "שמירה");
    const second = await publishedDuty([{ person: bar }], 4, "מטבח");
    const seatA = await seatOf(first.id, alon);
    const seatB = await seatOf(second.id, bar);
    const swap = await offer(alon, first.id, [seatB.id]);
    // The acceptance comes after Bar's duty started, although the offer came before.
    await startNow(second.id);
    expect(await accept(bar, swap.id, seatB.id)).toMatchObject({
      status: "awaiting_manager",
    });
    expect(await titles(manager)).toContain("החלפה ממתינה לטיפול");
    const row = await requestRow(swap.id);
    expect(row.data.managerReasons.map((item) => item.code)).toEqual([
      "started",
    ]);
    await expect(
      command(manager, "swap.review", { id: swap.id }, row.version)
    ).resolves.toMatchObject({ valid: true, started: true });
    await expect(
      command(
        bar,
        "swap.decide",
        { id: swap.id, decision: "reject", reason: "לא מתאים" },
        row.version
      )
    ).rejects.toThrow("לאחראי");
    // After the start a seat is split at a handover the manager sets (decision 183).
    await expect(
      command(
        manager,
        "swap.decide",
        {
          id: swap.id,
          decision: "approve",
          confirmed: true,
          previewToken: "x",
          approvalKeys: [],
        },
        row.version
      )
    ).rejects.toThrow("מועד החילוף");
    await command(
      manager,
      "swap.decide",
      { id: swap.id, decision: "reject", reason: "יש לתאם בתקופות ביצוע" },
      row.version
    );
    expect((await requestRow(swap.id)).data.status).toBe("manager_rejected");
    const rejectionMail = (await db.select().from(emailOutbox)).filter(
      (mail) => mail.requestId === swap.id && mail.requestEvent === "rejected"
    );
    expect(rejectionMail).toHaveLength(2);
    for (const mail of rejectionMail) {
      expect(mail.body).not.toContain("יש לתאם בתקופות ביצוע");
      expect(mail.body).toContain("פרטי ההחלטה באתר");
    }
    for (const person of [alon, bar]) {
      const view = (await readState(person)).requests.find(
        (item) => item.id === swap.id
      );
      expect(view).toMatchObject({
        status: "manager_rejected",
        decisionReason: "יש לתאם בתקופות ביצוע",
      });
    }
    expect((await seatOf(first.id, alon)).id).toBe(seatA.id);
    expect((await seatOf(second.id, bar)).id).toBe(seatB.id);
  });

  it("lets a manager approve each side's exception separately, keeps the reason with managers, and needs a fresh review after a change", async () => {
    const first = await publishedDuty([{ person: alon }], 2, "שמירה");
    const second = await publishedDuty([{ person: bar }], 4, "מטבח");
    const seatB = await seatOf(second.id, bar);
    // Bar has an exemption that blocks Alon's duty type.
    const exemptionId = await withExemption(bar, first.id);
    const swap = await offer(alon, first.id, [seatB.id]);
    expect(await accept(bar, swap.id, seatB.id)).toMatchObject({
      status: "awaiting_manager",
    });
    // Bar's exemption is Bar's own: Alon never sees it.
    const alonView = (await readState(alon)).requests.find(
      (item) => item.id === swap.id
    );
    expect(alonView?.managerReasons).toEqual([]);
    const barView = (await readState(bar)).requests.find(
      (item) => item.id === swap.id
    );
    expect(barView?.managerReasons).toEqual([
      expect.objectContaining({ code: "exemption", referenceId: exemptionId }),
    ]);
    let row = await requestRow(swap.id);
    const review = (await command(
      manager,
      "swap.review",
      { id: swap.id },
      row.version
    )) as unknown as {
      status: string;
      previewToken: string;
      sides: { soldierId: string; requirements: { key: string }[] }[];
    };
    expect(review.status).toBe("approval_required");
    const keys = review.sides.flatMap((side) =>
      side.requirements.map((item) => item.key)
    );
    expect(keys).toEqual([`${bar.soldierId}|exemption:${exemptionId}:`]);
    await expect(
      command(
        manager,
        "swap.decide",
        {
          id: swap.id,
          decision: "approve",
          confirmed: true,
          previewToken: review.previewToken,
          approvalReason: "אושר נקודתית",
          approvalKeys: [],
        },
        row.version
      )
    ).rejects.toThrow("לכל חריג");
    // A change to Alon's seats after the review invalidates it.
    await publishedDuty([{ person: alon }], 8, "שיבוץ נוסף");
    await expect(
      command(
        manager,
        "swap.decide",
        {
          id: swap.id,
          decision: "approve",
          confirmed: true,
          previewToken: review.previewToken,
          approvalReason: "אושר נקודתית",
          approvalKeys: keys,
        },
        row.version
      )
    ).rejects.toThrow("לבדוק שוב");
    row = await requestRow(swap.id);
    const fresh = (await command(
      manager,
      "swap.review",
      { id: swap.id },
      row.version
    )) as unknown as { previewToken: string };
    expect(
      await command(
        manager,
        "swap.decide",
        {
          id: swap.id,
          decision: "approve",
          confirmed: true,
          previewToken: fresh.previewToken,
          approvalReason: "אושר נקודתית",
          approvalKeys: keys,
        },
        row.version
      )
    ).toMatchObject({ status: "completed" });
    const barSeat = await seatOf(first.id, bar);
    expect(barSeat.data.approvals).toEqual([
      expect.objectContaining({
        kind: "exemption",
        soldierId: bar.soldierId,
        dutyId: first.id,
        reason: "אושר נקודתית",
      }),
    ]);
    expect((await seatOf(second.id, alon)).data.approvals).toEqual([]);
    for (const person of [alon, bar]) {
      const view = JSON.stringify(
        (await readState(person)).requests.find((item) => item.id === swap.id)
      );
      expect(view).not.toContain("אושר נקודתית");
      expect(view).toContain(manager.name);
    }
    expect(await titles(alon)).toContain("האחראי אישר את ההחלפה");
  });

  it("lets the offerer withdraw before consent and either side back out while a manager decides", async () => {
    const first = await publishedDuty([{ person: alon }], 2, "שמירה");
    const second = await publishedDuty([{ person: bar }], 4, "מטבח");
    const seatB = await seatOf(second.id, bar);
    const swap = await offer(alon, first.id, [seatB.id]);
    let row = await requestRow(swap.id);
    await expect(
      command(bar, "swap.withdraw", { id: swap.id }, row.version)
    ).rejects.toThrow("רק מי שהציע");
    await command(alon, "swap.withdraw", { id: swap.id }, row.version);
    await expect(accept(bar, swap.id, seatB.id)).rejects.toThrow("כבר נסגרה");

    await withExemption(bar, first.id);
    const again = await offer(alon, first.id, [seatB.id]);
    await accept(bar, again.id, seatB.id);
    row = await requestRow(again.id);
    expect(row.data.status).toBe("awaiting_manager");
    // While Bar's consent waits for a manager, Bar's seat is not on offer elsewhere.
    const third = await publishedDuty([{ person: chen }], 6, "סיור");
    await expect(offer(chen, third.id, [seatB.id])).rejects.toThrow(
      "ממתין להחלטת אחראי"
    );
    await command(bar, "swap.withdraw", { id: again.id }, row.version);
    expect((await requestRow(again.id)).data).toMatchObject({
      status: "cancelled",
      closedReason: "הצד השני חזר בו מהסכמתו לפני החלטת האחראי",
    });
    expect(await titles(alon)).toContain("ההחלפה בוטלה");
    expect((await seatOf(first.id, alon)).soldierId).toBe(alon.soldierId);
    expect((await seatOf(second.id, bar)).soldierId).toBe(bar.soldierId);
  });

  it("refuses unsuitable or unavailable seats at the offer without revealing why", async () => {
    const first = await publishedDuty([{ person: alon }], 2, "שמירה");
    const second = await publishedDuty([{ person: bar }], 4, "מטבח");
    const seatB = await seatOf(second.id, bar);
    // Bar already holds a seat overlapping Alon's duty.
    await publishedDuty([{ person: bar }], 2, "חפיפה");
    const refused = offer(alon, first.id, [seatB.id]);
    await expect(refused).rejects.toThrow("אינו מתאים לתורנות שלך");
    await expect(refused).rejects.not.toThrow("חפיפה");
    // A seat whose duty already started is not on offer.
    const third = await publishedDuty([{ person: chen }], 4, "סיור");
    await startNow(third.id);
    // A started fixed-rate seat can be offered, but its split needs a manager's allocation.
    const startedOffer = await offer(alon, first.id, [
      (await seatOf(third.id, chen)).id,
    ]);
    expect(startedOffer.id).toBeTruthy();
    // A manager takes no part in duties, so never offers a swap, on anyone's behalf (decision 192).
    const seatA = await seatOf(first.id, alon);
    await expect(
      command(
        manager,
        "swap.offer",
        { assignmentId: seatA.id, targetAssignmentIds: [seatB.id] },
        seatA.version
      )
    ).rejects.toThrow("אחראי תורנויות אינו משובץ");
    // Another soldier cannot offer Alon's seat either.
    await expect(
      command(
        chen,
        "swap.offer",
        { assignmentId: seatA.id, targetAssignmentIds: [seatB.id] },
        seatA.version
      )
    ).rejects.toThrow("בעל השיבוץ");
  });
});
