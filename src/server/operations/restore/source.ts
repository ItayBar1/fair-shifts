import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { sql } from "drizzle-orm";
import { type Database } from "../../db";
import { backupRun } from "../../auth-schema";
import type { BackupStorage } from "../backup-storage";
import { parseBackupStamp, type RestoreSource } from "../../../domain/restore";
import { RestoreFailure } from "./failures";

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
export async function backupMigrations(database: Database) {
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
