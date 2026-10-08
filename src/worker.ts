import { rm, writeFile } from "node:fs/promises";
import { PgBoss } from "pg-boss";
import { pool, unitTransaction } from "./server/db";
import { settleDue } from "./server/scoring";
import { deliverNextEmail } from "./server/operations/email";
import { expireCommandResults } from "./server/command-results";
import { operationsState, authRateLimit } from "./server/auth-schema";
import { eq, lt } from "drizzle-orm";
import { refreshRankReminders } from "./server/ranks";
import { announceDepartures } from "./server/departures";
import { recordWorkerHeartbeat } from "./server/operations/health";
import { refreshRoundNotices } from "./server/round-notices";
import { backupConfig, runBackupCycle } from "./server/operations/backup";
import { refreshDrillAlert } from "./server/operations/restore";
import { refreshDutyReminders } from "./server/duty-reminders";
import { listenForMail, singleFlight } from "./server/operations/mail-signal";
import { calendarSyncEnabled } from "./server/calendar/config";
import { runCalendarSync } from "./server/calendar/sync";
import {
  DELETION_LOG_CHANNEL,
  drainDeletionLog,
} from "./server/operations/deletion-log";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
// The container health check reads this file's age (see compose.production.yaml).
const heartbeatFile =
  process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/fair-shifts-worker-heartbeat";
// A file left by a previous run in the same container must not pass the check.
await rm(heartbeatFile, { force: true });
const boss = new PgBoss(process.env.DATABASE_URL);
boss.on("error", (error) => console.error("Worker queue error", error.name));
await boss.start();
// One drain of the outbox at a time, from the minute's maintenance or from a
// committed code's signal (decision 188).
const drainMail = singleFlight(async () => {
  for (let index = 0; index < 20; index++) {
    const result = await deliverNextEmail();
    if (result.status === "idle" || result.status === "disabled") break;
  }
});
// The deletion log (decision 196) is appended once a minute and at the signal a
// committed deletion sends, one run at a time.
const drainLog = singleFlight(async () => {
  await drainDeletionLog();
});
await boss.createQueue("unit-maintenance", { retryLimit: 5, retryDelay: 15 });
await boss.schedule("unit-maintenance", "* * * * *");
await boss.work("unit-maintenance", async () => {
  await unitTransaction(async (tx) => {
    const now = new Date();
    const [restore] = await tx
      .select()
      .from(operationsState)
      .where(eq(operationsState.key, "restore"));
    if (process.env.RESTORE_MODE === "true" || restore?.data.blocked === true) {
      await recordWorkerHeartbeat(tx, { now, paused: true });
      return;
    }
    const credited = await settleDue(tx);
    await expireCommandResults(tx, now);
    await refreshRankReminders(tx);
    await refreshRoundNotices(tx, now);
    await announceDepartures(tx, now);
    await refreshDutyReminders(tx, now);
    await tx
      .delete(authRateLimit)
      .where(lt(authRateLimit.expiresAt, new Date(now.getTime() - 86_400_000)));
    // A restore drill overdue by more than 100 days reminds the technical account (decision 200).
    // In a savepoint: a failed reminder must not undo the settlement above.
    await tx
      .transaction((inner) => refreshDrillAlert(inner, backupConfig(), now))
      .catch((error: unknown) =>
        console.error(
          "Drill reminder failed",
          error instanceof Error ? error.name : "unknown"
        )
      );
    await recordWorkerHeartbeat(tx, { now, paused: false, credited });
  });
  await writeFile(heartbeatFile, new Date().toISOString());
  await drainMail();
  await drainLog();
});
// Backups run in their own queue so a long dump never delays the minute's maintenance.
// The run table, not the queue, decides whether a backup is due (decision 173).
await boss.createQueue("backup", {
  policy: "stately",
  retryLimit: 0,
  expireInSeconds: 2 * 3600,
});
await boss.schedule("backup", "* * * * *");
await boss.work("backup", async () => {
  const result = await runBackupCycle();
  if (result.status === "failed" || result.status === "retry")
    console.error("Backup run failed", result.code);
});
// The calendar sync (decision 195) has a queue of its own, so a slow Google never
// delays the minute's maintenance; the link table, not the queue, says what is due.
if (calendarSyncEnabled()) {
  await boss.createQueue("calendar-sync", {
    policy: "stately",
    retryLimit: 0,
    expireInSeconds: 3600,
  });
  await boss.schedule("calendar-sync", "* * * * *");
  await boss.work("calendar-sync", async () => {
    await runCalendarSync();
  });
}
await boss.send("unit-maintenance");
const mailSignals = listenForMail(() => {
  drainMail().catch((error: Error) =>
    console.error("Mail delivery failed", error.name)
  );
});
const logSignals = listenForMail(
  () => {
    drainLog().catch((error: Error) =>
      console.error("Deletion log drain failed", error.name)
    );
  },
  { channel: DELETION_LOG_CHANNEL }
);
console.log("Fair Shifts worker ready");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await boss.stop({ graceful: true, timeout: 20_000 });
  await mailSignals.stop();
  await logSignals.stop();
  await drainMail.settled();
  await drainLog.settled();
  await pool.end();
  console.log("Fair Shifts worker stopped");
}
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
