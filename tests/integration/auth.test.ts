import { randomUUID } from "node:crypto";
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
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
import type { previewImportRestore } from "../../src/server/import-restores";

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
        kind: "duty-reminder",
        reminderHours: 24,
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
          kind: "duty-reminder",
          reminderHours: 24,
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
  /** Adds a period the way the UI does: preview first, then confirm it. */
  async function addPeriod(
    payload: Record<string, unknown>,
    expectedVersion?: number,
    actor = manager
  ) {
    const preview = (await command(
      "soldier.timeline.preview",
      payload,
      expectedVersion,
      actor
    )) as unknown as { previewToken: string };
    return command(
      "soldier.timeline",
      { ...payload, confirmed: true, previewToken: preview.previewToken },
      expectedVersion,
      actor
    );
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
    await addPeriod(
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
    expect(stored.data.rejected).toMatchObject({ start: endDate });
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
      // The rejected item has no version in effect, so only one cancellation.
    ).toHaveLength(4);
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
    await expect(command("round.close", { id: round.id }, 2)).rejects.toThrow(
      "כבר נסגר"
    );
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
    ).toMatchObject({
      targetStart: date,
      targetEnd: date,
      status: "open",
      reopenCount: 1,
      reopenedByName: manager.name,
    });
  });
  async function openRound(targetStart: string, targetEnd: string) {
    return command("round.create", {
      name: "סבב גבולות",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 3600_000).toISOString(),
      targetStart,
      targetEnd,
    });
  }
  async function roundConstraints(roundId: string) {
    return (
      await db.select().from(records).where(eq(records.kind, "constraint"))
    ).filter((row) => row.data.roundId === roundId);
  }
  it("records a no-constraints declaration directly as a completed submission and lets a later item replace it", async () => {
    const { row, actor } = await fixtureDuty();
    const date = row.data.start.slice(0, 10);
    const round = await openRound(date, date);
    const declared = await command(
      "constraint.submit",
      { roundId: round.id, none: true },
      undefined,
      actor
    );
    let [stored] = await roundConstraints(round.id);
    expect(stored.data).toMatchObject({ status: "declared", pending: null });
    expect(stored.data.declared).toMatchObject({ none: true, version: 1 });
    await expect(
      command("constraint.preview", { id: declared.id }, 1)
    ).rejects.toThrow("אין גרסה ממתינה");
    await expect(
      command("constraint.review", { id: declared.id, decision: "approved" }, 1)
    ).rejects.toThrow("אין גרסה ממתינה");
    const managerView = await readState(manager);
    expect(
      managerView.constraints.find((item) => item.id === declared.id)
    ).toMatchObject({ status: "declared", subjectId: actor.soldierId });
    expect(
      (await db.select().from(records).where(eq(records.kind, "audit"))).some(
        (item) =>
          item.data.action === "constraint.declare_none" &&
          item.data.targetId === declared.id
      )
    ).toBe(true);
    expect(
      (await db.select().from(records).where(eq(records.kind, "notification")))
        .length
    ).toBe(0);
    // Declaring again updates the same submission instead of adding a row.
    await command(
      "constraint.submit",
      {
        roundId: round.id,
        none: true,
        existingVersions: [{ id: declared.id, version: 1 }],
      },
      undefined,
      actor
    );
    // A new item replaces the declaration and waits for review.
    await command(
      "constraint.submit",
      {
        roundId: round.id,
        items: [{ startDate: date, endDate: date, reason: "אילוץ מאוחר" }],
      },
      undefined,
      actor
    );
    const rows = await roundConstraints(round.id);
    expect(rows).toHaveLength(1);
    [stored] = rows;
    expect(stored.id).toBe(declared.id);
    expect(stored.data).toMatchObject({
      status: "pending",
      declared: null,
      pending: { start: date, end: date },
    });
    await command(
      "constraint.review",
      { id: declared.id, decision: "rejected", reason: "ללא הצדקה" },
      stored.version
    );
    // A rejected item without an approved version has nothing to cancel.
    await expect(
      command(
        "constraint.submit",
        { id: declared.id, roundId: round.id, none: true },
        stored.version + 1,
        actor
      )
    ).rejects.toThrow("אין בפריט");
    await command(
      "constraint.submit",
      {
        roundId: round.id,
        none: true,
        existingVersions: [{ id: declared.id, version: stored.version + 1 }],
      },
      undefined,
      actor
    );
    const after = await roundConstraints(round.id);
    expect(after.map((item) => item.data.status).sort()).toEqual([
      "declared",
      "rejected",
    ]);
    expect(
      (await unitTransaction((tx) => loadDomain(tx))).soldiers.find(
        (item) => item.id === actor.soldierId
      )!.constraints
    ).toHaveLength(0);
  });
  it("rejects submissions outside the window or target period and applies whole Israel days across a clock change", async () => {
    const { actor } = await fixtureDuty();
    const zone = "Asia/Jerusalem";
    let day = DateTime.now().setZone(zone).startOf("day").plus({ days: 3 });
    while (day.plus({ days: 1 }).offset === day.offset)
      day = day.plus({ days: 1 });
    const date = day.toISODate()!;
    expect(day.plus({ days: 1 }).diff(day, "hours").hours).not.toBe(24);
    const type = await command("dutyType.save", {
      name: "גבולות יום",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 1 }],
    });
    const at = (offsetDays: number, hour: number, minute = 0) =>
      day.plus({ days: offsetDays }).set({ hour, minute }).toISO()!;
    const windows = {
      before: [at(-1, 23), at(0, 0, 30)],
      lastHour: [at(0, 23), at(1, 0)],
      nextDay: [at(1, 0), at(1, 1)],
    } as const;
    const dutyIds: Record<string, string> = {};
    for (const [name, [start, end]] of Object.entries(windows)) {
      const created = await command("duty.create", {
        typeId: type.id,
        name,
        start,
        end,
      });
      const [stored] = await db
        .select()
        .from(duties)
        .where(eq(duties.id, created.id));
      await command(
        "duty.assign",
        {
          dutyId: created.id,
          slotId: stored.data.slots[0].id,
          soldierId: actor.soldierId,
        },
        1
      );
      dutyIds[name] = created.id;
    }
    const upcoming = await command("round.create", {
      name: "טרם נפתח",
      opensAt: new Date(Date.now() + 3600_000).toISOString(),
      closesAt: new Date(Date.now() + 7200_000).toISOString(),
      targetStart: date,
      targetEnd: date,
    });
    const expired = await command("round.create", {
      name: "חלון שעבר",
      opensAt: new Date(Date.now() - 7200_000).toISOString(),
      closesAt: new Date(Date.now() - 3600_000).toISOString(),
      targetStart: date,
      targetEnd: date,
    });
    for (const roundId of [upcoming.id, expired.id])
      await expect(
        command("constraint.submit", { roundId, none: true }, undefined, actor)
      ).rejects.toThrow("אינו פתוח");
    const round = await openRound(date, date);
    const next = day.plus({ days: 1 }).toISODate()!;
    const previous = day.minus({ days: 1 }).toISODate()!;
    for (const [startDate, endDate] of [
      [date, next],
      [previous, date],
      [next, next],
    ])
      await expect(
        command(
          "constraint.submit",
          { roundId: round.id, startDate, endDate, reason: "מחוץ לתקופה" },
          undefined,
          actor
        )
      ).rejects.toThrow("תקופת היעד");
    const submitted = await command(
      "constraint.submit",
      { roundId: round.id, startDate: date, endDate: date, reason: "יום שלם" },
      undefined,
      actor
    );
    const preview = (await command(
      "constraint.preview",
      { id: submitted.id },
      1
    )) as unknown as { conflicts: { dutyId: string }[] };
    expect(preview.conflicts.map((item) => item.dutyId).sort()).toEqual(
      [dutyIds.before, dutyIds.lastHour].sort()
    );
  });
  it("lets one of two managers decide a shared constraint, shows who decided and rejects stale edits", async () => {
    const { row, actor } = await fixtureDuty();
    const second = await invite(
      "אחראי שני לבדיקה",
      "manager",
      "manager-two@example.invalid",
      "00003"
    );
    const other: Actor = {
      id: second.id,
      name: second.name,
      role: "manager",
      soldierId: second.soldierId!,
      securityEpoch: 1,
    };
    const date = row.data.start.slice(0, 10);
    const round = await openRound(date, date);
    const submitted = await command(
      "constraint.submit",
      { roundId: round.id, startDate: date, endDate: date, reason: "משותף" },
      undefined,
      actor
    );
    const results = await Promise.allSettled([
      command(
        "constraint.review",
        { id: submitted.id, decision: "approved" },
        1
      ),
      command(
        "constraint.review",
        { id: submitted.id, decision: "rejected", reason: "החלטה מקבילה" },
        1,
        other
      ),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    const failure = results.find((item) => item.status === "rejected") as
      PromiseRejectedResult | undefined;
    expect(failure?.reason).toMatchObject({ status: 409 });
    const winner = results[0].status === "fulfilled" ? manager : other;
    const [stored] = await roundConstraints(round.id);
    expect(stored.version).toBe(2);
    expect(stored.data).toMatchObject({
      decidedBy: winner.id,
      decidedByName: winner.name,
      pending: null,
    });
    for (const viewer of [manager, other])
      expect(
        (await readState(viewer)).constraints.find(
          (item) => item.id === submitted.id
        )
      ).toMatchObject({
        decidedByName: winner.name,
        status: stored.data.status,
      });
    expect(
      (
        await db.select().from(records).where(eq(records.kind, "notification"))
      ).filter((item) => item.subjectId === actor.soldierId)
    ).toHaveLength(1);
    await expect(
      command(
        "constraint.submit",
        {
          id: submitted.id,
          roundId: round.id,
          startDate: date,
          endDate: date,
          reason: "עריכה מגרסה ישנה",
        },
        1,
        actor
      )
    ).rejects.toThrow();
    await expect(
      command(
        "constraint.review",
        { id: submitted.id, decision: "approved" },
        1
      )
    ).rejects.toThrow();
  });
  it("requires a new collision approval for every pending version and never carries it into the approved version", async () => {
    const { row, actor } = await fixtureDuty();
    const startDate = row.data.start.slice(0, 10);
    const endDate = row.data.end.slice(0, 10);
    const round = await openRound(startDate, endDate);
    const submitted = await command(
      "constraint.submit",
      { roundId: round.id, startDate, endDate, reason: "גרסה ראשונה" },
      undefined,
      actor
    );
    const input = {
      dutyId: row.id,
      slotId: row.data.slots[0].id,
      soldierId: actor.soldierId,
      reviewPending: true,
    };
    const preview = await assignmentPreview(input, 1);
    expect(preview.requirements.map((item) => item.code)).toEqual([
      "pending_constraint",
    ]);
    const assigned = await command(
      "duty.assign",
      {
        ...input,
        previewToken: preview.previewToken,
        approvalKeys: preview.requirements.map((item) => item.key),
        approvalReason: "התנגשות מאושרת לגרסה הראשונה",
      },
      1
    );
    const attention = async () =>
      (
        await db
          .select()
          .from(assignments)
          .where(eq(assignments.id, assigned.id))
      )[0];
    expect((await attention()).data.needsAttention ?? []).toEqual([]);
    await command(
      "constraint.submit",
      {
        id: submitted.id,
        roundId: round.id,
        startDate,
        endDate,
        reason: "גרסה שנייה",
      },
      1,
      actor
    );
    expect((await attention()).data.needsAttention).toContain(
      "pending_constraint"
    );
    const impact = (await command(
      "constraint.preview",
      { id: submitted.id },
      2
    )) as unknown as { conflicts: { id: string }[]; impactToken: string };
    expect(impact.conflicts.map((item) => item.id)).toEqual([assigned.id]);
    await command(
      "constraint.review",
      {
        id: submitted.id,
        decision: "approved",
        impactToken: impact.impactToken,
      },
      2
    );
    const final = await attention();
    expect(final.status).toBe("reserved");
    expect(final.data.needsAttention).toContain("approved_constraint");
    expect(final.data.approvals?.[0]).toMatchObject({
      kind: "pending_constraint",
      referenceVersion: 1,
    });
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
  it("keeps responsibility a versioned screen default set by the technical account or the manager, never a permission", async () => {
    const { actor, lower } = await rankFixture();
    await command("rank.catalog.save", {
      name: "דרגה א לבדיקה",
      track: "מסלול אחר",
      order: 1,
      source: "נתוני בדיקה בלבד",
    });
    const invited = await invite(
      "אחראי קבע לבדיקה",
      "manager",
      "career-manager@example.invalid",
      "00003"
    );
    const career: Actor = {
      id: invited.id,
      name: invited.name,
      role: "manager",
      soldierId: invited.soldierId!,
      securityEpoch: 1,
    };
    expect((await readState(career)).actor).toMatchObject({
      responsibilityVersion: 1,
    });
    expect((await readState(career)).actor.responsibility).toBeUndefined();
    const set = (
      id: string,
      responsibility: string | null,
      version: number,
      by: Actor
    ) => command("account.responsibility", { id, responsibility }, version, by);
    await expect(set(career.id, "career", 1, manager)).rejects.toThrow(
      "האחראי עצמו"
    );
    await expect(set(memberId, "career", 1, technical)).rejects.toThrow(
      "לאחראי"
    );
    await expect(set(career.id, "academic", 1, technical)).rejects.toThrow();
    const race = await Promise.allSettled([
      set(career.id, "career", 1, technical),
      set(career.id, "mandatory", 1, technical),
    ]);
    expect(race.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    await expect(set(career.id, "career", 1, technical)).rejects.toThrow(
      "השתנה"
    );
    await set(career.id, "career", 2, technical);
    await set(manager.id, "mandatory", 1, manager);
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.id, career.id));
    expect(account).toMatchObject({
      responsibility: "career",
      responsibilityVersion: 3,
      securityEpoch: 1,
    });
    const [own] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, career.soldierId!));
    expect(own.data.populationHistory).toEqual([]);
    expect(own.data.service.basePopulation).toBe("mandatory");
    expect(
      (await readState(technical)).accounts.find((row) => row.id === career.id)
    ).toMatchObject({ responsibility: "career", responsibilityVersion: 3 });

    const mandatoryView = await readState(manager);
    const careerView = await readState(career);
    expect(mandatoryView.actor.responsibility).toBe("mandatory");
    expect(careerView.actor.responsibility).toBe("career");
    const ids = (view: typeof careerView) =>
      view.soldiers.map((row) => row.id).sort();
    expect(ids(careerView)).toEqual(ids(mandatoryView));
    expect(careerView.soldiers).toHaveLength(3);
    expect(
      careerView.soldiers.find((row) => row.id === actor.soldierId)
    ).toMatchObject({
      population: "mandatory",
      rankId: lower.id,
      rankTrack: "מסלול סינתטי",
      rankName: "דרגה א לבדיקה",
    });
    expect(
      careerView.soldiers.find((row) => row.id === career.soldierId)
    ).toMatchObject({ rankId: undefined });

    const [before] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    await command(
      "soldier.update",
      {
        id: actor.soldierId,
        name: "חייל חובה שנערך בידי אחראי קבע",
        personalNumber: "00001",
        population: "mandatory",
        serviceType: "mandatory",
        graceEligible: false,
      },
      before.version,
      career
    );
    const [after] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(after.name).toBe("חייל חובה שנערך בידי אחראי קבע");

    await command(
      "soldier.update",
      {
        id: career.soldierId,
        name: "אחראי קבע לבדיקה",
        personalNumber: "00003",
        population: "academic",
        serviceType: "mandatory",
        graceEligible: false,
      },
      own.version
    );
    expect((await readState(career)).actor.responsibility).toBe("career");
    await set(career.id, null, 3, career);
    expect((await readState(career)).actor).toMatchObject({
      responsibilityVersion: 4,
    });
    expect((await readState(career)).actor.responsibility).toBeUndefined();

    const soldierView = await readState(actor);
    expect(soldierView.actor).not.toHaveProperty("responsibility");
    const visible = soldierView.soldiers.find(
      (row) => row.id === actor.soldierId
    )!;
    expect(visible.rankName).toBe("דרגה א לבדיקה");
    for (const row of soldierView.soldiers)
      for (const key of ["rankId", "rankTrack", "email", "rankHistory"])
        expect(row).not.toHaveProperty(key);
    await expect(set(career.id, "career", 4, actor)).rejects.toThrow();
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
    await addPeriod(
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
    await addPeriod(
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
    await addPeriod(
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
    await addPeriod(
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
    expect(state.duties[0]).toMatchObject({
      status: "cancelled",
      wasPublished: true,
    });
    expect(state.duties[0]).not.toHaveProperty("requirements");
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
    await addPeriod(
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
    await addPeriod(
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
  type PeriodPreview = {
    previewToken: string;
    impact: {
      assignmentId: string;
      before: string;
      after: string;
      affected: boolean;
      reasons: { code: string }[];
    }[];
  };
  async function periodPreview(
    payload: Record<string, unknown>,
    version: number,
    actor = manager
  ) {
    return (await command(
      "soldier.timeline.preview",
      payload,
      version,
      actor
    )) as unknown as PeriodPreview;
  }
  it("previews a new inactivity period that touches only the last day of a duty, saves nothing until confirmation and then flags it in the same save", async () => {
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
      .update(balances)
      .set({ current: 7 })
      .where(eq(balances.soldierId, actor.soldierId!));
    const constraintId = randomUUID();
    const constraint = {
      approved: { start: "2029-06-01", end: "2029-06-02", version: 1 },
      status: "approved",
    };
    await db.insert(records).values({
      id: constraintId,
      kind: "constraint",
      subjectId: actor.soldierId,
      data: constraint,
    });
    const lastDay = DateTime.fromISO(row.data.end)
      .setZone("Asia/Jerusalem")
      .toISODate()!;
    const input = {
      soldierId: actor.soldierId,
      kind: "inactive",
      startDate: lastDay,
      endDate: lastDay,
      reason: "קורס סינתטי",
    };
    await expect(periodPreview(input, 1, actor)).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
    const preview = await periodPreview(input, 1);
    expect(preview.impact).toHaveLength(1);
    expect(preview.impact[0]).toMatchObject({
      before: "eligible",
      after: "blocked",
      affected: true,
    });
    expect(preview.impact[0].reasons.map((reason) => reason.code)).toContain(
      "inactive"
    );
    const [unchanged] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(unchanged.version).toBe(1);
    expect(unchanged.data.inactivePeriods).toHaveLength(0);
    expect(
      (await db.select().from(assignments))[0].data.needsAttention ?? []
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(records)
        .where(eq(records.kind, "personnel_change"))
    ).toHaveLength(0);
    await expect(command("soldier.timeline", input, 1)).rejects.toThrow();
    await expect(
      command(
        "soldier.timeline",
        { ...input, confirmed: false, previewToken: preview.previewToken },
        1
      )
    ).rejects.toThrow();
    await command(
      "soldier.timeline",
      { ...input, confirmed: true, previewToken: preview.previewToken },
      1
    );
    const [assigned] = await db.select().from(assignments);
    expect(assigned.status).toBe("reserved");
    expect(assigned.data.needsAttention).toContain("inactive");
    const [saved] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(saved.version).toBe(2);
    expect(saved.data.inactivePeriods).toEqual([
      { start: lastDay, end: lastDay },
    ]);
    expect(
      (
        await db
          .select()
          .from(balances)
          .where(eq(balances.soldierId, actor.soldierId!))
      )[0].current
    ).toBe(7);
    expect(
      (await db.select().from(records).where(eq(records.id, constraintId)))[0]
        .data
    ).toEqual(constraint);
    // Inactivity blocks scheduling only; the account still signs in.
    await requestCode(memberEmail);
    await expect(
      verifyCode(memberEmail, await storedCode(memberId))
    ).resolves.toMatchObject({ epoch: 1 });
  });
  it("requires exemption approval for a partial overlap, rejects an obsolete preview and saves one of two competing confirmations", async () => {
    const { row, actor } = await fixtureDuty();
    const exemption = await command("eligibility.catalog.save", {
      kind: "exemption",
      name: "פטור חדש לבדיקה",
    });
    await db
      .update(duties)
      .set({
        data: {
          ...row.data,
          requirements: { blockingExemptionIds: [exemption.id] },
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
    const firstDay = DateTime.fromISO(row.data.start)
      .setZone("Asia/Jerusalem")
      .toISODate()!;
    const input = {
      soldierId: actor.soldierId,
      kind: "exemption",
      value: exemption.id,
      startDate: "2026-01-01",
      endDate: firstDay,
    };
    const obsolete = await periodPreview(input, 1);
    expect(obsolete.impact[0]).toMatchObject({
      before: "eligible",
      affected: true,
    });
    expect(obsolete.impact[0].after).not.toBe("eligible");
    expect(obsolete.impact[0].reasons.map((reason) => reason.code)).toContain(
      "exemption"
    );
    await fixtureDuty();
    await expect(
      command(
        "soldier.timeline",
        { ...input, confirmed: true, previewToken: obsolete.previewToken },
        1
      )
    ).rejects.toMatchObject({ code: "stale_preview", status: 409 });
    const current = await periodPreview(input, 1);
    const outcomes = await Promise.allSettled([
      command(
        "soldier.timeline",
        { ...input, confirmed: true, previewToken: current.previewToken },
        1
      ),
      command(
        "soldier.timeline",
        { ...input, confirmed: true, previewToken: current.previewToken },
        1
      ),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(person.version).toBe(2);
    expect(person.data.exemptions).toHaveLength(1);
    const [assigned] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.dutyId, row.id));
    expect(assigned.status).toBe("reserved");
    expect(assigned.data.needsAttention).toContain("exemption");
    expect(
      (await readState(actor)).soldiers.every((item) => !("exemptions" in item))
    ).toBe(true);
  });
  it("counts combined qualification periods over the whole duty and clears the attention flag only when they cover it", async () => {
    const { row, actor } = await fixtureDuty();
    const qualification = await command("eligibility.catalog.save", {
      kind: "qualification",
      name: "כשירות מחולקת",
    });
    await addPeriod(
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
    const firstDay = DateTime.fromISO(row.data.start)
      .setZone("Asia/Jerusalem")
      .toISODate()!;
    const lastDay = DateTime.fromISO(row.data.end)
      .setZone("Asia/Jerusalem")
      .toISODate()!;
    const edit = {
      soldierId: actor.soldierId,
      kind: "qualification",
      operation: "replace",
      index: 0,
      value: qualification.id,
      startDate: "2026-01-01",
      endDate: DateTime.fromISO(firstDay).minus({ days: 1 }).toISODate()!,
      reason: "קיצור לבדיקה",
    };
    const shortened = await timelinePreview(manager, edit, 2);
    await command(
      "soldier.timeline.edit",
      { ...edit, confirmed: true, previewToken: shortened.previewToken },
      2
    );
    expect(
      (await db.select().from(assignments))[0].data.needsAttention
    ).toContain("qualification");
    const partial = await periodPreview(
      {
        soldierId: actor.soldierId,
        kind: "qualification",
        value: qualification.id,
        startDate: firstDay,
        endDate: firstDay,
      },
      3
    );
    expect(partial.impact[0]).toMatchObject({
      after: "blocked",
      affected: false,
    });
    const covering = {
      soldierId: actor.soldierId,
      kind: "qualification",
      value: qualification.id,
      startDate: firstDay,
      endDate: lastDay,
    };
    const preview = await periodPreview(covering, 3);
    expect(preview.impact[0]).toMatchObject({
      before: "blocked",
      after: "eligible",
      affected: true,
    });
    await command(
      "soldier.timeline",
      { ...covering, confirmed: true, previewToken: preview.previewToken },
      3
    );
    expect(
      (await db.select().from(assignments))[0].data.needsAttention
    ).toEqual([]);
  });
  it("removes an exemption without discarding approved constraints and restricts both preview and catalog edits to managers", async () => {
    const { row, actor } = await fixtureDuty();
    const exemption = await command("eligibility.catalog.save", {
      kind: "exemption",
      name: "פטור סינתטי",
    });
    await addPeriod(
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
    await addPeriod(
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
  async function importUpdate(values: Record<string, unknown>) {
    const preview = await command("import.preview", {
      filename: "restore.xlsx",
      rows: [{ rowNumber: 2, values: { personalNumber: "00001", ...values } }],
    });
    return command(
      "import.apply",
      {
        id: preview.id,
        confirmed: true,
        overwriteConfirmed: true,
        reason: "ייבוא לבדיקה",
      },
      1
    );
  }
  async function restoration(batchId: string, version = 2) {
    return (await executeAction(manager, {
      type: "import.restore.preview",
      payload: { id: batchId },
      expectedVersion: version,
      idempotencyKey: randomUUID(),
    })) as Awaited<ReturnType<typeof previewImportRestore>>;
  }
  it("restores unchanged imported fields while preserving later edits and reservations", async () => {
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
    const batch = await importUpdate({
      name: "שם מהייבוא",
      phone: "0500000007",
      currentScore: 20,
    });
    await db
      .update(soldierContacts)
      .set({ address: "כתובת שנערכה אחר כך" })
      .where(eq(soldierContacts.soldierId, actor.soldierId!));
    const preview = await restoration(batch.id);
    expect(
      preview.rows[0].fields.every((field) => field.status === "automatic")
    ).toBe(true);
    const result = await command(
      "import.restore",
      {
        id: batch.id,
        token: preview.token,
        confirmed: true,
        reason: "ביטול ייבוא שגוי",
      },
      2
    );
    expect(result).toMatchObject({ status: "restored", version: 3 });
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(person.name).toBe("חייל לבדיקה");
    expect(
      (
        await db
          .select()
          .from(soldierContacts)
          .where(eq(soldierContacts.soldierId, person.id))
      )[0]
    ).toMatchObject({ phone: null, address: "כתובת שנערכה אחר כך" });
    expect(
      (
        await db
          .select()
          .from(balances)
          .where(eq(balances.soldierId, person.id))
      )[0].current
    ).toBe(0);
    expect(
      (await db.select().from(assignments)).filter(
        (item) => item.status === "reserved"
      )[0].points
    ).toBe(4);
    expect((await db.select().from(ledger)).map((item) => item.kind)).toEqual([
      "import_set",
      "import_restore",
    ]);
  });
  it("requires a decision after a field changes and returns to the imported value", async () => {
    const { actor } = await fixtureDuty();
    const batch = await importUpdate({ phone: "0500000007", name: "שם מיובא" });
    await db
      .update(soldierContacts)
      .set({ phone: "0500000008" })
      .where(eq(soldierContacts.soldierId, actor.soldierId!));
    await db
      .update(soldierContacts)
      .set({ phone: "0500000007" })
      .where(eq(soldierContacts.soldierId, actor.soldierId!));
    const preview = await restoration(batch.id);
    const field = preview.rows[0].fields.find(
      (field) => field.key === "phone"
    )!;
    expect(field.status).toBe("conflict");
    await expect(
      command(
        "import.restore",
        {
          id: batch.id,
          token: preview.token,
          confirmed: true,
          reason: "ללא הכרעה",
        },
        2
      )
    ).rejects.toThrow("להכריע");
    await command(
      "import.restore",
      {
        id: batch.id,
        token: preview.token,
        confirmed: true,
        reason: "להשאיר טלפון עדכני",
        decisions: [
          { rowId: preview.rows[0].id, key: "phone", action: "keep" },
        ],
      },
      2
    );
    expect(
      (
        await db
          .select()
          .from(soldierContacts)
          .where(eq(soldierContacts.soldierId, actor.soldierId!))
      )[0].phone
    ).toBe("0500000007");
    expect(
      (
        await db
          .select()
          .from(soldiers)
          .where(eq(soldiers.id, actor.soldierId!))
      )[0].name
    ).toBe("חייל לבדיקה");
  });
  it("requires explicit balance resolution after performance, preserves its ledger and applies once in a race", async () => {
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
    const batch = await importUpdate({ currentScore: 20 });
    await db
      .update(duties)
      .set({
        data: {
          ...row.data,
          status: "published",
          start: new Date(Date.now() - 2 * 86400000).toISOString(),
          end: new Date(Date.now() - 86400000).toISOString(),
        },
      })
      .where(eq(duties.id, row.id));
    const preview = await restoration(batch.id);
    expect(preview.rows[0].fields[0]).toMatchObject({
      status: "conflict",
      current: 24,
    });
    await expect(
      command(
        "import.restore",
        {
          id: batch.id,
          token: preview.token,
          confirmed: true,
          reason: "אין קביעה",
          decisions: [
            {
              rowId: preview.rows[0].id,
              key: "currentScore",
              action: "restore",
            },
          ],
        },
        2
      )
    ).rejects.toThrow("מפורשת");
    const payload = {
      id: batch.id,
      token: preview.token,
      confirmed: true,
      reason: "שומרים ביצוע חדש",
      decisions: [
        {
          rowId: preview.rows[0].id,
          key: "currentScore",
          action: "set_score",
          value: 4,
        },
      ],
    };
    const key = randomUUID();
    const competing = await Promise.allSettled([
      command("import.restore", payload, 2, manager, key),
      command("import.restore", payload, 2),
    ]);
    expect(
      competing.filter((item) => item.status === "fulfilled")
    ).toHaveLength(1);
    if (competing[0].status === "fulfilled")
      expect(await command("import.restore", payload, 2, manager, key)).toEqual(
        competing[0].value
      );
    expect(
      (
        await db
          .select()
          .from(balances)
          .where(eq(balances.soldierId, actor.soldierId!))
      )[0].current
    ).toBe(4);
    const entries = await db.select().from(ledger);
    expect(entries.find((entry) => entry.kind === "performance")?.amount).toBe(
      4
    );
    expect(
      entries.filter((entry) => entry.kind === "import_restore")
    ).toHaveLength(1);
    expect((await db.select().from(assignments))[0].status).toBe("credited");
  });
  it("restores the imported rank change without removing a later rank-history entry", async () => {
    const { actor } = await fixtureDuty();
    const first = await command("rank.catalog.save", {
      name: "ראשונה",
      track: "מסלול",
      order: 1,
      source: "סינתטי",
    });
    const second = await command("rank.catalog.save", {
      name: "שנייה",
      track: "מסלול",
      order: 2,
      source: "סינתטי",
    });
    const third = await command("rank.catalog.save", {
      name: "שלישית",
      track: "מסלול",
      order: 3,
      source: "סינתטי",
    });
    await command(
      "rank.set",
      {
        soldierId: actor.soldierId,
        rankId: first.id,
        effectiveDate: "2026-01-01",
        reason: "מקור",
      },
      1
    );
    const batch = await importUpdate({
      rankName: "שנייה",
      rankTrack: "מסלול",
      rankEffectiveDate: "2026-01-01",
    });
    await command(
      "rank.set",
      {
        soldierId: actor.soldierId,
        rankId: third.id,
        effectiveDate: "2026-06-01",
        reason: "עבודה מאוחרת",
      },
      3
    );
    const preview = await restoration(batch.id);
    expect(preview.rows[0].fields[0].status).toBe("conflict");
    await command(
      "import.restore",
      {
        id: batch.id,
        token: preview.token,
        confirmed: true,
        reason: "תיקון הייבוא בלבד",
        decisions: [
          { rowId: preview.rows[0].id, key: "rankHistory", action: "restore" },
        ],
      },
      2
    );
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(person.data.rankHistory.map((rank) => rank.rankId)).toEqual([
      first.id,
      third.id,
    ]);
    expect(
      person.data.rankHistory.some((rank) => rank.rankId === second.id)
    ).toBe(false);
  });
  it("rejects a stale restore and never reintroduces erased contact data", async () => {
    const { actor } = await fixtureDuty();
    const batch = await importUpdate({
      phone: "0500000007",
      name: "שם מהייבוא",
    });
    const preview = await restoration(batch.id);
    await db
      .update(soldierContacts)
      .set({ address: "שינוי מקביל" })
      .where(eq(soldierContacts.soldierId, actor.soldierId!));
    await expect(
      command(
        "import.restore",
        {
          id: batch.id,
          token: preview.token,
          confirmed: true,
          reason: "תמונה ישנה",
        },
        2
      )
    ).rejects.toThrow("השתנו");
    await db
      .update(soldiers)
      .set({ deletedAt: new Date() })
      .where(eq(soldiers.id, actor.soldierId!));
    await db
      .delete(soldierContacts)
      .where(eq(soldierContacts.soldierId, actor.soldierId!));
    const erasedPreview = await restoration(batch.id);
    expect(
      erasedPreview.rows[0].fields.every(
        (field) =>
          field.status === "erased" &&
          field.before === null &&
          field.after === null
      )
    ).toBe(true);
    await command(
      "import.restore",
      {
        id: batch.id,
        token: erasedPreview.token,
        confirmed: true,
        reason: "לא משחזרים מידע שנמחק",
      },
      2
    );
    expect(
      await db
        .select()
        .from(soldierContacts)
        .where(eq(soldierContacts.soldierId, actor.soldierId!))
    ).toHaveLength(0);
    const viewed = await command("import.get", { id: batch.id });
    expect(JSON.stringify(viewed)).not.toContain("0500000007");
  });
});

describe("past performance corrections", () => {
  async function run(
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
    })) as Record<string, unknown> & { id: string; version: number };
  }
  async function balance(soldierId: string) {
    return (
      await db.select().from(balances).where(eq(balances.soldierId, soldierId))
    )[0].current;
  }
  async function member() {
    const [row] = await db.select().from(user).where(eq(user.id, memberId));
    return {
      id: row.id,
      name: row.name,
      role: "soldier",
      soldierId: row.soldierId!,
      securityEpoch: row.securityEpoch,
    } satisfies Actor;
  }
  async function adjust(
    soldierIds: string[],
    operation: string,
    value: number,
    reason: string
  ) {
    const input = { soldierIds, operation, value, reason };
    const preview = await run("score.preview", input);
    await run("score.apply", { ...input, token: preview.token });
  }
  /** A published four-point duty that ended yesterday and was credited to the soldier. */
  async function credited(soldierId: string) {
    const type = await run("dutyType.save", {
      name: "שמירה סינתטית",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 1 }],
    });
    const created = await run("duty.create", {
      typeId: type.id,
      name: "תורנות עבר לתיקון",
      start: new Date(Date.now() + 86_400_000).toISOString(),
      end: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    });
    const [row] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, created.id));
    await run(
      "duty.assign",
      { dutyId: row.id, slotId: row.data.slots[0].id, soldierId },
      1
    );
    await run("duty.publish", { id: row.id, confirmed: true }, 2);
    const [published] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, row.id));
    const start = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const end = new Date(Date.now() - 86_400_000).toISOString();
    await db
      .update(duties)
      .set({ data: { ...published.data, start, end } })
      .where(eq(duties.id, row.id));
    await unitTransaction((tx) => settleDue(tx));
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.dutyId, row.id));
    expect(assignment.status).toBe("credited");
    return { dutyId: row.id, assignment, start, end };
  }

  it("previews and applies a value correction once, keeping the draw value and hiding reasons from soldiers", async () => {
    const soldier = await member();
    const { dutyId, assignment, start, end } = await credited(
      soldier.soldierId
    );
    await adjust([soldier.soldierId], "add", 3, "תוספת שאינה משנה משמעות");
    const input = {
      assignmentId: assignment.id,
      start,
      end,
      points: 6,
      reason: "הביצוע נמשך יותר מהמתוכנן",
    };
    await expect(
      run("performance.correction.preview", input, assignment.version, soldier)
    ).rejects.toMatchObject({ status: 403 });
    const preview = await run(
      "performance.correction.preview",
      input,
      assignment.version
    );
    expect(preview).toMatchObject({
      drawPoints: 4,
      current: { performerId: soldier.soldierId, points: 4 },
      proposed: { points: 6 },
      computedPoints: 4,
      manual: true,
    });
    expect(preview.effects).toMatchObject([
      {
        soldierId: soldier.soldierId,
        historyBefore: 4,
        historyAfter: 6,
        balance: 7,
        status: "automatic",
        delta: 2,
        after: 9,
      },
    ]);
    const key = randomUUID();
    const payload = { ...input, token: preview.token };
    const first = await run(
      "performance.correction.apply",
      payload,
      assignment.version,
      manager,
      key
    );
    expect(
      await run(
        "performance.correction.apply",
        payload,
        assignment.version,
        manager,
        key
      )
    ).toEqual(first);
    await expect(
      run("performance.correction.apply", payload, assignment.version)
    ).rejects.toMatchObject({ status: 409 });
    expect(await balance(soldier.soldierId)).toBe(9);
    const corrections = (await db.select().from(ledger)).filter(
      (row) => row.kind === "correction"
    );
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({
      amount: 2,
      reason: input.reason,
      data: { historyBefore: 4, historyAfter: 6, barrier: false },
    });
    expect(corrections[0].effectiveAt.getTime()).toBeGreaterThan(
      new Date(end).getTime()
    );
    const [saved] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignment.id));
    expect(saved.points).toBe(4);
    expect(saved.data.performance).toMatchObject({
      points: 6,
      reflected: { [soldier.soldierId]: 6 },
      corrections: 1,
    });
    await expect(
      run(
        "performance.correction.preview",
        { ...input, points: 6 },
        saved.version
      )
    ).rejects.toMatchObject({ code: "no_change" });
    const visible = await readState(soldier);
    const own = visible.assignments.find((row) => row.id === assignment.id);
    expect(own).toMatchObject({ points: 4, performance: { points: 6 } });
    expect(JSON.stringify(visible)).not.toContain(input.reason.slice(0, 10));
    expect(visible.performanceCorrections).toEqual([]);
    const managed = await readState(manager);
    expect(managed.performanceCorrections).toHaveLength(1);
    expect(
      (await db.select().from(records)).filter(
        (row) =>
          row.kind === "audit" && row.data.action === "performance.correct"
      )
    ).toHaveLength(1);
    const [duty] = await db.select().from(duties).where(eq(duties.id, dutyId));
    expect(duty.data.end).toBe(end);
  });

  it("records the history but leaves the balance for a manager decision after a normalization, even when the corrected end moves past it", async () => {
    const soldier = await member();
    const { assignment, start, end } = await credited(soldier.soldierId);
    await adjust(
      [soldier.soldierId, manager.soldierId!],
      "percent",
      50,
      "נרמול סינתטי"
    );
    expect(await balance(soldier.soldierId)).toBe(2);
    const input = {
      assignmentId: assignment.id,
      start,
      end: new Date(Date.now() - 60_000).toISOString(),
      points: 8,
      reason: "הביצוע הסתיים מאוחר מהרישום",
    };
    const preview = await run(
      "performance.correction.preview",
      input,
      assignment.version
    );
    expect(preview.effects).toMatchObject([
      { status: "decision_required", rawDelta: 4, balance: 2 },
    ]);
    expect(
      (preview.effects as { barriers: { kind: string }[] }[])[0].barriers
    ).toMatchObject([{ kind: "normalization" }]);
    const applied = await run(
      "performance.correction.apply",
      { ...input, token: preview.token },
      assignment.version
    );
    expect(applied.outcomes).toMatchObject([{ status: "decision_required" }]);
    expect(await balance(soldier.soldierId)).toBe(2);
    const second = {
      ...input,
      end,
      points: 5,
      reason: "תיקון נוסף לאותו ביצוע",
    };
    const again = await run(
      "performance.correction.preview",
      second,
      applied.version
    );
    await run(
      "performance.correction.apply",
      { ...second, token: again.token },
      applied.version
    );
    expect(await balance(soldier.soldierId)).toBe(2);
    const decisions = (await db.select().from(records)).filter(
      (row) => row.kind === "score_decision"
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0].data).toMatchObject({
      status: "pending",
      historyPoints: 5,
      reflectedPoints: 4,
      rawDelta: 1,
    });
    expect(decisions[0].data.correctionIds).toHaveLength(2);
    expect(
      (await db.select().from(ledger)).filter(
        (row) => row.kind === "correction"
      )
    ).toHaveLength(0);
    const notices = (await readState(manager)).notifications;
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({
      title: "תיקון ביצוע ממתין להכרעת ניקוד",
    });
  });

  it("checks each performer separately on a performer change and reports eligibility findings without blocking", async () => {
    const soldier = await member();
    const other = await invite(
      "מבצע בפועל",
      "soldier",
      "performer@example.invalid",
      "00003"
    );
    const { assignment, start, end } = await credited(soldier.soldierId);
    await adjust([other.soldierId!], "set", 10, "קביעת יתרה לפני התיקון");
    await db
      .update(soldiers)
      .set({
        data: {
          ...(
            await db
              .select()
              .from(soldiers)
              .where(eq(soldiers.id, other.soldierId!))
          )[0].data,
          inactivePeriods: [
            {
              start: new Date(Date.now() - 5 * 86_400_000)
                .toISOString()
                .slice(0, 10),
              end: new Date(Date.now()).toISOString().slice(0, 10),
            },
          ],
        },
      })
      .where(eq(soldiers.id, other.soldierId!));
    const input = {
      assignmentId: assignment.id,
      performerId: other.soldierId,
      start,
      end,
      reason: "בפועל ביצע חייל אחר",
    };
    const preview = await run(
      "performance.correction.preview",
      input,
      assignment.version
    );
    expect(
      (preview.findings as unknown[]).length,
      JSON.stringify(preview.findings)
    ).toBeGreaterThan(0);
    const effects = preview.effects as {
      soldierId: string;
      status: string;
      delta?: number;
    }[];
    expect(
      effects.find((row) => row.soldierId === soldier.soldierId)
    ).toMatchObject({ status: "automatic", delta: -4 });
    expect(
      effects.find((row) => row.soldierId === other.soldierId)
    ).toMatchObject({ status: "decision_required" });
    const applied = await run(
      "performance.correction.apply",
      { ...input, token: preview.token },
      assignment.version
    );
    expect(await balance(soldier.soldierId)).toBe(0);
    expect(await balance(other.soldierId!)).toBe(10);
    const [saved] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignment.id));
    expect(saved.soldierId).toBe(soldier.soldierId);
    expect(saved.data.performance).toMatchObject({
      performerId: other.soldierId,
      points: 4,
      reflected: {},
    });
    expect(applied.outcomes).toHaveLength(2);
  });

  it("applies a correction to zero with a floor, then treats that clamp as a barrier", async () => {
    const soldier = await member();
    const { assignment, start, end } = await credited(soldier.soldierId);
    await adjust([soldier.soldierId], "subtract", 3, "הפחתה רגילה");
    expect(await balance(soldier.soldierId)).toBe(1);
    const zero = {
      assignmentId: assignment.id,
      start,
      end,
      points: 0,
      reason: "התורנות לא בוצעה בפועל",
    };
    const preview = await run(
      "performance.correction.preview",
      zero,
      assignment.version
    );
    expect(preview.effects).toMatchObject([
      { status: "automatic", delta: -1, after: 0, clamped: true },
    ]);
    const applied = await run(
      "performance.correction.apply",
      { ...zero, token: preview.token },
      assignment.version
    );
    expect(await balance(soldier.soldierId)).toBe(0);
    const restore = { ...zero, points: 4, reason: "הביצוע אומת מחדש" };
    const next = await run(
      "performance.correction.preview",
      restore,
      applied.version
    );
    expect(next.effects).toMatchObject([
      { status: "decision_required", rawDelta: 4 },
    ]);
  });

  it("rejects future, uncredited and stale corrections and lets only one of two competing managers apply", async () => {
    const soldier = await member();
    const { assignment, start, end } = await credited(soldier.soldierId);
    await expect(
      run(
        "performance.correction.preview",
        {
          assignmentId: assignment.id,
          start,
          end: new Date(Date.now() + 3_600_000).toISOString(),
          reason: "סיום עתידי",
        },
        assignment.version
      )
    ).rejects.toMatchObject({ code: "future_performance" });
    const base = { assignmentId: assignment.id, start, end };
    const first = { ...base, points: 5, reason: "תיקון ראשון" };
    const second = { ...base, points: 7, reason: "תיקון שני" };
    const [a, b] = await Promise.all([
      run("performance.correction.preview", first, assignment.version),
      run("performance.correction.preview", second, assignment.version),
    ]);
    const results = await Promise.allSettled([
      run(
        "performance.correction.apply",
        { ...first, token: a.token },
        assignment.version
      ),
      run(
        "performance.correction.apply",
        { ...second, token: b.token },
        assignment.version
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      (await db.select().from(ledger)).filter(
        (row) => row.kind === "correction"
      )
    ).toHaveLength(1);
    expect([5, 7]).toContain(await balance(soldier.soldierId));
    const [current] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignment.id));
    const repeat = await run(
      "performance.correction.preview",
      { ...base, points: 1, reason: "בדיקת תצוגה מיושנת" },
      current.version
    );
    await adjust([soldier.soldierId], "add", 1, "שינוי מקביל ביתרה");
    await expect(
      run(
        "performance.correction.apply",
        {
          ...base,
          points: 1,
          reason: "בדיקת תצוגה מיושנת",
          token: repeat.token,
        },
        current.version
      )
    ).rejects.toMatchObject({ code: "stale_preview" });
  });
});
describe("gender, capability and personal hours conditions", () => {
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
  type ConditionsPreview = {
    previewToken: string;
    impact: {
      assignmentId: string;
      before: string;
      after: string;
      affected: boolean;
      reasons: { code: string; referenceId?: string }[];
    }[];
  };
  const previewConditions = async (
    payload: Record<string, unknown>,
    version: number,
    actor = manager
  ) =>
    (await command(
      "soldier.conditions.preview",
      payload,
      version,
      actor
    )) as unknown as ConditionsPreview;
  async function saveConditions(
    payload: Record<string, unknown>,
    version: number
  ) {
    const preview = await previewConditions(payload, version);
    return command(
      "soldier.conditions",
      { ...payload, confirmed: true, previewToken: preview.previewToken },
      version
    );
  }
  async function member() {
    const [row] = await db.select().from(user).where(eq(user.id, memberId));
    const actor: Actor = {
      id: row.id,
      name: row.name,
      role: "soldier",
      soldierId: row.soldierId!,
      securityEpoch: row.securityEpoch,
    };
    return actor;
  }
  /** A local Israeli date a few days ahead, away from any clock change today. */
  const day = (offset = 3) =>
    DateTime.now()
      .setZone("Asia/Jerusalem")
      .plus({ days: offset })
      .toISODate()!;
  async function localDuty(
    typeId: string,
    start: string,
    end: string,
    name = "תורנות תנאים"
  ) {
    const created = await command("duty.create", { typeId, name, start, end });
    return (await db.select().from(duties).where(eq(duties.id, created.id)))[0];
  }
  const plainType = () =>
    command("dutyType.save", {
      name: "תורנות שעות",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 1 }],
    });

  it("saves a gender change only after a current confirmed preview, flags the assignment in the same save and hides conditions from soldiers", async () => {
    const actor = await member();
    const capability = await command("eligibility.catalog.save", {
      kind: "capability",
      name: "נשיאת משקל",
    });
    const type = await command("dutyType.save", {
      name: "תורנות מותנית",
      pricing: { mode: "fixed", base: 4 },
      genders: ["female"],
      capabilityIds: [capability.id],
      roles: [{ name: "תורנית", count: 1 }],
    });
    const row = await localDuty(type.id, `${day()}T08:00`, `${day()}T16:00`);
    expect(row.data.requirements).toMatchObject({
      genders: ["female"],
      capabilityIds: [capability.id],
    });
    const blocked = (await command(
      "duty.assignment.preview",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      row.version
    )) as unknown as { status: string; blockers: { code: string }[] };
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockers.map((item) => item.code).sort()).toEqual([
      "capability",
      "gender",
    ]);
    const base = {
      soldierId: actor.soldierId,
      gender: "female",
      capabilityIds: [capability.id],
    };
    await expect(previewConditions(base, 1, actor)).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
    await saveConditions(base, 1);
    await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      row.version
    );
    await db
      .update(balances)
      .set({ current: 9 })
      .where(eq(balances.soldierId, actor.soldierId!));
    const change = { ...base, gender: "male", reason: "תיקון נתון" };
    const preview = await previewConditions(change, 2);
    expect(preview.impact).toHaveLength(1);
    expect(preview.impact[0]).toMatchObject({
      before: "eligible",
      after: "blocked",
      affected: true,
    });
    expect(preview.impact[0].reasons.map((item) => item.code)).toEqual([
      "gender",
    ]);
    const [unchanged] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(unchanged).toMatchObject({ version: 2 });
    expect(unchanged.data.gender).toBe("female");
    await expect(command("soldier.conditions", change, 2)).rejects.toThrow();
    await expect(
      command(
        "soldier.conditions",
        { ...change, confirmed: false, previewToken: preview.previewToken },
        2
      )
    ).rejects.toThrow();
    const saved = await command(
      "soldier.conditions",
      { ...change, confirmed: true, previewToken: preview.previewToken },
      2
    );
    expect(saved).toMatchObject({ version: 3, flagged: 1 });
    const [assigned] = await db.select().from(assignments);
    expect(assigned.status).toBe("reserved");
    expect(assigned.data.needsAttention).toEqual(["gender"]);
    expect(
      (
        await db
          .select()
          .from(balances)
          .where(eq(balances.soldierId, actor.soldierId!))
      )[0].current
    ).toBe(9);
    const changes = await db
      .select()
      .from(records)
      .where(
        and(
          eq(records.kind, "personnel_change"),
          eq(records.subjectId, actor.soldierId!)
        )
      );
    expect(changes.map((item) => item.data.kind)).toEqual([
      "conditions",
      "conditions",
    ]);
    expect(
      changes.find((item) => item.data.reason === "תיקון נתון")!.data
    ).toMatchObject({
      before: { gender: "female" },
      after: { gender: "male", capabilities: [capability.id] },
    });
    const visible = JSON.stringify((await readState(actor)).soldiers);
    for (const key of ["gender", "capabilities", "allowedHours"])
      expect(visible).not.toContain(key);
    const managed = (await readState(manager)).soldiers.find(
      (item) => item.id === actor.soldierId
    ) as Record<string, unknown>;
    expect(managed).toMatchObject({
      gender: "male",
      capabilities: [capability.id],
    });
  });

  it("validates condition input and catalog references on the server", async () => {
    const actor = await member();
    const qualification = await command("eligibility.catalog.save", {
      kind: "qualification",
      name: "כשירות ולא יכולת",
    });
    const exemption = await command("eligibility.catalog.save", {
      kind: "exemption",
      name: "פטור ולא יכולת",
    });
    const limit = {
      start: day(),
      end: day(10),
      windows: [{ startTime: "08:00", endTime: "17:00", weekdays: [7, 1] }],
    };
    const soldierId = actor.soldierId;
    await expect(
      previewConditions({ soldierId, capabilityIds: [qualification.id] }, 1)
    ).rejects.toMatchObject({ code: "catalog_kind" });
    await expect(
      previewConditions(
        { soldierId, allowedHours: [{ ...limit, start: day(10), end: day() }] },
        1
      )
    ).rejects.toMatchObject({ code: "date_range" });
    await expect(
      previewConditions(
        { soldierId, allowedHours: [{ ...limit, id: randomUUID() }] },
        1
      )
    ).rejects.toMatchObject({ code: "not_found" });
    for (const invalid of [
      { allowedHours: [{ ...limit, windows: [] }] },
      {
        allowedHours: [
          { ...limit, windows: [{ ...limit.windows[0], startTime: "25:00" }] },
        ],
      },
      {
        allowedHours: [
          { ...limit, windows: [{ ...limit.windows[0], weekdays: [0] }] },
        ],
      },
      { gender: "unknown" },
    ])
      await expect(
        previewConditions({ soldierId, ...invalid }, 1)
      ).rejects.toThrow();
    await expect(previewConditions({ soldierId }, 1)).rejects.toMatchObject({
      code: "no_change",
    });
    await expect(
      previewConditions({ soldierId, gender: "other" }, 7)
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      command("dutyType.save", {
        name: "יכולת שגויה",
        pricing: { mode: "fixed", base: 4 },
        capabilityIds: [exemption.id],
        roles: [{ name: "תורן", count: 1 }],
      })
    ).rejects.toMatchObject({ code: "invalid_requirement" });
    await expect(
      command("dutyType.save", {
        name: "מגדר שגוי",
        pricing: { mode: "fixed", base: 4 },
        roles: [
          { name: "תורן", count: 1, requirements: { genders: ["unknown"] } },
        ],
      })
    ).rejects.toThrow();
    const saved = await saveConditions({ soldierId, allowedHours: [limit] }, 1);
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, saved.id));
    expect(person.data.allowedHours).toEqual([
      {
        ...limit,
        id: expect.any(String),
        windows: [{ ...limit.windows[0], weekdays: [1, 7] }],
      },
    ]);
    // Keeping the stored id edits the same limit instead of replacing it.
    const id = person.data.allowedHours![0].id;
    await saveConditions(
      { soldierId, allowedHours: [{ ...limit, id, end: day(12) }] },
      2
    );
    expect(
      (await db.select().from(soldiers).where(eq(soldiers.id, soldierId!)))[0]
        .data.allowedHours
    ).toMatchObject([{ id, end: day(12) }]);
  });

  it("rejects a stale conditions preview and saves only one of two competing confirmations", async () => {
    const actor = await member();
    const type = await plainType();
    const row = await localDuty(type.id, `${day()}T18:00`, `${day()}T23:00`);
    const input = {
      soldierId: actor.soldierId,
      allowedHours: [
        {
          start: day(),
          end: day(),
          windows: [
            {
              startTime: "08:00",
              endTime: "17:00",
              weekdays: [1, 2, 3, 4, 5, 6, 7],
            },
          ],
        },
      ],
    };
    const obsolete = await previewConditions(input, 1);
    expect(obsolete.impact).toEqual([]);
    await command(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: actor.soldierId,
      },
      row.version
    );
    await expect(
      command(
        "soldier.conditions",
        { ...input, confirmed: true, previewToken: obsolete.previewToken },
        1
      )
    ).rejects.toMatchObject({ code: "stale_preview", status: 409 });
    const current = await previewConditions(input, 1);
    expect(current.impact[0]).toMatchObject({
      before: "eligible",
      after: "approval_required",
      affected: true,
    });
    const outcomes = await Promise.allSettled(
      [0, 1].map(() =>
        command(
          "soldier.conditions",
          { ...input, confirmed: true, previewToken: current.previewToken },
          1
        )
      )
    );
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    expect(person.version).toBe(2);
    expect(person.data.allowedHours).toHaveLength(1);
    const [assigned] = await db.select().from(assignments);
    expect(assigned.status).toBe("reserved");
    expect(assigned.data.needsAttention).toEqual(["allowed_hours"]);
  });

  it("checks personal hours over a night in Israeli time, keeps them out of the lottery and allows only a justified manual exception", async () => {
    const actor = await member();
    const type = await plainType();
    const night = await localDuty(
      type.id,
      `${day()}T23:00`,
      `${day(4)}T05:00`,
      "לילה בתוך החלון"
    );
    const evening = await localDuty(
      type.id,
      `${day(5)}T20:00`,
      `${day(6)}T02:00`,
      "ערב שחורג מהחלון"
    );
    await saveConditions(
      {
        soldierId: actor.soldierId,
        allowedHours: [
          {
            start: day(),
            end: day(6),
            windows: [
              {
                startTime: "22:00",
                endTime: "06:00",
                weekdays: [1, 2, 3, 4, 5, 6, 7],
              },
            ],
          },
        ],
      },
      1
    );
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, actor.soldierId!));
    const limitId = person.data.allowedHours![0].id;
    const preview = async (row: typeof night) =>
      (await command(
        "duty.assignment.preview",
        {
          dutyId: row.id,
          slotId: row.data.slots[0].id,
          soldierId: actor.soldierId,
        },
        (await db.select().from(duties).where(eq(duties.id, row.id)))[0].version
      )) as unknown as {
        status: string;
        previewToken: string;
        requirements: { key: string; code: string; referenceId?: string }[];
      };
    expect((await preview(night)).status).toBe("eligible");
    const outside = await preview(evening);
    expect(outside.status).toBe("approval_required");
    expect(outside.requirements).toMatchObject([
      { code: "allowed_hours", referenceId: limitId },
    ]);
    // The lottery picks the only candidate without a blocking limit.
    await db
      .update(balances)
      .set({ current: 100 })
      .where(eq(balances.soldierId, manager.soldierId!));
    const drawn = (await command(
      "duty.lottery",
      { dutyId: evening.id, slotId: evening.data.slots[0].id },
      evening.version
    )) as unknown as { candidateId: string };
    expect(drawn.candidateId).toBe(manager.soldierId);
    const other = await localDuty(
      type.id,
      `${day(5)}T20:00`,
      `${day(6)}T02:00`,
      "ערב נוסף"
    );
    const assignInput = {
      dutyId: other.id,
      slotId: other.data.slots[0].id,
      soldierId: actor.soldierId,
    };
    const checked = await preview(other);
    await expect(
      command(
        "duty.assign",
        { ...assignInput, previewToken: checked.previewToken },
        other.version
      )
    ).rejects.toMatchObject({ code: "approval_required" });
    await command(
      "duty.assign",
      {
        ...assignInput,
        previewToken: checked.previewToken,
        approvalKeys: checked.requirements.map((item) => item.key),
        approvalReason: "אושר חריג שעות נקודתי",
      },
      other.version
    );
    const [assigned] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.dutyId, other.id));
    expect(assigned.status).toBe("reserved");
    expect(assigned.data.approvals).toMatchObject([
      {
        kind: "allowed_hours",
        referenceId: limitId,
        reason: "אושר חריג שעות נקודתי",
        approvedBy: manager.id,
      },
    ]);
    expect(
      (
        await db
          .select()
          .from(soldiers)
          .where(eq(soldiers.id, actor.soldierId!))
      )[0].data.allowedHours
    ).toEqual(person.data.allowedHours);
  });

  it("snapshots role conditions into a duty and keeps them when the catalog changes later", async () => {
    const capability = await command("eligibility.catalog.save", {
      kind: "capability",
      name: "נהיגה",
    });
    const roles = [
      {
        name: "נהג",
        count: 1,
        requirements: {
          genders: ["female", "other"],
          capabilityIds: [capability.id],
        },
      },
      { name: "מלווה", count: 1 },
    ];
    const type = await command("dutyType.save", {
      name: "סיור",
      pricing: { mode: "fixed", base: 4 },
      roles,
    });
    const row = await localDuty(type.id, `${day()}T08:00`, `${day()}T12:00`);
    expect(row.data.slots.map((slot) => slot.requirements)).toEqual([
      roles[0].requirements,
      undefined,
    ]);
    const [catalogRow] = await db
      .select()
      .from(records)
      .where(eq(records.id, capability.id));
    expect(catalogRow.data.kind).toBe("capability");
    await command(
      "dutyType.save",
      {
        id: type.id,
        name: "סיור",
        pricing: { mode: "fixed", base: 4 },
        genders: ["male"],
        roles: [{ name: "נהג", count: 1 }],
      },
      1
    );
    const [kept] = await db.select().from(duties).where(eq(duties.id, row.id));
    expect(kept.data.requirements.genders ?? []).toEqual([]);
    expect(kept.data.slots[0].requirements).toEqual(roles[0].requirements);
  });
});
