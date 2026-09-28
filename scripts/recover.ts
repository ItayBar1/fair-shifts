import { eq } from "drizzle-orm";
import { z } from "zod";
import { pool, unitTransaction } from "../src/server/db";
import { user } from "../src/server/auth-schema";
import { issueRecoveryCodes, revokeAccess } from "../src/server/auth/accounts";
import { createRecord } from "../src/server/repository";
import { invariant } from "../src/server/errors";
try {
  const input = z
    .object({
      RECOVERY_EMAIL: z.email(),
      RECOVERY_REASON: z.string().trim().min(5),
    })
    .parse(process.env);
  const codes = await unitTransaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(user)
      .where(eq(user.email, input.RECOVERY_EMAIL.toLowerCase()))
      .for("update");
    invariant(
      account && account.role === "technical" && !account.deletedAt,
      "not_found",
      "חשבון טכני לא נמצא"
    );
    await tx
      .update(user)
      .set({
        failedAttempts: 0,
        lockedAt: null,
        securityEpoch: account.securityEpoch + 1,
      })
      .where(eq(user.id, account.id));
    await revokeAccess(tx, account.id);
    await createRecord(tx, "audit", {
      actorId: "server-operator",
      targetId: account.id,
      action: "technical.server-recovery",
      reason: input.RECOVERY_REASON,
    });
    return issueRecoveryCodes(account.id, tx);
  });
  console.log(
    "הגישה שוחררה ונדרשת התחברות מחדש. קודי שחזור חדשים לשמירה מחוץ למאגר:"
  );
  console.log(codes.join("\n"));
} finally {
  await pool.end();
}
