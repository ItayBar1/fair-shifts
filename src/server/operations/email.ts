import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
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
import {
  CODE_RESERVE,
  CONFIGURATION_PAUSE_MS,
  DAILY_QUOTA,
  DELIVERY_WINDOW_MS,
  classifyProviderStatus,
  closedOutcome,
  codeKinds,
  emailText,
  publicationVersion,
  quotaAllows,
  retryAt,
  type FailureCategory,
  type OutboxError,
} from "../../domain/mail-delivery";

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
/** A transport reports only a category; provider text may contain addresses or secrets. */
export class MailDeliveryError extends Error {
  constructor(readonly category: FailureCategory) {
    super(`mail_${category}`);
    this.name = "MailDeliveryError";
  }
}
export const brevoTransport: MailTransport = async (message) => {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL)
    throw new MailDeliveryError("configuration");
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
  if (!response.ok)
    throw new MailDeliveryError(classifyProviderStatus(response.status));
  const result = (await response.json()) as { messageId: string };
  return result.messageId;
};

type Executor = typeof db | DbTransaction;
const MAIL_STATE_KEY = "mail";
type MailState = {
  pausedUntil?: string;
  pauseReason?: "configuration" | "provider_quota";
  /** The quota day on which messages were held back for lack of quota. */
  quotaExhaustedDay?: string;
};
export function quotaDay(now: Date) {
  return DateTime.fromJSDate(now)
    .setZone(process.env.MAIL_QUOTA_TIME_ZONE ?? "UTC")
    .toISODate()!;
}
async function readMailState(tx: Executor): Promise<MailState> {
  const [row] = await tx
    .select()
    .from(operationsState)
    .where(eq(operationsState.key, MAIL_STATE_KEY));
  return (row?.data ?? {}) as MailState;
}
async function writeMailState(tx: Executor, data: MailState, now: Date) {
  await tx
    .insert(operationsState)
    .values({ key: MAIL_STATE_KEY, data, updatedAt: now })
    .onConflictDoUpdate({
      target: operationsState.key,
      set: {
        data: sql`${operationsState.data} || excluded.data`,
        updatedAt: now,
      },
    });
}
const cleared = { encryptedSecret: null, destination: null, leaseUntil: null };

/** Messages whose window closed are failed or skipped once, so a later day never sends them. */
async function closeExpired(tx: DbTransaction, now: Date) {
  const rows = await tx
    .select({
      id: emailOutbox.id,
      attempts: emailOutbox.attempts,
      error: emailOutbox.error,
    })
    .from(emailOutbox)
    .where(
      and(
        or(
          eq(emailOutbox.status, "pending"),
          and(
            eq(emailOutbox.status, "sending"),
            lte(emailOutbox.leaseUntil, now)
          )
        ),
        or(
          lte(emailOutbox.expiresAt, now),
          lte(
            emailOutbox.createdAt,
            new Date(now.getTime() - DELIVERY_WINDOW_MS)
          )
        )
      )
    )
    .limit(500)
    .for("update", { skipLocked: true });
  for (const row of rows)
    await tx
      .update(emailOutbox)
      .set({ ...closedOutcome(row), ...cleared, updatedAt: now })
      .where(eq(emailOutbox.id, row.id));
}

/** Marks what the quota holds back, so a message that expires waiting is shown as a quota failure. */
async function holdForQuota(
  tx: DbTransaction,
  now: Date,
  day: string,
  codesToo: boolean
) {
  const held = await tx
    .update(emailOutbox)
    .set({ error: "quota_waiting", updatedAt: now })
    .where(
      and(
        eq(emailOutbox.status, "pending"),
        lte(emailOutbox.nextAttemptAt, now),
        or(isNull(emailOutbox.error), ne(emailOutbox.error, "quota_waiting")),
        codesToo ? undefined : notInArray(emailOutbox.kind, [...codeKinds])
      )
    )
    .returning({ id: emailOutbox.id });
  if (held.length) await writeMailState(tx, { quotaExhaustedDay: day }, now);
}

/** A newer publication, update or cancellation mail of the same duty replaces an older one. */
async function superseded(
  tx: DbTransaction,
  message: typeof emailOutbox.$inferSelect
) {
  const current = publicationVersion(message.eventKey);
  if (!current) return false;
  const siblings = await tx
    .select({ eventKey: emailOutbox.eventKey })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.recipientAccountId, message.recipientAccountId),
        inArray(emailOutbox.kind, ["publication", "publication-change"]),
        like(emailOutbox.eventKey, `%:${current.dutyId}:%`)
      )
    );
  return siblings.some((row) => {
    const other = publicationVersion(row.eventKey);
    return other?.dutyId === current.dutyId && other.version > current.version;
  });
}

type Claimed = typeof emailOutbox.$inferSelect & {
  leaseUntil: Date;
  to: string;
};
/** Claim and charge the shared quota atomically; never hold a database lock during delivery. */
export async function deliverNextEmail(
  transport?: MailTransport,
  now = new Date()
) {
  if (!transport && process.env.MAIL_TRANSPORT !== "brevo")
    return { status: "disabled" };
  const claimed = await db.transaction(
    async (tx): Promise<Claimed | "skipped" | null> => {
      // A common quota lock serializes claims, so workers keep priority and never overspend.
      const day = quotaDay(now);
      await tx
        .insert(emailQuota)
        .values({ day, used: 0 })
        .onConflictDoNothing();
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
      await closeExpired(tx, now);
      const state = await readMailState(tx);
      if (state.pausedUntil && new Date(state.pausedUntil) > now) return null;
      if (!quotaAllows("login-code", quota.used)) {
        await holdForQuota(tx, now, day, true);
        return null;
      }
      const codesOnly = !quotaAllows("publication", quota.used);
      if (codesOnly) await holdForQuota(tx, now, day, false);
      const [message] = await tx
        .select()
        .from(emailOutbox)
        .where(
          and(
            lte(emailOutbox.nextAttemptAt, now),
            sql`(${emailOutbox.status} = 'pending' or (${emailOutbox.status} = 'sending' and ${emailOutbox.leaseUntil} <= ${now}))`,
            codesOnly ? inArray(emailOutbox.kind, [...codeKinds]) : undefined
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
      let skip: OutboxError | null =
        recipient && !recipient.deletedAt ? null : "recipient_unavailable";
      if (!skip && message.kind === "login-code") {
        const [code] = await tx
          .select()
          .from(loginCode)
          .where(eq(loginCode.userId, message.recipientAccountId));
        const valid =
          code &&
          !code.usedAt &&
          code.expiresAt > now &&
          code.expiresAt.getTime() === message.expiresAt.getTime() &&
          code.securityEpoch === recipient.securityEpoch &&
          !recipient.lockedAt;
        if (!valid) skip = "not_relevant";
      }
      if (
        !skip &&
        (message.kind === "round-opening" ||
          message.kind === "round-closing") &&
        !(await roundEmailRelevant(
          tx,
          message.eventKey,
          message.recipientAccountId,
          now
        ))
      )
        skip = "not_relevant";
      if (
        !skip &&
        message.kind === "duty-reminder" &&
        !(await dutyReminderRelevant(
          tx,
          message.eventKey,
          message.recipientAccountId,
          now
        ))
      )
        skip = "not_relevant";
      if (!skip && (await superseded(tx, message))) skip = "superseded";
      // Preferences are read again at delivery time, never frozen when the message was queued.
      if (
        !skip &&
        !emailAllowed(
          (await effectivePreferences(tx, message.recipientAccountId))
            .preferences,
          message.kind as EmailKind,
          message.reminderHours
        )
      )
        skip = "preference_disabled";
      if (skip) {
        await tx
          .update(emailOutbox)
          .set({ status: "cancelled", error: skip, ...cleared, updatedAt: now })
          .where(eq(emailOutbox.id, message.id));
        return "skipped";
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
    }
  );
  if (!claimed) return { status: "idle" };
  if (claimed === "skipped") return { status: "skipped" };
  const ownLease = and(
    eq(emailOutbox.id, claimed.id),
    eq(emailOutbox.status, "sending"),
    eq(emailOutbox.leaseUntil, claimed.leaseUntil)
  );
  try {
    const body = claimed.encryptedSecret
      ? claimed.body.replace("{{CODE}}", openSecret(claimed.encryptedSecret))
      : claimed.body;
    const providerId = await (transport ?? brevoTransport)({
      to: claimed.to,
      subject: claimed.title,
      text: emailText(
        body,
        claimed.href,
        process.env.BETTER_AUTH_URL ?? "http://localhost:3000"
      ),
      eventKey: claimed.eventKey,
    });
    await db
      .update(emailOutbox)
      .set({
        status: "sent",
        providerId,
        ...cleared,
        error: null,
        updatedAt: new Date(),
      })
      .where(ownLease);
    return { status: "sent" };
  } catch (error) {
    const category =
      error instanceof MailDeliveryError ? error.category : "transient";
    await db.transaction(async (tx) => {
      if (category === "configuration" || category === "provider_quota") {
        // Not this message's fault: it keeps its attempts and waits for the pause to end.
        await tx
          .update(emailOutbox)
          .set({
            status: "pending",
            attempts: claimed.attempts - 1,
            leaseUntil: null,
            ...(category === "provider_quota" && { error: "quota_waiting" }),
            updatedAt: now,
          })
          .where(ownLease);
        const pausedUntil =
          category === "configuration"
            ? new Date(now.getTime() + CONFIGURATION_PAUSE_MS)
            : DateTime.fromISO(quotaDay(now), {
                zone: process.env.MAIL_QUOTA_TIME_ZONE ?? "UTC",
              })
                .plus({ days: 1 })
                .toJSDate();
        await writeMailState(
          tx,
          {
            pausedUntil: pausedUntil.toISOString(),
            pauseReason: category,
            ...(category === "provider_quota" && {
              quotaExhaustedDay: quotaDay(now),
            }),
          },
          now
        );
        return;
      }
      const next = category === "transient" && retryAt(claimed.attempts, now);
      await tx
        .update(emailOutbox)
        .set(
          next
            ? {
                status: "pending",
                leaseUntil: null,
                error: "delivery_failed",
                nextAttemptAt: next,
                updatedAt: now,
              }
            : {
                status: "failed",
                ...cleared,
                error:
                  category === "permanent" ? "rejected" : "delivery_failed",
                updatedAt: now,
              }
        )
        .where(ownLease);
    });
    return { status: "failed", category };
  }
}

export type MailFailure = {
  id: string;
  kind: string;
  error: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
};
/**
 * Operational mail status for the technical admin: counts and categories only,
 * without recipients, addresses, titles or content.
 */
export async function readMailStatus(tx: Executor, now = new Date()) {
  const day = quotaDay(now);
  const [quota] = await tx
    .select()
    .from(emailQuota)
    .where(eq(emailQuota.day, day));
  const state = await readMailState(tx);
  const week = new Date(now.getTime() - 7 * DELIVERY_WINDOW_MS);
  const [counts] = await tx
    .select({
      pending: sql<number>`count(*) filter (where ${emailOutbox.status} in ('pending', 'sending'))::int`,
      waiting: sql<number>`count(*) filter (where ${emailOutbox.status} = 'pending' and ${emailOutbox.error} = 'quota_waiting')::int`,
      failed: sql<number>`count(*) filter (where ${emailOutbox.status} = 'failed' and ${emailOutbox.updatedAt} >= ${week})::int`,
      lastSentAt: sql<
        string | null
      >`max(${emailOutbox.updatedAt}) filter (where ${emailOutbox.status} = 'sent')`,
    })
    .from(emailOutbox);
  const failures: MailFailure[] = await tx
    .select({
      id: emailOutbox.id,
      kind: emailOutbox.kind,
      error: emailOutbox.error,
      attempts: emailOutbox.attempts,
      createdAt: emailOutbox.createdAt,
      updatedAt: emailOutbox.updatedAt,
    })
    .from(emailOutbox)
    .where(
      and(eq(emailOutbox.status, "failed"), gte(emailOutbox.updatedAt, week))
    )
    .orderBy(desc(emailOutbox.updatedAt))
    .limit(20);
  const paused =
    state.pausedUntil && new Date(state.pausedUntil) > now
      ? { until: state.pausedUntil, reason: state.pauseReason }
      : null;
  const quotaExhausted = state.quotaExhaustedDay === day;
  const recentFailure = failures.some(
    (row) => now.getTime() - row.updatedAt.getTime() < DELIVERY_WINDOW_MS
  );
  const transport =
    process.env.MAIL_TRANSPORT === "brevo" ? "brevo" : "disabled";
  return {
    // A real problem is shown even where sending is switched off.
    status:
      paused || quotaExhausted || recentFailure
        ? "attention"
        : transport === "disabled"
          ? "disabled"
          : "ok",
    transport,
    day,
    used: quota?.used ?? 0,
    limit: DAILY_QUOTA,
    reserve: CODE_RESERVE,
    quotaExhausted,
    paused,
    pending: counts.pending,
    waitingForQuota: counts.waiting,
    failedThisWeek: counts.failed,
    lastSentAt: counts.lastSentAt
      ? new Date(counts.lastSentAt).toISOString()
      : null,
    failures,
  };
}
export type MailStatus = Awaited<ReturnType<typeof readMailStatus>>;
