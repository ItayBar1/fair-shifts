/**
 * Mail delivery rules (decision 177): one shared daily quota, a reserve for codes,
 * growing retry delays within 24 hours, and failure categories that never carry
 * provider text, addresses or secrets.
 */
export const DAILY_QUOTA = 300;
/** The last messages of the day are kept for sign-in and address-verification codes. */
export const CODE_RESERVE = 10;
export const codeKinds = ["login-code", "email-change"] as const;
export const MAX_ATTEMPTS = 5;
export const DELIVERY_WINDOW_MS = 86_400_000;
/** Waits after failed attempts 1–4: the fifth attempt comes about 7 hours after the first. */
export const RETRY_DELAYS_MS = [60_000, 600_000, 3_600_000, 21_600_000];
/** A rejected API key or sender pauses all mail for this long, then tries again. */
export const CONFIGURATION_PAUSE_MS = 900_000;

export const isCodeKind = (kind: string) =>
  (codeKinds as readonly string[]).includes(kind);

/** Whether the quota still has room for this kind after `used` messages today. */
export function quotaAllows(kind: string, used: number) {
  return used < (isCodeKind(kind) ? DAILY_QUOTA : DAILY_QUOTA - CODE_RESERVE);
}

/** When the next attempt may run after `attempts` failed ones; null once none remain. */
export function retryAt(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const delay = RETRY_DELAYS_MS[Math.max(0, attempts - 1)];
  return new Date(now.getTime() + delay);
}

/**
 * What a provider failure means for delivery:
 * transient — retry this message; permanent — this message can never be sent;
 * configuration — every message fails until the technical admin fixes the account;
 * provider_quota — the provider refuses more mail today.
 */
export type FailureCategory =
  "transient" | "permanent" | "configuration" | "provider_quota";

export function classifyProviderStatus(status: number): FailureCategory {
  if (status === 402) return "provider_quota";
  if (status === 401 || status === 403) return "configuration";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  if (status >= 400) return "permanent";
  return "transient";
}

// Domains reserved for tests and examples (RFC 2606, RFC 6761): no mailbox can
// exist there. Synthetic staging data uses them, and the provider never gets
// them, so they cost no quota and no bounce (decision 190).
const reservedDomain =
  /(^|\.)(invalid|test|example|localhost)$|(^|\.)example\.(com|net|org)$/i;
export const reservedAddress = (address: string) =>
  reservedDomain.test(address.slice(address.lastIndexOf("@") + 1));

/** Only these categories are stored; provider responses are never persisted. */
export type OutboxError =
  | "delivery_failed"
  | "rejected"
  | "quota_waiting"
  | "quota_exhausted"
  | "expired"
  | "not_relevant"
  | "superseded"
  | "recipient_unavailable"
  | "preference_disabled"
  | "reserved_address"
  /** Cancelled when the system was restored from a backup (decision 199). */
  | "restored";

type Closable = { attempts: number; error: string | null };
/**
 * A message whose delivery window closed before it was sent. Waiting for quota or
 * failed attempts are failures shown to the technical admin; anything else was
 * skipped on purpose, as after an outage.
 */
export function closedOutcome(message: Closable): {
  status: "failed" | "cancelled";
  error: OutboxError;
} {
  if (message.error === "quota_waiting")
    return { status: "failed", error: "quota_exhausted" };
  if (message.attempts > 0)
    return { status: "failed", error: "delivery_failed" };
  return { status: "cancelled", error: "expired" };
}

/** The mail is a short summary; details stay behind the sign-in on the site. */
export function emailText(body: string, href: string | null, baseUrl: string) {
  if (!href) return body;
  const link = new URL(href, baseUrl).toString();
  return `${body}\n\nלפרטים באתר (נדרשת כניסה): ${link}`;
}

/** Publication mail keys carry the duty and its version: `publish:<duty>:<version>:<account>`. */
export function publicationVersion(eventKey: string) {
  const match = /^(publish|update|cancel):([^:]+):(\d+):/.exec(eventKey);
  return match ? { dutyId: match[2], version: Number(match[3]) } : null;
}
