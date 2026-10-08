// Only the operations converter reads the unsigned v1 format.
import { createHash } from "node:crypto";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { isNotNull, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { records, soldiers } from "../schema";
import {
  GENESIS_HASH,
  nextEntry,
  parseLog,
  serializeEntry,
  type LogEntry,
} from "../../domain/deletion-log";
import {
  DELETION_LOG_FILE,
  DELETION_LOG_KIND,
  DELETION_LOG_LOCK,
  logPath,
  readState,
  mergeState,
  type DeletionLogConfig,
} from "./deletion-log";
import { logSigner, matchingLogKeys } from "./deletion-log-keys";

type LegacyEntry = {
  v: 1;
  seq: number;
  id: string;
  soldierId: string;
  at: string;
  prev: string;
  hash: string;
};
export function parseLegacyLogForConversion(text: string): LegacyEntry[] {
  if (!text) return [];
  if (!text.endsWith("\n"))
    throw new Error("Legacy deletion log has a torn line");
  const entries: LegacyEntry[] = [],
    seen = new Set<string>();
  for (const line of text.slice(0, -1).split("\n")) {
    const entry = JSON.parse(line) as LegacyEntry;
    if (
      !entry ||
      Object.keys(entry).sort().join(",") !==
        "at,hash,id,prev,seq,soldierId,v" ||
      entry.v !== 1 ||
      entry.seq !== entries.length + 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        entry.id
      ) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        entry.soldierId
      ) ||
      typeof entry.at !== "string" ||
      Number.isNaN(Date.parse(entry.at)) ||
      seen.has(entry.id) ||
      entry.prev !== (entries.at(-1)?.hash ?? GENESIS_HASH)
    )
      throw new Error("Legacy deletion log is invalid");
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          entry.v,
          entry.seq,
          entry.id,
          entry.soldierId,
          entry.at,
          entry.prev,
        ])
      )
      .digest("hex");
    if (hash !== entry.hash)
      throw new Error("Legacy deletion log hash is invalid");
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}
export async function convertDeletionLog(config: DeletionLogConfig) {
  const signer = config.signer ?? logSigner();
  if (
    !config.directory ||
    !config.storage ||
    !signer ||
    !matchingLogKeys(signer, config.publicKeys ?? {})
  )
    throw new Error("Conversion needs both copies and matching signing keys");
  const directory = config.directory,
    storage = config.storage;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${DELETION_LOG_LOCK})`);
    const local = await readFile(logPath(directory), "utf8");
    const remote = await storage.findKind(DELETION_LOG_KIND);
    if (!remote.length)
      throw new Error("Both copies must exist before legacy conversion");
    for (const file of remote) {
      const bytes = await storage.read(file.id);
      if (!bytes || bytes.toString("utf8") !== local)
        throw new Error("Legacy deletion log copies differ");
    }
    const legacy = parseLegacyLogForConversion(local);
    const state = await readState(tx);
    if (
      (state.headSeq ?? 0) !== legacy.length ||
      (legacy.length && state.headHash !== legacy.at(-1)?.hash)
    )
      throw new Error("Legacy deletion log disagrees with the database head");
    const logged = new Set(legacy.map((entry) => entry.soldierId));
    const pending = new Set(
      (
        await tx
          .select()
          .from(records)
          .where(eq(records.kind, "deletion_log_entry"))
      )
        .filter((row) => row.data.status === "pending")
        .map((row) => row.subjectId)
    );
    for (const row of await tx
      .select()
      .from(soldiers)
      .where(isNotNull(soldiers.deletedAt)))
      if (!logged.has(row.id) && !pending.has(row.id))
        throw new Error("An existing deletion is absent from the legacy log");
    const signed: LogEntry[] = [];
    for (const entry of legacy)
      signed.push(nextEntry(signed.at(-1), entry, signer));
    const content = signed.map(serializeEntry).join("");
    if (parseLog(content, config.publicKeys).problems.length)
      throw new Error("Converted signatures did not verify");
    const temporary = `${logPath(directory)}.v2-conversion`;
    await writeFile(temporary, content, {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    try {
      const hash = createHash("sha256").update(content).digest("hex");
      const uploaded = await storage.upload({
        path: temporary,
        name: DELETION_LOG_FILE,
        runId: `signed-conversion-${hash}`,
        size: Buffer.byteLength(content),
        kind: DELETION_LOG_KIND,
      });
      const confirmed = await storage.read(uploaded.id);
      if (
        !confirmed ||
        confirmed.toString("utf8") !== content ||
        uploaded.sha256 !== hash
      )
        throw new Error("Converted remote log failed verification");
      // A crash between copies fails closed. Restore both verified old copies
      // before retrying; site and worker stay stopped throughout conversion.
      await rename(temporary, logPath(directory));
      for (const old of remote) await storage.remove(old.id);
      await mergeState(tx, {
        headSeq: signed.length,
        headHash: signed.at(-1)?.hash ?? null,
        remoteSeq: signed.length,
        signedConversionAt: new Date().toISOString(),
      });
      return signed.length;
    } finally {
      await rm(temporary, { force: true });
    }
  });
}
