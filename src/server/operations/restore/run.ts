import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { DateTime } from "luxon";
import { Client } from "pg";
import { connectDatabase, type Database, type DbTransaction } from "../../db";
import { staffNotificationRecipients } from "../../notification-audience";
import {
  emailOutbox,
  loginCode,
  session,
  verification,
} from "../../auth-schema";
import { audit, createRecord } from "../../repository";
import { enqueueEmail } from "../email";
import { RESTORE_ACTOR, applyLoggedDeletions } from "../../restore-deletions";
import type { DeletionLogConfig } from "../deletion-log";
import {
  DELETION_LOG_BLOCKER,
  clearRestoreBlocker,
  raiseRestoreBlocker,
} from "../restore-gate";
import { UNIT_ZONE } from "../../../domain/time";
import {
  RESTORE_CHECKS_BLOCKER,
  SAMPLE_LIMIT,
  restoreNoticeText,
  restoreOutcome,
  type CheckResult,
  type DeletionLogOutcome,
  type RestoreActions,
  type RestoreCounts,
  type RestoreOutcome,
  type RestoreReport,
} from "../../../domain/restore";
import {
  createScratch,
  databaseName,
  dropDatabase,
  exists,
  noop,
  quoteName,
  scratchName,
  urlFor,
  withAdmin,
} from "./database";
import { REPORT_STATE, recordDrill, writeState } from "./drill";
import { RestoreFailure } from "./failures";
import {
  type SourceInput,
  backupMigrations,
  locateBackup,
  migrationsFolder,
  restoreInto,
} from "./source";
import { rowCounts, verifyRestoredData } from "./verify";

// ---------------------------------------------------------------- opening a restored system

/**
 * A backup is an old picture: whoever signed in or was waiting for a code then
 * may have lost access since, and mail that was queued has mostly been sent.
 * Both are cleared before the system opens (decision 200).
 */
export async function clearStaleAccess(tx: DbTransaction, now: Date) {
  const sessions = await tx.delete(session).returning({ id: session.id });
  const codes = await tx.delete(loginCode).returning({ id: loginCode.userId });
  const tokens = await tx
    .delete(verification)
    .returning({ id: verification.id });
  const mail = await tx
    .update(emailOutbox)
    .set({
      status: "cancelled",
      error: "restored",
      title: "",
      body: "",
      href: null,
      destination: null,
      encryptedSecret: null,
      updatedAt: now,
    })
    .where(inArray(emailOutbox.status, ["pending", "sending"]))
    .returning({ id: emailOutbox.id });
  return {
    sessionsRevoked: sessions.length,
    codesRemoved: codes.length + tokens.length,
    mailCancelled: mail.length,
  };
}

/** The managers and the technical account learn what the restore left behind. */
export async function announceRestore(
  tx: DbTransaction,
  input: { restoreId: string; restorePoint?: Date; mailCancelled: number },
  now: Date
) {
  const text = restoreNoticeText(input);
  const staff = await staffNotificationRecipients(
    tx,
    ["manager", "technical"],
    now
  );
  for (const account of staff) {
    const href = account.role === "technical" ? "/technical" : "/manage";
    await createRecord(tx, "notification", {
      accountId: account.id,
      ...text,
      href,
      restoreId: input.restoreId,
    });
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey: `restore:${input.restoreId}:${account.id}`,
      kind: "restore",
      ...text,
      href,
      priority: 1,
      expiresAt: new Date(now.getTime() + 2 * 86_400_000),
    });
  }
  return staff.length;
}

// ---------------------------------------------------------------- the run

export type RestoreRun = {
  mode: "drill" | "restore";
  source: SourceInput;
  /** An age identity file; the private key never lives on the server. */
  identity?: string;
  /** The live database: names derive from it, and a restore replaces it. */
  liveUrl: string;
  /** Connection to the live database, for the run table and the drill record. */
  live?: Database;
  deletionLog: DeletionLogConfig;
  /** Keep the scratch database of a drill. A restore always keeps its own. */
  keep?: boolean;
  now?: Date;
  log?: (line: string) => void;
};

export type RestoreResult = {
  report: RestoreReport;
  /** The database that holds the restored copy; undefined when it was dropped. */
  database?: string;
};

export async function runRestore(options: RestoreRun): Promise<RestoreResult> {
  const log = options.log ?? noop;
  const now = options.now ?? new Date();
  const name = scratchName(options.liveUrl, options.mode);
  const url = urlFor(options.liveUrl, name);
  const restoreId = randomUUID();
  const startedAt = new Date().toISOString();
  let created = false;
  let scratch: ReturnType<typeof connectDatabase> | undefined;
  const close = async () => {
    const pool = scratch?.pool;
    scratch = undefined;
    await pool?.end().catch(() => {});
  };
  const record = async (outcome: RestoreOutcome, point?: string) => {
    if (options.mode === "drill" && options.live)
      await recordDrill(options.live, outcome, point, now).catch(() =>
        log("The result could not be recorded in the live database")
      );
  };
  try {
    log("Locating the backup");
    const located = await locateBackup(options.source, options.live);
    log(
      `Backup ${located.source.name ?? ""} (${located.source.sizeBytes} bytes)${located.restorePoint ? `, taken ${located.restorePoint.toISOString()}` : ""}`
    );
    await createScratch(options.liveUrl, name, options.mode === "drill");
    created = true;
    log(`Restoring into the separate database ${name}`);
    await restoreInto(url, located, options.identity);

    scratch = connectDatabase(url);
    const target = scratch.db;
    const migrations = await backupMigrations(target);
    const restorePoint = located.restorePoint?.toISOString();
    const base = {
      id: restoreId,
      mode: options.mode,
      startedAt,
      source: located.source,
      restorePoint,
      schema: { inBackup: migrations.inBackup, inApp: migrations.inApp },
    };
    let report: RestoreReport;
    if (migrations.unknown.length || migrations.inBackup === 0) {
      // The schema is not one this version understands, so nothing else can be asked of it.
      const failed: CheckResult = {
        id: "migrations_known",
        status: "fail",
        count: migrations.unknown.length || 1,
        samples: migrations.unknown.slice(0, SAMPLE_LIMIT).map(String),
      };
      report = {
        ...base,
        finishedAt: new Date().toISOString(),
        counts: emptyCounts,
        deletionLog: skippedLog,
        checks: [failed],
        outcome: "failed",
      };
    } else {
      log("Bringing the copy up to this version's schema");
      await migrate(target, { migrationsFolder: migrationsFolder() });
      if (process.env.SERVICE_ROLE === "operations") {
        const { applyDatabaseGrants } = await import("../database-permissions");
        await applyDatabaseGrants(target);
      }
      // Closed first: whatever happens next, nobody opens this database half checked.
      await raiseRestoreBlocker(target, RESTORE_CHECKS_BLOCKER, {
        restoreId,
        startedAt,
      });
      let cleared = { sessionsRevoked: 0, codesRemoved: 0, mailCancelled: 0 };
      if (options.mode === "restore") {
        log("Revoking sessions and sign-in codes, cancelling queued mail");
        cleared = await target.transaction((tx) => clearStaleAccess(tx, now));
      }
      log("Applying the deletions made since the backup");
      const deletionLog = await applyDeletions(
        target,
        options.deletionLog,
        now,
        options.mode === "restore"
      );
      log("Running the checks");
      const checks: CheckResult[] = [
        { id: "migrations_known", status: "pass", count: 0, samples: [] },
        ...(await verifyRestoredData(target, now)),
      ];
      const outcome = restoreOutcome(checks, deletionLog);
      let actions: RestoreActions | undefined;
      if (options.mode === "restore" && outcome !== "failed") {
        const notices = await target.transaction((tx) =>
          announceRestore(
            tx,
            {
              restoreId,
              restorePoint: located.restorePoint,
              mailCancelled: cleared.mailCancelled,
            },
            now
          )
        );
        actions = { ...cleared, noticesCreated: notices };
        await clearRestoreBlocker(target, RESTORE_CHECKS_BLOCKER, {
          restoreId,
          clearedAt: now.toISOString(),
        });
      }
      report = {
        ...base,
        finishedAt: new Date().toISOString(),
        counts: await rowCounts(target),
        deletionLog,
        checks,
        ...(actions && { actions }),
        outcome,
      };
    }
    if (options.mode === "restore") {
      await writeState(target, REPORT_STATE, report, now);
      await target.transaction(async (tx) => {
        await audit(tx, RESTORE_ACTOR, "restore.complete", restoreId, {
          outcome: report.outcome,
          restorePoint,
          checks: report.checks.filter((check) => check.status !== "pass")
            .length,
        });
        if (report.outcome === "passed")
          await recordDrill(tx, "passed", restorePoint, now);
      });
    }
    await record(report.outcome, restorePoint);
    // A restore keeps its copy for the swap; a drill drops its own unless asked to keep it.
    await close();
    const keep = options.mode === "restore" || options.keep === true;
    if (!keep) {
      await dropDatabase(options.liveUrl, name);
      created = false;
    }
    return { report, database: keep ? name : undefined };
  } catch (error) {
    // A restore that could not even load is a failed drill, and its scratch copy is useless.
    await close();
    if (created) await dropDatabase(options.liveUrl, name).catch(() => {});
    if (error instanceof RestoreFailure) await record("failed");
    throw error;
  } finally {
    await close();
  }
}

const emptyCounts: RestoreCounts = {
  soldiers: 0,
  deletedSoldiers: 0,
  duties: 0,
  assignments: 0,
  ledgerEntries: 0,
  accounts: 0,
};
const skippedLog: DeletionLogOutcome = {
  status: "blocked",
  applied: 0,
  alreadyDeleted: 0,
  notInDatabase: 0,
  head: 0,
  reasons: ["not_run"],
};

async function applyDeletions(
  database: Database,
  config: DeletionLogConfig,
  now: Date,
  writeLocalCopy: boolean
): Promise<DeletionLogOutcome> {
  if (!config.directory) {
    // Without a log nothing proves that no deletion was lost, so the copy stays closed.
    await raiseRestoreBlocker(database, DELETION_LOG_BLOCKER, {
      reasons: ["not_configured"],
    });
    return { ...skippedLog, reasons: ["not_configured"] };
  }
  const result = await applyLoggedDeletions(config, now, {
    database,
    restoreLocal: writeLocalCopy,
  });
  if (result.status === "blocked")
    return {
      ...skippedLog,
      reasons: result.verification.reasons,
    };
  return {
    status: "applied",
    applied: result.applied,
    alreadyDeleted: result.alreadyDeleted,
    notInDatabase: result.notInDatabase,
    head: result.head,
    reasons: [],
  };
}

// ---------------------------------------------------------------- the swap

/**
 * Replaces the live database with a restored one that passed its checks. The
 * live database is renamed, not dropped, so a restore can be undone by hand.
 * The site and the worker must be stopped: a rename needs no open connection.
 */
export async function promoteRestore(options: {
  liveUrl: string;
  restored?: string;
  now?: Date;
  log?: (line: string) => void;
}) {
  const log = options.log ?? noop;
  const live = databaseName(options.liveUrl);
  const restored = options.restored ?? scratchName(options.liveUrl, "restore");
  quoteName(live);
  quoteName(restored);
  const restoredUrl = urlFor(options.liveUrl, restored);
  // The verdict is read from the restored database itself.
  const probe = new Client({ connectionString: restoredUrl });
  try {
    await probe.connect();
  } catch {
    throw new RestoreFailure("database_missing");
  }
  let report: RestoreReport | undefined;
  try {
    report = (
      await probe.query("select data from operations_state where key = $1", [
        REPORT_STATE,
      ])
    ).rows[0]?.data;
  } catch {
    report = undefined;
  } finally {
    await probe.end();
  }
  if (
    !report ||
    report.mode !== "restore" ||
    (report.outcome !== "passed" && report.outcome !== "needs_deletion_log")
  )
    throw new RestoreFailure("not_verified");
  const stamp = DateTime.fromJSDate(options.now ?? new Date())
    .setZone(UNIT_ZONE)
    .toFormat("yyyyLLddHHmmss");
  const kept = `${live}_before_restore_${stamp}`;
  quoteName(kept);
  return withAdmin(options.liveUrl, async (client) => {
    // A connection that was just closed may take a moment to leave the list.
    let open = 1;
    for (let attempt = 0; attempt < 10 && open > 0; attempt++) {
      open = (
        await client.query(
          "select count(*)::int as count from pg_stat_activity where datname = any($1) and pid <> pg_backend_pid()",
          [[live, restored]]
        )
      ).rows[0].count;
      if (open > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (open > 0) throw new RestoreFailure("database_in_use");
    const hadLive = await exists(client, live);
    if (hadLive) {
      await client.query(
        `alter database ${quoteName(live)} rename to ${quoteName(kept)}`
      );
      log(`The old database is kept as ${kept}`);
    }
    try {
      await client.query(
        `alter database ${quoteName(restored)} rename to ${quoteName(live)}`
      );
    } catch (error) {
      if (hadLive)
        await client.query(
          `alter database ${quoteName(kept)} rename to ${quoteName(live)}`
        );
      throw error;
    }
    log(`The restored copy is now ${live}`);
    return {
      outcome: report.outcome as RestoreOutcome,
      kept: hadLive ? kept : undefined,
    };
  });
}
