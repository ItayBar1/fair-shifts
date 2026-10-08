import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { connectDatabase, db, pool } from "../../src/server/db";
import {
  applyDatabaseGrants,
  checkDatabaseRole,
  databaseRoles,
  type ServiceRole,
} from "../../src/server/operations/database-permissions";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Requires a dedicated test database");
const baseUrl = new URL(process.env.TEST_DATABASE_URL);
const passwords = {
  app: randomBytes(24).toString("hex"),
  worker: randomBytes(24).toString("hex"),
  operations: randomBytes(24).toString("hex"),
};
const roleUrl = (role: ServiceRole) => {
  const url = new URL(baseUrl);
  url.username = databaseRoles[role];
  url.password = passwords[role];
  return url.toString();
};
const clients = {
  app: connectDatabase(roleUrl("app")),
  worker: connectDatabase(roleUrl("worker")),
  operations: connectDatabase(roleUrl("operations")),
};
let runtimeClosed = false;
const bootstrap = (ack: string) => {
  const url = new URL(baseUrl);
  const password = decodeURIComponent(url.password);
  url.password = "";
  return execFileSync(
    "psql",
    [
      "--dbname",
      url.toString(),
      "--no-password",
      "--set",
      "ON_ERROR_STOP=1",
      "--file",
      "scripts/database-bootstrap.sql",
    ],
    {
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        PGPASSWORD: password,
        FS_APP_DB_PASSWORD: passwords.app,
        FS_WORKER_DB_PASSWORD: passwords.worker,
        FS_OPS_DB_PASSWORD: passwords.operations,
        DATABASE_BOOTSTRAP_ACKNOWLEDGEMENT: ack,
      },
    }
  );
};
beforeAll(async () => {
  bootstrap("services stopped and backup verified");
  await applyDatabaseGrants(clients.operations.db);
});
afterAll(async () => {
  await Promise.all(
    Object.entries(clients)
      .filter(([role]) => !runtimeClosed || role === "operations")
      .map(([, client]) => client.pool.end())
  );
  await pool.end();
});

describe("separate PostgreSQL service privileges", () => {
  it("verifies real non-superuser logins and grants operations DDL while limiting runtime schemas", async () => {
    for (const role of Object.keys(clients) as ServiceRole[])
      expect(await checkDatabaseRole(role, clients[role].db)).toEqual([]);
    await clients.app.db.execute(
      sql`insert into unit_lock (id, version) values (1, 1) on conflict (id) do update set version=unit_lock.version+1`
    );
    expect(
      (
        await clients.worker.db.execute(
          sql`select version from unit_lock where id=1`
        )
      ).rows
    ).toHaveLength(1);
    for (const role of ["app", "worker"] as const) {
      await expect(
        clients[role].db.execute(
          sql`create table public.forbidden_runtime_ddl (id int)`
        )
      ).rejects.toThrow();
      await expect(
        clients[role].db.execute(
          sql`alter table public.unit_lock add column forbidden int`
        )
      ).rejects.toThrow();
      await expect(
        clients[role].db.execute(
          sql`create database forbidden_runtime_database`
        )
      ).rejects.toThrow();
      await expect(
        clients[role].db.execute(sql`set role fair_shifts_ops`)
      ).rejects.toThrow();
    }
  });
  it("lets pg-boss initialize and work only in the worker-owned schema", async () => {
    const boss = new PgBoss({
      connectionString: roleUrl("worker"),
      createSchema: false,
    });
    boss.on("error", () => {});
    try {
      await boss.start();
      await boss.createQueue("permissions-probe");
      expect(
        await boss.send("permissions-probe", { synthetic: true })
      ).toBeTruthy();
      await expect(
        clients.app.db.execute(
          sql`create table pgboss.forbidden_site_ddl (id int)`
        )
      ).rejects.toThrow();
      await expect(
        clients.app.db.execute(sql`select * from pgboss.version`)
      ).rejects.toThrow();
      await expect(
        clients.worker.db.execute(
          sql`create table drizzle.forbidden_worker_ddl (id int)`
        )
      ).rejects.toThrow();
    } finally {
      await boss.stop({ graceful: true });
    }
  });
  it("allows the worker to dump application and migration data without schema ownership", () => {
    const url = new URL(roleUrl("worker"));
    const password = decodeURIComponent(url.password);
    url.password = "";
    const dump = execFileSync(
      "pg_dump",
      [
        "--format=custom",
        "--exclude-schema=pgboss",
        "--no-password",
        "--dbname",
        url.toString(),
      ],
      {
        env: { ...process.env, PGPASSWORD: password },
        stdio: "pipe",
        timeout: 10000,
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    expect(dump.subarray(0, 5).toString()).toBe("PGDMP");
  });
  it("stops permission verification for an unexpected object owner or schema grant", async () => {
    await clients.operations.db.execute(
      sql`grant create on schema public to fair_shifts_app`
    );
    expect(await checkDatabaseRole("app", clients.app.db)).not.toEqual([]);
    await clients.operations.db.execute(
      sql`revoke create on schema public from fair_shifts_app`
    );
    await clients.operations.db.execute(
      sql`create table public.owner_probe (id int)`
    );
    // Cluster administrator simulates an incorrectly restored object owner.
    await db.execute(
      sql`alter table public.owner_probe owner to fair_shifts_app`
    );
    expect(await checkDatabaseRole("app", clients.app.db)).not.toEqual([]);
    await db.execute(
      sql`alter table public.owner_probe owner to fair_shifts_ops`
    );
    await clients.operations.db.execute(sql`drop table public.owner_probe`);
    expect(await checkDatabaseRole("app", clients.app.db)).toEqual([]);
  });
  it("refuses an existing-database bootstrap without stopped-service and backup acknowledgement", () => {
    expect(() => bootstrap("")).toThrow();
  });
  it("refuses runtime migration, active-service migration and pending migrations without a verified backup", async () => {
    const migrate = (role: ServiceRole) =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/migrate.ts"],
        {
          encoding: "utf8",
          stdio: "pipe",
          timeout: 10000,
          env: {
            ...process.env,
            SERVICE_ROLE: role,
            DATABASE_URL: roleUrl(role),
            BACKUP_STORAGE: "",
          },
        }
      );
    const failure = (role: ServiceRole) => {
      try {
        migrate(role);
        return "unexpected success";
      } catch (error) {
        return String((error as { stderr?: unknown }).stderr);
      }
    };
    expect(failure("app")).toContain(
      "Migrations require the separate operations service"
    );
    expect(failure("operations")).toContain(
      "Stop site and worker before migrations"
    );
    await clients.app.pool.end();
    await clients.worker.pool.end();
    runtimeClosed = true;
    expect(migrate("operations")).toContain("Migrations applied");
    const latest = await clients.operations.db.execute<{
      id: number;
      hash: string;
      created_at: string;
    }>(
      sql`delete from drizzle.__drizzle_migrations where id=(select max(id) from drizzle.__drizzle_migrations) returning *`
    );
    try {
      expect(failure("operations")).toContain(
        "A verified backup from the last 24 hours is required"
      );
    } finally {
      const row = latest.rows[0];
      await clients.operations.db.execute(
        sql`insert into drizzle.__drizzle_migrations (id, hash, created_at) values (${row.id}, ${row.hash}, ${row.created_at})`
      );
    }
  });
});
