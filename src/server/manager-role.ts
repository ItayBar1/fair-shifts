import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { assignments, balances, records } from "./schema";
import { user } from "./auth-schema";
import {
  audit,
  createRecord,
  currentVersion,
  findRecord,
  manager,
  technical,
  updateRecord,
  type Actor,
} from "./repository";
import { setRole } from "./auth/accounts";
import { reassessAssignments } from "./personnel";
import { invariant } from "./errors";
import { id, text } from "./validation";

/**
 * A duty manager is never assigned to a duty (decision 192). Granting or removing
 * the role changes what the soldier's existing reservations mean, so the marks
 * and the follow-up items are written in the same transaction as the role.
 */
export async function changeRole(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  // Permission first, so a refused caller learns nothing about the account.
  technical(actor);
  const input = z
    .object({ id: z.string(), role: z.enum(["soldier", "manager"]) })
    .parse(payload);
  const [target] = await tx
    .select()
    .from(user)
    .where(eq(user.id, input.id))
    .for("update");
  invariant(target, "not_found", "חשבון לא נמצא", 404);
  currentVersion(target.securityEpoch, expectedVersion);
  await setRole(actor, input.id, input.role, tx);
  if (target.role !== input.role && target.soldierId)
    await afterRoleChange(tx, actor, {
      soldierId: target.soldierId,
      name: target.name,
      to: input.role,
    });
  return { success: true };
}

function pendingReturns(tx: DbTransaction, soldierId: string) {
  return tx
    .select()
    .from(records)
    .where(
      and(eq(records.kind, "manager_return"), eq(records.subjectId, soldierId))
    )
    .then((rows) => rows.filter((row) => row.data.status === "pending"));
}

async function afterRoleChange(
  tx: DbTransaction,
  actor: Actor,
  change: { soldierId: string; name: string; to: "soldier" | "manager" }
) {
  // The marks follow the role in both directions: a reservation flagged for a
  // manager is cleared when the person is a soldier again.
  await reassessAssignments(tx, change.soldierId);
  const now = new Date().toISOString();
  const open = await pendingReturns(tx, change.soldierId);
  if (change.to === "manager") {
    for (const row of open)
      await updateRecord(tx, row, {
        ...row.data,
        status: "closed",
        outcome: "reappointed",
        closedAt: now,
        closedBy: actor.id,
      });
    const flagged = (
      await tx
        .select()
        .from(assignments)
        .where(eq(assignments.soldierId, change.soldierId))
    ).filter(
      (row) =>
        row.status === "reserved" &&
        (row.data.needsAttention ?? []).includes("manager")
    ).length;
    if (flagged) await notifyManagers(tx, change.name, flagged);
    return;
  }
  if (open.length) return;
  const [balance] = await tx
    .select()
    .from(balances)
    .where(eq(balances.soldierId, change.soldierId));
  await createRecord(
    tx,
    "manager_return",
    {
      soldierId: change.soldierId,
      status: "pending",
      openedAt: now,
      openedBy: actor.id,
      // The balance stood still while the person was a manager.
      balanceAtReturn: balance?.current ?? 0,
    },
    change.soldierId
  );
}

async function notifyManagers(tx: DbTransaction, name: string, count: number) {
  const recipients = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.role, "manager"), isNull(user.deletedAt)));
  const title = "חייל מונה לאחראי תורנויות";
  const body =
    `${name} מונה לאחראי תורנויות ואינו משובץ עוד לתורנויות. ` +
    `${count === 1 ? "שיבוץ אחד שלו מסומן" : `${count} שיבוצים שלו מסומנים`} לטיפול. ` +
    "עד שאחראי יחליף אותם השיבוץ המקורי בתוקף.";
  for (const recipient of recipients)
    await createRecord(tx, "notification", {
      accountId: recipient.id,
      title,
      body,
      href: "/manage",
    });
}

/**
 * Any balance operation applied to a returned manager is the decision about the
 * balance, so it closes that soldier's pending item, once.
 */
export async function closeReturnsAfterScore(
  tx: DbTransaction,
  actor: Actor,
  changes: { soldierId: string; before: number; after: number }[],
  previewId: string
) {
  for (const change of changes)
    for (const row of await pendingReturns(tx, change.soldierId))
      await updateRecord(tx, row, {
        ...row.data,
        status: "closed",
        outcome: "adjusted",
        closedAt: new Date().toISOString(),
        closedBy: actor.id,
        closedByName: actor.name,
        balanceBefore: change.before,
        balanceAfter: change.after,
        previewId,
      });
}

/** The manager's explicit decision to leave the balance of a returned manager as it is. */
export async function keepReturnedBalance(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z.object({ id, reason: text }).parse(payload);
  const row = await findRecord(tx, "manager_return", input.id);
  invariant(
    row.data.status === "pending",
    "already_decided",
    `הפריט כבר נסגר בידי ${String(row.data.closedByName ?? "אחראי אחר")}`,
    409
  );
  currentVersion(row.version, expectedVersion);
  const closed = await updateRecord(tx, row, {
    ...row.data,
    status: "closed",
    outcome: "kept",
    reason: input.reason,
    closedAt: new Date().toISOString(),
    closedBy: actor.id,
    closedByName: actor.name,
  });
  await audit(
    tx,
    actor,
    "manager.return.keep",
    row.id,
    { recordId: row.id },
    row.subjectId ?? undefined
  );
  return { id: closed.id, version: closed.version };
}
