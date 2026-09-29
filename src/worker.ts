import { rm, writeFile } from "node:fs/promises";
import { PgBoss } from "pg-boss";
import { pool, unitTransaction } from "./server/db";
import { settleDue } from "./server/scoring";
import { deliverNextEmail } from "./server/operations/email";
import { operationsState } from "./server/auth-schema";
import { eq } from "drizzle-orm";
import { refreshRankReminders } from "./server/ranks";
import { recordWorkerHeartbeat } from "./server/operations/health";
import { refreshRoundNotices } from "./server/round-notices";
import { runBackupCycle } from "./server/operations/backup";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
// The container health check reads this file's age (see compose.production.yaml).
const heartbeatFile =
  process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/fair-shifts-worker-heartbeat";
// A file left by a previous run in the same container must not pass the check.
await rm(heartbeatFile, { force: true });
const boss = new PgBoss(process.env.DATABASE_URL);
boss.on("error", (error) => console.error("Worker queue error", error.name));
await boss.start();
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
    await refreshRankReminders(tx);
    await refreshRoundNotices(tx, now);
    await recordWorkerHeartbeat(tx, { now, paused: false, credited });
  });
  await writeFile(heartbeatFile, new Date().toISOString());
  for (let index = 0; index < 20; index++) {
    const result = await deliverNextEmail();
    if (result.status === "idle" || result.status === "disabled") break;
  }
});
// Backups run in their own queue so a long dump never delays the minute's maintenance.
// The run table, not the queue, decides whether a backup is due (decision 170).
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
await boss.send("unit-maintenance");
console.log("עובד Fair Shifts מוכן");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await boss.stop({ graceful: true, timeout: 20_000 });
  await pool.end();
  console.log("עובד Fair Shifts נעצר");
}
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
