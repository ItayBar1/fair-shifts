import { eq } from "drizzle-orm";
import { db } from "../db";
import { user, loginCode } from "../auth-schema";
import { AppError } from "../errors";
import { accountAvailable, revokeAccess } from "./accounts";
import {
  digestCode,
  failureResult,
  matchesDigest,
  newCode,
  normalizeEmail,
  OTP_RESEND_MS,
  OTP_TTL_MS,
} from "./policy";
import { enqueueEmail } from "../operations/email";

// A soldier is released by a manager, a manager by the technical account, and
// the technical account by its own recovery codes.
function releaseGuidance(role: string) {
  if (role === "technical")
    return "יש להשתמש בקוד שחזור חד־פעמי או בשחזור דרך השרת";
  return `יש לפנות ${role === "soldier" ? "לאחראי התורנויות" : "למנהל הטכני"} לשחרור`;
}
function remainingWarning(remaining: number | undefined) {
  if (remaining === 2) return ". נותרו שני ניסיונות לפני נעילת החשבון";
  if (remaining === 1) return ". נותר ניסיון אחד לפני נעילת החשבון";
  return "";
}

export async function requestCode(email: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const [person] = await tx
      .select()
      .from(user)
      .where(eq(user.email, normalizeEmail(email)))
      .for("update");
    if (!person || !(await accountAvailable(person, tx)))
      return { success: true };
    const [old] = await tx
      .select()
      .from(loginCode)
      .where(eq(loginCode.userId, person.id));
    if (old && now.getTime() - old.sentAt.getTime() < OTP_RESEND_MS)
      throw new AppError("rate_limit", "יש להמתין דקה בין שליחות קוד", 429);
    const code = newCode();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
    const values = {
      userId: person.id,
      digest: digestCode(person.id, code),
      securityEpoch: person.securityEpoch,
      expiresAt,
      sentAt: now,
      usedAt: null,
    };
    await tx
      .insert(loginCode)
      .values(values)
      .onConflictDoUpdate({ target: loginCode.userId, set: values });
    await enqueueEmail(tx, {
      recipientAccountId: person.id,
      kind: "login-code",
      title: "קוד כניסה לתורנות הוגנת",
      body: "קוד הכניסה שלך: {{CODE}}. הקוד תקף לעשר דקות.",
      secret: code,
      priority: 0,
      expiresAt,
      eventKey: `login:${person.id}:${now.toISOString()}`,
    });
    return { success: true };
  });
}

export async function verifyCode(
  email: string,
  code: string,
  now = new Date()
) {
  const outcome = await db.transaction(async (tx) => {
    const [person] = await tx
      .select()
      .from(user)
      .where(eq(user.email, normalizeEmail(email)))
      .for("update");
    if (!person) return { error: "קוד לא תקין או שפג תוקפו", locked: false };
    if (!(await accountAvailable(person, tx)))
      return {
        error: person.lockedAt
          ? `החשבון נעול. ${releaseGuidance(person.role)}`
          : "החשבון אינו זמין לכניסה",
        locked: true,
      };
    const [challenge] = await tx
      .select()
      .from(loginCode)
      .where(eq(loginCode.userId, person.id));
    if (
      !challenge ||
      challenge.usedAt ||
      challenge.expiresAt <= now ||
      challenge.securityEpoch !== person.securityEpoch
    )
      return { error: "קוד לא תקין או שפג תוקפו", locked: false };
    if (!matchesDigest(digestCode(person.id, code), challenge.digest)) {
      const failure = failureResult(person.failedAttempts);
      await tx
        .update(user)
        .set({
          failedAttempts: failure.count,
          lockedAt: failure.locked ? now : null,
          securityEpoch: person.securityEpoch + (failure.locked ? 1 : 0),
        })
        .where(eq(user.id, person.id));
      if (failure.locked) await revokeAccess(tx, person.id);
      return {
        error: failure.locked
          ? `החשבון ננעל. ${releaseGuidance(person.role)}`
          : `קוד לא תקין${remainingWarning(failure.remaining)}`,
        locked: failure.locked,
      };
    }
    await tx
      .update(loginCode)
      .set({ usedAt: now })
      .where(eq(loginCode.userId, person.id));
    await tx
      .update(user)
      .set({ failedAttempts: 0, emailVerified: true })
      .where(eq(user.id, person.id));
    return {
      user: { ...person, emailVerified: true },
      epoch: person.securityEpoch,
    };
  });
  // The failed attempt must commit before an HTTP error is raised.
  if ("error" in outcome)
    throw new AppError(
      outcome.locked ? "account_locked" : "invalid_code",
      outcome.error!,
      401
    );
  return outcome;
}
