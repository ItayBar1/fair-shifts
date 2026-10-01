import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { DbTransaction } from "./db";
import { records, soldiers, balances, duties, assignments } from "./schema";
import { user } from "./auth-schema";
import { AppError, invariant } from "./errors";
import type { Constraint } from "../domain/types";
import type { Actor } from "./auth/accounts";
export type { Actor } from "./auth/accounts";

export type Workflow = typeof records.$inferSelect;
export function manager(actor: Actor) {
  invariant(
    actor.role === "manager",
    "forbidden",
    "הפעולה זמינה לאחראי תורנויות בלבד",
    403
  );
}
export function technical(actor: Actor) {
  invariant(
    actor.role === "technical",
    "forbidden",
    "הפעולה זמינה למנהל הטכני בלבד",
    403
  );
}
export function currentVersion(actual: number, expected?: number) {
  invariant(
    expected !== undefined && actual === expected,
    "stale_version",
    "המידע השתנה. יש לרענן ולבדוק את השינוי לפני שמירה",
    409
  );
}
export async function findRecord(tx: DbTransaction, kind: string, id: string) {
  const [record] = await tx
    .select()
    .from(records)
    .where(and(eq(records.id, id), eq(records.kind, kind)));
  invariant(record, "not_found", "הרשומה לא נמצאה", 404);
  return record;
}
export async function createRecord(
  tx: DbTransaction,
  kind: string,
  data: Record<string, unknown>,
  subjectId?: string
) {
  const [record] = await tx
    .insert(records)
    .values({ id: randomUUID(), kind, data, subjectId })
    .returning();
  return record;
}
export async function updateRecord(
  tx: DbTransaction,
  record: Workflow,
  data: Record<string, unknown>
) {
  const [result] = await tx
    .update(records)
    .set({ data, version: record.version + 1, updatedAt: new Date() })
    .where(and(eq(records.id, record.id), eq(records.version, record.version)))
    .returning();
  if (!result)
    throw new AppError("stale_version", "המידע השתנה בזמן השמירה", 409);
  return result;
}
/**
 * Records an audit envelope: who, what and references only. It outlives an
 * account erasure, so personal text never goes in `data`. Such text is either
 * already in a business record the envelope points to (`recordId`), or passed
 * as `detail`, which is stored as an `audit_detail` record of the soldier and
 * is erased with the soldier's other sensitive records.
 */
export async function audit(
  tx: DbTransaction,
  actor: Actor,
  action: string,
  targetId: string,
  data: Record<string, unknown> = {},
  subjectId?: string,
  detail?: Record<string, unknown>
) {
  invariant(
    !detail || subjectId,
    "audit_detail_subject",
    "פירוט רגיש ביומן חייב להיות משויך לחייל"
  );
  const stored = detail
    ? await createRecord(tx, "audit_detail", detail, subjectId)
    : undefined;
  return createRecord(
    tx,
    "audit",
    {
      actorId: actor.id,
      actorName: actor.name,
      action,
      targetId,
      ...data,
      ...(stored && { detailId: stored.id }),
    },
    subjectId
  );
}
export async function loadDomain(tx: DbTransaction) {
  const people = await tx.select().from(soldiers);
  const scoreRows = await tx.select().from(balances);
  const dutyRows = await tx.select().from(duties);
  const assignmentRows = await tx.select().from(assignments);
  const constraintRows = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "constraint"));
  const scores = new Map(scoreRows.map((row) => [row.soldierId, row.current]));
  // The role at this moment decides: a duty manager is never assigned (decision 192).
  const managers = new Set(
    (
      await tx
        .select({ soldierId: user.soldierId })
        .from(user)
        .where(and(eq(user.role, "manager"), isNull(user.deletedAt)))
    ).map((row) => row.soldierId)
  );
  return {
    soldiers: people.map((row) => ({
      ...row.data,
      id: row.id,
      name: row.name,
      personalNumber: row.personalNumber,
      version: row.version,
      currentScore: scores.get(row.id) ?? 0,
      deletedAt: row.deletedAt?.toISOString(),
      // Set from the account alone, so a stale stored value never counts.
      isManager: managers.has(row.id) || undefined,
      constraints: constraintRows
        .filter((c) => c.subjectId === row.id)
        .flatMap((c) => {
          const active = c.data.approved as Record<string, unknown> | undefined;
          const pending = c.data.pending as Record<string, unknown> | undefined;
          const result: Constraint[] = [];
          for (const [status, value] of [
            ["approved", active],
            ["pending", pending],
          ] as const) {
            if (
              value &&
              typeof value.start === "string" &&
              typeof value.end === "string"
            )
              result.push({
                start: value.start,
                end: value.end,
                id: c.id,
                version: Number(value.version ?? c.version),
                status,
              });
          }
          return result;
        }),
    })),
    duties: dutyRows.map((row) => ({
      ...row.data,
      id: row.id,
      version: row.version,
    })),
    assignments: assignmentRows.map((row) => ({
      ...row.data,
      id: row.id,
      version: row.version,
      points: row.points,
      status: row.status as typeof row.data.status,
    })),
  };
}
