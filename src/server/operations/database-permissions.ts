import { sql } from "drizzle-orm";
import { db, type Database } from "../db";

export const databaseRoles = {
  app: "fair_shifts_app",
  worker: "fair_shifts_worker",
  operations: "fair_shifts_ops",
} as const;
export type ServiceRole = keyof typeof databaseRoles;

/** Operations owns application DDL; the worker owns only its queue schema. */
export async function applyDatabaseGrants(database: Database = db) {
  await database.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`
      DO $$ BEGIN
        EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO fair_shifts_app, fair_shifts_worker, fair_shifts_ops', current_database());
      END $$;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      REVOKE CREATE ON SCHEMA public FROM fair_shifts_app, fair_shifts_worker;
      GRANT USAGE ON SCHEMA public TO fair_shifts_app, fair_shifts_worker;
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fair_shifts_app, fair_shifts_worker;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM fair_shifts_app, fair_shifts_worker;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fair_shifts_app, fair_shifts_worker;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fair_shifts_app, fair_shifts_worker;
      REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO fair_shifts_app, fair_shifts_worker;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fair_shifts_app, fair_shifts_worker;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO fair_shifts_app, fair_shifts_worker;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO fair_shifts_app, fair_shifts_worker;
      GRANT USAGE ON SCHEMA drizzle TO fair_shifts_app, fair_shifts_worker;
      GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO fair_shifts_app, fair_shifts_worker;
      GRANT SELECT ON ALL SEQUENCES IN SCHEMA drizzle TO fair_shifts_worker;
      CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION fair_shifts_worker;
      REVOKE ALL ON SCHEMA pgboss FROM PUBLIC, fair_shifts_app;
    `)
    );
  });
}

/** Real PostgreSQL privileges, never configuration-file claims. */
export async function checkDatabaseRole(
  role: ServiceRole,
  database: Pick<Database, "execute"> = db
) {
  const result = await database.execute<{
    name: string;
    superuser: boolean;
    create_db: boolean;
    create_role: boolean;
    replication: boolean;
    bypass_rls: boolean;
    public_create: boolean;
    database_create: boolean;
    queue_create: boolean;
    operations_member: boolean;
  }>(sql`
    select current_user as name, rolsuper as superuser, rolcreatedb as create_db,
      rolcreaterole as create_role, rolreplication as replication, rolbypassrls as bypass_rls,
      has_schema_privilege(current_user, 'public', 'CREATE') as public_create,
      has_database_privilege(current_user, current_database(), 'CREATE') as database_create,
      coalesce((select has_schema_privilege(current_user, oid, 'CREATE') from pg_namespace where nspname='pgboss'), false) as queue_create,
      pg_has_role(current_user, 'fair_shifts_ops', 'MEMBER') as operations_member
    from pg_roles where rolname=current_user
  `);
  const row = result.rows[0];
  const errors: string[] = [];
  if (!row || row.name !== databaseRoles[role])
    errors.push("Database login does not match SERVICE_ROLE");
  if (!row) return errors;
  if (row.superuser || row.create_role || row.replication || row.bypass_rls)
    errors.push("Database login has forbidden cluster privileges");
  if (role === "operations") {
    if (!row.create_db || !row.public_create)
      errors.push("Operations login cannot migrate or restore databases");
  } else {
    if (
      row.create_db ||
      row.public_create ||
      row.database_create ||
      row.operations_member
    )
      errors.push("Runtime login can administer application data or databases");
    if (role === "worker" && !row.queue_create)
      errors.push("Worker cannot manage the pgboss schema");
    if (role === "app" && row.queue_create)
      errors.push("Site can manage the worker queue schema");
    const unexpected = await database.execute(sql`
      select 1 from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema'
        and not (${role} = 'worker' and nspname = 'pgboss')
        and has_schema_privilege(current_user, oid, 'CREATE')
      union all
      select 1 from (
        select relnamespace as namespace, relowner as owner from pg_class
        union all select pronamespace, proowner from pg_proc
        union all select typnamespace, typowner from pg_type
      ) objects join pg_namespace n on n.oid=objects.namespace
      where n.nspname in ('public', 'drizzle') and pg_has_role(current_user, objects.owner, 'USAGE')
      limit 1
    `);
    if (unexpected.rows.length)
      errors.push(
        "Runtime login can administer a schema or application object outside pgboss"
      );
  }
  return errors;
}
