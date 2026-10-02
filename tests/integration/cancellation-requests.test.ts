import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { emailOutbox } from "../../src/server/auth-schema";
import {
  assignmentMailEvent,
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

const DAY = 86_400_000;
let manager: Actor;
let secondManager: Actor;
let member: Actor;
let other: Actor;

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
  idempotencyKey = randomUUID()
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
async function requestRow(id: string) {
  const [row] = await db.select().from(records).where(eq(records.id, id));
  return row;
}
async function reserved(dutyId: string) {
  return (
    await db.select().from(assignments).where(eq(assignments.dutyId, dutyId))
  ).filter((row) => row.status === "reserved");
}
async function auditOf(action: string) {
  return (
    await db.select().from(records).where(eq(records.kind, "audit"))
  ).filter((row) => row.data.action === action);
}
async function requestEmails(requestId: string) {
  return db
    .select()
    .from(emailOutbox)
    .where(like(emailOutbox.eventKey, `cancellation:${requestId}:%`));
}
/** A published duty in two days with `seats` places, filled by the given soldiers in order. */
async function publishedDuty(people: Actor[], seats = people.length) {
  const type = await command(manager, "dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: seats }],
  });
  const duty = await command(manager, "duty.create", {
    typeId: type.id,
    name: "תורנות לבדיקה",
    start: new Date(Date.now() + 2 * DAY).toISOString(),
    end: new Date(Date.now() + 3 * DAY).toISOString(),
  });
  let version = 1;
  const created = await dutyRow(duty.id);
  for (const [index, person] of people.entries()) {
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
  return dutyRow(duty.id);
}
async function seatOf(dutyId: string, person: Actor) {
  const seat = (await reserved(dutyId)).find(
    (row) => row.soldierId === person.soldierId
  );
  if (!seat) throw new Error("seat not found");
  return seat;
}
async function submit(
  dutyId: string,
  person = member,
  kind: "cancel" | "postpone" = "cancel"
) {
  const seat = await seatOf(dutyId, person);
  return command(
    person,
    "cancellation.submit",
    { assignmentId: seat.id, kind, reason: "פטור שלדעתי חל עליי" },
    seat.version
  );
}
async function preview(changeId: string) {
  const change = await requestRow(changeId);
  return (await command(
    manager,
    "duty.change.preview",
    { id: changeId },
    change.version
  )) as unknown as {
    previewToken: string;
    checks: { soldierId: string; status: string }[];
    affected: { soldierId: string; before: unknown[]; after: unknown[] }[];
    request?: { id: string; status: string };
  };
}
async function publish(changeId: string) {
  const checked = await preview(changeId);
  const change = await requestRow(changeId);
  return command(
    manager,
    "duty.change.publish",
    { id: changeId, confirmed: true, previewToken: checked.previewToken },
    change.version
  );
}
const aboutRequest = (requestId: string) => (row: object) =>
  (row as Record<string, unknown>).requestId === requestId;
async function startNow(dutyId: string) {
  const row = await dutyRow(dutyId);
  await db
    .update(duties)
    .set({
      data: {
        ...row.data,
        start: new Date(Date.now() - 60_000).toISOString(),
      },
    })
    .where(eq(duties.id, dutyId));
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("אחראי לבדיקה", "manager", "00002");
  secondManager = await invite("אחראי נוסף", "manager", "00003");
  member = await invite("חייל מבקש", "soldier", "00001");
  other = await invite("חייל נוסף", "soldier", "00004");
});
afterAll(async () => pool.end());

describe("cancellation and postponement requests", () => {
  it("submitting changes neither the seat, the calendar nor reserved points, and is visible only to its owner and managers", async () => {
    const duty = await publishedDuty([member, other]);
    const seat = await seatOf(duty.id, member);
    await expect(
      command(
        other,
        "cancellation.submit",
        { assignmentId: seat.id, kind: "cancel", reason: "לא שלי" },
        seat.version
      )
    ).rejects.toThrow("רק לשיבוץ שלך");
    await expect(
      command(
        manager,
        "cancellation.submit",
        { assignmentId: seat.id, kind: "cancel", reason: "אחראי" },
        seat.version
      )
    ).rejects.toThrow("רק לשיבוץ שלך");
    const request = await submit(duty.id, member, "postpone");
    await expect(submit(duty.id)).rejects.toThrow("כבר קיימת בקשה פתוחה");

    // Nothing moved: the same seat, version, duty version and balances.
    const after = await seatOf(duty.id, member);
    expect(after).toMatchObject({ id: seat.id, version: seat.version });
    expect((await dutyRow(duty.id)).version).toBe(duty.version);
    expect(
      (await db.select().from(balances)).every((row) => row.current === 0)
    ).toBe(true);
    expect((await reserved(duty.id)).map((row) => row.points)).toEqual([4, 4]);

    const mine = (await readState(member)).requests;
    expect(mine).toEqual([
      expect.objectContaining({
        id: request.id,
        type: "cancellation",
        kind: "postpone",
        status: "pending",
      }),
    ]);
    expect((await readState(other)).requests).toHaveLength(0);
    for (const person of [manager, secondManager]) {
      const state = await readState(person);
      expect(state.requests.map((row) => row.id)).toContain(request.id);
      expect(state.notifications.filter(aboutRequest(request.id))).toHaveLength(
        1
      );
    }
    // Managers get a site notice only; the requester receives no copy.
    expect(
      (await readState(member)).notifications.filter(aboutRequest(request.id))
    ).toHaveLength(0);
    expect(await requestEmails(request.id)).toHaveLength(0);
    expect(await auditOf("cancellation.submit")).toHaveLength(1);

    // The owner may withdraw a pending request; nobody else can.
    const row = await requestRow(request.id);
    await expect(
      command(other, "cancellation.withdraw", { id: request.id }, row.version)
    ).rejects.toThrow("רק מי שהגיש");
    await command(
      member,
      "cancellation.withdraw",
      { id: request.id },
      row.version
    );
    expect((await requestRow(request.id)).data.status).toBe("cancelled");
    expect((await seatOf(duty.id, member)).id).toBe(seat.id);
    // A new request is possible after withdrawal.
    await submit(duty.id);
  });

  it("is decided once when two managers race, keeps the seat on rejection and hides the decider from the soldier", async () => {
    const duty = await publishedDuty([member]);
    const seat = await seatOf(duty.id, member);
    const request = await submit(duty.id);
    await expect(
      command(member, "cancellation.reject", { id: request.id, reason: "x" }, 1)
    ).rejects.toThrow("לאחראי תורנויות בלבד");
    const outcomes = await Promise.allSettled([
      command(
        manager,
        "cancellation.reject",
        { id: request.id, reason: "הפטור לא הוזן במערכת" },
        1
      ),
      command(
        secondManager,
        "cancellation.reject",
        { id: request.id, reason: "סיבה אחרת" },
        1
      ),
    ]);
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(
      1
    );
    const failed = outcomes.find((row) => row.status === "rejected");
    expect(String((failed as PromiseRejectedResult).reason)).toMatch(
      /הוכרעה בידי|המידע השתנה/
    );
    const decided = await requestRow(request.id);
    expect(decided.version).toBe(2);
    expect(decided.data).toMatchObject({
      status: "rejected",
      decision: { outcome: "rejected" },
    });
    // A later attempt through another route names who decided.
    await expect(
      command(
        secondManager,
        "cancellation.prepare",
        { id: request.id, outcome: "remove", reason: "מאוחר" },
        2
      )
    ).rejects.toThrow("כבר הוכרעה בידי");
    await expect(
      command(
        secondManager,
        "duty.cancel",
        {
          id: duty.id,
          reason: "מאוחר",
          confirmed: true,
          requestId: request.id,
        },
        duty.version
      )
    ).rejects.toThrow("כבר הוכרעה בידי");
    expect((await dutyRow(duty.id)).data.status).toBe("published");
    expect((await seatOf(duty.id, member)).id).toBe(seat.id);
    expect(await auditOf("cancellation.rejected")).toHaveLength(1);

    // Both managers see the one decision with its decider; the soldier sees the reason only.
    const decision = decided.data.decision as Record<string, string>;
    const decider = decision.deciderName;
    for (const person of [manager, secondManager]) {
      const view = (await readState(person)).requests.find(
        (row) => row.id === request.id
      )!;
      expect(view).toMatchObject({
        version: 2,
        decision: { deciderName: decider },
      });
    }
    const soldierView = (await readState(member)).requests[0];
    expect(soldierView).toMatchObject({
      status: "rejected",
      decision: { reason: decision.reason },
    });
    expect(JSON.stringify(soldierView)).not.toContain(decider);
    const emails = await requestEmails(request.id);
    expect(emails).toHaveLength(1);
    expect(emails[0].kind).toBe("transfer");
    // The mail omits the free-text reason; the site notice keeps it (decision 177).
    expect(emails[0].body).not.toContain(decision.reason);
    expect(emails[0].body).toContain("הסיבה מופיעה באתר");
    const notices = (await readState(member)).notifications.filter(
      aboutRequest(request.id)
    );
    expect(notices).toHaveLength(1);
    expect(String((notices[0] as Record<string, unknown>).body)).toContain(
      decision.reason
    );
  });

  it("completes a removal only through update and publish, frees the seat and its reserved points", async () => {
    const duty = await publishedDuty([member, other]);
    const request = await submit(duty.id);
    const prepared = await command(
      manager,
      "cancellation.prepare",
      { id: request.id, outcome: "remove", reason: "פטור אושר מחוץ למערכת" },
      1
    );
    await expect(
      command(
        secondManager,
        "cancellation.prepare",
        { id: request.id, outcome: "remove", reason: "כפול" },
        1
      )
    ).rejects.toThrow("כבר קיימת הצעת שינוי פתוחה");
    const change = await requestRow(prepared.id);
    expect(change.data).toMatchObject({
      requestId: request.id,
      requestOutcome: "remove",
    });
    expect(
      (change.data.seats as { soldierId: string | null }[]).map(
        (seat) => seat.soldierId
      )
    ).toEqual([null, other.soldierId]);
    // Preparing is only a proposal: the request is pending and the seat stays until publishing.
    expect((await requestRow(request.id)).data.status).toBe("pending");
    expect((await reserved(duty.id)).map((row) => row.soldierId)).toContain(
      member.soldierId
    );
    const checked = await preview(prepared.id);
    expect(checked.request).toMatchObject({
      id: request.id,
      status: "pending",
    });
    expect(
      checked.affected.find((row) => row.soldierId === member.soldierId)
    ).toMatchObject({ after: [] });

    await publish(prepared.id);
    const done = await requestRow(request.id);
    expect(done.data).toMatchObject({
      status: "completed",
      decision: { outcome: "removed", changeId: prepared.id },
    });
    expect((await reserved(duty.id)).map((row) => row.soldierId)).toEqual([
      other.soldierId,
    ]);
    // The duty email already reports the change; the request adds a site notice, no second mail.
    expect(await requestEmails(request.id)).toHaveLength(0);
    const notices = (await readState(member)).notifications;
    expect(notices.some(aboutRequest(request.id))).toBe(true);
    // The change is announced through the member's window (decision 197).
    expect(
      (await db.select().from(assignmentMailEvent)).filter(
        (row) => row.change === "cancelled"
      )
    ).toHaveLength(1);
    expect(await auditOf("cancellation.completed")).toHaveLength(1);
  });

  it("keeps the request pending when the prepared change is discarded or leaves the requester in place", async () => {
    const duty = await publishedDuty([member]);
    const request = await submit(duty.id, member, "postpone");
    const first = await command(
      manager,
      "cancellation.prepare",
      { id: request.id, outcome: "remove", reason: "טיוטת טיפול" },
      1
    );
    const change = await requestRow(first.id);
    await command(
      manager,
      "duty.change.discard",
      { id: first.id },
      change.version
    );
    expect((await requestRow(request.id)).data.status).toBe("pending");

    // A linked change that neither removes nor moves the duty does not decide the request.
    const second = await command(
      manager,
      "cancellation.prepare",
      { id: request.id, outcome: "reschedule", reason: "שינוי הנחיות בלבד" },
      1
    );
    const live = await dutyRow(duty.id);
    const saved = await requestRow(second.id);
    await command(
      manager,
      "duty.change.save",
      {
        id: second.id,
        name: live.data.name,
        start: live.data.start,
        end: live.data.end,
        location: "",
        instructions: "הנחיות חדשות",
        reason: "שינוי הנחיות בלבד",
        seats: saved.data.seats,
      },
      saved.version
    );
    await publish(second.id);
    expect((await requestRow(request.id)).data.status).toBe("pending");
    expect((await reserved(duty.id)).map((row) => row.soldierId)).toEqual([
      member.soldierId,
    ]);
  });

  it("postpones to a new date only after the eligibility check passes on that date", async () => {
    const duty = await publishedDuty([member]);
    const request = await submit(duty.id, member, "postpone");
    const prepared = await command(
      manager,
      "cancellation.prepare",
      { id: request.id, outcome: "reschedule", reason: "דחייה לשבוע הבא" },
      1
    );
    const start = new Date(Date.now() + 8 * DAY).toISOString();
    const end = new Date(Date.now() + 9 * DAY).toISOString();
    // The requester is already busy on the new date: the move is blocked, nothing is published.
    const busy = await command(manager, "duty.create", {
      typeId: duty.typeId,
      name: "תורנות חופפת",
      start,
      end,
    });
    const busyRow = await dutyRow(busy.id);
    await command(
      manager,
      "duty.assign",
      {
        dutyId: busy.id,
        slotId: busyRow.data.slots[0].id,
        soldierId: member.soldierId,
      },
      1
    );
    const change = await requestRow(prepared.id);
    const values = {
      id: prepared.id,
      name: duty.data.name,
      start,
      end,
      location: "",
      instructions: "",
      reason: "דחייה לשבוע הבא",
      seats: change.data.seats,
    };
    await command(manager, "duty.change.save", values, change.version);
    const blocked = await preview(prepared.id);
    expect(blocked.checks[0].status).toBe("blocked");
    await expect(publish(prepared.id)).rejects.toThrow("שיבוצים חסומים");
    expect((await requestRow(request.id)).data.status).toBe("pending");
    expect((await dutyRow(duty.id)).data.start).toBe(duty.data.start);

    const later = {
      ...values,
      start: new Date(Date.now() + 12 * DAY).toISOString(),
      end: new Date(Date.now() + 13 * DAY).toISOString(),
    };
    await command(
      manager,
      "duty.change.save",
      later,
      (await requestRow(prepared.id)).version
    );
    await publish(prepared.id);
    expect((await requestRow(request.id)).data).toMatchObject({
      status: "completed",
      decision: { outcome: "rescheduled", changeId: prepared.id },
    });
    const [seat] = await reserved(duty.id);
    expect(seat.soldierId).toBe(member.soldierId);
    expect(new Date((await dutyRow(duty.id)).data.start).getTime()).toBe(
      new Date(later.start).getTime()
    );
  });

  it("completes every pending request when the whole duty is cancelled, once", async () => {
    const duty = await publishedDuty([member, other]);
    const mine = await submit(duty.id);
    const theirs = await submit(duty.id, other, "postpone");
    const key = randomUUID();
    const payload = {
      id: duty.id,
      reason: "התורנות אינה נדרשת",
      confirmed: true,
      requestId: mine.id,
    };
    await command(manager, "duty.cancel", payload, duty.version, key);
    // Replaying the same command returns the stored result instead of deciding again.
    await command(manager, "duty.cancel", payload, duty.version, key);
    for (const id of [mine.id, theirs.id])
      expect((await requestRow(id)).data).toMatchObject({
        status: "completed",
        decision: { outcome: "duty_cancelled" },
      });
    expect(await reserved(duty.id)).toHaveLength(0);
    expect(await auditOf("cancellation.completed")).toHaveLength(2);
    expect(await auditOf("duty.cancel")).toHaveLength(1);
  });

  it("refuses requests after the start and does not let a pending one bypass the regular cancellation limit", async () => {
    const duty = await publishedDuty([member, other]);
    const request = await submit(duty.id);
    await expect(
      command(manager, "cancellation.refer", { id: request.id, reason: "x" }, 1)
    ).rejects.toThrow("לפני תחילת התורנות");
    await startNow(duty.id);
    await expect(submit(duty.id, other)).rejects.toThrow("כבר התחילה");
    await expect(
      command(
        manager,
        "cancellation.prepare",
        { id: request.id, outcome: "remove", reason: "מאוחר" },
        1
      )
    ).rejects.toThrow("טרם התחילה");
    const started = await dutyRow(duty.id);
    await expect(
      command(
        manager,
        "duty.cancel",
        {
          id: duty.id,
          reason: "מאוחר",
          confirmed: true,
          requestId: request.id,
        },
        started.version
      )
    ).rejects.toThrow("התחילה");
    expect((await requestRow(request.id)).data.status).toBe("pending");
    expect(await reserved(duty.id)).toHaveLength(2);

    await command(
      manager,
      "cancellation.refer",
      { id: request.id, reason: "יתועד בתקופות הביצוע" },
      1
    );
    expect((await requestRow(request.id)).data).toMatchObject({
      status: "referred",
      decision: { outcome: "referred" },
    });
    expect(await reserved(duty.id)).toHaveLength(2);
    const emails = await requestEmails(request.id);
    expect(emails.map((row) => row.kind)).toEqual(["transfer"]);
    expect(emails[0].body).not.toContain("יתועד בתקופות הביצוע");
  });

  it("closes the owner's request when the seat moves to another soldier by consent", async () => {
    const duty = await publishedDuty([member]);
    const request = await submit(duty.id);
    const seat = await seatOf(duty.id, member);
    const offer = await command(
      member,
      "transfer.offer",
      { assignmentId: seat.id, candidateIds: [other.soldierId] },
      seat.version
    );
    await command(
      other,
      "transfer.respond",
      { id: offer.id, decision: "accept", confirmed: true },
      offer.version
    );
    expect((await requestRow(request.id)).data).toMatchObject({
      status: "closed",
      closedReason: "התורנות הועברה לחייל אחר בהסכמה",
    });
    expect((await reserved(duty.id)).map((row) => row.soldierId)).toEqual([
      other.soldierId,
    ]);
    const rows = await db
      .select()
      .from(records)
      .where(
        and(
          eq(records.kind, "request"),
          eq(records.subjectId, other.soldierId!)
        )
      );
    expect(rows).toHaveLength(0);
  });
});
