import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "../db";
import { user, emailOutbox } from "../auth-schema";
import { soldiers, records, soldierContacts } from "../schema";
import {
  createRecord,
  currentVersion,
  manager,
  updateRecord,
  audit,
} from "../repository";
import { id, text } from "../validation";
import { invariant } from "../errors";
import { enqueueEmail } from "../operations/email";
import {
  digestCode,
  matchesDigest,
  newCode,
  normalizeEmail,
  OTP_RESEND_MS,
  OTP_TTL_MS,
} from "./policy";
import { applyVerifiedEmailChange, type Actor } from "./accounts";
import type { CalendarCleanup } from "../calendar/link";
import { reserveCodeBudget } from "./budgets";

export async function requestEmailChange(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({ soldierId: id, email: z.email(), reason: text })
    .parse(payload);
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, input.soldierId));
  invariant(person && !person.deletedAt, "not_found", "חייל לא נמצא", 404);
  currentVersion(person.version, expectedVersion);
  const [target] = await tx
    .select()
    .from(user)
    .where(eq(user.soldierId, person.id))
    .for("update");
  invariant(target && !target.deletedAt, "not_found", "חשבון לא נמצא", 404);
  invariant(
    target.role === "soldier",
    "forbidden",
    "שינוי זה זמין לחשבון חייל בלבד",
    403
  );
  const email = normalizeEmail(input.email);
  invariant(
    email !== target.email,
    "unchanged_email",
    "זו כתובת המייל הנוכחית"
  );
  invariant(
    !(await tx.select({ id: user.id }).from(user).where(eq(user.email, email)))
      .length,
    "email_exists",
    "הכתובת משויכת לחשבון אחר"
  );
  const pending = await tx
    .select()
    .from(records)
    .where(
      and(eq(records.kind, "email_change"), eq(records.subjectId, person.id))
    );
  const now = new Date();
  invariant(
    !pending.some(
      (row) => now.getTime() - row.createdAt.getTime() < OTP_RESEND_MS
    ),
    "rate_limit",
    "יש להמתין דקה בין בקשות אימות",
    429
  );
  invariant(
    await reserveCodeBudget(tx, "email-change", target.id, 1, "issue", now),
    "rate_limit",
    "מכסת הודעות האימות היומית מוצתה",
    429
  );
  for (const row of pending)
    await updateRecord(tx, row, { status: "superseded", accountId: target.id });
  await tx
    .update(emailOutbox)
    .set({
      status: "cancelled",
      destination: null,
      encryptedSecret: null,
      body: "",
    })
    .where(
      and(
        eq(emailOutbox.recipientAccountId, target.id),
        eq(emailOutbox.kind, "email-change")
      )
    );
  const code = newCode();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  const record = await createRecord(
    tx,
    "email_change",
    {
      accountId: target.id,
      securityEpoch: target.securityEpoch,
      email,
      digest: digestCode(`email-change:${target.id}`, code),
      attempts: 0,
      status: "pending",
      expiresAt: expiresAt.toISOString(),
      reason: input.reason,
    },
    person.id
  );
  await enqueueEmail(tx, {
    recipientAccountId: target.id,
    eventKey: `email-change:${record.id}`,
    kind: "email-change",
    title: "אימות כתובת מייל חדשה",
    body: "קוד אימות לשינוי כתובת: {{CODE}}. הקוד תקף לעשר דקות.",
    secret: code,
    destination: email,
    priority: 0,
    expiresAt,
  });
  await audit(tx, actor, "account.email.request", target.id, {}, person.id);
  return { success: true };
}
export async function confirmEmailChange(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number,
  calendarCleanups?: CalendarCleanup[]
) {
  manager(actor);
  const input = z
    .object({
      soldierId: id,
      code: z.string().min(1).max(100),
      disconnectGoogle: z.literal(true),
    })
    .parse(payload);
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, input.soldierId));
  invariant(person && !person.deletedAt, "not_found", "חייל לא נמצא", 404);
  currentVersion(person.version, expectedVersion);
  const [target] = await tx
    .select()
    .from(user)
    .where(eq(user.soldierId, person.id))
    .for("update");
  invariant(target && !target.deletedAt, "not_found", "חשבון לא נמצא", 404);
  invariant(
    target.role === "soldier",
    "forbidden",
    "שינוי זה זמין לחשבון חייל בלבד",
    403
  );
  const candidates = await tx
    .select()
    .from(records)
    .where(
      and(eq(records.kind, "email_change"), eq(records.subjectId, person.id))
    );
  const record = candidates.find((row) => row.data.status === "pending");
  invariant(
    record &&
      record.data.securityEpoch === target.securityEpoch &&
      new Date(String(record.data.expiresAt)) > new Date() &&
      Number(record.data.attempts) < 5,
    "expired_verification",
    "בקשת האימות פגה או אינה תקפה. יש להתחיל מחדש"
  );
  if (
    !matchesDigest(
      digestCode(`email-change:${target.id}`, input.code),
      String(record.data.digest)
    )
  ) {
    const attempts = Number(record.data.attempts) + 1;
    await updateRecord(tx, record, {
      ...record.data,
      attempts,
      status: attempts >= 5 ? "failed" : "pending",
    });
    // Returned failures are committed by the command layer before producing the HTTP error.
    return {
      committedError: {
        code: "invalid_code",
        message:
          attempts >= 5
            ? "האימות נחסם לאחר חמישה ניסיונות. יש לבקש קוד חדש"
            : "קוד האימות אינו תקין",
        status: 422,
      },
    };
  }
  await applyVerifiedEmailChange(
    tx,
    target.id,
    String(record.data.email),
    calendarCleanups
  );
  const [contact] = await tx
    .select()
    .from(soldierContacts)
    .where(eq(soldierContacts.soldierId, person.id));
  invariant(contact, "missing_contact", "פרטי הקשר חסרים; נדרש תיקון רשומה");
  await tx
    .update(soldierContacts)
    .set({
      fieldVersions: {
        ...contact.fieldVersions,
        email: (contact.fieldVersions.email ?? 0) + 1,
      },
    })
    .where(eq(soldierContacts.soldierId, person.id));
  await tx
    .update(soldiers)
    .set({ version: person.version + 1, updatedAt: new Date() })
    .where(eq(soldiers.id, person.id));
  await updateRecord(tx, record, {
    status: "completed",
    accountId: target.id,
    googleDisconnected: true,
  });
  await tx
    .update(emailOutbox)
    .set({ status: "cancelled", destination: null, encryptedSecret: null })
    .where(
      and(
        eq(emailOutbox.recipientAccountId, target.id),
        eq(emailOutbox.kind, "email-change")
      )
    );
  await audit(
    tx,
    actor,
    "account.email.confirm",
    target.id,
    { googleDisconnected: true },
    person.id
  );
  return { success: true };
}
