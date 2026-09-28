import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "../src/server/db";
const connection = await pool.connect();
try {
  // App and worker may start together. Migrations use this same dedicated connection.
  await connection.query("select pg_advisory_lock(61832740)");
  await migrate(drizzle(connection), { migrationsFolder: "./drizzle" });
  console.log("מיגרציות הושלמו");
} finally {
  await connection.query("select pg_advisory_unlock(61832740)");
  connection.release();
  await pool.end();
}
