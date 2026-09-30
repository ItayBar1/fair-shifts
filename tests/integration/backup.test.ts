import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { db, pool } from "../../src/server/db";
import {
  backupRun,
  emailOutbox,
  operationsState,
} from "../../src/server/auth-schema";
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
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import {
  backupBeforeDeploy,
  backupConfig,
  backupState,
  beforeDeploy,
  runBackupCycle,
  type BackupConfig,
} from "../../src/server/operations/backup";
import {
  BackupFailure,
  directoryStorage,
  type BackupStorage,
} from "../../src/server/operations/backup-storage";
import { deliverNextEmail } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

const MINUTE = 60_000;
const RESTORE_DB = "fair_shifts_test_restore";
let technical: Actor;
let manager: Actor;
let work: string;
let identity: string;
let recipient: string;
let store: string;

function run(command: string, args: string[], input?: Buffer) {
  return new Promise<{ code: number; stdout: Buffer; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args);
      const out: Buffer[] = [];
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err })
      );
      child.stdin.end(input);
    }
  );
}
function config(overrides: Record<string, string> = {}): BackupConfig {
  return backupConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    BACKUP_STORAGE: "directory",
    BACKUP_DIRECTORY: store,
    BACKUP_WORK_DIRECTORY: join(work, "staging"),
    AGE_RECIPIENT: recipient,
    ...overrides,
  });
}
async function command(actor: Actor, type: string) {
  return executeAction(actor, {
    type,
    payload: {},
    idempotencyKey: randomUUID(),
  });
}
async function runs() {
  return db.select().from(backupRun).orderBy(backupRun.createdAt);
}
async function technicalNotices() {
  return (
    await db.select().from(records).where(eq(records.kind, "notification"))
  ).filter((row) => row.data.accountId === technical.id);
}
async function storedFiles() {
  return (await readdir(store)).sort();
}
/** Wraps a real storage so one operation can fail in a chosen way. */
function failing(
  base: BackupStorage,
  overrides: Partial<BackupStorage>
): BackupStorage {
  return { ...base, ...overrides };
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "fair-shifts-backup-test-"));
  // The action and the screen read the environment; cycles get explicit config.
  process.env.BACKUP_STORAGE = "directory";
  process.env.BACKUP_DIRECTORY = join(work, "env-store");
  identity = join(work, "identity.txt");
  const generated = await run("age-keygen", ["-o", identity]);
  expect(generated.code).toBe(0);
  recipient = (await run("age-keygen", ["-y", identity])).stdout
    .toString()
    .trim();
});
afterAll(async () => {
  delete process.env.BACKUP_STORAGE;
  delete process.env.BACKUP_DIRECTORY;
  await rm(work, { recursive: true, force: true });
  await pool.query(`drop database if exists ${RESTORE_DB}`);
  await pool.end();
});
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results, backup_run cascade`
  );
  store = join(work, `store-${randomUUID()}`);
  await mkdir(store);
  const tech = await createInvitedAccount({
    name: "טכני גיבוי",
    role: "technical",
    email: "backup-technical@example.invalid",
  });
  technical = {
    id: tech.id,
    name: tech.name,
    role: "technical",
    securityEpoch: 1,
  };
  const people = [
    ["אחראי גיבוי", "700001", 3],
    ["חייל גיבוי ראשון", "700002", 12],
    ["חייל גיבוי שני", "700003", 7],
  ] as const;
  for (const [name, personalNumber, points] of people) {
    const id = randomUUID();
    await db.insert(soldiers).values({
      id,
      name,
      personalNumber,
      data: soldier({ id, name, personalNumber }),
    });
    await db
      .insert(soldierContacts)
      .values({ soldierId: id, email: `${personalNumber}@example.invalid` });
    await db.insert(balances).values({ soldierId: id, current: points });
    if (personalNumber === "700001") {
      const account = await createInvitedAccount({
        name,
        role: "manager",
        email: `${personalNumber}@example.invalid`,
        soldierId: id,
      });
      manager = {
        id: account.id,
        name,
        role: "manager",
        soldierId: id,
        securityEpoch: 1,
      };
    }
  }
});

describe("encrypted backup that restores into an isolated database", () => {
  it("produces a verified copy that is only ciphertext, decrypts and restores the data", async () => {
    await command(technical, "backup.request");
    const result = await runBackupCycle(new Date(), config());
    expect(result.status).toBe("verified");

    const [row] = await runs();
    expect(row).toMatchObject({
      trigger: "manual",
      status: "verified",
      attempts: 1,
      storageKind: "directory",
      requestedBy: technical.id,
    });
    const files = await storedFiles();
    expect(files).toHaveLength(1);
    const encrypted = await readFile(join(store, files[0]));
    expect(encrypted.subarray(0, 21).toString()).toBe("age-encryption.org/v1");
    expect(encrypted.length).toBe(row.sizeBytes);
    // Neither names nor contact details are readable in the stored file.
    expect(encrypted.includes(Buffer.from("700002@example.invalid"))).toBe(
      false
    );
    expect(encrypted.includes(Buffer.from("חייל גיבוי ראשון"))).toBe(false);
    // Nothing is left in the local staging directory.
    expect(await readdir(join(work, "staging"))).toEqual([]);

    const decrypted = await run(
      "age",
      ["--decrypt", "-i", identity],
      encrypted
    );
    expect(decrypted.code).toBe(0);
    await pool.query(`drop database if exists ${RESTORE_DB}`);
    await pool.query(`create database ${RESTORE_DB}`);
    const target = new URL(process.env.DATABASE_URL!);
    target.pathname = `/${RESTORE_DB}`;
    const restored = await run(
      "pg_restore",
      ["--no-owner", "--no-privileges", `--dbname=${target}`],
      decrypted.stdout
    );
    expect(restored.code).toBe(0);

    const client = new Client({ connectionString: target.toString() });
    await client.connect();
    try {
      const people = await client.query(
        "select s.name, s.personal_number, b.current from soldiers s join balances b on b.soldier_id = s.id order by s.personal_number"
      );
      expect(people.rows).toEqual([
        { name: "אחראי גיבוי", personal_number: "700001", current: 3 },
        { name: "חייל גיבוי ראשון", personal_number: "700002", current: 12 },
        { name: "חייל גיבוי שני", personal_number: "700003", current: 7 },
      ]);
      const accounts = await client.query(
        "select role from auth_user order by role"
      );
      expect(accounts.rows.map((r) => r.role)).toEqual([
        "manager",
        "technical",
      ]);
      const migrations = await client.query(
        "select count(*)::int as count from drizzle.__drizzle_migrations"
      );
      expect(migrations.rows[0].count).toBeGreaterThan(0);
      // The transient job queue is left out of the dump.
      const queue = await client.query(
        "select count(*)::int as count from information_schema.schemata where schema_name = 'pgboss'"
      );
      expect(queue.rows[0].count).toBe(0);
    } finally {
      await client.end();
    }

    const state = (await readState(technical)) as Record<string, unknown>;
    const backups = state.backups as Record<string, unknown>;
    expect(backups).toMatchObject({
      kind: "directory",
      storageConfigured: true,
      keyConfigured: false,
      retained: 1,
      max: 30,
    });
    expect(JSON.stringify(backups)).not.toContain(recipient);
  });

  it("does not leave another copy when the same run is taken over after its lease expired", async () => {
    await command(technical, "backup.request");
    const now = new Date();
    const [pending] = await runs();
    // A worker claimed the run, uploaded part of a file and died.
    await db
      .update(backupRun)
      .set({
        status: "running",
        attempts: 1,
        leaseUntil: new Date(now.getTime() - MINUTE),
      })
      .where(eq(backupRun.id, pending.id));
    await writeFile(
      join(store, `fair-shifts-${pending.id}--partial.dump.age`),
      "partial"
    );
    const result = await runBackupCycle(now, config());
    expect(result).toMatchObject({ status: "verified", runId: pending.id });
    const files = await storedFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("partial");
    expect((await runs())[0].attempts).toBe(2);
  });
});

describe("daily schedule and concurrency", () => {
  it("runs once per Israel date from 03:30 and not while restore mode is on", async () => {
    const early = new Date("2026-09-29T00:00:00Z"); // 03:00 in Israel
    expect(await runBackupCycle(early, config())).toEqual({ status: "idle" });
    expect(await runs()).toEqual([]);

    await db
      .insert(operationsState)
      .values({ key: "restore", data: { blocked: true } });
    const due = new Date("2026-09-29T00:31:00Z");
    expect(await runBackupCycle(due, config())).toEqual({ status: "paused" });
    expect(await runs()).toEqual([]);
    await db.delete(operationsState).where(eq(operationsState.key, "restore"));

    expect((await runBackupCycle(due, config())).status).toBe("verified");
    const later = new Date("2026-09-29T15:00:00Z");
    expect(await runBackupCycle(later, config())).toEqual({ status: "idle" });
    const rows = await runs();
    expect(rows.map((row) => [row.key, row.status])).toEqual([
      ["daily:2026-09-29", "verified"],
    ]);
    expect(await runBackupCycle(due, config({ BACKUP_STORAGE: "" }))).toEqual({
      status: "disabled",
    });
  });

  it("accepts one waiting request at a time and two workers back up once", async () => {
    await command(technical, "backup.request");
    await expect(command(technical, "backup.request")).rejects.toMatchObject({
      code: "backup_active",
      status: 409,
    });
    await expect(command(manager, "backup.request")).rejects.toMatchObject({
      code: "forbidden",
    });
    const now = new Date();
    const results = await Promise.all([
      runBackupCycle(now, config()),
      runBackupCycle(now, config()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["idle", "verified"]);
    expect(await storedFiles()).toHaveLength(1);
    expect(await runs()).toHaveLength(1);
    // Finished: a new request is accepted again.
    await command(technical, "backup.request");
    expect(await runs()).toHaveLength(2);
  });
});

describe("failures reach the technical screen and account", () => {
  it("fails at once with one alert when the encryption key is missing", async () => {
    await command(technical, "backup.request");
    const now = new Date();
    const result = await runBackupCycle(
      now,
      config({ AGE_RECIPIENT: "AGE-SECRET-KEY-1-not-a-public-key" })
    );
    expect(result).toMatchObject({ status: "failed", code: "key_missing" });
    const [row] = await runs();
    expect(row).toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "key_missing",
    });
    expect(await storedFiles()).toEqual([]);

    const notices = await technicalNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].data).toMatchObject({
      title: "הגיבוי נכשל",
      href: "/technical/backups",
      code: "key_missing",
    });
    expect(String(notices[0].data.body)).toContain("מפתח ההצפנה");
    const mail = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, "backup-alert"));
    expect(mail.map((m) => m.recipientAccountId)).toEqual([technical.id]);

    // A later cycle does not alert again, and nobody else sees the alert.
    await runBackupCycle(new Date(now.getTime() + MINUTE), config());
    expect(await technicalNotices()).toHaveLength(1);
    const managerState = await readState(manager);
    expect(
      managerState.notifications.some(
        (n) => (n as Record<string, unknown>).code === "key_missing"
      )
    ).toBe(false);
    expect("backups" in managerState).toBe(false);
    const technicalState = await readState(technical);
    expect(technicalState.notifications).toHaveLength(1);
  });

  it("respects the technical account's email switch for operational alerts", async () => {
    await executeAction(technical, {
      type: "settings.save",
      payload: {
        reminderHours: [],
        email: {
          dutyReminder: true,
          roundOpening: true,
          roundClosing: true,
          publication: true,
          transfer: true,
          departure: true,
          operations: false,
        },
      },
      idempotencyKey: randomUUID(),
    });
    await command(technical, "backup.request");
    await runBackupCycle(new Date(), config({ AGE_RECIPIENT: "" }));
    expect(await technicalNotices()).toHaveLength(1);
    const sent: string[] = [];
    await deliverNextEmail(async (message) => {
      sent.push(message.eventKey);
      return "synthetic";
    });
    expect(sent).toEqual([]);
    const [mail] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, "backup-alert"));
    expect(mail).toMatchObject({
      status: "cancelled",
      error: "preference_disabled",
    });
  });

  it("alerts at once when the Drive grant expired, without retrying", async () => {
    await command(technical, "backup.request");
    const base = directoryStorage(store);
    const expired = failing(base, {
      freeBytes: async () => {
        throw new BackupFailure("auth_expired");
      },
    });
    const result = await runBackupCycle(new Date(), {
      ...config(),
      storage: expired,
    });
    expect(result).toMatchObject({ status: "failed", code: "auth_expired" });
    expect((await runs())[0].attempts).toBe(1);
    expect(await technicalNotices()).toHaveLength(1);
  });

  it("retries an upload failure after 15 minutes and an hour, then alerts once", async () => {
    await command(technical, "backup.request");
    const base = directoryStorage(store);
    const broken = {
      ...config(),
      storage: failing(base, {
        upload: async () => {
          throw new BackupFailure("upload_failed");
        },
      }),
    };
    const start = Date.now();
    const at = (minutes: number) => new Date(start + minutes * MINUTE);

    expect(await runBackupCycle(at(0), broken)).toMatchObject({
      status: "retry",
    });
    let [row] = await runs();
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    expect(row.nextAttemptAt.getTime()).toBe(at(15).getTime());
    expect(await runBackupCycle(at(14), broken)).toEqual({ status: "idle" });
    expect(await technicalNotices()).toEqual([]);

    expect((await runBackupCycle(at(15), broken)).status).toBe("retry");
    [row] = await runs();
    expect(row.nextAttemptAt.getTime()).toBe(at(75).getTime());
    expect(await runBackupCycle(at(74), broken)).toEqual({ status: "idle" });

    expect(await runBackupCycle(at(75), broken)).toMatchObject({
      status: "failed",
      code: "upload_failed",
    });
    [row] = await runs();
    expect(row).toMatchObject({ status: "failed", attempts: 3 });
    const notices = await technicalNotices();
    expect(notices).toHaveLength(1);
    expect(String(notices[0].data.body)).toContain("אחרי 3 ניסיונות");
    expect(await storedFiles()).toEqual([]);
  });

  it("removes a copy whose read-back does not match and does not mark it verified", async () => {
    await command(technical, "backup.request");
    const base = directoryStorage(store);
    const corrupt = {
      ...config(),
      storage: failing(base, {
        get: async (id: string) => {
          const file = await base.get(id);
          return file && { ...file, sha256: "0".repeat(64) };
        },
      }),
    };
    expect((await runBackupCycle(new Date(), corrupt)).status).toBe("retry");
    expect(await storedFiles()).toEqual([]);
    expect((await runs())[0]).toMatchObject({
      status: "pending",
      errorCode: "upload_failed",
    });
  });
});

describe("retention up to 30 copies and free space", () => {
  /** Verified copies from earlier days, each with a real file in the store. */
  async function seed(count: number, size = 1024) {
    const ids: string[] = [];
    for (let day = 1; day <= count; day++) {
      const id = randomUUID();
      const name = `fair-shifts-${id}--seed-${day}.dump.age`;
      await writeFile(join(store, name), Buffer.alloc(size, day));
      await db.insert(backupRun).values({
        id,
        key: `daily:2026-08-${String(day).padStart(2, "0")}`,
        trigger: "daily",
        status: "verified",
        attempts: 1,
        storageKind: "directory",
        storageId: name,
        fileName: name,
        sizeBytes: size,
        finishedAt: new Date(Date.UTC(2026, 7, day, 1)),
      });
      ids.push(id);
    }
    return ids;
  }

  it("keeps the newest 30 and never touches files the application did not create", async () => {
    const ids = await seed(30);
    await writeFile(join(store, "notes-of-the-account-owner.txt"), "foreign");
    await command(technical, "backup.request");
    expect((await runBackupCycle(new Date(), config())).status).toBe(
      "verified"
    );
    const rows = await runs();
    const verified = rows.filter((row) => row.status === "verified");
    expect(verified).toHaveLength(30);
    const [oldest] = rows.filter((row) => row.id === ids[0]);
    expect(oldest).toMatchObject({
      status: "deleted",
      deleteReason: "retention",
    });
    const files = await storedFiles();
    expect(files).toContain("notes-of-the-account-owner.txt");
    expect(files.some((name) => name.includes(ids[0]))).toBe(false);
    expect(files.some((name) => name.includes(ids[1]))).toBe(true);
    expect(files).toHaveLength(31);
  });

  it("frees the oldest copies for a new one but keeps the newest verified copy", async () => {
    const MB = 1024 * 1024;
    const ids = await seed(3, MB);
    await writeFile(join(store, "foreign.bin"), Buffer.alloc(MB));
    // Four files use 4MB; the quota leaves only a few bytes free.
    const tight = config({
      BACKUP_DIRECTORY_QUOTA_BYTES: String(4 * MB + 10),
    });
    await command(technical, "backup.request");
    expect((await runBackupCycle(new Date(), tight)).status).toBe("verified");
    const rows = await runs();
    const byId = (id: string) => rows.find((row) => row.id === id)!;
    expect(byId(ids[0])).toMatchObject({
      status: "deleted",
      deleteReason: "space",
    });
    expect(byId(ids[1]).status).toBe("verified");
    expect(byId(ids[2]).status).toBe("verified");
    expect(await storedFiles()).toContain("foreign.bin");
  });

  it("fails without deleting anything when even the older copies would not make room", async () => {
    const ids = await seed(2, 1024);
    await writeFile(join(store, "foreign.bin"), Buffer.alloc(8 * 1024 * 1024));
    const full = config({
      BACKUP_DIRECTORY_QUOTA_BYTES: String(8 * 1024 * 1024 + 2048),
    });
    await command(technical, "backup.request");
    expect(await runBackupCycle(new Date(), full)).toMatchObject({
      status: "failed",
      code: "insufficient_space",
    });
    const rows = await runs();
    for (const id of ids)
      expect(rows.find((row) => row.id === id)!.status).toBe("verified");
    expect(await storedFiles()).toHaveLength(3);
    const [notice] = await technicalNotices();
    expect(notice.data.code).toBe("insufficient_space");
    const failed = rows.find((row) => row.status === "failed")!;
    expect(failed.freeBytes).toBe(0);
    expect(
      await db
        .select()
        .from(backupRun)
        .where(
          and(eq(backupRun.status, "deleted"), eq(backupRun.trigger, "daily"))
        )
    ).toEqual([]);
  });
});

describe("a verified backup before a deployment changes the database (card #36)", () => {
  const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
  async function until(check: () => Promise<boolean> | boolean) {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > 10_000) throw new Error("timed out");
      await settle(20);
    }
  }
  const follow = (
    lines: string[] = [],
    overrides: Parameters<typeof backupBeforeDeploy>[1] = {}
  ) => ({
    config: config(),
    pollMs: 20,
    log: (line: string) => lines.push(line),
    ...overrides,
  });

  it("waits for a run already active, then takes and verifies one of its own", async () => {
    await command(technical, "backup.request");
    const lines: string[] = [];
    const deploying = backupBeforeDeploy("abc123def456", follow(lines));
    await settle(150);
    expect(await runs()).toHaveLength(1);
    expect(lines).toEqual([
      expect.stringMatching(/^waiting for backup \S+ \(manual\), now pending$/),
    ]);

    expect((await runBackupCycle(new Date(), config())).status).toBe(
      "verified"
    );
    await until(async () => (await runs()).length === 2);
    expect((await runBackupCycle(new Date(), config())).status).toBe(
      "verified"
    );
    const result = await deploying;

    const rows = await runs();
    expect(rows.map((row) => [row.status, beforeDeploy(row)])).toEqual([
      ["verified", false],
      ["verified", true],
    ]);
    expect(rows[1].key).toMatch(/^deploy:abc123def456:/);
    expect(result).toEqual({
      status: "verified",
      runId: rows[1].id,
      fileName: rows[1].fileName,
    });
    expect(await storedFiles()).toHaveLength(2);
    // The screen tells it apart from a manual request.
    const state = await backupState(db, config());
    expect(state.runs.map((row) => row.beforeDeploy)).toEqual([true, false]);
  });

  it("reports a failed attempt and keeps waiting until the retry is verified", async () => {
    const lines: string[] = [];
    const deploying = backupBeforeDeploy("v2", follow(lines));
    await until(async () => (await runs()).length === 1);
    const now = new Date();
    const broken = {
      ...config(),
      storage: failing(directoryStorage(store), {
        upload: async () => {
          throw new BackupFailure("upload_failed");
        },
      }),
    };
    expect((await runBackupCycle(now, broken)).status).toBe("retry");
    await until(() =>
      lines.some((line) =>
        /attempt 1 failed \(upload_failed\); next attempt at /.test(line)
      )
    );
    expect(
      (await runBackupCycle(new Date(now.getTime() + 16 * MINUTE), config()))
        .status
    ).toBe("verified");
    expect(await deploying).toMatchObject({ status: "verified" });
    expect(lines[0]).toMatch(/^backup \S+ requested; waiting for the worker$/);
  });

  it("ends with the worker's final failure, alerting the technical account", async () => {
    const deploying = backupBeforeDeploy("v3", follow());
    await until(async () => (await runs()).length === 1);
    expect(
      await runBackupCycle(new Date(), config({ AGE_RECIPIENT: "" }))
    ).toMatchObject({ status: "failed", code: "key_missing" });
    expect(await deploying).toMatchObject({
      status: "failed",
      code: "key_missing",
    });
    const notices = await technicalNotices();
    expect(notices).toHaveLength(1);
    expect(String(notices[0].data.body)).toContain("הגיבוי לפני עדכון הגרסה");
  });

  it("stops waiting when no worker takes the run up", async () => {
    const result = await backupBeforeDeploy("v4", follow([], { stallMs: 100 }));
    const [row] = await runs();
    expect(result).toEqual({ status: "stalled", runId: row.id });
    expect(row.status).toBe("pending");
  });

  it("requests nothing where backups are off or restore mode is on", async () => {
    expect(
      await backupBeforeDeploy(
        "v5",
        follow([], { config: config({ BACKUP_STORAGE: "" }) })
      )
    ).toEqual({ status: "disabled" });
    await db
      .insert(operationsState)
      .values({ key: "restore", data: { blocked: true } });
    expect(await backupBeforeDeploy("v5", follow())).toEqual({
      status: "restore",
    });
    expect(await runs()).toEqual([]);
  });

  it("is what the deployment runs: exit code 0 only for a verified copy", async () => {
    const cli = (version: string) =>
      new Promise<{ code: number; output: string }>((resolve, reject) => {
        const child = spawn(
          "node_modules/.bin/tsx",
          ["scripts/backup-before-deploy.ts", version],
          { env: process.env }
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk));
        child.once("error", reject);
        child.once("close", (code) => resolve({ code: code ?? -1, output }));
      });

    const passing = cli("good1234");
    await until(async () => (await runs()).length === 1);
    expect((await runBackupCycle(new Date(), config())).status).toBe(
      "verified"
    );
    const passed = await passing;
    expect(passed.code).toBe(0);
    expect(passed.output).toMatch(/requested; waiting for the worker\n/);
    expect(passed.output).toMatch(/verified: fair-shifts-\S+\.dump\.age\n$/);

    const refused = cli("bad12345");
    await until(async () => (await runs()).length === 2);
    await runBackupCycle(new Date(), config({ AGE_RECIPIENT: "" }));
    const failed = await refused;
    expect(failed.code).toBe(1);
    expect(failed.output).toMatch(
      /failed \(key_missing\); see the backup screen\n$/
    );
  }, 60_000);
});
