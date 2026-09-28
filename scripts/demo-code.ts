import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db, pool } from "../src/server/db";
import { user, emailOutbox, loginCode } from "../src/server/auth-schema";
import { openSecret } from "../src/server/operations/email";
try {
  const email = process.argv[2]?.toLowerCase();
  if (
    process.env.NODE_ENV === "production" ||
    process.env.MAIL_TRANSPORT !== "disabled" ||
    !email ||
    !/^[a-z0-9.-]+@example\.invalid$/.test(email)
  )
    throw new Error("הכלי זמין רק לחשבונות סינתטיים כשמשלוח מייל כבוי");
  const [account] = await db.select().from(user).where(eq(user.email, email));
  if (!account || account.lockedAt || account.deletedAt)
    throw new Error("חשבון סינתטי פעיל לא נמצא");
  const [challenge] = await db
    .select()
    .from(loginCode)
    .where(
      and(
        eq(loginCode.userId, account.id),
        isNull(loginCode.usedAt),
        gt(loginCode.expiresAt, new Date())
      )
    );
  if (!challenge || challenge.securityEpoch !== account.securityEpoch)
    throw new Error("יש לבקש תחילה קוד דרך מסך הכניסה");
  const [message] = await db
    .select()
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.recipientAccountId, account.id),
        eq(emailOutbox.kind, "login-code"),
        eq(emailOutbox.expiresAt, challenge.expiresAt)
      )
    )
    .orderBy(desc(emailOutbox.createdAt));
  if (!message?.encryptedSecret) throw new Error("קוד זמין לא נמצא");
  console.log(openSecret(message.encryptedSecret));
} finally {
  await pool.end();
}
