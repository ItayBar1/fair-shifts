import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, type DbTransaction } from "../db";
import { backupRun, operationsState, user } from "../auth-schema";
import { AppError } from "../errors";
import { audit, createRecord, technical, type Actor } from "../repository";
import { enqueueEmail } from "./email";
import { readWorkerBackup } from "./health";
import {
  BackupFailure,
  directoryStorage,
  driveStorage,
  type BackupStorage,
} from "./backup-storage";
import {
  DEFAULT_BACKUP_TIME,
  MAX_ATTEMPTS,
  MAX_BACKUPS,
  beyondRetention,
  dailyBackupDue,
  failureLabels,
  isTransient,
  retryDelay,
  spaceToFree,
  validBackupTime,
  type BackupFailureCode,
} from "../../domain/backup";
import { UNIT_ZONE } from "../../domain/time";

type Env = Record<string, string | undefined>;
export type BackupRun = typeof backupRun.$inferSelect;
export type BackupConfig = {
  /** none: backups are switched off in this environment (no runs, no alerts). */
  kind: "drive" | "directory" | "none";
  /** Undefined when the chosen target lacks settings: runs fail as not_configured. */
  storage?: BackupStorage;
  /** age public key; the private key never reaches the server. */
  recipient?: string;
  time: string;
  workDirectory: string;
  databaseUrl: string;
};

/** Must be longer than a dump and upload; an expired lease is taken over. */
const LEASE_MS = 60 * 60_000;
const AGE_RECIPIENT = /^age1[0-9a-z]{58}$/;
export const validRecipient = (value: string) => AGE_RECIPIENT.test(value);

export function backupConfig(env: Env = process.env): BackupConfig {
  const value = (name: string) => env[name]?.trim() ?? "";
  const kind = value("BACKUP_STORAGE");
  const recipient = value("AGE_RECIPIENT");
  const base = {
    recipient: validRecipient(recipient) ? recipient : undefined,
    time: validBackupTime(value("BACKUP_TIME"))
      ? value("BACKUP_TIME")
      : DEFAULT_BACKUP_TIME,
    workDirectory:
      value("BACKUP_WORK_DIRECTORY") || join(tmpdir(), "fair-shifts-backups"),
    databaseUrl: value("DATABASE_URL"),
  };
  if (kind === "drive") {
    const [clientId, clientSecret, refreshToken] = [
      "GOOGLE_DRIVE_CLIENT_ID",
      "GOOGLE_DRIVE_CLIENT_SECRET",
      "GOOGLE_DRIVE_REFRESH_TOKEN",
    ].map(value);
    return {
      ...base,
      kind,
      storage:
        clientId && clientSecret && refreshToken
          ? driveStorage({
              clientId,
              clientSecret,
              refreshToken,
              folderId: value("GOOGLE_DRIVE_FOLDER_ID") || undefined,
            })
          : undefined,
    };
  }
  if (kind === "directory") {
    const quota = Number(value("BACKUP_DIRECTORY_QUOTA_BYTES"));
    return {
      ...base,
      kind,
      storage: value("BACKUP_DIRECTORY")
        ? directoryStorage(
            value("BACKUP_DIRECTORY"),
            quota > 0 ? quota : undefined
          )
        : undefined,
    };
  }
  return { ...base, kind: "none" };
}

// ---------------------------------------------------------------- dump

/**
 * pg_dump takes one consistent snapshot of the live database. Its output goes
 * straight into age, so only ciphertext is written to disk. The job queue
 * (pgboss) is transient and left out.
 */
export async function dumpEncrypted(
  databaseUrl: string,
  recipient: string,
  target: string
) {
  const url = new URL(databaseUrl);
  const password = decodeURIComponent(url.password);
  url.password = "";
  const dump = spawn(
    "pg_dump",
    [
      "--format=custom",
      "--exclude-schema=pgboss",
      "--no-password",
      `--dbname=${url.toString()}`,
    ],
    {
      env: { ...process.env, PGPASSWORD: password },
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  const age = spawn("age", ["--encrypt", "--recipient", recipient], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = (child: ChildProcess) =>
    new Promise<number>((resolve) => {
      child.once("error", () => resolve(-1));
      child.once("close", (code) => resolve(code ?? -1));
    });
  const dumpExit = exited(dump);
  const ageExit = exited(age);
  const hash = createHash("sha256");
  let size = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await Promise.all([
      pipeline(dump.stdout, age.stdin),
      pipeline(age.stdout, measure, createWriteStream(target, { mode: 0o600 })),
    ]);
  } catch {
    dump.kill();
    age.kill();
    throw new BackupFailure("dump_failed");
  }
  const [dumpCode, ageCode] = await Promise.all([dumpExit, ageExit]);
  if (dumpCode !== 0 || ageCode !== 0 || size === 0)
    throw new BackupFailure("dump_failed");
  return { size, sha256: hash.digest("hex") };
}

// ---------------------------------------------------------------- cycle

async function restoreBlocked() {
  if (process.env.RESTORE_MODE === "true") return true;
  const [row] = await db
    .select()
    .from(operationsState)
    .where(eq(operationsState.key, "restore"));
  return row?.data.blocked === true;
}

/** Creates today's daily run once; a pending or running run defers it. */
export async function scheduleDaily(now: Date, time: string) {
  const key = dailyBackupDue(now, time);
  if (!key) return;
  await db
    .insert(backupRun)
    .values({ id: randomUUID(), key, trigger: "daily", nextAttemptAt: now })
    .onConflictDoNothing();
}

/**
 * Takes the next due run. Row locks with SKIP LOCKED and the single-active
 * index keep two workers from running the same or two backups at once.
 */
async function claim(now: Date): Promise<BackupRun | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(backupRun)
      .where(
        or(
          and(
            eq(backupRun.status, "pending"),
            lte(backupRun.nextAttemptAt, now)
          ),
          and(eq(backupRun.status, "running"), lte(backupRun.leaseUntil, now))
        )
      )
      .orderBy(backupRun.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return undefined;
    // A run whose worker died three times is not started a fourth time.
    if (row.attempts >= MAX_ATTEMPTS) {
      await failRun(tx, row, "internal", now);
      return undefined;
    }
    const [claimed] = await tx
      .update(backupRun)
      .set({
        status: "running",
        attempts: row.attempts + 1,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(backupRun.id, row.id))
      .returning();
    return claimed;
  });
}

/** Only the holder of the current lease may finish a run. */
const holding = (run: BackupRun) =>
  and(
    eq(backupRun.id, run.id),
    eq(backupRun.status, "running"),
    eq(backupRun.leaseUntil, run.leaseUntil!)
  );

async function verifiedCopies(executor: typeof db | DbTransaction) {
  return (
    await executor
      .select()
      .from(backupRun)
      .where(eq(backupRun.status, "verified"))
  ).map((row) => ({
    id: row.id,
    storageId: row.storageId!,
    finishedAt: row.finishedAt!,
    sizeBytes: row.sizeBytes ?? 0,
  }));
}

async function removeCopies(
  storage: BackupStorage,
  rows: { id: string; storageId: string }[],
  reason: "retention" | "space",
  now: Date
) {
  for (const row of rows) {
    await storage.remove(row.storageId);
    await db
      .update(backupRun)
      .set({
        status: "deleted",
        deletedAt: now,
        deleteReason: reason,
        updatedAt: now,
      })
      .where(and(eq(backupRun.id, row.id), eq(backupRun.status, "verified")));
  }
}

async function execute(run: BackupRun, config: BackupConfig, now: Date) {
  const { storage } = config;
  if (!storage) throw new BackupFailure("not_configured");
  if (!config.recipient) throw new BackupFailure("key_missing");
  // Leftovers of an attempt that died mid-upload belong to this run only.
  for (const file of await storage.findRun(run.id))
    await storage.remove(file.id);
  const freeBytes = await storage.freeBytes();
  await mkdir(config.workDirectory, { recursive: true, mode: 0o700 });
  const local = join(config.workDirectory, `${run.id}.dump.age`);
  await rm(local, { force: true });
  try {
    const { size, sha256 } = await dumpEncrypted(
      config.databaseUrl,
      config.recipient,
      local
    );
    await db
      .update(backupRun)
      .set({ freeBytes: freeBytes ?? null, updatedAt: now })
      .where(holding(run));
    const plan = spaceToFree(await verifiedCopies(db), size, freeBytes);
    if (!plan.fits) throw new BackupFailure("insufficient_space");
    await removeCopies(storage, plan.remove, "space", now);
    const stamp = DateTime.fromJSDate(now)
      .setZone(UNIT_ZONE)
      .toFormat("yyyyLLdd-HHmmss");
    const fileName = `fair-shifts-${stamp}-${run.id.slice(0, 8)}.dump.age`;
    const uploaded = await storage.upload({
      path: local,
      name: fileName,
      runId: run.id,
      size,
    });
    // Verified means the stored copy matches what was encrypted here, read back from the target.
    const stored = await storage.get(uploaded.id);
    if (!stored || stored.size !== size || stored.sha256 !== sha256) {
      await storage.remove(uploaded.id);
      throw new BackupFailure("upload_failed");
    }
    return { fileName, storageId: stored.id, size, sha256 };
  } finally {
    await rm(local, { force: true });
  }
}

async function failRun(
  tx: DbTransaction,
  run: BackupRun,
  code: BackupFailureCode,
  now: Date
) {
  const retry = isTransient(code) && run.attempts < MAX_ATTEMPTS;
  const [row] = await tx
    .update(backupRun)
    .set({
      status: retry ? "pending" : "failed",
      errorCode: code,
      leaseUntil: null,
      finishedAt: retry ? null : now,
      nextAttemptAt: retry
        ? new Date(now.getTime() + retryDelay(run.attempts))
        : run.nextAttemptAt,
      alertedAt: retry ? null : now,
      updatedAt: now,
    })
    .where(
      and(
        eq(backupRun.id, run.id),
        run.status === "running" ? holding(run) : undefined,
        isNull(backupRun.alertedAt)
      )
    )
    .returning();
  if (row && !retry) await alertTechnical(tx, row, code, now);
}

/** One site notice and one email per technical account for a run that gave up. */
async function alertTechnical(
  tx: DbTransaction,
  run: BackupRun,
  code: BackupFailureCode,
  now: Date
) {
  const accounts = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.role, "technical"), isNull(user.deletedAt)));
  const title = "הגיבוי נכשל";
  const body = `${failureLabels[code]}. ${
    run.trigger === "daily"
      ? "הגיבוי היומי"
      : beforeDeploy(run)
        ? "הגיבוי לפני עדכון הגרסה"
        : "הגיבוי הידני"
  } לא הושלם${run.attempts > 1 ? ` אחרי ${run.attempts} ניסיונות` : ""}. יש לבדוק במסך הגיבוי.`;
  for (const account of accounts) {
    await createRecord(tx, "notification", {
      accountId: account.id,
      title,
      body,
      href: "/technical/backups",
      backupRunId: run.id,
      code,
    });
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey: `backup:${run.id}:${account.id}`,
      kind: "backup-alert",
      title,
      body,
      href: "/technical/backups",
      priority: 1,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
  }
}

export type CycleResult =
  | { status: "disabled" | "paused" | "idle" }
  | { status: "verified"; runId: string }
  | { status: "failed" | "retry"; runId: string; code: BackupFailureCode };

/** Called by the worker every minute; does nothing unless a run is due. */
export async function runBackupCycle(
  now = new Date(),
  config = backupConfig()
): Promise<CycleResult> {
  if (config.kind === "none") return { status: "disabled" };
  if (await restoreBlocked()) return { status: "paused" };
  await scheduleDaily(now, config.time);
  const run = await claim(now);
  if (!run) return { status: "idle" };
  try {
    const result = await execute(run, config, now);
    const [done] = await db
      .update(backupRun)
      .set({
        status: "verified",
        fileName: result.fileName,
        storageKind: config.kind,
        storageId: result.storageId,
        sizeBytes: result.size,
        sha256: result.sha256,
        errorCode: null,
        leaseUntil: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(holding(run))
      .returning();
    // Lost the lease: the copy is not recorded, so remove it rather than leave an orphan.
    if (!done) {
      await config.storage!.remove(result.storageId);
      return { status: "idle" };
    }
    await removeCopies(
      config.storage!,
      beyondRetention(await verifiedCopies(db)),
      "retention",
      now
    );
    return { status: "verified", runId: run.id };
  } catch (error) {
    const code = error instanceof BackupFailure ? error.code : "internal";
    if (code === "internal")
      console.error(
        "Backup failed",
        error instanceof Error ? error.name : "unknown"
      );
    await db.transaction((tx) => failRun(tx, run, code, now));
    const retry = isTransient(code) && run.attempts < MAX_ATTEMPTS;
    return { status: retry ? "retry" : "failed", runId: run.id, code };
  }
}

// ---------------------------------------------------------------- screen

export async function requestBackup(
  tx: DbTransaction,
  actor: Actor,
  config = backupConfig()
) {
  technical(actor);
  const kind =
    process.env.SERVICE_ROLE === "app"
      ? (await readWorkerBackup(tx)).kind
      : config.kind;
  if (kind === "none")
    throw new AppError("backup_disabled", "הגיבוי אינו מופעל בסביבה הזאת", 409);
  const [row] = await tx
    .insert(backupRun)
    .values({
      id: randomUUID(),
      key: `manual:${randomUUID()}`,
      trigger: "manual",
      requestedBy: actor.id,
    })
    .onConflictDoNothing()
    .returning();
  if (!row)
    throw new AppError(
      "backup_active",
      "גיבוי אחר כבר ממתין או רץ. אפשר לעקוב אחריו ברשימה",
      409
    );
  await audit(tx, actor, "backup.request", row.id);
  return { id: row.id };
}

/** Technical view: configuration presence (never values) and recent runs. */
export async function backupState(
  executor: typeof db | DbTransaction,
  config = backupConfig()
) {
  const runs = await executor
    .select()
    .from(backupRun)
    .orderBy(desc(backupRun.createdAt))
    .limit(60);
  const [counts] = await executor
    .select({
      verified: sql<number>`count(*) filter (where ${backupRun.status} = 'verified')::int`,
      lastVerifiedAt: sql<Date | null>`max(${backupRun.finishedAt}) filter (where ${backupRun.status} = 'verified')`,
    })
    .from(backupRun);
  const reported =
    process.env.SERVICE_ROLE === "app"
      ? await readWorkerBackup(executor)
      : {
          kind: config.kind,
          storageConfigured: Boolean(config.storage),
          keyConfigured: Boolean(config.recipient),
          time: config.time,
        };
  return {
    ...reported,
    max: MAX_BACKUPS,
    retained: counts?.verified ?? 0,
    lastVerifiedAt: counts?.lastVerifiedAt
      ? new Date(counts.lastVerifiedAt).toISOString()
      : undefined,
    runs: runs.map((row) => ({
      id: row.id,
      trigger: row.trigger,
      beforeDeploy: beforeDeploy(row),
      status: row.status,
      attempts: row.attempts,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      nextAttemptAt: row.status === "pending" ? row.nextAttemptAt : undefined,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      freeBytes: row.freeBytes,
      errorCode: row.errorCode,
      deleteReason: row.deleteReason,
    })),
  };
}

// ---------------------------------------------------------------- deploy

const DEPLOY_KEY = "deploy:";
/** A run that the automatic deployment requested before migrating. */
export const beforeDeploy = (run: Pick<BackupRun, "key">) =>
  run.key.startsWith(DEPLOY_KEY);

export type DeployBackupResult =
  | { status: "verified"; runId: string; fileName: string }
  | { status: "failed"; runId: string; code: string }
  | { status: "stalled"; runId: string }
  | { status: "disabled" | "restore" };

/**
 * A verified backup before a deployment changes the database (card #36).
 * scripts/backup-before-deploy.ts runs it in the worker of the version still
 * live. It waits for a run that is already pending or running, then requests
 * one of its own and follows it while the worker takes, retries and verifies
 * it. Attempts are bounded, so the wait ends; a run that no worker takes up
 * within `stallMs` of being due ends it too, rather than holding the
 * deployment forever. Progress lines are English: they are read in the
 * deployment journal on the server (decision 187).
 */
export async function backupBeforeDeploy(
  version: string,
  {
    config = backupConfig(),
    pollMs = 5_000,
    stallMs = 10 * 60_000,
    log = (line: string) => console.log(line),
  }: {
    config?: BackupConfig;
    pollMs?: number;
    stallMs?: number;
    log?: (line: string) => void;
  } = {}
): Promise<DeployBackupResult> {
  if (config.kind === "none") return { status: "disabled" };
  if (await restoreBlocked()) return { status: "restore" };
  let own: string | undefined;
  let last = "";
  for (;;) {
    if (!own) {
      const [row] = await db
        .insert(backupRun)
        .values({
          id: randomUUID(),
          key: `${DEPLOY_KEY}${version}:${randomUUID()}`,
          trigger: "manual",
        })
        .onConflictDoNothing()
        .returning();
      own = row?.id;
    }
    const [run] = await db
      .select()
      .from(backupRun)
      .where(
        own
          ? eq(backupRun.id, own)
          : inArray(backupRun.status, ["pending", "running"])
      )
      .limit(1);
    if (run && own && run.status === "verified")
      return { status: "verified", runId: run.id, fileName: run.fileName! };
    if (run && own && run.status !== "pending" && run.status !== "running")
      return { status: "failed", runId: run.id, code: run.errorCode ?? "" };
    if (run) {
      const line = deployProgress(run, Boolean(own));
      if (line !== last) log((last = line));
      const due = run.status === "pending" ? run.nextAttemptAt : run.leaseUntil;
      if (due && Date.now() > due.getTime() + stallMs)
        return { status: "stalled", runId: run.id };
    }
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

function deployProgress(run: BackupRun, own: boolean) {
  const id = run.id.slice(0, 8);
  if (!own)
    return `waiting for backup ${id} (${run.trigger}), now ${run.status}`;
  if (run.status === "running")
    return `backup ${id} is running (attempt ${run.attempts})`;
  if (run.errorCode)
    return `backup ${id} attempt ${run.attempts} failed (${run.errorCode}); next attempt at ${run.nextAttemptAt.toISOString()}`;
  return `backup ${id} requested; waiting for the worker`;
}
