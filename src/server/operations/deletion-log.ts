import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../db";
import { operationsState, user } from "../auth-schema";
import { records, soldiers } from "../schema";
import { createRecord, updateRecord } from "../repository";
import { enqueueEmail } from "./email";
import { readRestoreGate } from "./restore-gate";
import { backupConfig } from "./backup";
import type { BackupStorage } from "./backup-storage";
import {
  compareLogs,
  nextEntry,
  parseLog,
  serializeEntry,
  type LogEntry,
  type LogProblem,
  type LogSigner,
  type LogPublicKeys,
} from "../../domain/deletion-log";
import { logPublicKeys, logSigner, matchingLogKeys } from "./deletion-log-keys";

/**
 * The independent deletion log (decision 196, ticket #34). A deletion commits
 * a pending record in the database; this module appends it to a file kept
 * outside the database and its backups, and copies the file to the backup
 * storage. After a restore, the log says which deletions to apply again.
 *
 * Messages that reach logs are English: they are read on the server (decision
 * 187). Nothing sensitive is written: ids, times and hashes only.
 */
export const DELETION_LOG_FILE = "deletion-log.jsonl";
export const DELETION_LOG_KIND = "deletion-log";
export const DELETION_LOG_CHANNEL = "fair_shifts_deletion_log";
export const DELETION_LOG_STATE = "deletion-log";
/** One writer at a time; exported for the test that holds it. */
export const DELETION_LOG_LOCK = 7_461_902;
/** A failure this old is reported to the technical account, once a day. */
const ALERT_AFTER_MS = 10 * 60_000;
const VERIFY_EVERY_MS = 24 * 3_600_000;

type Env = Record<string, string | undefined>;
export type DeletionLogConfig = {
  /** Empty: the log is off in this environment (development and tests that do not need it). */
  directory?: string;
  /** The same storage as the backups; the log is a separate file in it. */
  storage?: BackupStorage;
  publicKeys?: LogPublicKeys;
  signer?: LogSigner;
};

export function deletionLogConfig(env: Env = process.env): DeletionLogConfig {
  return {
    directory: env.DELETION_LOG_DIRECTORY?.trim() || undefined,
    storage: backupConfig(env).storage,
    publicKeys: logPublicKeys(
      env.DELETION_LOG_PUBLIC_KEYS_FILE,
      env.DELETION_LOG_PUBLIC_KEYS
    ),
  };
}

// ---------------------------------------------------------------- the queue

/**
 * Called inside the deletion's own transaction. The record commits together
 * with the deletion, so no committed deletion is ever missing from the queue;
 * the notice reaches the worker only after the commit.
 */
export async function queueDeletionLog(
  tx: DbTransaction,
  soldierId: string,
  at: Date
) {
  const event = await createRecord(
    tx,
    "deletion_log_entry",
    { status: "pending", at: at.toISOString() },
    soldierId
  );
  await tx.execute(sql`select pg_notify(${DELETION_LOG_CHANNEL}, '')`);
  return event;
}

// ---------------------------------------------------------------- the files

type LocalCopy = {
  status: "unconfigured" | "missing" | "intact" | "broken";
  entries: LogEntry[];
  problems: LogProblem[];
  /** Bytes of the intact beginning; a torn last line lies beyond it. */
  intactBytes: number;
  torn: boolean;
};

export const logPath = (directory: string) =>
  join(directory, DELETION_LOG_FILE);

async function readLocal(
  directory?: string,
  publicKeys: LogPublicKeys = {}
): Promise<LocalCopy> {
  const empty = { entries: [], problems: [], intactBytes: 0, torn: false };
  if (!directory) return { ...empty, status: "unconfigured" };
  let text: string;
  try {
    text = await readFile(logPath(directory), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...empty, status: "missing" };
    throw error;
  }
  const { entries, problems } = parseLog(text, publicKeys);
  const intactBytes = Buffer.byteLength(entries.map(serializeEntry).join(""));
  // Only a last line without its newline, cut short by a crash, is repairable.
  const torn =
    problems.length === 1 &&
    problems[0]!.code === "malformed" &&
    problems[0]!.line === entries.length + 1 &&
    !text.endsWith("\n") &&
    text.startsWith(entries.map(serializeEntry).join(""));
  return {
    status: problems.length ? "broken" : "intact",
    entries,
    problems,
    intactBytes,
    torn,
  };
}

async function appendDurably(directory: string, line: string) {
  const handle = await open(logPath(directory), "a", 0o640);
  try {
    await handle.appendFile(line);
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o750 });
}

const digest = (content: Buffer | string) =>
  createHash("sha256").update(content).digest("hex");

// ---------------------------------------------------------------- the copy in storage

type RemoteCopy = {
  status: "unconfigured" | "missing" | "intact" | "broken" | "unreadable";
  entries: LogEntry[];
  problems: LogProblem[];
  /** Every file of the kind the storage holds, with the log each one carries. */
  files: { id: string; entries: LogEntry[]; intact: boolean }[];
  /** Intact copies that tell different histories. */
  conflict: boolean;
};

async function readRemote(
  storage?: BackupStorage,
  publicKeys: LogPublicKeys = {}
): Promise<RemoteCopy> {
  const base = { entries: [], problems: [], files: [], conflict: false };
  if (!storage) return { ...base, status: "unconfigured" };
  try {
    const found = await storage.findKind(DELETION_LOG_KIND);
    if (!found.length) return { ...base, status: "missing" };
    const files: RemoteCopy["files"] = [];
    let problems: LogProblem[] = [];
    for (const file of found) {
      const content = await storage.read(file.id);
      if (!content) continue;
      const parsed = parseLog(content.toString("utf8"), publicKeys);
      files.push({
        id: file.id,
        entries: parsed.entries,
        intact: parsed.problems.length === 0,
      });
      if (parsed.problems.length) problems = parsed.problems;
    }
    if (!files.length) return { ...base, status: "missing" };
    const intact = files.filter((file) => file.intact);
    const best = [...intact].sort(
      (a, b) => b.entries.length - a.entries.length
    )[0];
    // Copies that tell different histories are a conflict, not a choice.
    const conflict = intact.some(
      (file) => compareLogs(file.entries, best!.entries) === "diverged"
    );
    return {
      status: !best || conflict ? "broken" : "intact",
      entries: best?.entries ?? [],
      problems,
      files,
      conflict,
    };
  } catch {
    return { ...base, status: "unreadable" };
  }
}

/**
 * Brings the storage copy up to date: uploads the local file, checks it was
 * stored whole, and only then removes the older copies. A copy that is ahead
 * of, or tells another story than, the local file is never overwritten.
 */
async function publishRemote(
  directory: string,
  storage: BackupStorage,
  local: LogEntry[],
  publicKeys: LogPublicKeys = {}
): Promise<"published" | "current" | "conflict"> {
  const remote = await readRemote(storage, publicKeys);
  if (remote.status === "broken" || remote.status === "unreadable")
    return "conflict";
  const relation = compareLogs(local, remote.entries);
  if (remote.status === "intact" && relation === "diverged") return "conflict";
  if (remote.status === "intact" && relation === "second_ahead")
    return "conflict";
  const path = logPath(directory);
  const content = await readFile(path);
  const hash = digest(content);
  const size = (await stat(path)).size;
  const stale = remote.files.filter((file) => file.intact);
  if (remote.status === "intact" && relation === "same") {
    // Already stored; drop leftovers of earlier uploads.
    const keep = remote.files.find(
      (file) => file.entries.length === local.length
    );
    for (const file of remote.files)
      if (file.id !== keep?.id) await storage.remove(file.id);
    return "current";
  }
  const stored = await storage.upload({
    path,
    name: DELETION_LOG_FILE,
    runId: `${DELETION_LOG_KIND}-${local.length}-${hash.slice(0, 12)}`,
    size,
    kind: DELETION_LOG_KIND,
  });
  if (stored.size !== size || stored.sha256 !== hash) {
    await storage.remove(stored.id);
    return "conflict";
  }
  for (const file of stale) await storage.remove(file.id);
  return "published";
}

// ---------------------------------------------------------------- the state row

type State = {
  headSeq?: number;
  headHash?: string;
  appendedAt?: string;
  remoteSeq?: number;
  remoteAt?: string;
  lastError?: string;
  errorSince?: string;
  alertedAt?: string;
  verifiedAt?: string;
  verified?: { status: string; reasons: string[] };
  appliedThrough?: number;
  appliedAt?: string;
  acknowledgedAt?: string;
};
type Executor = typeof db | DbTransaction;

export async function readState(tx: Executor): Promise<State> {
  const [row] = await tx
    .select()
    .from(operationsState)
    .where(eq(operationsState.key, DELETION_LOG_STATE));
  return (row?.data ?? {}) as State;
}

/** Merges into the row; a key set to null is removed. */
export async function mergeState(tx: Executor, patch: Record<string, unknown>) {
  const state = { ...(await readState(tx)) } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch))
    if (value === null || value === undefined) delete state[key];
    else state[key] = value;
  await tx
    .insert(operationsState)
    .values({ key: DELETION_LOG_STATE, data: state, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: operationsState.key,
      set: { data: state, updatedAt: new Date() },
    });
}

// ---------------------------------------------------------------- verification

export type VerifyReason =
  /** No copy of the log exists anywhere. */
  | "no_log"
  | "local_broken"
  | "remote_broken"
  | "remote_unreadable"
  /** The two copies tell different histories. */
  | "diverged"
  /** The database knows a line the log lacks: the log was cut or replaced. */
  | "database_ahead"
  | "database_mismatch"
  | "verification_keys_missing"
  /** Deleted soldiers the log never recorded. */
  | "unlogged_deletions";
export type VerifyWarning =
  "local_missing" | "remote_missing" | "local_behind" | "remote_behind";

export type LogVerification = {
  status: "verified" | "unverified";
  reasons: VerifyReason[];
  warnings: VerifyWarning[];
  /** Where the log in `entries` came from. */
  source?: "local" | "remote";
  entries: LogEntry[];
  local: Pick<LocalCopy, "status" | "problems"> & { length: number };
  remote: Pick<RemoteCopy, "status" | "problems"> & { length: number };
  unloggedDeletions: string[];
  checkedAt: string;
};

/**
 * Whether the log can be trusted to say what to apply again: at least one copy
 * exists and is intact, the copies agree, and the database does not know of
 * anything the log does not. A copy that is only behind, or missing while the
 * other is whole, is a warning; the whole copy is the log.
 */
export async function verifyDeletionLog(
  tx: Executor,
  config: DeletionLogConfig = deletionLogConfig(),
  options: { strict?: boolean; now?: Date } = {}
): Promise<LogVerification> {
  const strict = options.strict ?? true;
  const local = await readLocal(config.directory, config.publicKeys);
  const remote = await readRemote(config.storage, config.publicKeys);
  const reasons: VerifyReason[] = [];
  if (
    (config.directory || config.storage) &&
    !Object.keys(config.publicKeys ?? {}).length
  )
    reasons.push("verification_keys_missing");
  const warnings: VerifyWarning[] = [];
  const intactLocal = local.status === "intact";
  const intactRemote = remote.status === "intact";
  if (local.status === "broken") reasons.push("local_broken");
  if (remote.conflict) reasons.push("diverged");
  else if (remote.status === "broken") reasons.push("remote_broken");
  if (remote.status === "unreadable" && strict)
    reasons.push("remote_unreadable");
  if (local.status === "missing") warnings.push("local_missing");
  if (remote.status === "missing") warnings.push("remote_missing");

  let chosen: LogEntry[] = [];
  let source: "local" | "remote" | undefined;
  if (intactLocal && intactRemote) {
    const relation = compareLogs(local.entries, remote.entries);
    if (relation === "diverged") {
      if (!reasons.includes("diverged")) reasons.push("diverged");
    } else {
      source = relation === "second_ahead" ? "remote" : "local";
      chosen = source === "remote" ? remote.entries : local.entries;
      if (relation === "first_ahead") warnings.push("remote_behind");
      if (relation === "second_ahead") warnings.push("local_behind");
    }
  } else if (intactLocal) {
    source = "local";
    chosen = local.entries;
  } else if (intactRemote) {
    source = "remote";
    chosen = remote.entries;
  }
  const exists = intactLocal || intactRemote;
  if (!exists && !reasons.length) reasons.push("no_log");

  const state = await readState(tx);
  const unloggedDeletions: string[] = [];
  if (exists && !reasons.includes("diverged")) {
    if (state.headSeq && state.headHash) {
      if (state.headSeq > chosen.length) reasons.push("database_ahead");
      else if (chosen[state.headSeq - 1]?.hash !== state.headHash)
        reasons.push("database_mismatch");
    }
    const logged = new Set(chosen.map((entry) => entry.soldierId));
    const pending = new Set(
      (
        await tx
          .select({ subjectId: records.subjectId, data: records.data })
          .from(records)
          .where(eq(records.kind, "deletion_log_entry"))
      )
        .filter((row) => row.data.status === "pending")
        .map((row) => row.subjectId)
    );
    for (const row of await tx
      .select({ id: soldiers.id })
      .from(soldiers)
      .where(isNotNull(soldiers.deletedAt)))
      if (!logged.has(row.id) && !pending.has(row.id))
        unloggedDeletions.push(row.id);
    if (unloggedDeletions.length) reasons.push("unlogged_deletions");
  }
  return {
    status: reasons.length ? "unverified" : "verified",
    reasons,
    warnings,
    source,
    entries: reasons.length ? [] : chosen,
    local: {
      status: local.status,
      problems: local.problems,
      length: local.entries.length,
    },
    remote: {
      status: remote.status,
      problems: remote.problems,
      length: remote.entries.length,
    },
    unloggedDeletions,
    checkedAt: (options.now ?? new Date()).toISOString(),
  };
}

// ---------------------------------------------------------------- the drain

export type DrainResult =
  | { status: "disabled" | "idle" }
  | { status: "appended"; appended: number; head: number }
  | { status: "failed"; code: DrainFailure };
export type DrainFailure =
  "log_broken" | "log_missing" | "write_failed" | "storage_conflict";

/**
 * Writes every pending deletion to the log, one process at a time (an advisory
 * lock), then brings the storage copy up to date. A line is appended before its
 * record is marked, so a crash between the two finds the line already there and
 * only marks it: no entry is lost, none is written twice. The log is never
 * started afresh while the database or the storage says it should have history.
 */
export async function drainDeletionLog(
  config: DeletionLogConfig = deletionLogConfig(),
  now = new Date()
): Promise<DrainResult> {
  const directory = config.directory;
  if (!directory) return { status: "disabled" };
  const signer = config.signer ?? logSigner();
  if (!signer || !matchingLogKeys(signer, config.publicKeys ?? {})) {
    await recordFailure("write_failed", now);
    return { status: "failed", code: "write_failed" };
  }
  // A restored database is not appended to before its deletions are applied.
  if (
    process.env.RESTORE_MODE === "true" ||
    (await readRestoreGate(db)).blocked
  )
    return { status: "idle" };
  let result: DrainResult = { status: "idle" };
  let entries: LogEntry[] = [];
  let failure = undefined as DrainFailure | undefined;
  try {
    await ensureDirectory(directory);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${DELETION_LOG_LOCK})`);
      const state = await readState(tx);
      let local = await readLocal(directory, config.publicKeys);
      if (local.status === "broken" && local.torn) {
        // A repair may remove only bytes beyond the committed database witness.
        if (
          state.headSeq &&
          (!state.headHash ||
            local.entries[state.headSeq - 1]?.hash !== state.headHash)
        ) {
          failure = "storage_conflict";
          return;
        }
        await truncate(logPath(directory), local.intactBytes);
        local = await readLocal(directory, config.publicKeys);
      }
      if (local.status === "broken") {
        failure = "log_broken";
        return;
      }
      if (local.status === "missing") {
        // A fresh volume with history elsewhere: take it from the storage copy
        // when it is whole; otherwise start empty only if nothing says there was a log.
        const remote = await readRemote(config.storage, config.publicKeys);
        if (remote.status === "intact" && remote.entries.length) {
          await writeFile(
            logPath(directory),
            remote.entries.map(serializeEntry).join(""),
            { mode: 0o640 }
          );
        } else if (
          remote.status === "broken" ||
          remote.status === "unreadable" ||
          (state.headSeq ?? 0) > 0
        ) {
          failure = "log_missing";
          return;
        } else await writeFile(logPath(directory), "", { mode: 0o640 });
        local = await readLocal(directory, config.publicKeys);
      }
      // Never replace a newer database witness with a valid, older signed prefix.
      // A crash may leave the file ahead of the DB; it must still contain its head.
      if (
        state.headSeq &&
        (!state.headHash ||
          local.entries[state.headSeq - 1]?.hash !== state.headHash)
      ) {
        failure = "storage_conflict";
        return;
      }
      entries = local.entries;
      const pending = (
        await tx
          .select()
          .from(records)
          .where(eq(records.kind, "deletion_log_entry"))
          .orderBy(asc(records.createdAt), asc(records.id))
      ).filter((row) => row.data.status === "pending");
      let appended = 0;
      for (const row of pending) {
        let entry = entries.find((item) => item.id === row.id);
        if (!entry) {
          entry = nextEntry(
            entries.at(-1),
            {
              id: row.id,
              soldierId: row.subjectId!,
              at: String(row.data.at),
            },
            signer
          );
          await appendDurably(directory, serializeEntry(entry));
          entries = [...entries, entry];
          appended++;
        }
        await updateRecord(tx, row, {
          ...row.data,
          status: "logged",
          seq: entry.seq,
          loggedAt: now.toISOString(),
        });
      }
      const head = entries.at(-1);
      await mergeState(tx, {
        headSeq: head?.seq ?? 0,
        headHash: head?.hash ?? null,
        ...(appended && { appendedAt: now.toISOString() }),
        lastError: null,
        errorSince: null,
      });
      result = appended
        ? { status: "appended", appended, head: head!.seq }
        : { status: "idle" };
    });
  } catch {
    failure = "write_failed";
  }
  // An empty log is not copied: there is nothing to apply again, and the first
  // deletion creates the copy.
  if (!failure && config.storage && entries.length) {
    try {
      const outcome = await publishRemote(
        directory,
        config.storage,
        entries,
        config.publicKeys
      );
      if (outcome === "conflict") failure = "storage_conflict";
      else
        await mergeState(db, {
          remoteSeq: entries.length,
          remoteAt: now.toISOString(),
        });
    } catch {
      // The copy is retried on the next drain; the local log is already safe.
    }
  }
  if (failure) {
    await recordFailure(failure, now);
    return { status: "failed", code: failure };
  }
  await dailyVerification(config, now);
  return result;
}

const failureText: Record<DrainFailure, string> = {
  log_broken: "The deletion log file is damaged",
  log_missing: "The deletion log file is missing",
  write_failed: "The deletion log could not be written",
  storage_conflict: "The deletion log copy in storage does not match",
};

/** Notes the failure, and reports it once a day after it lasted ten minutes. */
async function recordFailure(code: DrainFailure, now: Date) {
  console.error("Deletion log failure:", failureText[code]);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${DELETION_LOG_LOCK})`);
    const state = await readState(tx);
    const since = state.errorSince ?? now.toISOString();
    const patch: Record<string, unknown> = {
      lastError: code,
      errorSince: since,
    };
    const lasted = now.getTime() - new Date(since).getTime();
    const alerted = state.alertedAt
      ? now.getTime() - new Date(state.alertedAt).getTime() < 86_400_000
      : false;
    if (lasted >= ALERT_AFTER_MS && !alerted) {
      await alertTechnical(tx, code, now);
      patch.alertedAt = now.toISOString();
    }
    await mergeState(tx, patch);
  });
}

/** One site notice and one email to each technical account. */
async function alertTechnical(
  tx: DbTransaction,
  code: DrainFailure,
  now: Date
) {
  const accounts = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.role, "technical"), isNull(user.deletedAt)));
  const title = "יומן המחיקות אינו מתעדכן";
  const body =
    "מחיקות חיילים אינן נרשמות ביומן העצמאי, ולכן שחזור מגיבוי עלול להחזיר מידע שנמחק. יש לבדוק את מצב היומן במסך תמונת המצב ובלוג העובד.";
  for (const account of accounts) {
    await createRecord(tx, "notification", {
      accountId: account.id,
      title,
      body,
      href: "/technical",
      code,
    });
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey: `deletion-log:${code}:${now.toISOString().slice(0, 10)}:${account.id}`,
      kind: "backup-alert",
      title,
      body,
      href: "/technical",
      priority: 1,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
  }
}

/** The log is checked against the storage copy and the database once a day. */
async function dailyVerification(config: DeletionLogConfig, now: Date) {
  const state = await readState(db);
  if (
    state.verifiedAt &&
    now.getTime() - new Date(state.verifiedAt).getTime() < VERIFY_EVERY_MS
  )
    return;
  const result = await verifyDeletionLog(db, config, { strict: false, now });
  await mergeState(db, {
    verifiedAt: now.toISOString(),
    verified: { status: result.status, reasons: result.reasons },
  });
  if (result.status === "unverified")
    console.error("Deletion log verification:", result.reasons.join(", "));
}

// ---------------------------------------------------------------- what the technical screen shows

export type DeletionLogStatus = {
  enabled: boolean;
  /** Deletions committed but not yet in the log. */
  pending: number;
  oldestPendingAt?: string;
  entries: number;
  appendedAt?: string;
  storageCopy: "none" | "current" | "behind";
  lastError?: string;
  verifiedAt?: string;
  verified?: { status: string; reasons: string[] };
  appliedThrough?: number;
};

/** Counts and times only; no soldier, id or content. */
export async function readDeletionLogStatus(
  tx: Executor,
  config: DeletionLogConfig = deletionLogConfig()
): Promise<DeletionLogStatus> {
  const state = await readState(tx);
  const pending = (
    await tx
      .select({ data: records.data, createdAt: records.createdAt })
      .from(records)
      .where(eq(records.kind, "deletion_log_entry"))
  ).filter((row) => row.data.status === "pending");
  const oldest = pending
    .map((row) => row.createdAt.getTime())
    .sort((a, b) => a - b)[0];
  const entries = state.headSeq ?? 0;
  return {
    enabled: Boolean(config.directory),
    pending: pending.length,
    oldestPendingAt: oldest ? new Date(oldest).toISOString() : undefined,
    entries,
    appendedAt: state.appendedAt,
    // An empty log is not copied, so there is nothing for the copy to lack.
    storageCopy: !config.storage
      ? "none"
      : entries === 0 || (state.remoteSeq ?? 0) >= entries
        ? "current"
        : "behind",
    lastError: state.lastError,
    verifiedAt: state.verifiedAt,
    verified: state.verified,
    appliedThrough: state.appliedThrough,
  };
}

/** Writes the chosen log back to the local file, for a fresh volume after a restore. */
export async function restoreLocalCopy(
  config: DeletionLogConfig,
  entries: LogEntry[]
) {
  if (!config.directory) return;
  await ensureDirectory(config.directory);
  await writeFile(
    logPath(config.directory),
    entries.map(serializeEntry).join(""),
    { mode: 0o640 }
  );
}
