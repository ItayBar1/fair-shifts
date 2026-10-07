import { eq } from "drizzle-orm";
import { z } from "zod";
import { unitTransaction, type DbTransaction } from "../db";
import { user } from "../auth-schema";
import { calendarLink } from "../schema";
import { accountAvailable } from "../auth/accounts";
import { audit } from "../repository";
import { invariant } from "../errors";
import { openSecret } from "../operations/email";
import { CALENDAR_NAME, CALENDAR_ZONE } from "../../domain/calendar-sync";
import { calendarMetadata, refreshAccessToken } from "./google";
import { calendarSyncEnabled } from "./config";

const paused = (code: string | null) =>
  code === "calendar_creation_pending" ||
  code === "calendar_creation_uncertain";

async function snapshot(tx: DbTransaction, accountId: string) {
  invariant(
    calendarSyncEnabled(),
    "calendar_unavailable",
    "Calendar sync is disabled"
  );
  const [login] = await tx
    .select()
    .from(user)
    .where(eq(user.id, accountId))
    .for("update");
  invariant(
    login && login.role === "soldier" && (await accountAvailable(login, tx)),
    "calendar_account_unavailable",
    "The soldier account is unavailable"
  );
  const [link] = await tx
    .select()
    .from(calendarLink)
    .where(eq(calendarLink.accountId, accountId))
    .for("update");
  invariant(
    link &&
      link.state === "active" &&
      link.refreshToken &&
      paused(link.errorCode) &&
      !link.calendarId,
    "calendar_recovery_unavailable",
    "There is no uncertain calendar creation to recover"
  );
  invariant(
    !link.leaseUntil || link.leaseUntil <= new Date(),
    "calendar_busy",
    "Wait for the current sync lease to expire"
  );
  return { login, link };
}

/** Only a server operator can call this. No Google request holds a database lock. */
export async function recoverCalendarCreation(input: unknown) {
  const command = z
    .discriminatedUnion("mode", [
      z.object({
        mode: z.literal("adopt"),
        accountId: z.string().min(1),
        calendarId: z.string().min(1).max(500),
        reason: z.string().trim().min(5).max(500),
      }),
      z.object({
        mode: z.literal("retry"),
        accountId: z.string().min(1),
        acknowledgement: z.literal("no calendar was created"),
        reason: z.string().trim().min(5).max(500),
      }),
    ])
    .parse(input);
  const before = await unitTransaction((tx) => snapshot(tx, command.accountId));
  if (command.mode === "adopt") {
    const token = await refreshAccessToken(
      openSecret(before.link.refreshToken!)
    );
    // The narrow app-created scope cannot read a private or primary calendar.
    const calendar = await calendarMetadata(token, command.calendarId);
    invariant(
      calendar &&
        calendar.id === command.calendarId &&
        calendar.summary === CALENDAR_NAME &&
        calendar.timeZone === CALENDAR_ZONE,
      "calendar_not_verified",
      "The calendar must be the app-created duties calendar in Asia/Jerusalem"
    );
  }
  return unitTransaction(async (tx) => {
    const current = await snapshot(tx, command.accountId);
    invariant(
      current.login.securityEpoch === before.login.securityEpoch &&
        current.link.version === before.link.version &&
        current.link.refreshToken === before.link.refreshToken,
      "stale_calendar_recovery",
      "The account or grant changed; inspect it again before recovery"
    );
    await tx
      .update(calendarLink)
      .set({
        calendarId: command.mode === "adopt" ? command.calendarId : null,
        errorCode: null,
        attempts: 0,
        nextAttemptAt: new Date(),
        leaseUntil: null,
        leaseToken: null,
        version: current.link.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(calendarLink.accountId, command.accountId));
    await audit(
      tx,
      {
        id: "server-operator",
        name: "מפעיל השרת",
        role: "technical",
        securityEpoch: 0,
      },
      "calendar.creation.recover",
      command.accountId,
      { mode: command.mode, reason: command.reason }
    );
    return { recovered: true };
  });
}
