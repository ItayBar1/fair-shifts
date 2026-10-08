import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import {
  user,
  session,
  loginCode,
  emailOutbox,
  recoveryCode,
} from "../../src/server/auth-schema";
import {
  soldiers,
  soldierContacts,
  balances,
  records,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  issueRecoveryCodes,
  recoverTechnicalAccess,
  useRecoveryCode,
  type Actor,
} from "../../src/server/auth/accounts";
import { requestCode, verifyCode } from "../../src/server/auth/otp";
import { createProvenSession, getActor, getAuth } from "../../src/server/auth";
import { openSecret } from "../../src/server/operations/email";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

const emails = {
  technical: "access-technical@example.invalid",
  mandatoryManager: "access-mandatory@example.invalid",
  careerManager: "access-career@example.invalid",
  member: "access-member@example.invalid",
  other: "access-other@example.invalid",
};
let ids: Record<keyof typeof emails, string>;

async function invite(
  name: string,
  role: "soldier" | "manager",
  email: string,
  personalNumber: string
) {
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber,
    data: soldier({ id, name, personalNumber }),
  });
  await db.insert(soldierContacts).values({
    soldierId: id,
    email,
    phone: `05${personalNumber}`,
  });
  await db.insert(balances).values({ soldierId: id });
  return (await createInvitedAccount({ name, role, email, soldierId: id })).id;
}
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  ids = {
    technical: (
      await createInvitedAccount({
        name: "טכני גישה",
        role: "technical",
        email: emails.technical,
      })
    ).id,
    mandatoryManager: await invite(
      "אחראי חובה",
      "manager",
      emails.mandatoryManager,
      "3000001"
    ),
    careerManager: await invite(
      "אחראי קבע",
      "manager",
      emails.careerManager,
      "3000002"
    ),
    member: await invite("חייל גישה", "soldier", emails.member, "3000003"),
    other: await invite("חייל אחר", "soldier", emails.other, "3000004"),
  };
});
afterAll(async () => pool.end());

async function account(id: string) {
  const [row] = await db.select().from(user).where(eq(user.id, id));
  return row;
}
async function actorOf(id: string): Promise<Actor> {
  const row = await account(id);
  return {
    id: row.id,
    name: row.name,
    role: row.role as Actor["role"],
    soldierId: row.soldierId ?? undefined,
    securityEpoch: row.securityEpoch,
  };
}
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
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  )[0];
  return openSecret(latest.encryptedSecret!, {
    purpose: "mail-code",
    recordId: latest.id,
  });
}
/** Moves the last send out of the one-minute window instead of sleeping. */
async function allowResend(accountId: string) {
  await db
    .update(loginCode)
    .set({ sentAt: new Date(Date.now() - 120_000) })
    .where(eq(loginCode.userId, accountId));
}
/** Signs in through the real endpoint and returns the browser cookie header. */
async function signIn(email: string) {
  const [row] = await db.select().from(user).where(eq(user.email, email));
  await allowResend(row.id);
  await requestCode(email);
  const response = await verifyEndpoint(email, await storedCode(row.id));
  expect(response.status, await response.clone().text()).toBe(200);
  return new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; "),
  });
}
function verifyEndpoint(email: string, code: string) {
  return getAuth().handler(
    new Request("http://localhost:3000/api/auth/verify-code", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, code }),
    })
  );
}
/** The session Better Auth creates after a provider callback carries no code proof. */
async function providerSession(accountId: string) {
  return (await getAuth().$context).internalAdapter.createSession(accountId);
}
async function command(
  actorId: string,
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) {
  return executeAction(await actorOf(actorId), {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  });
}
async function fail(email: string, now?: Date) {
  try {
    await verifyCode(email, "000000-wrong", now);
  } catch (error) {
    return error as Error & { code: string };
  }
  throw new Error("a wrong code was accepted");
}
async function auditActions(targetId: string) {
  return (await db.select().from(records).where(eq(records.kind, "audit")))
    .filter((row) => row.data.targetId === targetId)
    .map((row) => ({
      actorId: row.data.actorId,
      action: row.data.action,
      reason: row.data.reason,
    }))
    .sort((a, b) => String(a.action).localeCompare(String(b.action)));
}
async function lock(email: string) {
  const [row] = await db.select().from(user).where(eq(user.email, email));
  // A lock retained from the pre-207 policy still needs authorized release.
  await db
    .update(user)
    .set({
      lockedAt: new Date(),
      failedAttempts: 5,
      securityEpoch: row.securityEpoch + 1,
    })
    .where(eq(user.id, row.id));
}

describe("manager permission is granted and removed only by the technical account", () => {
  it("rejects managers and soldiers on the server, applies a grant and a removal to an existing connection and records both", async () => {
    const memberConnection = await signIn(emails.member);
    expect((await getActor(memberConnection))?.role).toBe("soldier");
    const version = (await account(ids.member)).securityEpoch;

    for (const actorId of [ids.mandatoryManager, ids.careerManager, ids.member])
      await expect(
        command(
          actorId,
          "account.role",
          { id: ids.member, role: "manager" },
          version
        )
      ).rejects.toMatchObject({ status: 403 });
    await expect(
      command(
        ids.careerManager,
        "account.role",
        { id: ids.mandatoryManager, role: "soldier" },
        version
      )
    ).rejects.toMatchObject({ status: 403 });
    expect((await account(ids.member)).role).toBe("soldier");
    expect(await auditActions(ids.member)).toEqual([]);

    const staleSoldier = await actorOf(ids.member);
    await command(
      ids.technical,
      "account.role",
      { id: ids.member, role: "manager" },
      version
    );
    // The connection opened as a soldier ends at once, not when it expires.
    expect(await getActor(memberConnection)).toBeNull();
    await expect(
      executeAction(staleSoldier, {
        type: "notification.read",
        payload: {},
        idempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject({ status: 401 });

    const managerConnection = await signIn(emails.member);
    expect((await getActor(managerConnection))?.role).toBe("manager");
    const [managerSession] = await db
      .select()
      .from(session)
      .where(eq(session.userId, ids.member));
    expect(
      managerSession.expiresAt.getTime() - managerSession.createdAt.getTime()
    ).toBeLessThanOrEqual(86_400_000 + 1000);

    await command(
      ids.technical,
      "account.role",
      { id: ids.member, role: "soldier" },
      (await account(ids.member)).securityEpoch
    );
    expect(await getActor(managerConnection)).toBeNull();
    expect((await getActor(await signIn(emails.member)))?.role).toBe("soldier");
    expect(await auditActions(ids.member)).toEqual([
      { actorId: ids.technical, action: "role:manager", reason: undefined },
      { actorId: ids.technical, action: "role:soldier", reason: undefined },
    ]);
  });

  it("keeps the technical account out of soldier records, rankings and role changes", async () => {
    await expect(
      command(
        ids.technical,
        "account.role",
        { id: ids.technical, role: "manager" },
        (await account(ids.technical)).securityEpoch
      )
    ).rejects.toMatchObject({ code: "ACCOUNT_TYPE" });
    await expect(
      createInvitedAccount({
        name: "טכני עם רשומה",
        role: "technical",
        email: "technical-soldier@example.invalid",
        soldierId: ids.member,
      })
    ).rejects.toMatchObject({ code: "ACCOUNT_TYPE" });

    const managerView = await readState(await actorOf(ids.mandatoryManager));
    const names = managerView.soldiers.map((row) => row.name);
    expect(names).not.toContain("טכני גישה");
    expect(managerView.accounts.map((row) => row.id)).not.toContain(
      ids.technical
    );
    // The technical account manages roles without receiving soldier data.
    const technicalView = await readState(await actorOf(ids.technical));
    expect(technicalView.soldiers).toEqual([]);
    expect(JSON.stringify(technicalView.accounts)).not.toContain(
      "example.invalid"
    );
    expect(JSON.stringify(technicalView)).not.toContain("053000003");
  });

  it("hides deleted accounts from the permission and release lists", async () => {
    await db
      .update(user)
      .set({ deletedAt: new Date(), lockedAt: new Date() })
      .where(eq(user.id, ids.other));
    const technicalView = await readState(await actorOf(ids.technical));
    const managerView = await readState(await actorOf(ids.mandatoryManager));
    expect(technicalView.accounts.map((row) => row.id)).not.toContain(
      ids.other
    );
    expect(managerView.accounts.map((row) => row.id)).not.toContain(ids.other);
  });
});

describe("issuing a connection races revoking access", () => {
  it("does not issue a session from a code proof that a revocation made obsolete", async () => {
    await requestCode(emails.member);
    const proof = await verifyCode(emails.member, await storedCode(ids.member));
    // A role change commits after the code was accepted and before the session exists.
    await command(
      ids.technical,
      "account.role",
      { id: ids.member, role: "manager" },
      (await account(ids.member)).securityEpoch
    );
    const context = await getAuth().$context;
    expect(
      await createProvenSession(context.internalAdapter, proof)
    ).toBeNull();
    expect(
      await db.select().from(session).where(eq(session.userId, ids.member))
    ).toHaveLength(0);
  });

  it("issues one connection when the same code is submitted concurrently", async () => {
    await requestCode(emails.member);
    const code = await storedCode(ids.member);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => verifyEndpoint(emails.member, code))
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 401, 401, 401,
    ]);
    expect(
      await db.select().from(session).where(eq(session.userId, ids.member))
    ).toHaveLength(1);
  });
});

describe("connection lifetime", () => {
  it("keeps a soldier seven days and managers and the technical account 24 hours, without extending on use", async () => {
    const lifetimes: Record<string, number> = {};
    for (const key of ["member", "mandatoryManager", "technical"] as const) {
      await signIn(emails[key]);
      const [row] = await db
        .select()
        .from(session)
        .where(eq(session.userId, ids[key]));
      lifetimes[key] = Math.round(
        (row.expiresAt.getTime() - row.createdAt.getTime()) / 3_600_000
      );
    }
    expect(lifetimes).toEqual({
      member: 168,
      mandatoryManager: 24,
      technical: 24,
    });

    // A manager connection used near its end is not renewed.
    const managerConnection = await signIn(emails.careerManager);
    const nearEnd = new Date(Date.now() + 60_000);
    await db
      .update(session)
      .set({
        createdAt: new Date(Date.now() - 86_340_000),
        updatedAt: new Date(Date.now() - 86_340_000),
        expiresAt: nearEnd,
      })
      .where(eq(session.userId, ids.careerManager));
    expect((await getActor(managerConnection))?.id).toBe(ids.careerManager);
    const [used] = await db
      .select()
      .from(session)
      .where(eq(session.userId, ids.careerManager));
    expect(used.expiresAt.getTime()).toBe(nearEnd.getTime());
    await db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(session.userId, ids.careerManager));
    expect(await getActor(managerConnection)).toBeNull();
  });
});

describe("failed codes, lock and release", () => {
  it("warns after the third and fourth failure, keeps counting across a resend and burns on the fifth failure without locking", async () => {
    const start = new Date();
    await requestCode(emails.member, start);
    expect((await fail(emails.member, start)).message).toBe("קוד לא תקין");
    expect((await fail(emails.member, start)).message).toBe("קוד לא תקין");
    expect((await fail(emails.member, start)).message).toBe(
      "קוד לא תקין. נותרו שני ניסיונות לפני ביטול הקוד"
    );
    const later = new Date(start.getTime() + 61_000);
    await requestCode(emails.member, later);
    expect((await account(ids.member)).failedAttempts).toBe(3);
    const resent = await storedCode(ids.member);
    expect((await fail(emails.member, later)).message).toBe(
      "קוד לא תקין. נותר ניסיון אחד לפני ביטול הקוד"
    );
    const burned = await fail(emails.member, later);
    expect(burned.code).toBe("invalid_code");
    expect(burned.message).toBe(
      "הקוד בוטל לאחר חמש טעויות. יש להמתין לפני בקשת קוד חדש"
    );
    // The correct code of the resend no longer opens the account.
    await expect(
      verifyCode(emails.member, resent, later)
    ).rejects.toMatchObject({ code: "invalid_code" });
    expect((await account(ids.member)).lockedAt).toBeNull();
  });

  it("blocks an existing connection, a provider sign-in and new codes until a manager releases the soldier", async () => {
    const connection = await signIn(emails.member);
    await lock(emails.member);
    expect(await getActor(connection)).toBeNull();
    expect(await providerSession(ids.member)).toBeNull();
    const mailBefore = await db.select().from(emailOutbox);
    await allowResend(ids.member);
    expect(await requestCode(emails.member)).toEqual({ success: true });
    expect(await db.select().from(emailOutbox)).toHaveLength(mailBefore.length);

    const version = (await account(ids.member)).securityEpoch;
    // Permission is checked before the version, so a soldier learns nothing.
    for (const actorId of [ids.technical, ids.other])
      await expect(
        command(actorId, "account.unlock", { id: ids.member }, version + 7)
      ).rejects.toMatchObject({ status: 403 });
    await command(
      ids.careerManager,
      "account.unlock",
      { id: ids.member },
      version
    );
    const released = await account(ids.member);
    expect(released.lockedAt).toBeNull();
    expect(released.failedAttempts).toBe(0);
    expect(released.securityEpoch).toBe(version + 1);
    expect(await getActor(connection)).toBeNull();
    expect(await auditActions(ids.member)).toEqual([
      { actorId: ids.careerManager, action: "unlock", reason: undefined },
    ]);
    expect((await getActor(await signIn(emails.member)))?.id).toBe(ids.member);
  });

  it("sends a locked manager to the technical account, which alone releases it", async () => {
    const connection = await signIn(emails.careerManager);
    await lock(emails.careerManager);
    expect((await fail(emails.careerManager)).message).toBe(
      "החשבון נעול. יש לפנות למנהל הטכני לשחרור"
    );
    expect(await getActor(connection)).toBeNull();
    expect(await providerSession(ids.careerManager)).toBeNull();

    const version = (await account(ids.careerManager)).securityEpoch;
    await expect(
      command(
        ids.mandatoryManager,
        "account.unlock",
        { id: ids.careerManager },
        version
      )
    ).rejects.toMatchObject({ status: 403 });
    await command(
      ids.technical,
      "account.unlock",
      { id: ids.careerManager },
      version
    );
    expect((await account(ids.careerManager)).lockedAt).toBeNull();
    expect((await getActor(await signIn(emails.careerManager)))?.role).toBe(
      "manager"
    );
  });

  it("keeps failures on resend and refuses an unproven provider session instead of resetting them", async () => {
    await requestCode(emails.member);
    for (let attempt = 0; attempt < 4; attempt++) await fail(emails.member);
    await allowResend(ids.member);
    await requestCode(emails.member);
    expect((await account(ids.member)).failedAttempts).toBe(4);
    expect(await providerSession(ids.member)).toBeNull();
    expect((await account(ids.member)).failedAttempts).toBe(4);
  });
});

describe("technical access recovery", () => {
  it("points a locked technical account to its recovery codes and lets each code work once", async () => {
    const codes = await db.transaction((tx) =>
      issueRecoveryCodes(ids.technical, tx)
    );
    await lock(emails.technical);
    expect((await fail(emails.technical)).message).toBe(
      "החשבון נעול. יש להשתמש בקוד שחזור חד־פעמי או בשחזור דרך השרת"
    );
    await expect(
      useRecoveryCode(emails.member, codes[0])
    ).rejects.toMatchObject({ status: 401 });
    const epoch = (await account(ids.technical)).securityEpoch;
    await useRecoveryCode(emails.technical, codes[0]);
    const recovered = await account(ids.technical);
    expect(recovered.lockedAt).toBeNull();
    expect(recovered.failedAttempts).toBe(0);
    expect(recovered.securityEpoch).toBe(epoch + 1);
    await expect(
      useRecoveryCode(emails.technical, codes[0])
    ).rejects.toMatchObject({ status: 401 });
    await useRecoveryCode(emails.technical, codes[1]);
    const stored = await db
      .select()
      .from(recoveryCode)
      .where(eq(recoveryCode.userId, ids.technical));
    expect(JSON.stringify(stored)).not.toContain(codes[2]);
    expect(await auditActions(ids.technical)).toEqual([
      {
        actorId: ids.technical,
        action: "recovery-code",
        reason: undefined,
      },
      {
        actorId: ids.technical,
        action: "recovery-code",
        reason: undefined,
      },
    ]);
    expect((await getActor(await signIn(emails.technical)))?.role).toBe(
      "technical"
    );
  });

  it("recovers through the server with a recorded reason, ends connections and replaces every earlier code", async () => {
    const earlier = await db.transaction((tx) =>
      issueRecoveryCodes(ids.technical, tx)
    );
    const connection = await signIn(emails.technical);
    await lock(emails.technical);
    await expect(
      recoverTechnicalAccess(emails.technical, "קצר")
    ).rejects.toThrow();
    await expect(
      recoverTechnicalAccess(emails.careerManager, "אובדן גישה למייל")
    ).rejects.toMatchObject({ code: "not_found" });

    const codes = await recoverTechnicalAccess(
      emails.technical.toUpperCase(),
      "אובדן גישה למייל"
    );
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    expect((await account(ids.technical)).lockedAt).toBeNull();
    expect(await getActor(connection)).toBeNull();
    await expect(
      useRecoveryCode(emails.technical, earlier[0])
    ).rejects.toMatchObject({ status: 401 });
    await useRecoveryCode(emails.technical, codes[0]);
    expect(await auditActions(ids.technical)).toEqual([
      {
        actorId: ids.technical,
        action: "recovery-code",
        reason: undefined,
      },
      {
        actorId: "server-operator",
        action: "technical.server-recovery",
        reason: "אובדן גישה למייל",
      },
    ]);
    const log = (await readState(await actorOf(ids.technical))).audit.find(
      (entry) => entry.action === "technical.server-recovery"
    );
    expect(log).toMatchObject({
      label: "שחזור גישה טכנית דרך השרת",
      actorName: "מפעיל השרת",
      reason: "אובדן גישה למייל",
    });
  });
});
