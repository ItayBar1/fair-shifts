import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool } from "../../src/server/db";
import { user } from "../../src/server/auth-schema";
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
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

let manager: Actor;
let second: Actor;
let serial = 10;

async function invite(
  name: string,
  role: "soldier" | "manager",
  balance = 100,
  service: Record<string, unknown> = {}
): Promise<Actor> {
  const id = randomUUID();
  const personalNumber = String(serial++).padStart(5, "0");
  const base = soldier({ id, name, personalNumber });
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber,
    data: { ...base, service: { ...base.service, ...service } },
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: `${personalNumber}@example.invalid` });
  await db.insert(balances).values({ soldierId: id, current: balance });
  const row = await createInvitedAccount({
    name,
    role,
    email: `${personalNumber}@example.invalid`,
    soldierId: id,
  });
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
  })) as Record<string, unknown> & { id: string; version: number };
}
/** Israel-time instants `days` ahead at `hour`, lasting `hours`. */
function at(days: number, hour = 8, hours = 8) {
  const start = DateTime.now()
    .setZone("Asia/Jerusalem")
    .startOf("day")
    .plus({ days, hours: hour });
  return { start: start.toISO()!, end: start.plus({ hours }).toISO()! };
}
async function dutyType(
  base: number,
  roles: { name: string; count: number; requirements?: unknown }[] = [
    { name: "תורן", count: 1 },
  ],
  extra: Record<string, unknown> = {}
) {
  return command("dutyType.save", {
    name: `סוג בשווי ${base}`,
    pricing: { mode: "fixed", base },
    roles,
    ...extra,
  });
}
async function instance(
  typeId: string,
  when: { start: string; end: string },
  name = "מופע לתכנון"
) {
  const created = await command("duty.create", { typeId, name, ...when });
  const [row] = await db.select().from(duties).where(eq(duties.id, created.id));
  return row;
}
async function inactive(person: Actor, from: string, to: string) {
  const payload = {
    soldierId: person.soldierId,
    kind: "inactive",
    startDate: from,
    endDate: to,
    reason: "אי־פעילות סינתטית",
  };
  const [row] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, person.soldierId!));
  const preview = await command(
    "soldier.timeline.preview",
    payload,
    row.version
  );
  await command(
    "soldier.timeline",
    { ...payload, confirmed: true, previewToken: preview.previewToken },
    row.version
  );
}
async function attempts() {
  return (
    await db.select().from(records).where(eq(records.kind, "lottery_attempt"))
  ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
async function run(id: string) {
  const [row] = await db.select().from(records).where(eq(records.id, id));
  return row;
}
async function stepUntilDone(id: string, actor = manager) {
  for (let i = 0; i < 20; i++) {
    const current = await run(id);
    if (current.data.status !== "running") return current;
    await command("planning.step", { id }, current.version, actor);
  }
  throw new Error("planning did not settle");
}
function day(value: string) {
  return DateTime.fromISO(value).setZone("Asia/Jerusalem").toISODate()!;
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  serial = 10;
  manager = await invite("אחראי ראשון", "manager");
  second = await invite("אחראי שני", "manager");
});
afterAll(async () => pool.end());

describe("lottery band and scheduling score", () => {
  it("filters blocked candidates before the minimum and keeps the exact strict band", async () => {
    const people = await Promise.all(
      [10, 10, 11, 14, 15].map((score, index) =>
        invite(`מועמד ${index}`, "soldier", score)
      )
    );
    const idle = await invite("לא זמין בניקוד אפס", "soldier", 0);
    const type = await dutyType(4);
    const when = at(10);
    const duty = await instance(type.id, when);
    await inactive(idle, day(when.start), day(when.end));
    await command(
      "duty.lottery",
      { dutyId: duty.id, slotId: duty.data.slots[0].id },
      duty.version
    );
    const [attempt] = await attempts();
    expect(attempt.data.minimum).toBe(10);
    expect(new Set(attempt.data.band as string[])).toEqual(
      new Set(people.slice(0, 3).map((row) => row.soldierId))
    );
    const blocked = (
      attempt.data.candidates as { id: string; status: string }[]
    ).find((row) => row.id === idle.soldierId);
    expect(blocked?.status).toBe("blocked");
  });
  it("draws nobody for a zero value seat and reports it as missing in a period plan", async () => {
    await invite("מועמד יחיד", "soldier", 0);
    const type = await dutyType(0);
    const when = at(10);
    const duty = await instance(type.id, when);
    const draw = await command(
      "duty.lottery",
      { dutyId: duty.id, slotId: duty.data.slots[0].id },
      duty.version
    );
    expect(draw.status).toBe("manual_only");
    const plan = await command("planning.run", {
      start: day(when.start),
      end: day(when.start),
    });
    const done = await stepUntilDone(plan.id);
    expect(done.data.status).toBe("completed");
    expect(done.data.missing).toEqual([
      { dutyId: duty.id, slotId: duty.data.slots[0].id },
    ]);
    expect(await db.select().from(assignments)).toHaveLength(0);
  });
  it("counts draft and in-execution reservations of both managers in the scheduling score", async () => {
    const drafted = await invite("עם טיוטה", "soldier", 10);
    const running = await invite("בביצוע", "soldier", 10);
    await invite("בלי שיבוץ", "soldier", 13);
    const eight = await dutyType(8);
    const other = await instance(eight.id, at(3), "טיוטה של האחראי השני");
    await command(
      "duty.assign",
      {
        dutyId: other.id,
        slotId: other.data.slots[0].id,
        soldierId: drafted.soldierId,
      },
      other.version,
      second
    );
    const executing = await instance(eight.id, at(4), "תורנות בביצוע");
    await command(
      "duty.assign",
      {
        dutyId: executing.id,
        slotId: executing.data.slots[0].id,
        soldierId: running.soldierId,
      },
      executing.version
    );
    await command(
      "duty.publish",
      { id: executing.id, confirmed: true },
      executing.version + 1
    );
    // The duty has started and is not credited yet.
    const [live] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, executing.id));
    const started = DateTime.now().minus({ hours: 1 });
    await db
      .update(duties)
      .set({
        data: {
          ...live.data,
          start: started.toISO()!,
          end: started.plus({ days: 2 }).toISO()!,
        },
      })
      .where(eq(duties.id, executing.id));
    const four = await dutyType(4);
    const target = await instance(four.id, at(20));
    await command(
      "duty.lottery",
      { dutyId: target.id, slotId: target.data.slots[0].id },
      target.version
    );
    const attempt = (await attempts()).at(-1)!;
    const scores = Object.fromEntries(
      (attempt.data.candidates as { id: string; score: number }[]).map(
        (row) => [row.id, row.score]
      )
    );
    expect(scores[drafted.soldierId!]).toBe(18);
    expect(scores[running.soldierId!]).toBe(18);
    expect(attempt.data.minimum).toBe(13);
  });
});

describe("period planning", () => {
  it("recomputes candidates and the minimum after every seat of one instance", async () => {
    const people = await Promise.all(
      [10, 10, 13, 14].map((score, index) =>
        invite(`מועמד ${index}`, "soldier", score)
      )
    );
    const type = await dutyType(4, [{ name: "תורן", count: 3 }]);
    const when = at(10);
    const duty = await instance(type.id, when);
    const plan = await command("planning.run", {
      start: day(when.start),
      end: day(when.start),
    });
    const done = await stepUntilDone(plan.id);
    expect(done.data.missing).toEqual([]);
    const seats = await db
      .select()
      .from(assignments)
      .where(eq(assignments.dutyId, duty.id));
    expect(seats).toHaveLength(3);
    expect(new Set(seats.map((row) => row.soldierId)).size).toBe(3);
    const draws = await attempts();
    expect(draws).toHaveLength(3);
    const base: Record<string, number> = Object.fromEntries(
      people.map((row, index) => [row.soldierId, [10, 10, 13, 14][index]])
    );
    const chosen: string[] = [];
    for (const draw of draws) {
      const candidates = draw.data.candidates as {
        id: string;
        score: number;
        status: string;
      }[];
      // Everyone already chosen is out; the rest are scored from the saved state.
      for (const id of chosen)
        expect(candidates.find((row) => row.id === id)?.status).toBe("blocked");
      const open = candidates.filter(
        (row) => row.status !== "blocked" && row.id in base
      );
      expect(open.map((row) => row.score)).toEqual(
        open.map((row) => base[row.id])
      );
      expect(draw.data.minimum).toBe(Math.min(...open.map((row) => row.score)));
      expect(draw.data.band).toEqual(
        open
          .filter((row) => row.score < (draw.data.minimum as number) + 4)
          .map((row) => row.id)
          .sort()
      );
      chosen.push(draw.data.candidateId as string);
    }
  });
  it("orders equally scarce duties by nearer start and then a fixed id", async () => {
    await invite("מועמד", "soldier", 0);
    const type = await dutyType(4);
    const later = await instance(type.id, at(12), "מאוחר שנוצר ראשון");
    const earlier = await instance(type.id, at(11), "מוקדם שנוצר שני");
    const twinA = await instance(type.id, at(13, 8, 2), "תאום");
    const twinB = await instance(type.id, at(13, 8, 2), "תאום");
    const plan = await command("planning.run", {
      start: day(earlier.data.start),
      end: day(twinA.data.start),
    });
    await stepUntilDone(plan.id);
    const order = (await attempts()).map((row) => row.data.dutyId);
    expect(order.slice(0, 2)).toEqual([earlier.id, later.id]);
    expect(order.slice(2)).toEqual([twinA.id, twinB.id].sort());
  });
  it("lets two managers plan overlapping duties at once without booking one soldier twice", async () => {
    const only = await invite("המתאים היחיד", "soldier", 0);
    const type = await dutyType(4);
    const when = at(10);
    const first = await instance(type.id, when, "של האחראי הראשון");
    const other = await instance(type.id, when, "של האחראי השני");
    // Both managers are soldiers with a high score; keep them out of the band.
    const runs = await Promise.all([
      command("planning.run", {
        start: day(when.start),
        end: day(when.start),
        dutyIds: [first.id],
      }),
      command(
        "planning.run",
        { start: day(when.start), end: day(when.start), dutyIds: [other.id] },
        undefined,
        second
      ),
    ]);
    await Promise.allSettled([
      stepUntilDone(runs[0].id),
      stepUntilDone(runs[1].id, second),
    ]);
    const seats = await db.select().from(assignments);
    expect(
      seats.filter((row) => row.soldierId === only.soldierId)
    ).toHaveLength(1);
    // The lost seat went to the next band or stayed missing; never a double booking.
    for (const person of new Set(seats.map((row) => row.soldierId)))
      expect(seats.filter((row) => row.soldierId === person)).toHaveLength(1);
  });
  it("accepts only one of two managers stepping the same run from the same version", async () => {
    await Promise.all(
      [0, 0, 0].map((score, index) =>
        invite(`מועמד ${index}`, "soldier", score)
      )
    );
    const type = await dutyType(4, [{ name: "תורן", count: 2 }]);
    const when = at(10);
    await instance(type.id, when);
    const plan = await command("planning.run", {
      start: day(when.start),
      end: day(when.start),
    });
    const outcomes = await Promise.allSettled([
      command("planning.step", { id: plan.id }, plan.version),
      command("planning.step", { id: plan.id }, plan.version, second),
    ]);
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(
      1
    );
    expect(await db.select().from(assignments)).toHaveLength(1);
  });
});

describe("approvals while data changes", () => {
  async function nearRelease() {
    const when = at(10);
    const release = DateTime.fromISO(when.start)
      .setZone("Asia/Jerusalem")
      .plus({ days: 10 })
      .toISODate()!;
    const leaving = await invite("לפני שחרור", "soldier", 0, {
      releaseDate: release,
    });
    const next = await invite("הבא בתור", "soldier", 50);
    const type = await dutyType(4);
    const duty = await instance(type.id, when);
    const plan = await command("planning.run", {
      start: day(when.start),
      end: day(when.start),
    });
    await command("planning.step", { id: plan.id }, plan.version);
    const waiting = await run(plan.id);
    expect(waiting.data.status).toBe("awaiting_approval");
    const [proposal] = await attempts();
    expect(proposal.data.candidateId).toBe(leaving.soldierId);
    return { duty, plan, waiting, proposal, leaving, next, type, when };
  }
  function approve(proposal: Awaited<ReturnType<typeof attempts>>[number]) {
    return command(
      "duty.lottery.approve",
      {
        proposalId: proposal.id,
        decision: "approve",
        reason: "אישור נקודתי",
        approvalKeys: (proposal.data.requirements as { key: string }[]).map(
          (row) => row.key
        ),
      },
      proposal.version
    );
  }
  it("keeps a waiting proposal valid while the other manager changes what the draw does not use", async () => {
    const { plan, proposal, leaving } = await nearRelease();
    // Unrelated work of the other manager: a new catalog type and a new draft.
    const other = await command(
      "dutyType.save",
      {
        name: "סוג אחר",
        pricing: { mode: "fixed", base: 2 },
        roles: [{ name: "תורן", count: 1 }],
      },
      undefined,
      second
    );
    await command(
      "duty.create",
      { typeId: other.id, name: "עבודה אחרת", ...at(30) },
      undefined,
      second
    );
    const waiting = await run(plan.id);
    await command("planning.step", { id: plan.id }, waiting.version);
    expect((await run(plan.id)).data.status).toBe("awaiting_approval");
    await approve(proposal);
    const approved = await run(plan.id);
    await command("planning.step", { id: plan.id }, approved.version);
    const done = await stepUntilDone(plan.id);
    expect(done.data.status).toBe("completed");
    expect(done.data.results).toEqual([
      expect.objectContaining({ status: "assigned" }),
    ]);
    const seats = await db.select().from(assignments);
    expect(seats.map((row) => row.soldierId)).toEqual([leaving.soldierId]);
  });
  it("makes a waiting proposal stale when the band changes", async () => {
    const { plan, proposal, next } = await nearRelease();
    await db
      .update(balances)
      .set({ current: 2 })
      .where(eq(balances.soldierId, next.soldierId!));
    await expect(approve(proposal)).rejects.toThrow("הנתונים השתנו");
    const waiting = await run(plan.id);
    await command("planning.step", { id: plan.id }, waiting.version);
    const draws = await attempts();
    expect(draws[0].data.status).toBe("stale");
    expect(new Set(draws[1].data.band as string[]).has(next.soldierId!)).toBe(
      true
    );
  });
  it("never assigns a proposal into a duty that was published meanwhile", async () => {
    const { duty, proposal } = await nearRelease();
    await command(
      "duty.publish",
      { id: duty.id, confirmed: true },
      duty.version,
      second
    );
    await expect(approve(proposal)).rejects.toThrow("הנתונים השתנו");
    expect(await db.select().from(assignments)).toHaveLength(0);
  });
  it("stops a confirmed run at a newly pending constraint until a manager confirms again", async () => {
    const early = await invite("הגיש מוקדם", "soldier", 0);
    const late = await invite("הגיש מאוחר", "soldier", 0);
    const type = await dutyType(4);
    const when = at(10);
    await instance(type.id, when, "ראשון");
    await instance(type.id, at(12), "שני");
    const round = await command("round.create", {
      name: "סבב מקביל לתכנון",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 3600_000).toISOString(),
      targetStart: day(when.start),
      targetEnd: day(at(40).start),
    });
    const submit = (person: Actor, date: string) =>
      command(
        "constraint.submit",
        { roundId: round.id, startDate: date, endDate: date, reason: "סיבה" },
        undefined,
        person
      );
    await submit(early, day(at(35).start));
    const plan = await command("planning.run", {
      start: day(when.start),
      end: day(at(12).start),
      reviewPending: true,
    });
    await command("planning.step", { id: plan.id }, plan.version);
    await submit(late, day(at(36).start));
    const halted = await run(plan.id);
    await expect(
      command("planning.step", { id: plan.id }, halted.version, second)
    ).rejects.toThrow("אילוצים ממתינים חדשים");
    await command(
      "planning.step",
      { id: plan.id, reviewPending: true },
      halted.version,
      second
    );
    const resumed = await run(plan.id);
    expect(resumed.data.reviewConfirmedBy).toBe(second.id);
    expect(resumed.data.reviewCovers).toHaveLength(2);
    expect(await db.select().from(assignments)).toHaveLength(2);
  });
  it("rejects an approval after another manager filled the seat and settles the run truthfully", async () => {
    const { duty, plan, proposal, next } = await nearRelease();
    await command(
      "duty.assign",
      {
        dutyId: duty.id,
        slotId: duty.data.slots[0].id,
        soldierId: next.soldierId,
      },
      duty.version,
      second
    );
    await expect(
      command(
        "duty.lottery.approve",
        {
          proposalId: proposal.id,
          decision: "approve",
          reason: "אישור מאוחר",
          approvalKeys: (proposal.data.requirements as { key: string }[]).map(
            (row) => row.key
          ),
        },
        proposal.version
      )
    ).rejects.toThrow("הנתונים השתנו");
    const waiting = await run(plan.id);
    await command("planning.step", { id: plan.id }, waiting.version);
    const done = await run(plan.id);
    expect(done.data.status).toBe("completed");
    expect(done.data.missing).toEqual([]);
    const seats = await db.select().from(assignments);
    expect(seats.map((row) => row.soldierId)).toEqual([next.soldierId]);
    expect(done.data.results).toEqual([
      expect.objectContaining({
        slotId: duty.data.slots[0].id,
        status: "filled",
      }),
    ]);
  });
  it("excludes a rejected near-release candidate only from that duty", async () => {
    const { plan, proposal, leaving, type, when } = await nearRelease();
    const sibling = await instance(type.id, at(11), "מופע נוסף באותה ריצה");
    expect(day(sibling.data.start) > day(when.start)).toBe(true);
    await command(
      "duty.lottery.approve",
      { proposalId: proposal.id, decision: "reject", reason: "שיקול דעת" },
      proposal.version
    );
    const replacement = (await attempts()).at(-1)!;
    expect(replacement.data.excludedIds).toEqual([leaving.soldierId]);
    expect(replacement.data.status).toBe("assigned");
    const other = await command(
      "duty.lottery",
      { dutyId: sibling.id, slotId: sibling.data.slots[0].id },
      sibling.version
    );
    const candidates = (await attempts()).at(-1)!.data.candidates as {
      id: string;
      status: string;
    }[];
    expect(other.status).not.toBe("unfilled");
    expect(
      candidates.find((row) => row.id === leaving.soldierId)?.status
    ).not.toBe("blocked");
    void plan;
  });
  it("keeps the review confirmation separate from each collision in a period plan", async () => {
    const person = await invite("עם אילוץ ממתין", "soldier", 0);
    const type = await dutyType(4);
    const when = at(10);
    const duty = await instance(type.id, when);
    const round = await command("round.create", {
      name: "סבב לתכנון",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 3600_000).toISOString(),
      targetStart: day(when.start),
      targetEnd: day(when.end),
    });
    await command(
      "constraint.submit",
      {
        roundId: round.id,
        startDate: day(when.start),
        endDate: day(when.end),
        reason: "אילוץ שממתין",
      },
      undefined,
      person
    );
    const plan = await command("planning.run", {
      start: day(when.start),
      end: day(when.start),
    });
    await expect(
      command("planning.step", { id: plan.id }, plan.version)
    ).rejects.toThrow("סקירת האילוצים");
    await command(
      "planning.step",
      { id: plan.id, reviewPending: true },
      plan.version
    );
    const [proposal] = await attempts();
    expect(proposal.data.status).toBe("approval_required");
    expect(proposal.data.candidateId).toBe(person.soldierId);
    await expect(
      command(
        "duty.lottery.approve",
        { proposalId: proposal.id, decision: "approve", reason: "ללא פרטני" },
        proposal.version
      )
    ).rejects.toThrow("אישור מפורש");
    expect(await db.select().from(assignments)).toHaveLength(0);
    void duty;
  });
  it("never changes a published duty or shows the draw explanation to soldiers", async () => {
    const person = await invite("חייל", "soldier", 0);
    await invite("שני", "soldier", 0);
    const type = await dutyType(4, [{ name: "תורן", count: 2 }]);
    const when = at(10);
    const duty = await instance(type.id, when);
    await command(
      "duty.assign",
      {
        dutyId: duty.id,
        slotId: duty.data.slots[0].id,
        soldierId: person.soldierId,
      },
      duty.version
    );
    await command("duty.publish", { id: duty.id, confirmed: true }, 2);
    await expect(
      command(
        "duty.lottery",
        { dutyId: duty.id, slotId: duty.data.slots[1].id },
        3
      )
    ).rejects.toThrow("טיוטה");
    // A zero value draft in the same period is left missing and reported.
    const zero = await instance((await dutyType(0)).id, when, "שווי אפס");
    const plan = await command("planning.run", {
      start: day(when.start),
      end: day(when.start),
    });
    const done = await stepUntilDone(plan.id);
    expect(done.data.dutyIds).toEqual([zero.id]);
    expect(await db.select().from(assignments)).toHaveLength(1);
    const visible = await readState(person);
    expect(JSON.stringify(visible)).not.toMatch(/lottery_attempt|planning_run/);
    const notices = (
      await db.select().from(records).where(eq(records.kind, "notification"))
    ).filter((row) => row.data.runId);
    expect(notices.length).toBeGreaterThan(0);
    const managers = new Set(
      (await db.select().from(user).where(eq(user.role, "manager"))).map(
        (row) => row.id
      )
    );
    for (const row of notices)
      expect(managers.has(row.data.accountId as string)).toBe(true);
  });
});
