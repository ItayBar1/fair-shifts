import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, unitTransaction, type DbTransaction } from "../db";
import {
  user,
  session,
  account,
  loginCode,
  recoveryCode,
  emailOutbox,
  operationsState,
} from "../auth-schema";
import { soldiers, records, soldierContacts } from "../schema";
import { invariant } from "../errors";
import { closeWindowsOf } from "../assignment-mail-delivery";
import { purgeCalendarLink, type CalendarCleanup } from "../calendar/link";
import { canAccessAfterService } from "../../domain/eligibility";
import {
  digestCode,
  newRecoveryCode,
  normalizeEmail,
  type Role,
} from "./policy";
export type Actor = {
  id: string;
  name: string;
  role: Role;
  soldierId?: string;
  securityEpoch: number;
};
export type InvitedAccount = {
  id?: string;
  name: string;
  email: string;
  soldierId?: string;
  role?: Role;
};
/**
 * Checked on every request and sign-in, so release takes effect at the local
 * boundary even when the worker is late. `now` is injectable for tests.
 */
export async function accountAvailable(
  row: typeof user.$inferSelect,
  tx: DbTransaction | typeof db = db,
  now = new Date()
) {
  if (row.lockedAt || row.deletedAt) return false;
  if (row.soldierId) {
    const [soldier] = await tx
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, row.soldierId));
    if (!soldier || soldier.deletedAt) return false;
    if (!canAccessAfterService(soldier.data, now.toISOString())) return false;
  }
  const [maintenance] = await tx
    .select()
    .from(operationsState)
    .where(eq(operationsState.key, "restore"));
  return (
    process.env.RESTORE_MODE !== "true" && maintenance?.data.blocked !== true
  );
}
export async function assertActorCurrent(actor: Actor, tx: DbTransaction) {
  const [row] = await tx
    .select()
    .from(user)
    .where(eq(user.id, actor.id))
    .for("update");
  invariant(
    row &&
      row.securityEpoch === actor.securityEpoch &&
      row.role === actor.role &&
      (await accountAvailable(row, tx)),
    "UNAUTHORIZED",
    "יש להתחבר מחדש",
    401
  );
  return row;
}
export async function createInvitedAccount(
  input: InvitedAccount,
  tx?: DbTransaction
) {
  const work = async (cx: DbTransaction) => {
    const role = input.role ?? "soldier";
    invariant(
      role === "technical" ? !input.soldierId : !!input.soldierId,
      "ACCOUNT_TYPE",
      "חשבון טכני נפרד מחייל"
    );
    if (input.soldierId) {
      const [person] = await cx
        .select()
        .from(soldiers)
        .where(eq(soldiers.id, input.soldierId));
      invariant(
        person && !person.deletedAt,
        "ACCOUNT_TYPE",
        "נדרשת רשומת חייל פעילה"
      );
    }
    const [created] = await cx
      .insert(user)
      .values({
        id: input.id ?? randomUUID(),
        name: input.name,
        email: normalizeEmail(input.email),
        role,
        soldierId: input.soldierId,
      })
      .returning();
    return created;
  };
  return tx ? work(tx) : db.transaction(work);
}
async function audit(
  tx: DbTransaction,
  actorId: string,
  targetId: string,
  action: string
) {
  await tx.insert(records).values({
    id: randomUUID(),
    kind: "audit",
    data: { actorId, targetId, action },
  });
}
export async function revokeAccess(tx: DbTransaction, targetId: string) {
  await tx.delete(session).where(eq(session.userId, targetId));
  await tx.delete(loginCode).where(eq(loginCode.userId, targetId));
  await tx
    .update(emailOutbox)
    .set({
      status: "cancelled",
      encryptedSecret: null,
      destination: null,
      body: "",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(emailOutbox.recipientAccountId, targetId),
        eq(emailOutbox.kind, "login-code")
      )
    );
}
export async function setRole(
  actor: Actor,
  targetId: string,
  role: "soldier" | "manager",
  tx?: DbTransaction
) {
  const work = async (cx: DbTransaction) => {
    await assertActorCurrent(actor, cx);
    invariant(
      actor.role === "technical",
      "FORBIDDEN",
      "רק מנהל טכני מנהל הרשאות אחראים",
      403
    );
    const [target] = await cx
      .select()
      .from(user)
      .where(eq(user.id, targetId))
      .for("update");
    invariant(
      target && target.soldierId && !target.deletedAt,
      "ACCOUNT_TYPE",
      "נדרש חשבון חייל פעיל"
    );
    await cx
      .update(user)
      .set({
        role,
        securityEpoch: target.securityEpoch + 1,
        updatedAt: new Date(),
      })
      .where(eq(user.id, targetId));
    await revokeAccess(cx, targetId);
    await audit(cx, actor.id, targetId, `role:${role}`);
  };
  return tx ? work(tx) : db.transaction(work);
}
// Default screen filter for a manager; never a permission boundary and never
// the manager's own scheduling population. Set by the technical account or by
// the manager for themselves; null means not set (all populations).
export async function setResponsibility(
  actor: Actor,
  targetId: string,
  responsibility: "mandatory" | "career" | null,
  expectedVersion: number | undefined,
  tx?: DbTransaction
) {
  const work = async (cx: DbTransaction) => {
    await assertActorCurrent(actor, cx);
    invariant(
      actor.role === "technical" ||
        (actor.role === "manager" && actor.id === targetId),
      "FORBIDDEN",
      "תחום אחריות קובעים המנהל הטכני או האחראי עצמו",
      403
    );
    const [target] = await cx
      .select()
      .from(user)
      .where(eq(user.id, targetId))
      .for("update");
    invariant(
      target && target.role === "manager" && !target.deletedAt,
      "ACCOUNT_TYPE",
      "תחום אחריות מוגדר רק לאחראי פעיל"
    );
    invariant(
      expectedVersion !== undefined &&
        target.responsibilityVersion === expectedVersion,
      "stale_version",
      "תחום האחריות השתנה. יש לרענן ולבדוק לפני שמירה",
      409
    );
    await cx
      .update(user)
      .set({
        responsibility,
        responsibilityVersion: target.responsibilityVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(user.id, targetId));
    await audit(
      cx,
      actor.id,
      targetId,
      `responsibility:${responsibility ?? "unset"}`
    );
  };
  return tx ? work(tx) : db.transaction(work);
}
export async function unlockAccount(
  actor: Actor,
  targetId: string,
  tx?: DbTransaction
) {
  const work = async (cx: DbTransaction) => {
    await assertActorCurrent(actor, cx);
    const [target] = await cx
      .select()
      .from(user)
      .where(eq(user.id, targetId))
      .for("update");
    invariant(target && !target.deletedAt, "NOT_FOUND", "חשבון לא נמצא", 404);
    invariant(
      target.role === "soldier"
        ? actor.role === "manager"
        : target.role === "manager" && actor.role === "technical",
      "FORBIDDEN",
      "אין הרשאה לשחרר חשבון זה",
      403
    );
    await cx
      .update(user)
      .set({
        lockedAt: null,
        failedAttempts: 0,
        nextCodeAllowedAt: null,
        securityEpoch: target.securityEpoch + 1,
        updatedAt: new Date(),
      })
      .where(eq(user.id, targetId));
    await revokeAccess(cx, targetId);
    await audit(cx, actor.id, targetId, "unlock");
  };
  return tx ? work(tx) : db.transaction(work);
}
export async function deleteAccountAuth(targetId: string, tx?: DbTransaction) {
  const work = async (cx: DbTransaction) => {
    const [target] = await cx
      .select()
      .from(user)
      .where(eq(user.id, targetId))
      .for("update");
    if (!target) return;
    await purgeCalendarLink(cx, targetId, { collect: false });
    await revokeAccess(cx, targetId);
    await cx.delete(account).where(eq(account.userId, targetId));
    await cx.delete(recoveryCode).where(eq(recoveryCode.userId, targetId));
    await cx
      .update(user)
      .set({
        email: `deleted-${target.id}@invalid.local`,
        image: null,
        deletedAt: new Date(),
        securityEpoch: target.securityEpoch + 1,
        googleLinkGeneration: target.googleLinkGeneration + 1,
        updatedAt: new Date(),
      })
      .where(eq(user.id, targetId));
    await cx
      .update(emailOutbox)
      .set({
        status: "cancelled",
        body: "",
        title: "",
        href: null,
        destination: null,
        encryptedSecret: null,
      })
      .where(eq(emailOutbox.recipientAccountId, targetId));
    await closeWindowsOf(cx, targetId);
  };
  return tx ? work(tx) : db.transaction(work);
}
export async function issueRecoveryCodes(targetId: string, tx: DbTransaction) {
  const [target] = await tx
    .select()
    .from(user)
    .where(eq(user.id, targetId))
    .for("update");
  invariant(
    target?.role === "technical",
    "FORBIDDEN",
    "קודי שחזור למנהל הטכני בלבד",
    403
  );
  await tx.delete(recoveryCode).where(eq(recoveryCode.userId, targetId));
  const codes = Array.from({ length: 8 }, newRecoveryCode);
  await tx.insert(recoveryCode).values(
    codes.map((code) => ({
      id: randomUUID(),
      userId: targetId,
      digest: digestCode(targetId, code),
    }))
  );
  return codes;
}
export async function useRecoveryCode(email: string, code: string) {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(user)
      .where(eq(user.email, normalizeEmail(email)))
      .for("update");
    invariant(
      target?.role === "technical" && !target.deletedAt,
      "INVALID_CODE",
      "קוד שחזור לא תקין או נוצל",
      401
    );
    const [recovery] = await tx
      .select()
      .from(recoveryCode)
      .where(
        and(
          eq(recoveryCode.userId, target.id),
          eq(recoveryCode.digest, digestCode(target.id, code)),
          isNull(recoveryCode.usedAt)
        )
      )
      .for("update");
    invariant(recovery, "INVALID_CODE", "קוד שחזור לא תקין או נוצל", 401);
    await tx
      .update(recoveryCode)
      .set({ usedAt: new Date() })
      .where(eq(recoveryCode.id, recovery.id));
    await tx
      .update(user)
      .set({
        lockedAt: null,
        failedAttempts: 0,
        nextCodeAllowedAt: null,
        securityEpoch: target.securityEpoch + 1,
        updatedAt: new Date(),
      })
      .where(eq(user.id, target.id));
    await revokeAccess(tx, target.id);
    await audit(tx, target.id, target.id, "recovery-code");
    return { success: true };
  });
}
/** Server-side fallback for a technical account without a usable recovery code. */
export async function recoverTechnicalAccess(email: string, reason: string) {
  const input = z
    .object({ email: z.email(), reason: z.string().trim().min(5) })
    .parse({ email, reason });
  return unitTransaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(user)
      .where(eq(user.email, normalizeEmail(input.email)))
      .for("update");
    invariant(
      target && target.role === "technical" && !target.deletedAt,
      "not_found",
      // Server recovery only (scripts/recover.ts): read in the server's terminal.
      "Technical account not found"
    );
    await tx
      .update(user)
      .set({
        failedAttempts: 0,
        nextCodeAllowedAt: null,
        lockedAt: null,
        securityEpoch: target.securityEpoch + 1,
        updatedAt: new Date(),
      })
      .where(eq(user.id, target.id));
    await revokeAccess(tx, target.id);
    await tx.insert(records).values({
      id: randomUUID(),
      kind: "audit",
      data: {
        actorId: "server-operator",
        actorName: "מפעיל השרת",
        targetId: target.id,
        action: "technical.server-recovery",
        reason: input.reason,
      },
    });
    return issueRecoveryCodes(target.id, tx);
  });
}
export async function applyVerifiedEmailChange(
  tx: DbTransaction,
  targetId: string,
  newEmail: string,
  calendarCleanups?: CalendarCleanup[]
) {
  const [target] = await tx
    .select()
    .from(user)
    .where(eq(user.id, targetId))
    .for("update");
  invariant(target && !target.deletedAt, "NOT_FOUND", "חשבון לא נמצא");
  const calendarCleanup = await purgeCalendarLink(tx, target.id, {
    collect: Boolean(calendarCleanups),
  });
  if (calendarCleanup) calendarCleanups?.push(calendarCleanup);
  await revokeAccess(tx, target.id);
  await tx.delete(account).where(eq(account.userId, target.id));
  await tx
    .update(user)
    .set({
      email: normalizeEmail(newEmail),
      emailVerified: true,
      securityEpoch: target.securityEpoch + 1,
      googleLinkGeneration: target.googleLinkGeneration + 1,
      updatedAt: new Date(),
    })
    .where(eq(user.id, target.id));
  if (target.soldierId)
    await tx
      .update(soldierContacts)
      .set({ email: normalizeEmail(newEmail) })
      .where(eq(soldierContacts.soldierId, target.soldierId));
}
