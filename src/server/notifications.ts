import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { records } from "./schema";
import { user } from "./auth-schema";
import {
  audit,
  createRecord,
  currentVersion,
  findRecord,
  manager,
  updateRecord,
  type Actor,
  type Workflow,
} from "./repository";
import { invariant } from "./errors";
import { id } from "./validation";
import {
  preferencesSchema,
  resolvePreferences,
} from "../domain/notification-preferences";

async function personalRecord(tx: DbTransaction, accountId: string) {
  const [row] = await tx
    .select()
    .from(records)
    .where(
      and(
        eq(records.kind, "settings"),
        sql`${records.data}->>'accountId' = ${accountId}`
      )
    );
  return row as Workflow | undefined;
}
async function defaultsRecord(tx: DbTransaction) {
  const [row] = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "notification_defaults"));
  return row as Workflow | undefined;
}

function latest(...dates: (Date | undefined)[]) {
  const times = dates.flatMap((date) => (date ? [date.getTime()] : []));
  return times.length ? new Date(Math.max(...times)) : undefined;
}
export async function effectivePreferences(
  tx: DbTransaction,
  accountId: string
) {
  const [personal, unit] = await Promise.all([
    personalRecord(tx, accountId),
    defaultsRecord(tx),
  ]);
  const resolved = resolvePreferences(personal?.data, unit?.data);
  return {
    ...resolved,
    version: personal?.version,
    defaultsVersion: unit?.version,
    // When the preferences in effect were last saved or reset to the defaults.
    changedAt: latest(
      personal?.updatedAt,
      resolved.source === "unit" ? unit?.updatedAt : undefined
    ),
  };
}

/** Each account edits only its own preferences; the payload cannot name another account. */
export async function savePreferences(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const input = preferencesSchema.parse(payload);
  const existing = await personalRecord(tx, actor.id);
  const data = { accountId: actor.id, custom: true, ...input };
  if (existing) {
    currentVersion(existing.version, expectedVersion);
    const row = await updateRecord(tx, existing, data);
    return { id: row.id, version: row.version };
  }
  invariant(
    expectedVersion === undefined,
    "stale_version",
    "המידע השתנה. יש לרענן ולבדוק את השינוי לפני שמירה",
    409
  );
  const row = await createRecord(tx, "settings", data, actor.soldierId);
  return { id: row.id, version: row.version };
}

/** Return to the unit defaults; later default changes apply again. */
export async function resetPreferences(
  tx: DbTransaction,
  actor: Actor,
  expectedVersion?: number
) {
  const existing = await personalRecord(tx, actor.id);
  invariant(existing, "not_found", "לא נשמרו העדפות אישיות", 404);
  currentVersion(existing.version, expectedVersion);
  if (existing.data.custom !== true)
    return { id: existing.id, version: existing.version };
  const row = await updateRecord(tx, existing, {
    accountId: actor.id,
    custom: false,
  });
  return { id: row.id, version: row.version };
}

export async function saveDefaults(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = preferencesSchema.parse(payload);
  const existing = await defaultsRecord(tx);
  let row: Workflow;
  if (existing) {
    currentVersion(existing.version, expectedVersion);
    row = await updateRecord(tx, existing, input);
  } else {
    invariant(
      expectedVersion === undefined,
      "stale_version",
      "המידע השתנה. יש לרענן ולבדוק את השינוי לפני שמירה",
      409
    );
    row = await createRecord(tx, "notification_defaults", input);
  }
  await audit(tx, actor, "notification.defaults.save", row.id, {
    // Stored forms of the older shape are shown in the current one.
    before: existing
      ? resolvePreferences(null, existing.data).preferences
      : null,
    after: input,
  });
  return { id: row.id, version: row.version };
}

/** The recipient is the addressed account, or the subject's own account when none is named. */
export async function isRecipient(
  tx: DbTransaction,
  actor: Actor,
  row: Pick<Workflow, "data" | "subjectId">
) {
  if (typeof row.data.accountId === "string")
    return row.data.accountId === actor.id;
  if (!row.subjectId) return false;
  const [owner] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.soldierId, row.subjectId));
  return owner?.id === actor.id;
}

/**
 * Reading and hiding are personal inbox states, not business decisions: they never
 * touch the related request, assignment or other recipients' copies, and repeating
 * them keeps the first time.
 */
export async function markNotification(
  tx: DbTransaction,
  actor: Actor,
  payload: Record<string, unknown>,
  mark: "readAt" | "hiddenAt"
) {
  const input = z.object({ id }).parse(payload);
  const row = await findRecord(tx, "notification", input.id);
  invariant(
    await isRecipient(tx, actor, row),
    "forbidden",
    "אין הרשאה להודעה",
    403
  );
  if (row.data[mark]) return { id: row.id, version: row.version };
  const updated = await updateRecord(tx, row, {
    ...row.data,
    [mark]: new Date().toISOString(),
  });
  return { id: updated.id, version: updated.version };
}
