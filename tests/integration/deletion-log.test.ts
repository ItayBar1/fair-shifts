import { nextEntry, parseLog, testLogKeys } from "../log-keys";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import {
  emailOutbox,
  operationsState,
  session,
  user,
} from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  calendarEvent,
  calendarLink,
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
import { eraseSoldier } from "../../src/server/soldier-deletion";
import {
  DELETION_LOG_FILE,
  DELETION_LOG_LOCK,
  drainDeletionLog,
  mergeState,
  readDeletionLogStatus,
  readState as readLogState,
  verifyDeletionLog,
  type DeletionLogConfig,
} from "../../src/server/operations/deletion-log";
import { directoryStorage } from "../../src/server/operations/backup-storage";
import {
  DELETION_LOG_BLOCKER,
  raiseRestoreBlocker,
  readRestoreGate,
} from "../../src/server/operations/restore-gate";
import {
  ACKNOWLEDGEMENT,
  acknowledgeUnverifiedLog,
  applyLoggedDeletions,
} from "../../src/server/restore-deletions";
import { deliverNextEmail } from "../../src/server/operations/email";
import { serializeEntry, type LogEntry } from "../../src/domain/deletion-log";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// The independent deletion log and the restore gate (ticket #34, decision 196). Synthetic people only.
const DAY = 86_400_000;
let manager: Actor;
let technical: Actor;
let people: Actor[];
let directory: string;
let store: string;
const roots: string[] = [];

const config = (): DeletionLogConfig => ({
  directory,
  ...testLogKeys,
  storage: directoryStorage(store),
});
const localPath = () => join(directory, DELETION_LOG_FILE);
const lines = async () =>
  (await readFile(localPath(), "utf8")).split("\n").filter(Boolean);
const storedFiles = async () =>
  (await readdir(store)).filter((name) => name.includes("deletion-log"));
async function stored() {
  const [name] = await storedFiles();
  return name ? readFile(join(store, name), "utf8") : undefined;
}

async function invite(
  name: string,
  role: "soldier" | "manager" | "technical",
  personalNumber: string
): Promise<Actor> {
  const soldierId = role === "technical" ? undefined : randomUUID();
  if (soldierId) {
    await db.insert(soldiers).values({
      id: soldierId,
      name,
      personalNumber,
      data: soldier({ id: soldierId, name, personalNumber }),
    });
    await db.insert(soldierContacts).values({
      soldierId,
      email: `${personalNumber}@example.invalid`,
      phone: `050${personalNumber}`,
      address: `רחוב הדגמה ${personalNumber}`,
    });
    await db.insert(balances).values({ soldierId });
  }
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
  expectedVersion?: number
) {
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as { id: string; version: number } & Record<string, unknown>;
}
async function remove(person: Actor) {
  const [row] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, person.soldierId!));
  const impact = (await command(
    manager,
    "soldier.delete.preview",
    { id: person.soldierId },
    row.version
  )) as unknown as { previewToken: string };
  return command(
    manager,
    "soldier.delete",
    {
      id: person.soldierId,
      previewToken: impact.previewToken,
      reason: "שוחרר מהשירות",
      confirmed: true,
    },
    row.version
  );
}
async function pendingRecords() {
  return (
    await db
      .select()
      .from(records)
      .where(eq(records.kind, "deletion_log_entry"))
  ).filter((row) => row.data.status === "pending");
}
async function soldierRow(person: Actor) {
  const [row] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, person.soldierId!));
  return row;
}
/** The entry a deletion made after a backup would have in the log. */
function entryFor(
  last: LogEntry | undefined,
  soldierId: string,
  at = "2026-10-01T10:00:00.000Z"
) {
  return nextEntry(last, { id: randomUUID(), soldierId, at });
}
async function writeLocal(entries: LogEntry[]) {
  await writeFile(localPath(), entries.map(serializeEntry).join(""));
}
async function localEntries() {
  return parseLog(await readFile(localPath(), "utf8")).entries;
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  directory = await mkdtemp(join(tmpdir(), "fs-deletion-log-"));
  store = await mkdtemp(join(tmpdir(), "fs-deletion-store-"));
  roots.push(directory, store);
  manager = await invite("אחראי יומן", "manager", "00501");
  technical = await invite("טכני יומן", "technical", "00500");
  people = [];
  for (const [index, name] of ["ראשון", "שני", "שלישי", "רביעי"].entries())
    people.push(await invite(`חייל ${name}`, "soldier", `0051${index}`));
  delete process.env.RESTORE_MODE;
});
afterEach(() => {
  delete process.env.RESTORE_MODE;
});
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  await pool.end();
});

describe("writing the log", () => {
  it("queues a deletion in its own commit and appends it once, with ids and a time only", async () => {
    const [first] = people;
    await remove(first!);
    const pending = await pendingRecords();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.subjectId).toBe(first!.soldierId);
    await expect(readFile(localPath())).rejects.toThrow();

    expect(await drainDeletionLog(config())).toEqual({
      status: "appended",
      appended: 1,
      head: 1,
    });
    const written = await lines();
    expect(written).toHaveLength(1);
    const [entry] = await localEntries();
    expect(entry).toMatchObject({
      seq: 1,
      id: pending[0]!.id,
      soldierId: first!.soldierId,
    });
    // No name, number, contact detail or reason reaches the file or its copy.
    const text = await readFile(localPath(), "utf8");
    for (const secret of ["חייל", "00510", "example.invalid", "שוחרר"])
      expect(text).not.toContain(secret);
    expect(await pendingRecords()).toHaveLength(0);
    const [logged] = await db
      .select()
      .from(records)
      .where(eq(records.id, pending[0]!.id));
    expect(logged.data).toMatchObject({ status: "logged", seq: 1 });
    expect((await readLogState(db)).headSeq).toBe(1);
    // Nothing more to write.
    expect(await drainDeletionLog(config())).toEqual({ status: "idle" });
    expect(await lines()).toHaveLength(1);
  });

  it("leaves nothing in the log for a deletion that rolled back", async () => {
    await expect(
      unitTransaction(async (tx) => {
        await eraseSoldier(tx, manager, people[0]!.soldierId!, {
          reason: "שוחרר",
        });
        throw new Error("rolled back");
      })
    ).rejects.toThrow("rolled back");
    expect(await pendingRecords()).toHaveLength(0);
    expect((await soldierRow(people[0]!)).deletedAt).toBeNull();
    await drainDeletionLog(config());
    expect(await readFile(localPath(), "utf8")).toBe("");
  });

  it("appends each deletion once and in order when workers drain at the same time", async () => {
    for (const person of people.slice(0, 3)) await remove(person);
    await Promise.all([
      drainDeletionLog(config()),
      drainDeletionLog(config()),
      drainDeletionLog(config()),
    ]);
    const entries = await localEntries();
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(new Set(entries.map((entry) => entry.soldierId)).size).toBe(3);
    expect(parseLog(await readFile(localPath(), "utf8")).problems).toEqual([]);
    expect(await pendingRecords()).toHaveLength(0);
  });

  it("neither loses nor repeats an entry when a crash came between the append and the mark", async () => {
    await remove(people[0]!);
    const [pending] = await pendingRecords();
    // The line was written; the record was not yet marked.
    await writeFile(
      localPath(),
      serializeEntry(
        nextEntry(undefined, {
          id: pending!.id,
          soldierId: people[0]!.soldierId!,
          at: String(pending!.data.at),
        })
      )
    );
    await drainDeletionLog(config());
    expect(await lines()).toHaveLength(1);
    expect(await pendingRecords()).toHaveLength(0);
  });

  it("writes one process at a time", async () => {
    await remove(people[0]!);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${DELETION_LOG_LOCK})`);
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const drain = drainDeletionLog(config());
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Waiting on the other writer: nothing was written yet.
    await expect(readFile(localPath())).rejects.toThrow();
    release();
    await holder;
    expect(await drain).toMatchObject({ status: "appended", appended: 1 });
    expect(await lines()).toHaveLength(1);
  });

  it("does not write while a restore is in progress", async () => {
    await remove(people[0]!);
    process.env.RESTORE_MODE = "true";
    expect(await drainDeletionLog(config())).toEqual({ status: "idle" });
    delete process.env.RESTORE_MODE;
    await raiseRestoreBlocker(db, "other_check");
    expect(await drainDeletionLog(config())).toEqual({ status: "idle" });
    expect(await pendingRecords()).toHaveLength(1);
  });

  it("is off without a directory", async () => {
    await remove(people[0]!);
    expect(await drainDeletionLog({})).toEqual({ status: "disabled" });
    expect(await pendingRecords()).toHaveLength(1);
  });
});

describe("the copy in storage", () => {
  it("is made after the first deletion and replaced, never duplicated", async () => {
    await drainDeletionLog(config());
    // An empty log is not copied.
    expect(await storedFiles()).toEqual([]);
    await remove(people[0]!);
    await drainDeletionLog(config());
    expect(await storedFiles()).toHaveLength(1);
    expect(await stored()).toBe(await readFile(localPath(), "utf8"));
    await remove(people[1]!);
    await drainDeletionLog(config());
    expect(await storedFiles()).toHaveLength(1);
    expect(parseLog((await stored())!).entries).toHaveLength(2);
    expect((await readLogState(db)).remoteSeq).toBe(2);
    // A drain with nothing new leaves it as it is.
    await drainDeletionLog(config());
    expect(await storedFiles()).toHaveLength(1);
  });

  it("is never overwritten when it is ahead of the local file or tells another story", async () => {
    await remove(people[0]!);
    await remove(people[1]!);
    await drainDeletionLog(config());
    const before = await stored();
    // The local file lost its last line: the copy in storage is ahead.
    const [first] = await localEntries();
    await writeLocal([first!]);
    expect(await drainDeletionLog(config())).toEqual({
      status: "failed",
      code: "storage_conflict",
    });
    expect(await stored()).toBe(before);
    expect((await readLogState(db)).lastError).toBe("storage_conflict");
    // A different history from the start.
    await writeLocal([entryFor(undefined, randomUUID())]);
    expect(await drainDeletionLog(config())).toMatchObject({
      status: "failed",
      code: "storage_conflict",
    });
    expect(await stored()).toBe(before);
  });
});

describe("a damaged or missing local file", () => {
  it("never lowers the database witness when both signed copies are rolled back", async () => {
    await remove(people[0]!);
    await remove(people[1]!);
    await drainDeletionLog(config());
    const witness = await readLogState(db);
    const [first] = await localEntries();
    await writeLocal([first!]);
    for (const name of await storedFiles()) await rm(join(store, name));
    await remove(people[2]!);
    expect(await drainDeletionLog(config())).toEqual({
      status: "failed",
      code: "storage_conflict",
    });
    expect(await readLogState(db)).toMatchObject({
      headSeq: witness.headSeq,
      headHash: witness.headHash,
    });
    expect(await pendingRecords()).toHaveLength(1);
    expect(await localEntries()).toHaveLength(1);
  });

  it("does not repair a torn signed entry that the database already witnessed", async () => {
    await remove(people[0]!);
    await drainDeletionLog({ directory, ...testLogKeys });
    const text = (await readFile(localPath(), "utf8")).slice(0, -20);
    await writeFile(localPath(), text);
    await remove(people[1]!);
    expect(await drainDeletionLog({ directory, ...testLogKeys })).toEqual({
      status: "failed",
      code: "storage_conflict",
    });
    expect(await readFile(localPath(), "utf8")).toBe(text);
    expect((await readLogState(db)).headSeq).toBe(1);
    expect(await pendingRecords()).toHaveLength(1);
  });

  it("is not appended to when a line was changed", async () => {
    await remove(people[0]!);
    await remove(people[1]!);
    await drainDeletionLog({ directory, ...testLogKeys });
    const text = (await readFile(localPath(), "utf8")).replace(
      people[0]!.soldierId!,
      randomUUID()
    );
    await writeFile(localPath(), text);
    await remove(people[2]!);
    expect(await drainDeletionLog({ directory, ...testLogKeys })).toEqual({
      status: "failed",
      code: "log_broken",
    });
    expect(await readFile(localPath(), "utf8")).toBe(text);
    expect(await pendingRecords()).toHaveLength(1);
  });

  it("repairs a last line cut short by a crash and goes on", async () => {
    await remove(people[0]!);
    await drainDeletionLog({ directory, ...testLogKeys });
    await appendFile(localPath(), '{"v":1,"seq":2,"id":"half');
    await remove(people[1]!);
    expect((await drainDeletionLog({ directory, ...testLogKeys })).status).toBe(
      "appended"
    );
    const entries = await localEntries();
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(parseLog(await readFile(localPath(), "utf8")).problems).toEqual([]);
  });

  it("is taken back from the storage copy on a fresh volume", async () => {
    await remove(people[0]!);
    await remove(people[1]!);
    await drainDeletionLog(config());
    const original = await readFile(localPath(), "utf8");
    await rm(localPath());
    await remove(people[2]!);
    expect((await drainDeletionLog(config())).status).toBe("appended");
    const restored = await readFile(localPath(), "utf8");
    expect(restored.startsWith(original)).toBe(true);
    expect((await localEntries()).map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it("never starts a new chain while the database or storage says there was history", async () => {
    await remove(people[0]!);
    await drainDeletionLog(config());
    await rm(localPath());
    // The copy in storage is gone too.
    for (const name of await storedFiles()) await rm(join(store, name));
    await remove(people[1]!);
    expect(await drainDeletionLog(config())).toEqual({
      status: "failed",
      code: "log_missing",
    });
    await expect(readFile(localPath())).rejects.toThrow();
    expect(await pendingRecords()).toHaveLength(1);
  });

  it("starts an empty log on a first run", async () => {
    expect(await drainDeletionLog(config())).toEqual({ status: "idle" });
    expect(await readFile(localPath(), "utf8")).toBe("");
  });
});

describe("telling the technical account", () => {
  it("alerts once a day after ten minutes of failure, by site notice and email", async () => {
    await remove(people[0]!);
    await drainDeletionLog({ directory, ...testLogKeys });
    const original = await readFile(localPath(), "utf8");
    await writeFile(localPath(), "not a log\n");
    const t0 = new Date("2026-10-01T10:00:00.000Z");
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    const notices = async () =>
      (
        await db.select().from(records).where(eq(records.kind, "notification"))
      ).filter((row) => row.data.accountId === technical.id);
    await drainDeletionLog({ directory, ...testLogKeys }, t0);
    await drainDeletionLog({ directory, ...testLogKeys }, at(5));
    expect(await notices()).toHaveLength(0);
    await drainDeletionLog({ directory, ...testLogKeys }, at(11));
    await drainDeletionLog({ directory, ...testLogKeys }, at(30));
    expect(await notices()).toHaveLength(1);
    const mail = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, technical.id));
    expect(mail).toHaveLength(1);
    expect(mail[0]!.kind).toBe("backup-alert");
    await drainDeletionLog({ directory, ...testLogKeys }, at(60 * 25));
    expect(await notices()).toHaveLength(2);
    // Recover the verified original; an empty file cannot replace committed history.
    await writeFile(localPath(), original);
    expect(
      (await drainDeletionLog({ directory, ...testLogKeys }, at(60 * 26)))
        .status
    ).not.toBe("failed");
    expect((await readLogState(db)).lastError).toBeUndefined();
  });
});

describe("verifying the log", () => {
  async function twoDeletions() {
    await remove(people[0]!);
    await remove(people[1]!);
    await drainDeletionLog(config());
  }

  it("verifies whole, matching copies", async () => {
    await twoDeletions();
    const result = await verifyDeletionLog(db, config());
    expect(result).toMatchObject({
      status: "verified",
      reasons: [],
      warnings: [],
      local: { status: "intact", length: 2 },
      remote: { status: "intact", length: 2 },
    });
    expect(result.entries).toHaveLength(2);
  });

  it("is unverified when no copy exists", async () => {
    expect(await verifyDeletionLog(db, config())).toMatchObject({
      status: "unverified",
      reasons: ["no_log"],
    });
    expect(
      await verifyDeletionLog(db, { directory, ...testLogKeys })
    ).toMatchObject({
      status: "unverified",
      reasons: ["no_log"],
    });
  });

  it("is unverified when the local file is damaged, even if storage is whole", async () => {
    await twoDeletions();
    await writeFile(localPath(), "garbage\n");
    const result = await verifyDeletionLog(db, config());
    expect(result.status).toBe("unverified");
    expect(result.reasons).toContain("local_broken");
    expect(result.entries).toEqual([]);
  });

  it("uses the storage copy when the local file is missing, and says so", async () => {
    await twoDeletions();
    await rm(localPath());
    expect(await verifyDeletionLog(db, config())).toMatchObject({
      status: "verified",
      source: "remote",
      warnings: ["local_missing"],
    });
  });

  it("takes the longer copy when one is only behind", async () => {
    await twoDeletions();
    const entries = await localEntries();
    await writeLocal(entries.slice(0, 1));
    expect(await verifyDeletionLog(db, config())).toMatchObject({
      status: "verified",
      source: "remote",
      warnings: ["local_behind"],
    });
    await writeLocal(entries);
    const copy = (await storedFiles())[0]!;
    await writeFile(
      join(store, copy),
      entries.slice(0, 1).map(serializeEntry).join("")
    );
    expect(await verifyDeletionLog(db, config())).toMatchObject({
      status: "verified",
      source: "local",
      warnings: ["remote_behind"],
    });
  });

  it("is unverified when the two copies tell different histories", async () => {
    await twoDeletions();
    const [first] = await localEntries();
    await writeLocal([first!, entryFor(first, randomUUID())]);
    const result = await verifyDeletionLog(db, config());
    expect(result.status).toBe("unverified");
    expect(result.reasons).toEqual(["diverged"]);
  });

  it("is unverified when the database knows a line the log lacks", async () => {
    await twoDeletions();
    const entries = await localEntries();
    await writeLocal(entries.slice(0, 1));
    for (const name of await storedFiles()) await rm(join(store, name));
    const ahead = await verifyDeletionLog(db, config());
    expect(ahead.status).toBe("unverified");
    expect(ahead.reasons).toContain("database_ahead");
    // The same number of lines, another history.
    await mergeState(db, { headSeq: 1, headHash: "f".repeat(64) });
    const mismatch = await verifyDeletionLog(db, config());
    expect(mismatch.reasons).toContain("database_mismatch");
    expect(mismatch.reasons).not.toContain("database_ahead");
  });

  it("is unverified when a deleted soldier is missing from the log, unless its line is still queued", async () => {
    await twoDeletions();
    await db
      .update(soldiers)
      .set({ deletedAt: new Date() })
      .where(eq(soldiers.id, people[2]!.soldierId!));
    const result = await verifyDeletionLog(db, config());
    expect(result.status).toBe("unverified");
    expect(result.reasons).toEqual(["unlogged_deletions"]);
    expect(result.unloggedDeletions).toEqual([people[2]!.soldierId]);
    await db.insert(records).values({
      id: randomUUID(),
      kind: "deletion_log_entry",
      subjectId: people[2]!.soldierId!,
      data: { status: "pending", at: new Date().toISOString() },
    });
    expect((await verifyDeletionLog(db, config())).status).toBe("verified");
  });

  it("does not hold an unreadable storage against the daily check, only against a restore", async () => {
    await twoDeletions();
    const broken = {
      ...directoryStorage(store),
      findKind: async () => {
        throw new Error("offline");
      },
    };
    expect(
      await verifyDeletionLog(
        db,
        { directory, ...testLogKeys, storage: broken },
        { strict: false }
      )
    ).toMatchObject({ status: "verified" });
    expect(
      (
        await verifyDeletionLog(db, {
          directory,
          ...testLogKeys,
          storage: broken,
        })
      ).reasons
    ).toEqual(["remote_unreadable"]);
  });
});

describe("what the technical screen sees", () => {
  it("counts only: pending, entries and the storage copy, with no soldier or id", async () => {
    await remove(people[0]!);
    let status = await readDeletionLogStatus(db, config());
    expect(status).toMatchObject({
      enabled: true,
      pending: 1,
      entries: 0,
      storageCopy: "current",
    });
    await drainDeletionLog(config());
    status = await readDeletionLogStatus(db, config());
    expect(status).toMatchObject({
      pending: 0,
      entries: 1,
      storageCopy: "current",
    });
    expect(JSON.stringify(status)).not.toContain(people[0]!.soldierId!);
    // A second deletion is logged but not yet copied.
    await remove(people[1]!);
    await mergeState(db, { remoteSeq: 1 });
    expect(await drainDeletionLog({ directory, ...testLogKeys })).toMatchObject(
      {
        appended: 1,
      }
    );
    expect((await readDeletionLogStatus(db, config())).storageCopy).toBe(
      "behind"
    );
    expect(
      (await readDeletionLogStatus(db, { directory, ...testLogKeys }))
        .storageCopy
    ).toBe("none");
    expect((await readDeletionLogStatus(db, {})).enabled).toBe(false);
  });

  it("reaches the technical account and nobody else", async () => {
    await remove(people[0]!);
    await drainDeletionLog(config());
    const state = (await readState(technical)) as unknown as Record<
      string,
      unknown
    >;
    expect(state.deletionLog).toMatchObject({ entries: 1 });
    expect(
      (state.operations as { id: string }[]).map((item) => item.id)
    ).not.toContain("deletion-log");
    expect(
      (await readState(manager)) as unknown as Record<string, unknown>
    ).not.toHaveProperty("deletionLog");
  });
});

describe("applying the log after a restore", () => {
  /** A soldier as the restored backup holds them: whole, with sensitive data, in a future and a running seat. */
  async function restoredSoldier(person: Actor) {
    const row = await soldierRow(person);
    await db
      .update(soldiers)
      .set({
        data: {
          ...row.data,
          gender: "female",
          exemptions: [
            {
              exemptionId: randomUUID(),
              start: "2026-01-01",
              end: "2030-12-31",
            },
          ],
        },
      })
      .where(eq(soldiers.id, row.id));
    await db.insert(session).values({
      id: randomUUID(),
      userId: person.id,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + DAY),
      securityEpoch: 1,
    });
    const type = await command(manager, "dutyType.save", {
      name: `סוג ${randomUUID().slice(0, 6)}`,
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 1 }],
    });
    const seats: string[] = [];
    for (const startInDays of [2, 4]) {
      const duty = await command(manager, "duty.create", {
        typeId: type.id,
        name: `תורנות ${startInDays}`,
        start: new Date(Date.now() + startInDays * DAY).toISOString(),
        end: new Date(Date.now() + (startInDays + 1) * DAY).toISOString(),
      });
      const [created] = await db
        .select()
        .from(duties)
        .where(eq(duties.id, duty.id));
      await command(
        manager,
        "duty.assign",
        {
          dutyId: duty.id,
          slotId: created.data.slots[0].id,
          soldierId: person.soldierId,
        },
        1
      );
      await command(
        manager,
        "duty.publish",
        { id: duty.id, confirmed: true },
        2
      );
      seats.push(duty.id);
    }
    // The second duty has started.
    const [running] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, seats[1]!));
    await db
      .update(duties)
      .set({
        data: {
          ...running.data,
          start: new Date(Date.now() - 3_600_000).toISOString(),
          end: new Date(Date.now() + 3_600_000).toISOString(),
        },
      })
      .where(eq(duties.id, seats[1]!));
    return seats;
  }

  it("applies the deletions the database lacks, once, and opens the gate for this check only", async () => {
    // B was deleted before the backup; A after it; X is unknown to this database.
    await remove(people[1]!);
    await drainDeletionLog(config());
    const [seatFuture, seatRunning] = await restoredSoldier(people[0]!);
    const logged = await localEntries();
    const entryA = entryFor(
      logged.at(-1),
      people[0]!.soldierId!,
      "2026-10-01T08:30:00.000Z"
    );
    const entryX = entryFor(entryA, randomUUID());
    await writeLocal([...logged, entryA, entryX]);
    await drainDeletionLog(config());
    await raiseRestoreBlocker(db, "other_check");

    const result = await applyLoggedDeletions(config());
    expect(result).toMatchObject({
      status: "applied",
      applied: 1,
      alreadyDeleted: 1,
      notInDatabase: 1,
      head: 3,
    });

    const row = await soldierRow(people[0]!);
    expect(row.deletedAt?.toISOString()).toBe("2026-10-01T08:30:00.000Z");
    expect(row.data.exemptions).toEqual([]);
    expect(row.data.gender).toBeUndefined();
    const [contact] = await db
      .select()
      .from(soldierContacts)
      .where(eq(soldierContacts.soldierId, people[0]!.soldierId!));
    expect(contact).toMatchObject({ email: null, phone: null, address: null });
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.id, people[0]!.id));
    expect(account.deletedAt).not.toBeNull();
    expect(
      await db.select().from(session).where(eq(session.userId, people[0]!.id))
    ).toHaveLength(0);
    const seats = await db
      .select()
      .from(assignments)
      .where(eq(assignments.soldierId, people[0]!.soldierId!));
    expect(seats.find((item) => item.dutyId === seatFuture)!.status).toBe(
      "cancelled"
    );
    const running = seats.find((item) => item.dutyId === seatRunning)!;
    expect(running.status).toBe("reserved");
    expect(running.data.needsAttention).toContain("deleted");

    // The managers are told again, by site and email, with a key of its own.
    const notices = (
      await db.select().from(records).where(eq(records.kind, "notification"))
    ).filter((item) => item.data.accountId === manager.id);
    expect(
      notices.some((item) => String(item.data.body).includes("הוחלה מחדש"))
    ).toBe(true);
    expect(
      (
        await db
          .select()
          .from(emailOutbox)
          .where(eq(emailOutbox.kind, "deletion"))
      ).some((item) => item.eventKey.includes(":restored:"))
    ).toBe(true);
    // The log is not told twice, and the check is clear while the gate is held by another.
    expect(await pendingRecords()).toHaveLength(0);
    expect(await lines()).toHaveLength(3);
    const gate = await readRestoreGate(db);
    expect(gate.blockers).toEqual(["other_check"]);
    expect(gate.blocked).toBe(true);
    expect(await readLogState(db)).toMatchObject({
      appliedThrough: 3,
      headSeq: 3,
    });
    const audits = await db
      .select()
      .from(records)
      .where(eq(records.kind, "audit"));
    expect(
      audits.find((item) => item.data.action === "restore.deletions.apply")
        ?.data
    ).toMatchObject({ applied: 1, alreadyDeleted: 1, notInDatabase: 1 });

    // A second run changes nothing.
    expect(await applyLoggedDeletions(config())).toMatchObject({
      status: "applied",
      applied: 0,
      alreadyDeleted: 2,
      notInDatabase: 1,
    });
    expect(
      await db
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.kind, "deletion"))
    ).toHaveLength(1);
  });

  it("opens the gate when nothing else holds it", async () => {
    await remove(people[0]!);
    await drainDeletionLog(config());
    await rm(localPath());
    expect((await applyLoggedDeletions(config())).status).toBe("applied");
    expect(await readRestoreGate(db)).toMatchObject({
      blocked: false,
      blockers: [],
    });
    // A fresh volume got the whole log back.
    expect(await localEntries()).toHaveLength(1);
    await expect(readState(manager)).resolves.toBeTruthy();
  });

  it("purges a restored Calendar grant even when the soldier was already deleted in the backup", async () => {
    const person = people[0]!;
    await remove(person);
    await drainDeletionLog(config());
    // Simulate inconsistent restored rows. A token must not survive just because
    // the deletion marker is already present; applying the verified log erases it.
    await db.insert(calendarLink).values({
      accountId: person.id,
      refreshToken: "synthetic-restored-ciphertext",
    });
    await db.insert(calendarEvent).values({
      id: randomUUID(),
      accountId: person.id,
      dutyId: randomUUID(),
      googleEventId: "restored-event",
      fingerprint: "old",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + DAY),
    });
    expect(await applyLoggedDeletions(config())).toMatchObject({
      status: "applied",
      alreadyDeleted: 1,
      applied: 0,
    });
    expect(await db.select().from(calendarLink)).toEqual([]);
    expect(await db.select().from(calendarEvent)).toEqual([]);
    expect(await applyLoggedDeletions(config())).toMatchObject({
      status: "applied",
      alreadyDeleted: 1,
      applied: 0,
    });
  });

  it("applies a deletion to an account that is a manager in the restored database", async () => {
    const lead = await invite("מנהל לשעבר", "manager", "00590");
    const entry = entryFor(undefined, lead.soldierId!);
    await writeLocal([entry]);
    await drainDeletionLog(config());
    expect(await applyLoggedDeletions(config())).toMatchObject({ applied: 1 });
    expect((await soldierRow(lead)).deletedAt).not.toBeNull();
    const [account] = await db.select().from(user).where(eq(user.id, lead.id));
    expect(account.deletedAt).not.toBeNull();
  });

  it("applies in the order of the log", async () => {
    const first = entryFor(
      undefined,
      people[0]!.soldierId!,
      "2026-10-01T08:00:00.000Z"
    );
    const second = entryFor(
      first,
      people[1]!.soldierId!,
      "2026-10-01T09:00:00.000Z"
    );
    await writeLocal([first, second]);
    await drainDeletionLog(config());
    await applyLoggedDeletions(config());
    const deleted = await db
      .select({ id: soldiers.id, at: soldiers.deletedAt })
      .from(soldiers)
      .where(and(sql`${soldiers.deletedAt} is not null`));
    expect(
      Object.fromEntries(
        deleted.map((item) => [item.id, item.at!.toISOString()])
      )
    ).toEqual({
      [people[0]!.soldierId!]: "2026-10-01T08:00:00.000Z",
      [people[1]!.soldierId!]: "2026-10-01T09:00:00.000Z",
    });
  });
});

describe("a restore with a missing or unverified log stays closed", () => {
  it("blocks access and mail when the log is damaged, and applies nothing", async () => {
    await remove(people[0]!);
    await drainDeletionLog({ directory, ...testLogKeys });
    await writeFile(localPath(), "garbage\n");
    await restoreLikeSoldier(people[1]!);
    const result = await applyLoggedDeletions({ directory, ...testLogKeys });
    expect(result.status).toBe("blocked");
    const gate = await readRestoreGate(db);
    expect(gate).toMatchObject({
      blocked: true,
      blockers: [DELETION_LOG_BLOCKER],
    });
    expect(gate.details[DELETION_LOG_BLOCKER]).toMatchObject({
      reasons: ["local_broken"],
    });
    expect((await soldierRow(people[1]!)).deletedAt).toBeNull();
    await expect(readState(people[1]!)).rejects.toMatchObject({ status: 401 });
    // Mail waits: even a ready message is not delivered.
    expect(
      await deliverNextEmail(async () => "sent", new Date())
    ).toMatchObject({ status: expect.not.stringMatching(/^sent$/) });
    const [still] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.status, "sent"));
    expect(still).toBeUndefined();
  });

  it("blocks when no log exists at all", async () => {
    const result = await applyLoggedDeletions({
      directory,
      ...testLogKeys,
      storage: directoryStorage(store),
    });
    expect(result).toMatchObject({
      status: "blocked",
      verification: { reasons: ["no_log"] },
    });
    expect((await readRestoreGate(db)).blockers).toEqual([
      DELETION_LOG_BLOCKER,
    ]);
  });

  it("is released only by a person with a reason and the exact words, and the managers are told", async () => {
    await applyLoggedDeletions({
      directory,
      ...testLogKeys,
      storage: directoryStorage(store),
    });
    await raiseRestoreBlocker(db, "other_check");
    await expect(
      acknowledgeUnverifiedLog(
        { reason: "ok", acknowledgement: ACKNOWLEDGEMENT },
        { directory, ...testLogKeys }
      )
    ).rejects.toMatchObject({ code: "reason_required" });
    await expect(
      acknowledgeUnverifiedLog(
        { reason: "הכונן נבדק ידנית מול הרשימה", acknowledgement: "yes" },
        { directory, ...testLogKeys }
      )
    ).rejects.toMatchObject({ code: "acknowledgement_required" });
    expect((await readRestoreGate(db)).blockers).toContain(
      DELETION_LOG_BLOCKER
    );

    const reason = "אין עותק של היומן; נבדקו ידנית המחיקות מאז הגיבוי";
    const result = await acknowledgeUnverifiedLog(
      { reason, acknowledgement: ACKNOWLEDGEMENT },
      { directory, ...testLogKeys }
    );
    expect(result.status).toBe("unverified");
    // Only this check is clear; the other still holds the gate.
    const gate = await readRestoreGate(db);
    expect(gate.blockers).toEqual(["other_check"]);
    expect(gate.blocked).toBe(true);
    const audits = await db
      .select()
      .from(records)
      .where(eq(records.kind, "audit"));
    expect(
      audits.find(
        (item) => item.data.action === "restore.deletions.acknowledge"
      )?.data
    ).toMatchObject({ reason, status: "unverified", reasons: ["no_log"] });
    const notices = (
      await db.select().from(records).where(eq(records.kind, "notification"))
    ).filter((item) => item.data.accountId === manager.id);
    expect(
      notices.some(
        (item) => item.data.title === "השחזור נפתח בלי יומן מחיקות מאומת"
      )
    ).toBe(true);
    expect((await readLogState(db)).acknowledgedAt).toBeTruthy();
  });

  it("opens the gate after an acknowledgement when nothing else holds it", async () => {
    await applyLoggedDeletions({ directory, ...testLogKeys });
    await acknowledgeUnverifiedLog(
      {
        reason: "אין יומן, אין מחיקות מאז הגיבוי",
        acknowledgement: ACKNOWLEDGEMENT,
      },
      { directory, ...testLogKeys }
    );
    expect((await readRestoreGate(db)).blocked).toBe(false);
    await expect(readState(manager)).resolves.toBeTruthy();
  });

  it("keeps a block set by hand, which only a person clears", async () => {
    await remove(people[0]!);
    await drainDeletionLog({ directory, ...testLogKeys });
    await rm(localPath());
    await db
      .insert(operationsState)
      .values({ key: "restore", data: { blocked: true } });
    await applyLoggedDeletions({ directory, ...testLogKeys });
    await acknowledgeUnverifiedLog(
      { reason: "מצב שחזור ידני נשאר", acknowledgement: ACKNOWLEDGEMENT },
      { directory, ...testLogKeys }
    );
    expect(await readRestoreGate(db)).toMatchObject({
      blocked: true,
      manual: true,
    });
    // What access and mail read is the stored flag itself, and it stays closed.
    const [row] = await db
      .select()
      .from(operationsState)
      .where(eq(operationsState.key, "restore"));
    expect(row.data.blocked).toBe(true);
    await expect(readState(manager)).rejects.toMatchObject({ status: 401 });
  });

  async function restoreLikeSoldier(person: Actor) {
    // The soldier is whole in the restored database; the log is what would have deleted them.
    expect((await soldierRow(person)).deletedAt).toBeNull();
  }
});
