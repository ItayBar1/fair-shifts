\getenv app_password FS_APP_DB_PASSWORD
\getenv worker_password FS_WORKER_DB_PASSWORD
\getenv ops_password FS_OPS_DB_PASSWORD
\getenv bootstrap_ack DATABASE_BOOTSTRAP_ACKNOWLEDGEMENT
BEGIN;
SELECT set_config('fair_shifts.app_password', :'app_password', true),
       set_config('fair_shifts.worker_password', :'worker_password', true),
       set_config('fair_shifts.ops_password', :'ops_password', true),
       set_config('fair_shifts.bootstrap_ack', :'bootstrap_ack', true) \gset
DO $$
DECLARE item record; kind text; owner_name text;
BEGIN
  IF to_regclass('public.auth_user') IS NOT NULL AND
      current_setting('fair_shifts.bootstrap_ack') <> 'services stopped and backup verified' THEN
    RAISE EXCEPTION 'Existing data requires stopped services and a verified backup acknowledgement';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND pid<>pg_backend_pid() AND backend_type='client backend'
      AND usename IN ('fair_shifts_app','fair_shifts_worker',current_user)) THEN
    RAISE EXCEPTION 'Stop site and worker before changing database permissions';
  END IF;
  FOREACH kind IN ARRAY ARRAY['app','worker','ops'] LOOP
    owner_name := 'fair_shifts_' || kind;
    IF length(current_setting('fair_shifts.' || kind || '_password')) < 32 THEN
      RAISE EXCEPTION 'Database role passwords must be random and at least 32 characters';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=owner_name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', owner_name);
    END IF;
    EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER %s NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
      owner_name, CASE WHEN kind='ops' THEN 'CREATEDB' ELSE 'NOCREATEDB' END,
      current_setting('fair_shifts.' || kind || '_password'));
  END LOOP;
  GRANT fair_shifts_app, fair_shifts_worker TO fair_shifts_ops;
  REVOKE fair_shifts_ops FROM fair_shifts_app, fair_shifts_worker;
  EXECUTE format('ALTER DATABASE %I OWNER TO fair_shifts_ops', current_database());
  FOR item IN SELECT nspname FROM pg_namespace WHERE nspname IN ('public','drizzle','pgboss') LOOP
    owner_name := CASE WHEN item.nspname='pgboss' THEN 'fair_shifts_worker' ELSE 'fair_shifts_ops' END;
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', item.nspname, owner_name);
  END LOOP;
  -- Transfer only application objects. REASSIGN OWNED could change system objects.
  FOR item IN SELECT c.relname, c.relkind, n.nspname FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','drizzle','pgboss') AND c.relkind IN ('r','p','S','v','m','f')
      ORDER BY CASE WHEN c.relkind='S' THEN 1 ELSE 0 END LOOP
    owner_name := CASE WHEN item.nspname='pgboss' THEN 'fair_shifts_worker' ELSE 'fair_shifts_ops' END;
    kind := CASE item.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
      WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END;
    EXECUTE format('ALTER %s %I.%I OWNER TO %I', kind, item.nspname, item.relname, owner_name);
  END LOOP;
  FOR item IN SELECT p.oid::regprocedure AS name, p.prokind, n.nspname FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','drizzle','pgboss') LOOP
    owner_name := CASE WHEN item.nspname='pgboss' THEN 'fair_shifts_worker' ELSE 'fair_shifts_ops' END;
    kind := CASE item.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END;
    EXECUTE format('ALTER %s %s OWNER TO %I', kind, item.name, owner_name);
  END LOOP;
  FOR item IN SELECT t.typname, t.typtype, n.nspname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname IN ('public','drizzle','pgboss') AND t.typtype IN ('e','d') LOOP
    owner_name := CASE WHEN item.nspname='pgboss' THEN 'fair_shifts_worker' ELSE 'fair_shifts_ops' END;
    kind := CASE item.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END;
    EXECUTE format('ALTER %s %I.%I OWNER TO %I', kind, item.nspname, item.typname, owner_name);
  END LOOP;
END $$;
COMMIT;
