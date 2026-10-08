import { DateTime } from "luxon";
import { UNIT_ZONE } from "./time";

/**
 * Restoring from a backup (decision 200, ticket #35). A backup is restored into
 * a separate database, never over the live one; the deletions made since are
 * applied again, every check runs, and only a database that passed them can
 * replace the live one. These are the pure rules: what a check reports, when a
 * restore passed, how stale the last drill is, and what the managers are told.
 * Report lines are English because they are read on the server (decision 187);
 * the notice for the managers is Hebrew.
 */

/** A drill older than this is overdue: the policy is quarterly, with slack. */
export const DRILL_INTERVAL_DAYS = 100;
/** While a drill stays overdue the technical account is reminded this often. */
export const DRILL_REALERT_DAYS = 30;
const DAY_MS = 86_400_000;

/** The names of the gate blockers a restore raises in the restored database. */
export const RESTORE_CHECKS_BLOCKER = "restore_checks";

export const checkIds = [
  "migrations_known",
  "versions",
  "assignment_links",
  "deleted_soldier_seats",
  "balances_present",
  "ledger_arithmetic",
  "balances_match_ledger",
  "credited_have_ledger",
  "no_double_credit",
  "performance_orphans",
  "accounts",
  "technical_account",
  "deleted_soldier_residue",
  "command_result_retention",
] as const;
export type CheckId = (typeof checkIds)[number];

/** What each check proves, for the report. */
export const checkLabels: Record<CheckId, string> = {
  migrations_known:
    "every migration the backup holds is known to this version of the application",
  versions: "record versions are positive and match the stored data",
  assignment_links: "every assignment points to its duty, seat and soldier",
  deleted_soldier_seats:
    "no deleted soldier holds a seat of a duty that has not started",
  balances_present: "every soldier has a balance",
  ledger_arithmetic: "every ledger entry adds up and never goes below zero",
  balances_match_ledger: "every balance equals the sum of its ledger",
  credited_have_ledger:
    "every credited seat reached the ledger or waits for a score decision",
  no_double_credit:
    "no seat that is still reserved already has a performance credit",
  performance_orphans: "every performance credit belongs to a seat",
  accounts: "every account belongs to a soldier and none to a deleted soldier",
  technical_account: "an active technical account exists",
  deleted_soldier_residue:
    "nothing erased by a deletion is left for a deleted soldier",
  command_result_retention:
    "command content is attributed, retained at most 30 days, and expired results contain only a tombstone",
};

/** fail blocks the restore; warn is reported and does not. */
export type CheckStatus = "pass" | "fail" | "warn";
export type CheckResult = {
  id: CheckId;
  status: CheckStatus;
  /** How many rows break the rule. */
  count: number;
  /** A few internal ids, never names or contact details. */
  samples: string[];
};

export const SAMPLE_LIMIT = 5;

export type DeletionLogOutcome = {
  status: "applied" | "blocked";
  applied: number;
  alreadyDeleted: number;
  notInDatabase: number;
  head: number;
  /** Why the log could not be trusted; empty when it was applied. */
  reasons: string[];
};

/**
 * passed: everything ran and nothing is blocking.
 * needs_deletion_log: the data is sound but the deletion log could not be
 *   verified; the restored database stays closed until the operator fixes the
 *   log or acknowledges it (decision 196).
 * failed: a check broke; the database must not replace the live one.
 */
export type RestoreOutcome = "passed" | "needs_deletion_log" | "failed";

export function restoreOutcome(
  checks: readonly CheckResult[],
  deletionLog: Pick<DeletionLogOutcome, "status">
): RestoreOutcome {
  if (checks.some((check) => check.status === "fail")) return "failed";
  return deletionLog.status === "applied" ? "passed" : "needs_deletion_log";
}

export type RestoreSource = {
  kind: "storage" | "file" | "dump";
  name?: string;
  sizeBytes?: number;
  sha256?: string;
};

export type RestoreCounts = {
  soldiers: number;
  deletedSoldiers: number;
  duties: number;
  assignments: number;
  ledgerEntries: number;
  accounts: number;
};

export type RestoreActions = {
  sessionsRevoked: number;
  codesRemoved: number;
  mailCancelled: number;
  noticesCreated: number;
};

export type RestoreReport = {
  id: string;
  mode: "drill" | "restore";
  startedAt: string;
  finishedAt: string;
  source: RestoreSource;
  /** When the backup was taken, from its file name or the storage. */
  restorePoint?: string;
  schema: { inBackup: number; inApp: number };
  counts: RestoreCounts;
  deletionLog: DeletionLogOutcome;
  checks: CheckResult[];
  /** Only a restore that is meant to go live acts on sessions, mail and notices. */
  actions?: RestoreActions;
  outcome: RestoreOutcome;
};

/** `fair-shifts-20261001-033000-1a2b3c4d.dump.age`: the Israel time the run started. */
const STAMP = /fair-shifts-(\d{8})-(\d{6})-[0-9a-f]{8}/;
export function parseBackupStamp(name: string): Date | undefined {
  const match = STAMP.exec(name);
  if (!match) return undefined;
  const parsed = DateTime.fromFormat(
    `${match[1]}${match[2]}`,
    "yyyyLLddHHmmss",
    {
      zone: UNIT_ZONE,
    }
  );
  return parsed.isValid ? parsed.toJSDate() : undefined;
}

// ---------------------------------------------------------------- drill status

export type DrillRecord = {
  /** The last drill, or restore, that passed every check. */
  lastPassedAt?: string;
  restorePoint?: string;
  lastAttemptAt?: string;
  lastOutcome?: RestoreOutcome;
  lastAlertAt?: string;
};

export type DrillState =
  /** Backups are off in this environment, so there is nothing to drill. */
  | "disabled"
  /** No drill yet and the first backup is still younger than the interval. */
  | "pending"
  | "ok"
  | "overdue";

export type DrillStatus = {
  state: DrillState;
  lastPassedAt?: string;
  restorePoint?: string;
  lastAttemptAt?: string;
  lastOutcome?: RestoreOutcome;
  /** Whole days since the last passed drill (or the first backup, when none). */
  daysSince?: number;
};

/**
 * Where the drill stands. With no drill yet the clock starts at the first
 * backup, so a new system is not blamed before it could have drilled.
 */
export function drillStatus(input: {
  now: Date;
  backupEnabled: boolean;
  record?: DrillRecord;
  firstBackupAt?: string;
}): DrillStatus {
  const { record } = input;
  const base = {
    lastPassedAt: record?.lastPassedAt,
    restorePoint: record?.restorePoint,
    lastAttemptAt: record?.lastAttemptAt,
    lastOutcome: record?.lastOutcome,
  };
  if (!input.backupEnabled) return { ...base, state: "disabled" };
  const since = record?.lastPassedAt ?? input.firstBackupAt;
  if (!since) return { ...base, state: "pending" };
  const days = Math.floor(
    (input.now.getTime() - new Date(since).getTime()) / DAY_MS
  );
  if (days > DRILL_INTERVAL_DAYS)
    return { ...base, state: "overdue", daysSince: days };
  return {
    ...base,
    state: record?.lastPassedAt ? "ok" : "pending",
    daysSince: days,
  };
}

/** One reminder when the drill becomes overdue, then one every 30 days. */
export function drillAlertDue(
  status: Pick<DrillStatus, "state">,
  lastAlertAt: string | undefined,
  now: Date
) {
  if (status.state !== "overdue") return false;
  if (!lastAlertAt) return true;
  return (
    now.getTime() - new Date(lastAlertAt).getTime() >=
    DRILL_REALERT_DAYS * DAY_MS
  );
}

export const drillAlertText = (
  status: Pick<DrillStatus, "daysSince" | "lastPassedAt">
) => ({
  title: "הגיע הזמן לתרגיל שחזור",
  body: status.lastPassedAt
    ? `עברו ${status.daysSince} ימים מאז תרגיל השחזור המוצלח האחרון. יש להריץ תרגיל לפי מדריך ההפעלה ולוודא שהגיבוי באמת ניתן לשחזור.`
    : `עברו ${status.daysSince} ימים מאז הגיבוי הראשון, ועדיין לא בוצע תרגיל שחזור מוצלח. יש להריץ תרגיל לפי מדריך ההפעלה.`,
});

// ---------------------------------------------------------------- the notice

const display = (value: Date) =>
  DateTime.fromJSDate(value).setZone(UNIT_ZONE).toFormat("dd.LL.yyyy HH:mm");

/**
 * What the managers and the technical account are told once a restored
 * system opens (decision 200): when the backup was taken, that later changes
 * are gone, that everyone was signed out, and what happened to queued mail.
 */
export function restoreNoticeText(input: {
  restorePoint?: Date;
  mailCancelled: number;
}) {
  const point = input.restorePoint
    ? `מגיבוי מ־${display(input.restorePoint)}`
    : "מגיבוי שמועדו אינו ידוע";
  const mail =
    input.mailCancelled > 0
      ? ` ${input.mailCancelled} מיילים שהמתינו בתור בוטלו.`
      : "";
  return {
    title: "המערכת שוחזרה מגיבוי",
    body: `המערכת שוחזרה ${point}. שינויים שנעשו אחרי המועד הזה אינם קיימים עוד: שיבוצים, אילוצים, בקשות, נעילות והרשאות. כל החיבורים בוטלו, ויש להתחבר מחדש.${mail} יש לבדוק מה נעשה מאז ולחזור על מה שחסר.`,
  };
}

// ---------------------------------------------------------------- the report text

/** The report as lines for the server's terminal. No names, numbers or contact details. */
export function reportLines(report: RestoreReport): string[] {
  const lines = [
    `${report.mode === "drill" ? "Restore drill" : "Restore"}: ${report.outcome.toUpperCase()}`,
    `Source: ${report.source.kind}${report.source.name ? ` ${report.source.name}` : ""}${report.source.sizeBytes !== undefined ? ` (${report.source.sizeBytes} bytes)` : ""}`,
    `Restore point: ${report.restorePoint ?? "unknown"}`,
    `Migrations: ${report.schema.inBackup} in the backup, ${report.schema.inApp} in this version`,
    `Rows: ${report.counts.soldiers} soldiers (${report.counts.deletedSoldiers} deleted), ${report.counts.duties} duties, ${report.counts.assignments} assignments, ${report.counts.ledgerEntries} ledger entries, ${report.counts.accounts} accounts`,
    report.deletionLog.status === "applied"
      ? `Deletion log: applied through entry ${report.deletionLog.head} (${report.deletionLog.applied} applied, ${report.deletionLog.alreadyDeleted} already deleted, ${report.deletionLog.notInDatabase} not in the backup)`
      : `Deletion log: BLOCKED (${report.deletionLog.reasons.join(", ") || "unknown"})`,
    "Checks:",
  ];
  for (const check of report.checks) {
    const detail =
      check.status === "pass"
        ? ""
        : ` — ${check.count} found${check.samples.length ? `, e.g. ${check.samples.join(", ")}` : ""}`;
    lines.push(
      `  ${check.status.toUpperCase().padEnd(4)} ${check.id}: ${checkLabels[check.id]}${detail}`
    );
  }
  if (report.actions)
    lines.push(
      `Opened with: ${report.actions.sessionsRevoked} sessions revoked, ${report.actions.codesRemoved} pending codes removed, ${report.actions.mailCancelled} queued emails cancelled, ${report.actions.noticesCreated} notices created`
    );
  return lines;
}
