import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DbTransaction } from "./db";
import { assignments, duties, soldiers } from "./schema";
import { operationsState, user } from "./auth-schema";
import { createRecord } from "./repository";
import { enqueueEmail } from "./operations/email";
import { effectivePreferences } from "./notifications";
import { ACTIVE_SEAT, hasAccess } from "./duty-reminder-checks";
import {
  dueReminder,
  dutyReminderKey,
  dutyReminderText,
} from "../domain/duty-reminders";

const STATE_KEY = "duty-reminders";

type DutyRow = typeof duties.$inferSelect;

/**
 * Creates the duty reminders that became due since the previous run. Runs inside the
 * unit transaction, so the run marker and the reminders commit together and two
 * workers never create the same reminder. A soldier without an account gets nothing:
 * a reminder is time-bound and cannot be read later.
 */
export async function refreshDutyReminders(
  tx: DbTransaction,
  now = new Date()
) {
  const [state] = await tx
    .select()
    .from(operationsState)
    .where(eq(operationsState.key, STATE_KEY));
  const last = Date.parse(String(state?.data.lastRunAt ?? ""));
  // The first run does not reach back: times before it were never scheduled.
  const since = Number.isNaN(last) ? now.getTime() - 60_000 : last;
  const upcoming = (await tx.select().from(duties)).filter(
    (row) =>
      row.data.status === "published" &&
      Date.parse(row.data.start) > now.getTime()
  );
  let created = 0;
  if (upcoming.length) {
    const seats = await tx
      .select()
      .from(assignments)
      .where(
        and(
          inArray(
            assignments.dutyId,
            upcoming.map((row) => row.id)
          ),
          inArray(assignments.status, ACTIVE_SEAT)
        )
      );
    const people = seats.length
      ? await tx
          .select()
          .from(soldiers)
          .where(
            inArray(
              soldiers.id,
              seats.map((seat) => seat.soldierId)
            )
          )
      : [];
    const accounts = seats.length
      ? await tx
          .select({ id: user.id, soldierId: user.soldierId })
          .from(user)
          .where(
            and(
              inArray(
                user.soldierId,
                seats.map((seat) => seat.soldierId)
              ),
              isNull(user.deletedAt)
            )
          )
      : [];
    for (const seat of seats) {
      const duty = upcoming.find((row) => row.id === seat.dutyId)!;
      const account = accounts.find((row) => row.soldierId === seat.soldierId);
      const person = people.find((row) => row.id === seat.soldierId);
      if (!account || !hasAccess(person, now)) continue;
      const { preferences, changedAt } = await effectivePreferences(
        tx,
        account.id
      );
      const start = Date.parse(duty.data.start);
      const published = Date.parse(String(duty.data.publishedAt ?? ""));
      const reminder = dueReminder({
        start,
        hours: preferences.reminderHours,
        since,
        knownAt: Math.max(
          seat.createdAt.getTime(),
          Number.isNaN(published) ? 0 : published,
          changedAt?.getTime() ?? 0
        ),
        now: now.getTime(),
      });
      if (!reminder) continue;
      await send(tx, duty, seat.soldierId, account.id, reminder, start);
      created++;
    }
  }
  // Never moves back, so an earlier clock cannot repeat a window already handled.
  const data = {
    lastRunAt: new Date(Math.max(since, now.getTime())).toISOString(),
  };
  await tx
    .insert(operationsState)
    .values({ key: STATE_KEY, data, updatedAt: now })
    .onConflictDoUpdate({
      target: operationsState.key,
      set: { data, updatedAt: now },
    });
  return created;
}

async function send(
  tx: DbTransaction,
  duty: DutyRow,
  soldierId: string,
  accountId: string,
  reminder: { hours: number; merged: number[] },
  start: number
) {
  const { title, body } = dutyReminderText({
    name: duty.name,
    start: duty.data.start,
  });
  const href = `/duties/${duty.id}`;
  await createRecord(
    tx,
    "notification",
    {
      accountId,
      title,
      body,
      href,
      dutyId: duty.id,
      reminderHours: reminder.hours,
      ...(reminder.merged.length && { mergedHours: reminder.merged }),
      startsAt: duty.data.start,
    },
    soldierId
  );
  // The site notice stays even when preferences later cancel the email.
  await enqueueEmail(tx, {
    recipientAccountId: accountId,
    eventKey: dutyReminderKey(duty.id, start, reminder.hours, accountId),
    kind: "duty-reminder",
    reminderHours: reminder.hours,
    title,
    body,
    href,
    expiresAt: new Date(start),
  });
}
