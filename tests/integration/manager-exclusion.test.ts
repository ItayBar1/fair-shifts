import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool, unitTransaction } from "../../src/server/db";
import { emailOutbox, user } from "../../src/server/auth-schema";
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
import { deliverNextEmail } from "../../src/server/operations/email";
import { refreshRoundNotices } from "../../src/server/round-notices";
import { roundEventKey } from "../../src/domain/round-notices";
import { MANAGER_BLOCKER_MESSAGE } from "../../src/domain/eligibility";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// A duty manager is never assigned to a duty (card #82, decision 192). Synthetic people only.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let technical: Actor;
let manager: Actor;
let otherManager: Actor;
let alon: Actor;
let bar: Actor;
let chen: Actor;
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
async function accountOf(person: Actor) {
  const [row] = await db.select().from(user).where(eq(user.id, person.id));
  return row;
}
/** The person as the session would see them after a role change. */
async function actorOf(person: Actor): Promise<Actor> {
  const row = await accountOf(person);
  return {
    id: row.id,
    name: row.name,
    role: row.role as Actor["role"],
    soldierId: row.soldierId ?? undefined,
    securityEpoch: row.securityEpoch,
  };
}
async function setRole(person: Actor, role: "soldier" | "manager") {
  const row = await accountOf(person);
  await command(
    technical,
    "account.role",
    { id: person.id, role },
    row.securityEpoch
  );
  return actorOf(person);
}
async function dutyRow(id: string) {
  const [row] = await db.select().from(duties).where(eq(duties.id, id));
  return row;
}
async function seatsOf(dutyId: string) {
  return (
    await db.select().from(assignments).where(eq(assignments.dutyId, dutyId))
  ).filter((row) => row.status !== "cancelled");
}
async function assignmentOf(person: Actor, dutyId?: string) {
  const rows = (await db.select().from(assignments)).filter(
    (row) =>
      row.soldierId === person.soldierId &&
      row.status !== "cancelled" &&
      (!dutyId || row.dutyId === dutyId)
  );
  if (!rows.length) throw new Error("assignment not found");
  return rows[0];
}
async function attention(person: Actor) {
  return (await db.select().from(assignments))
    .filter((row) => row.soldierId === person.soldierId)
    .map((row) => ({
      status: row.status,
      marks: row.data.needsAttention ?? [],
    }));
}
async function balanceOf(person: Actor) {
  const [row] = await db
    .select()
    .from(balances)
    .where(eq(balances.soldierId, person.soldierId!));
  return row.current;
}
async function notices(person: Actor) {
  return (await readState(person)).notifications as unknown as {
    title: string;
    body: string;
    href?: string;
  }[];
}
async function type(roles = 1, mode: "fixed" | "daily" = "fixed") {
  return command(manager, "dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode, base: 4 },
    roles: [{ name: "תורן", count: roles }],
  });
}
/** A draft duty `days` ahead, lasting `hours`; its first seat is at `slots[0]`. */
async function draft(
  seats = 1,
  days = 3,
  hours = 8,
  name = "תורנות לבדיקה",
  mode: "fixed" | "daily" = "fixed"
) {
  const kind = await type(seats, mode);
  const start = Math.floor(Date.now() / HOUR) * HOUR + days * DAY;
  const created = await command(manager, "duty.create", {
    typeId: kind.id,
    name,
    start: new Date(start).toISOString(),
    end: new Date(start + hours * HOUR).toISOString(),
  });
  return dutyRow(created.id);
}
async function assign(
  duty: { id: string; data: { slots: { id: string }[] } },
  person: Actor,
  index = 0
) {
  const live = await dutyRow(duty.id);
  return command(
    manager,
    "duty.assign",
    {
      dutyId: duty.id,
      slotId: duty.data.slots[index].id,
      soldierId: person.soldierId,
    },
    live.version
  );
}
async function publish(dutyId: string) {
  const live = await dutyRow(dutyId);
  return command(
    manager,
    "duty.publish",
    { id: dutyId, confirmed: true },
    live.version
  );
}
/** A published duty with the people in its seats. */
async function published(
  people: Actor[],
  days = 3,
  name = "תורנות שפורסמה",
  mode: "fixed" | "daily" = "fixed"
) {
  const duty = await draft(people.length, days, 8, name, mode);
  for (const [index, person] of people.entries())
    await assign(duty, person, index);
  await publish(duty.id);
  return dutyRow(duty.id);
}
async function startNow(dutyId: string) {
  const row = await dutyRow(dutyId);
  const start = new Date(row.data.start).getTime();
  const shift = start - (Date.now() - HOUR);
  await db
    .update(duties)
    .set({
      data: {
        ...row.data,
        start: new Date(start - shift).toISOString(),
        end: new Date(new Date(row.data.end).getTime() - shift).toISOString(),
      },
    })
    .where(eq(duties.id, dutyId));
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  serial = 10;
  const tech = await createInvitedAccount({
    name: "טכני לבדיקה",
    role: "technical",
    email: "technical@example.invalid",
  });
  technical = {
    id: tech.id,
    name: tech.name,
    role: "technical",
    securityEpoch: 1,
  };
  // The managers hold the lowest balance, so a rule that let them in would pick them first.
  manager = await invite("אחראי ראשון", "manager", 0);
  otherManager = await invite("אחראי שני", "manager", 0);
  alon = await invite("אלון", "soldier", 100);
  bar = await invite("בר", "soldier", 100);
  chen = await invite("חן", "soldier", 100);
});
afterAll(async () => pool.end());

describe("a manager is refused in every assignment path", () => {
  it("refuses a manual assignment with the reason, directly through the API", async () => {
    const duty = await draft();
    const slotId = duty.data.slots[0].id;
    const preview = (await command(
      manager,
      "duty.assignment.preview",
      { dutyId: duty.id, slotId, soldierId: otherManager.soldierId },
      duty.version
    )) as unknown as {
      status: string;
      blockers: { code: string; message: string }[];
    };
    expect(preview.status).toBe("blocked");
    expect(preview.blockers).toEqual([
      { code: "manager", message: MANAGER_BLOCKER_MESSAGE },
    ]);
    // The manager's own soldier record is refused as well.
    for (const target of [otherManager, manager])
      await expect(
        command(
          manager,
          "duty.assign",
          { dutyId: duty.id, slotId, soldierId: target.soldierId },
          duty.version
        )
      ).rejects.toMatchObject({
        code: "blocked",
        status: 422,
        message: MANAGER_BLOCKER_MESSAGE,
      });
    expect(await seatsOf(duty.id)).toHaveLength(0);
    // The seat itself is fine: a soldier takes it.
    await assign(duty, alon);
    expect(await seatsOf(duty.id)).toHaveLength(1);
  });

  it("never draws a manager, and leaves one out of the draw's picture", async () => {
    const duty = await draft();
    await command(
      manager,
      "duty.lottery",
      { dutyId: duty.id, slotId: duty.data.slots[0].id },
      duty.version
    );
    const [attempt] = await db
      .select()
      .from(records)
      .where(eq(records.kind, "lottery_attempt"));
    const ids = (attempt.data.candidates as { id: string }[]).map(
      (row) => row.id
    );
    expect(ids.sort()).toEqual(
      [alon.soldierId, bar.soldierId, chen.soldierId].sort()
    );
    expect(attempt.data.minimum).toBe(100);
    const [seat] = await seatsOf(duty.id);
    expect([alon, bar, chen].map((row) => row.soldierId)).toContain(
      seat.soldierId
    );
  });

  it("leaves a seat missing in a period plan rather than filling it with a manager", async () => {
    // Two seats, and only one soldier who can take one of them.
    await db
      .update(soldiers)
      .set({ deletedAt: new Date() })
      .where(eq(soldiers.id, bar.soldierId!));
    await db
      .update(soldiers)
      .set({ deletedAt: new Date() })
      .where(eq(soldiers.id, chen.soldierId!));
    const duty = await draft(2);
    const date = DateTime.fromISO(duty.data.start)
      .setZone("Asia/Jerusalem")
      .toISODate()!;
    const plan = await command(manager, "planning.run", {
      start: date,
      end: date,
    });
    let current = (
      await db.select().from(records).where(eq(records.id, plan.id))
    )[0];
    for (let i = 0; i < 6 && current.data.status === "running"; i++) {
      await command(manager, "planning.step", { id: plan.id }, current.version);
      current = (
        await db.select().from(records).where(eq(records.id, plan.id))
      )[0];
    }
    expect(current.data.status).toBe("completed");
    expect(current.data.missing).toHaveLength(1);
    expect((await seatsOf(duty.id)).map((row) => row.soldierId)).toEqual([
      alon.soldierId,
    ]);
  });

  it("refuses a manager in a current execution period, and lets the period of one who was appointed be handed over", async () => {
    // A daily rate: a seat at a fixed rate cannot be split until card #19.
    const duty = await published([alon], 3, "אבטחה ממושכת", "daily");
    await startNow(duty.id);
    const live = await dutyRow(duty.id);
    const start = new Date(live.data.start).getTime();
    const half = new Date(start + 4 * HOUR).toISOString();
    const parts = (second: Actor) => [
      {
        soldierId: alon.soldierId,
        start: new Date(start).toISOString(),
        end: half,
      },
      { soldierId: second.soldierId, start: half, end: live.data.end },
    ];
    const payload = (second: Actor) => ({
      dutyId: duty.id,
      slotId: live.data.slots[0].id,
      segments: parts(second),
      reason: "חילוף באמצע התורנות",
    });
    const preview = (await command(
      manager,
      "execution.preview",
      payload(otherManager)
    )) as unknown as {
      changes: { eligibility?: { blockers: { code: string }[] } }[];
    };
    expect(
      preview.changes.some((change) =>
        change.eligibility?.blockers.some((row) => row.code === "manager")
      )
    ).toBe(true);
    await expect(
      command(manager, "execution.apply", {
        ...payload(otherManager),
        token: (preview as unknown as { token: string }).token,
      })
    ).rejects.toMatchObject({ code: "segment_ineligible" });

    // Alon is appointed while the duty runs: the seat stays, marked, and a manager hands it over.
    await setRole(alon, "manager");
    expect(await attention(alon)).toEqual([
      { status: "reserved", marks: ["manager"] },
    ]);
    const handover = await command(manager, "execution.preview", payload(bar));
    await command(manager, "execution.apply", {
      ...payload(bar),
      token: (handover as unknown as { token: string }).token,
    });
    const seats = await seatsOf(duty.id);
    expect(seats.map((row) => row.soldierId).sort()).toEqual(
      [alon.soldierId, bar.soldierId].sort()
    );
  });

  it("refuses a manager in a change proposal and needs a kept manager replaced before publishing", async () => {
    const duty = await published([alon]);
    const created = await command(
      manager,
      "duty.change.create",
      { dutyId: duty.id, reason: "שינוי לבדיקה" },
      duty.version
    );
    const seat = (soldierId: string) => ({
      ...duty.data,
      id: created.id,
      seats: [{ slotId: duty.data.slots[0].id, soldierId, extraPoints: 0 }],
      reason: "החלפת מבצע",
    });
    await command(
      manager,
      "duty.change.save",
      seat(otherManager.soldierId!),
      1
    );
    const blocked = (await command(
      manager,
      "duty.change.preview",
      { id: created.id },
      2
    )) as unknown as {
      previewToken: string;
      checks: { status: string; blockers: { code: string }[] }[];
    };
    expect(blocked.checks[0].status).toBe("blocked");
    expect(blocked.checks[0].blockers.map((row) => row.code)).toContain(
      "manager"
    );
    await expect(
      command(
        manager,
        "duty.change.publish",
        { id: created.id, confirmed: true, previewToken: blocked.previewToken },
        2
      )
    ).rejects.toThrow();
    // A soldier in the seat: the proposal goes through.
    await command(manager, "duty.change.save", seat(bar.soldierId!), 2);
    const fine = (await command(
      manager,
      "duty.change.preview",
      { id: created.id },
      3
    )) as unknown as { previewToken: string };
    await command(
      manager,
      "duty.change.publish",
      { id: created.id, confirmed: true, previewToken: fine.previewToken },
      3
    );
    expect((await seatsOf(duty.id)).map((row) => row.soldierId)).toEqual([
      bar.soldierId,
    ]);
  });
});

describe("transfers, swaps and constraint rounds leave managers out", () => {
  it("does not offer a transfer to a manager, and a manager offers none", async () => {
    const duty = await published([alon, chen]);
    const seat = await assignmentOf(alon, duty.id);
    const refused = command(
      alon,
      "transfer.offer",
      { assignmentId: seat.id, candidateIds: [otherManager.soldierId] },
      seat.version
    );
    await expect(refused).rejects.toMatchObject({
      code: "candidate_ineligible",
    });
    // The offerer learns only that the candidate is unsuitable, never why.
    await expect(refused).rejects.not.toThrow(MANAGER_BLOCKER_MESSAGE);
    const held = await assignmentOf(chen, duty.id);
    chen = await setRole(chen, "manager");
    await expect(
      command(
        chen,
        "transfer.offer",
        { assignmentId: held.id, candidateIds: [bar.soldierId] },
        held.version
      )
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("does not let an appointed soldier accept a transfer offered before", async () => {
    const duty = await published([alon]);
    const seat = await assignmentOf(alon, duty.id);
    const offer = await command(
      alon,
      "transfer.offer",
      { assignmentId: seat.id, candidateIds: [bar.soldierId] },
      seat.version
    );
    const appointed = await setRole(bar, "manager");
    const [row] = await db
      .select()
      .from(records)
      .where(eq(records.id, offer.id));
    await expect(
      command(
        appointed,
        "transfer.respond",
        { id: offer.id, decision: "accept", confirmed: true },
        row.version
      )
    ).rejects.toMatchObject({ code: "candidate_ineligible" });
    expect((await assignmentOf(alon, duty.id)).status).toBe("reserved");
    expect(await seatsOf(duty.id)).toHaveLength(1);
  });

  it("does not put a manager's kept seat on offer in a swap, and a manager offers none", async () => {
    const mine = await published([alon], 3, "שלי");
    const theirs = await published([chen], 4, "שלו");
    chen = await setRole(chen, "manager");
    const seat = await assignmentOf(alon, mine.id);
    const target = await assignmentOf(chen, theirs.id);
    await expect(
      command(
        alon,
        "swap.offer",
        { assignmentId: seat.id, targetAssignmentIds: [target.id] },
        seat.version
      )
    ).rejects.toMatchObject({ code: "candidate_ineligible" });
    await expect(
      command(
        chen,
        "swap.offer",
        { assignmentId: target.id, targetAssignmentIds: [seat.id] },
        target.version
      )
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("takes no constraints from a manager and sends no round notice to one", async () => {
    const now = Date.now();
    const round = await command(manager, "round.create", {
      name: "סבב סינתטי",
      opensAt: new Date(now - 60_000).toISOString(),
      closesAt: new Date(now + 3 * DAY).toISOString(),
      targetStart: DateTime.now().plus({ days: 5 }).toISODate()!,
      targetEnd: DateTime.now().plus({ days: 10 }).toISODate()!,
    });
    await expect(
      command(manager, "constraint.submit", { roundId: round.id, none: true })
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(
      (await db.select().from(records)).filter(
        (row) => row.kind === "constraint"
      )
    ).toHaveLength(0);
    // The opening is queued for the soldiers only; one appointed before delivery gets no email.
    await unitTransaction((tx) => refreshRoundNotices(tx, new Date(now)));
    for (const person of [manager, otherManager])
      expect(
        (await notices(person)).filter((row) => row.href === "/constraints")
      ).toEqual([]);
    expect(
      (await notices(alon)).filter((row) => row.href === "/constraints")
    ).toHaveLength(1);
    await setRole(bar, "manager");
    const sent: string[] = [];
    for (let i = 0; i < 10; i++) {
      const result = await deliverNextEmail(
        async (message) => {
          sent.push(message.eventKey);
          return "synthetic";
        },
        new Date(now + 1000)
      );
      if (result.status === "idle") break;
    }
    expect(sent.sort()).toEqual(
      [
        roundEventKey(round.id, 0, "opening", alon.id),
        roundEventKey(round.id, 0, "opening", chen.id),
      ].sort()
    );
    expect(
      await db
        .select()
        .from(emailOutbox)
        .where(like(emailOutbox.eventKey, `round:${round.id}:%`))
    ).toHaveLength(3);
  });
});

describe("granting and removing the role", () => {
  it("marks the soldier's reservations, keeps them in force and tells the managers", async () => {
    const inDraft = await draft(1, 3, 8, "טיוטה");
    await assign(inDraft, alon);
    const live = await published([alon], 5, "מפורסמת");
    const ended = await published([alon], 7, "שהסתיימה");
    // A duty that ended and was credited is history, and is left alone.
    const history = await assignmentOf(alon, ended.id);
    await db
      .update(assignments)
      .set({
        status: "credited",
        data: { ...history.data, status: "credited" },
      })
      .where(eq(assignments.id, history.id));
    const before = {
      balance: await balanceOf(alon),
      entries: (await db.select().from(ledger)).length,
    };

    const result = await command(
      technical,
      "account.role",
      { id: alon.id, role: "manager" },
      1
    );
    expect(result).toEqual({ success: true });
    const marks = await attention(alon);
    expect(marks.filter((row) => row.status === "reserved")).toEqual([
      { status: "reserved", marks: ["manager"] },
      { status: "reserved", marks: ["manager"] },
    ]);
    expect(marks.find((row) => row.status === "credited")?.marks).toEqual([]);
    // Nothing is removed or cancelled, and no balance or history changes.
    expect((await assignmentOf(alon, live.id)).status).toBe("reserved");
    expect((await assignmentOf(alon, inDraft.id)).status).toBe("reserved");
    expect(await balanceOf(alon)).toBe(before.balance);
    expect((await db.select().from(ledger)).length).toBe(before.entries);

    // Every manager, the new one included, is told once; soldiers and the technical account are not.
    const appointed = await actorOf(alon);
    for (const person of [manager, otherManager, appointed]) {
      const told = (await notices(person)).filter(
        (row) => row.title === "חייל מונה לאחראי תורנויות"
      );
      expect(told).toHaveLength(1);
      expect(told[0].body).toContain("אלון");
      expect(told[0].body).toContain("2 שיבוצים שלו מסומנים לטיפול");
      expect(told[0].href).toBe("/manage");
    }
    for (const person of [bar, chen, technical])
      expect(
        (await notices(person)).filter(
          (row) => row.title === "חייל מונה לאחראי תורנויות"
        )
      ).toEqual([]);

    // The draft cannot be published while the appointed soldier holds a seat in it.
    await expect(publish(inDraft.id)).rejects.toMatchObject({
      code: "assignment_changed",
    });
    // The flagged reservation reaches the managers' handling list.
    const view = await readState(manager);
    expect(
      (view.assignments as Record<string, unknown>[]).filter(
        (row) =>
          Array.isArray(row.needsAttention) &&
          row.needsAttention.includes("manager")
      )
    ).toHaveLength(2);
  });

  it("makes a waiting lottery proposal stale when its candidate is appointed meanwhile", async () => {
    // The only candidate in the band is near release, so the draw waits for approval.
    const [row] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, alon.soldierId!));
    await db
      .update(soldiers)
      .set({
        data: {
          ...row.data,
          service: {
            ...row.data.service,
            releaseDate: DateTime.now().plus({ days: 10 }).toISODate()!,
          },
        },
      })
      .where(eq(soldiers.id, alon.soldierId!));
    await db
      .update(balances)
      .set({ current: 0 })
      .where(eq(balances.soldierId, alon.soldierId!));
    const duty = await draft();
    const proposal = (await command(
      manager,
      "duty.lottery",
      { dutyId: duty.id, slotId: duty.data.slots[0].id },
      duty.version
    )) as unknown as {
      proposalId: string;
      version: number;
      status: string;
      candidateId: string;
      requirements: { key: string }[];
    };
    expect(proposal).toMatchObject({
      status: "approval_required",
      candidateId: alon.soldierId,
    });
    await setRole(alon, "manager");
    await expect(
      command(
        manager,
        "duty.lottery.approve",
        {
          proposalId: proposal.proposalId,
          decision: "approve",
          reason: "אישור אחרי מינוי",
          approvalKeys: proposal.requirements.map((item) => item.key),
        },
        proposal.version
      )
    ).rejects.toMatchObject({ code: "stale_proposal", status: 409 });
    expect(await seatsOf(duty.id)).toHaveLength(0);
    const shown = ((await readState(manager)) as Record<string, unknown>)
      .lotteryAttempts as {
      id: string;
      status: string;
    }[];
    expect(shown.find((row) => row.id === proposal.proposalId)?.status).toBe(
      "stale"
    );
  });

  it("sends no notice when the appointed soldier holds no reservation", async () => {
    await setRole(bar, "manager");
    for (const person of [manager, otherManager])
      expect(
        (await notices(person)).filter(
          (row) => row.title === "חייל מונה לאחראי תורנויות"
        )
      ).toEqual([]);
  });

  it("clears the marks when the role is removed and opens one decision about the balance", async () => {
    await published([alon]);
    const appointed = await setRole(alon, "manager");
    expect((await attention(alon))[0].marks).toEqual(["manager"]);
    await db
      .update(balances)
      .set({ current: 7 })
      .where(eq(balances.soldierId, alon.soldierId!));

    await setRole(appointed, "soldier");
    expect((await attention(alon))[0].marks).toEqual([]);
    const items = (await db.select().from(records)).filter(
      (row) => row.kind === "manager_return"
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ subjectId: alon.soldierId });
    expect(items[0].data).toMatchObject({
      status: "pending",
      soldierId: alon.soldierId,
      balanceAtReturn: 7,
    });
    // Only managers see the item; the balance did not change by itself.
    const view = await readState(manager);
    expect(view.managerReturns).toHaveLength(1);
    expect((await readState(bar)).managerReturns).toEqual([]);
    expect(await balanceOf(alon)).toBe(7);
    // From this moment the soldier is a candidate again, with the balance they have.
    const duty = await draft(1, 9);
    const slotId = duty.data.slots[0].id;
    const again = (await command(
      manager,
      "duty.assignment.preview",
      { dutyId: duty.id, slotId, soldierId: alon.soldierId },
      duty.version
    )) as unknown as { status: string };
    expect(again.status).toBe("eligible");
  });

  it("closes the decision once, by setting the balance with a preview", async () => {
    const appointed = await setRole(alon, "manager");
    await setRole(appointed, "soldier");
    const [item] = (await db.select().from(records)).filter(
      (row) => row.kind === "manager_return"
    );
    const input = {
      soldierIds: [alon.soldierId],
      operation: "set",
      value: 90,
      reason: "חזרה מתפקיד אחראי",
    };
    const preview = (await command(
      manager,
      "score.preview",
      input
    )) as unknown as {
      rows: { before: number; after: number }[];
      token: string;
    };
    expect(preview.rows).toEqual([
      expect.objectContaining({ before: 100, after: 90 }),
    ]);
    // A preview alone decides nothing.
    expect(
      (await db.select().from(records).where(eq(records.id, item.id)))[0].data
        .status
    ).toBe("pending");
    await command(manager, "score.apply", { ...input, token: preview.token });
    const [closed] = await db
      .select()
      .from(records)
      .where(eq(records.id, item.id));
    expect(closed.data).toMatchObject({
      status: "closed",
      outcome: "adjusted",
      balanceBefore: 100,
      balanceAfter: 90,
      closedBy: manager.id,
    });
    expect(await balanceOf(alon)).toBe(90);
    // Another balance operation does not reopen it, and it cannot be closed twice.
    const again = { ...input, value: 50 };
    const second = (await command(
      manager,
      "score.preview",
      again
    )) as unknown as { token: string };
    await command(manager, "score.apply", { ...again, token: second.token });
    expect(
      (await db.select().from(records).where(eq(records.id, item.id)))[0]
        .version
    ).toBe(closed.version);
    await expect(
      command(
        manager,
        "manager.return.keep",
        { id: item.id, reason: "כבר הוכרע" },
        closed.version
      )
    ).rejects.toMatchObject({ code: "already_decided", status: 409 });
    expect((await readState(manager)).managerReturns).toEqual([
      expect.objectContaining({ id: item.id, status: "closed" }),
    ]);
  });

  it("closes the decision once, by leaving the balance as it is, with a reason in the audit log", async () => {
    const appointed = await setRole(alon, "manager");
    await setRole(appointed, "soldier");
    const [item] = (await db.select().from(records)).filter(
      (row) => row.kind === "manager_return"
    );
    await expect(
      command(
        await actorOf(alon),
        "manager.return.keep",
        { id: item.id, reason: "חייל אינו מכריע" },
        item.version
      )
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(
      command(
        manager,
        "manager.return.keep",
        { id: item.id, reason: "ישן" },
        item.version + 5
      )
    ).rejects.toMatchObject({ code: "stale_version" });
    const kept = await command(
      manager,
      "manager.return.keep",
      { id: item.id, reason: "היתרה מתאימה" },
      item.version
    );
    const [closed] = await db
      .select()
      .from(records)
      .where(eq(records.id, item.id));
    expect(closed.data).toMatchObject({
      status: "closed",
      outcome: "kept",
      reason: "היתרה מתאימה",
    });
    expect(kept.version).toBe(closed.version);
    await expect(
      command(
        otherManager,
        "manager.return.keep",
        { id: item.id, reason: "שוב" },
        closed.version
      )
    ).rejects.toMatchObject({ code: "already_decided" });
    expect(await balanceOf(alon)).toBe(100);
    const entry = (await readState(manager)).audit.find(
      (row) => row.action === "manager.return.keep"
    );
    expect(entry).toMatchObject({
      label: "השארת היתרה של אחראי שחזר",
      reason: "היתרה מתאימה",
      soldierId: alon.soldierId,
    });
  });

  it("closes a pending decision when the soldier is appointed again", async () => {
    const appointed = await setRole(alon, "manager");
    const returned = await setRole(appointed, "soldier");
    await setRole(returned, "manager");
    const items = (await db.select().from(records)).filter(
      (row) => row.kind === "manager_return"
    );
    expect(items).toHaveLength(1);
    expect(items[0].data).toMatchObject({
      status: "closed",
      outcome: "reappointed",
    });
  });

  it("changes the role only for the technical account, and only from a current version", async () => {
    await expect(
      command(manager, "account.role", { id: alon.id, role: "manager" }, 1)
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(
      command(technical, "account.role", { id: alon.id, role: "manager" }, 9)
    ).rejects.toMatchObject({ code: "stale_version" });
    expect((await accountOf(alon)).role).toBe("soldier");
    // A repeated grant changes nothing more: no second notice, no item.
    await published([alon]);
    await setRole(alon, "manager");
    const again = await accountOf(alon);
    await command(
      technical,
      "account.role",
      { id: alon.id, role: "manager" },
      again.securityEpoch
    );
    expect(
      (await notices(manager)).filter(
        (row) => row.title === "חייל מונה לאחראי תורנויות"
      )
    ).toHaveLength(1);
  });
});

describe("what each account is sent", () => {
  it("leaves managers out of a soldier's lists and sends no sign of the role", async () => {
    const duty = await published([alon, chen]);
    chen = await setRole(chen, "manager");
    const view = await readState(alon);
    const ids = view.soldiers.map((row) => row.id);
    expect(ids).toContain(alon.soldierId);
    expect(ids).toContain(bar.soldierId);
    for (const person of [manager, otherManager, chen])
      expect(ids).not.toContain(person.soldierId);
    // Soldier summaries keep exactly the keys they had before, and the points
    // ahead on published duties (decision 220).
    for (const row of view.soldiers)
      expect(Object.keys(row).sort()).toEqual(
        [
          "currentScore",
          "futureScore",
          "deletedAt",
          "id",
          "name",
          "population",
          "rankName",
          "version",
        ].sort()
      );
    expect(JSON.stringify(view)).not.toContain("isManager");
    expect(JSON.stringify(view)).not.toContain("manager_return");
    // The duty still names the appointed soldier who holds a seat, from the names alone.
    expect(view.names).toEqual({
      [manager.soldierId!]: manager.name,
      [otherManager.soldierId!]: otherManager.name,
      [chen.soldierId!]: chen.name,
    });
    expect(
      view.assignments.some(
        (row) => row.dutyId === duty.id && row.soldierId === chen.soldierId
      )
    ).toBe(true);
  });

  it("marks managers for a manager, and gives the technical account no soldiers", async () => {
    const view = await readState(manager);
    const rows = view.soldiers as Record<string, unknown>[];
    const marked = rows.filter((row) => row.isManager === true);
    expect(marked.map((row) => row.id).sort()).toEqual(
      [manager.soldierId, otherManager.soldierId].sort()
    );
    expect(
      rows
        .filter((row) => row.isManager !== true)
        .map((row) => row.id)
        .sort()
    ).toEqual([alon, bar, chen].map((row) => row.soldierId).sort());
    expect(view.names).toEqual({});
    const technicalView = await readState(technical);
    expect(technicalView.soldiers).toEqual([]);
    expect(technicalView.names).toEqual({});
  });
});

describe("granting the role and assigning at the same time", () => {
  it("never leaves an unmarked reservation of a manager, whichever comes first", async () => {
    for (let round = 0; round < 6; round++) {
      const duty = await draft(1, 3 + round, 8, `מרוץ ${round}`);
      const person = await invite(`חייל ${round}`, "soldier", 100);
      const outcomes = await Promise.allSettled([
        command(
          technical,
          "account.role",
          { id: person.id, role: "manager" },
          1
        ),
        assign(duty, person),
      ]);
      expect(outcomes[0].status).toBe("fulfilled");
      const seats = await seatsOf(duty.id);
      expect((await accountOf(person)).role).toBe("manager");
      if (outcomes[1].status === "fulfilled") {
        // The assignment came first: it was kept, and the appointment marked it.
        expect(seats).toHaveLength(1);
        expect(seats[0].data.needsAttention).toEqual(["manager"]);
      } else {
        // The appointment came first: the assignment was refused with the reason.
        expect(seats).toHaveLength(0);
        expect(outcomes[1].reason).toMatchObject({
          message: MANAGER_BLOCKER_MESSAGE,
        });
      }
    }
  });

  it("holds with two managers assigning one soldier to different duties meanwhile", async () => {
    const first = await draft(1, 3, 8, "ראשונה");
    const second = await draft(1, 6, 8, "שנייה");
    const outcomes = await Promise.allSettled([
      assign(first, alon),
      command(technical, "account.role", { id: alon.id, role: "manager" }, 1),
      command(
        otherManager,
        "duty.assign",
        {
          dutyId: second.id,
          slotId: second.data.slots[0].id,
          soldierId: alon.soldierId,
        },
        second.version
      ),
    ]);
    expect(outcomes[1].status).toBe("fulfilled");
    const seats = await db
      .select()
      .from(assignments)
      .where(
        and(
          eq(assignments.soldierId, alon.soldierId!),
          eq(assignments.status, "reserved")
        )
      );
    // Every reservation that exists is marked; none was added after the appointment.
    for (const seat of seats)
      expect(seat.data.needsAttention).toEqual(["manager"]);
    expect(seats.length).toBe(
      outcomes.filter((row, index) => index !== 1 && row.status === "fulfilled")
        .length
    );
  });
});
