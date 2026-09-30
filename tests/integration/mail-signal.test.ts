import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { soldiers, soldierContacts, balances } from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { requestCode } from "../../src/server/auth/otp";
import {
  deliverNextEmail,
  enqueueEmail,
  type MailMessage,
} from "../../src/server/operations/email";
import {
  MAIL_CHANNEL,
  listenForMail,
  singleFlight,
} from "../../src/server/operations/mail-signal";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

const memberEmail = "signal-member@example.invalid";
let memberId: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name: "חייל אות",
    personalNumber: "5000001",
    data: soldier({ id, name: "חייל אות", personalNumber: "5000001" }),
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: memberEmail });
  await db.insert(balances).values({ soldierId: id });
  memberId = (
    await createInvitedAccount({
      name: "חייל אות",
      email: memberEmail,
      soldierId: id,
    })
  ).id;
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
afterAll(async () => pool.end());

/** A raw LISTEN on the channel, collecting what PostgreSQL delivers. */
async function observe() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const seen: string[] = [];
  client.on("notification", (message) => seen.push(message.channel));
  await client.query(`listen ${MAIL_CHANNEL}`);
  cleanups.push(() => client.end());
  return seen;
}
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function waitFor(check: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await settle(20);
  }
  return Date.now() - start;
}

/** The worker's wiring, with a synthetic transport instead of Brevo. */
async function startWorkerListener() {
  const sent: MailMessage[] = [];
  const drain = singleFlight(async () => {
    for (let index = 0; index < 20; index++) {
      const result = await deliverNextEmail(async (message) => {
        sent.push(message);
        return `synthetic-${sent.length}`;
      });
      if (result.status === "idle") break;
    }
  });
  let connections = 0;
  const listener = listenForMail(() => void drain(), {
    retryMs: 50,
    onListening: () => connections++,
  });
  cleanups.push(async () => {
    await listener.stop();
    await drain.settled();
  });
  await waitFor(() => connections > 0);
  await drain.settled();
  return { sent, connections: () => connections };
}

describe("codes are sent at once after commit (decision 188)", () => {
  it("signals a committed code only, not a rolled-back code or other mail", async () => {
    const seen = await observe();
    await db
      .transaction(async (tx) => {
        await enqueueEmail(tx, {
          recipientAccountId: memberId,
          eventKey: `login:${randomUUID()}`,
          kind: "login-code",
          title: "קוד",
          body: "{{CODE}}",
          secret: "123456",
          expiresAt: new Date(Date.now() + 600_000),
        });
        throw new Error("rolled back");
      })
      .catch(() => undefined);
    await db.transaction((tx) =>
      enqueueEmail(tx, {
        recipientAccountId: memberId,
        eventKey: `synthetic:${randomUUID()}`,
        kind: "publication",
        title: "הודעה",
        body: "תוכן",
        expiresAt: new Date(Date.now() + 3_600_000),
      })
    );
    await settle(300);
    expect(seen).toEqual([]);

    await requestCode(memberEmail);
    await waitFor(() => seen.length > 0);
    expect(seen).toEqual([MAIL_CHANNEL]);
  });

  it("delivers a requested code within seconds, without the minute's maintenance", async () => {
    const worker = await startWorkerListener();
    const elapsed = await (async () => {
      await requestCode(memberEmail);
      return waitFor(() => worker.sent.length > 0);
    })();
    expect(elapsed).toBeLessThan(5_000);
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0]).toMatchObject({ to: memberEmail });
    expect(worker.sent[0].text).toMatch(/\d{6}/);
  });

  it("reconnects after losing its connection and sends a code committed meanwhile", async () => {
    const worker = await startWorkerListener();
    await db.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity where query = ${`listen ${MAIL_CHANNEL}`} and pid <> pg_backend_pid()`
    );
    await requestCode(memberEmail);
    await waitFor(() => worker.connections() > 1);
    await waitFor(() => worker.sent.length > 0);
    expect(worker.sent[0]).toMatchObject({ to: memberEmail });
  });

  it("coalesces a burst of signals into one more run, never two at once", async () => {
    let active = 0;
    let most = 0;
    let runs = 0;
    const drain = singleFlight(async () => {
      runs++;
      most = Math.max(most, ++active);
      await settle(30);
      active--;
    });
    await Promise.all([drain(), drain(), drain(), drain()]);
    expect(most).toBe(1);
    expect(runs).toBe(2);
    await drain();
    expect(runs).toBe(3);
  });
});
