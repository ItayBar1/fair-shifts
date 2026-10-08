import { pool } from "../src/server/db";
import { readHealth } from "../src/server/operations/health";
try {
  const health = await readHealth();
  console.log(JSON.stringify(health, null, 2));
  if (health.database !== "ok") process.exitCode = 1;
} catch {
  console.error("System health check failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
