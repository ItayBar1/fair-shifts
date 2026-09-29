import { PgBoss } from "pg-boss";
import { pool, unitTransaction } from "./server/db";
import { settleDue } from "./server/scoring";
import { deliverNextEmail } from "./server/operations/email";
import { operationsState } from "./server/auth-schema";
import { eq } from "drizzle-orm";
import { refreshRankReminders } from "./server/ranks";
import { refreshRoundNotices } from "./server/round-notices";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const boss = new PgBoss(process.env.DATABASE_URL);
boss.on("error", (error) => console.error("Worker queue error", error.name));
await boss.start();
await boss.createQueue("unit-maintenance", { retryLimit: 5, retryDelay: 15 });
await boss.schedule("unit-maintenance", "* * * * *");
await boss.work("unit-maintenance", async () => {
  await unitTransaction(async (tx) => {
    const [restore] = await tx
      .select()
      .from(operationsState)
      .where(eq(operationsState.key, "restore"));
    if (process.env.RESTORE_MODE === "true" || restore?.data.blocked === true)
      return;
    const credited = await settleDue(tx);
    await refreshRankReminders(tx);
    await refreshRoundNotices(tx);
    await tx
      .insert(operationsState)
      .values({
        key: "worker",
        data: { lastSuccessAt: new Date().toISOString(), credited },
      })
      .onConflictDoUpdate({
        target: operationsState.key,
        set: {
          data: { lastSuccessAt: new Date().toISOString(), credited },
          updatedAt: new Date(),
        },
      });
  });
  for (let index = 0; index < 20; index++) {
    const result = await deliverNextEmail();
    if (result.status === "idle" || result.status === "disabled") break;
  }
});
await boss.send("unit-maintenance");
console.log("עובד Fair Shifts מוכן");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await boss.stop({ graceful: true, timeout: 20_000 });
  await pool.end();
}
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
