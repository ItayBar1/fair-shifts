import { eq } from "drizzle-orm";
import type { db, DbTransaction } from "../db";
import { operationsState } from "../auth-schema";

/**
 * The gate that keeps access and mail closed while a restored system is not yet
 * trusted (decision 196). One `operations_state` row, `restore`, carries it.
 * Everything that must stay closed reads `blocked` (the request check, the mail
 * delivery, the worker, the backup); the checks of a restore add a named
 * blocker and clear it when they pass, so the gate opens only when every check
 * has. Messages are English: they are read on the server (decision 187).
 */
export const RESTORE_KEY = "restore";
export const DELETION_LOG_BLOCKER = "deletion_log";

type Executor = typeof db | DbTransaction;
export type RestoreGate = {
  blocked: boolean;
  blockers: string[];
  /** A block set by hand, as before blockers existed; only a person clears it. */
  manual: boolean;
  details: Record<string, unknown>;
};

function readGate(data: Record<string, unknown> | undefined): RestoreGate {
  const blockers = Array.isArray(data?.blockers)
    ? data.blockers.filter((item): item is string => typeof item === "string")
    : [];
  // A row without a list of blockers is the older, manual form.
  const manual =
    data?.blockers === undefined
      ? data?.blocked === true
      : data?.manual === true;
  const details =
    data?.details && typeof data.details === "object"
      ? (data.details as Record<string, unknown>)
      : {};
  return { blocked: blockers.length > 0 || manual, blockers, manual, details };
}

export async function readRestoreGate(tx: Executor): Promise<RestoreGate> {
  const [row] = await tx
    .select()
    .from(operationsState)
    .where(eq(operationsState.key, RESTORE_KEY));
  return readGate(row?.data);
}

async function writeGate(tx: Executor, gate: Omit<RestoreGate, "blocked">) {
  const data = { ...gate, blocked: gate.blockers.length > 0 || gate.manual };
  await tx
    .insert(operationsState)
    .values({ key: RESTORE_KEY, data, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: operationsState.key,
      set: { data, updatedAt: new Date() },
    });
  return data;
}

/** Closes the gate on behalf of one check, with details for the operator. */
export async function raiseRestoreBlocker(
  tx: Executor,
  name: string,
  detail?: Record<string, unknown>
) {
  const gate = await readRestoreGate(tx);
  return writeGate(tx, {
    manual: gate.manual,
    blockers: gate.blockers.includes(name)
      ? gate.blockers
      : [...gate.blockers, name],
    details: { ...gate.details, ...(detail && { [name]: detail }) },
  });
}

/** Lifts one check's block; the gate stays closed while any other holds it. */
export async function clearRestoreBlocker(
  tx: Executor,
  name: string,
  detail?: Record<string, unknown>
) {
  const gate = await readRestoreGate(tx);
  return writeGate(tx, {
    manual: gate.manual,
    blockers: gate.blockers.filter((item) => item !== name),
    details: { ...gate.details, ...(detail && { [name]: detail }) },
  });
}
