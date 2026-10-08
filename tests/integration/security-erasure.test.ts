import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  balances,
  commandResults,
  commandResultSubjects,
  dutyTypes,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { createRecord } from "../../src/server/repository";
import { eraseRelatedCopies } from "../../src/server/soldier-deletion";
import { expireCommandResults } from "../../src/server/command-results";
import {
  deliverNextEmail,
  enqueueEmail,
} from "../../src/server/operations/email";
import { verifyRestoredData } from "../../src/server/operations/restore";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("A dedicated test database is required");
let manager: Actor, member: Actor, other: Actor;
async function invite(number: string, role: "manager" | "soldier" = "soldier") {
  const id = randomUUID(),
    name = `Synthetic ${number}`,
    email = `${number}@example.invalid`;
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber: number,
    data: soldier({ id, name, personalNumber: number }),
  });
  await db.insert(soldierContacts).values({ soldierId: id, email });
  await db.insert(balances).values({ soldierId: id });
  const account = await createInvitedAccount({
    name,
    email,
    role,
    soldierId: id,
  });
  return {
    id: account.id,
    role,
    name,
    soldierId: id,
    securityEpoch: 1,
  } as Actor;
}
const run = async (
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number,
  key = randomUUID()
) =>
  (await executeAction(manager, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: key,
  })) as Record<string, unknown> & { id: string; version: number };
async function removal() {
  const [person] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, member.soldierId!));
  const preview = await run(
    "soldier.delete.preview",
    { id: person.id },
    person.version
  );
  return {
    type: "soldier.delete",
    payload: {
      id: person.id,
      confirmed: true,
      reason: "Synthetic deletion",
      previewToken: preview.previewToken,
    },
    expectedVersion: person.version,
    idempotencyKey: randomUUID(),
  };
}
async function workflowMail(status = "pending") {
  const request = await db.transaction((tx) =>
    createRecord(
      tx,
      "request",
      {
        type: "transfer",
        status: "completed",
        fromSoldierId: member.soldierId,
        acceptedBy: other.soldierId,
        candidates: [{ soldierId: other.soldierId, status: "accepted" }],
      },
      member.soldierId
    )
  );
  await db.transaction((tx) =>
    enqueueEmail(tx, {
      recipientAccountId: other.id,
      eventKey: `transfer:${request.id}:completed:${other.id}`,
      kind: "transfer",
      title: "Synthetic private decision",
      body: "Historical private reason",
      expiresAt: new Date(Date.now() + 86400_000),
    })
  );
  if (status !== "pending")
    await db
      .update(emailOutbox)
      .set({ status })
      .where(eq(emailOutbox.requestId, request.id));
  return (
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.requestId, request.id))
  )[0];
}
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("920001", "manager");
  member = await invite("920002");
  other = await invite("920003");
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => pool.end());

describe("security #126: all retained copies", () => {
  it.each(["pending", "sending", "sent", "failed"])(
    "erases the other party's %s mail by request",
    async (status) => {
      const mail = await workflowMail(status);
      await executeAction(manager, await removal());
      const [copy] = await db
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.id, mail.id));
      expect(copy).toMatchObject({
        status: "cancelled",
        title: "",
        body: "",
        href: null,
        encryptedSecret: null,
        destination: null,
        providerId: null,
      });
      expect(
        (await db.select().from(user).where(eq(user.id, other.id)))[0].deletedAt
      ).toBeNull();
    }
  );

  it("scrubs historical contact-only results before erasing contact revisions and conservatively scrubs unlinked legacy results", async () => {
    const historic = "historic-contact@example.invalid";
    await db.transaction((tx) =>
      createRecord(
        tx,
        "import_row",
        {
          values: { email: historic },
          changes: [
            { key: "email", before: historic, after: "920002@example.invalid" },
          ],
        },
        member.soldierId
      )
    );
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(commandResults).values([
      {
        id: ids[0],
        actorId: manager.id,
        requestKey: randomUUID(),
        payloadHash: "historical",
        result: { address: historic },
        linkageComplete: true,
      },
      {
        id: ids[1],
        actorId: manager.id,
        requestKey: randomUUID(),
        payloadHash: "unknown",
        result: { opaque: "private old data" },
      },
      {
        id: ids[2],
        actorId: manager.id,
        requestKey: randomUUID(),
        payloadHash: "unrelated",
        result: { safe: "unit configuration" },
        linkageComplete: true,
      },
    ]);
    await executeAction(manager, await removal());
    const all = await db.select().from(commandResults);
    expect(all.find((row) => row.id === ids[0])?.result).toMatchObject({
      erasedAt: expect.any(String),
    });
    expect(all.find((row) => row.id === ids[1])?.result).toMatchObject({
      erasedAt: expect.any(String),
    });
    expect(all.find((row) => row.id === ids[2])?.result).toEqual({
      safe: "unit configuration",
    });
  });

  it("erases an opaque result by its explicit subject and keeps its replay key and fingerprint", async () => {
    const id = randomUUID(),
      key = randomUUID();
    await db.insert(commandResults).values({
      id,
      actorId: manager.id,
      requestKey: key,
      payloadHash: "stable-fingerprint",
      result: { opaque: "synthetic sensitive result" },
      linkageComplete: true,
    });
    await db.insert(commandResultSubjects).values({
      id: randomUUID(),
      commandId: id,
      soldierId: member.soldierId!,
    });
    await executeAction(manager, await removal());
    expect(
      (
        await db.select().from(commandResults).where(eq(commandResults.id, id))
      )[0]
    ).toMatchObject({
      requestKey: key,
      payloadHash: "stable-fingerprint",
      result: { erasedAt: expect.any(String) },
    });
  });

  it("completes the subject links of an import preview after the new soldier is created, then erases its replay content", async () => {
    const key = randomUUID(),
      payload = {
        filename: "synthetic.xlsx",
        rows: [
          {
            rowNumber: 2,
            values: {
              personalNumber: "920004",
              name: "Synthetic imported",
              email: "new-import@example.invalid",
            },
          },
        ],
      };
    const preview = await run("import.preview", payload, undefined, key);
    const [prior] = await db
      .select()
      .from(commandResults)
      .where(eq(commandResults.requestKey, key));
    expect(prior.importBatchId).toBe(preview.id);
    await run(
      "import.apply",
      { id: preview.id, confirmed: true, reason: "Synthetic intake" },
      1
    );
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.personalNumber, "920004"));
    expect(
      await db
        .select()
        .from(commandResultSubjects)
        .where(
          and(
            eq(commandResultSubjects.commandId, prior.id),
            eq(commandResultSubjects.soldierId, person.id)
          )
        )
    ).toHaveLength(1);
    const deletion = await run(
      "soldier.delete.preview",
      { id: person.id },
      person.version
    );
    await run(
      "soldier.delete",
      {
        id: person.id,
        confirmed: true,
        reason: "Synthetic removal",
        previewToken: deletion.previewToken,
      },
      person.version
    );
    expect(await run("import.preview", payload, undefined, key)).toMatchObject({
      erasedAt: expect.any(String),
    });
    expect(
      (await db.select().from(records).where(eq(records.kind, "import"))).length
    ).toBe(1);
  });
});

describe("security #126: retention and dispatch", () => {
  it("detects expired unpruned results and false tombstones in restore checks even without a deleted soldier", async () => {
    await db.insert(commandResults).values([
      {
        id: randomUUID(),
        actorId: manager.id,
        requestKey: randomUUID(),
        payloadHash: "old",
        result: { private: "old retained data" },
        linkageComplete: true,
        createdAt: new Date(Date.now() - 31 * 86400_000),
      },
      {
        id: randomUUID(),
        actorId: manager.id,
        requestKey: randomUUID(),
        payloadHash: "false marker",
        result: {
          erasedAt: new Date().toISOString(),
          private: "restored data",
        },
        linkageComplete: true,
        contentExpiredAt: new Date(),
      },
    ]);
    const checks = await verifyRestoredData(db, new Date());
    expect(
      checks.find((check) => check.id === "command_result_retention")?.status
    ).toBe("fail");
  });
  it("expires content at 30 days and never reexecutes an old key, including conflict checks", async () => {
    const key = randomUUID(),
      payload = {
        name: "Synthetic type",
        pricing: { mode: "fixed", base: 4 },
        roles: [{ name: "תורן", count: 1 }],
      };
    await run("dutyType.save", payload, undefined, key);
    const [prior] = await db
      .select()
      .from(commandResults)
      .where(eq(commandResults.requestKey, key));
    await db
      .update(commandResults)
      .set({ createdAt: new Date(Date.now() - 31 * 86400_000) })
      .where(eq(commandResults.id, prior.id));
    expect(await run("dutyType.save", payload, undefined, key)).toMatchObject({
      expiredAt: expect.any(String),
    });
    expect(await db.select().from(dutyTypes)).toHaveLength(1);
    await expect(
      run("dutyType.save", { ...payload, name: "Changed type" }, undefined, key)
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    const retained = (
      await db
        .select()
        .from(commandResults)
        .where(eq(commandResults.id, prior.id))
    )[0];
    expect(retained.payloadHash).toBe(prior.payloadHash);
    expect(retained.requestKey).toBe(key);
  });

  it("prunes content at the exact 30-day boundary while retaining newer results", async () => {
    const now = new Date(),
      old = randomUUID(),
      fresh = randomUUID();
    await db.insert(commandResults).values([
      {
        id: old,
        actorId: manager.id,
        requestKey: randomUUID(),
        payloadHash: "old",
        result: { private: "old" },
        createdAt: new Date(now.getTime() - 30 * 86400_000),
        linkageComplete: true,
      },
      {
        id: fresh,
        actorId: manager.id,
        requestKey: randomUUID(),
        payloadHash: "fresh",
        result: { private: "fresh" },
        createdAt: new Date(now.getTime() - 30 * 86400_000 + 1),
        linkageComplete: true,
      },
    ]);
    await db.transaction((tx) => expireCommandResults(tx, now));
    const all = await db.select().from(commandResults);
    expect(all.find((row) => row.id === old)?.result).toEqual({
      expiredAt: now.toISOString(),
    });
    expect(all.find((row) => row.id === fresh)?.result).toEqual({
      private: "fresh",
    });
  });

  it("refuses a claimed copy when deletion commits before dispatch begins", async () => {
    const mail = await workflowMail(),
      command = await removal();
    const real = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction");
    spy.mockImplementationOnce(real);
    spy.mockImplementationOnce(async (work, config) => {
      spy.mockRestore();
      await executeAction(manager, command);
      return real(work, config);
    });
    let sent = 0;
    expect(
      await deliverNextEmail(async () => {
        sent++;
        return "synthetic";
      })
    ).toEqual({ status: "skipped" });
    expect(sent).toBe(0);
    expect(
      (
        await db.select().from(emailOutbox).where(eq(emailOutbox.id, mail.id))
      )[0].body
    ).toBe("");
  });

  it("serializes erasure with an already-started dispatch and removes the local copy after delivery", async () => {
    const mail = await workflowMail(),
      command = await removal();
    let signal!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = deliverNextEmail(async () => {
      signal();
      await held;
      return "synthetic";
    });
    await started;
    let deleted = false;
    const deleting = executeAction(manager, command).then(() => {
      deleted = true;
    });
    try {
      await vi.waitFor(async () => {
        const blocked = await pool.query(
          "select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%email_outbox%' and pid <> pg_backend_pid()"
        );
        expect(blocked.rowCount).toBeGreaterThan(0);
      });
      expect(deleted).toBe(false);
    } finally {
      release();
    }
    expect(await sending).toEqual({ status: "sent" });
    await deleting;
    expect(
      (
        await db.select().from(emailOutbox).where(eq(emailOutbox.id, mail.id))
      )[0]
    ).toMatchObject({ status: "cancelled", body: "", providerId: null });
  });

  it("detects deleted subjects and counterpart mail in a restored copy, and applies the same erasure rules", async () => {
    const mail = await workflowMail("sent"),
      id = randomUUID();
    await db.insert(commandResults).values({
      id,
      actorId: manager.id,
      requestKey: randomUUID(),
      payloadHash: "restored",
      result: { opaque: "restored private data" },
      linkageComplete: true,
      createdAt: new Date(Date.now() - 1000),
    });
    await db.insert(commandResultSubjects).values({
      id: randomUUID(),
      commandId: id,
      soldierId: member.soldierId!,
    });
    await db
      .update(soldiers)
      .set({ deletedAt: new Date() })
      .where(eq(soldiers.id, member.soldierId!));
    const before = await verifyRestoredData(db, new Date());
    expect(
      before.find((check) => check.id === "deleted_soldier_residue")?.status
    ).toBe("fail");
    await unitTransaction((tx) =>
      eraseRelatedCopies(
        tx,
        member.soldierId!,
        member.id,
        [],
        new Date().toISOString()
      )
    );
    expect(
      (
        await db.select().from(commandResults).where(eq(commandResults.id, id))
      )[0].result
    ).toMatchObject({ erasedAt: expect.any(String) });
    expect(
      (
        await db.select().from(emailOutbox).where(eq(emailOutbox.id, mail.id))
      )[0].body
    ).toBe("");
  });
});
