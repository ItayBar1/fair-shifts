import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { unitTransaction, type DbTransaction } from "../db";
import { user, emailOutbox } from "../auth-schema";
import { records } from "../schema";
import { audit, createRecord, technical, updateRecord } from "../repository";
import { AppError, invariant } from "../errors";
import { text } from "../validation";
import { enqueueEmail } from "../operations/email";
import {
  digestCode,
  matchesDigest,
  MAX_FAILURES,
  newCode,
  normalizeEmail,
  OTP_RESEND_MS,
  OTP_TTL_MS,
} from "./policy";
import {
  applyVerifiedEmailChange,
  issueRecoveryCodes,
  type Actor,
} from "./accounts";

/**
 * Changing the address of the technical account (decision 203). The account is
 * not a soldier, so none of the soldier-contact path applies. Two routes share
 * the rules below:
 *
 * - on the site, by the technical account itself: one code to the current
 *   address and one to the new one, and the change happens only when both are
 *   entered correctly, so whoever takes over an open connection cannot move the
 *   account to an address of their own;
 * - on the server, for when the current address is out of reach: a code to the
 *   new address only, with a reason, run by whoever can reach the server.
 *   Output of that route is read in the server's terminal, hence English.
 */
const KIND = "technical_email_change";

type Mode = "web" | "server";
const messages = {
  web: {
    notFound: "חשבון לא נמצא",
    unchanged: "זו כתובת המייל הנוכחית",
    taken: "הכתובת משויכת לחשבון אחר",
    wait: "יש להמתין דקה בין בקשות אימות",
    expired: "בקשת האימות פגה או אינה תקפה. יש להתחיל מחדש",
    invalid: "קוד האימות אינו תקין",
    blocked: "האימות נחסם לאחר חמישה ניסיונות. יש לבקש קוד חדש",
  },
  server: {
    notFound: "Technical account not found",
    unchanged: "That is already the address of the account",
    taken: "The address belongs to another account",
    wait: "Wait a minute between requests",
    expired:
      "There is no valid request: it expired, was replaced or was cancelled. Start again",
    invalid: "The code is not valid",
    blocked: "Cancelled after five wrong codes. Start again",
  },
} satisfies Record<Mode, Record<string, string>>;

/** What the server route reports in the audit log in place of an account. */
const serverOperator = {
  id: "server-operator",
  name: "מפעיל השרת",
  role: "technical",
  securityEpoch: 0,
} satisfies Actor;

// The two codes are different secrets even if they happen to be equal digits.
const newDigest = (accountId: string, code: string) =>
  digestCode(`technical-email:new:${accountId}`, code);
const currentDigest = (accountId: string, code: string) =>
  digestCode(`technical-email:current:${accountId}`, code);

const accountRequests = (tx: DbTransaction, accountId: string) =>
  tx
    .select()
    .from(records)
    .where(
      and(
        eq(records.kind, KIND),
        sql`${records.data}->>'accountId' = ${accountId}`
      )
    );

/** Unsent code mail of the account stops with its request. */
const cancelCodeMail = (tx: DbTransaction, accountId: string) =>
  tx
    .update(emailOutbox)
    .set({
      status: "cancelled",
      destination: null,
      encryptedSecret: null,
      body: "",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(emailOutbox.recipientAccountId, accountId),
        eq(emailOutbox.kind, "email-change"),
        inArray(emailOutbox.status, ["pending", "sending"])
      )
    );

async function lockTechnical(tx: DbTransaction, where: SQL) {
  const [target] = await tx.select().from(user).where(where).for("update");
  return target && target.role === "technical" && !target.deletedAt
    ? target
    : undefined;
}

type Target = NonNullable<Awaited<ReturnType<typeof lockTechnical>>>;
type Pending = { reason: string; email: string; mode: Mode };

async function openRequest(
  tx: DbTransaction,
  actor: Actor,
  target: Target,
  input: Pending
) {
  const say = messages[input.mode];
  const email = normalizeEmail(input.email);
  invariant(email !== target.email, "unchanged_email", say.unchanged);
  invariant(
    !(await tx.select({ id: user.id }).from(user).where(eq(user.email, email)))
      .length,
    "email_exists",
    say.taken
  );
  const existing = await accountRequests(tx, target.id);
  const now = new Date();
  invariant(
    !existing.some(
      (row) => now.getTime() - row.createdAt.getTime() < OTP_RESEND_MS
    ),
    "rate_limit",
    say.wait,
    429
  );
  // A new request cancels the earlier one, whichever route opened it.
  for (const row of existing.filter((entry) => entry.data.status === "pending"))
    await updateRecord(tx, row, {
      accountId: target.id,
      mode: row.data.mode,
      reason: row.data.reason,
      status: "superseded",
    });
  await cancelCodeMail(tx, target.id);
  const nextCode = newCode();
  const currentCode = input.mode === "web" ? newCode() : undefined;
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  const record = await createRecord(tx, "technical_email_change", {
    accountId: target.id,
    securityEpoch: target.securityEpoch,
    mode: input.mode,
    email,
    digest: newDigest(target.id, nextCode),
    ...(currentCode && {
      currentDigest: currentDigest(target.id, currentCode),
    }),
    attempts: 0,
    status: "pending",
    expiresAt: expiresAt.toISOString(),
    reason: input.reason,
  });
  const mail = (side: "new" | "current", code: string, to: string) =>
    enqueueEmail(tx, {
      recipientAccountId: target.id,
      eventKey: `technical-email:${record.id}:${side}`,
      kind: "email-change",
      title:
        side === "new"
          ? "החלפת כתובת המנהל הטכני: קוד לכתובת החדשה"
          : "החלפת כתובת המנהל הטכני: קוד לכתובת הנוכחית",
      body:
        side === "new"
          ? "קוד אימות לכתובת החדשה של החשבון הטכני: {{CODE}}. הקוד תקף לעשר דקות."
          : "קוד אימות להחלפת הכתובת של החשבון הטכני: {{CODE}}. הקוד תקף לעשר דקות. אם לא ביקשת להחליף כתובת, אין למסור אותו.",
      secret: code,
      destination: to,
      priority: 0,
      expiresAt,
    });
  await mail("new", nextCode, email);
  if (currentCode) await mail("current", currentCode, target.email);
  // The technical account's own reason, no soldier's text, so it can sit in the envelope.
  await audit(tx, actor, "technical.email.request", target.id, {
    reason: input.reason,
    ...(input.mode === "server" && { via: "server" }),
  });
  return { expiresAt: expiresAt.toISOString() };
}

type Failure = {
  committedError: { code: string; message: string; status: number };
};
type Codes = { current?: string; next: string };

/**
 * Checks the codes and, when they are right, moves the account. A wrong
 * submission counts once against the request, whichever code was wrong, and the
 * answer does not say which one it was. Failures are returned, not thrown, so
 * the caller commits the count before reporting.
 */
async function settleRequest(
  tx: DbTransaction,
  actor: Actor,
  target: Target,
  mode: Mode,
  codes: Codes
): Promise<Failure | { recoveryCodes?: string[] }> {
  const say = messages[mode];
  const record = (await accountRequests(tx, target.id)).find(
    (row) => row.data.status === "pending" && row.data.mode === mode
  );
  invariant(
    record &&
      record.data.securityEpoch === target.securityEpoch &&
      new Date(String(record.data.expiresAt)) > new Date() &&
      Number(record.data.attempts) < MAX_FAILURES,
    "expired_verification",
    say.expired
  );
  const base = {
    accountId: target.id,
    mode,
    reason: record.data.reason,
  };
  const matches =
    matchesDigest(
      newDigest(target.id, codes.next),
      String(record.data.digest)
    ) &&
    (mode === "server" ||
      matchesDigest(
        currentDigest(target.id, codes.current ?? ""),
        String(record.data.currentDigest)
      ));
  if (!matches) {
    const attempts = Number(record.data.attempts) + 1;
    const exhausted = attempts >= MAX_FAILURES;
    // A closed request keeps its status and reason, not the address or the digests.
    await updateRecord(
      tx,
      record,
      exhausted
        ? { ...base, attempts, status: "failed" }
        : { ...record.data, attempts }
    );
    if (exhausted) await cancelCodeMail(tx, target.id);
    return {
      committedError: {
        code: "invalid_code",
        message: exhausted ? say.blocked : say.invalid,
        status: 422,
      },
    };
  }
  const email = String(record.data.email);
  // The address could have been given to someone else since the request.
  if (
    (await tx.select({ id: user.id }).from(user).where(eq(user.email, email)))
      .length
  ) {
    await updateRecord(tx, record, { ...base, status: "failed" });
    await cancelCodeMail(tx, target.id);
    return {
      committedError: { code: "email_exists", message: say.taken, status: 409 },
    };
  }
  await applyVerifiedEmailChange(tx, target.id, email);
  await updateRecord(tx, record, {
    ...base,
    attempts: record.data.attempts,
    status: "completed",
  });
  await cancelCodeMail(tx, target.id);
  await audit(tx, actor, "technical.email.confirm", target.id, {
    reason: String(record.data.reason),
    ...(mode === "server" && { via: "server" }),
  });
  // Taking the account over from the server also takes the recovery codes the
  // previous holder kept. On the site the same person holds both mailboxes.
  return mode === "server"
    ? { recoveryCodes: await issueRecoveryCodes(target.id, tx) }
    : {};
}

const siteRequest = z.object({ email: z.email(), reason: text });
const siteConfirmation = z.object({
  currentCode: z.string().trim().min(1).max(100),
  newCode: z.string().trim().min(1).max(100),
});

/** `technical.email.request`: the technical account asks to move itself. */
export async function requestTechnicalEmailChange(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  technical(actor);
  const input = siteRequest.parse(payload);
  const target = await lockTechnical(tx, eq(user.id, actor.id));
  invariant(target, "not_found", messages.web.notFound, 404);
  return {
    success: true,
    ...(await openRequest(tx, actor, target, { ...input, mode: "web" })),
  };
}

/** `technical.email.confirm`: both codes, from the two mailboxes. */
export async function confirmTechnicalEmailChange(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  technical(actor);
  const input = siteConfirmation.parse(payload);
  const target = await lockTechnical(tx, eq(user.id, actor.id));
  invariant(target, "not_found", messages.web.notFound, 404);
  const outcome = await settleRequest(tx, actor, target, "web", {
    current: input.currentCode,
    next: input.newCode,
  });
  return "committedError" in outcome ? outcome : { success: true };
}

const serverRequest = z.object({
  currentEmail: z.email(),
  newEmail: z.email(),
  reason: z.string().trim().min(5),
});
const serverConfirmation = z.object({
  currentEmail: z.email(),
  code: z.string().trim().min(1).max(100),
});

/**
 * Server route, step one (`scripts/technical-email.ts request`): a code goes
 * to the new address. The current address is only how the account is found.
 */
export async function requestServerEmailChange(
  currentEmail: string,
  newEmail: string,
  reason: string
) {
  const input = serverRequest.parse({ currentEmail, newEmail, reason });
  return unitTransaction(async (tx) => {
    const target = await lockTechnical(
      tx,
      eq(user.email, normalizeEmail(input.currentEmail))
    );
    invariant(target, "not_found", messages.server.notFound, 404);
    return openRequest(tx, serverOperator, target, {
      email: input.newEmail,
      reason: input.reason,
      mode: "server",
    });
  });
}

/**
 * Server route, step two: the code from the new address. Returns the new
 * recovery codes, shown once in the terminal and never stored in the clear.
 */
export async function confirmServerEmailChange(
  currentEmail: string,
  code: string
) {
  const input = serverConfirmation.parse({ currentEmail, code });
  const outcome = await unitTransaction(async (tx) => {
    const target = await lockTechnical(
      tx,
      eq(user.email, normalizeEmail(input.currentEmail))
    );
    invariant(target, "not_found", messages.server.notFound, 404);
    return settleRequest(tx, serverOperator, target, "server", {
      next: input.code,
    });
  });
  if ("committedError" in outcome)
    throw new AppError(
      outcome.committedError.code,
      outcome.committedError.message,
      outcome.committedError.status
    );
  return outcome.recoveryCodes ?? [];
}
