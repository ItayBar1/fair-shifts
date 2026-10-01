import { createHash } from "node:crypto";

/**
 * The independent deletion log (decision 196). One line per deleted soldier:
 * an internal id, the time and a hash that chains the line to the one before.
 * It holds no name, personal number, contact detail or reason, so keeping it
 * outside the database and its backups keeps no sensitive data. After a backup
 * is restored, the log says which deletions to apply again.
 *
 * The rules here are pure; the server module reads and writes the files.
 */
export const LOG_VERSION = 1;
export const GENESIS_HASH = "0".repeat(64);

export type LogEntry = {
  v: typeof LOG_VERSION;
  /** 1, 2, 3… with no gap. */
  seq: number;
  /** The deletion event; a repeated append of the same event adds nothing. */
  id: string;
  soldierId: string;
  /** When the deletion was committed, as an ISO instant. */
  at: string;
  /** The hash of the previous line, or GENESIS_HASH for the first. */
  prev: string;
  hash: string;
};

export type LogProblemCode =
  /** A line that is not a complete, well-formed entry, or a torn last line. */
  "malformed" | "sequence" | "link" | "hash" | "duplicate";
export type LogProblem = { code: LogProblemCode; line: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

export function entryHash(entry: Omit<LogEntry, "hash">) {
  return createHash("sha256")
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
}

/** The entry that follows `last` (or starts the log). */
export function nextEntry(
  last: LogEntry | undefined,
  input: { id: string; soldierId: string; at: string }
): LogEntry {
  const body = {
    v: LOG_VERSION,
    seq: (last?.seq ?? 0) + 1,
    id: input.id,
    soldierId: input.soldierId,
    at: input.at,
    prev: last?.hash ?? GENESIS_HASH,
  } as const;
  return { ...body, hash: entryHash(body) };
}

/** One line with a fixed key order, ended by a newline. */
export function serializeEntry(entry: LogEntry) {
  return `${JSON.stringify({
    v: entry.v,
    seq: entry.seq,
    id: entry.id,
    soldierId: entry.soldierId,
    at: entry.at,
    prev: entry.prev,
    hash: entry.hash,
  })}\n`;
}

function shaped(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort().join(",");
  return (
    keys === "at,hash,id,prev,seq,soldierId,v" &&
    entry.v === LOG_VERSION &&
    Number.isSafeInteger(entry.seq) &&
    typeof entry.id === "string" &&
    UUID.test(entry.id) &&
    typeof entry.soldierId === "string" &&
    UUID.test(entry.soldierId) &&
    typeof entry.at === "string" &&
    !Number.isNaN(Date.parse(entry.at)) &&
    typeof entry.prev === "string" &&
    HASH.test(entry.prev) &&
    typeof entry.hash === "string" &&
    HASH.test(entry.hash)
  );
}

/**
 * Reads a log. `entries` is the longest prefix that is intact; the first line
 * that breaks the chain stops the reading, and everything after it is
 * untrusted. A last line without its newline is a torn write.
 */
export function parseLog(text: string): {
  entries: LogEntry[];
  problems: LogProblem[];
} {
  const entries: LogEntry[] = [];
  const problems: LogProblem[] = [];
  if (!text) return { entries, problems };
  const lines = text.split("\n");
  const torn = lines.pop() !== "";
  const seen = new Set<string>();
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      problems.push({ code: "malformed", line });
      return { entries, problems };
    }
    if (!shaped(value)) {
      problems.push({ code: "malformed", line });
      return { entries, problems };
    }
    const previous = entries.at(-1);
    if (value.seq !== line) {
      problems.push({ code: "sequence", line });
      return { entries, problems };
    }
    if (value.prev !== (previous?.hash ?? GENESIS_HASH)) {
      problems.push({ code: "link", line });
      return { entries, problems };
    }
    const { hash, ...body } = value;
    if (entryHash(body) !== hash) {
      problems.push({ code: "hash", line });
      return { entries, problems };
    }
    if (seen.has(value.id)) {
      problems.push({ code: "duplicate", line });
      return { entries, problems };
    }
    seen.add(value.id);
    entries.push(value);
  }
  if (torn) problems.push({ code: "malformed", line: lines.length + 1 });
  return { entries, problems };
}

/**
 * How two intact logs relate: one holds the other as its beginning, or they
 * tell different histories. A copy that is merely behind is not a conflict;
 * the longer one is the log.
 */
export function compareLogs(
  first: readonly LogEntry[],
  second: readonly LogEntry[]
): "same" | "first_ahead" | "second_ahead" | "diverged" {
  const shared = Math.min(first.length, second.length);
  if (shared > 0 && first[shared - 1]!.hash !== second[shared - 1]!.hash)
    return "diverged";
  if (first.length === second.length) return "same";
  return first.length > second.length ? "first_ahead" : "second_ahead";
}
