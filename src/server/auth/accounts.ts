import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, type DbTransaction } from "../db";
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
  population?: string;
  securityEpoch: number;
};
export type InvitedAccount = {
  id?: string;
  name: string;
  email: string;
  soldierId?: string;
  role?: Role;
  population?: string;
};
export async function accountAvailable(
  row: typeof user.$inferSelect,
  tx: DbTransaction | typeof db = db
) {
  if (row.lockedAt || row.deletedAt) return false;
  if (row.soldierId) {
    const [soldier] = await tx
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, row.soldierId));
    if (!soldier || soldier.deletedAt) return false;
    const date = soldier.data.service.releaseDate;
    if (date && DateTime.now().setZone("Asia/Jerusalem").toISODate()! > date)
      return false;
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
        population: input.population,
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
      "קוד שחזור לא תקין",
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
        securityEpoch: target.securityEpoch + 1,
        updatedAt: new Date(),
      })
      .where(eq(user.id, target.id));
    await revokeAccess(tx, target.id);
    await audit(tx, target.id, target.id, "recovery-code");
    return { success: true };
  });
}
export async function applyVerifiedEmailChange(
  tx: DbTransaction,
  targetId: string,
  newEmail: string
) {
  const [target] = await tx
    .select()
    .from(user)
    .where(eq(user.id, targetId))
    .for("update");
  invariant(target && !target.deletedAt, "NOT_FOUND", "חשבון לא נמצא");
  await revokeAccess(tx, target.id);
  await tx.delete(account).where(eq(account.userId, target.id));
  await tx
    .update(user)
    .set({
      email: normalizeEmail(newEmail),
      emailVerified: true,
      securityEpoch: target.securityEpoch + 1,
      updatedAt: new Date(),
    })
    .where(eq(user.id, target.id));
  if (target.soldierId)
    await tx
      .update(soldierContacts)
      .set({ email: normalizeEmail(newEmail) })
      .where(eq(soldierContacts.soldierId, target.soldierId));
}
