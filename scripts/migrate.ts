import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "../src/server/db";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { verifyMigrationBackup } from "../src/server/operations/security-backup";
import { checkDatabaseRole } from "../src/server/operations/database-permissions";
if (process.env.SERVICE_ROLE && process.env.SERVICE_ROLE !== "operations")
  throw new Error("Migrations require the separate operations service");
const connection = await pool.connect();
try {
  // One operations connection owns the migration lock, including preflight.
  await connection.query("select pg_advisory_lock(61832740)");
  if (process.env.SERVICE_ROLE === "operations") {
    const errors = await checkDatabaseRole("operations", drizzle(connection));
    if (errors.length) throw new Error(errors.join("; "));
    const active = await connection.query(
      "select 1 from pg_stat_activity where datname=current_database() and usename in ('fair_shifts_app','fair_shifts_worker') limit 1"
    );
    if (active.rowCount)
      throw new Error("Stop site and worker before migrations");
    const existing = await connection.query(
      "select to_regclass('public.auth_user') as users, to_regclass('drizzle.__drizzle_migrations') as migrations"
    );
    const latest = existing.rows[0].migrations
      ? await connection.query(
          "select max(created_at)::bigint as time from drizzle.__drizzle_migrations"
        )
      : undefined;
    const pending = readMigrationFiles({ migrationsFolder: "./drizzle" }).some(
      (item) => item.folderMillis > Number(latest?.rows[0].time || 0)
    );
    if (pending && existing.rows[0].users) await verifyMigrationBackup();
  }
  await migrate(drizzle(connection), { migrationsFolder: "./drizzle" });
  console.log("Migrations applied");
} finally {
  await connection.query("select pg_advisory_unlock(61832740)");
  connection.release();
  await pool.end();
}
