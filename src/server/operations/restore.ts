import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { DateTime } from "luxon";
import { Client } from "pg";
import { connectDatabase, type Database, type DbTransaction } from "../db";
import { staffNotificationRecipients } from "../notification-audience";
import {
  backupRun,
  emailOutbox,
  loginCode,
  operationsState,
  session,
  user,
  verification,
} from "../auth-schema";
import { soldiers } from "../schema";
import { audit, createRecord } from "../repository";
import { enqueueEmail } from "./email";
import { RESTORE_ACTOR, applyLoggedDeletions } from "../restore-deletions";
import type { DeletionLogConfig } from "./deletion-log";
import {
  DELETION_LOG_BLOCKER,
  clearRestoreBlocker,
  raiseRestoreBlocker,
} from "./restore-gate";
import type { BackupConfig } from "./backup";
import type { BackupStorage } from "./backup-storage";
import { UNIT_ZONE } from "../../domain/time";
import { hasConditions, recordPolicies } from "../../domain/erasure";
import {
  RESTORE_CHECKS_BLOCKER,
  SAMPLE_LIMIT,
  drillAlertDue,
  drillAlertText,
  drillStatus,
  parseBackupStamp,
  restoreNoticeText,
  restoreOutcome,
  type CheckId,
  type CheckResult,
  type DeletionLogOutcome,
  type DrillRecord,
  type DrillStatus,
  type RestoreActions,
  type RestoreCounts,
  type RestoreOutcome,
  type RestoreReport,
  type RestoreSource,
} from "../../domain/restore";

/**
 * Restoring from a backup (decision 200, ticket #35).
 *
 * A backup is never restored over the live database. It is decrypted into a
 * database of its own, brought up to this version's schema, closed behind the
 * restore gate, given the deletions made since it was taken (decision 196), and
 * checked. Only a database that passed can replace the live one, by renaming
 * the two; the old one is kept under another name. A drill is the same run on a
 * scratch database that is dropped afterwards, so it can be done on the live
 * server without touching it.
 *
 * Output is English: it is read on the server (decision 187). Nothing printed or
 * stored here carries a name, a personal number or contact details.
 */

export type RestoreFailureCode =
  | "source_missing"
  | "source_corrupt"
  | "identity_missing"
  | "decrypt_failed"
  | "restore_failed"
  | "database_exists"
  | "database_missing"
  | "database_in_use"
  | "not_verified"
  | "invalid_name";

const failureText: Record<RestoreFailureCode, string> = {
  source_missing: "No backup was found in the storage or at that path",
  source_corrupt:
    "The backup does not match the size or checksum recorded for it",
  identity_missing:
    "An age identity file is needed to open an encrypted backup (--identity)",
  decrypt_failed:
    "The backup could not be decrypted; check that the identity belongs to the backup key",
  restore_failed: "pg_restore failed; the scratch database was dropped",
  database_exists:
    "That database already exists; promote it, or drop it and run again",
  database_missing: "That database does not exist",
  database_in_use:
    "Other connections are open on the live or the restored database. Stop the site and the worker first",
  not_verified:
    "That database holds no passed restore report; run the restore first",
  invalid_name: "Database names may only use letters, digits and underscores",
};

export class RestoreFailure extends Error {
  constructor(public code: RestoreFailureCode) {
    super(failureText[code]);
  }
}

type Executor = Database | DbTransaction;
const noop = () => {};

// ---------------------------------------------------------------- names

const NAME = /^[A-Za-z0-9_]+$/;
export const quoteName = (name: string) => {
  if (!NAME.test(name)) throw new RestoreFailure("invalid_name");
  return `"${name}"`;
};

export function databaseName(url: string) {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}
export function urlFor(url: string, name: string) {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
}
/** The database a restore works in, next to the live one. */
export const scratchName = (liveUrl: string, mode: "drill" | "restore") =>
  `${databaseName(liveUrl)}_${mode === "drill" ? "drill" : "restore"}`;

async function withAdmin<T>(
  liveUrl: string,
  work: (client: Client) => Promise<T>
) {
  const client = new Client({ connectionString: urlFor(liveUrl, "postgres") });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
const exists = async (client: Client, name: string) =>
  (await client.query("select 1 from pg_database where datname = $1", [name]))
    .rowCount === 1;

async function createScratch(liveUrl: string, name: string, replace: boolean) {
  await withAdmin(liveUrl, async (client) => {
    if (await exists(client, name)) {
      if (!replace) throw new RestoreFailure("database_exists");
      await client.query(`drop database ${quoteName(name)} with (force)`);
    }
    await client.query(`create database ${quoteName(name)}`);
  });
}
export async function dropDatabase(liveUrl: string, name: string) {
  await withAdmin(liveUrl, (client) =>
    client.query(`drop database if exists ${quoteName(name)} with (force)`)
  );
}

// ---------------------------------------------------------------- the backup

export type SourceInput =
  /** The newest verified backup in the storage, or the one named. */
  | { kind: "storage"; storage: BackupStorage; name?: string }
  /** An encrypted dump taken from the storage by hand. */
  | { kind: "file"; path: string }
  /**
   * A dump the operator already decrypted on their own computer, so the
   * private key never reaches the server. A path of "-" is read from the
   * standard input, which keeps the plaintext off the server's disk too.
   */
  | { kind: "dump"; path: string; point?: Date };

type Located = {
  bytes: Buffer;
  encrypted: boolean;
  source: RestoreSource;
  restorePoint?: Date;
};

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Finds the backup and reads it. From the storage it never needs the database:
 * when the live database is reachable, its record of the run adds the checksum
 * and says whether the run was verified; when it was lost, the newest dump is used.
 */
export async function locateBackup(
  input: SourceInput,
  live?: Database
): Promise<Located> {
  if (input.kind === "dump" && input.path === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) throw new RestoreFailure("source_missing");
    return {
      bytes,
      encrypted: false,
      source: {
        kind: "dump",
        name: "standard input",
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
      },
      restorePoint: input.point,
    };
  }
  if (input.kind !== "storage") {
    let info;
    try {
      info = await stat(input.path);
    } catch {
      throw new RestoreFailure("source_missing");
    }
    const bytes = await readFile(input.path);
    return {
      bytes,
      encrypted: input.kind === "file",
      source: {
        kind: input.kind,
        name: basename(input.path),
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
      },
      restorePoint:
        (input.kind === "dump" ? input.point : undefined) ??
        parseBackupStamp(basename(input.path)) ??
        info.mtime,
    };
  }
  const files = await input.storage.listBackups();
  // A live database that was lost or just created has no run table: the storage alone decides.
  const rows = live
    ? await live
        .select()
        .from(backupRun)
        .catch(() => [])
    : [];
  const runs = new Map(
    rows.filter((row) => row.storageId).map((row) => [row.storageId!, row])
  );
  const wanted = input.name
    ? files.filter((file) => file.name === input.name || file.id === input.name)
    : files;
  // A run that is not verified may still be uploading: it is not a backup yet.
  const file = wanted.find((item) => {
    const row = runs.get(item.id);
    return !row || row.status === "verified";
  });
  if (!file) throw new RestoreFailure("source_missing");
  const bytes = await input.storage.read(file.id);
  if (!bytes) throw new RestoreFailure("source_missing");
  const row = runs.get(file.id);
  const digest = sha256(bytes);
  const expectedDigest = row?.sha256 || file.sha256 || undefined;
  const expectedSize =
    row?.sizeBytes ?? (file.size >= 0 ? file.size : undefined);
  if (
    (expectedDigest && expectedDigest !== digest) ||
    (expectedSize !== undefined && expectedSize !== bytes.length)
  )
    throw new RestoreFailure("source_corrupt");
  return {
    bytes,
    encrypted: true,
    source: {
      kind: "storage",
      name: file.name,
      sizeBytes: bytes.length,
      sha256: digest,
    },
    restorePoint: parseBackupStamp(file.name) ?? file.createdAt,
  };
}

/**
 * Decrypts (when needed) and loads the dump into an empty database. The
 * plaintext only passes through a pipe; pg_restore's complaints are not read,
 * because they can quote rows.
 */
export async function restoreInto(
  targetUrl: string,
  located: Pick<Located, "bytes" | "encrypted">,
  identity?: string
) {
  if (located.encrypted) {
    if (!identity) throw new RestoreFailure("identity_missing");
    try {
      await access(identity);
    } catch {
      throw new RestoreFailure("identity_missing");
    }
  }
  const url = new URL(targetUrl);
  const password = decodeURIComponent(url.password);
  url.password = "";
  const restore = spawn(
    "pg_restore",
    [
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      "--no-password",
      `--dbname=${url.toString()}`,
    ],
    {
      env: { ...process.env, PGPASSWORD: password },
      stdio: ["pipe", "ignore", "ignore"],
    }
  );
  const exited = (child: ReturnType<typeof spawn>) =>
    new Promise<number>((resolve) => {
      child.once("error", () => resolve(-1));
      child.once("close", (code) => resolve(code ?? -1));
    });
  restore.stdin!.on("error", () => {});
  const restoreExit = exited(restore);
  let decryptExit: Promise<number> | undefined;
  if (located.encrypted) {
    const age = spawn("age", ["--decrypt", "-i", identity!], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    age.stdin!.on("error", () => {});
    age.stdout!.on("error", () => {});
    decryptExit = exited(age);
    age.stdout!.pipe(restore.stdin!);
    age.stdin!.end(located.bytes);
  } else restore.stdin!.end(located.bytes);
  const [decrypted, restored] = await Promise.all([
    decryptExit ?? Promise.resolve(0),
    restoreExit,
  ]);
  if (decrypted !== 0) throw new RestoreFailure("decrypt_failed");
  if (restored !== 0) throw new RestoreFailure("restore_failed");
}

// ---------------------------------------------------------------- the schema

export const migrationsFolder = () =>
  process.env.MIGRATIONS_FOLDER ?? "./drizzle";

async function journalTimes(): Promise<number[]> {
  const journal = JSON.parse(
    await readFile(`${migrationsFolder()}/meta/_journal.json`, "utf8")
  ) as { entries: { when: number }[] };
  return journal.entries.map((entry) => entry.when);
}

/** The migrations a backup holds, and how many of them this version does not know. */
async function backupMigrations(database: Database) {
  const known = new Set(await journalTimes());
  let times: number[] = [];
  try {
    times = (
      await database.execute<{ created_at: string }>(
        sql`select created_at from drizzle.__drizzle_migrations`
      )
    ).rows.map((row) => Number(row.created_at));
  } catch {
    // A dump without the migration table is not one this application made.
  }
  return {
    inBackup: times.length,
    inApp: known.size,
    unknown: times.filter((time) => !known.has(time)),
  };
}

// ---------------------------------------------------------------- the checks

type Found = { id: string; total: string | number };
async function found(database: Executor, query: SQL): Promise<Found[]> {
  return (await database.execute<Found>(query)).rows;
}
function checked(
  id: CheckId,
  rows: Found[],
  status: "fail" | "warn" = "fail"
): CheckResult {
  const count = rows.length ? Number(rows[0].total) : 0;
  return {
    id,
    status: count ? status : "pass",
    count,
    samples: rows.slice(0, SAMPLE_LIMIT).map((row) => row.id),
  };
}
const limited = (query: SQL) =>
  sql`select id, total from (${query}) found limit ${SAMPLE_LIMIT}`;

/**
 * Every rule a restored database must keep, asked of the database itself.
 * `fail` blocks the restore; `warn` is reported. All of it is read only, and
 * the ids it names are internal.
 */
export async function verifyRestoredData(
  database: Executor,
  now: Date
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const nowIso = now.toISOString();

  // Versions: positive everywhere; a stored copy that disagrees with its column is only a warning.
  const lowVersions = await found(
    database,
    limited(sql`
      select id, count(*) over () as total from (
        select id::text as id from soldiers where version < 1
        union all select id::text from duties where version < 1
        union all select id::text from assignments where version < 1
        union all select id::text from duty_types where version < 1
        union all select id::text from records where version < 1
        union all select soldier_id::text from balances where version < 1
        union all select id::text from unit_lock where version < 1
      ) low`)
  );
  const mismatched = await found(
    database,
    limited(sql`
      select id, count(*) over () as total from (
        select id::text as id from soldiers where data ? 'version' and (data->>'version')::int <> version
        union all select id::text from duties where data ? 'version' and (data->>'version')::int <> version
        union all select id::text from assignments where data ? 'version' and (data->>'version')::int <> version
      ) mismatched`)
  );
  results.push(
    lowVersions.length
      ? checked("versions", lowVersions)
      : checked("versions", mismatched, "warn")
  );

  results.push(
    checked(
      "assignment_links",
      await found(
        database,
        limited(sql`
          select a.id::text as id, count(*) over () as total
          from assignments a
          left join duties d on d.id = a.duty_id
          left join duty_slots s on s.id = a.slot_id
          left join soldiers p on p.id = a.soldier_id
          where d.id is null or s.id is null or p.id is null or s.duty_id <> a.duty_id`)
      )
    )
  );
  // Deleted soldiers keep the seats of a duty that already started (decision 192); any other seat should have been vacated.
  results.push(
    checked(
      "deleted_soldier_seats",
      await found(
        database,
        limited(sql`
          select a.id::text as id, count(*) over () as total
          from assignments a
          join soldiers p on p.id = a.soldier_id
          join duties d on d.id = a.duty_id
          where p.deleted_at is not null
            and a.status in ('reserved', 'held')
            and (d.data->>'start')::timestamptz > ${nowIso}::timestamptz`)
      )
    )
  );
  results.push(
    checked(
      "balances_present",
      await found(
        database,
        limited(sql`
          select s.id::text as id, count(*) over () as total
          from soldiers s left join balances b on b.soldier_id = s.id
          where b.soldier_id is null`)
      )
    )
  );
  results.push(
    checked(
      "ledger_arithmetic",
      await found(
        database,
        limited(sql`
          select id::text as id, count(*) over () as total
          from score_ledger
          where after <> before + amount or after < 0 or before < 0`)
      )
    )
  );
  // Every change of a balance goes through the ledger, so the two always agree.
  results.push(
    checked(
      "balances_match_ledger",
      await found(
        database,
        limited(sql`
          select b.soldier_id::text as id, count(*) over () as total
          from balances b
          left join (
            select soldier_id, sum(amount)::bigint as total
            from score_ledger group by soldier_id
          ) l on l.soldier_id = b.soldier_id
          where b.current <> coalesce(l.total, 0)`)
      )
    )
  );
  // A credited seat reached the ledger, or a score decision is waiting for the manager to say how it does.
  results.push(
    checked(
      "credited_have_ledger",
      await found(
        database,
        limited(sql`
          select a.id::text as id, count(*) over () as total
          from assignments a
          where a.status = 'credited'
            and not exists (
              select 1 from score_ledger l where l.source_key = 'performance:' || a.id::text)
            and not exists (
              select 1 from records r
              where r.kind = 'score_decision' and r.data->>'assignmentId' = a.id::text)`)
      )
    )
  );
  results.push(
    checked(
      "no_double_credit",
      await found(
        database,
        limited(sql`
          select a.id::text as id, count(*) over () as total
          from assignments a
          join score_ledger l on l.source_key = 'performance:' || a.id::text
          where a.status in ('reserved', 'held')`)
      )
    )
  );
  results.push(
    checked(
      "performance_orphans",
      await found(
        database,
        limited(sql`
          select l.id::text as id, count(*) over () as total
          from score_ledger l
          where l.source_key ~ '^performance:[0-9a-f-]{36}$'
            and not exists (
              select 1 from assignments a where 'performance:' || a.id::text = l.source_key)`)
      ),
      "warn"
    )
  );
  results.push(
    checked(
      "accounts",
      await found(
        database,
        limited(sql`
          select id, count(*) over () as total from (
            select u.id as id from auth_user u
            where u.role <> 'technical' and u.deleted_at is null
              and not exists (select 1 from soldiers s where s.id = u.soldier_id)
            union all
            select u.id from auth_user u join soldiers s on s.id = u.soldier_id
            where s.deleted_at is not null and u.deleted_at is null
          ) broken`)
      )
    )
  );
  results.push(
    checked(
      "technical_account",
      await found(
        database,
        sql`select 'none' as id, 1 as total
            where not exists (
              select 1 from auth_user where role = 'technical' and deleted_at is null)`
      )
    )
  );
  results.push(await deletedSoldierResidue(database, now));
  results.push(
    checked(
      "command_result_retention",
      await found(
        database,
        sql`
    select c.id::text as id, count(*) over () as total from command_results c
    where (c.content_expired_at is null and
      (not c.linkage_complete or c.created_at <= ${now}::timestamptz - interval '30 days'))
      or (c.content_expired_at is not null and not (case when jsonb_typeof(c.result) = 'object' then
        (c.result ? 'expiredAt' or c.result ? 'erasedAt') and
        (c.result - 'expiredAt' - 'erasedAt' - 'reason') = '{}'::jsonb and
        (not (c.result ? 'reason') or c.result->>'reason' = 'legacy_unlinked') else false end))
    limit 100`
      )
    )
  );
  return results;
}

/**
 * What a deletion should have removed and a restore may have brought back:
 * contact details, recorded conditions, the records and notices of that account
 * that were made before the deletion, its sign-in material and its queued mail.
 * Records made after the deletion are new history, not residue.
 */
async function deletedSoldierResidue(
  database: Executor,
  now: Date
): Promise<CheckResult> {
  const deleted = await database
    .select({ id: soldiers.id, data: soldiers.data })
    .from(soldiers)
    .where(sql`${soldiers.deletedAt} is not null`);
  if (!deleted.length) return checked("deleted_soldier_residue", []);
  const removable = Object.entries(recordPolicies)
    .filter(([, policy]) => policy.action === "delete")
    .map(([kind]) => kind);
  const residue = new Set<string>();
  const add = (rows: { id: string }[]) =>
    rows.forEach((row) => residue.add(row.id));
  for (const person of deleted)
    if (hasConditions(person.data)) residue.add(person.id);
  const query = async (text: SQL) => add(await found(database, text));
  await query(sql`
    select s.id::text as id, 1 as total
    from soldier_contacts c join soldiers s on s.id = c.soldier_id
    where s.deleted_at is not null
      and (coalesce(c.email, '') <> '' or coalesce(c.phone, '') <> '' or coalesce(c.address, '') <> '')`);
  await query(sql`
    select s.id::text as id, 1 as total
    from records r join soldiers s on s.id = r.subject_id
    where s.deleted_at is not null and r.created_at < s.deleted_at
      and r.kind in (${sql.join(
        removable.map((kind) => sql`${kind}`),
        sql`, `
      )})`);
  // Notices and settings are addressed to the account, not the soldier.
  await query(sql`
    select s.id::text as id, 1 as total
    from records r
    join auth_user u on u.id = r.data->>'accountId'
    join soldiers s on s.id = u.soldier_id
    where s.deleted_at is not null and r.created_at < s.deleted_at
      and r.kind in ('notification', 'settings')`);
  for (const table of [
    "auth_session",
    "login_code",
    "recovery_code",
    "auth_account",
  ])
    await query(
      sql`select s.id::text as id, 1 as total
          from ${sql.raw(table)} t
          join auth_user u on u.id = t.user_id
          join soldiers s on s.id = u.soldier_id
          where s.deleted_at is not null`
    );
  for (const table of ["calendar_link", "calendar_event"])
    await query(sql`
      select s.id::text as id, 1 as total from ${sql.raw(table)} c
      join auth_user u on u.id = c.account_id
      join soldiers s on s.id = u.soldier_id
      where s.deleted_at is not null`);
  await query(sql`
    select s.id::text as id, 1 as total
    from email_outbox m
    join auth_user u on u.id = m.recipient_account_id
    join soldiers s on s.id = u.soldier_id
    where s.deleted_at is not null and m.status in ('pending', 'sending')
      and m.created_at < s.deleted_at`);
  await query(sql`
    select s.id::text as id, 1 as total
    from command_results c
    join command_result_subjects l on l.command_id = c.id
    join soldiers s on s.id = l.soldier_id
    where s.deleted_at is not null and c.created_at < s.deleted_at
      and c.content_expired_at is null`);
  await query(sql`
    select c.id::text as id, 1 as total from command_results c
    where c.content_expired_at is null and
      (not c.linkage_complete or c.created_at <= ${now}::timestamptz - interval '30 days')`);
  await query(sql`
    select s.id::text as id, 1 as total from email_outbox m
    join records r on r.id = m.request_id
    join soldiers s on r.subject_id = s.id or position(s.id::text in r.data::text) > 0
    where s.deleted_at is not null and m.created_at < s.deleted_at
      and (m.status in ('pending', 'sending') or m.body <> '' or m.title <> ''
        or m.destination is not null or m.encrypted_secret is not null or m.href is not null)`);
  const ids = [...residue].sort();
  return {
    id: "deleted_soldier_residue",
    status: ids.length ? "fail" : "pass",
    count: ids.length,
    samples: ids.slice(0, SAMPLE_LIMIT),
  };
}

async function rowCounts(database: Executor): Promise<RestoreCounts> {
  const [row] = (
    await database.execute<Record<string, string | number>>(sql`
      select
        (select count(*) from soldiers) as soldiers,
        (select count(*) from soldiers where deleted_at is not null) as deleted,
        (select count(*) from duties) as duties,
        (select count(*) from assignments) as assignments,
        (select count(*) from score_ledger) as ledger,
        (select count(*) from auth_user where deleted_at is null) as accounts`)
  ).rows;
  return {
    soldiers: Number(row.soldiers),
    deletedSoldiers: Number(row.deleted),
    duties: Number(row.duties),
    assignments: Number(row.assignments),
    ledgerEntries: Number(row.ledger),
    accounts: Number(row.accounts),
  };
}

// ---------------------------------------------------------------- opening a restored system

/**
 * A backup is an old picture: whoever signed in or was waiting for a code then
 * may have lost access since, and mail that was queued has mostly been sent.
 * Both are cleared before the system opens (decision 200).
 */
export async function clearStaleAccess(tx: DbTransaction, now: Date) {
  const sessions = await tx.delete(session).returning({ id: session.id });
  const codes = await tx.delete(loginCode).returning({ id: loginCode.userId });
  const tokens = await tx
    .delete(verification)
    .returning({ id: verification.id });
  const mail = await tx
    .update(emailOutbox)
    .set({
      status: "cancelled",
      error: "restored",
      title: "",
      body: "",
      href: null,
      destination: null,
      encryptedSecret: null,
      updatedAt: now,
    })
    .where(inArray(emailOutbox.status, ["pending", "sending"]))
    .returning({ id: emailOutbox.id });
  return {
    sessionsRevoked: sessions.length,
    codesRemoved: codes.length + tokens.length,
    mailCancelled: mail.length,
  };
}

/** The managers and the technical account learn what the restore left behind. */
export async function announceRestore(
  tx: DbTransaction,
  input: { restoreId: string; restorePoint?: Date; mailCancelled: number },
  now: Date
) {
  const text = restoreNoticeText(input);
  const staff = await staffNotificationRecipients(
    tx,
    ["manager", "technical"],
    now
  );
  for (const account of staff) {
    const href = account.role === "technical" ? "/technical" : "/manage";
    await createRecord(tx, "notification", {
      accountId: account.id,
      ...text,
      href,
      restoreId: input.restoreId,
    });
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey: `restore:${input.restoreId}:${account.id}`,
      kind: "restore",
      ...text,
      href,
      priority: 1,
      expiresAt: new Date(now.getTime() + 2 * 86_400_000),
    });
  }
  return staff.length;
}

// ---------------------------------------------------------------- the drill record

export const REPORT_STATE = "restore-report";
export const DRILL_STATE = "restore-drill";

async function writeState(
  tx: Executor,
  key: string,
  data: Record<string, unknown>,
  now: Date
) {
  await tx
    .insert(operationsState)
    .values({ key, data, updatedAt: now })
    .onConflictDoUpdate({
      target: operationsState.key,
      set: { data, updatedAt: now },
    });
}
async function readDrillRecord(tx: Executor): Promise<DrillRecord> {
  const [row] = await tx
    .select()
    .from(operationsState)
    .where(eq(operationsState.key, DRILL_STATE));
  return (row?.data ?? {}) as DrillRecord;
}

/** What a drill, or a restore, left: counts and times, never content. */
export async function recordDrill(
  tx: Executor,
  outcome: RestoreOutcome,
  restorePoint: string | undefined,
  now: Date
) {
  const { lastAlertAt, ...record } = await readDrillRecord(tx);
  const next: DrillRecord = {
    ...record,
    lastAttemptAt: now.toISOString(),
    lastOutcome: outcome,
    ...(outcome === "passed" && {
      lastPassedAt: now.toISOString(),
      restorePoint,
    }),
    ...(outcome !== "passed" && lastAlertAt && { lastAlertAt }),
  };
  await writeState(tx, DRILL_STATE, next, now);
}

export async function readDrillStatus(
  tx: Executor,
  config: Pick<BackupConfig, "kind">,
  now = new Date()
): Promise<DrillStatus> {
  const [first] = await tx
    .select({ at: sql<Date | null>`min(${backupRun.finishedAt})` })
    .from(backupRun)
    .where(inArray(backupRun.status, ["verified", "deleted"]));
  return drillStatus({
    now,
    backupEnabled: config.kind !== "none",
    record: await readDrillRecord(tx),
    firstBackupAt: first?.at ? new Date(first.at).toISOString() : undefined,
  });
}

/**
 * The worker's daily look: a drill overdue by more than 100 days is a notice
 * and an email to the technical account, again every 30 days (decision 200).
 */
export async function refreshDrillAlert(
  tx: DbTransaction,
  config: Pick<BackupConfig, "kind">,
  now = new Date()
) {
  const record = await readDrillRecord(tx);
  const status = await readDrillStatus(tx, config, now);
  if (!drillAlertDue(status, record.lastAlertAt, now)) return 0;
  const text = drillAlertText(status);
  const accounts = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.role, "technical"), isNull(user.deletedAt)));
  const day = DateTime.fromJSDate(now)
    .setZone(UNIT_ZONE)
    .toFormat("yyyy-LL-dd");
  for (const account of accounts) {
    await createRecord(tx, "notification", {
      accountId: account.id,
      ...text,
      href: "/technical/backups",
    });
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey: `drill:${day}:${account.id}`,
      kind: "backup-alert",
      ...text,
      href: "/technical/backups",
      priority: 1,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
  }
  await writeState(
    tx,
    DRILL_STATE,
    { ...record, lastAlertAt: now.toISOString() },
    now
  );
  return accounts.length;
}

// ---------------------------------------------------------------- the run

export type RestoreRun = {
  mode: "drill" | "restore";
  source: SourceInput;
  /** An age identity file; the private key never lives on the server. */
  identity?: string;
  /** The live database: names derive from it, and a restore replaces it. */
  liveUrl: string;
  /** Connection to the live database, for the run table and the drill record. */
  live?: Database;
  deletionLog: DeletionLogConfig;
  /** Keep the scratch database of a drill. A restore always keeps its own. */
  keep?: boolean;
  now?: Date;
  log?: (line: string) => void;
};

export type RestoreResult = {
  report: RestoreReport;
  /** The database that holds the restored copy; undefined when it was dropped. */
  database?: string;
};

export async function runRestore(options: RestoreRun): Promise<RestoreResult> {
  const log = options.log ?? noop;
  const now = options.now ?? new Date();
  const name = scratchName(options.liveUrl, options.mode);
  const url = urlFor(options.liveUrl, name);
  const restoreId = randomUUID();
  const startedAt = new Date().toISOString();
  let created = false;
  let scratch: ReturnType<typeof connectDatabase> | undefined;
  const close = async () => {
    const pool = scratch?.pool;
    scratch = undefined;
    await pool?.end().catch(() => {});
  };
  const record = async (outcome: RestoreOutcome, point?: string) => {
    if (options.mode === "drill" && options.live)
      await recordDrill(options.live, outcome, point, now).catch(() =>
        log("The result could not be recorded in the live database")
      );
  };
  try {
    log("Locating the backup");
    const located = await locateBackup(options.source, options.live);
    log(
      `Backup ${located.source.name ?? ""} (${located.source.sizeBytes} bytes)${located.restorePoint ? `, taken ${located.restorePoint.toISOString()}` : ""}`
    );
    await createScratch(options.liveUrl, name, options.mode === "drill");
    created = true;
    log(`Restoring into the separate database ${name}`);
    await restoreInto(url, located, options.identity);

    scratch = connectDatabase(url);
    const target = scratch.db;
    const migrations = await backupMigrations(target);
    const restorePoint = located.restorePoint?.toISOString();
    const base = {
      id: restoreId,
      mode: options.mode,
      startedAt,
      source: located.source,
      restorePoint,
      schema: { inBackup: migrations.inBackup, inApp: migrations.inApp },
    };
    let report: RestoreReport;
    if (migrations.unknown.length || migrations.inBackup === 0) {
      // The schema is not one this version understands, so nothing else can be asked of it.
      const failed: CheckResult = {
        id: "migrations_known",
        status: "fail",
        count: migrations.unknown.length || 1,
        samples: migrations.unknown.slice(0, SAMPLE_LIMIT).map(String),
      };
      report = {
        ...base,
        finishedAt: new Date().toISOString(),
        counts: emptyCounts,
        deletionLog: skippedLog,
        checks: [failed],
        outcome: "failed",
      };
    } else {
      log("Bringing the copy up to this version's schema");
      await migrate(target, { migrationsFolder: migrationsFolder() });
      // Closed first: whatever happens next, nobody opens this database half checked.
      await raiseRestoreBlocker(target, RESTORE_CHECKS_BLOCKER, {
        restoreId,
        startedAt,
      });
      let cleared = { sessionsRevoked: 0, codesRemoved: 0, mailCancelled: 0 };
      if (options.mode === "restore") {
        log("Revoking sessions and sign-in codes, cancelling queued mail");
        cleared = await target.transaction((tx) => clearStaleAccess(tx, now));
      }
      log("Applying the deletions made since the backup");
      const deletionLog = await applyDeletions(
        target,
        options.deletionLog,
        now,
        options.mode === "restore"
      );
      log("Running the checks");
      const checks: CheckResult[] = [
        { id: "migrations_known", status: "pass", count: 0, samples: [] },
        ...(await verifyRestoredData(target, now)),
      ];
      const outcome = restoreOutcome(checks, deletionLog);
      let actions: RestoreActions | undefined;
      if (options.mode === "restore" && outcome !== "failed") {
        const notices = await target.transaction((tx) =>
          announceRestore(
            tx,
            {
              restoreId,
              restorePoint: located.restorePoint,
              mailCancelled: cleared.mailCancelled,
            },
            now
          )
        );
        actions = { ...cleared, noticesCreated: notices };
        await clearRestoreBlocker(target, RESTORE_CHECKS_BLOCKER, {
          restoreId,
          clearedAt: now.toISOString(),
        });
      }
      report = {
        ...base,
        finishedAt: new Date().toISOString(),
        counts: await rowCounts(target),
        deletionLog,
        checks,
        ...(actions && { actions }),
        outcome,
      };
    }
    if (options.mode === "restore") {
      await writeState(target, REPORT_STATE, report, now);
      await target.transaction(async (tx) => {
        await audit(tx, RESTORE_ACTOR, "restore.complete", restoreId, {
          outcome: report.outcome,
          restorePoint,
          checks: report.checks.filter((check) => check.status !== "pass")
            .length,
        });
        if (report.outcome === "passed")
          await recordDrill(tx, "passed", restorePoint, now);
      });
    }
    await record(report.outcome, restorePoint);
    // A restore keeps its copy for the swap; a drill drops its own unless asked to keep it.
    await close();
    const keep = options.mode === "restore" || options.keep === true;
    if (!keep) {
      await dropDatabase(options.liveUrl, name);
      created = false;
    }
    return { report, database: keep ? name : undefined };
  } catch (error) {
    // A restore that could not even load is a failed drill, and its scratch copy is useless.
    await close();
    if (created) await dropDatabase(options.liveUrl, name).catch(() => {});
    if (error instanceof RestoreFailure) await record("failed");
    throw error;
  } finally {
    await close();
  }
}

const emptyCounts: RestoreCounts = {
  soldiers: 0,
  deletedSoldiers: 0,
  duties: 0,
  assignments: 0,
  ledgerEntries: 0,
  accounts: 0,
};
const skippedLog: DeletionLogOutcome = {
  status: "blocked",
  applied: 0,
  alreadyDeleted: 0,
  notInDatabase: 0,
  head: 0,
  reasons: ["not_run"],
};

async function applyDeletions(
  database: Database,
  config: DeletionLogConfig,
  now: Date,
  writeLocalCopy: boolean
): Promise<DeletionLogOutcome> {
  if (!config.directory) {
    // Without a log nothing proves that no deletion was lost, so the copy stays closed.
    await raiseRestoreBlocker(database, DELETION_LOG_BLOCKER, {
      reasons: ["not_configured"],
    });
    return { ...skippedLog, reasons: ["not_configured"] };
  }
  const result = await applyLoggedDeletions(config, now, {
    database,
    restoreLocal: writeLocalCopy,
  });
  if (result.status === "blocked")
    return {
      ...skippedLog,
      reasons: result.verification.reasons,
    };
  return {
    status: "applied",
    applied: result.applied,
    alreadyDeleted: result.alreadyDeleted,
    notInDatabase: result.notInDatabase,
    head: result.head,
    reasons: [],
  };
}

// ---------------------------------------------------------------- the swap

/**
 * Replaces the live database with a restored one that passed its checks. The
 * live database is renamed, not dropped, so a restore can be undone by hand.
 * The site and the worker must be stopped: a rename needs no open connection.
 */
export async function promoteRestore(options: {
  liveUrl: string;
  restored?: string;
  now?: Date;
  log?: (line: string) => void;
}) {
  const log = options.log ?? noop;
  const live = databaseName(options.liveUrl);
  const restored = options.restored ?? scratchName(options.liveUrl, "restore");
  quoteName(live);
  quoteName(restored);
  const restoredUrl = urlFor(options.liveUrl, restored);
  // The verdict is read from the restored database itself.
  const probe = new Client({ connectionString: restoredUrl });
  try {
    await probe.connect();
  } catch {
    throw new RestoreFailure("database_missing");
  }
  let report: RestoreReport | undefined;
  try {
    report = (
      await probe.query("select data from operations_state where key = $1", [
        REPORT_STATE,
      ])
    ).rows[0]?.data;
  } catch {
    report = undefined;
  } finally {
    await probe.end();
  }
  if (
    !report ||
    report.mode !== "restore" ||
    (report.outcome !== "passed" && report.outcome !== "needs_deletion_log")
  )
    throw new RestoreFailure("not_verified");
  const stamp = DateTime.fromJSDate(options.now ?? new Date())
    .setZone(UNIT_ZONE)
    .toFormat("yyyyLLddHHmmss");
  const kept = `${live}_before_restore_${stamp}`;
  quoteName(kept);
  return withAdmin(options.liveUrl, async (client) => {
    // A connection that was just closed may take a moment to leave the list.
    let open = 1;
    for (let attempt = 0; attempt < 10 && open > 0; attempt++) {
      open = (
        await client.query(
          "select count(*)::int as count from pg_stat_activity where datname = any($1) and pid <> pg_backend_pid()",
          [[live, restored]]
        )
      ).rows[0].count;
      if (open > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (open > 0) throw new RestoreFailure("database_in_use");
    const hadLive = await exists(client, live);
    if (hadLive) {
      await client.query(
        `alter database ${quoteName(live)} rename to ${quoteName(kept)}`
      );
      log(`The old database is kept as ${kept}`);
    }
    try {
      await client.query(
        `alter database ${quoteName(restored)} rename to ${quoteName(live)}`
      );
    } catch (error) {
      if (hadLive)
        await client.query(
          `alter database ${quoteName(kept)} rename to ${quoteName(live)}`
        );
      throw error;
    }
    log(`The restored copy is now ${live}`);
    return {
      outcome: report.outcome as RestoreOutcome,
      kept: hadLive ? kept : undefined,
    };
  });
}
