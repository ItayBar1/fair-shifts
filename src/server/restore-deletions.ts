import { eq } from "drizzle-orm";
import { unitTransaction, type Database, type DbTransaction } from "./db";
import { soldiers } from "./schema";
import { user } from "./auth-schema";
import { purgeCalendarLink } from "./calendar/link";
import { audit, createRecord, type Actor } from "./repository";
import { invariant } from "./errors";
import { eraseSoldier } from "./soldier-deletion";
import {
  deletionLogConfig,
  mergeState,
  restoreLocalCopy,
  verifyDeletionLog,
  type DeletionLogConfig,
  type LogVerification,
} from "./operations/deletion-log";
import {
  DELETION_LOG_BLOCKER,
  clearRestoreBlocker,
  raiseRestoreBlocker,
} from "./operations/restore-gate";

/**
 * After a backup is restored (decision 196, ticket #34): the deletions the live
 * system made since the backup are applied again from the independent log
 * before anyone is let in. A log that is missing or cannot be verified leaves
 * access and mail closed until a person clarifies and says so explicitly.
 * Output is English: it is read on the server (decision 187).
 */
export const RESTORE_ACTOR: Actor = {
  id: "restore",
  name: "שחזור מגיבוי",
  role: "technical",
  securityEpoch: 0,
};

/** The words an operator types to open a restore without a verified log. */
export const ACKNOWLEDGEMENT = "deleted data may return";

export type ApplyResult =
  | { status: "blocked"; verification: LogVerification }
  | {
      status: "applied";
      verification: LogVerification;
      applied: number;
      alreadyDeleted: number;
      notInDatabase: number;
      head: number;
    };

/**
 * Verifies the log and applies every deletion in it that the restored database
 * does not yet show. Safe to run again: a soldier already deleted is left alone,
 * and one the database does not know is skipped. The gate opens for this check
 * only when the log verified and all of it was applied.
 *
 * An isolated restore (ticket #35) passes the scratch `database` it works on.
 * A drill also passes `restoreLocal: false`, because it only reads the live
 * log and must not write the live file.
 */
export async function applyLoggedDeletions(
  config: DeletionLogConfig = deletionLogConfig(),
  now = new Date(),
  options: { database?: Database; restoreLocal?: boolean } = {}
): Promise<ApplyResult> {
  return unitTransaction(async (tx) => {
    const verification = await verifyDeletionLog(tx, config, { now });
    if (verification.status !== "verified") {
      await raiseRestoreBlocker(tx, DELETION_LOG_BLOCKER, {
        reasons: verification.reasons,
        checkedAt: verification.checkedAt,
      });
      return { status: "blocked" as const, verification };
    }
    // Closed first: whatever happens below, nobody enters on a half-applied log.
    await raiseRestoreBlocker(tx, DELETION_LOG_BLOCKER, {
      reasons: ["applying"],
      checkedAt: verification.checkedAt,
    });
    let applied = 0;
    let alreadyDeleted = 0;
    let notInDatabase = 0;
    for (const entry of verification.entries) {
      const [person] = await tx
        .select({ id: soldiers.id, deletedAt: soldiers.deletedAt })
        .from(soldiers)
        .where(eq(soldiers.id, entry.soldierId));
      if (!person) notInDatabase++;
      else if (person.deletedAt) {
        // A restored grant must never outlive a recorded deletion, even when the
        // backup already marks the soldier deleted. No provider calls during restore.
        const accounts = await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.soldierId, person.id))
          .for("update");
        for (const login of accounts)
          await purgeCalendarLink(tx, login.id, { collect: false });
        alreadyDeleted++;
      } else {
        await eraseSoldier(tx, RESTORE_ACTOR, entry.soldierId, {
          reason: "Applied again from the deletion log after a restore",
          restored: { at: entry.at },
        });
        applied++;
      }
    }
    const head = verification.entries.at(-1);
    // A fresh volume, or a copy that was behind, gets the whole verified log.
    if (
      options.restoreLocal !== false &&
      verification.warnings.some((w) => w.startsWith("local_"))
    )
      await restoreLocalCopy(config, verification.entries);
    await mergeState(tx, {
      headSeq: head?.seq ?? 0,
      headHash: head?.hash ?? null,
      appliedThrough: head?.seq ?? 0,
      appliedAt: now.toISOString(),
      acknowledgedAt: null,
      lastError: null,
      errorSince: null,
    });
    await audit(tx, RESTORE_ACTOR, "restore.deletions.apply", "deletion-log", {
      entries: verification.entries.length,
      applied,
      alreadyDeleted,
      notInDatabase,
    });
    await clearRestoreBlocker(tx, DELETION_LOG_BLOCKER, {
      appliedThrough: head?.seq ?? 0,
      appliedAt: now.toISOString(),
    });
    return {
      status: "applied" as const,
      verification,
      applied,
      alreadyDeleted,
      notInDatabase,
      head: head?.seq ?? 0,
    };
  }, options.database);
}

/**
 * Opens the gate for the deletion check although the log is missing or could
 * not be verified. Only a person with access to the server can reach this, with
 * a reason and the explicit words; the managers are told that deleted data may
 * have returned. Nothing is applied: deletions made after the backup are not
 * known and must be repeated by a manager.
 */
export async function acknowledgeUnverifiedLog(
  input: { reason: string; acknowledgement: string },
  config: DeletionLogConfig = deletionLogConfig(),
  now = new Date()
) {
  const reason = input.reason.trim();
  invariant(
    reason.length >= 5 && reason.length <= 500,
    "reason_required",
    "A reason of 5 to 500 characters is required"
  );
  invariant(
    input.acknowledgement.trim() === ACKNOWLEDGEMENT,
    "acknowledgement_required",
    `Type the exact words: ${ACKNOWLEDGEMENT}`
  );
  return unitTransaction(async (tx) => {
    const verification = await verifyDeletionLog(tx, config, { now });
    await audit(
      tx,
      RESTORE_ACTOR,
      "restore.deletions.acknowledge",
      "deletion-log",
      {
        reason,
        status: verification.status,
        reasons: verification.reasons,
      }
    );
    await mergeState(tx, { acknowledgedAt: now.toISOString() });
    await clearRestoreBlocker(tx, DELETION_LOG_BLOCKER, {
      acknowledgedAt: now.toISOString(),
      reasons: verification.reasons,
    });
    await notifyManagers(tx);
    return verification;
  });
}

async function notifyManagers(tx: DbTransaction) {
  for (const manager of await tx
    .select({ id: user.id, deletedAt: user.deletedAt })
    .from(user)
    .where(eq(user.role, "manager")))
    if (!manager.deletedAt)
      await createRecord(tx, "notification", {
        accountId: manager.id,
        title: "השחזור נפתח בלי יומן מחיקות מאומת",
        body: "יומן המחיקות לא אומת אחרי השחזור, ולכן מידע של חיילים שנמחקו אחרי מועד הגיבוי עלול להופיע שוב. יש לבדוק מחיקות שבוצעו מאז ולחזור עליהן.",
        href: "/manage",
      });
}
