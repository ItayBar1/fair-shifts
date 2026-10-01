import { describe, expect, it } from "vitest";
import {
  DRILL_INTERVAL_DAYS,
  checkIds,
  checkLabels,
  drillAlertDue,
  drillStatus,
  parseBackupStamp,
  reportLines,
  restoreNoticeText,
  restoreOutcome,
  type CheckResult,
  type RestoreReport,
} from "../../src/domain/restore";

const pass = (id: CheckResult["id"]): CheckResult => ({
  id,
  status: "pass",
  count: 0,
  samples: [],
});
const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);

describe("restore outcome", () => {
  const log = { status: "applied" as const };
  it("passes only when every check passed and the deletion log was applied", () => {
    expect(restoreOutcome([pass("accounts")], log)).toBe("passed");
  });
  it("a warning does not block, a failure does", () => {
    const warn: CheckResult = { ...pass("versions"), status: "warn", count: 2 };
    const fail: CheckResult = { ...pass("accounts"), status: "fail", count: 1 };
    expect(restoreOutcome([warn, pass("accounts")], log)).toBe("passed");
    expect(restoreOutcome([warn, fail], log)).toBe("failed");
  });
  it("a deletion log that could not be verified keeps the restore closed but is not a data failure", () => {
    expect(restoreOutcome([pass("accounts")], { status: "blocked" })).toBe(
      "needs_deletion_log"
    );
  });
  it("a data failure outranks the deletion log", () => {
    const fail: CheckResult = { ...pass("accounts"), status: "fail", count: 1 };
    expect(restoreOutcome([fail], { status: "blocked" })).toBe("failed");
  });
  it("names every check", () => {
    for (const id of checkIds)
      expect(checkLabels[id].length).toBeGreaterThan(10);
  });
});

describe("backup file stamps", () => {
  it("reads the Israel time the run started", () => {
    // 03:30 on 1 October 2026 in Israel is UTC+3.
    expect(
      parseBackupStamp(
        "fair-shifts-20261001-033000-1a2b3c4d.dump.age"
      )?.toISOString()
    ).toBe("2026-10-01T00:30:00.000Z");
    // After the clocks go back it is UTC+2.
    expect(
      parseBackupStamp(
        "fair-shifts-20261101-033000-1a2b3c4d.dump.age"
      )?.toISOString()
    ).toBe("2026-11-01T01:30:00.000Z");
  });
  it("finds the stamp inside a storage name that carries the run id", () => {
    expect(
      parseBackupStamp(
        "fair-shifts-9f9f9f9f-aaaa-bbbb-cccc-dddddddddddd--fair-shifts-20260101-033000-1a2b3c4d.dump.age"
      )
    ).toBeInstanceOf(Date);
  });
  it("returns nothing for a name without a stamp or with an impossible date", () => {
    expect(parseBackupStamp("backup.dump")).toBeUndefined();
    expect(
      parseBackupStamp("fair-shifts-20261301-033000-1a2b3c4d.dump.age")
    ).toBeUndefined();
  });
});

describe("drill status", () => {
  const now = at("2026-10-01T12:00:00Z");
  it("is off where backups are off", () => {
    expect(drillStatus({ now, backupEnabled: false }).state).toBe("disabled");
  });
  it("waits while there is no drill and no backup yet, or the first backup is young", () => {
    expect(drillStatus({ now, backupEnabled: true }).state).toBe("pending");
    expect(
      drillStatus({
        now,
        backupEnabled: true,
        firstBackupAt: new Date(now.getTime() - 30 * DAY).toISOString(),
      })
    ).toMatchObject({ state: "pending", daysSince: 30 });
  });
  it("counts from the first backup when nothing was ever drilled", () => {
    expect(
      drillStatus({
        now,
        backupEnabled: true,
        firstBackupAt: new Date(
          now.getTime() - (DRILL_INTERVAL_DAYS + 1) * DAY
        ).toISOString(),
      }).state
    ).toBe("overdue");
  });
  it("is ok after a passed drill and overdue after more than 100 days", () => {
    const record = (days: number) => ({
      lastPassedAt: new Date(now.getTime() - days * DAY).toISOString(),
    });
    expect(
      drillStatus({ now, backupEnabled: true, record: record(100) })
    ).toMatchObject({ state: "ok", daysSince: 100 });
    expect(
      drillStatus({ now, backupEnabled: true, record: record(101) })
    ).toMatchObject({ state: "overdue", daysSince: 101 });
  });
  it("shows a failed latest attempt next to the last pass", () => {
    const status = drillStatus({
      now,
      backupEnabled: true,
      record: {
        lastPassedAt: new Date(now.getTime() - 10 * DAY).toISOString(),
        lastAttemptAt: now.toISOString(),
        lastOutcome: "failed",
      },
    });
    expect(status).toMatchObject({ state: "ok", lastOutcome: "failed" });
  });
  it("ignores a failed attempt when counting overdue time", () => {
    expect(
      drillStatus({
        now,
        backupEnabled: true,
        record: {
          lastPassedAt: new Date(now.getTime() - 120 * DAY).toISOString(),
          lastAttemptAt: now.toISOString(),
          lastOutcome: "failed",
        },
      }).state
    ).toBe("overdue");
  });
});

describe("drill reminders", () => {
  const now = at("2026-10-01T12:00:00Z");
  it("reminds once when overdue, not before", () => {
    expect(drillAlertDue({ state: "ok" }, undefined, now)).toBe(false);
    expect(drillAlertDue({ state: "pending" }, undefined, now)).toBe(false);
    expect(drillAlertDue({ state: "disabled" }, undefined, now)).toBe(false);
    expect(drillAlertDue({ state: "overdue" }, undefined, now)).toBe(true);
  });
  it("repeats every 30 days while it stays overdue", () => {
    const last = (days: number) =>
      new Date(now.getTime() - days * DAY).toISOString();
    expect(drillAlertDue({ state: "overdue" }, last(29), now)).toBe(false);
    expect(drillAlertDue({ state: "overdue" }, last(30), now)).toBe(true);
  });
});

describe("restore notice", () => {
  it("states the restore point in Israel time and what changed", () => {
    const text = restoreNoticeText({
      restorePoint: at("2026-10-01T00:30:00Z"),
      mailCancelled: 3,
    });
    expect(text.title).toBe("המערכת שוחזרה מגיבוי");
    expect(text.body).toContain("מגיבוי מ־01.10.2026 03:30");
    expect(text.body).toContain("כל החיבורים בוטלו");
    expect(text.body).toContain("3 מיילים שהמתינו בתור בוטלו");
  });
  it("says so when the restore point is unknown and no mail was cancelled", () => {
    const text = restoreNoticeText({ mailCancelled: 0 });
    expect(text.body).toContain("שמועדו אינו ידוע");
    expect(text.body).not.toContain("בוטלו.");
  });
});

describe("report text", () => {
  const report: RestoreReport = {
    id: "r1",
    mode: "drill",
    startedAt: "2026-10-01T10:00:00Z",
    finishedAt: "2026-10-01T10:01:00Z",
    source: { kind: "storage", name: "backup.dump.age", sizeBytes: 1234 },
    restorePoint: "2026-10-01T00:30:00.000Z",
    schema: { inBackup: 9, inApp: 9 },
    counts: {
      soldiers: 20,
      deletedSoldiers: 1,
      duties: 4,
      assignments: 12,
      ledgerEntries: 25,
      accounts: 3,
    },
    deletionLog: {
      status: "applied",
      applied: 1,
      alreadyDeleted: 0,
      notInDatabase: 0,
      head: 1,
      reasons: [],
    },
    checks: [
      pass("accounts"),
      {
        id: "balances_match_ledger",
        status: "fail",
        count: 2,
        samples: ["a", "b"],
      },
    ],
    outcome: "failed",
  };
  it("lists the outcome, the source, the log and each check with its findings", () => {
    const text = reportLines(report).join("\n");
    expect(text).toContain("Restore drill: FAILED");
    expect(text).toContain("backup.dump.age (1234 bytes)");
    expect(text).toContain("applied through entry 1");
    expect(text).toContain("PASS accounts");
    expect(text).toContain("FAIL balances_match_ledger");
    expect(text).toContain("2 found, e.g. a, b");
  });
  it("shows a blocked deletion log with its reasons and the actions of a restore", () => {
    const text = reportLines({
      ...report,
      mode: "restore",
      outcome: "needs_deletion_log",
      deletionLog: {
        ...report.deletionLog,
        status: "blocked",
        reasons: ["no_log"],
      },
      actions: {
        sessionsRevoked: 4,
        codesRemoved: 1,
        mailCancelled: 7,
        noticesCreated: 2,
      },
    }).join("\n");
    expect(text).toContain("Restore: NEEDS_DELETION_LOG");
    expect(text).toContain("Deletion log: BLOCKED (no_log)");
    expect(text).toContain("4 sessions revoked");
    expect(text).toContain("7 queued emails cancelled");
  });
});
