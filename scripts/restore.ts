import { sql } from "drizzle-orm";
import { db, pool } from "../src/server/db";
import { backupRun } from "../src/server/auth-schema";
import { backupConfig, beforeDeploy } from "../src/server/operations/backup";
import { deletionLogConfig } from "../src/server/operations/deletion-log";
import {
  RestoreFailure,
  databaseName,
  locateBackup,
  promoteRestore,
  runRestore,
  scratchName,
  type SourceInput,
} from "../src/server/operations/restore";
import { parseBackupStamp, reportLines } from "../src/domain/restore";

// Output is English: it is read on the server (decision 187). Nothing sensitive
// is printed: counts, internal ids, file names and reason codes only.
const usage = `Usage: pnpm restore <command> [options]

  list                  list the encrypted backups in the storage, newest first
  fetch                 write one encrypted backup to the standard output, to take it to
                        your own computer: restore fetch --backup <name> > backup.dump.age
  drill                 restore a backup into a scratch database, apply the deletion
                        log, run every check, print the report and drop the copy.
                        The live database is not touched.
  restore               the same into <database>_restore, which is kept. If it passes,
                        it can replace the live database (promote).
  promote               rename the live database aside and the restored copy into its place.
                        Stop the site and the worker first.

Choose the backup (default: the newest verified one in the storage):
  --backup <name>       a backup file name from "list"
  --file <path>         an encrypted .dump.age taken from the storage by hand
  --dump <path>         a dump already decrypted with age on your own computer; "-" reads
                        it from the standard input, so neither the key nor the plaintext
                        ever touches the server:
                        age -d -i key.txt backup.dump.age | ssh server '... restore drill --dump -'
  --point <time>        when that dump was taken (an ISO time or a backup file name), for
                        the notice to the managers
  --identity <path>     the age identity (private key) file, for encrypted backups;
                        or RESTORE_IDENTITY_FILE. It is never stored on the server.
Other:
  --keep                keep the scratch database of a drill
  --promote             after a passing restore, promote it at once
  --database <name>     promote: the restored database (default <database>_restore)`;

function parse(args: string[]) {
  const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (["keep", "promote"].includes(key)) options.set(key, true);
    else {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`--${key} needs a value`);
      options.set(key, value);
    }
  }
  return options;
}

function pointOf(value: string | undefined) {
  if (!value) return undefined;
  const found = parseBackupStamp(value) ?? new Date(value);
  if (Number.isNaN(found.getTime()))
    throw new Error("--point is not a time or a backup file name");
  return found;
}

const [command, ...rest] = process.argv.slice(2);
let code = 0;
try {
  if (process.env.SERVICE_ROLE && process.env.SERVICE_ROLE !== "operations")
    throw new Error("Restore requires the separate operations service");
  if (process.env.SERVICE_ROLE === "operations") {
    const { checkDatabaseRole } =
      await import("../src/server/operations/database-permissions");
    const errors = await checkDatabaseRole("operations");
    if (errors.length) throw new Error(errors.join("; "));
  }
  const options = parse(rest);
  const liveUrl = process.env.DATABASE_URL;
  const text = (key: string) => {
    const value = options.get(key);
    return typeof value === "string" ? value : undefined;
  };
  if (
    !["list", "fetch", "drill", "restore", "promote"].includes(command ?? "")
  ) {
    console.error(usage);
    code = 2;
  } else if (!liveUrl) {
    console.error("DATABASE_URL is not set");
    code = 2;
  } else if (command === "promote") {
    // The operations permission check opened the live pool. Promotion requires
    // no connections to either database, including this CLI's own connection.
    await pool.end();
    const result = await promoteRestore({
      liveUrl,
      restored: text("database"),
      log: (line) => console.log(line),
    });
    console.log(`Promoted (${result.outcome}). Start the site and the worker.`);
    if (result.outcome === "needs_deletion_log")
      console.log(
        "The deletion log could not be verified, so access and mail stay closed. Fix the log and run: pnpm deletion-log apply   (or, after checking by hand: pnpm deletion-log acknowledge)"
      );
    if (result.kept)
      console.log(
        `The previous database is kept as ${result.kept}. Drop it when it is no longer needed.`
      );
  } else {
    const config = backupConfig();
    // The live database is reachable on a running server; after a loss it may not be.
    const live = await db.execute(sql`select 1`).then(
      () => db,
      () => undefined
    );
    if (command === "fetch") {
      if (!config.storage) throw new RestoreFailure("source_missing");
      const located = await locateBackup(
        { kind: "storage", storage: config.storage, name: text("backup") },
        live
      );
      // Only the bytes go to the standard output; the name goes to the error output.
      console.error(
        `Writing ${located.source.name} (${located.source.sizeBytes} bytes)`
      );
      await new Promise<void>((done) =>
        process.stdout.write(located.bytes, () => done())
      );
    } else if (command === "list") {
      if (!config.storage) throw new RestoreFailure("source_missing");
      const runs = live
        ? await live
            .select()
            .from(backupRun)
            .catch(() => [])
        : [];
      for (const file of await config.storage.listBackups()) {
        const run = runs.find((row) => row.storageId === file.id);
        console.log(
          `${file.name}  ${file.size} bytes  ${file.createdAt.toISOString()}${run && beforeDeploy(run) ? "  before-update" : ""}${run && run.status !== "verified" ? `  (${run.status})` : ""}`
        );
      }
    } else {
      let source: SourceInput;
      if (text("file")) source = { kind: "file", path: text("file")! };
      else if (text("dump"))
        source = {
          kind: "dump",
          path: text("dump")!,
          point: pointOf(text("point")),
        };
      else if (config.storage)
        source = {
          kind: "storage",
          storage: config.storage,
          name: text("backup"),
        };
      else
        throw new Error(
          "No backup storage is configured: pass --file or --dump"
        );
      const mode = command as "drill" | "restore";
      const result = await runRestore({
        mode,
        source,
        identity: text("identity") ?? process.env.RESTORE_IDENTITY_FILE,
        liveUrl,
        live,
        deletionLog: deletionLogConfig(),
        keep: options.has("keep"),
        log: (line) => console.log(line),
      });
      console.log("");
      for (const line of reportLines(result.report)) console.log(line);
      console.log("");
      const name = result.database ?? scratchName(liveUrl, mode);
      if (mode === "drill") {
        if (!live)
          console.log(
            "The live database is unreachable: this drill was not recorded."
          );
        else console.log("The result is recorded for the drill status.");
        if (result.database)
          console.log(
            `The scratch database ${name} was kept. Drop it when done.`
          );
      } else if (result.report.outcome === "failed") {
        console.log(
          `The copy ${name} failed its checks and was kept for inspection. The live database was not touched. Drop it when done, or pick another backup with --backup.`
        );
      } else if (options.has("promote")) {
        // This process holds a connection to the live database; the swap needs none.
        await pool.end();
        const promoted = await promoteRestore({
          liveUrl,
          restored: name,
          log: (line) => console.log(line),
        });
        console.log(
          `Promoted. Start the site and the worker. ${promoted.kept ? `The previous database is kept as ${promoted.kept}.` : ""}`
        );
        if (result.report.outcome === "needs_deletion_log")
          console.log(
            "The deletion log could not be verified, so access and mail stay closed. Fix the log and run: pnpm deletion-log apply   (or, after checking by hand: pnpm deletion-log acknowledge)"
          );
      } else
        console.log(
          `Passed. Live database ${databaseName(liveUrl)} is untouched. Stop the site and the worker, then run: pnpm restore promote`
        );
      code = result.report.outcome === "passed" ? 0 : 1;
    }
  }
} catch (error) {
  console.error(
    error instanceof RestoreFailure || error instanceof Error
      ? error.message
      : "Failed"
  );
  code = 1;
} finally {
  await pool.end().catch(() => {});
}
process.exit(code);
