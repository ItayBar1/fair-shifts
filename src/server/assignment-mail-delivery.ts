import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbTransaction } from "./db";
import {
  assignmentMailEvent,
  assignmentMailWindow,
  assignments,
  duties,
} from "./schema";
import { user } from "./auth-schema";
import { ACTIVE_SEAT } from "./duty-reminder-checks";
import {
  digestMail,
  netGroups,
  type DutyFacts,
} from "../domain/assignment-digest";

/** The base of the links in a mail; the site address the mail is read against. */
export const siteBase = () =>
  process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

/** What is true now of the given duties for one soldier, as a window is read. */
export async function dutyFacts(
  tx: DbTransaction,
  soldierId: string,
  dutyIds: string[]
): Promise<Map<string, DutyFacts>> {
  const facts = new Map<string, DutyFacts>();
  if (!dutyIds.length) return facts;
  const rows = await tx
    .select({ id: duties.id, name: duties.name, data: duties.data })
    .from(duties)
    .where(inArray(duties.id, dutyIds));
  const seats = await tx
    .select({ dutyId: assignments.dutyId })
    .from(assignments)
    .where(
      and(
        eq(assignments.soldierId, soldierId),
        inArray(assignments.dutyId, dutyIds),
        inArray(assignments.status, ACTIVE_SEAT)
      )
    );
  const held = new Set(seats.map((seat) => seat.dutyId));
  for (const row of rows)
    facts.set(row.id, {
      id: row.id,
      name: row.name,
      start: row.data.start,
      end: row.data.end,
      status: row.data.status,
      held: held.has(row.id),
    });
  return facts;
}

/** The events of a window, oldest first. */
export const windowEvents = (tx: DbTransaction, windowId: string) =>
  tx
    .select()
    .from(assignmentMailEvent)
    .where(eq(assignmentMailEvent.windowId, windowId))
    .orderBy(asc(assignmentMailEvent.seq));

/**
 * Freezes a window once its mail is taken for delivery: an event that comes after
 * opens a new window. The claim and a concurrent announcement both lock the row,
 * so each event ends up in exactly one mail.
 */
export async function closeWindow(
  tx: DbTransaction,
  windowId: string,
  now: Date
) {
  await tx
    .update(assignmentMailWindow)
    .set({ status: "closed", updatedAt: now })
    .where(
      and(
        eq(assignmentMailWindow.id, windowId),
        eq(assignmentMailWindow.status, "open")
      )
    );
}

/** A closed window of the recipient's account never receives an event again. */
export async function closeWindowsOf(tx: DbTransaction, accountId: string) {
  await tx
    .update(assignmentMailWindow)
    .set({ status: "closed", updatedAt: new Date() })
    .where(
      and(
        eq(assignmentMailWindow.recipientAccountId, accountId),
        eq(assignmentMailWindow.status, "open")
      )
    );
}

/**
 * The mail of a window from the state at delivery (decision 197): null when
 * nothing is left to announce, so no empty mail goes out.
 */
export async function buildWindowMail(
  tx: DbTransaction,
  windowId: string,
  accountId: string,
  now: Date
) {
  const [account] = await tx
    .select({ soldierId: user.soldierId })
    .from(user)
    .where(eq(user.id, accountId));
  if (!account?.soldierId) return null;
  const events = await windowEvents(tx, windowId);
  const facts = await dutyFacts(tx, account.soldierId, [
    ...new Set(events.map((event) => event.dutyId)),
  ]);
  const groups = netGroups(
    events.map((event) => ({
      dutyId: event.dutyId,
      change: event.change as "new" | "updated" | "cancelled",
    })),
    facts,
    now,
    false
  );
  const mail = digestMail(groups, siteBase(), windowId);
  // Freeze the same duties as the actual mail, including cancellations and
  // excluding publications cancelled within this window (decision 202).
  return mail
    ? {
        ...mail,
        dutyIds: Object.values(groups)
          .flat()
          .map((line) => line.dutyId),
      }
    : null;
}
