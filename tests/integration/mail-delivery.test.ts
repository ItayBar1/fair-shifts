import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { emailOutbox, emailQuota } from "../../src/server/auth-schema";
import {
  balances,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { requestCode } from "../../src/server/auth/otp";
import { createRecord } from "../../src/server/repository";
import { readState } from "../../src/server/state";
import {
  MailDeliveryError,
  deliverNextEmail,
  enqueueEmail,
  quotaDay,
  readMailStatus,
  type MailMessage,
} from "../../src/server/operations/email";
import type { EmailKind } from "../../src/domain/notification-preferences";
import { RETRY_DELAYS_MS } from "../../src/domain/mail-delivery";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

const memberEmail = "mail-member@example.invalid";
let member: Actor;
let technical: Actor;
const transportSetting = process.env.MAIL_TRANSPORT;

async function invite(name: string, email: string, personalNumber: string) {
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber,
    data: soldier({ id, name, personalNumber }),
  });
  await db.insert(soldierContacts).values({ soldierId: id, email });
  await db.insert(balances).values({ soldierId: id });
  const row = await createInvitedAccount({
    name,
    role: "soldier",
    email,
    soldierId: id,
  });
  return {
    id: row.id,
    name,
    role: "soldier",
    soldierId: id,
    securityEpoch: 1,
  } as Actor;
}
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  member = await invite("חייל מייל", memberEmail, "30001");
  const tech = await createInvitedAccount({
    name: "טכני מייל",
    role: "technical",
    email: "mail-technical@example.invalid",
  });
  technical = {
    id: tech.id,
    name: tech.name,
    role: "technical",
    securityEpoch: 1,
  };
});
afterEach(() => {
  process.env.MAIL_TRANSPORT = transportSetting;
});
afterAll(async () => pool.end());

type Queued = {
  kind?: EmailKind;
  eventKey?: string;
  href?: string;
  priority?: number;
  expiresInMs?: number;
};
async function queue(options: Queued = {}) {
  const eventKey = options.eventKey ?? `synthetic:${randomUUID()}`;
  await db.transaction((tx) =>
    enqueueEmail(tx, {
      recipientAccountId: member.id,
      eventKey,
      kind: options.kind ?? "publication",
      title: "הודעה סינתטית",
      body: "תוכן סינתטי",
      href: options.href,
      priority: options.priority,
      expiresAt: new Date(Date.now() + (options.expiresInMs ?? 3600_000)),
    })
  );
  return eventKey;
}
async function row(eventKey: string) {
  const [found] = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.eventKey, eventKey));
  return found;
}
async function setUsed(used: number, now = new Date()) {
  await db
    .insert(emailQuota)
    .values({ day: quotaDay(now), used })
    .onConflictDoUpdate({ target: emailQuota.day, set: { used } });
}
async function used(now = new Date()) {
  const [quota] = await db
    .select()
    .from(emailQuota)
    .where(eq(emailQuota.day, quotaDay(now)));
  return quota?.used ?? 0;
}
/** Deliver until the queue has nothing it may send at `now`. */
async function drain(now: Date, sent: string[] = []) {
  for (let index = 0; index < 1000; index++) {
    const result = await deliverNextEmail(async (message) => {
      sent.push(message.eventKey);
      return `synthetic-${message.eventKey}`;
    }, now);
    if (result.status === "idle") break;
  }
  return sent;
}
const later = (ms: number) => new Date(Date.now() + ms);

describe("shared quota and the code reserve", () => {
  it("sends 290 of three waves of 120, keeps the rest for the next day and never counts 360", async () => {
    const sent: string[] = [];
    // Expiring after 30 hours keeps the remainder relevant into the next quota day.
    for (let wave = 0; wave < 3; wave++) {
      await db.transaction(async (tx) => {
        for (let index = 0; index < 120; index++)
          await enqueueEmail(tx, {
            recipientAccountId: member.id,
            eventKey: `wave:${wave}:${index}`,
            kind: "publication",
            title: "גל",
            body: "גל",
            expiresAt: later(30 * 3600_000),
          });
      });
      await drain(later(1000), sent);
    }
    expect(sent).toHaveLength(290);
    expect(await used(later(1000))).toBe(290);
    const status = await readMailStatus(db, later(1000));
    expect(status).toMatchObject({
      quotaExhausted: true,
      waitingForQuota: 70,
      limit: 300,
      reserve: 10,
    });
    // A new quota day sends what is still relevant.
    const nextDay = new Date(`${quotaDay(later(86_400_000))}T00:01:00Z`);
    await drain(nextDay, sent);
    expect(sent).toHaveLength(360);
    expect(new Set(sent).size).toBe(360);
    expect(await used(nextDay)).toBe(70);
  }, 120_000);

  it("holds business mail at 290 and still sends a sign-in code from the reserve", async () => {
    const now = later(1000);
    await setUsed(289, now);
    const first = await queue();
    const second = await queue();
    expect(await drain(now)).toEqual([first]);
    expect(await row(second)).toMatchObject({
      status: "pending",
      error: "quota_waiting",
    });
    await requestCode(memberEmail);
    const sent = await drain(later(2000));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^login:/);
    expect(await used(now)).toBe(291);
    expect(await row(second)).toMatchObject({ status: "pending" });
  });

  it("does not overspend or send one event twice when workers compete", async () => {
    const now = later(1000);
    await setUsed(270, now);
    const keys: string[] = [];
    for (let index = 0; index < 40; index++) keys.push(await queue());
    const sent: string[] = [];
    const worker = async () => {
      for (let index = 0; index < 50; index++) {
        const result = await deliverNextEmail(async (message) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          sent.push(message.eventKey);
          return "synthetic";
        }, now);
        if (result.status === "idle") return;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    expect(sent).toHaveLength(20);
    expect(new Set(sent).size).toBe(20);
    expect(await used(now)).toBe(290);
    const rows = await db.select().from(emailOutbox);
    expect(rows.filter((item) => item.status === "sent")).toHaveLength(20);
    expect(rows.every((item) => item.attempts <= 1)).toBe(true);
  });

  it("never sends an expired code, and reports one that expired waiting for quota", async () => {
    await requestCode(memberEmail);
    const calls: MailMessage[] = [];
    const record = async (message: MailMessage) => {
      calls.push(message);
      return "synthetic";
    };
    expect((await deliverNextEmail(record, later(11 * 60_000))).status).toBe(
      "idle"
    );
    const [expired] = await db.select().from(emailOutbox);
    expect(expired).toMatchObject({
      status: "cancelled",
      error: "expired",
      encryptedSecret: null,
    });

    await db.delete(emailOutbox);
    await setUsed(300);
    await requestCode(memberEmail, later(120_000));
    expect((await deliverNextEmail(record, later(130_000))).status).toBe(
      "idle"
    );
    expect((await deliverNextEmail(record, later(13 * 60_000))).status).toBe(
      "idle"
    );
    const [waited] = await db.select().from(emailOutbox);
    expect(waited).toMatchObject({
      status: "failed",
      error: "quota_exhausted",
      encryptedSecret: null,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("retries and failures", () => {
  it("retries with growing delays, then fails visibly while the site notice stays", async () => {
    process.env.MAIL_TRANSPORT = "brevo";
    const key = await queue({ expiresInMs: 20 * 3600_000 });
    await db.transaction((tx) =>
      createRecord(tx, "notification", {
        accountId: member.id,
        title: "הודעה סינתטית",
        body: "תוכן סינתטי",
      })
    );
    let calls = 0;
    // Provider text can include addresses; it must never reach the database.
    const failing = async () => {
      calls++;
      throw new Error(`bounce for ${memberEmail}`);
    };
    let at = later(1000);
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await deliverNextEmail(failing, at)).status).toBe("failed");
      const current = await row(key);
      expect(current.attempts).toBe(attempt);
      if (attempt < 5) {
        expect(current).toMatchObject({
          status: "pending",
          error: "delivery_failed",
        });
        waits.push(current.nextAttemptAt.getTime() - at.getTime());
        // Nothing is sent before the wait ends.
        expect(
          (await deliverNextEmail(failing, new Date(at.getTime() + 1000)))
            .status
        ).toBe("idle");
        at = current.nextAttemptAt;
      }
    }
    expect(waits).toEqual(RETRY_DELAYS_MS);
    expect(calls).toBe(5);
    const failed = await row(key);
    expect(failed).toMatchObject({
      status: "failed",
      error: "delivery_failed",
    });
    expect(JSON.stringify(failed)).not.toContain(memberEmail);

    const status = await readMailStatus(db, at);
    expect(status.status).toBe("attention");
    expect(status.failures).toHaveLength(1);
    expect(status.failures[0]).toMatchObject({
      kind: "publication",
      error: "delivery_failed",
      attempts: 5,
    });
    expect(JSON.stringify(status)).not.toMatch(
      /example\.invalid|הודעה סינתטית|תוכן סינתטי/
    );
    const notices = await db
      .select()
      .from(records)
      .where(eq(records.kind, "notification"));
    expect(notices).toHaveLength(1);
  });

  it("stops retrying when the message is no longer relevant", async () => {
    const key = await queue({ expiresInMs: 30 * 60_000 });
    const failing = async () => {
      throw new MailDeliveryError("transient");
    };
    let at = later(1000);
    for (let attempt = 0; attempt < 3; attempt++) {
      await deliverNextEmail(failing, at);
      at = (await row(key)).nextAttemptAt;
    }
    // The fourth attempt would come after the message expired.
    expect((await deliverNextEmail(failing, at)).status).toBe("idle");
    expect(await row(key)).toMatchObject({
      status: "failed",
      error: "delivery_failed",
      attempts: 3,
    });
  });

  it("fails a rejected address at once and clears the destination", async () => {
    const key = await queue();
    await deliverNextEmail(async () => {
      throw new MailDeliveryError("permanent");
    }, later(1000));
    expect(await row(key)).toMatchObject({
      status: "failed",
      error: "rejected",
      attempts: 1,
      destination: null,
    });
  });

  it("never hands a reserved test address to the real provider, and charges no quota", async () => {
    process.env.MAIL_TRANSPORT = "brevo";
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      throw new Error("the provider must not be called");
    }) as typeof fetch;
    try {
      const key = await queue();
      expect(await deliverNextEmail(undefined, later(1000))).toEqual({
        status: "skipped",
      });
      expect(await row(key)).toMatchObject({
        status: "cancelled",
        error: "reserved_address",
        attempts: 0,
        destination: null,
      });
      expect(calls).toEqual([]);
      const [quota] = await db.select().from(emailQuota);
      expect(quota?.used ?? 0).toBe(0);
      // A code for a reserved address is dropped the same way.
      await requestCode(memberEmail, later(2000));
      await deliverNextEmail(undefined, later(3000));
      const [code] = await db
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.kind, "login-code"));
      expect(code).toMatchObject({
        status: "cancelled",
        error: "reserved_address",
        encryptedSecret: null,
      });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("pauses all mail on an account problem without spending the message's attempts", async () => {
    process.env.MAIL_TRANSPORT = "brevo";
    const key = await queue();
    const other = await queue();
    const start = later(1000);
    const result = await deliverNextEmail(async () => {
      throw new MailDeliveryError("configuration");
    }, start);
    expect(result).toMatchObject({
      status: "failed",
      category: "configuration",
    });
    expect(await row(key)).toMatchObject({ status: "pending", attempts: 0 });
    const status = await readMailStatus(db, start);
    expect(status).toMatchObject({
      status: "attention",
      paused: { reason: "configuration" },
    });
    let calls = 0;
    const working = async (message: MailMessage) => {
      calls++;
      return message.eventKey;
    };
    expect((await deliverNextEmail(working, later(5 * 60_000))).status).toBe(
      "idle"
    );
    expect(calls).toBe(0);
    const resumed = await drain(later(16 * 60_000));
    expect(resumed.sort()).toEqual([key, other].sort());
    expect((await readMailStatus(db, later(16 * 60_000))).paused).toBeNull();
  });

  it("stops for the day when the provider reports its own quota is spent", async () => {
    process.env.MAIL_TRANSPORT = "brevo";
    const key = await queue({ expiresInMs: 30 * 3600_000 });
    const start = later(1000);
    await deliverNextEmail(async () => {
      throw new MailDeliveryError("provider_quota");
    }, start);
    expect(await row(key)).toMatchObject({
      status: "pending",
      attempts: 0,
      error: "quota_waiting",
    });
    const status = await readMailStatus(db, start);
    expect(status).toMatchObject({
      quotaExhausted: true,
      paused: { reason: "provider_quota" },
    });
    expect(new Date(status.paused!.until!).toISOString()).toBe(
      new Date(`${quotaDay(later(86_400_000))}T00:00:00Z`).toISOString()
    );
    const nextDay = new Date(`${quotaDay(later(86_400_000))}T00:01:00Z`);
    expect(await drain(nextDay)).toEqual([key]);
  });
});

describe("relevance and content", () => {
  it("sends only the newest published version of a duty", async () => {
    const dutyId = randomUUID();
    const older = await queue({
      eventKey: `publish:${dutyId}:1:${member.id}`,
      kind: "publication",
    });
    const newer = await queue({
      eventKey: `update:${dutyId}:2:${member.id}`,
      kind: "publication-change",
    });
    const unrelated = await queue({
      eventKey: `publish:${randomUUID()}:1:${member.id}`,
    });
    expect((await drain(later(1000))).sort()).toEqual(
      [newer, unrelated].sort()
    );
    expect(await row(older)).toMatchObject({
      status: "cancelled",
      error: "superseded",
    });
  });

  it("sends a short summary with a sign-in link and nothing else", async () => {
    await queue({ href: "/duties/abc" });
    const messages: MailMessage[] = [];
    await deliverNextEmail(async (message) => {
      messages.push(message);
      return "synthetic";
    }, later(1000));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      to: memberEmail,
      subject: "הודעה סינתטית",
    });
    expect(messages[0].text).toBe(
      `תוכן סינתטי\n\nלפרטים באתר (נדרשת כניסה): ${new URL(
        "/duties/abc",
        process.env.BETTER_AUTH_URL ?? "http://localhost:3000"
      ).toString()}`
    );
  });

  it("shows the mail status to the technical admin only", async () => {
    await queue();
    const view = (await readState(technical)) as Record<string, unknown>;
    expect(view.mail).toMatchObject({ pending: 1, used: 0, limit: 300 });
    expect(JSON.stringify(view.operations)).not.toContain(memberEmail);
    expect(JSON.stringify(view)).not.toContain("תוכן סינתטי");
    const soldierView = await readState(member);
    expect("mail" in soldierView).toBe(false);
  });
});

describe("delay notice on the login page", () => {
  const unknown = "not-registered@example.invalid";
  it("tells every address the same thing, and only when codes cannot go out", async () => {
    // Nothing is wrong: no notice for anyone.
    expect(await requestCode(memberEmail)).toEqual({ success: true });
    expect(await requestCode(unknown)).toEqual({ success: true });

    // Mail is paused by an account problem at the provider.
    await queue();
    await deliverNextEmail(async () => {
      throw new MailDeliveryError("configuration");
    }, later(1000));
    const paused = later(2 * 60_000);
    const answers = [
      await requestCode(memberEmail, paused),
      await requestCode(unknown, paused),
    ];
    expect(answers).toEqual([
      { success: true, mailDelayed: true },
      { success: true, mailDelayed: true },
    ]);
    // After the pause ends the notice goes away.
    expect(await requestCode(unknown, later(20 * 60_000))).toEqual({
      success: true,
    });
  });

  it("shows the notice once even the code reserve is spent, not before", async () => {
    await setUsed(299);
    expect(await requestCode(unknown)).toEqual({ success: true });
    await setUsed(300);
    expect(await requestCode(unknown)).toEqual({
      success: true,
      mailDelayed: true,
    });
    expect(await requestCode(memberEmail)).toEqual({
      success: true,
      mailDelayed: true,
    });
  });
});
