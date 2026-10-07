import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { connectDatabase, db, pool } from "../../src/server/db";
import {
  authBudget,
  authRateLimit,
  emailOutbox,
  loginCode,
  session,
  user,
} from "../../src/server/auth-schema";
import { records, soldiers } from "../../src/server/schema";
import { soldier } from "../fixtures";
import {
  createInvitedAccount,
  useRecoveryCode as recoverAccount,
} from "../../src/server/auth/accounts";
import { requestCode, verifyCode } from "../../src/server/auth/otp";
import { reserveCodeBudget } from "../../src/server/auth/budgets";
import {
  enforceAuthRateLimit,
  clientBucket,
  normalizeClientIp,
} from "../../src/server/auth/rate-limit";
import {
  deliverNextEmail,
  MailDeliveryError,
  openSecret,
  quotaDay,
} from "../../src/server/operations/email";
import { executeAction } from "../../src/server/actions";
import { POST } from "../../src/app/api/auth/[...all]/route";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Security tests require a dedicated *_test database");
const start = DateTime.utc().startOf("day").plus({ hours: 12 }).toJSDate();
let person: typeof user.$inferSelect;
beforeEach(async () => {
  vi.unstubAllEnvs();
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  person = await createInvitedAccount({
    name: "Synthetic security account",
    email: "protection@example.invalid",
    role: "technical",
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pool.end();
});
const current = async () =>
  (await db.select().from(user).where(eq(user.id, person.id)))[0];
const mails = () =>
  db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.recipientAccountId, person.id));
async function wrong(now = start) {
  await expect(
    verifyCode(person.email, "always-wrong", now)
  ).rejects.toMatchObject({ code: "invalid_code" });
}

describe("security #124: OTP burn and durable budgets", () => {
  it("burns exactly once in a race and keeps the account, epoch and existing session", async () => {
    await requestCode(person.email, start);
    await db.insert(session).values({
      id: randomUUID(),
      token: randomUUID(),
      userId: person.id,
      securityEpoch: person.securityEpoch,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => verifyCode(person.email, "wrong", start))
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(await current()).toMatchObject({
      failedAttempts: 5,
      lockedAt: null,
      securityEpoch: person.securityEpoch,
      nextCodeAllowedAt: new Date(start.getTime() + 120_000),
    });
    expect(await db.select().from(session)).toHaveLength(1);
    expect((await db.select().from(loginCode))[0]).toMatchObject({
      digest: "",
      usedAt: start,
    });
    expect(
      (await mails()).every(
        (row) => row.encryptedSecret === null && row.status === "cancelled"
      )
    ).toBe(true);
  });

  it("anchors the wait to burning even just before expiry, and cannot bypass it by deleting the challenge", async () => {
    await requestCode(person.email, start);
    const burnAt = new Date(start.getTime() + 599_000);
    for (let i = 0; i < 5; i++) await wrong(burnAt);
    await db.delete(loginCode).where(eq(loginCode.userId, person.id));
    const before = await mails();
    await requestCode(person.email, new Date(start.getTime() + 600_001));
    expect(await mails()).toHaveLength(before.length);
    await requestCode(person.email, new Date(burnAt.getTime() + 120_000));
    expect(await mails()).toHaveLength(before.length + 1);
    expect((await current()).failedAttempts).toBe(5);
  });

  it("doubles each burn delay to 24 hours and keeps it across subsequent requests", async () => {
    for (const failures of [0, 5, 10, 50, 55, 500]) {
      await db
        .update(user)
        .set({ failedAttempts: failures, nextCodeAllowedAt: null })
        .where(eq(user.id, person.id));
      await db.delete(loginCode).where(eq(loginCode.userId, person.id));
      await requestCode(person.email, start);
      for (let i = 0; i < 5; i++) await wrong();
      const expected = Math.min(86_400_000, 60_000 * 2 ** (failures / 5 + 1));
      expect((await current()).nextCodeAllowedAt?.getTime()).toBe(
        start.getTime() + expected
      );
      await requestCode(person.email, new Date(start.getTime() + expected - 1));
      expect((await current()).failedAttempts).toBe(failures + 5);
    }
  });

  it("gives the same code-request response for unknown, waiting and capped accounts", async () => {
    const unknown = await requestCode("unknown@example.invalid", start);
    expect(await requestCode(person.email, start)).toEqual(unknown);
    expect(await requestCode(person.email, start)).toEqual(unknown);
    for (let i = 1; i < 10; i++)
      await requestCode(person.email, new Date(start.getTime() + i * 61_000));
    const before = await db.select().from(loginCode);
    expect(
      await requestCode(person.email, new Date(start.getTime() + 11 * 61_000))
    ).toEqual(unknown);
    expect(await mails()).toHaveLength(10);
    expect(await db.select().from(loginCode)).toEqual(before);
  });

  it("limits the whole unit to 200 issued login codes, including concurrent accounts", async () => {
    const people = await Promise.all(
      Array.from({ length: 21 }, (_, i) =>
        createInvitedAccount({
          name: `Synthetic ${i}`,
          role: "technical",
          email: `unit-${i}@example.invalid`,
        })
      )
    );
    for (let round = 0; round < 10; round++)
      await Promise.all(
        people
          .slice(0, 20)
          .map((row) =>
            requestCode(row.email, new Date(start.getTime() + round * 61_000))
          )
      );
    await requestCode(
      people[20].email,
      new Date(start.getTime() + 11 * 61_000)
    );
    expect(await db.select().from(emailOutbox)).toHaveLength(200);
    const [unit] = await db
      .select()
      .from(authBudget)
      .where(
        and(
          eq(authBudget.day, quotaDay(start)),
          eq(authBudget.category, "login-code:issue"),
          eq(authBudget.scope, "unit")
        )
      );
    expect(unit.used).toBe(200);
  });

  it("resets failures on success while retaining the ten-code issuance budget", async () => {
    await db
      .update(user)
      .set({ failedAttempts: 6 })
      .where(eq(user.id, person.id));
    await requestCode(person.email, start);
    const [mail] = await mails();
    await verifyCode(person.email, openSecret(mail.encryptedSecret!), start);
    expect(await current()).toMatchObject({
      failedAttempts: 0,
      nextCodeAllowedAt: null,
    });
    const [budget] = await db
      .select()
      .from(authBudget)
      .where(eq(authBudget.scope, `account:${person.id}`));
    expect(budget.used).toBe(1);
  });

  it("allocates a pair atomically at both account and unit boundaries without partial mail", async () => {
    for (const [scope, used] of [
      [`account:${person.id}`, 9],
      ["unit", 29],
    ] as const) {
      await db.delete(authBudget);
      await db.insert(authBudget).values({
        day: quotaDay(new Date()),
        category: "email-change:issue",
        scope,
        used,
      });
      await expect(
        executeAction(
          {
            id: person.id,
            name: person.name,
            role: "technical",
            securityEpoch: person.securityEpoch,
          },
          {
            type: "technical.email.request",
            idempotencyKey: randomUUID(),
            payload: {
              email: "pair-next@example.invalid",
              reason: "Synthetic change",
            },
          }
        )
      ).rejects.toMatchObject({ status: 429 });
      expect(await mails()).toHaveLength(0);
      expect(
        await db
          .select()
          .from(records)
          .where(eq(records.kind, "technical_email_change"))
      ).toHaveLength(0);
      const [row] = await db
        .select()
        .from(authBudget)
        .where(eq(authBudget.scope, scope));
      expect(row.used).toBe(used);
    }
  });

  it("uses the configured quota-day boundary and retains reservations on cancellation", async () => {
    vi.stubEnv("MAIL_QUOTA_TIME_ZONE", "Asia/Jerusalem");
    const before = new Date("2026-10-07T20:59:59Z"),
      after = new Date("2026-10-07T21:00:00Z");
    expect(
      await db.transaction((tx) =>
        reserveCodeBudget(tx, "email-change", person.id, 10, "issue", before)
      )
    ).toBe(true);
    expect(
      await db.transaction((tx) =>
        reserveCodeBudget(tx, "email-change", person.id, 1, "issue", before)
      )
    ).toBe(false);
    expect(
      await db.transaction((tx) =>
        reserveCodeBudget(tx, "email-change", person.id, 2, "issue", after)
      )
    ).toBe(true);
    expect(
      (
        await db
          .select()
          .from(authBudget)
          .where(eq(authBudget.scope, `account:${person.id}`))
      )
        .map((row) => row.used)
        .sort((a, b) => a - b)
    ).toEqual([2, 10]);
  });

  it("lets only one competing pair take the final two unit slots and never creates half a pair", async () => {
    const other = await createInvitedAccount({
      name: "Synthetic second account",
      email: "pair-other@example.invalid",
      role: "technical",
    });
    await db.insert(authBudget).values({
      day: quotaDay(new Date()),
      category: "email-change:issue",
      scope: "unit",
      used: 28,
    });
    const results = await Promise.allSettled(
      [person, other].map((row) =>
        executeAction(
          {
            id: row.id,
            name: row.name,
            role: "technical",
            securityEpoch: row.securityEpoch,
          },
          {
            type: "technical.email.request",
            idempotencyKey: randomUUID(),
            payload: {
              email: `next-${row.id}@example.invalid`,
              reason: "Synthetic change",
            },
          }
        )
      )
    );
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(await db.select().from(emailOutbox)).toHaveLength(2);
    expect(
      await db
        .select()
        .from(records)
        .where(eq(records.kind, "technical_email_change"))
    ).toHaveLength(1);
    expect(
      (
        await db.select().from(authBudget).where(eq(authBudget.scope, "unit"))
      )[0].used
    ).toBe(30);
  });

  it("charges actual retry attempts atomically and holds mail instead of exceeding the budget", async () => {
    await requestCode(person.email, start);
    await db
      .update(emailOutbox)
      .set({ nextAttemptAt: start, createdAt: start })
      .where(eq(emailOutbox.recipientAccountId, person.id));
    await db.insert(authBudget).values({
      day: quotaDay(start),
      category: "login-code:attempt",
      scope: `account:${person.id}`,
      used: 9,
    });
    let attempts = 0;
    const transport = async () => {
      attempts++;
      throw new MailDeliveryError("transient");
    };
    await deliverNextEmail(transport, start);
    await deliverNextEmail(transport, new Date(start.getTime() + 120_000));
    expect(attempts).toBe(1);
    const [mail] = await mails();
    expect(mail.error).toBe("quota_waiting");
    expect(
      (
        await db
          .select()
          .from(authBudget)
          .where(
            and(
              eq(authBudget.category, "login-code:attempt"),
              eq(authBudget.scope, `account:${person.id}`)
            )
          )
      )[0].used
    ).toBe(10);
  });

  it("retains issuance budgets when a new service connection replaces the old one", async () => {
    const first = connectDatabase(process.env.DATABASE_URL!);
    try {
      expect(
        await first.db.transaction((tx) =>
          reserveCodeBudget(tx, "login-code", person.id, 10, "issue", start)
        )
      ).toBe(true);
    } finally {
      await first.pool.end();
    }
    const restarted = connectDatabase(process.env.DATABASE_URL!);
    try {
      expect(
        await restarted.db.transaction((tx) =>
          reserveCodeBudget(tx, "login-code", person.id, 1, "issue", start)
        )
      ).toBe(false);
    } finally {
      await restarted.pool.end();
    }
  });

  it("returns an identical recovery error for unknown, soldier and technical addresses", async () => {
    const soldierId = randomUUID();
    await db.insert(soldiers).values({
      id: soldierId,
      name: "Synthetic soldier",
      personalNumber: "6543210",
      data: soldier({ id: soldierId, personalNumber: "6543210" }),
    });
    await createInvitedAccount({
      role: "soldier",
      name: "Synthetic soldier",
      email: "soldier@example.invalid",
      soldierId,
    });
    const errors: unknown[] = [];
    for (const email of [
      person.email,
      "unknown@example.invalid",
      "soldier@example.invalid",
    ]) {
      try {
        await recoverAccount(email, "wrong");
      } catch (error) {
        const e = error as { code: string; message: string; status: number };
        errors.push({ code: e.code, message: e.message, status: e.status });
      }
    }
    expect(errors[0]).toEqual(errors[1]);
    expect(errors[0]).toEqual(errors[2]);
    await db
      .update(user)
      .set({ deletedAt: new Date() })
      .where(eq(user.id, person.id));
    await expect(recoverAccount(person.email, "wrong")).rejects.toMatchObject(
      errors[0] as object
    );
  });
});

describe("security #124: atomic IP limits", () => {
  const request = (ip: string) =>
    new Request("http://localhost:3000/api/auth/recovery", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "cf-connecting-ip": ip,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "unknown@example.invalid", code: "wrong" }),
    });
  it("does not trust client-provided proxy headers outside the Tunnel", () => {
    expect(clientBucket(request("203.0.113.7"))).toBe("direct-origin");
    vi.stubEnv("TRUST_CLOUDFLARE_IP", "true");
    expect(clientBucket(request("203.0.113.7"))).toBe("direct-origin");
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "staging");
    expect(clientBucket(request("203.0.113.7"))).toBe("203.0.113.7");
    expect(clientBucket(request("invalid"))).toBe("direct-origin");
    expect(normalizeClientIp("2001:db8:aaaa:bbbb::1")).toBe(
      normalizeClientIp("2001:db8:aaaa:bbbb:ffff::2")
    );
    expect(normalizeClientIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });
  it("enforces 60 requests, 300 verifications and 10 recoveries atomically and persists across calls", async () => {
    for (const [path, limit] of [
      ["request-code", 60],
      ["verify-code", 300],
      ["recovery", 10],
    ] as const) {
      const result = await Promise.allSettled(
        Array.from({ length: limit + 12 }, () =>
          enforceAuthRateLimit(request("203.0.113.7"), path, start)
        )
      );
      expect(result.filter((row) => row.status === "fulfilled")).toHaveLength(
        limit
      );
      await expect(
        enforceAuthRateLimit(request("203.0.113.8"), path, start)
      ).rejects.toMatchObject({ status: 429 });
      await expect(
        enforceAuthRateLimit(
          request("203.0.113.7"),
          path,
          new Date(start.getTime() + 60_000)
        )
      ).resolves.toBeUndefined();
    }
    expect(
      (await db.select().from(authRateLimit)).every(
        (row) => !row.key.includes("203.0.113")
      )
    ).toBe(true);
  });
  it("applies the rate limit at the public authentication route", async () => {
    for (let i = 0; i < 10; i++)
      expect((await POST(request(`203.0.113.${i}`))).status).toBe(401);
    expect((await POST(request("203.0.113.99"))).status).toBe(429);
  });
});
