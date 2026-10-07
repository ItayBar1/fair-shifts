import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import {
  user,
  session,
  account,
  loginCode,
  emailOutbox,
  recoveryCode,
} from "../../src/server/auth-schema";
import {
  soldiers,
  soldierContacts,
  balances,
  records,
  commandResults,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  issueRecoveryCodes,
  useRecoveryCode,
  type Actor,
} from "../../src/server/auth/accounts";
import { requestCode, verifyCode } from "../../src/server/auth/otp";
import {
  confirmServerEmailChange,
  requestServerEmailChange,
} from "../../src/server/auth/technical-email";
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
  technical: "tech-change-technical@example.invalid",
  next: "tech-change-next@example.invalid",
  manager: "tech-change-manager@example.invalid",
  member: "tech-change-member@example.invalid",
};
let ids: { technical: string; manager: string; member: string };
let recovery: string[];

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
  await db.insert(soldierContacts).values({ soldierId: id, email });
  await db.insert(balances).values({ soldierId: id });
  return (await createInvitedAccount({ name, role, email, soldierId: id })).id;
}
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  const technical = await createInvitedAccount({
    name: "טכני להחלפת כתובת",
    role: "technical",
    email: emails.technical,
  });
  ids = {
    technical: technical.id,
    manager: await invite("אחראי", "manager", emails.manager, "6000001"),
    member: await invite("חייל", "soldier", emails.member, "6000002"),
  };
  recovery = await db.transaction((tx) => issueRecoveryCodes(technical.id, tx));
});
afterAll(async () => pool.end());

async function account_(id: string) {
  const [row] = await db.select().from(user).where(eq(user.id, id));
  return row;
}
async function actorOf(id: string): Promise<Actor> {
  const row = await account_(id);
  return {
    id: row.id,
    name: row.name,
    role: row.role as Actor["role"],
    soldierId: row.soldierId ?? undefined,
    securityEpoch: row.securityEpoch,
  };
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
const asTechnical = (type: string, payload: Record<string, unknown>) =>
  command(ids.technical, type, payload);

const ask = (email: string, reason = "מעבר לחשבון הייעודי") =>
  asTechnical("technical.email.request", { email, reason });

/** The codes the mail queue holds, by the address each one goes to. */
async function codesSent(accountId = ids.technical) {
  const rows = await db
    .select()
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.recipientAccountId, accountId),
        eq(emailOutbox.kind, "email-change"),
        eq(emailOutbox.status, "pending")
      )
    );
  return Object.fromEntries(
    rows.map((row) => [row.destination, openSecret(row.encryptedSecret!)])
  ) as Record<string, string>;
}
const requests = async () =>
  (
    await db
      .select()
      .from(records)
      .where(eq(records.kind, "technical_email_change"))
  ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
/** Moves the last request out of the one-minute window instead of sleeping. */
async function allowNewRequest() {
  await db
    .update(records)
    .set({ createdAt: new Date(Date.now() - 120_000) })
    .where(eq(records.kind, "technical_email_change"));
}
const confirm = (currentCode: string, newCode: string) =>
  asTechnical("technical.email.confirm", { currentCode, newCode });
async function ask_and_codes(email = emails.next) {
  await ask(email);
  return codesSent();
}
const audit = async () =>
  (await db.select().from(records).where(eq(records.kind, "audit")))
    .filter((row) => row.data.targetId === ids.technical)
    .map((row) => row.data);

describe("security #123: manager email authority", () => {
  const askManager = () =>
    command(ids.manager, "manager.email.request", {
      email: emails.next,
      reason: "החלפת תיבה אישית",
    });
  const confirmManager = (codes: Record<string, string>) =>
    command(ids.manager, "manager.email.confirm", {
      currentCode: codes[emails.manager],
      newCode: codes[emails.next],
    });

  it("blocks the original peer takeover, including self through the soldier route", async () => {
    const other = await invite(
      "אחראי שני",
      "manager",
      "second@example.invalid",
      "6000003"
    );
    for (const targetId of [ids.manager, other]) {
      const target = await account_(targetId);
      for (const type of ["account.email.request", "account.email.confirm"])
        await expect(
          command(
            ids.manager,
            type,
            {
              soldierId: target.soldierId,
              email: emails.next,
              reason: "בדיקה",
              code: "123456",
              disconnectGoogle: true,
            },
            1
          )
        ).rejects.toMatchObject({ status: 403 });
      expect((await account_(targetId)).email).toBe(target.email);
    }
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });

  it("rechecks the role under lock after a soldier is promoted between request and confirmation", async () => {
    const member = await account_(ids.member);
    await command(
      ids.manager,
      "account.email.request",
      { soldierId: member.soldierId, email: emails.next, reason: "החלפה" },
      1
    );
    const codes = await codesSent(ids.member);
    await command(
      ids.technical,
      "account.role",
      { id: ids.member, role: "manager" },
      member.securityEpoch
    );
    await expect(
      command(
        ids.manager,
        "account.email.confirm",
        {
          soldierId: member.soldierId,
          code: codes[emails.next],
          disconnectGoogle: true,
        },
        1
      )
    ).rejects.toMatchObject({ status: 403 });
    expect((await account_(ids.member)).email).toBe(emails.member);
  });

  it("requires both mailboxes for a manager and revokes prior access on success", async () => {
    const before = await account_(ids.manager);
    await requestCode(emails.manager);
    await db.insert(session).values({
      id: randomUUID(),
      token: randomUUID(),
      userId: ids.manager,
      expiresAt: new Date(Date.now() + 60_000),
      securityEpoch: before.securityEpoch,
    });
    await db.insert(account).values({
      id: randomUUID(),
      userId: ids.manager,
      providerId: "google",
      accountId: "manager-old-sub",
      proofEpoch: before.securityEpoch,
      googleLinkGeneration: before.googleLinkGeneration,
      needsEmailVerification: false,
    });
    await askManager();
    const codes = await codesSent(ids.manager);
    expect(Object.keys(codes).sort()).toEqual(
      [emails.manager, emails.next].sort()
    );
    await expect(
      confirmManager({ ...codes, [emails.manager]: "not-the-code" })
    ).rejects.toMatchObject({ code: "invalid_code" });
    expect((await account_(ids.manager)).email).toBe(emails.manager);
    const result = await readState(await actorOf(ids.manager));
    expect(result.ownAccount).toMatchObject({
      email: emails.manager,
      pendingEmailChange: { email: emails.next },
    });
    await confirmManager(codes);
    expect(await account_(ids.manager)).toMatchObject({
      email: emails.next,
      securityEpoch: before.securityEpoch + 1,
    });
    expect(
      await db.select().from(session).where(eq(session.userId, ids.manager))
    ).toHaveLength(0);
    expect(
      await db.select().from(account).where(eq(account.userId, ids.manager))
    ).toHaveLength(0);
    expect(
      await db.select().from(loginCode).where(eq(loginCode.userId, ids.manager))
    ).toHaveLength(0);
    const [contact] = await db
      .select()
      .from(soldierContacts)
      .where(eq(soldierContacts.soldierId, before.soldierId!));
    expect(contact.email).toBe(emails.next);
  });

  it("rejects unauthorized roles before parsing and never lets a self request choose another target", async () => {
    for (const actorId of [ids.technical, ids.member])
      for (const type of ["manager.email.request", "manager.email.confirm"])
        await expect(command(actorId, type, {})).rejects.toMatchObject({
          status: 403,
        });
    for (const actorId of [ids.manager, ids.member])
      for (const type of [
        "technical.manager-email.request",
        "technical.manager-email.confirm",
      ])
        await expect(command(actorId, type, {})).rejects.toMatchObject({
          status: 403,
        });
    await command(ids.manager, "manager.email.request", {
      accountId: ids.technical,
      email: emails.next,
      reason: "בדיקה",
    });
    expect(await codesSent()).toEqual({});
    expect(Object.keys(await codesSent(ids.manager))).toHaveLength(2);
  });

  it("allows technical recovery with a reason and only the new mailbox code, and records erasable reasons", async () => {
    await expect(
      asTechnical("technical.manager-email.request", {
        accountId: ids.manager,
        email: emails.next,
        reason: "",
      })
    ).rejects.toThrow();
    for (const accountId of [ids.member, ids.technical])
      await expect(
        asTechnical("technical.manager-email.request", {
          accountId,
          email: emails.next,
          reason: "תיבה אבדה",
        })
      ).rejects.toMatchObject({ status: 403 });
    await asTechnical("technical.manager-email.request", {
      accountId: ids.manager,
      email: emails.next,
      reason: "תיבה אבדה",
    });
    const codes = await codesSent(ids.manager);
    expect(Object.keys(codes)).toEqual([emails.next]);
    await expect(
      confirmManager({ [emails.manager]: "123456", ...codes })
    ).rejects.toMatchObject({ code: "expired_verification" });
    await asTechnical("technical.manager-email.confirm", {
      accountId: ids.manager,
      newCode: codes[emails.next],
    });
    expect((await account_(ids.manager)).email).toBe(emails.next);
    const logs = await db
      .select()
      .from(records)
      .where(eq(records.kind, "audit"));
    const entry = logs.find(
      (row) => row.data.action === "technical.manager-email.confirm"
    )!;
    expect(entry.data.reason).toBeUndefined();
    const [detail] = await db
      .select()
      .from(records)
      .where(eq(records.id, String(entry.data.detailId)));
    expect(detail).toMatchObject({
      subjectId: (await account_(ids.manager)).soldierId,
      data: { reason: "תיבה אבדה" },
    });
  });

  it("rejects recovery confirmation after demotion", async () => {
    await asTechnical("technical.manager-email.request", {
      accountId: ids.manager,
      email: emails.next,
      reason: "תיבה אבדה",
    });
    const codes = await codesSent(ids.manager);
    await command(
      ids.technical,
      "account.role",
      { id: ids.manager, role: "soldier" },
      (await account_(ids.manager)).securityEpoch
    );
    await expect(
      asTechnical("technical.manager-email.confirm", {
        accountId: ids.manager,
        newCode: codes[emails.next],
      })
    ).rejects.toMatchObject({ status: 403 });
    expect((await account_(ids.manager)).email).toBe(emails.manager);
  });

  it("serializes competing confirmations so only one applies", async () => {
    await askManager();
    const codes = await codesSent(ids.manager);
    const results = await Promise.allSettled([
      confirmManager(codes),
      confirmManager(codes),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect((await account_(ids.manager)).email).toBe(emails.next);
  });
});

describe("who can use the route", () => {
  it("is refused to a manager and a soldier, also when called directly", async () => {
    for (const actorId of [ids.manager, ids.member])
      for (const [type, payload] of [
        [
          "technical.email.request",
          { email: emails.next, reason: "ניסיון לא מורשה" },
        ],
        ["technical.email.confirm", { currentCode: "1", newCode: "2" }],
      ] as const)
        await expect(command(actorId, type, payload)).rejects.toMatchObject({
          status: 403,
        });
    expect(await requests()).toHaveLength(0);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });

  it("leaves the soldier route to the managers, with the technical account refused there", async () => {
    await expect(
      asTechnical("account.email.request", {
        soldierId: (await account_(ids.member)).soldierId,
        email: emails.next,
        reason: "ניסיון",
      })
    ).rejects.toMatchObject({ status: 403 });
    // A manager's request for a soldier works as before and does not touch this route.
    await command(
      ids.manager,
      "account.email.request",
      {
        soldierId: (await account_(ids.member)).soldierId,
        email: "tech-change-member-new@example.invalid",
        reason: "בקשת חייל",
      },
      1
    );
    expect(await requests()).toHaveLength(0);
  });
});

describe("asking for the change", () => {
  it("sends one code to each mailbox, stores only digests and changes nothing yet", async () => {
    const before = await account_(ids.technical);
    await ask("NEXT-Address@Example.invalid");
    const sent = await codesSent();
    expect(Object.keys(sent).sort()).toEqual(
      [emails.technical, "next-address@example.invalid"].sort()
    );
    expect(sent[emails.technical]).toMatch(/^\d{6}$/);
    expect(sent["next-address@example.invalid"]).toMatch(/^\d{6}$/);
    const [record] = await requests();
    expect(record.data).toMatchObject({
      accountId: ids.technical,
      mode: "web",
      status: "pending",
      attempts: 0,
      reason: "מעבר לחשבון הייעודי",
      email: "next-address@example.invalid",
    });
    const stored = JSON.stringify(record.data);
    for (const code of Object.values(sent)) expect(stored).not.toContain(code);
    const minutes =
      (new Date(String(record.data.expiresAt)).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
    expect(await account_(ids.technical)).toMatchObject({
      email: emails.technical,
      securityEpoch: before.securityEpoch,
    });
  });

  it("refuses the current address and an address of another account", async () => {
    await expect(ask(emails.technical.toUpperCase())).rejects.toMatchObject({
      code: "unchanged_email",
    });
    await expect(ask(emails.manager)).rejects.toMatchObject({
      code: "email_exists",
    });
    await expect(ask(emails.next, "")).rejects.toThrow();
    expect(await requests()).toHaveLength(0);
  });

  it("allows one request a minute and lets a new one cancel the earlier one and its mail", async () => {
    const first = await ask_and_codes("first-address@example.invalid");
    await expect(ask(emails.next)).rejects.toMatchObject({
      code: "rate_limit",
      status: 429,
    });
    await allowNewRequest();
    const second = await ask_and_codes();
    expect(Object.keys(second)).not.toContain("first-address@example.invalid");
    const [old, current] = await requests();
    expect(old.data).toMatchObject({ status: "superseded" });
    expect(old.data.email).toBeUndefined();
    expect(old.data.digest).toBeUndefined();
    expect(current.data.status).toBe("pending");
    // The first pair of codes is of no use any more.
    await expect(
      confirm(first[emails.technical], first["first-address@example.invalid"])
    ).rejects.toMatchObject({ code: "invalid_code" });
    const cancelled = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.status, "cancelled"));
    expect(cancelled).toHaveLength(2);
    expect(cancelled.every((row) => row.encryptedSecret === null)).toBe(true);
  });

  it("serializes two requests made together: one succeeds, the other waits a minute", async () => {
    const results = await Promise.allSettled([
      ask("together-a@example.invalid"),
      ask("together-b@example.invalid"),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.find((row) => row.status === "rejected")).toMatchObject({
      reason: { code: "rate_limit" },
    });
    expect(await requests()).toHaveLength(1);
  });
});

describe("confirming with both codes", () => {
  it("needs both: one right code and one wrong code changes nothing and says nothing about which was wrong", async () => {
    const sent = await ask_and_codes();
    const wrong = (value: string) => (value === "000000" ? "111111" : "000000");
    for (const [current, next] of [
      [sent[emails.technical], wrong(sent[emails.next])],
      [wrong(sent[emails.technical]), sent[emails.next]],
    ])
      await expect(confirm(current, next)).rejects.toMatchObject({
        code: "invalid_code",
        message: "קוד האימות אינו תקין",
        status: 422,
      });
    // The new code in both fields, and the codes the other way round, are not enough.
    await expect(
      confirm(sent[emails.next], sent[emails.technical])
    ).rejects.toMatchObject({ code: "invalid_code" });
    expect((await requests())[0].data.attempts).toBe(3);
    expect((await account_(ids.technical)).email).toBe(emails.technical);
  });

  it("cancels the request after five mistakes, even for the right codes, and the unsent codes with it", async () => {
    const sent = await ask_and_codes();
    for (let attempt = 1; attempt <= 4; attempt++)
      await expect(confirm("000000", "000001")).rejects.toMatchObject({
        message: "קוד האימות אינו תקין",
      });
    await expect(confirm("000000", "000001")).rejects.toMatchObject({
      message: "האימות נחסם לאחר חמישה ניסיונות. יש לבקש קוד חדש",
    });
    const [record] = await requests();
    expect(record.data).toMatchObject({ status: "failed", attempts: 5 });
    expect(record.data.email).toBeUndefined();
    await expect(
      confirm(sent[emails.technical], sent[emails.next])
    ).rejects.toMatchObject({ code: "expired_verification" });
    expect((await account_(ids.technical)).email).toBe(emails.technical);
    expect(await codesSent()).toEqual({});
  });

  it("does not accept an expired request", async () => {
    const sent = await ask_and_codes();
    const [record] = await requests();
    await db
      .update(records)
      .set({
        data: {
          ...record.data,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      })
      .where(eq(records.id, record.id));
    await expect(
      confirm(sent[emails.technical], sent[emails.next])
    ).rejects.toMatchObject({ code: "expired_verification" });
    expect((await account_(ids.technical)).email).toBe(emails.technical);
  });

  it("does not accept a request opened before the account's access changed", async () => {
    const sent = await ask_and_codes();
    await db
      .update(user)
      .set({ securityEpoch: sql`${user.securityEpoch} + 1` })
      .where(eq(user.id, ids.technical));
    await expect(
      confirm(sent[emails.technical], sent[emails.next])
    ).rejects.toMatchObject({ code: "expired_verification" });
  });

  it("moves the account: new address verified, connections and the Google link gone, recovery codes kept, and recorded with the reason", async () => {
    await db.insert(account).values({
      id: "technical-google",
      userId: ids.technical,
      providerId: "google",
      accountId: "technical-sub",
      proofEpoch: 1,
      googleLinkGeneration: 1,
      needsEmailVerification: false,
    });
    await db.insert(session).values({
      id: "technical-session",
      userId: ids.technical,
      token: "technical-token",
      securityEpoch: 1,
      expiresAt: new Date(Date.now() + 1_000_000),
    });
    const before = await account_(ids.technical);
    const sent = await ask_and_codes();
    expect(
      (await readState(await actorOf(ids.technical))).ownAccount
    ).toMatchObject({
      email: emails.technical,
      pendingEmailChange: { email: emails.next },
    });
    const result = await confirm(sent[emails.technical], sent[emails.next]);
    expect(result).toEqual({ success: true });

    expect(await account_(ids.technical)).toMatchObject({
      email: emails.next,
      emailVerified: true,
      securityEpoch: before.securityEpoch + 1,
    });
    expect(
      await db.select().from(session).where(eq(session.userId, ids.technical))
    ).toHaveLength(0);
    expect(
      await db.select().from(account).where(eq(account.userId, ids.technical))
    ).toHaveLength(0);
    const [record] = await requests();
    expect(record.data).toMatchObject({ status: "completed", mode: "web" });
    expect(record.data.email).toBeUndefined();
    expect(record.data.digest).toBeUndefined();
    expect(await codesSent()).toEqual({});

    // Nothing the technical account was sent, and nothing returned, holds a code or recovery code.
    const stored = JSON.stringify(await db.select().from(commandResults));
    for (const code of [...Object.values(sent), ...recovery])
      expect(stored).not.toContain(code);
    // The same person keeps the recovery codes they hold.
    expect(
      await db
        .select()
        .from(recoveryCode)
        .where(eq(recoveryCode.userId, ids.technical))
    ).toHaveLength(8);
    await useRecoveryCode(emails.next, recovery[0]);

    expect(
      (await audit()).map((entry) => ({
        action: entry.action,
        actorId: entry.actorId,
        via: entry.via,
      }))
    ).toEqual(
      expect.arrayContaining([
        {
          action: "technical.email.request",
          actorId: ids.technical,
          via: undefined,
        },
        {
          action: "technical.email.confirm",
          actorId: ids.technical,
          via: undefined,
        },
      ])
    );
    const log = (await readState(await actorOf(ids.technical))).audit.filter(
      (entry) => entry.action.startsWith("technical.email.")
    );
    expect(log.map((entry) => entry.label).sort()).toEqual([
      "בקשה להחלפת כתובת החשבון הטכני",
      "החלפת כתובת החשבון הטכני",
    ]);
    expect(log.every((entry) => entry.reason === "מעבר לחשבון הייעודי")).toBe(
      true
    );
    expect(JSON.stringify(log)).not.toContain(emails.next);
  });

  it("signs in with a code at the new address only", async () => {
    const sent = await ask_and_codes();
    await confirm(sent[emails.technical], sent[emails.next]);
    await db.execute(sql`truncate table email_outbox`);
    await requestCode(emails.technical);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
    await requestCode(emails.next);
    const [mail] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, "login-code"));
    expect(mail.recipientAccountId).toBe(ids.technical);
    await expect(
      verifyCode(emails.next, openSecret(mail.encryptedSecret!))
    ).resolves.toMatchObject({ epoch: 2 });
    await db.delete(loginCode);
  });

  it("lets only one of two confirmations made together succeed", async () => {
    const sent = await ask_and_codes();
    const actor = await actorOf(ids.technical);
    const run = () =>
      executeAction(actor, {
        type: "technical.email.confirm",
        payload: {
          currentCode: sent[emails.technical],
          newCode: sent[emails.next],
        },
        idempotencyKey: randomUUID(),
      });
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect((await account_(ids.technical)).securityEpoch).toBe(
      actor.securityEpoch + 1
    );
  });

  it("stops when the address was given to someone else after the request", async () => {
    const sent = await ask_and_codes();
    await invite("חייל חדש", "soldier", emails.next, "6000003");
    await expect(
      confirm(sent[emails.technical], sent[emails.next])
    ).rejects.toMatchObject({ code: "email_exists", status: 409 });
    expect((await account_(ids.technical)).email).toBe(emails.technical);
    expect((await requests())[0].data.status).toBe("failed");
  });
});

describe("the server route", () => {
  const reason = "המנהל הטכני הקודם עזב והתיבה אינה זמינה";
  const english = /^[\x20-\x7e]+$/;
  async function newAddressCode() {
    const rows = await db
      .select()
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.kind, "email-change"),
          eq(emailOutbox.status, "pending")
        )
      );
    expect(rows.map((row) => row.destination)).toEqual([emails.next]);
    return openSecret(rows[0].encryptedSecret!);
  }

  it("sends a code to the new address only and needs a reason", async () => {
    await expect(
      requestServerEmailChange(emails.technical, emails.next, "קצר")
    ).rejects.toThrow();
    await requestServerEmailChange(
      emails.technical.toUpperCase(),
      emails.next,
      reason
    );
    expect(await newAddressCode()).toMatch(/^\d{6}$/);
    expect((await requests())[0].data).toMatchObject({
      mode: "server",
      reason,
      status: "pending",
    });
    expect((await account_(ids.technical)).email).toBe(emails.technical);
  });

  it("works only on the technical account, and its errors are in English", async () => {
    for (const email of [
      emails.manager,
      emails.member,
      "nobody@example.invalid",
    ])
      await expect(
        requestServerEmailChange(email, emails.next, reason)
      ).rejects.toMatchObject({
        code: "not_found",
        message: "Technical account not found",
      });
    await expect(
      requestServerEmailChange(emails.technical, emails.manager, reason)
    ).rejects.toMatchObject({
      code: "email_exists",
      message: expect.stringMatching(english),
    });
    await expect(
      requestServerEmailChange(emails.technical, emails.technical, reason)
    ).rejects.toMatchObject({ message: expect.stringMatching(english) });
    await expect(
      confirmServerEmailChange(emails.manager, "123456")
    ).rejects.toMatchObject({ code: "not_found" });
    await requestServerEmailChange(emails.technical, emails.next, reason);
    await expect(
      requestServerEmailChange(emails.technical, emails.next, reason)
    ).rejects.toMatchObject({
      code: "rate_limit",
      message: expect.stringMatching(english),
    });
    await expect(
      confirmServerEmailChange(emails.technical, "000000")
    ).rejects.toMatchObject({
      code: "invalid_code",
      message: expect.stringMatching(english),
    });
  });

  it("moves the account with the code from the new address, ends access and replaces the recovery codes", async () => {
    await db.insert(account).values({
      id: "technical-google-server",
      userId: ids.technical,
      providerId: "google",
      accountId: "technical-sub-server",
      proofEpoch: 1,
      googleLinkGeneration: 1,
      needsEmailVerification: false,
    });
    await requestServerEmailChange(emails.technical, emails.next, reason);
    const code = await newAddressCode();
    const fresh = await confirmServerEmailChange(emails.technical, code);

    expect(await account_(ids.technical)).toMatchObject({
      email: emails.next,
      emailVerified: true,
    });
    expect(
      await db.select().from(account).where(eq(account.userId, ids.technical))
    ).toHaveLength(0);
    expect(fresh).toHaveLength(8);
    expect(new Set([...fresh, ...recovery]).size).toBe(16);
    await expect(
      useRecoveryCode(emails.next, recovery[0])
    ).rejects.toMatchObject({ status: 401 });
    await useRecoveryCode(emails.next, fresh[0]);
    expect(
      JSON.stringify(await db.select().from(commandResults))
    ).not.toContain(fresh[1]);
    const entries = (await audit()).filter((entry) =>
      String(entry.action).startsWith("technical.email.")
    );
    expect(
      entries.map((entry) => [entry.action, entry.actorId, entry.via])
    ).toEqual(
      expect.arrayContaining([
        ["technical.email.request", "server-operator", "server"],
        ["technical.email.confirm", "server-operator", "server"],
      ])
    );
    const log = (await readState(await actorOf(ids.technical))).audit.filter(
      (entry) => entry.action.startsWith("technical.email.")
    );
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      actorName: "מפעיל השרת",
      reason,
      details: expect.arrayContaining([
        { label: "חשבון", value: "טכני להחלפת כתובת" },
        { label: "דרך", value: "פקודת שרת" },
      ]),
    });
  });

  it("counts wrong codes and cancels after five", async () => {
    await requestServerEmailChange(emails.technical, emails.next, reason);
    const code = await newAddressCode();
    for (let attempt = 1; attempt < 5; attempt++)
      await expect(
        confirmServerEmailChange(emails.technical, "000000")
      ).rejects.toMatchObject({ message: "The code is not valid" });
    await expect(
      confirmServerEmailChange(emails.technical, "000000")
    ).rejects.toMatchObject({
      message: "Cancelled after five wrong codes. Start again",
    });
    await expect(
      confirmServerEmailChange(emails.technical, code)
    ).rejects.toMatchObject({ code: "expired_verification" });
    expect((await account_(ids.technical)).email).toBe(emails.technical);
  });

  it("keeps the two routes apart: a request of one is not confirmed by the other", async () => {
    await requestServerEmailChange(emails.technical, emails.next, reason);
    const serverCode = await newAddressCode();
    await expect(confirm("123456", serverCode)).rejects.toMatchObject({
      code: "expired_verification",
    });
    await allowNewRequest();
    const sent = await ask_and_codes("web-address@example.invalid");
    // The server step finds no server request of its own: the web one replaced it.
    await expect(
      confirmServerEmailChange(emails.technical, serverCode)
    ).rejects.toMatchObject({ code: "expired_verification" });
    await expect(
      confirm(sent[emails.technical], sent["web-address@example.invalid"])
    ).resolves.toEqual({ success: true });
    expect((await account_(ids.technical)).email).toBe(
      "web-address@example.invalid"
    );
  });
});
