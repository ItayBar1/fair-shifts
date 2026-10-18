import { sql, type SQL } from "drizzle-orm";
import { soldiers } from "../../schema";
import { hasConditions, recordPolicies } from "../../../domain/erasure";
import {
  SAMPLE_LIMIT,
  type CheckId,
  type CheckResult,
  type RestoreCounts,
} from "../../../domain/restore";
import { type Executor } from "./database";

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

export async function rowCounts(database: Executor): Promise<RestoreCounts> {
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
