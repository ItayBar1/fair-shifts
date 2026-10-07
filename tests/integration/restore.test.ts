import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { db, pool, unitTransaction } from "../../src/server/db";
import {
  backupRun,
  account,
  emailOutbox,
  loginCode,
  operationsState,
  session,
  user,
  verification,
} from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
  ledger,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import { postScore, settleDue } from "../../src/server/scoring";
import { enqueueEmail } from "../../src/server/operations/email";
import {
  backupConfig,
  requestBackup,
  runBackupCycle,
} from "../../src/server/operations/backup";
import { directoryStorage } from "../../src/server/operations/backup-storage";
import {
  DELETION_LOG_FILE,
  drainDeletionLog,
  type DeletionLogConfig,
} from "../../src/server/operations/deletion-log";
import {
  DELETION_LOG_BLOCKER,
  readRestoreGate,
} from "../../src/server/operations/restore-gate";
import {
  DRILL_STATE,
  REPORT_STATE,
  RestoreFailure,
  dropDatabase,
  locateBackup,
  migrationsFolder,
  promoteRestore,
  readDrillStatus,
  recordDrill,
  refreshDrillAlert,
  runRestore,
  urlFor,
  type RestoreRun,
} from "../../src/server/operations/restore";
import {
  DRILL_INTERVAL_DAYS,
  RESTORE_CHECKS_BLOCKER,
  type CheckId,
  type RestoreReport,
} from "../../src/domain/restore";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// Restoring from a backup into an isolated database (ticket #35, decision 200).
// The test database is the live system; every restore works in a database of its
// own next to it. Synthetic people only.
const LIVE = process.env.DATABASE_URL!;
const DAY = 86_400_000;
const NOW = new Date("2026-10-01T12:00:00Z");
const scratchNames = [
  "fair_shifts_test_drill",
  "fair_shifts_test_restore",
  "fair_shifts_promote_live",
  "fair_shifts_promote_live_restore",
  "fair_shifts_promote_plain",
];
/** Databases a swap kept aside, named by the time of the swap. */
async function dropKeptDatabases() {
  const kept = await pool.query(
    "select datname from pg_database where datname like 'fair_shifts_promote_live_before_restore_%'"
  );
  for (const { datname } of kept.rows) await dropDatabase(LIVE, datname);
}

let work: string;
let identity: string;
let otherIdentity: string;
let recipient: string;
let store: string;
let logDirectory: string;
let manager: Actor;
let technical: Actor;
let people: Actor[];
const cleanups: (() => Promise<void>)[] = [];

function run(command: string, args: string[], input?: Buffer) {
  return new Promise<{ code: number; stdout: Buffer }>((resolve, reject) => {
    const child = spawn(command, args);
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(out) })
    );
    child.stdin.end(input);
  });
}
function execute(
  args: string[],
  env: Record<string, string> = {},
  input?: Buffer
) {
  return new Promise<{ code: number; text: string; bytes: Buffer }>(
    (resolve, reject) => {
      const child = spawn(
        "node_modules/.bin/tsx",
        ["scripts/restore.ts", ...args],
        { env: { ...process.env, ...env } }
      );
      const out: Buffer[] = [];
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out.push(chunk);
        text += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({ code: code ?? -1, text, bytes: Buffer.concat(out) })
      );
      child.stdin.end(input);
    }
  );
}

const logConfig = (): DeletionLogConfig => ({
  directory: logDirectory,
  storage: directoryStorage(store),
});
const storage = () => directoryStorage(store);
const backups = () =>
  backupConfig({
    DATABASE_URL: LIVE,
    BACKUP_STORAGE: "directory",
    BACKUP_DIRECTORY: store,
    BACKUP_WORK_DIRECTORY: join(work, "staging"),
    AGE_RECIPIENT: recipient,
  });
async function invite(
  name: string,
  role: "soldier" | "manager" | "technical",
  personalNumber: string
): Promise<Actor> {
  if (role === "technical") {
    const row = await createInvitedAccount({
      name,
      role,
      email: `${personalNumber}@example.invalid`,
    });
    return { id: row.id, name, role, securityEpoch: 1 };
  }
  const soldierId = randomUUID();
  await db.insert(soldiers).values({
    id: soldierId,
    name,
    personalNumber,
    data: soldier({ id: soldierId, name, personalNumber }),
  });
  await db.insert(soldierContacts).values({
    soldierId,
    email: `${personalNumber}@example.invalid`,
    phone: `050${personalNumber}`,
    address: `רחוב הדגמה ${personalNumber}`,
  });
  await db.insert(balances).values({ soldierId });
  const row = await createInvitedAccount({
    name,
    role,
    email: `${personalNumber}@example.invalid`,
    soldierId,
  });
  return { id: row.id, name, role, soldierId, securityEpoch: 1 };
}
async function command(
  actor: Actor,
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) {
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as { id: string; version: number } & Record<string, unknown>;
}

async function deleteMember(member: Actor) {
  const [row] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, member.soldierId!));
  const impact = (await command(
    manager,
    "soldier.delete.preview",
    { id: member.soldierId },
    row.version
  )) as unknown as { previewToken: string };
  await command(
    manager,
    "soldier.delete",
    {
      id: member.soldierId,
      previewToken: impact.previewToken,
      reason: "שוחרר מהשירות",
      confirmed: true,
    },
    row.version
  );
}
const dutyRow = async (id: string) =>
  (await db.select().from(duties).where(eq(duties.id, id)))[0];

/** A published duty with one seat per person, then moved to the time asked. */
async function publishedDuty(seats: Actor[], startInDays: number) {
  const type = await command(manager, "dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: seats.length }],
  });
  const duty = await command(manager, "duty.create", {
    typeId: type.id,
    name: `תורנות ${randomUUID().slice(0, 4)}`,
    start: new Date(Date.now() + 2 * DAY).toISOString(),
    end: new Date(Date.now() + 3 * DAY).toISOString(),
  });
  const created = await dutyRow(duty.id);
  let version = 1;
  for (const [index, person] of seats.entries())
    await command(
      manager,
      "duty.assign",
      {
        dutyId: duty.id,
        slotId: created.data.slots[index].id,
        soldierId: person.soldierId,
      },
      version++
    );
  await command(
    manager,
    "duty.publish",
    { id: duty.id, confirmed: true },
    version
  );
  const row = await dutyRow(duty.id);
  await db
    .update(duties)
    .set({
      data: {
        ...row.data,
        start: new Date(Date.now() + startInDays * DAY).toISOString(),
        end: new Date(Date.now() + (startInDays + 1) * DAY).toISOString(),
      },
    })
    .where(eq(duties.id, duty.id));
  return dutyRow(duty.id);
}

/**
 * A unit with history: an opening score, a duty that ended and was credited
 * by the worker's own settlement, and a duty still to come.
 */
async function seed() {
  await unitTransaction((tx) =>
    postScore(tx, {
      soldierId: people[0]!.soldierId!,
      sourceKey: `opening:${people[0]!.soldierId}`,
      kind: "opening",
      actorId: manager.id,
      reason: "יתרת פתיחה",
      effectiveAt: new Date(),
      absolute: 10,
    })
  );
  const past = await publishedDuty([people[0]!, people[1]!], -3);
  expect(past.id).toBeTruthy();
  expect(await unitTransaction((tx) => settleDue(tx))).toBe(2);
  const future = await publishedDuty([people[2]!], 5);
  expect(future.id).toBeTruthy();
}

async function takeBackup() {
  await db.transaction((tx) => requestBackup(tx, technical, backups()));
  // The run's due time is the database's clock to the microsecond: take a moment later.
  const result = await runBackupCycle(new Date(Date.now() + 5_000), backups());
  expect(result.status).toBe("verified");
}
const drill = (overrides: Partial<RestoreRun> = {}) =>
  runRestore({
    mode: "drill",
    source: { kind: "storage", storage: storage() },
    identity,
    liveUrl: LIVE,
    live: db,
    deletionLog: logConfig(),
    now: NOW,
    ...overrides,
  });
const check = (report: RestoreReport, id: CheckId) =>
  report.checks.find((item) => item.id === id)!;
const failing = (report: RestoreReport) =>
  report.checks.filter((item) => item.status === "fail").map((item) => item.id);

async function open(name: string) {
  const client = new Client({ connectionString: urlFor(LIVE, name) });
  // A database dropped under an open connection ends it with an error event.
  client.on("error", () => {});
  await client.connect();
  cleanups.push(() => client.end());
  return client;
}
/** Everything in the restored database as text, to look for what must not be there. */
async function everything(name: string) {
  const client = await open(name);
  const tables = await client.query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"
  );
  let text = "";
  for (const { table_name } of tables.rows)
    text += (
      await client.query(`select t::text as row from "${table_name}" t`)
    ).rows
      .map((row) => row.row)
      .join("\n");
  return text;
}
async function dumpOf(name: string) {
  const client = await open(name);
  const rows = (query: string) => client.query(query).then((r) => r.rows);
  return { client, rows };
}
async function databaseExists(name: string) {
  const result = await pool.query(
    "select 1 from pg_database where datname = $1",
    [name]
  );
  return result.rowCount === 1;
}

/**
 * Loads the application's own modules against the restored database, as the site
 * would see it once it is promoted: what a restored system answers.
 */
async function asRestored<T>(
  name: string,
  work: (modules: {
    state: typeof import("../../src/server/state");
    database: typeof import("../../src/server/db");
  }) => Promise<T>
) {
  const holder = globalThis as unknown as { fairShiftsPool?: unknown };
  const previousUrl = process.env.DATABASE_URL;
  const previousPool = holder.fairShiftsPool;
  process.env.DATABASE_URL = urlFor(LIVE, name);
  delete holder.fairShiftsPool;
  vi.resetModules();
  const database = await import("../../src/server/db");
  try {
    const state = await import("../../src/server/state");
    return await work({ state, database });
  } finally {
    await database.pool.end();
    process.env.DATABASE_URL = previousUrl;
    holder.fairShiftsPool = previousPool;
    vi.resetModules();
  }
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "fair-shifts-restore-test-"));
  identity = join(work, "identity.txt");
  otherIdentity = join(work, "other-identity.txt");
  for (const file of [identity, otherIdentity])
    expect((await run("age-keygen", ["-o", file])).code).toBe(0);
  recipient = (await run("age-keygen", ["-y", identity])).stdout
    .toString()
    .trim();
});
afterAll(async () => {
  for (const name of scratchNames) await dropDatabase(LIVE, name);
  await dropKeptDatabases();
  await rm(work, { recursive: true, force: true });
  await pool.end();
});
beforeEach(async () => {
  for (const name of scratchNames) await dropDatabase(LIVE, name);
  await dropKeptDatabases();
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results, backup_run cascade`
  );
  store = join(work, `store-${randomUUID()}`);
  logDirectory = join(work, `log-${randomUUID()}`);
  await mkdir(store);
  await mkdir(logDirectory);
  technical = await invite("טכני שחזור", "technical", "00700");
  manager = await invite("אחראי שחזור", "manager", "00701");
  people = [];
  for (const [index, name] of ["ראשון", "שני", "שלישי"].entries())
    people.push(await invite(`חייל ${name}`, "soldier", `0071${index}`));
  delete process.env.RESTORE_MODE;
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
});

// ---------------------------------------------------------------- the drill

describe("a restore drill", () => {
  it("restores the newest backup into a scratch database, passes every check and leaves the live system as it was", async () => {
    await seed();
    await drainDeletionLog(logConfig());
    await takeBackup();
    // The live system moves on after the backup.
    await db.insert(session).values({
      id: randomUUID(),
      userId: manager.id,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + DAY),
      securityEpoch: 1,
    });
    const liveRecords = (await db.select().from(records)).length;

    const { report, database } = await drill();

    expect(report.outcome).toBe("passed");
    expect(failing(report)).toEqual([]);
    expect(report.checks.every((item) => item.status === "pass")).toBe(true);
    expect(report.mode).toBe("drill");
    expect(report.source).toMatchObject({ kind: "storage" });
    expect(report.source.name).toMatch(
      /^fair-shifts-\d{8}-\d{6}-[0-9a-f]{8}\.dump\.age$/
    );
    expect(report.counts).toMatchObject({
      soldiers: 4,
      deletedSoldiers: 0,
      duties: 2,
      assignments: 3,
      ledgerEntries: 3,
      accounts: 5,
    });
    expect(report.deletionLog).toMatchObject({ status: "applied", applied: 0 });
    expect(report.schema.inBackup).toBe(report.schema.inApp);
    expect(report.actions).toBeUndefined();
    // The copy is gone; the live database was not touched.
    expect(database).toBeUndefined();
    expect(await databaseExists("fair_shifts_test_drill")).toBe(false);
    expect((await db.select().from(session)).length).toBe(1);
    expect((await db.select().from(records)).length).toBe(liveRecords);
    expect(await readRestoreGate(db)).toMatchObject({ blocked: false });
    // The drill is recorded for the status row, without any content.
    const [saved] = await db
      .select()
      .from(operationsState)
      .where(eq(operationsState.key, DRILL_STATE));
    expect(saved.data).toMatchObject({
      lastOutcome: "passed",
      lastPassedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(saved.data)).not.toContain("חייל");
  });

  it("keeps the scratch copy on request, closed behind the gate while it is checked", async () => {
    await seed();
    await drainDeletionLog(logConfig());
    await takeBackup();
    const { database } = await drill({ keep: true });
    expect(database).toBe("fair_shifts_test_drill");
    const { client } = await dumpOf(database!);
    const [row] = (
      await client.query(
        "select data from operations_state where key = 'restore'"
      )
    ).rows;
    // A drill never opens the copy: the check that closed it stays raised.
    expect(row.data.blockers).toContain(RESTORE_CHECKS_BLOCKER);
  });

  it("replaces a scratch copy a previous drill left behind", async () => {
    await seed();
    await drainDeletionLog(logConfig());
    await takeBackup();
    await drill({ keep: true });
    expect((await drill()).report.outcome).toBe("passed");
  });

  it("brings a backup of an older schema up to this version's", async () => {
    await seed();
    const mailId = randomUUID();
    const mailDuties = [randomUUID(), randomUUID()];
    await db.insert(emailOutbox).values({
      id: mailId,
      recipientAccountId: people[0].id,
      eventKey: `digest:${mailId}`,
      kind: "publication-digest",
      title: "שני שיבוצים סינתטיים",
      body: mailDuties
        .map((id) => `https://example.invalid/duties/${id}`)
        .join("\n"),
      status: "sent",
      expiresAt: new Date(Date.now() + 86400_000),
    });
    await drainDeletionLog(logConfig());
    // The database as it was before migration 0008 (which added the index below) and everything after it.
    const journal = JSON.parse(
      await readFile("./drizzle/meta/_journal.json", "utf8")
    ) as { entries: { when: number; tag: string }[] };
    const since = journal.entries.find((entry) =>
      entry.tag.startsWith("0008_")
    )!.when;
    const removed = (
      await pool.query(
        "select id, hash, created_at from drizzle.__drizzle_migrations where created_at >= $1",
        [since]
      )
    ).rows;
    expect(removed.length).toBeGreaterThanOrEqual(1);
    // A backup from before 0008 must omit later schema objects as well as
    // migration records. Later migrations must recreate their own tables once.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("drop trigger google_account_proof on auth_account");
      await client.query("drop trigger session_proof on auth_session");
      await client.query("drop function fs_google_account_guard()");
      await client.query("drop function fs_session_proof_guard()");
      await client.query(
        "alter table auth_account drop column google_link_generation, drop column proof_epoch, drop column needs_email_verification"
      );
      await client.query(
        "alter table auth_session drop column google_subject, drop column google_link_generation"
      );
      await client.query(
        "alter table auth_user drop column google_link_generation"
      );
      await client.query("drop table auth_budget, auth_rate_limit");
      await client.query(
        "alter table auth_user drop column next_code_allowed_at"
      );
      await client.query("drop table calendar_event, calendar_link");
      await client.query("drop trigger duty_feed_change on duties");
      await client.query("drop trigger assignment_feed_change on assignments");
      await client.query("drop function fs_duty_feed_change()");
      await client.query("drop function fs_assignment_feed_change()");
      await client.query("drop function fs_assignment_snapshot(jsonb, jsonb)");
      await client.query("drop table assignment_feed");
      await client.query(
        "drop table assignment_mail_event, assignment_mail_window"
      );
      await client.query("alter table email_outbox drop column duty_ids");
      await client.query(
        "alter table auth_user drop column assignment_feed_cursor"
      );
      await client.query("drop index auth_account_user_provider");
      await client.query(
        "delete from drizzle.__drizzle_migrations where created_at >= $1",
        [since]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    try {
      // The current ORM knows columns absent from this deliberately old schema.
      await pool.query(
        "insert into auth_account (id, provider_id, account_id, user_id, access_token, refresh_token, id_token) values ($1, 'google', 'synthetic-legacy-subject', $2, 'synthetic-legacy-access', 'synthetic-legacy-refresh', 'synthetic-legacy-identity')",
        [randomUUID(), people[0]!.id]
      );
      await takeBackup();
    } finally {
      await migrate(db, { migrationsFolder: migrationsFolder() });
    }
    const { report, database } = await drill({ keep: true });
    expect(report.outcome).toBe("passed");
    expect(report.schema.inBackup).toBe(report.schema.inApp - removed.length);
    const { rows } = await dumpOf(database!);
    expect(
      (
        await rows(`select duty_ids from email_outbox where id = '${mailId}'`)
      )[0].duty_ids.sort()
    ).toEqual(mailDuties.sort());
    expect(
      await rows(
        "select 1 from pg_indexes where indexname = 'auth_account_user_provider'"
      )
    ).toHaveLength(1);
    expect(
      await rows(
        "select 1 from information_schema.tables where table_name in ('calendar_link', 'calendar_event')"
      )
    ).toHaveLength(2);
    expect(
      await rows(
        "select access_token, refresh_token, id_token from auth_account where provider_id = 'google'"
      )
    ).toEqual([{ access_token: null, refresh_token: null, id_token: null }]);
    expect(
      (
        await rows(
          "select count(*)::int as n from drizzle.__drizzle_migrations"
        )
      )[0].n
    ).toBe(report.schema.inApp);
  });

  it("refuses a backup written by a newer version, and runs no other check on it", async () => {
    await seed();
    await drainDeletionLog(logConfig());
    await pool.query(
      "insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-the-future', 9007199254740000)"
    );
    try {
      await takeBackup();
    } finally {
      await pool.query(
        "delete from drizzle.__drizzle_migrations where hash = 'from-the-future'"
      );
    }
    const { report, database } = await drill();
    expect(report.outcome).toBe("failed");
    expect(report.checks.map((item) => [item.id, item.status])).toEqual([
      ["migrations_known", "fail"],
    ]);
    expect(database).toBeUndefined();
    expect(await databaseExists("fair_shifts_test_drill")).toBe(false);
  });
});

// ---------------------------------------------------------------- the checks

describe("the checks of a restored database", () => {
  async function corrupt(
    change: string | ((ids: Record<string, string>) => Promise<void>)
  ) {
    await seed();
    await drainDeletionLog(logConfig());
    const [past] = await db
      .select({ id: assignments.id })
      .from(assignments)
      .where(eq(assignments.status, "credited"));
    const [future] = await db
      .select({ id: assignments.id, slotId: assignments.slotId })
      .from(assignments)
      .where(eq(assignments.status, "reserved"));
    const ids = {
      credited: past.id,
      reserved: future.id,
      reservedSlot: future.slotId,
      first: people[0]!.soldierId!,
      third: people[2]!.soldierId!,
      thirdAccount: people[2]!.id,
    };
    if (typeof change === "string") await db.execute(sql.raw(change));
    else await change(ids);
    await takeBackup();
    return ids;
  }
  type Change = string | ((ids: Record<string, string>) => Promise<void>);
  const cases: [string, CheckId, Change][] = [
    [
      "a balance that no longer equals its ledger",
      "balances_match_ledger",
      `update balances set "current" = "current" + 5 where "current" > 0`,
    ],
    [
      "a ledger entry that does not add up",
      "ledger_arithmetic",
      "update score_ledger set after = after + 1 where id = (select id from score_ledger limit 1)",
    ],
    [
      "a soldier without a balance",
      "balances_present",
      async (ids) => {
        await db.delete(balances).where(eq(balances.soldierId, ids.third));
      },
    ],
    [
      "a record version below one",
      "versions",
      "update soldiers set version = 0 where id = (select id from soldiers limit 1)",
    ],
    [
      "an account with no soldier",
      "accounts",
      "update auth_user set soldier_id = gen_random_uuid() where role = 'manager'",
    ],
    [
      "no active technical account",
      "technical_account",
      "update auth_user set deleted_at = now() where role = 'technical'",
    ],
    [
      "a seat in a slot of another duty",
      "assignment_links",
      async (ids) => {
        await db
          .update(assignments)
          .set({ slotId: ids.reservedSlot })
          .where(eq(assignments.id, ids.credited));
      },
    ],
    [
      "a credited seat that never reached the ledger",
      "credited_have_ledger",
      "update assignments set status = 'credited', data = jsonb_set(data, '{status}', '\"credited\"') where status = 'reserved'",
    ],
    [
      "a deleted soldier who still holds a seat of a duty to come",
      "deleted_soldier_seats",
      "update soldiers set deleted_at = now() where id = (select soldier_id from assignments where status = 'reserved' limit 1)",
    ],
    [
      "a deleted soldier whose contact details and account survived",
      "deleted_soldier_residue",
      "update soldiers set deleted_at = now() where personal_number = '00711'",
    ],
  ];
  it.each(cases)("fails on %s", async (_label, id, change) => {
    await corrupt(change);
    const { report } = await drill();
    expect(report.outcome).toBe("failed");
    expect(check(report, id).status).toBe("fail");
    expect(check(report, id).count).toBeGreaterThan(0);
    // The report names internal ids only.
    expect(JSON.stringify(report)).not.toContain("חייל");
    expect(JSON.stringify(report)).not.toContain("example.invalid");
    // The failed attempt is recorded, and counts as no drill.
    const [saved] = await db
      .select()
      .from(operationsState)
      .where(eq(operationsState.key, DRILL_STATE));
    expect(saved.data).toMatchObject({ lastOutcome: "failed" });
    expect(saved.data.lastPassedAt).toBeUndefined();
  });

  it("fails on a performance credit that a seat still reserved already has (a double credit)", async () => {
    await corrupt(async (ids) => {
      const [balance] = await db
        .select()
        .from(balances)
        .where(eq(balances.soldierId, ids.third));
      await db.insert(ledger).values({
        id: randomUUID(),
        soldierId: ids.third,
        sourceKey: `performance:${ids.reserved}`,
        kind: "performance",
        before: balance.current,
        after: balance.current,
        amount: 0,
        actorId: "system",
        reason: "כפילות",
        effectiveAt: new Date(),
      });
    });
    const { report } = await drill();
    expect(failing(report)).toEqual(["no_double_credit"]);
  });

  it("only warns about a performance credit with no seat, and the restore still passes", async () => {
    await corrupt(async (ids) => {
      const [balance] = await db
        .select()
        .from(balances)
        .where(eq(balances.soldierId, ids.third));
      await db.insert(ledger).values({
        id: randomUUID(),
        soldierId: ids.third,
        sourceKey: `performance:${randomUUID()}`,
        kind: "performance",
        before: balance.current,
        after: balance.current,
        amount: 0,
        actorId: "system",
        reason: "יתום",
        effectiveAt: new Date(),
      });
    });
    const { report } = await drill();
    expect(report.outcome).toBe("passed");
    expect(check(report, "performance_orphans")).toMatchObject({
      status: "warn",
      count: 1,
    });
  });

  it("accepts a credited seat whose score waits for the manager's decision", async () => {
    await corrupt(async (ids) => {
      await db.execute(
        sql`delete from score_ledger where source_key = ${`performance:${ids.credited}`}`
      );
      const [entry] = await db
        .select()
        .from(balances)
        .where(eq(balances.soldierId, ids.first));
      // The credit moved to a decision: the balance follows the ledger.
      await db
        .update(balances)
        .set({ current: 0 })
        .where(eq(balances.soldierId, entry.soldierId));
      await db.execute(
        sql`update balances set current = coalesce((select sum(amount) from score_ledger l where l.soldier_id = balances.soldier_id), 0)`
      );
      await db.insert(records).values({
        id: randomUUID(),
        kind: "score_decision",
        subjectId: ids.first,
        data: { assignmentId: ids.credited, status: "pending" },
      });
    });
    const { report } = await drill();
    expect(report.outcome).toBe("passed");
    expect(check(report, "credited_have_ledger").status).toBe("pass");
  });
});

// ---------------------------------------------------------------- finding the backup

describe("finding and reading the backup", () => {
  it("takes the newest verified backup and skips one that is not verified yet", async () => {
    await seed();
    await takeBackup();
    const [older] = await db.select().from(backupRun);
    await takeBackup();
    const [newer] = (await db.select().from(backupRun)).filter(
      (row) => row.id !== older.id
    );
    const newest = await locateBackup(
      { kind: "storage", storage: storage() },
      db
    );
    expect(newest.source.name).toBe(newer.fileName);
    expect(newest.source.sha256).toBe(newer.sha256);
    expect(newest.restorePoint).toBeInstanceOf(Date);
    // A run still marked running may be mid-upload: its file is not a backup yet.
    await db
      .update(backupRun)
      .set({ status: "running", leaseUntil: new Date(Date.now() + DAY) })
      .where(eq(backupRun.id, newer.id));
    const chosen = await locateBackup(
      { kind: "storage", storage: storage() },
      db
    );
    expect(chosen.source.name).toBe(older.fileName);
    // A name picks one.
    const named = await locateBackup(
      { kind: "storage", storage: storage(), name: older.fileName! },
      db
    );
    expect(named.source.sha256).toBe(older.sha256);
  });

  it("still finds the newest dump when the database that knew the runs is gone", async () => {
    await seed();
    await takeBackup();
    const [run] = await db.select().from(backupRun);
    const found = await locateBackup({ kind: "storage", storage: storage() });
    expect(found.source.name).toBe(run.fileName);
  });

  it("lists dumps only, never the deletion log kept beside them", async () => {
    await seed();
    await takeBackup();
    await deleteMember(people[0]!);
    await drainDeletionLog(logConfig());
    expect(
      (await readdir(store)).some((name) => name.includes("deletion-log"))
    ).toBe(true);
    const listed = await storage().listBackups();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name.endsWith(".dump.age")).toBe(true);
  });

  it("refuses a file that does not match its recorded checksum", async () => {
    await seed();
    await takeBackup();
    const [file] = await readdir(store);
    const path = join(store, file!);
    const bytes = await readFile(path);
    bytes[bytes.length - 3] ^= 0xff;
    await writeFile(path, bytes);
    await expect(
      drill({ source: { kind: "storage", storage: storage() } })
    ).rejects.toMatchObject({ code: "source_corrupt" });
    expect(await databaseExists("fair_shifts_test_drill")).toBe(false);
    const [saved] = await db
      .select()
      .from(operationsState)
      .where(eq(operationsState.key, DRILL_STATE));
    expect(saved.data).toMatchObject({ lastOutcome: "failed" });
  });

  it("says so when there is no backup, no key, or the wrong key, and leaves no copy behind", async () => {
    await expect(drill()).rejects.toMatchObject({ code: "source_missing" });
    await seed();
    await takeBackup();
    await expect(drill({ identity: undefined })).rejects.toMatchObject({
      code: "identity_missing",
    });
    await expect(
      drill({ identity: join(work, "absent.txt") })
    ).rejects.toMatchObject({ code: "identity_missing" });
    await expect(drill({ identity: otherIdentity })).rejects.toMatchObject({
      code: "decrypt_failed",
    });
    expect(await databaseExists("fair_shifts_test_drill")).toBe(false);
    expect(new RestoreFailure("decrypt_failed").message).toContain("identity");
  });

  it("restores a file taken by hand, and a dump the operator decrypted on their own computer", async () => {
    await seed();
    await drainDeletionLog(logConfig());
    await takeBackup();
    const [file] = await readdir(store);
    const encrypted = join(store, file!);
    expect(
      (await drill({ source: { kind: "file", path: encrypted } })).report
    ).toMatchObject({ outcome: "passed", source: { kind: "file" } });
    const plain = join(work, "plain.dump");
    const decrypted = await run(
      "age",
      ["--decrypt", "-i", identity],
      await readFile(encrypted)
    );
    await writeFile(plain, decrypted.stdout);
    expect(
      (
        await drill({
          source: { kind: "dump", path: plain },
          identity: undefined,
        })
      ).report
    ).toMatchObject({ outcome: "passed", source: { kind: "dump" } });
    await expect(
      drill({ source: { kind: "file", path: join(work, "absent") } })
    ).rejects.toMatchObject({ code: "source_missing" });
  });
});

// ---------------------------------------------------------------- deletions made after the backup

describe("deletions made after the backup", () => {
  const needles = [
    "0501234567",
    "רחוב חדש 9",
    "טיפול רפואי סינתטי",
    "אושר בגלל מצב אישי",
    "0509999999",
    "פטור סינתטי",
    "הודעה אישית לחייל",
    "00711@example.invalid",
  ];
  const present = (text: string) =>
    needles.filter((needle) => text.includes(needle));

  /** Sensitive data in every kind of copy the deletion removes, as the live system keeps it. */
  async function giveSensitiveData() {
    const member = people[1]!;
    const [row] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, member.soldierId!));
    await command(
      manager,
      "soldier.update",
      {
        id: member.soldierId,
        name: row.name,
        personalNumber: row.personalNumber,
        phone: "0501234567",
        address: "רחוב חדש 9",
      },
      row.version
    );
    const round = await command(manager, "round.create", {
      name: "סבב סינתטי",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 3_600_000).toISOString(),
      targetStart: "2030-11-01",
      targetEnd: "2030-11-30",
    });
    const submitted = await command(member, "constraint.submit", {
      roundId: round.id,
      startDate: "2030-11-10",
      endDate: "2030-11-11",
      reason: "טיפול רפואי סינתטי",
    });
    await command(
      manager,
      "constraint.review",
      { id: submitted.id, decision: "approved", reason: "אושר בגלל מצב אישי" },
      submitted.version
    );
    await db.insert(records).values([
      {
        id: randomUUID(),
        kind: "personnel_change",
        subjectId: member.soldierId,
        data: { kind: "exemption", reason: "פטור סינתטי", actorId: manager.id },
      },
      {
        id: randomUUID(),
        kind: "notification",
        subjectId: member.soldierId,
        data: { title: "הודעה", body: "הודעה אישית לחייל" },
      },
      {
        id: randomUUID(),
        kind: "import_row",
        subjectId: member.soldierId,
        data: {
          batchId: randomUUID(),
          rowNumber: 2,
          mode: "update",
          name: row.name,
          values: { personalNumber: row.personalNumber, phone: "0509999999" },
          changes: [{ key: "phone", before: "1", after: "0509999999" }],
        },
      },
    ]);
    return member;
  }
  it("are applied again from the log before anything of the restored copy is open, and no deleted data returns", async () => {
    await seed();
    const member = await giveSensitiveData();
    await drainDeletionLog(logConfig());
    // The backup holds everything the soldier's deletion will remove.
    await takeBackup();
    expect(present(await everything("fair_shifts_test")).length).toBe(
      needles.length
    );
    await deleteMember(member);
    expect(await drainDeletionLog(logConfig())).toMatchObject({
      status: "appended",
    });
    expect(present(await everything("fair_shifts_test"))).toEqual([]);

    const { report, database } = await drill({ mode: "restore" });

    expect(report.outcome).toBe("passed");
    expect(report.deletionLog).toMatchObject({
      status: "applied",
      applied: 1,
      alreadyDeleted: 0,
      head: 1,
    });
    expect(report.counts.deletedSoldiers).toBe(1);
    // In the copy: nothing the deletion removed is left, in any table.
    expect(present(await everything(database!))).toEqual([]);
    const { rows } = await dumpOf(database!);
    expect(
      await rows(
        `select name, personal_number, deleted_at is not null as deleted from soldiers where id = '${member.soldierId}'`
      )
    ).toEqual([{ name: member.name, personal_number: "00711", deleted: true }]);
    // The history stays, and so does the event.
    expect(
      await rows(
        `select 1 from assignments where soldier_id = '${member.soldierId}'`
      )
    ).not.toHaveLength(0);
    expect(
      await rows(
        "select 1 from records where kind = 'audit' and data->>'action' = 'soldier.delete'"
      )
    ).toHaveLength(1);

    // What the restored system answers once it is open: nobody is shown the deleted data,
    // in a response, a notice or the import records.
    await asRestored(database!, async ({ state }) => {
      for (const actor of [manager, technical, people[0]!, people[2]!]) {
        const answer = JSON.stringify(await state.readState(actor));
        expect(present(answer), actor.name).toEqual([]);
      }
      const asManager = (await state.readState(manager)) as unknown as {
        imports: unknown[];
        notifications: unknown[];
      };
      expect(present(JSON.stringify(asManager.notifications))).toEqual([]);
      expect(present(JSON.stringify(asManager.imports))).toEqual([]);
    });
  });

  it("leaves the restored copy closed, with its sensitive data, when the log is missing", async () => {
    await seed();
    const member = await giveSensitiveData();
    await drainDeletionLog(logConfig());
    await takeBackup();
    await deleteMember(member);
    await drainDeletionLog(logConfig());
    // The server lost the log file and the copy beside the backups: nothing says what was deleted.
    await rm(join(logDirectory, DELETION_LOG_FILE));
    for (const name of await readdir(store))
      if (name.includes("deletion-log")) await rm(join(store, name));

    const { report, database } = await drill({ keep: true });

    expect(report.outcome).toBe("needs_deletion_log");
    expect(report.deletionLog).toMatchObject({ status: "blocked", applied: 0 });
    expect(report.deletionLog.reasons).toContain("no_log");
    expect(failing(report)).toEqual([]);
    // Nothing was applied, so the old data is in the copy: exactly why it must stay closed.
    expect(present(await everything(database!)).length).toBeGreaterThan(0);
    const { rows } = await dumpOf(database!);
    const [gate] = await rows(
      "select data from operations_state where key = 'restore'"
    );
    expect(gate.data.blockers).toContain(DELETION_LOG_BLOCKER);
  });

  it("keeps the restored copy closed when no deletion log is configured at all", async () => {
    await seed();
    await takeBackup();
    const { report, database } = await drill({ deletionLog: {}, keep: true });
    expect(report.outcome).toBe("needs_deletion_log");
    expect(report.deletionLog.reasons).toEqual(["not_configured"]);
    const { rows } = await dumpOf(database!);
    const [gate] = await rows(
      "select data from operations_state where key = 'restore'"
    );
    expect(gate.data.blockers).toContain(DELETION_LOG_BLOCKER);
  });

  it("does not write the live deletion log when only drilling", async () => {
    await seed();
    await drainDeletionLog(logConfig());
    await takeBackup();
    await deleteMember(people[0]!);
    await drainDeletionLog(logConfig());
    const before = await readFile(
      join(logDirectory, DELETION_LOG_FILE),
      "utf8"
    );
    await rm(join(logDirectory, DELETION_LOG_FILE));
    // Only the copy beside the backups holds the log now: a real restore would put it back, a drill must not.
    const { report } = await drill();
    expect(report.outcome).toBe("passed");
    await expect(
      readFile(join(logDirectory, DELETION_LOG_FILE))
    ).rejects.toThrow();
    expect(before.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- a restore that goes live

describe("a restore that is meant to go live", () => {
  async function aliveBeforeTheLoss() {
    await seed();
    await drainDeletionLog(logConfig());
    // State the backup captures: signed-in people, waiting codes and queued mail.
    for (const actor of [manager, people[0]!])
      await db.insert(session).values({
        id: randomUUID(),
        userId: actor.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + DAY),
        securityEpoch: 1,
      });
    await db.insert(loginCode).values({
      userId: people[1]!.id,
      digest: "synthetic",
      securityEpoch: 1,
      expiresAt: new Date(Date.now() + DAY),
      sentAt: new Date(),
    });
    await db.insert(verification).values({
      id: randomUUID(),
      identifier: "synthetic",
      value: "synthetic",
      expiresAt: new Date(Date.now() + DAY),
    });
    await db.transaction(async (tx) => {
      for (const [index, actor] of people.entries())
        await enqueueEmail(tx, {
          recipientAccountId: actor.id,
          eventKey: `publish:synthetic:${index}`,
          kind: "publication",
          title: "שובצת",
          body: "שובצת לתורנות",
          expiresAt: new Date(Date.now() + DAY),
        });
    });
    await takeBackup();
    // What the backup holds, counted by the live system itself.
    return {
      queued: (
        await db
          .select()
          .from(emailOutbox)
          .where(inArray(emailOutbox.status, ["pending", "sending"]))
      ).length,
      codes:
        (await db.select().from(loginCode)).length +
        (await db.select().from(verification)).length,
    };
  }
  const restore = (overrides: Partial<RestoreRun> = {}) =>
    drill({ mode: "restore", ...overrides });

  it("clears stale access and mail, tells the managers, and opens only after every check passed", async () => {
    const held = await aliveBeforeTheLoss();
    expect(held.queued).toBeGreaterThanOrEqual(3);
    expect(held.codes).toBeGreaterThanOrEqual(2);
    const { report, database } = await restore();

    expect(report.outcome).toBe("passed");
    expect(report.actions).toEqual({
      sessionsRevoked: 2,
      codesRemoved: held.codes,
      mailCancelled: held.queued,
      noticesCreated: 2,
    });
    expect(database).toBe("fair_shifts_test_restore");
    const { client, rows } = await dumpOf(database!);
    // Nobody stays signed in, and no code from before the backup works.
    expect(await rows("select 1 from auth_session")).toHaveLength(0);
    expect(await rows("select 1 from login_code")).toHaveLength(0);
    expect(await rows("select 1 from auth_verification")).toHaveLength(0);
    // The mail that was queued is cancelled, with nothing of its text or address; only the restore notices wait.
    const mail = await rows(
      "select kind, status, error, title, body, destination, encrypted_secret from email_outbox order by kind"
    );
    const cancelled = mail.filter((row) => row.status === "cancelled");
    expect(cancelled).toHaveLength(held.queued);
    for (const row of cancelled)
      expect(row).toMatchObject({
        status: "cancelled",
        error: "restored",
        title: "",
        body: "",
        destination: null,
        encrypted_secret: null,
      });
    expect(
      mail.filter((row) => row.status === "pending").map((row) => row.kind)
    ).toEqual(["restore", "restore"]);
    // Both managers, the manager and the technical account, see a notice with the restore point.
    const notices = await rows(
      "select data from records where kind = 'notification' and data->>'title' = 'המערכת שוחזרה מגיבוי'"
    );
    expect(notices.map((row) => row.data.accountId).sort()).toEqual(
      [manager.id, technical.id].sort()
    );
    expect(notices[0].data.body).toContain("מגיבוי מ־");
    expect(notices[0].data.body).toContain(
      `${held.queued} מיילים שהמתינו בתור בוטלו`
    );
    expect(
      await rows(
        "select 1 from records where kind = 'audit' and data->>'action' = 'restore.complete'"
      )
    ).toHaveLength(1);
    // The gate is open, the verdict and the drill are saved with it.
    const [gate] = await rows(
      "select data from operations_state where key = 'restore'"
    );
    expect(gate.data).toMatchObject({ blocked: false, blockers: [] });
    const [saved] = await rows(
      `select data from operations_state where key = '${REPORT_STATE}'`
    );
    expect(saved.data).toMatchObject({ outcome: "passed", mode: "restore" });
    const [drilled] = await rows(
      `select data from operations_state where key = '${DRILL_STATE}'`
    );
    expect(drilled.data.lastOutcome).toBe("passed");
    await client.end();

    // The live system is untouched: its sessions and mail are still there.
    expect((await db.select().from(session)).length).toBe(2);
    expect(
      (
        await db
          .select()
          .from(emailOutbox)
          .where(eq(emailOutbox.status, "pending"))
      ).length
    ).toBe(held.queued);

    // What the restored system answers once it replaces the live one: it opens, and signed-in people were signed out.
    await asRestored(database!, async ({ state, database: restored }) => {
      expect((await state.readState(manager)).actor.id).toBe(manager.id);
      expect((await restored.db.select().from(session)).length).toBe(0);
    });
  });

  it("stays closed when a check fails, and cannot be promoted", async () => {
    await aliveBeforeTheLoss();
    await db.execute(
      sql`update balances set "current" = "current" + 5 where "current" > 0`
    );
    await takeBackup();
    const { report, database } = await restore();
    expect(report.outcome).toBe("failed");
    expect(failing(report)).toContain("balances_match_ledger");
    expect(report.actions).toBeUndefined();
    const { rows } = await dumpOf(database!);
    const [gate] = await rows(
      "select data from operations_state where key = 'restore'"
    );
    expect(gate.data).toMatchObject({ blocked: true });
    expect(gate.data.blockers).toContain(RESTORE_CHECKS_BLOCKER);
    // No notice, no audit of a completed restore, no drill that counts.
    expect(
      await rows(
        "select 1 from records where kind = 'notification' and data->>'title' = 'המערכת שוחזרה מגיבוי'"
      )
    ).toHaveLength(0);
    // Nobody can sign in to it, and it cannot take the live one's place.
    await asRestored(database!, async ({ state }) => {
      await expect(state.readState(manager)).rejects.toMatchObject({
        status: 401,
      });
    });
    await expect(
      promoteRestore({ liveUrl: LIVE, restored: database })
    ).rejects.toMatchObject({ code: "not_verified" });
  });

  it("opens the data checks but keeps the system closed while the deletion log is unverified", async () => {
    await aliveBeforeTheLoss();
    await rm(join(logDirectory, DELETION_LOG_FILE));
    const { report, database } = await restore();
    expect(report.outcome).toBe("needs_deletion_log");
    const { rows } = await dumpOf(database!);
    const [gate] = await rows(
      "select data from operations_state where key = 'restore'"
    );
    expect(gate.data.blockers).toEqual([DELETION_LOG_BLOCKER]);
    expect(gate.data.blocked).toBe(true);
    // Not a passed drill.
    expect(
      await rows(
        `select data from operations_state where key = '${DRILL_STATE}'`
      )
    ).toHaveLength(0);
    await asRestored(database!, async ({ state }) => {
      await expect(state.readState(manager)).rejects.toMatchObject({
        status: 401,
      });
    });
  });

  it("writes the verified log back to a fresh volume, which a drill never does", async () => {
    await aliveBeforeTheLoss();
    await deleteMember(people[0]!);
    await drainDeletionLog(logConfig());
    const before = await readFile(
      join(logDirectory, DELETION_LOG_FILE),
      "utf8"
    );
    // A new server: the volume of the log is empty, the copy beside the backups survives.
    await rm(join(logDirectory, DELETION_LOG_FILE));
    const { report } = await restore();
    expect(report.outcome).toBe("passed");
    expect(await readFile(join(logDirectory, DELETION_LOG_FILE), "utf8")).toBe(
      before
    );
  });

  it("refuses to restore over a copy that is waiting to be promoted", async () => {
    await aliveBeforeTheLoss();
    await restore();
    await expect(restore()).rejects.toMatchObject({ code: "database_exists" });
  });
});

// ---------------------------------------------------------------- the swap

describe("replacing the live database", () => {
  const LIVE_NAME = "fair_shifts_promote_live";
  const url = urlFor(LIVE, LIVE_NAME);
  const stamp = new Date("2026-10-02T09:15:30Z");

  async function prepared() {
    await seed();
    await drainDeletionLog(logConfig());
    await takeBackup();
    await pool.query(`create database ${LIVE_NAME}`);
    const old = new Client({ connectionString: url });
    await old.connect();
    await old.query("create table marker (note text)");
    await old.query("insert into marker values ('the database that was lost')");
    await old.end();
    const { report, database } = await runRestore({
      mode: "restore",
      source: { kind: "storage", storage: storage() },
      identity,
      liveUrl: url,
      deletionLog: logConfig(),
      now: NOW,
    });
    expect(report.outcome).toBe("passed");
    expect(database).toBe(`${LIVE_NAME}_restore`);
    return database!;
  }

  it("renames the live database aside and puts the checked copy in its place", async () => {
    const restored = await prepared();
    const result = await promoteRestore({ liveUrl: url, restored, now: stamp });
    expect(result.outcome).toBe("passed");
    expect(result.kept).toBe(`${LIVE_NAME}_before_restore_20261002121530`);
    const now = await open(LIVE_NAME);
    expect(
      (await now.query("select count(*)::int as n from soldiers")).rows[0].n
    ).toBe(4);
    const kept = await open(result.kept!);
    expect((await kept.query("select note from marker")).rows).toEqual([
      { note: "the database that was lost" },
    ]);
    expect(await databaseExists(restored)).toBe(false);
    await kept.end();
    await now.end();
    await dropDatabase(LIVE, result.kept!);
  });

  it("restores into a database that does not exist yet, as after a total loss", async () => {
    const restored = await prepared();
    await dropDatabase(LIVE, LIVE_NAME);
    const result = await promoteRestore({ liveUrl: url, restored, now: stamp });
    expect(result.kept).toBeUndefined();
    const now = await open(LIVE_NAME);
    expect(
      (await now.query("select count(*)::int as n from soldiers")).rows[0].n
    ).toBe(4);
  });

  it("refuses while anyone is connected to either database, and changes nothing", async () => {
    const restored = await prepared();
    const connected = await open(LIVE_NAME);
    await expect(
      promoteRestore({ liveUrl: url, restored, now: stamp })
    ).rejects.toMatchObject({ code: "database_in_use" });
    await connected.end();
    const other = await open(restored);
    await expect(
      promoteRestore({ liveUrl: url, restored, now: stamp })
    ).rejects.toMatchObject({ code: "database_in_use" });
    await other.end();
    expect(await databaseExists(LIVE_NAME)).toBe(true);
    expect(await databaseExists(restored)).toBe(true);
    const marker = await open(LIVE_NAME);
    expect((await marker.query("select note from marker")).rowCount).toBe(1);
  });

  it("refuses a database that holds no passed restore report, or does not exist", async () => {
    await pool.query("create database fair_shifts_promote_plain");
    await expect(
      promoteRestore({ liveUrl: url, restored: "fair_shifts_promote_plain" })
    ).rejects.toMatchObject({ code: "not_verified" });
    await expect(
      promoteRestore({ liveUrl: url, restored: "fair_shifts_absent" })
    ).rejects.toMatchObject({ code: "database_missing" });
    await expect(
      promoteRestore({ liveUrl: url, restored: "bad-name; drop database x" })
    ).rejects.toMatchObject({ code: "invalid_name" });
  });
});

// ---------------------------------------------------------------- the drill status and its reminder

describe("the drill status and its reminder", () => {
  const on = backupConfig({ BACKUP_STORAGE: "directory" });
  const off = backupConfig({});
  const verifiedRun = (finishedAt: Date) =>
    db.insert(backupRun).values({
      id: randomUUID(),
      key: `manual:${randomUUID()}`,
      trigger: "manual",
      status: "verified",
      finishedAt,
    });
  const mailTo = async (kind: string) =>
    (await db.select().from(emailOutbox)).filter((row) => row.kind === kind);
  const noticesOf = async () =>
    (
      await db.select().from(records).where(eq(records.kind, "notification"))
    ).filter((row) => row.data.accountId === technical.id);

  it("is off without backups, waiting while young, ok after a pass and overdue after 100 days", async () => {
    expect(await readDrillStatus(db, off, NOW)).toMatchObject({
      state: "disabled",
    });
    expect(await readDrillStatus(db, on, NOW)).toMatchObject({
      state: "pending",
    });
    await verifiedRun(new Date(NOW.getTime() - 30 * DAY));
    expect(await readDrillStatus(db, on, NOW)).toMatchObject({
      state: "pending",
      daysSince: 30,
    });
    await recordDrill(
      db,
      "passed",
      "2026-09-01T00:00:00.000Z",
      new Date(NOW.getTime() - 40 * DAY)
    );
    expect(await readDrillStatus(db, on, NOW)).toMatchObject({
      state: "ok",
      daysSince: 40,
      restorePoint: "2026-09-01T00:00:00.000Z",
    });
    await recordDrill(db, "failed", undefined, NOW);
    expect(await readDrillStatus(db, on, NOW)).toMatchObject({
      state: "ok",
      lastOutcome: "failed",
    });
    await recordDrill(
      db,
      "passed",
      undefined,
      new Date(NOW.getTime() - (DRILL_INTERVAL_DAYS + 1) * DAY)
    );
    expect(await readDrillStatus(db, on, NOW)).toMatchObject({
      state: "overdue",
    });
  });

  it("shows the technical account the status, and nobody else", async () => {
    await verifiedRun(new Date(NOW.getTime() - 5 * DAY));
    const state = await readState(technical);
    expect(state).toHaveProperty("restoreDrill");
    expect(
      state.operations.map((row) => (row as { id: string }).id)
    ).not.toContain(DRILL_STATE);
    expect(await readState(manager)).not.toHaveProperty("restoreDrill");
  });

  it("reminds the technical account once when overdue, and again after 30 days", async () => {
    await recordDrill(
      db,
      "passed",
      undefined,
      new Date(NOW.getTime() - 101 * DAY)
    );
    expect(await db.transaction((tx) => refreshDrillAlert(tx, on, NOW))).toBe(
      1
    );
    const [notice] = await noticesOf();
    expect(notice.data.title).toBe("הגיע הזמן לתרגיל שחזור");
    expect(notice.data.body).toContain("101 ימים");
    expect(await mailTo("backup-alert")).toHaveLength(1);
    // Not again the same day, nor within the month.
    expect(await db.transaction((tx) => refreshDrillAlert(tx, on, NOW))).toBe(
      0
    );
    expect(
      await db.transaction((tx) =>
        refreshDrillAlert(tx, on, new Date(NOW.getTime() + 29 * DAY))
      )
    ).toBe(0);
    expect(
      await db.transaction((tx) =>
        refreshDrillAlert(tx, on, new Date(NOW.getTime() + 31 * DAY))
      )
    ).toBe(1);
    expect(await noticesOf()).toHaveLength(2);
  });

  it("does not remind when the drill is current, or backups are off, or nothing was ever backed up", async () => {
    await recordDrill(
      db,
      "passed",
      undefined,
      new Date(NOW.getTime() - 99 * DAY)
    );
    expect(await db.transaction((tx) => refreshDrillAlert(tx, on, NOW))).toBe(
      0
    );
    await recordDrill(
      db,
      "passed",
      undefined,
      new Date(NOW.getTime() - 200 * DAY)
    );
    expect(await db.transaction((tx) => refreshDrillAlert(tx, off, NOW))).toBe(
      0
    );
    await db.execute(
      sql`delete from operations_state where key = ${DRILL_STATE}`
    );
    expect(await db.transaction((tx) => refreshDrillAlert(tx, on, NOW))).toBe(
      0
    );
    expect(await noticesOf()).toHaveLength(0);
  });

  it("stops reminding once a drill passes", async () => {
    await recordDrill(
      db,
      "passed",
      undefined,
      new Date(NOW.getTime() - 150 * DAY)
    );
    await db.transaction((tx) => refreshDrillAlert(tx, on, NOW));
    await recordDrill(db, "passed", undefined, NOW);
    const [saved] = await db
      .select()
      .from(operationsState)
      .where(eq(operationsState.key, DRILL_STATE));
    expect(saved.data.lastAlertAt).toBeUndefined();
    expect(
      await db.transaction((tx) =>
        refreshDrillAlert(tx, on, new Date(NOW.getTime() + 90 * DAY))
      )
    ).toBe(0);
  });
});

// ---------------------------------------------------------------- the command

describe("the server command", () => {
  const env = () => ({
    BACKUP_STORAGE: "directory",
    BACKUP_DIRECTORY: store,
    AGE_RECIPIENT: recipient,
    DELETION_LOG_DIRECTORY: logDirectory,
    RESTORE_IDENTITY_FILE: identity,
  });

  it("lists the backups, drills one and exits 0 only when every check passed", async () => {
    await seed();
    await drainDeletionLog(logConfig());
    await takeBackup();
    const [run] = await db.select().from(backupRun);
    const listed = await execute(["list"], env());
    expect(listed.code).toBe(0);
    expect(listed.text).toContain(run.fileName!);
    const drilled = await execute(["drill"], env());
    expect(drilled.code).toBe(0);
    expect(drilled.text).toContain("Restore drill: PASSED");
    expect(drilled.text).toContain("PASS balances_match_ledger");
    expect(drilled.text).toContain("Deletion log: applied");
    expect(drilled.text).toContain(
      "The result is recorded for the drill status"
    );
    expect(drilled.text).not.toContain("חייל");
    const [saved] = await db
      .select()
      .from(operationsState)
      .where(eq(operationsState.key, DRILL_STATE));
    expect(saved.data).toMatchObject({ lastOutcome: "passed" });
  });

  it("takes a backup off the server and restores a dump piped in, so that neither the key nor the plaintext is on the server", async () => {
    await seed();
    await drainDeletionLog(logConfig());
    await takeBackup();
    const [file] = await readdir(store);
    const fetched = await execute(["fetch"], env());
    expect(fetched.code).toBe(0);
    // Exactly the stored ciphertext, with nothing else on the standard output.
    expect(fetched.bytes.equals(await readFile(join(store, file!)))).toBe(true);
    const plain = (
      await run("age", ["--decrypt", "-i", identity], fetched.bytes)
    ).stdout;
    const piped = await execute(
      [
        "drill",
        "--dump",
        "-",
        "--point",
        "fair-shifts-20261001-033000-1a2b3c4d.dump.age",
      ],
      { ...env(), RESTORE_IDENTITY_FILE: "" },
      plain
    );
    expect(piped.code).toBe(0);
    expect(piped.text).toContain("Source: dump standard input");
    expect(piped.text).toContain("Restore point: 2026-10-01T00:30:00.000Z");
    expect(piped.text).toContain("Restore drill: PASSED");
    expect(
      (await execute(["drill", "--dump", "-"], env(), Buffer.alloc(0))).code
    ).toBe(1);
    expect(
      (
        await execute(
          ["drill", "--dump", "-", "--point", "not a time"],
          env(),
          plain
        )
      ).text
    ).toContain("--point is not a time");
  });

  it("restores and swaps in one command, after closing its own connection to the live database", async () => {
    await seed();
    await drainDeletionLog(logConfig());
    await takeBackup();
    // The live database was lost and created again: it exists, and holds no tables.
    await pool.query("create database fair_shifts_promote_live");
    const result = await execute(["restore", "--promote"], {
      ...env(),
      DATABASE_URL: urlFor(LIVE, "fair_shifts_promote_live"),
    });
    expect(result.text).toContain("Restore: PASSED");
    expect(result.text).toContain("Promoted. Start the site and the worker.");
    expect(result.code).toBe(0);
    const swapped = await open("fair_shifts_promote_live");
    expect(
      (await swapped.query("select count(*)::int as n from soldiers")).rows[0].n
    ).toBe(4);
    const kept = (
      await pool.query(
        "select datname from pg_database where datname like 'fair_shifts_promote_live_before_restore_%'"
      )
    ).rows;
    expect(kept).toHaveLength(1);
    expect(await databaseExists("fair_shifts_promote_live_restore")).toBe(
      false
    );
    await swapped.end();
    await dropDatabase(LIVE, kept[0].datname);
  });

  it("exits 1 with the report when a check fails, and 2 on a bad command", async () => {
    await seed();
    await drainDeletionLog(logConfig());
    await db.execute(
      sql`update balances set "current" = "current" + 5 where "current" > 0`
    );
    await takeBackup();
    const failed = await execute(["drill"], env());
    expect(failed.code).toBe(1);
    expect(failed.text).toContain("Restore drill: FAILED");
    expect(failed.text).toContain("FAIL balances_match_ledger");
    const wrong = await execute(["nonsense"], env());
    expect(wrong.code).toBe(2);
    expect(wrong.text).toContain("Usage: pnpm restore");
    const noKey = await execute(["drill"], {
      ...env(),
      RESTORE_IDENTITY_FILE: "",
    });
    expect(noKey.code).toBe(1);
    expect(noKey.text).toContain("age identity");
  });
});

// A last look at how the pieces meet: the audit log names what a restore did.
describe("the audit log", () => {
  it("shows what a restore did in words, to the managers", async () => {
    await seed();
    await drainDeletionLog(logConfig());
    await takeBackup();
    const { database } = await drill({ mode: "restore" });
    await asRestored(database!, async ({ state, database: restored }) => {
      // Opened: the manager reads the audit log of the restored system.
      const log = (await state.readState(manager)).audit as {
        action: string;
        label: string;
      }[];
      expect(
        log.find((entry) => entry.action === "restore.complete")?.label
      ).toBe("שחזור מגיבוי הושלם");
      expect(
        (
          await restored.db
            .select()
            .from(user)
            .where(eq(user.role, "technical"))
        ).length
      ).toBe(1);
    });
  });
});
