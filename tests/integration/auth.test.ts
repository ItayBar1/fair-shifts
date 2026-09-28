import { randomUUID } from "node:crypto";
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import {
  user,
  session,
  account,
  emailOutbox,
  emailQuota,
} from "../../src/server/auth-schema";
import {
  soldiers,
  soldierContacts,
  balances,
  duties,
  assignments,
  ledger,
  records,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  issueRecoveryCodes,
  useRecoveryCode,
  unlockAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { requestCode, verifyCode } from "../../src/server/auth/otp";
import { getAuth, getActor } from "../../src/server/auth";
import {
  openSecret,
  deliverNextEmail,
  enqueueEmail,
} from "../../src/server/operations/email";
import { soldier } from "../fixtures";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import { settleDue } from "../../src/server/scoring";
import { loadDomain } from "../../src/server/repository";
import { populationAt, rankAt } from "../../src/domain/eligibility";
import { refreshRankReminders } from "../../src/server/ranks";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");
let technical: Actor;
let manager: Actor;
let memberId: string;
const memberEmail = "member@example.invalid";
async function storedCode(accountId: string) {
  const rows = await db
    .select()
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.recipientAccountId, accountId),
        eq(emailOutbox.kind, "login-code")
      )
    );
  const latest = rows.sort(
    (a, b) => b.expiresAt.getTime() - a.expiresAt.getTime()
  )[0];
  return openSecret(latest.encryptedSecret!);
}
async function invite(
  name: string,
  role: "soldier" | "manager",
  email: string,
  personalNumber = role === "manager" ? "00002" : "00001"
) {
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber,
    data: soldier({ id, name, personalNumber }),
  });
  await db.insert(soldierContacts).values({ soldierId: id, email });
  await db.insert(balances).values({ soldierId: id });
  return createInvitedAccount({ name, role, email, soldierId: id });
}
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
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
  const admin = await invite(
    "אחראי לבדיקה",
    "manager",
    "manager@example.invalid"
  );
  manager = {
    id: admin.id,
    name: admin.name,
    role: "manager",
    soldierId: admin.soldierId!,
    securityEpoch: 1,
  };
  memberId = (await invite("חייל לבדיקה", "soldier", memberEmail)).id;
});
afterAll(async () => pool.end());

describe("invitation-only OTP and lock policy against PostgreSQL", () => {
  it("does not create an account or send mail for an unknown address", async () => {
    expect(await requestCode("unknown@example.invalid")).toEqual({
      success: true,
    });
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
    expect(await db.select().from(user)).toHaveLength(3);
  });
  it("commits all five concurrent failures, locks, and revokes sessions", async () => {
    await requestCode(memberEmail);
    await db.insert(session).values({
      id: "old",
      userId: memberId,
      token: "synthetic",
      securityEpoch: 1,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => verifyCode(memberEmail, "wrong"))
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    const [person] = await db.select().from(user).where(eq(user.id, memberId));
    expect(person.failedAttempts).toBe(5);
    expect(person.lockedAt).not.toBeNull();
    expect(person.securityEpoch).toBe(2);
    expect(await db.select().from(session)).toHaveLength(0);
    await expect(unlockAccount(technical, memberId)).rejects.toThrow();
    await unlockAccount(manager, memberId);
    await expect(verifyCode(memberEmail, "wrong")).rejects.toThrow();
    const [unlocked] = await db
      .select()
      .from(user)
      .where(eq(user.id, memberId));
    expect(unlocked.failedAttempts).toBe(0);
    expect(unlocked.securityEpoch).toBe(3);
  });
  it("retains failures on resend, resets on success, and consumes a code only once", async () => {
    const start = new Date();
    await requestCode(memberEmail, start);
    await expect(verifyCode(memberEmail, "wrong", start)).rejects.toThrow();
    await expect(requestCode(memberEmail, start)).rejects.toThrow("דקה");
    const later = new Date(start.getTime() + 60_001);
    await requestCode(memberEmail, later);
    expect(
      (await db.select().from(user).where(eq(user.id, memberId)))[0]
        .failedAttempts
    ).toBe(1);
    const code = await storedCode(memberId);
    await verifyCode(memberEmail, code, later);
    expect(
      (await db.select().from(user).where(eq(user.id, memberId)))[0]
        .failedAttempts
    ).toBe(0);
    await expect(verifyCode(memberEmail, code, later)).rejects.toThrow();
  });
  it("expires a code at ten minutes", async () => {
    const now = new Date();
    await requestCode(memberEmail, now);
    await expect(
      verifyCode(
        memberEmail,
        await storedCode(memberId),
        new Date(now.getTime() + 600_000)
      )
    ).rejects.toThrow();
  });
  it("allows one recovery only when two requests race", async () => {
    const codes = await db.transaction((tx) =>
      issueRecoveryCodes(technical.id, tx)
    );
    const results = await Promise.allSettled([
      useRecoveryCode("technical@example.invalid", codes[0]),
      useRecoveryCode("technical@example.invalid", codes[0]),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
  });
  it("creates real Better Auth cookies and invalidates them with a security epoch change", async () => {
    await requestCode(memberEmail);
    const response = await getAuth().handler(
      new Request("http://localhost:3000/api/auth/verify-code", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: memberEmail,
          code: await storedCode(memberId),
        }),
      })
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const cookies = response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    expect(cookies).toContain("session_token");
    const headers = new Headers({ cookie: cookies });
    expect((await getActor(headers))?.id).toBe(memberId);
    const [stored] = await db
      .select()
      .from(session)
      .where(eq(session.userId, memberId));
    expect(
      stored.expiresAt.getTime() - stored.createdAt.getTime()
    ).toBeLessThanOrEqual(7 * 86_400_000 + 1000);
    await unlockAccount(manager, memberId);
    expect(await getActor(headers)).toBeNull();
  });
});

describe("durable email queue", () => {
  it("encrypts codes and prioritizes them over reminders", async () => {
    await db.transaction((tx) =>
      enqueueEmail(tx, {
        recipientAccountId: memberId,
        eventKey: "reminder",
        kind: "reminder",
        title: "תזכורת",
        body: "בדיקה",
        priority: 2,
        expiresAt: new Date(Date.now() + 3600_000),
      })
    );
    await requestCode(memberEmail);
    const code = await storedCode(memberId);
    const [outbox] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, "login-code"));
    expect(JSON.stringify(outbox)).not.toContain(code);
    const subjects: string[] = [];
    await deliverNextEmail(async (message) => {
      subjects.push(message.subject);
      return "synthetic-id";
    });
    expect(subjects).toEqual(["קוד כניסה לתורנות הוגנת"]);
  });
  it("does not exceed the shared quota when workers compete", async () => {
    const now = new Date();
    await db
      .insert(emailQuota)
      .values({ day: now.toISOString().slice(0, 10), used: 299 });
    await db.transaction(async (tx) => {
      for (const eventKey of ["one", "two"])
        await enqueueEmail(tx, {
          recipientAccountId: memberId,
          eventKey,
          kind: "reminder",
          title: "תזכורת",
          body: "בדיקה",
          expiresAt: new Date(now.getTime() + 3600_000),
        });
    });
    let sent = 0;
    const deliveryTime = new Date(Date.now() + 1);
    await Promise.all([
      deliverNextEmail(async () => {
        sent++;
        return "one";
      }, deliveryTime),
      deliverNextEmail(async () => {
        sent++;
        return "two";
      }, deliveryTime),
    ]);
    expect(sent).toBe(1);
    expect((await db.select().from(emailQuota))[0].used).toBe(300);
  });
});

describe("first duty vertical slice", () => {
  async function command(
    type: string,
    payload: Record<string, unknown>,
    expectedVersion?: number,
    actor = manager,
    key = randomUUID()
  ) {
    return (await executeAction(actor, {
      type,
      payload,
      expectedVersion,
      idempotencyKey: key,
    })) as { id: string; version: number };
  }
  async function fixtureDuty() {
    const type = await command("dutyType.save", {
      name: "שמירה סינתטית",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 1 }],
    });
    const start = new Date(Date.now() + 86_400_000).toISOString();
    const end = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const duty = await command("duty.create", {
      typeId: type.id,
      name: "תורנות לבדיקה",
      start,
      end,
    });
    const [row] = await db.select().from(duties).where(eq(duties.id, duty.id));
    const [member] = await db.select().from(user).where(eq(user.id, memberId));
    const actor: Actor = {
      id: member.id,
      name: member.name,
      role: "soldier",
      soldierId: member.soldierId!,
      securityEpoch: member.securityEpoch,
    };
    return { row, actor };
  }
  it("keeps drafts private, publishes explicitly and settles exactly once", async () => {
    const { row, actor } = await fixtureDuty();
    await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      1
    );
    const draftState = await readState(actor);
    expect(draftState.duties).toHaveLength(0);
    expect(draftState.assignments).toHaveLength(0);
    expect(JSON.stringify(draftState)).not.toContain(memberEmail);
    expect(JSON.stringify(draftState)).not.toContain("personalNumber");
    await command("duty.publish", { id: row.id, confirmed: true }, 2);
    const published = await readState(actor);
    expect(published.duties).toHaveLength(1);
    expect(published.notifications).toHaveLength(1);
    expect(JSON.stringify(published.duties)).not.toContain("requirements");
    const end = new Date(row.data.end);
    expect(
      (
        await Promise.all([
          unitTransaction((tx) => settleDue(tx, end)),
          unitTransaction((tx) => settleDue(tx, end)),
        ])
      ).sort()
    ).toEqual([0, 1]);
    expect(
      (
        await db
          .select()
          .from(balances)
          .where(eq(balances.soldierId, actor.soldierId!))
      )[0].current
    ).toBe(4);
    expect(
      (
        await db
          .select()
          .from(assignments)
          .where(eq(assignments.dutyId, row.id))
      )[0].status
    ).toBe("credited");
    expect(
      await db
        .select()
        .from(ledger)
        .where(eq(ledger.soldierId, actor.soldierId!))
    ).toHaveLength(1);
  });
  it("lets only one of two managers occupy the last place", async () => {
    const { row, actor } = await fixtureDuty();
    const other = await invite(
      "אחראי שני",
      "manager",
      "second-manager@example.invalid",
      "00003"
    );
    const secondManager: Actor = {
      id: other.id,
      name: other.name,
      role: "manager",
      soldierId: other.soldierId!,
      securityEpoch: 1,
    };
    const results = await Promise.allSettled([
      command(
        "duty.assign",
        {
          dutyId: row.id,
          slotId: row.data.slots[0].id,
          soldierId: actor.soldierId,
        },
        1
      ),
      command(
        "duty.assign",
        {
          dutyId: row.id,
          slotId: row.data.slots[0].id,
          soldierId: manager.soldierId,
        },
        1,
        secondManager
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      await db.select().from(assignments).where(eq(assignments.dutyId, row.id))
    ).toHaveLength(1);
  });
  it("rejects forged privileges and makes retries idempotent", async () => {
    const { row, actor } = await fixtureDuty();
    await expect(
      command("duty.publish", { id: row.id, confirmed: true }, 1, actor)
    ).rejects.toThrow();
    await expect(
      command("account.role", { id: memberId, role: "manager" }, 1, manager)
    ).rejects.toThrow();
    const key = randomUUID();
    const first = await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      1,
      manager,
      key
    );
    const second = await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      1,
      manager,
      key
    );
    expect(second).toEqual(first);
    await expect(
      command(
        "duty.assign",
        {
          dutyId: row.id,
          slotId: row.data.slots[0].id,
          soldierId: manager.soldierId,
        },
        1,
        manager,
        key
      )
    ).rejects.toThrow();
    expect((await readState(technical)).soldiers).toHaveLength(0);
  });
  it("retains an assignment and flags it when a new inactivity period conflicts", async () => {
    const { row, actor } = await fixtureDuty();
    await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      1
    );
    await command(
      "soldier.timeline",
      {
        soldierId: actor.soldierId,
        kind: "inactive",
        startDate: row.data.start.slice(0, 10),
        endDate: row.data.end.slice(0, 10),
        reason: "תקופת אי פעילות סינתטית",
      },
      1
    );
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.dutyId, row.id));
    expect(assignment.status).toBe("reserved");
    expect(assignment.data.needsAttention).toContain("inactive");
    await expect(
      command("duty.publish", { id: row.id, confirmed: true }, 2)
    ).rejects.toThrow();
    // Inactivity concerns scheduling, not login access.
    await requestCode(memberEmail);
    await expect(
      verifyCode(memberEmail, await storedCode(memberId))
    ).resolves.toMatchObject({ epoch: 1 });
  });
  it("verifies a new email, commits failed attempts and revokes old access and Google linking", async () => {
    const { actor } = await fixtureDuty();
    await db.insert(account).values({
      id: "synthetic-google",
      userId: memberId,
      providerId: "google",
      accountId: "synthetic-sub",
    });
    await db.insert(session).values({
      id: "old-session",
      userId: memberId,
      token: "old-token",
      securityEpoch: 1,
      expiresAt: new Date(Date.now() + 1000_000),
    });
    await command(
      "account.email.request",
      {
        soldierId: actor.soldierId,
        email: "new@example.invalid",
        reason: "בדיקת שינוי",
      },
      1
    );
    const [message] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, "email-change"));
    await expect(
      command(
        "account.email.confirm",
        { soldierId: actor.soldierId, code: "wrong", disconnectGoogle: true },
        1
      )
    ).rejects.toThrow("אינו תקין");
    const [challenge] = await db
      .select()
      .from(records)
      .where(eq(records.kind, "email_change"));
    expect(challenge.data.attempts).toBe(1);
    expect(
      (await db.select().from(user).where(eq(user.id, memberId)))[0].email
    ).toBe(memberEmail);
    await command(
      "account.email.confirm",
      {
        soldierId: actor.soldierId,
        code: openSecret(message.encryptedSecret!),
        disconnectGoogle: true,
      },
      1
    );
    expect(
      (await db.select().from(user).where(eq(user.id, memberId)))[0]
    ).toMatchObject({ email: "new@example.invalid", securityEpoch: 2 });
    expect(
      await db.select().from(session).where(eq(session.userId, memberId))
    ).toHaveLength(0);
    expect(
      await db.select().from(account).where(eq(account.userId, memberId))
    ).toHaveLength(0);
    await requestCode(memberEmail);
    expect(
      (await db.select().from(emailOutbox)).filter(
        (row) => row.kind === "login-code"
      )
    ).toHaveLength(0);
  });
  it("keeps the approved constraint while an edit awaits review and after its rejection", async () => {
    const { row, actor } = await fixtureDuty();
    const startDate = row.data.start.slice(0, 10);
    const endDate = row.data.end.slice(0, 10);
    const round = await command("round.create", {
      name: "סבב בדיקה",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 3600_000).toISOString(),
      targetStart: startDate,
      targetEnd: endDate,
    });
    const submission = await command(
      "constraint.submit",
      {
        roundId: round.id,
        startDate,
        endDate: startDate,
        reason: "אילוץ סינתטי",
      },
      undefined,
      actor
    );
    await command(
      "constraint.review",
      { id: submission.id, decision: "approved" },
      1
    );
    await command(
      "constraint.submit",
      {
        id: submission.id,
        roundId: round.id,
        startDate: endDate,
        endDate,
        reason: "גרסה חדשה",
      },
      2,
      actor
    );
    let [stored] = await db
      .select()
      .from(records)
      .where(eq(records.id, submission.id));
    expect(stored.data.approved).toMatchObject({ start: startDate });
    expect(stored.data.pending).toMatchObject({ start: endDate });
    await command(
      "constraint.review",
      { id: submission.id, decision: "rejected", reason: "בדיקה" },
      3
    );
    [stored] = await db
      .select()
      .from(records)
      .where(eq(records.id, submission.id));
    expect(stored.data.approved).toMatchObject({ start: startDate });
    expect(stored.data.pending).toBeNull();
    await expect(
      command(
        "constraint.review",
        { id: submission.id, decision: "approved" },
        3
      )
    ).rejects.toThrow();
    await expect(
      command(
        "duty.assign",
        {
          dutyId: row.id,
          slotId: row.data.slots[0].id,
          soldierId: actor.soldierId,
        },
        1
      )
    ).rejects.toThrow();
    await command("round.close", { id: round.id }, 1);
    await expect(
      command("constraint.submit", { roundId: round.id, none: true }, 4, actor)
    ).rejects.toThrow("אינו פתוח");
  });
  it("accepts multiple independently reviewed items atomically and archives changed versions", async () => {
    const { row, actor } = await fixtureDuty();
    const startDate = row.data.start.slice(0, 10);
    const endDate = row.data.end.slice(0, 10);
    const round = await command("round.create", {
      name: "כמה אילוצים",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 3600_000).toISOString(),
      targetStart: startDate,
      targetEnd: endDate,
    });
    const first = { startDate, endDate: startDate, reason: "בדיקה ראשונה" };
    const second = { startDate: endDate, endDate, reason: "בדיקה שנייה" };
    await expect(
      command(
        "constraint.submit",
        {
          roundId: round.id,
          items: [first, { ...second, endDate: "2099-01-01" }],
        },
        undefined,
        actor
      )
    ).rejects.toThrow("תקופת היעד");
    expect(
      await db.select().from(records).where(eq(records.kind, "constraint"))
    ).toHaveLength(0);
    await command(
      "constraint.submit",
      { roundId: round.id, items: [first, second] },
      undefined,
      actor
    );
    let submissions = await db
      .select()
      .from(records)
      .where(eq(records.kind, "constraint"));
    expect(submissions).toHaveLength(2);
    const accepted = submissions.find(
      (row) => (row.data.pending as { start: string }).start === startDate
    )!;
    const rejected = submissions.find((row) => row.id !== accepted.id)!;
    await command(
      "constraint.review",
      { id: accepted.id, decision: "approved" },
      1
    );
    await command(
      "constraint.review",
      { id: rejected.id, decision: "rejected", reason: "נבדק בנפרד" },
      1
    );
    const [person] = (
      await unitTransaction((tx) => loadDomain(tx))
    ).soldiers.filter((row) => row.id === actor.soldierId);
    expect(person.constraints).toHaveLength(1);
    expect(person.constraints[0].status).toBe("approved");
    await expect(
      command(
        "constraint.submit",
        {
          roundId: round.id,
          none: true,
          existingVersions: submissions.map((row) => ({
            id: row.id,
            version: row.version,
          })),
        },
        undefined,
        actor
      )
    ).rejects.toThrow("השתנתה");
    submissions = await db
      .select()
      .from(records)
      .where(eq(records.kind, "constraint"));
    await command(
      "constraint.submit",
      {
        roundId: round.id,
        none: true,
        existingVersions: submissions.map((row) => ({
          id: row.id,
          version: row.version,
        })),
      },
      undefined,
      actor
    );
    expect(
      (await unitTransaction((tx) => loadDomain(tx))).soldiers.find(
        (row) => row.id === actor.soldierId
      )!.constraints
    ).toHaveLength(1);
    await command(
      "constraint.review",
      { id: accepted.id, decision: "approved" },
      3
    );
    expect(
      (await unitTransaction((tx) => loadDomain(tx))).soldiers.find(
        (row) => row.id === actor.soldierId
      )!.constraints
    ).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(records)
          .where(eq(records.kind, "constraint_revision"))
      ).filter((row) => row.subjectId === actor.soldierId)
    ).toHaveLength(5);
  });
  it("requires current impact confirmation and keeps a conflicting assignment for treatment", async () => {
    const { row, actor } = await fixtureDuty();
    const assigned = await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      1
    );
    const round = await command("round.create", {
      name: "התנגשות",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 3600_000).toISOString(),
      targetStart: row.data.start.slice(0, 10),
      targetEnd: row.data.end.slice(0, 10),
    });
    const submitted = await command(
      "constraint.submit",
      {
        roundId: round.id,
        startDate: row.data.start.slice(0, 10),
        endDate: row.data.end.slice(0, 10),
        reason: "בדיקת התנגשות",
      },
      undefined,
      actor
    );
    await expect(
      command("constraint.preview", { id: submitted.id }, 1, actor)
    ).rejects.toThrow();
    await expect(
      command(
        "constraint.review",
        { id: submitted.id, decision: "approved" },
        1
      )
    ).rejects.toThrow("המושפעים");
    const preview = (await executeAction(manager, {
      type: "constraint.preview",
      payload: { id: submitted.id },
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    })) as { conflicts: unknown[]; impactToken: string };
    expect(preview.conflicts).toHaveLength(1);
    await db
      .update(assignments)
      .set({ version: 10 })
      .where(eq(assignments.id, assigned.id));
    await expect(
      command(
        "constraint.review",
        {
          id: submitted.id,
          decision: "approved",
          impactToken: preview.impactToken,
        },
        1
      )
    ).rejects.toThrow("העדכנית");
    const updated = (await executeAction(manager, {
      type: "constraint.preview",
      payload: { id: submitted.id },
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    })) as { impactToken: string };
    await command(
      "constraint.review",
      {
        id: submitted.id,
        decision: "approved",
        impactToken: updated.impactToken,
      },
      1
    );
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assigned.id));
    expect(assignment.status).toBe("reserved");
    expect(assignment.data.needsAttention).toContain("approved_constraint");
  });
  it("allows a manager to reopen a closed round without changing its target period", async () => {
    const { row, actor } = await fixtureDuty();
    const date = row.data.start.slice(0, 10);
    const round = await command("round.create", {
      name: "פתיחה מחדש",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 3600_000).toISOString(),
      targetStart: date,
      targetEnd: date,
    });
    await command("round.close", { id: round.id }, 1);
    await expect(
      command(
        "constraint.submit",
        { roundId: round.id, none: true },
        undefined,
        actor
      )
    ).rejects.toThrow("אינו פתוח");
    const payload = {
      id: round.id,
      closesAt: new Date(Date.now() + 7200_000).toISOString(),
    };
    await expect(command("round.reopen", payload, 2, actor)).rejects.toThrow();
    await command("round.reopen", payload, 2);
    await command(
      "constraint.submit",
      { roundId: round.id, none: true },
      undefined,
      actor
    );
    expect(
      (await db.select().from(records).where(eq(records.id, round.id)))[0].data
    ).toMatchObject({ targetStart: date, targetEnd: date, status: "open" });
  });
  it("preserves historical population when editing a profile and can change back to its original population", async () => {
    const { actor } = await fixtureDuty();
    await command(
      "soldier.timeline",
      {
        soldierId: actor.soldierId,
        kind: "population",
        startDate: "2026-01-01",
        value: "academic",
        reason: "מעבר סינתטי",
      },
      1
    );
    const payload = {
      id: actor.soldierId,
      name: "שם מעודכן",
      personalNumber: "00001",
      population: "academic",
      serviceType: "mandatory",
      graceEligible: false,
    };
    await command("soldier.update", payload, 2);
    let [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(person.data.service.basePopulation).toBe("mandatory");
    expect(person.data.populationHistory).toHaveLength(1);
    expect(populationAt(person.data, "2025-12-31T12:00:00+02:00")).toBe(
      "mandatory"
    );
    await command("soldier.update", { ...payload, population: "mandatory" }, 3);
    [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(populationAt(person.data, new Date().toISOString())).toBe(
      "mandatory"
    );
    expect(populationAt(person.data, "2026-02-01T12:00:00+02:00")).toBe(
      "academic"
    );
  });
  it("settles overdue work before normalization and serializes a competing worker without double credit", async () => {
    const { row, actor } = await fixtureDuty();
    await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      1
    );
    await command("duty.publish", { id: row.id, confirmed: true }, 2);
    const [published] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, row.id));
    await db
      .update(duties)
      .set({
        data: {
          ...published.data,
          start: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          end: new Date(Date.now() - 86_400_000).toISOString(),
        },
      })
      .where(eq(duties.id, row.id));
    await db
      .update(balances)
      .set({ current: 47 })
      .where(eq(balances.soldierId, actor.soldierId!));
    await db
      .update(balances)
      .set({ current: 51 })
      .where(eq(balances.soldierId, manager.soldierId!));
    const score = {
      soldierIds: [actor.soldierId!, manager.soldierId!],
      operation: "percent",
      value: 20,
      reason: "נרמול סינתטי",
    };
    const preview = (await executeAction(manager, {
      type: "score.preview",
      payload: score,
      idempotencyKey: randomUUID(),
    })) as { token: string; rows: { before: number; after: number }[] };
    expect(preview.rows.map((row) => [row.before, row.after])).toEqual([
      [51, 41],
      [51, 41],
    ]);
    const key = randomUUID();
    await Promise.all([
      executeAction(manager, {
        type: "score.apply",
        payload: { ...score, token: preview.token },
        idempotencyKey: key,
      }),
      unitTransaction((tx) => settleDue(tx)),
    ]);
    await executeAction(manager, {
      type: "score.apply",
      payload: { ...score, token: preview.token },
      idempotencyKey: key,
    });
    expect(
      (await db.select().from(balances)).map((row) => row.current)
    ).toEqual([41, 41]);
    expect(
      (await db.select().from(ledger)).filter(
        (row) => row.kind === "performance"
      )
    ).toHaveLength(1);
    expect(
      (await db.select().from(ledger)).filter(
        (row) => row.kind === "normalization"
      )
    ).toHaveLength(2);
  });
  it("rejects a normalization preview after a concurrent balance change without partially applying it", async () => {
    const { actor } = await fixtureDuty();
    const input = {
      soldierIds: [manager.soldierId!, actor.soldierId!],
      operation: "add",
      value: 5,
      reason: "בדיקת תצוגה",
    };
    const preview = (await executeAction(manager, {
      type: "score.preview",
      payload: input,
      idempotencyKey: randomUUID(),
    })) as { token: string };
    const another = { ...input, soldierIds: [actor.soldierId!], value: 3 };
    const competing = (await executeAction(manager, {
      type: "score.preview",
      payload: another,
      idempotencyKey: randomUUID(),
    })) as { token: string };
    await executeAction(manager, {
      type: "score.apply",
      payload: { ...another, token: competing.token },
      idempotencyKey: randomUUID(),
    });
    await expect(
      command("score.apply", { ...input, token: preview.token })
    ).rejects.toThrow("יתרה השתנתה");
    expect(
      (
        await db
          .select()
          .from(balances)
          .where(eq(balances.soldierId, manager.soldierId!))
      )[0].current
    ).toBe(0);
    expect(
      (
        await db
          .select()
          .from(balances)
          .where(eq(balances.soldierId, actor.soldierId!))
      )[0].current
    ).toBe(3);
  });
  async function rankFixture() {
    const { actor } = await fixtureDuty();
    const lower = await command("rank.catalog.save", {
      name: "דרגה א לבדיקה",
      track: "מסלול סינתטי",
      order: 1,
      source: "נתוני בדיקה בלבד",
    });
    const upper = await command("rank.catalog.save", {
      name: "דרגה ב לבדיקה",
      track: "מסלול סינתטי",
      order: 2,
      source: "נתוני בדיקה בלבד",
    });
    await command(
      "rank.set",
      {
        soldierId: actor.soldierId,
        rankId: lower.id,
        effectiveDate: "2026-01-31",
        reason: "אישור סינתטי",
      },
      1
    );
    return { actor, lower, upper };
  }
  it("creates one tenure reminder without promoting and requires an explicit versioned decision", async () => {
    const { actor, lower, upper } = await rankFixture();
    await command("rank.rule.save", {
      name: "כלל סינתטי",
      fromRankId: lower.id,
      toRankId: upper.id,
      months: 1,
      base: "rank",
      source: "בדיקה בלבד",
    });
    await Promise.all([
      unitTransaction((tx) => refreshRankReminders(tx)),
      unitTransaction((tx) => refreshRankReminders(tx)),
    ]);
    const reminders = await db
      .select()
      .from(records)
      .where(eq(records.kind, "rank_reminder"));
    expect(reminders).toHaveLength(1);
    expect(reminders[0].data).toMatchObject({
      status: "pending",
      dueDate: "2026-02-28",
    });
    expect(
      (
        await db.select().from(records).where(eq(records.kind, "notification"))
      ).filter((row) => row.data.reminderId === reminders[0].id)
    ).toHaveLength(1);
    let [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(rankAt(person.data, new Date().toISOString())?.rankId).toBe(
      lower.id
    );
    await expect(
      command(
        "rank.approve",
        { id: reminders[0].id, effectiveDate: "2026-03-01", reason: "אישור" },
        reminders[0].version,
        actor
      )
    ).rejects.toThrow();
    await command(
      "rank.approve",
      {
        id: reminders[0].id,
        effectiveDate: "2026-03-01",
        reason: "אישור אחראי לבדיקה",
      },
      reminders[0].version
    );
    await expect(
      command(
        "rank.approve",
        { id: reminders[0].id, effectiveDate: "2026-03-01", reason: "כפילות" },
        reminders[0].version
      )
    ).rejects.toThrow();
    [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(rankAt(person.data, "2026-02-15T12:00:00+02:00")?.rankId).toBe(
      lower.id
    );
    expect(rankAt(person.data, new Date().toISOString())?.rankId).toBe(
      upper.id
    );
  });
  it("recalculates open reminders on a rule change and never overwrites a manually approved future rank", async () => {
    const { actor, lower, upper } = await rankFixture();
    const input = {
      name: "כלל לשינוי",
      fromRankId: lower.id,
      toRankId: upper.id,
      months: 1,
      base: "rank",
      source: "בדיקה בלבד",
    };
    const rule = await command("rank.rule.save", input);
    const [reminder] = await db
      .select()
      .from(records)
      .where(eq(records.kind, "rank_reminder"));
    await command(
      "rank.rule.save",
      { ...input, id: rule.id, months: 120, source: "כלל מתוקן לבדיקה" },
      1
    );
    const [updated] = await db
      .select()
      .from(records)
      .where(eq(records.id, reminder.id));
    expect(updated.data.status).toBe("scheduled");
    expect(updated.version).toBeGreaterThan(reminder.version);
    await expect(
      command(
        "rank.approve",
        { id: reminder.id, effectiveDate: "2026-03-01", reason: "אישור ישן" },
        reminder.version
      )
    ).rejects.toThrow();
    await command(
      "rank.set",
      {
        soldierId: actor.soldierId,
        rankId: upper.id,
        effectiveDate: "2030-01-01",
        reason: "עדכון עתידי מאושר לבדיקה",
      },
      2
    );
    await unitTransaction((tx) => refreshRankReminders(tx));
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(rankAt(person.data, "2029-12-31T12:00:00+02:00")?.rankId).toBe(
      lower.id
    );
    expect(rankAt(person.data, "2030-01-01T12:00:00+02:00")?.rankId).toBe(
      upper.id
    );
    expect(
      (await db.select().from(records).where(eq(records.id, reminder.id)))[0]
        .data.status
    ).toBe("superseded");
  });
  it("shows missing enlistment data and permits a sourced personal deadline without guessing equivalence", async () => {
    const { actor, lower, upper } = await rankFixture();
    const foreign = await command("rank.catalog.save", {
      name: "דרגה במסלול אחר",
      track: "מסלול אחר",
      order: 20,
      source: "בדיקה",
    });
    const rule = {
      name: "כלל גיוס",
      fromRankId: lower.id,
      toRankId: upper.id,
      months: 10,
      base: "enlistment",
      source: "בדיקה בלבד",
    };
    await expect(
      command("rank.rule.save", { ...rule, toRankId: foreign.id })
    ).rejects.toThrow("באותו מסלול");
    await command("rank.rule.save", rule);
    const [missing] = await db
      .select()
      .from(records)
      .where(eq(records.kind, "rank_reminder"));
    expect(missing.data.status).toBe("missing_data");
    expect(missing.data.dueDate).toBeNull();
    await command(
      "rank.deadline",
      {
        soldierId: actor.soldierId,
        toRankId: upper.id,
        dueDate: "2026-03-01",
        source: "מועד אישי מאומת לבדיקה",
      },
      2
    );
    const [updated] = await db
      .select()
      .from(records)
      .where(eq(records.id, missing.id));
    expect(updated.data).toMatchObject({
      status: "pending",
      dueDate: "2026-03-01",
    });
    expect((await readState(actor)).rankRules).toEqual([]);
  });
  it("snapshots duty and role rank requirements and checks the confirmed rank at the start", async () => {
    const { actor, lower, upper } = await rankFixture();
    const type = await command("dutyType.save", {
      name: "הרכב עם דרגות",
      populations: ["mandatory"],
      ranks: [{ trackId: "מסלול סינתטי", minOrder: 1, maxOrder: 2 }],
      pricing: { mode: "fixed", base: 4 },
      roles: [
        {
          name: "תפקיד מתקדם",
          count: 1,
          requirements: {
            ranks: [{ trackId: "מסלול סינתטי", rankIds: [upper.id] }],
          },
        },
        {
          name: "תפקיד בסיסי",
          count: 1,
          requirements: {
            ranks: [{ trackId: "מסלול סינתטי", rankIds: [lower.id] }],
          },
        },
      ],
    });
    const start = "2029-06-01T08:00:00+03:00";
    const end = "2029-06-03T08:00:00+03:00";
    const created = await command("duty.create", {
      typeId: type.id,
      name: "הרכב לבדיקה",
      start,
      end,
    });
    await command(
      "rank.set",
      {
        soldierId: actor.soldierId,
        rankId: upper.id,
        effectiveDate: "2029-06-02",
        reason: "אישור עתידי לבדיקה",
      },
      2
    );
    const [duty] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, created.id));
    await expect(
      command(
        "duty.assign",
        {
          dutyId: duty.id,
          slotId: duty.data.slots[0].id,
          soldierId: actor.soldierId,
        },
        1
      )
    ).rejects.toThrow("בדיקת התאמה");
    await command(
      "duty.assign",
      {
        dutyId: duty.id,
        slotId: duty.data.slots[1].id,
        soldierId: actor.soldierId,
      },
      1
    );
    expect(
      (
        await db
          .select()
          .from(assignments)
          .where(eq(assignments.dutyId, duty.id))
      )[0].slotId
    ).toBe(duty.data.slots[1].id);
    const foreign = await command("rank.catalog.save", {
      name: "דרגה זרה",
      track: "אחר",
      order: 1,
      source: "בדיקה",
    });
    await expect(
      command("dutyType.save", {
        name: "תנאי שגוי",
        ranks: [{ trackId: "מסלול סינתטי", rankIds: [foreign.id] }],
        pricing: { mode: "fixed", base: 4 },
        roles: [{ name: "תפקיד", count: 1 }],
      })
    ).rejects.toThrow("באותו מסלול");
  });
  async function assignmentPreview(
    payload: Record<string, unknown>,
    version: number
  ) {
    return (await executeAction(manager, {
      type: "duty.assignment.preview",
      payload,
      expectedVersion: version,
      idempotencyKey: randomUUID(),
    })) as {
      previewToken: string;
      status: string;
      requirements: { key: string; code: string }[];
    };
  }
  it("persists a justified rank exception through another seat assignment and publication", async () => {
    const { actor, upper } = await rankFixture();
    const type = await command("dutyType.save", {
      name: "חריג דרגה",
      pricing: { mode: "fixed", base: 4 },
      ranks: [{ trackId: "מסלול סינתטי", rankIds: [upper.id] }],
      roles: [{ name: "תורן", count: 2 }],
    });
    const created = await command("duty.create", {
      typeId: type.id,
      name: "בדיקת חריג",
      start: "2029-04-01T08:00:00+03:00",
      end: "2029-04-01T12:00:00+03:00",
    });
    const [duty] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, created.id));
    const input = {
      dutyId: duty.id,
      slotId: duty.data.slots[0].id,
      soldierId: actor.soldierId,
    };
    const preview = await assignmentPreview(input, 1);
    expect(preview.status).toBe("approval_required");
    expect(preview.requirements.map((row) => row.code)).toEqual(["rank"]);
    await expect(
      command(
        "duty.assign",
        {
          ...input,
          previewToken: preview.previewToken,
          approvalKeys: preview.requirements.map((row) => row.key),
        },
        1
      )
    ).rejects.toThrow("מנומק");
    await command(
      "duty.assign",
      {
        ...input,
        previewToken: preview.previewToken,
        approvalKeys: preview.requirements.map((row) => row.key),
        approvalReason: "חריג נקודתי לבדיקה",
      },
      1
    );
    const second = {
      ...input,
      slotId: duty.data.slots[1].id,
      soldierId: manager.soldierId,
    };
    const another = await assignmentPreview(second, 2);
    await command(
      "duty.assign",
      {
        ...second,
        previewToken: another.previewToken,
        approvalKeys: another.requirements.map((row) => row.key),
        approvalReason: "חריג שני לבדיקה",
      },
      2
    );
    await command("duty.publish", { id: duty.id, confirmed: true }, 3);
    expect(
      (await db.select().from(duties).where(eq(duties.id, duty.id)))[0].data
        .status
    ).toBe("published");
    const [memberAssignment] = (await db.select().from(assignments)).filter(
      (row) => row.soldierId === actor.soldierId
    );
    expect(memberAssignment.data.approvals?.[0]).toMatchObject({
      kind: "rank",
      approvedBy: manager.id,
      soldierVersion: 2,
    });
    await command(
      "soldier.timeline",
      {
        soldierId: actor.soldierId,
        kind: "inactive",
        startDate: "2029-04-01",
        endDate: "2029-04-01",
        reason: "שינוי זמינות",
      },
      2
    );
    expect(
      (
        await db
          .select()
          .from(assignments)
          .where(eq(assignments.id, memberAssignment.id))
      )[0].data.needsAttention
    ).toContain("inactive");
    expect(JSON.stringify((await readState(actor)).assignments)).not.toContain(
      "חריג נקודתי"
    );
  });
  it("rejects an obsolete exception preview and never permits it to bypass a missing qualification", async () => {
    const { actor, upper } = await rankFixture();
    const exemption = await command("eligibility.catalog.save", {
      kind: "exemption",
      name: "פטור סינתטי",
    });
    const qualification = await command("eligibility.catalog.save", {
      kind: "qualification",
      name: "כשירות סינתטית",
    });
    const type = await command("dutyType.save", {
      name: "תנאים מצטברים",
      pricing: { mode: "fixed", base: 4 },
      ranks: [{ trackId: "מסלול סינתטי", rankIds: [upper.id] }],
      exemptionIds: [exemption.id],
      roles: [{ name: "תורן", count: 1 }],
    });
    const created = await command("duty.create", {
      typeId: type.id,
      name: "בדיקת רעננות",
      start: "2029-04-01T08:00:00+03:00",
      end: "2029-04-01T12:00:00+03:00",
    });
    const [duty] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, created.id));
    const input = {
      dutyId: duty.id,
      slotId: duty.data.slots[0].id,
      soldierId: actor.soldierId,
    };
    const preview = await assignmentPreview(input, 1);
    await command(
      "soldier.timeline",
      {
        soldierId: actor.soldierId,
        kind: "exemption",
        startDate: "2029-04-01",
        endDate: "2029-04-01",
        value: exemption.id,
      },
      2
    );
    await expect(
      command(
        "duty.assign",
        {
          ...input,
          previewToken: preview.previewToken,
          approvalKeys: preview.requirements.map((row) => row.key),
          approvalReason: "אישור ישן",
        },
        1
      )
    ).rejects.toThrow("השתנו");
    const current = await assignmentPreview(input, 1);
    expect(current.requirements.map((row) => row.code).sort()).toEqual([
      "exemption",
      "rank",
    ]);
    await db
      .update(duties)
      .set({
        data: {
          ...duty.data,
          requirements: {
            ...duty.data.requirements,
            qualificationIds: [qualification.id],
          },
        },
      })
      .where(eq(duties.id, duty.id));
    const blocked = await assignmentPreview(input, 1);
    expect(blocked.status).toBe("blocked");
    await expect(
      command(
        "duty.assign",
        {
          ...input,
          previewToken: blocked.previewToken,
          approvalKeys: blocked.requirements.map((row) => row.key),
          approvalReason: "אסור לעקוף כשירות",
        },
        1
      )
    ).rejects.toThrow("בדיקת התאמה");
    expect(
      await db.select().from(assignments).where(eq(assignments.dutyId, duty.id))
    ).toHaveLength(0);
  });
  async function pendingLottery() {
    const { row, actor } = await fixtureDuty();
    await db
      .update(balances)
      .set({ current: 100 })
      .where(eq(balances.soldierId, manager.soldierId!));
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    await db
      .update(soldiers)
      .set({
        data: {
          ...person.data,
          service: {
            ...person.data.service,
            releaseDate: new Date(Date.now() + 10 * 86400_000)
              .toISOString()
              .slice(0, 10),
          },
        },
      })
      .where(eq(soldiers.id, person.id));
    const payload = { dutyId: row.id, slotId: row.data.slots[0].id };
    const result = (await executeAction(manager, {
      type: "duty.lottery",
      payload,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    })) as {
      proposalId: string;
      version: number;
      status: string;
      requirements: { key: string }[];
      candidateId: string;
    };
    return { row, actor, payload, result };
  }
  it("retains a pending draw without reserving points and recomputes the band after rejection", async () => {
    const { row, actor, payload, result } = await pendingLottery();
    expect(result.status).toBe("approval_required");
    expect(result.candidateId).toBe(actor.soldierId);
    expect(await db.select().from(assignments)).toHaveLength(0);
    const again = await executeAction(manager, {
      type: "duty.lottery",
      payload,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    expect(again).toEqual(result);
    const replacement = (await executeAction(manager, {
      type: "duty.lottery.approve",
      payload: {
        proposalId: result.proposalId,
        decision: "reject",
        reason: "דחייה לבדיקה",
      },
      expectedVersion: result.version,
      idempotencyKey: randomUUID(),
    })) as { status: string; minimum: number; candidateId: string };
    expect(replacement).toMatchObject({
      status: "assigned",
      minimum: 100,
      candidateId: manager.soldierId,
    });
    expect((await db.select().from(assignments))[0].dutyId).toBe(row.id);
    const visible = await readState(actor);
    expect(JSON.stringify(visible)).not.toContain("lottery_attempt");
    expect("lotteryAttempts" in visible ? visible.lotteryAttempts : []).toEqual(
      []
    );
  });
  it("requires explicit proposal approvals and completes a competing decision only once", async () => {
    const { row, result } = await pendingLottery();
    const payload = {
      proposalId: result.proposalId,
      decision: "approve",
      reason: "אישור נקודתי",
    };
    await expect(
      command("duty.lottery.approve", payload, result.version)
    ).rejects.toThrow("אישור מפורש");
    const approved = {
      ...payload,
      approvalKeys: result.requirements.map((item) => item.key),
    };
    const outcomes = await Promise.allSettled([
      command("duty.lottery.approve", approved, result.version),
      command("duty.lottery.approve", approved, result.version),
    ]);
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(
      1
    );
    expect(await db.select().from(assignments)).toHaveLength(1);
    await command("duty.publish", { id: row.id, confirmed: true }, 2);
  });
  it("rejects a proposal when candidate availability changes before approval", async () => {
    const { row, actor, result } = await pendingLottery();
    await command(
      "soldier.timeline",
      {
        soldierId: actor.soldierId,
        kind: "inactive",
        startDate: row.data.start.slice(0, 10),
        endDate: row.data.end.slice(0, 10),
        reason: "שינוי זמינות",
      },
      1
    );
    await expect(
      command(
        "duty.lottery.approve",
        {
          proposalId: result.proposalId,
          decision: "approve",
          reason: "מידע ישן",
          approvalKeys: result.requirements.map((item) => item.key),
        },
        result.version
      )
    ).rejects.toThrow("הנתונים השתנו");
    expect(await db.select().from(assignments)).toHaveLength(0);
  });
  it("plans one seat per transaction, resumes, and leaves missing seats without moving assignments", async () => {
    const type = await command("dutyType.save", {
      name: "תכנון שלושה מקומות",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 3 }],
    });
    const created = await command("duty.create", {
      typeId: type.id,
      name: "תכנון סינתטי",
      start: "2029-05-01T08:00:00+03:00",
      end: "2029-05-01T16:00:00+03:00",
    });
    const run = await command("planning.run", {
      start: "2029-05-01",
      end: "2029-05-01",
    });
    await command("planning.step", { id: run.id }, 1);
    expect(await db.select().from(assignments)).toHaveLength(1);
    await expect(command("planning.step", { id: run.id }, 1)).rejects.toThrow(
      "המידע השתנה"
    );
    await command("planning.step", { id: run.id }, 2);
    await command("planning.step", { id: run.id }, 3);
    await command("planning.step", { id: run.id }, 4);
    const [stored] = await db
      .select()
      .from(records)
      .where(eq(records.id, run.id));
    expect(stored.data.status).toBe("completed");
    expect(stored.data.missing).toHaveLength(1);
    const before = await db.select().from(assignments);
    expect(before).toHaveLength(2);
    expect(new Set(before.map((row) => row.soldierId)).size).toBe(2);
    const another = await command("planning.run", {
      start: "2029-05-01",
      end: "2029-05-01",
      dutyIds: [created.id],
    });
    await command("planning.step", { id: another.id }, 1);
    await command("planning.step", { id: another.id }, 2);
    expect(await db.select().from(assignments)).toEqual(before);
    const attempts = await db
      .select()
      .from(records)
      .where(eq(records.kind, "lottery_attempt"));
    expect(attempts.some((row) => row.data.status === "unfilled")).toBe(true);
  });
  it("resumes a waiting plan after rejecting a candidate and reports the replacement assignment", async () => {
    const { row, result } = await pendingLottery();
    const date = row.data.start.slice(0, 10);
    const run = await command("planning.run", {
      start: date,
      end: date,
      dutyIds: [row.id],
    });
    await command("planning.step", { id: run.id }, 1);
    const [waiting] = await db
      .select()
      .from(records)
      .where(eq(records.id, run.id));
    expect(waiting.data.status).toBe("awaiting_approval");
    await command("planning.step", { id: run.id }, waiting.version);
    expect(await db.select().from(assignments)).toHaveLength(0);
    await command(
      "duty.lottery.approve",
      {
        proposalId: result.proposalId,
        decision: "reject",
        reason: "דחייה ובחירה מחדש",
      },
      result.version
    );
    await command("planning.step", { id: run.id }, waiting.version);
    const [finished] = await db
      .select()
      .from(records)
      .where(eq(records.id, run.id));
    expect(finished.data.status).toBe("completed");
    expect(finished.data.missing).toEqual([]);
    expect(finished.data.results).toEqual([
      expect.objectContaining({ status: "assigned" }),
    ]);
  });
  it("plans scarce duties before earlier common duties and the rare role first within a duty", async () => {
    const { actor } = await fixtureDuty();
    const qualification = await command("eligibility.catalog.save", {
      kind: "qualification",
      name: "כשירות נדירה לבדיקה",
    });
    await command(
      "soldier.timeline",
      {
        soldierId: actor.soldierId,
        kind: "qualification",
        startDate: "2029-01-01",
        endDate: "2029-12-31",
        value: qualification.id,
      },
      1
    );
    const common = await command("dutyType.save", {
      name: "תפקיד רגיל",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "רגיל", count: 1 }],
    });
    const rare = await command("dutyType.save", {
      name: "תפקיד נדיר",
      pricing: { mode: "fixed", base: 4 },
      qualificationIds: [qualification.id],
      roles: [{ name: "נדיר", count: 1 }],
    });
    await command("duty.create", {
      typeId: common.id,
      name: "מוקדם ורגיל",
      start: "2029-05-01T08:00:00+03:00",
      end: "2029-05-01T12:00:00+03:00",
    });
    const scarce = await command("duty.create", {
      typeId: rare.id,
      name: "מאוחר ונדיר",
      start: "2029-05-02T08:00:00+03:00",
      end: "2029-05-02T12:00:00+03:00",
    });
    const run = await command("planning.run", {
      start: "2029-05-01",
      end: "2029-05-02",
    });
    await command("planning.step", { id: run.id }, 1);
    expect((await db.select().from(assignments))[0].dutyId).toBe(scarce.id);
    const mixed = await command("dutyType.save", {
      name: "הרכב מעורב",
      pricing: { mode: "fixed", base: 4 },
      roles: [
        { name: "רגיל", count: 1 },
        {
          name: "נדיר",
          count: 1,
          requirements: { qualificationIds: [qualification.id] },
        },
      ],
    });
    const created = await command("duty.create", {
      typeId: mixed.id,
      name: "סדר בתוך מופע",
      start: "2029-05-03T08:00:00+03:00",
      end: "2029-05-03T12:00:00+03:00",
    });
    const mixedRun = await command("planning.run", {
      start: "2029-05-03",
      end: "2029-05-03",
    });
    await command("planning.step", { id: mixedRun.id }, 1);
    const [duty] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, created.id));
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.dutyId, created.id));
    expect(assignment.slotId).toBe(
      duty.data.slots.find((slot) => slot.role === "נדיר")?.id
    );
    expect(assignment.soldierId).toBe(actor.soldierId);
  });
  it("keeps the global pending-review confirmation separate from each collision approval", async () => {
    const { row, actor } = await fixtureDuty();
    await db
      .update(balances)
      .set({ current: 100 })
      .where(eq(balances.soldierId, manager.soldierId!));
    const startDate = row.data.start.slice(0, 10);
    const endDate = row.data.end.slice(0, 10);
    const round = await command("round.create", {
      name: "סקירה לפני הגרלה",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 3600_000).toISOString(),
      targetStart: startDate,
      targetEnd: endDate,
    });
    await command(
      "constraint.submit",
      { roundId: round.id, startDate, endDate, reason: "אילוץ לבדיקה" },
      undefined,
      actor
    );
    const payload = { dutyId: row.id, slotId: row.data.slots[0].id };
    await expect(command("duty.lottery", payload, 1)).rejects.toThrow(
      "סקירת האילוצים"
    );
    const attempt = (await executeAction(manager, {
      type: "duty.lottery",
      payload: { ...payload, reviewPending: true },
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    })) as {
      proposalId: string;
      version: number;
      status: string;
      requirements: { key: string; code: string }[];
    };
    expect(attempt.status).toBe("approval_required");
    expect(attempt.requirements).toHaveLength(1);
    await expect(
      command(
        "duty.lottery.approve",
        {
          proposalId: attempt.proposalId,
          decision: "approve",
          reason: "חסר אישור פרטני",
        },
        attempt.version
      )
    ).rejects.toThrow("אישור מפורש");
    expect(await db.select().from(assignments)).toHaveLength(0);
    await command(
      "duty.lottery.approve",
      {
        proposalId: attempt.proposalId,
        decision: "approve",
        reason: "אישור פרטני מתועד",
        approvalKeys: attempt.requirements.map((item) => item.key),
      },
      attempt.version
    );
    await command("duty.publish", { id: row.id, confirmed: true }, 2);
    expect(await db.select().from(assignments)).toHaveLength(1);
  });
  async function publishedFixture() {
    const fixture = await fixtureDuty();
    await command(
      "duty.assign",
      {
        dutyId: fixture.row.id,
        slotId: fixture.row.data.slots[0].id,
        soldierId: fixture.actor.soldierId,
      },
      1
    );
    await command("duty.publish", { id: fixture.row.id, confirmed: true }, 2);
    return fixture;
  }
  async function changePreview(changeId: string, version: number) {
    return (await executeAction(manager, {
      type: "duty.change.preview",
      payload: { id: changeId },
      expectedVersion: version,
      idempotencyKey: randomUUID(),
    })) as {
      previewToken: string;
      checks: { status: string; requirements: { key: string }[] }[];
      affected: unknown[];
    };
  }
  it("edits a draft and explicitly applies catalog changes without publishing or double reserving points", async () => {
    const { row, actor } = await fixtureDuty();
    await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      1
    );
    await command(
      "dutyType.save",
      {
        id: row.typeId,
        name: "קטלוג לטיוטה",
        pricing: { mode: "fixed", base: 9 },
        roles: [{ name: "תורן", count: 2 }],
      },
      1
    );
    const change = await command(
      "duty.change.create",
      { dutyId: row.id, reason: "עדכון טיוטה מפורש", applyCatalog: true },
      2
    );
    const proposal = (
      await db.select().from(records).where(eq(records.id, change.id))
    )[0];
    const proposed = proposal.data.proposed as typeof row.data;
    await command(
      "duty.change.save",
      {
        ...proposed,
        id: change.id,
        name: "טיוטה מעודכנת",
        reason: "שינוי פרטים והרכב",
        seats: proposed.slots.map((slot, index) => ({
          slotId: slot.id,
          soldierId: index ? null : actor.soldierId,
          extraPoints: index ? 0 : 2,
        })),
      },
      1
    );
    expect(
      (await db.select().from(assignments)).filter(
        (item) => item.status === "reserved"
      )
    ).toMatchObject([{ points: 4 }]);
    const preview = await changePreview(change.id, 2);
    const payload = {
      id: change.id,
      confirmed: true,
      previewToken: preview.previewToken,
    };
    await expect(command("duty.change.publish", payload, 2)).rejects.toThrow(
      "אינו מפרסם טיוטה"
    );
    await command("duty.change.apply", payload, 2);
    const [updated] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, row.id));
    expect(updated.data).toMatchObject({
      name: "טיוטה מעודכנת",
      status: "draft",
      version: 3,
    });
    expect(updated.data.slots).toHaveLength(2);
    expect(
      (await db.select().from(assignments)).filter(
        (item) => item.status === "reserved"
      )
    ).toMatchObject([{ points: 11 }]);
    const privateState = await readState(actor);
    expect(privateState.duties).toHaveLength(0);
    expect(privateState.notifications).toHaveLength(0);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
    await command("duty.publish", { id: row.id, confirmed: true }, 3);
    const published = await readState(actor);
    expect(published.duties[0].name).toBe("טיוטה מעודכנת");
    expect(published.assignments).toHaveLength(1);
  });
  it("cancels an expired draft explicitly and releases reservations without earning points or revealing it", async () => {
    const { row, actor } = await fixtureDuty();
    await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      1
    );
    const [live] = await db.select().from(duties).where(eq(duties.id, row.id));
    await db
      .update(duties)
      .set({
        data: {
          ...live.data,
          start: new Date(Date.now() - 2 * 86400_000).toISOString(),
          end: new Date(Date.now() - 86400_000).toISOString(),
        },
      })
      .where(eq(duties.id, row.id));
    await unitTransaction((tx) => settleDue(tx));
    expect((await db.select().from(assignments))[0].status).toBe("reserved");
    await expect(
      command(
        "duty.cancel",
        { id: row.id, reason: "ביטול", confirmed: true },
        2,
        actor
      )
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    const cancellation = {
      type: "duty.cancel",
      payload: { id: row.id, reason: "טיוטה שלא בוצעה", confirmed: true },
      expectedVersion: 2,
      idempotencyKey: randomUUID(),
    };
    const result = await executeAction(manager, cancellation);
    expect(await executeAction(manager, cancellation)).toEqual(result);
    expect((await db.select().from(assignments))[0].status).toBe("cancelled");
    expect(await db.select().from(ledger)).toHaveLength(0);
    expect(
      (await db.select().from(balances)).every((item) => item.current === 0)
    ).toBe(true);
    const state = await readState(actor);
    expect(state.duties).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
  });
  it("cancels a future published duty atomically, closes proposals and sends one cancellation per affected soldier", async () => {
    const { row, actor } = await publishedFixture();
    const change = await command(
      "duty.change.create",
      { dutyId: row.id, reason: "הצעה פתוחה" },
      3
    );
    const preview = await changePreview(change.id, 1);
    await expect(
      command(
        "duty.change.apply",
        { id: change.id, confirmed: true, previewToken: preview.previewToken },
        1
      )
    ).rejects.toThrow("אינה מיועדת לתורנות שפורסמה");
    const results = await Promise.allSettled([
      command(
        "duty.cancel",
        { id: row.id, reason: "ביטול מאושר", confirmed: true },
        3
      ),
      command(
        "duty.cancel",
        { id: row.id, reason: "ביטול מתחרה", confirmed: true },
        3
      ),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    const state = await readState(actor);
    expect(state.duties[0].status).toBe("cancelled");
    expect(
      state.assignments.filter((item) => item.status === "reserved")
    ).toHaveLength(0);
    expect(
      (
        await db.select().from(records).where(eq(records.kind, "notification"))
      ).filter(
        (item) =>
          item.subjectId === actor.soldierId &&
          item.data.title === "התורנות בוטלה"
      )
    ).toHaveLength(1);
    expect(
      (await db.select().from(records).where(eq(records.id, change.id)))[0].data
        .status
    ).toBe("cancelled");
    const messages = await db.select().from(emailOutbox);
    expect(
      messages.filter((item) => item.kind === "publication")[0].status
    ).toBe("cancelled");
    expect(
      messages.filter((item) => item.kind === "publication-change")
    ).toHaveLength(1);
    await unitTransaction((tx) =>
      settleDue(tx, new Date(Date.now() + 15 * 86400_000))
    );
    expect(await db.select().from(ledger)).toHaveLength(0);
  });
  it("serializes cancellation with publication and refuses to cancel a published duty after it starts", async () => {
    const { row, actor } = await fixtureDuty();
    await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      1
    );
    const outcomes = await Promise.allSettled([
      command("duty.publish", { id: row.id, confirmed: true }, 2),
      command(
        "duty.cancel",
        { id: row.id, reason: "ביטול מתחרה לפרסום", confirmed: true },
        2
      ),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    const [live] = await db.select().from(duties).where(eq(duties.id, row.id));
    await db
      .update(duties)
      .set({
        data: {
          ...live.data,
          status: "published",
          start: new Date(Date.now() - 3600_000).toISOString(),
        },
      })
      .where(eq(duties.id, row.id));
    await expect(
      command(
        "duty.cancel",
        { id: row.id, reason: "נדרש ביצוע", confirmed: true },
        live.version
      )
    ).rejects.toThrow("מחייב טיפול בביצוע");
  });
  async function timelinePreview(
    actor: Actor,
    payload: Record<string, unknown>,
    version: number
  ) {
    return (await executeAction(actor, {
      type: "soldier.timeline.edit.preview",
      payload,
      expectedVersion: version,
      idempotencyKey: randomUUID(),
    })) as {
      previewToken: string;
      impact: { before: string; after: string; reasons: { code: string }[] }[];
    };
  }
  it("previews a shortened qualification for the whole performance, retains the assignment and flags it after explicit confirmation", async () => {
    const { row, actor } = await fixtureDuty();
    const qualification = await command("eligibility.catalog.save", {
      kind: "qualification",
      name: "הכשרה לבדיקה",
    });
    await command(
      "soldier.timeline",
      {
        soldierId: actor.soldierId,
        kind: "qualification",
        value: qualification.id,
        startDate: "2026-01-01",
        endDate: "2030-12-31",
      },
      1
    );
    await db
      .update(duties)
      .set({
        data: {
          ...row.data,
          requirements: { qualificationIds: [qualification.id] },
        },
      })
      .where(eq(duties.id, row.id));
    await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      1
    );
    const input = {
      soldierId: actor.soldierId,
      kind: "qualification",
      operation: "replace",
      index: 0,
      value: qualification.id,
      startDate: "2026-01-01",
      endDate: row.data.start.slice(0, 10),
      reason: "קיצור תוקף מאומת",
    };
    const preview = await timelinePreview(manager, input, 2);
    expect(preview.impact[0]).toMatchObject({
      before: "eligible",
      after: "blocked",
    });
    expect(
      preview.impact[0].reasons.some(
        (reason) => reason.code === "qualification"
      )
    ).toBe(true);
    expect(
      (
        await db
          .select()
          .from(soldiers)
          .where(eq(soldiers.id, actor.soldierId!))
      )[0].data.qualifications[0].end
    ).toBe("2030-12-31");
    await command(
      "soldier.timeline.edit",
      { ...input, confirmed: true, previewToken: preview.previewToken },
      2
    );
    const [assigned] = await db.select().from(assignments);
    expect(assigned.status).toBe("reserved");
    expect(assigned.data.needsAttention).toContain("qualification");
    expect(assigned.data.version).toBe(assigned.version);
    expect(
      (await readState(actor)).soldiers.every(
        (person) => !("qualifications" in person)
      )
    ).toBe(true);
    expect(await db.select().from(ledger)).toHaveLength(0);
  });
  it("rejects an obsolete personnel impact preview and removes a period only once when managers compete", async () => {
    const { actor } = await fixtureDuty();
    await command(
      "soldier.timeline",
      {
        soldierId: actor.soldierId,
        kind: "inactive",
        startDate: "2029-01-01",
        endDate: "2029-01-05",
      },
      1
    );
    const input = {
      soldierId: actor.soldierId,
      kind: "inactive",
      operation: "remove",
      index: 0,
      reason: "סיום אי־פעילות",
    };
    const preview = await timelinePreview(manager, input, 2);
    await fixtureDuty();
    await expect(
      command(
        "soldier.timeline.edit",
        { ...input, confirmed: true, previewToken: preview.previewToken },
        2
      )
    ).rejects.toMatchObject({ code: "stale_preview" });
    const current = await timelinePreview(manager, input, 2);
    const outcomes = await Promise.allSettled([
      command(
        "soldier.timeline.edit",
        { ...input, confirmed: true, previewToken: current.previewToken },
        2
      ),
      command(
        "soldier.timeline.edit",
        { ...input, confirmed: true, previewToken: current.previewToken },
        2
      ),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(person.data.inactivePeriods).toHaveLength(0);
    expect(person.version).toBe(3);
    expect(
      (
        await db
          .select()
          .from(records)
          .where(eq(records.kind, "personnel_change"))
      ).filter((item) => item.data.operation === "remove")
    ).toHaveLength(1);
  });
  it("removes an exemption without discarding approved constraints and restricts both preview and catalog edits to managers", async () => {
    const { row, actor } = await fixtureDuty();
    const exemption = await command("eligibility.catalog.save", {
      kind: "exemption",
      name: "פטור סינתטי",
    });
    await command(
      "soldier.timeline",
      {
        soldierId: actor.soldierId,
        kind: "exemption",
        value: exemption.id,
        startDate: "2026-01-01",
        endDate: "2030-12-31",
      },
      1
    );
    await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      1
    );
    await db.insert(records).values({
      id: randomUUID(),
      kind: "constraint",
      subjectId: actor.soldierId,
      data: {
        approved: {
          start: row.data.start.slice(0, 10),
          end: row.data.end.slice(0, 10),
          version: 1,
        },
        status: "approved",
      },
    });
    const input = {
      soldierId: actor.soldierId,
      kind: "exemption",
      operation: "remove",
      index: 0,
      reason: "הסרה מאומתת",
    };
    await expect(timelinePreview(actor, input, 2)).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
    const preview = await timelinePreview(manager, input, 2);
    expect(
      preview.impact[0].reasons.some(
        (reason) => reason.code === "approved_constraint"
      )
    ).toBe(true);
    await command(
      "soldier.timeline.edit",
      { ...input, confirmed: true, previewToken: preview.previewToken },
      2
    );
    expect(
      (await db.select().from(assignments))[0].data.needsAttention
    ).toContain("approved_constraint");
    await command(
      "eligibility.catalog.save",
      { id: exemption.id, kind: "exemption", name: "שם פטור מעודכן" },
      1
    );
    await expect(
      command(
        "eligibility.catalog.save",
        { id: exemption.id, kind: "qualification", name: "אין שינוי סוג" },
        2
      )
    ).rejects.toMatchObject({ code: "catalog_kind" });
    await expect(
      command(
        "eligibility.catalog.save",
        { id: exemption.id, kind: "exemption", name: "עריכה ישנה" },
        1
      )
    ).rejects.toMatchObject({ code: "stale_version" });
    await expect(
      command(
        "eligibility.catalog.save",
        { id: exemption.id, kind: "exemption", name: "חייל לא עורך" },
        2,
        actor
      )
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (await db.select().from(records).where(eq(records.id, exemption.id)))[0]
        .data.name
    ).toBe("שם פטור מעודכן");
  });
  it("keeps a published duty binding until an atomic versioned update replaces its reservations", async () => {
    const { row, actor } = await publishedFixture();
    const change = await command(
      "duty.change.create",
      { dutyId: row.id, reason: "שינוי מפורש לבדיקה" },
      3
    );
    await command(
      "duty.change.save",
      {
        ...row.data,
        id: change.id,
        name: "שם מוצע בלבד",
        seats: [
          {
            slotId: row.data.slots[0].id,
            soldierId: manager.soldierId,
            extraPoints: 2,
          },
        ],
        reason: "החלפת מבצע מפורשת",
      },
      1
    );
    const before = await readState(actor);
    expect(before.duties[0].name).toBe(row.name);
    expect("dutyChanges" in before ? before.dutyChanges : []).toEqual([]);
    expect(
      before.assignments
        .filter((item) => item.status === "reserved")
        .map((item) => item.soldierId)
    ).toEqual([actor.soldierId]);
    const preview = await changePreview(change.id, 2);
    expect(preview.affected).toHaveLength(2);
    const payload = {
      id: change.id,
      confirmed: true,
      previewToken: preview.previewToken,
    };
    const outcomes = await Promise.allSettled([
      command("duty.change.publish", payload, 2),
      command("duty.change.publish", payload, 2),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    const after = await readState(actor);
    expect(after.duties[0].name).toBe("שם מוצע בלבד");
    const active = (await db.select().from(assignments)).filter(
      (item) => item.status === "reserved"
    );
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      soldierId: manager.soldierId,
      points: 6,
    });
    expect(
      (await db.select().from(balances)).every((item) => item.current === 0)
    ).toBe(true);
    expect(
      (await db.select().from(emailOutbox))
        .filter((item) => item.kind === "publication")
        .every((item) => item.status === "cancelled")
    ).toBe(true);
    expect(
      (await db.select().from(emailOutbox)).filter(
        (item) => item.kind === "publication-change"
      )
    ).toHaveLength(2);
    expect(
      await db.select().from(records).where(eq(records.kind, "duty_revision"))
    ).toHaveLength(1);
  });
  it("requires explicit removal of a blocked proposed assignment and rejects an obsolete preview", async () => {
    const { row, actor } = await publishedFixture();
    const change = await command(
      "duty.change.create",
      { dutyId: row.id, reason: "שינוי מועד לבדיקה" },
      3
    );
    const start = new Date(Date.now() + 5 * 86400_000).toISOString();
    const end = new Date(Date.now() + 6 * 86400_000).toISOString();
    const values = {
      ...row.data,
      id: change.id,
      start,
      end,
      seats: [
        {
          slotId: row.data.slots[0].id,
          soldierId: actor.soldierId,
          extraPoints: 0,
        },
      ],
      reason: "שינוי מועד מפורש",
    };
    await command("duty.change.save", values, 1);
    const preview = await changePreview(change.id, 2);
    await command(
      "soldier.timeline",
      {
        soldierId: actor.soldierId,
        kind: "inactive",
        startDate: start.slice(0, 10),
        endDate: end.slice(0, 10),
        reason: "שינוי זמינות",
      },
      1
    );
    await expect(
      command(
        "duty.change.publish",
        { id: change.id, confirmed: true, previewToken: preview.previewToken },
        2
      )
    ).rejects.toThrow("הנתונים השתנו");
    const blocked = await changePreview(change.id, 2);
    expect(blocked.checks[0].status).toBe("blocked");
    await expect(
      command(
        "duty.change.publish",
        { id: change.id, confirmed: true, previewToken: blocked.previewToken },
        2
      )
    ).rejects.toThrow("שיבוצים חסומים");
    expect(
      (await db.select().from(assignments)).filter(
        (item) => item.status === "reserved"
      )
    ).toHaveLength(1);
    await command(
      "duty.change.save",
      { ...values, seats: [{ ...values.seats[0], soldierId: null }] },
      2
    );
    const removed = await changePreview(change.id, 3);
    await command(
      "duty.change.publish",
      { id: change.id, confirmed: true, previewToken: removed.previewToken },
      3
    );
    expect(
      (await db.select().from(assignments)).filter(
        (item) => item.status === "reserved"
      )
    ).toHaveLength(0);
  });
  it("does not inherit an earlier near-release approval into a new published version", async () => {
    const { row, result } = await pendingLottery();
    await command(
      "duty.lottery.approve",
      {
        proposalId: result.proposalId,
        decision: "approve",
        reason: "אישור ראשון",
        approvalKeys: result.requirements.map((item) => item.key),
      },
      result.version
    );
    await command("duty.publish", { id: row.id, confirmed: true }, 2);
    const change = await command(
      "duty.change.create",
      { dutyId: row.id, reason: "גרסה חדשה לבדיקה" },
      3
    );
    const preview = await changePreview(change.id, 1);
    expect(preview.checks[0].requirements).toHaveLength(1);
    await expect(
      command(
        "duty.change.publish",
        { id: change.id, confirmed: true, previewToken: preview.previewToken },
        1
      )
    ).rejects.toThrow("אישור נפרד");
    await command(
      "duty.change.publish",
      {
        id: change.id,
        confirmed: true,
        previewToken: preview.previewToken,
        approvalKeys: preview.checks[0].requirements.map(
          (reason) => reason.key
        ),
      },
      1
    );
    const [active] = (await db.select().from(assignments)).filter(
      (item) => item.status === "reserved"
    );
    expect(active.data.approvals?.[0].dutyVersion).toBe(2);
  });
  it("applies updated catalog prices and composition only through an explicit proposal", async () => {
    const { row } = await publishedFixture();
    await command(
      "dutyType.save",
      {
        id: row.typeId,
        name: "מחירון מעודכן",
        pricing: { mode: "fixed", base: 9 },
        roles: [{ name: "תורן", count: 2 }],
      },
      1
    );
    const impact = (await executeAction(manager, {
      type: "dutyType.impact.preview",
      payload: { id: row.typeId },
      expectedVersion: 2,
      idempotencyKey: randomUUID(),
    })) as {
      duties: {
        afterSlots: number;
        checks: { beforePoints: number; afterPoints: number }[];
      }[];
    };
    expect(impact.duties[0].afterSlots).toBe(2);
    expect(impact.duties[0].checks[0]).toMatchObject({
      beforePoints: 4,
      afterPoints: 9,
    });
    expect(
      (await db.select().from(duties).where(eq(duties.id, row.id)))[0].data
        .slots
    ).toHaveLength(1);
    const change = await command(
      "duty.change.create",
      { dutyId: row.id, reason: "החלה מפורשת של המחירון", applyCatalog: true },
      3
    );
    expect((await db.select().from(assignments))[0].points).toBe(4);
    const preview = await changePreview(change.id, 1);
    await command(
      "duty.change.publish",
      { id: change.id, confirmed: true, previewToken: preview.previewToken },
      1
    );
    const [updated] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, row.id));
    expect(updated.data.slots).toHaveLength(2);
    expect(
      (await db.select().from(assignments)).filter(
        (item) => item.status === "reserved"
      )[0].points
    ).toBe(9);
  });
  it("imports a whole reviewed batch, preserving reservations and blank fields with documented balances", async () => {
    const { row, actor } = await fixtureDuty();
    await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      1
    );
    await db
      .update(soldierContacts)
      .set({ phone: "0500000000", address: "כתובת סינתטית" })
      .where(eq(soldierContacts.soldierId, actor.soldierId!));
    const rank = await command("rank.catalog.save", {
      name: "דרגת בדיקה",
      track: "מסלול בדיקה",
      order: 1,
      source: "סינתטי",
    });
    const preview = await command("import.preview", {
      filename: "synthetic.xlsx",
      rows: [
        {
          rowNumber: 2,
          values: {
            personalNumber: "00001",
            name: "שם מעודכן",
            currentScore: 51,
          },
        },
        {
          rowNumber: 3,
          values: {
            personalNumber: "000009",
            name: "חייל מייבוא",
            email: "import@example.invalid",
            phone: "0500000009",
            currentScore: 12,
            rankName: "דרגת בדיקה",
            rankTrack: "מסלול בדיקה",
            rankEffectiveDate: "2026-01-01",
          },
        },
      ],
    });
    expect(await db.select().from(soldiers)).toHaveLength(2);
    await expect(
      command(
        "import.apply",
        { id: preview.id, confirmed: true, reason: "קליטת בדיקה" },
        1
      )
    ).rejects.toThrow("דריסת");
    const applied = await command(
      "import.apply",
      {
        id: preview.id,
        confirmed: true,
        overwriteConfirmed: true,
        reason: "קליטת בדיקה",
      },
      1
    );
    expect(applied).toMatchObject({
      status: "applied",
      created: 1,
      updated: 1,
    });
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(person.name).toBe("שם מעודכן");
    const [contact] = await db
      .select()
      .from(soldierContacts)
      .where(eq(soldierContacts.soldierId, actor.soldierId!));
    expect(contact).toMatchObject({
      phone: "0500000000",
      address: "כתובת סינתטית",
    });
    expect(
      (
        await db
          .select()
          .from(balances)
          .where(eq(balances.soldierId, actor.soldierId!))
      )[0].current
    ).toBe(51);
    const [newPerson] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.personalNumber, "000009"));
    expect(newPerson.data.service.graceEligible).toBe(false);
    expect(newPerson.data.rankHistory[0].rankId).toBe(rank.id);
    const active = (await db.select().from(assignments)).filter(
      (item) => item.status === "reserved"
    );
    expect(active).toHaveLength(1);
    expect(active[0].points).toBe(4);
    expect(
      (await db.select().from(ledger)).map((item) => item.kind).sort()
    ).toEqual(["import_set", "opening"]);
    expect(
      (await db.select().from(user)).find(
        (item) => item.email === "import@example.invalid"
      )?.soldierId
    ).toBe(newPerson.id);
  });
  it("rejects all rows on duplicate, conflicting identities, incomplete ranks or deleted people", async () => {
    const { actor } = await fixtureDuty();
    const rows = [
      {
        rowNumber: 2,
        values: {
          personalNumber: "00001",
          name: "אסור לשמור",
          email: "changed@example.invalid",
        },
      },
      {
        rowNumber: 3,
        values: {
          personalNumber: "000009",
          name: "חדש",
          email: memberEmail,
          rankName: "חלקי",
        },
      },
      {
        rowNumber: 4,
        values: {
          personalNumber: "000009",
          name: "כפול",
          email: "new@example.invalid",
        },
      },
    ];
    await expect(
      command("import.preview", { filename: "invalid.xlsx", rows })
    ).rejects.toMatchObject({
      code: "import_errors",
      details: {
        problems: expect.arrayContaining([
          expect.objectContaining({ row: 2, field: "מייל" }),
          expect.objectContaining({ row: 3, field: "דרגה" }),
          expect.objectContaining({ row: 4, field: "מספר אישי" }),
        ]),
      },
    });
    expect(
      (
        await db
          .select()
          .from(soldiers)
          .where(eq(soldiers.id, actor.soldierId!))
      )[0].name
    ).toBe("חייל לבדיקה");
    expect(
      await db.select().from(records).where(eq(records.kind, "import"))
    ).toHaveLength(0);
    await db
      .update(soldiers)
      .set({ deletedAt: new Date() })
      .where(eq(soldiers.id, actor.soldierId!));
    await expect(
      command("import.preview", {
        filename: "deleted.xlsx",
        rows: [
          {
            rowNumber: 2,
            values: { personalNumber: "00001", name: "אסור להחיות" },
          },
        ],
      })
    ).rejects.toThrow("שגיאות");
  });
  it("tracks per-field ABA changes and rejects a stale import without changing any row", async () => {
    const { actor } = await fixtureDuty();
    const original = (
      await db.select().from(soldiers).where(eq(soldiers.id, actor.soldierId!))
    )[0];
    const preview = await command("import.preview", {
      filename: "stale.xlsx",
      rows: [
        {
          rowNumber: 2,
          values: { personalNumber: "00001", name: "ייבוא מיושן" },
        },
      ],
    });
    await db
      .update(soldiers)
      .set({ name: "שם זמני", data: { ...original.data, name: "שם זמני" } })
      .where(eq(soldiers.id, actor.soldierId!));
    await db
      .update(soldiers)
      .set({ name: original.name, data: original.data })
      .where(eq(soldiers.id, actor.soldierId!));
    const person = (
      await db.select().from(soldiers).where(eq(soldiers.id, actor.soldierId!))
    )[0];
    expect(person.fieldVersions.name).toBe(2);
    expect(person.fieldVersions["service.arrivalDate"]).toBeUndefined();
    await db
      .update(soldierContacts)
      .set({ phone: "0500000000" })
      .where(eq(soldierContacts.soldierId, actor.soldierId!));
    await db
      .update(soldierContacts)
      .set({ phone: "0500000001" })
      .where(eq(soldierContacts.soldierId, actor.soldierId!));
    await db
      .update(soldierContacts)
      .set({ phone: "0500000000" })
      .where(eq(soldierContacts.soldierId, actor.soldierId!));
    expect(
      (
        await db
          .select()
          .from(soldierContacts)
          .where(eq(soldierContacts.soldierId, actor.soldierId!))
      )[0].fieldVersions
    ).toEqual({ phone: 3 });
    await expect(
      command(
        "import.apply",
        {
          id: preview.id,
          confirmed: true,
          overwriteConfirmed: true,
          reason: "אסור לדרוס",
        },
        1
      )
    ).rejects.toThrow("השתנו");
    expect(
      (
        await db
          .select()
          .from(soldiers)
          .where(eq(soldiers.id, actor.soldierId!))
      )[0].name
    ).toBe(original.name);
  });
  it("serializes competing import approvals and returns idempotent results without duplicate ledger entries", async () => {
    const preview = await command("import.preview", {
      filename: "retry.xlsx",
      rows: [
        { rowNumber: 2, values: { personalNumber: "00001", currentScore: 10 } },
      ],
    });
    const payload = {
      id: preview.id,
      confirmed: true,
      overwriteConfirmed: true,
      reason: "אישור מקביל",
    };
    const results = await Promise.allSettled([
      command("import.apply", payload, 1),
      command("import.apply", payload, 1),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    expect(await db.select().from(ledger)).toHaveLength(1);
    const preview2 = await command("import.preview", {
      filename: "retry2.xlsx",
      rows: [
        { rowNumber: 2, values: { personalNumber: "00001", currentScore: 20 } },
      ],
    });
    const key = randomUUID();
    const result = await command(
      "import.apply",
      { ...payload, id: preview2.id },
      1,
      manager,
      key
    );
    expect(
      await command(
        "import.apply",
        { ...payload, id: preview2.id },
        1,
        manager,
        key
      )
    ).toEqual(result);
    expect(await db.select().from(ledger)).toHaveLength(2);
  });
  it("restricts import previews and history to managers", async () => {
    const { actor } = await fixtureDuty();
    const payload = {
      filename: "permissions.xlsx",
      rows: [
        { rowNumber: 2, values: { personalNumber: "00001", name: "חדש" } },
      ],
    };
    await expect(
      command("import.preview", payload, undefined, actor)
    ).rejects.toThrow("אחראי");
    await expect(
      command("import.preview", payload, undefined, technical)
    ).rejects.toThrow("אחראי");
    const preview = await command("import.preview", payload);
    await expect(
      command("import.get", { id: preview.id }, undefined, actor)
    ).rejects.toThrow("אחראי");
    expect((await readState(actor)).imports).toEqual([]);
  });
});
