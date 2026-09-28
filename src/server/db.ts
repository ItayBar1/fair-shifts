import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

const globalDb = globalThis as unknown as { fairShiftsPool?: Pool };
export const pool =
  globalDb.fairShiftsPool ??
  new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:54329/fair_shifts",
    max: 10,
  });
if (process.env.NODE_ENV !== "production") globalDb.fairShiftsPool = pool;
export const db = drizzle(pool, { schema });
export type Database = typeof db;
export type DbTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export async function unitTransaction<T>(
  work: (tx: DbTransaction, version: number) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx
      .insert(schema.unitLock)
      .values({ id: 1, version: 1 })
      .onConflictDoNothing();
    const result = await tx.execute<{ version: number }>(
      sql`select version from unit_lock where id = 1 for update`
    );
    const value = await work(tx, result.rows[0].version);
    await tx.execute(
      sql`update unit_lock set version = version + 1 where id = 1`
    );
    return value;
  });
}
