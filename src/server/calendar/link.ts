import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbTransaction } from "../db";
import { account, user } from "../auth-schema";
import { calendarEvent, calendarLink } from "../schema";
import { invariant } from "../errors";
import { openSecret, sealSecret } from "../operations/email";
import {
  calendarState,
  grantsCalendar,
  type CalendarState,
} from "../../domain/calendar-sync";
import { calendarSyncEnabled } from "./config";
import { refreshAccessToken, removeEvent, revokeToken } from "./google";
import { accountAvailable, type Actor } from "../auth/accounts";

/**
 * Records what a Google sign-in granted (decision 195). Called from the sign-in itself,
 * outside the unit transaction. Only the permission and its refresh token are kept; the
 * token is sealed, and the access token and everything else Google sent are dropped.
 *
 * A grant with a token makes the link usable and clears an earlier loss. A sign-in
 * without the permission turns a usable link into "permission needed". A grant that
 * Google reports without a new token (the soldier already granted it earlier) keeps
 * whatever token is held.
 */
export async function recordGoogleGrant(
  userId: string,
  grant: {
    scopes?: readonly string[] | null;
    refreshToken?: string | null;
    epoch?: number;
  },
  transaction?: DbTransaction
) {
  if (!calendarSyncEnabled()) return;
  const work = async (tx: DbTransaction) => {
    // The account row serializes this with the deletion of the account.
    const [person] = await tx
      .select()
      .from(user)
      .where(eq(user.id, userId))
      .for("update");
    // A duty manager takes no part in duties (decision 192), so has no calendar.
    if (
      !person ||
      person.role !== "soldier" ||
      (grant.epoch !== undefined && grant.epoch !== person.securityEpoch) ||
      !(await accountAvailable(person, tx))
    )
      return;
    const [existing] = await tx
      .select()
      .from(calendarLink)
      .where(eq(calendarLink.accountId, userId));
    const now = new Date();
    if (grantsCalendar(grant.scopes)) {
      if (grant.refreshToken) {
        const creationUncertain =
          !existing?.calendarId &&
          ["calendar_creation_pending", "calendar_creation_uncertain"].includes(
            existing?.errorCode ?? ""
          );
        const values = {
          refreshToken: sealSecret(grant.refreshToken, {
            purpose: "calendar-refresh",
            recordId: userId,
          }),
          state: "active",
          attempts: creationUncertain ? (existing?.attempts ?? 0) : 0,
          nextAttemptAt: now,
          leaseUntil: null,
          leaseToken: null,
          // A new token cannot prove whether an earlier Calendar POST created
          // a calendar. Retain that marker until the operator reconciles it.
          errorCode: creationUncertain ? (existing?.errorCode ?? null) : null,
          permissionNoticeAt: null,
          updatedAt: now,
        };
        await tx
          .insert(calendarLink)
          .values({ accountId: userId, ...values })
          .onConflictDoUpdate({
            target: calendarLink.accountId,
            set: { ...values, version: sql`${calendarLink.version} + 1` },
          });
      } else if (!existing)
        await tx
          .insert(calendarLink)
          .values({ accountId: userId, state: "needs_permission" });
      return;
    }
    if (existing?.state === "active")
      await tx
        .update(calendarLink)
        .set({
          state: "needs_permission",
          refreshToken: null,
          leaseUntil: null,
          leaseToken: null,
          version: sql`${calendarLink.version} + 1`,
          updatedAt: now,
        })
        .where(eq(calendarLink.accountId, userId));
  };
  return transaction ? work(transaction) : db.transaction(work);
}

/** What the settings screen needs to draw the calendar switch. */
export async function calendarSettings(tx: DbTransaction, actor: Actor) {
  const available = calendarSyncEnabled();
  // Only a soldier holds seats, so only a soldier has the option.
  if (!available || actor.role !== "soldier")
    return { available } as { available: boolean; state?: CalendarState };
  const [google] = await tx
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, actor.id), eq(account.providerId, "google")));
  const [link] = await tx
    .select()
    .from(calendarLink)
    .where(eq(calendarLink.accountId, actor.id));
  const state = calendarState({ googleLinked: Boolean(google), link });
  return {
    available,
    state,
    version: link?.version,
    paused:
      link?.errorCode === "calendar_creation_pending" ||
      link?.errorCode === "calendar_creation_uncertain",
    // The button to remove the future duties is offered while the sync is off.
    removing: Boolean(link?.removeRequestedAt),
  };
}

/** The role is checked before anything else is read (decision 203): a manager takes no seat, so has no calendar. */
function soldierOnly(actor: Actor) {
  invariant(
    actor.role === "soldier",
    "forbidden",
    "היומן זמין לחיילים בלבד",
    403
  );
}

async function ownLink(
  tx: DbTransaction,
  actor: Actor,
  expectedVersion: number | undefined
) {
  invariant(
    calendarSyncEnabled(),
    "calendar_unavailable",
    "סנכרון היומן אינו מופעל במערכת",
    409
  );
  const [link] = await tx
    .select()
    .from(calendarLink)
    .where(eq(calendarLink.accountId, actor.id))
    .for("update");
  invariant(
    link?.state === "active",
    "calendar_permission_required",
    "נדרשת הרשאה ליומן Google. אפשר לאשר אותה במסך ההעדפות",
    409
  );
  invariant(
    link.version === expectedVersion,
    "conflict",
    "העדפות היומן השתנו. יש לרענן ולנסות שוב",
    409
  );
  return link;
}

/** The soldier's own switch. Requires a usable permission; a direct call without one is refused. */
export async function setCalendarSwitch(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  soldierOnly(actor);
  const input = z.object({ enabled: z.boolean() }).parse(payload);
  const link = await ownLink(tx, actor, expectedVersion);
  await tx
    .update(calendarLink)
    .set({
      enabled: input.enabled,
      // Switching on again starts from a clean slate: no pending removal and no backoff.
      ...(input.enabled && {
        removeRequestedAt: null,
        attempts: 0,
        nextAttemptAt: new Date(),
      }),
      updatedAt: new Date(),
      version: link.version + 1,
    })
    .where(eq(calendarLink.accountId, link.accountId));
  return { enabled: input.enabled };
}

/** "Remove the future duties from the calendar": done by the worker, and only while the sync is off. */
export async function requestFutureRemoval(
  tx: DbTransaction,
  actor: Actor,
  expectedVersion?: number
) {
  soldierOnly(actor);
  const link = await ownLink(tx, actor, expectedVersion);
  invariant(
    !link.enabled,
    "calendar_still_on",
    "אפשר להסיר את התורנויות מהיומן רק אחרי כיבוי הסנכרון",
    409
  );
  await tx
    .update(calendarLink)
    .set({
      removeRequestedAt: new Date(),
      attempts: 0,
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
      version: link.version + 1,
    })
    .where(eq(calendarLink.accountId, link.accountId));
  return { requested: true };
}

/** What a deleted account leaves to do at Google, kept in memory only. */
export type CalendarCleanup = {
  refreshToken: string;
  calendarId: string | null;
  eventIds: string[];
};

/**
 * Deletes the link and the event records of an account, in the transaction of its
 * deletion (decision 195). The token and the events still to be removed are returned
 * when the caller can reach Google afterwards; a restore, which must never call Google,
 * collects nothing and still removes the rows, so a restored token never comes back.
 */
export async function purgeCalendarLink(
  tx: DbTransaction,
  accountId: string,
  options: { collect: boolean }
): Promise<CalendarCleanup | undefined> {
  const [link] = await tx
    .delete(calendarLink)
    .where(eq(calendarLink.accountId, accountId))
    .returning();
  const events = await tx
    .delete(calendarEvent)
    .where(eq(calendarEvent.accountId, accountId))
    .returning();
  if (!options.collect || !link?.refreshToken) return undefined;
  let refreshToken: string;
  try {
    refreshToken = openSecret(link.refreshToken, {
      purpose: "calendar-refresh",
      recordId: link.accountId,
    });
  } catch {
    // A damaged ciphertext cannot delay erasure or leave a token in the database.
    console.error("Calendar cleanup token unavailable");
    return undefined;
  }
  const now = Date.now();
  return {
    refreshToken,
    calendarId: link.calendarId,
    eventIds: events
      .filter(
        (row) =>
          ["synced", "pending"].includes(row.status) &&
          row.startsAt.getTime() > now
      )
      .map((row) => row.googleEventId),
  };
}

const pending = new Set<Promise<void>>();
/**
 * After the deletion committed: remove the future events and revoke the token, as far
 * as Google answers. A failure leaves them, and the token is already gone here.
 */
export function scheduleCalendarCleanup(cleanup: CalendarCleanup) {
  const task: Promise<void> = (async () => {
    try {
      if (cleanup.calendarId && cleanup.eventIds.length) {
        const accessToken = await refreshAccessToken(cleanup.refreshToken);
        for (const id of cleanup.eventIds) {
          try {
            await removeEvent(accessToken, cleanup.calendarId, id);
          } catch {
            console.error("Calendar event cleanup incomplete");
          }
        }
      }
    } catch (error) {
      console.error(
        "Calendar cleanup incomplete",
        error instanceof Error ? error.name : "unknown"
      );
    }
    try {
      await revokeToken(cleanup.refreshToken);
    } catch {
      console.error("Calendar token revocation incomplete");
    }
  })().finally(() => {
    pending.delete(task);
  });
  pending.add(task);
  return task;
}
/** Waits for the cleanups in flight; used by tests and when the process stops. */
export async function settleCalendarCleanups() {
  await Promise.allSettled([...pending]);
}
