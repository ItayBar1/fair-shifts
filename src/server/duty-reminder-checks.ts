import { and, eq, inArray, like } from "drizzle-orm";
import type { DbTransaction } from "./db";
import { assignments, duties, soldiers } from "./schema";
import { emailOutbox, user } from "./auth-schema";
import { canAccessAfterService } from "../domain/eligibility";
import { parseDutyReminderKey } from "../domain/duty-reminders";
import type { Soldier } from "../domain/types";

/** Seat states that still expect the soldier at the duty. */
export const ACTIVE_SEAT = ["reserved", "held"];

export function hasAccess(
  person: typeof soldiers.$inferSelect | undefined,
  now: Date
) {
  return Boolean(
    person &&
    !person.deletedAt &&
    canAccessAfterService(person.data as Soldier, now.toISOString())
  );
}

/**
 * Checked right before delivery: the duty is still published with the same start and
 * has not started, and the recipient still holds a seat in it and has access.
 * Preferences are checked separately against the reminder hours.
 */
export async function dutyReminderRelevant(
  tx: DbTransaction,
  eventKey: string,
  accountId: string,
  now: Date
) {
  const key = parseDutyReminderKey(eventKey);
  if (!key || key.accountId !== accountId) return false;
  const [duty] = await tx
    .select()
    .from(duties)
    .where(eq(duties.id, key.dutyId));
  if (
    !duty ||
    duty.data.status !== "published" ||
    Date.parse(duty.data.start) !== key.start ||
    key.start <= now.getTime()
  )
    return false;
  const [account] = await tx
    .select({ soldierId: user.soldierId, deletedAt: user.deletedAt })
    .from(user)
    .where(eq(user.id, accountId));
  if (!account?.soldierId || account.deletedAt) return false;
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, account.soldierId));
  if (!hasAccess(person, now)) return false;
  const [seat] = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(
        eq(assignments.dutyId, duty.id),
        eq(assignments.soldierId, account.soldierId),
        inArray(assignments.status, ACTIVE_SEAT)
      )
    );
  return Boolean(seat);
}

/**
 * A published change, transfer or cancellation cancels the queued reminders of the
 * old start and of soldiers who no longer hold a seat. Reminders that still match
 * are kept, so a change that keeps the start does not repeat them.
 */
export async function cancelStaleDutyReminders(
  tx: DbTransaction,
  dutyId: string,
  now = new Date()
) {
  const queued = await tx
    .select()
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.kind, "duty-reminder"),
        inArray(emailOutbox.status, ["pending", "sending"]),
        like(emailOutbox.eventKey, `reminder:${dutyId}:%`)
      )
    );
  for (const message of queued) {
    if (
      await dutyReminderRelevant(
        tx,
        message.eventKey,
        message.recipientAccountId,
        now
      )
    )
      continue;
    await tx
      .update(emailOutbox)
      .set({
        status: "cancelled",
        error: "superseded",
        destination: null,
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(emailOutbox.id, message.id));
  }
}
