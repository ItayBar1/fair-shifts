import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, type DbTransaction } from "../db";
import {
  emailOutbox,
  emailQuota,
  loginCode,
  operationsState,
  user,
} from "../auth-schema";
import { invariant } from "../errors";
import { effectivePreferences } from "../notifications";
import { roundEmailRelevant } from "../round-recipients";
import { dutyReminderRelevant } from "../duty-reminder-checks";
import {
  emailAllowed,
  type EmailKind,
} from "../../domain/notification-preferences";

function encryptionKey() {
  const value = process.env.MAIL_ENCRYPTION_KEY ?? "";
  invariant(
    /^[a-f0-9]{64}$/i.test(value),
    "mail_configuration",
    "חסר מפתח הצפנת הודעות",
    503
  );
  return Buffer.from(value, "hex");
}
export function sealSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}
export function openSecret(value: string): string {
  const [iv, tag, encrypted] = value
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8"
  );
}
type EnqueueInput = {
  recipientAccountId: string;
  eventKey: string;
  kind: EmailKind;
  reminderHours?: number;
  title: string;
  body: string;
  href?: string;
  secret?: string;
  destination?: string;
  priority?: number;
  expiresAt: Date;
};
export async function enqueueEmail(tx: DbTransaction, input: EnqueueInput) {
  const { secret, ...values } = input;
  await tx
    .insert(emailOutbox)
    .values({
      id: randomUUID(),
      ...values,
      encryptedSecret: secret ? sealSecret(secret) : null,
    })
    .onConflictDoNothing({ target: emailOutbox.eventKey });
}
export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  eventKey: string;
};
export type MailTransport = (message: MailMessage) => Promise<string>;
export const brevoTransport: MailTransport = async (message) => {
  invariant(
    process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL,
    "mail_configuration",
    "חסרות הגדרות משלוח מייל",
    503
  );
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: { email: process.env.BREVO_SENDER_EMAIL, name: "תורנות הוגנת" },
      to: [{ email: message.to }],
      subject: message.subject,
      textContent: message.text,
      headers: { "X-Mailin-custom": message.eventKey },
    }),
  });
  if (!response.ok) throw new Error(`mail_provider_${response.status}`);
  const result = (await response.json()) as { messageId: string };
  return result.messageId;
};

/** Claim and charge the shared quota atomically; never hold a database lock during delivery. */
export async function deliverNextEmail(
  transport?: MailTransport,
  now = new Date()
) {
  if (!transport && process.env.MAIL_TRANSPORT !== "brevo")
    return { status: "disabled" };
  const claimed = await db.transaction(async (tx) => {
    // A common quota lock also preserves priority when workers compete.
    const day = DateTime.fromJSDate(now)
      .setZone(process.env.MAIL_QUOTA_TIME_ZONE ?? "UTC")
      .toISODate()!;
    await tx.insert(emailQuota).values({ day, used: 0 }).onConflictDoNothing();
    const [quota] = await tx
      .select()
      .from(emailQuota)
      .where(eq(emailQuota.day, day))
      .for("update");
    const [maintenance] = await tx
      .select()
      .from(operationsState)
      .where(eq(operationsState.key, "restore"));
    if (process.env.RESTORE_MODE === "true" || maintenance?.data.blocked)
      return null;
    if (quota.used >= 300) return null;
    const [message] = await tx
      .select()
      .from(emailOutbox)
      .where(
        and(
          lte(emailOutbox.nextAttemptAt, now),
          sql`(${emailOutbox.status} = 'pending' or (${emailOutbox.status} = 'sending' and ${emailOutbox.leaseUntil} <= ${now}))`
        )
      )
      .orderBy(emailOutbox.priority, emailOutbox.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!message) return null;
    const [recipient] = await tx
      .select()
      .from(user)
      .where(eq(user.id, message.recipientAccountId));
    let relevant = Boolean(
      recipient &&
      !recipient.deletedAt &&
      message.expiresAt > now &&
      message.attempts < 5 &&
      now.getTime() - message.createdAt.getTime() < 86_400_000
    );
    if (message.kind === "login-code") {
      const [code] = await tx
        .select()
        .from(loginCode)
        .where(eq(loginCode.userId, message.recipientAccountId));
      relevant &&= Boolean(
        code &&
        !code.usedAt &&
        code.expiresAt > now &&
        code.expiresAt.getTime() === message.expiresAt.getTime() &&
        code.securityEpoch === recipient.securityEpoch &&
        !recipient.lockedAt
      );
    }
    if (
      relevant &&
      (message.kind === "round-opening" || message.kind === "round-closing")
    )
      relevant = await roundEmailRelevant(
        tx,
        message.eventKey,
        message.recipientAccountId,
        now
      );
    if (relevant && message.kind === "duty-reminder")
      relevant = await dutyReminderRelevant(
        tx,
        message.eventKey,
        message.recipientAccountId,
        now
      );
    // Preferences are read again at delivery time, never frozen when the message was queued.
    const allowed =
      !relevant ||
      emailAllowed(
        (await effectivePreferences(tx, message.recipientAccountId))
          .preferences,
        message.kind as EmailKind,
        message.reminderHours
      );
    if (!relevant || !allowed) {
      await tx
        .update(emailOutbox)
        .set({
          status: relevant || message.attempts < 5 ? "cancelled" : "failed",
          error: relevant ? "preference_disabled" : message.error,
          encryptedSecret: null,
          destination: null,
          updatedAt: now,
        })
        .where(eq(emailOutbox.id, message.id));
      return "skipped" as const;
    }
    await tx
      .update(emailQuota)
      .set({ used: quota.used + 1 })
      .where(eq(emailQuota.day, day));
    const leaseUntil = new Date(now.getTime() + 60_000);
    await tx
      .update(emailOutbox)
      .set({
        status: "sending",
        attempts: message.attempts + 1,
        leaseUntil,
        updatedAt: now,
      })
      .where(eq(emailOutbox.id, message.id));
    return {
      ...message,
      attempts: message.attempts + 1,
      leaseUntil,
      to: message.destination ?? recipient.email,
    };
  });
  if (!claimed) return { status: "idle" };
  if (claimed === "skipped") return { status: "skipped" };
  try {
    const text = claimed.encryptedSecret
      ? claimed.body.replace("{{CODE}}", openSecret(claimed.encryptedSecret))
      : claimed.body;
    const providerId = await (transport ?? brevoTransport)({
      to: claimed.to,
      subject: claimed.title,
      text,
      eventKey: claimed.eventKey,
    });
    await db
      .update(emailOutbox)
      .set({
        status: "sent",
        providerId,
        encryptedSecret: null,
        destination: null,
        leaseUntil: null,
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(emailOutbox.id, claimed.id),
          eq(emailOutbox.status, "sending"),
          eq(emailOutbox.leaseUntil, claimed.leaseUntil)
        )
      );
    return { status: "sent" };
  } catch {
    // Provider responses can contain addresses or secrets: store only a safe error category.
    await db
      .update(emailOutbox)
      .set({
        status: claimed.attempts >= 5 ? "failed" : "pending",
        leaseUntil: null,
        error: "delivery_failed",
        nextAttemptAt: new Date(
          now.getTime() + Math.min(3600_000, 30_000 * 2 ** claimed.attempts)
        ),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(emailOutbox.id, claimed.id),
          eq(emailOutbox.status, "sending"),
          eq(emailOutbox.leaseUntil, claimed.leaseUntil)
        )
      );
    return { status: "failed" };
  }
}
