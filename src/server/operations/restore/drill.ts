import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { type DbTransaction } from "../../db";
import { backupRun, operationsState, user } from "../../auth-schema";
import { createRecord } from "../../repository";
import { enqueueEmail } from "../email";
import type { BackupConfig } from "../backup";
import { UNIT_ZONE } from "../../../domain/time";
import {
  drillAlertDue,
  drillAlertText,
  drillStatus,
  type DrillRecord,
  type DrillStatus,
  type RestoreOutcome,
} from "../../../domain/restore";
import { type Executor } from "./database";

// ---------------------------------------------------------------- the drill record

export const REPORT_STATE = "restore-report";
export const DRILL_STATE = "restore-drill";

export async function writeState(
  tx: Executor,
  key: string,
  data: Record<string, unknown>,
  now: Date
) {
  await tx
    .insert(operationsState)
    .values({ key, data, updatedAt: now })
    .onConflictDoUpdate({
      target: operationsState.key,
      set: { data, updatedAt: now },
    });
}
async function readDrillRecord(tx: Executor): Promise<DrillRecord> {
  const [row] = await tx
    .select()
    .from(operationsState)
    .where(eq(operationsState.key, DRILL_STATE));
  return (row?.data ?? {}) as DrillRecord;
}

/** What a drill, or a restore, left: counts and times, never content. */
export async function recordDrill(
  tx: Executor,
  outcome: RestoreOutcome,
  restorePoint: string | undefined,
  now: Date
) {
  const { lastAlertAt, ...record } = await readDrillRecord(tx);
  const next: DrillRecord = {
    ...record,
    lastAttemptAt: now.toISOString(),
    lastOutcome: outcome,
    ...(outcome === "passed" && {
      lastPassedAt: now.toISOString(),
      restorePoint,
    }),
    ...(outcome !== "passed" && lastAlertAt && { lastAlertAt }),
  };
  await writeState(tx, DRILL_STATE, next, now);
}

export async function readDrillStatus(
  tx: Executor,
  config: Pick<BackupConfig, "kind">,
  now = new Date()
): Promise<DrillStatus> {
  const [first] = await tx
    .select({ at: sql<Date | null>`min(${backupRun.finishedAt})` })
    .from(backupRun)
    .where(inArray(backupRun.status, ["verified", "deleted"]));
  return drillStatus({
    now,
    backupEnabled:
      process.env.SERVICE_ROLE === "app"
        ? (
            await import("../health").then(({ readWorkerBackup }) =>
              readWorkerBackup(tx)
            )
          ).kind !== "none"
        : config.kind !== "none",
    record: await readDrillRecord(tx),
    firstBackupAt: first?.at ? new Date(first.at).toISOString() : undefined,
  });
}

/**
 * The worker's daily look: a drill overdue by more than 100 days is a notice
 * and an email to the technical account, again every 30 days (decision 200).
 */
export async function refreshDrillAlert(
  tx: DbTransaction,
  config: Pick<BackupConfig, "kind">,
  now = new Date()
) {
  const record = await readDrillRecord(tx);
  const status = await readDrillStatus(tx, config, now);
  if (!drillAlertDue(status, record.lastAlertAt, now)) return 0;
  const text = drillAlertText(status);
  const accounts = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.role, "technical"), isNull(user.deletedAt)));
  const day = DateTime.fromJSDate(now)
    .setZone(UNIT_ZONE)
    .toFormat("yyyy-LL-dd");
  for (const account of accounts) {
    await createRecord(tx, "notification", {
      accountId: account.id,
      ...text,
      href: "/technical/backups",
    });
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey: `drill:${day}:${account.id}`,
      kind: "backup-alert",
      ...text,
      href: "/technical/backups",
      priority: 1,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
  }
  await writeState(
    tx,
    DRILL_STATE,
    { ...record, lastAlertAt: now.toISOString() },
    now
  );
  return accounts.length;
}
