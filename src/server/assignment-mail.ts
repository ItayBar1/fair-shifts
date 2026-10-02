import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DbTransaction } from "./db";
import { emailOutbox, user } from "./auth-schema";
import { assignmentMailEvent, assignmentMailWindow, records } from "./schema";
import { createRecord } from "./repository";
import { enqueueEmail } from "./operations/email";
import { dutyFacts, windowEvents } from "./assignment-mail-delivery";
import { DELIVERY_WINDOW_MS } from "../domain/mail-delivery";
import {
  DIGEST_KIND,
  DIGEST_WINDOW_MS,
  isImmediate,
  netGroups,
  noticeAnnouncement,
  singleAnnouncement,
  type AssignmentChange,
} from "../domain/assignment-digest";
import { instant } from "../domain/time";

export interface AssignmentAnnouncement {
  soldierId: string;
  duty: { id: string; name: string; start: string; end: string };
  dutyVersion: number;
  change: AssignmentChange;
  /** The duty itself was cancelled, rather than the soldier taken out of it. */
  dutyCancelled?: boolean;
  /**
   * The start of the soldier's own part of the duty. Only a duty that has not
   * started is published, changed or cancelled, and it has no execution periods
   * yet, so this is the duty start; it is a parameter for the day that changes.
   */
  startsAt?: string;
}

const keyPrefix: Record<AssignmentChange, string> = {
  new: "publish",
  updated: "update",
  cancelled: "cancel",
};

/**
 * The open window of a recipient that can still take an event, or a new one. A
 * window whose time ran out, or whose mail is gone (cancelled by a restore, for
 * one), is closed first. Two announcements for the same recipient at once end up
 * in the same window, because the row is locked and the open window is unique.
 */
async function joinWindow(tx: DbTransaction, accountId: string, now: Date) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [open] = await tx
      .select()
      .from(assignmentMailWindow)
      .where(
        and(
          eq(assignmentMailWindow.recipientAccountId, accountId),
          eq(assignmentMailWindow.status, "open")
        )
      )
      .for("update");
    if (open) {
      const [mail] = await tx
        .select({ status: emailOutbox.status })
        .from(emailOutbox)
        .where(eq(emailOutbox.id, open.id));
      if (open.closesAt.getTime() > now.getTime() && mail?.status === "pending")
        return open;
      await tx
        .update(assignmentMailWindow)
        .set({ status: "closed", updatedAt: now })
        .where(eq(assignmentMailWindow.id, open.id));
    }
    const id = randomUUID();
    const closesAt = new Date(now.getTime() + DIGEST_WINDOW_MS);
    const [created] = await tx
      .insert(assignmentMailWindow)
      .values({
        id,
        recipientAccountId: accountId,
        opensAt: now,
        closesAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) continue;
    // The text is built when the mail is taken for delivery; this is only a placeholder.
    await tx.insert(emailOutbox).values({
      id,
      recipientAccountId: accountId,
      eventKey: `digest:${id}`,
      kind: DIGEST_KIND,
      priority: 1,
      title: "שיבוצים לתורנויות",
      body: "",
      nextAttemptAt: closesAt,
      expiresAt: new Date(closesAt.getTime() + DELIVERY_WINDOW_MS),
    });
    return created;
  }
  throw new Error("assignment window unavailable");
}

/**
 * The single site notice of a window: written at the first event and rewritten at
 * each one after it, so a read or hidden notice shows again as unread with the
 * new counts (decision 197). The rewrite is one statement, so a soldier marking
 * the notice read at the same moment cannot make the publishing fail.
 */
async function refreshNotice(
  tx: DbTransaction,
  win: typeof assignmentMailWindow.$inferSelect,
  soldierId: string,
  now: Date
) {
  const events = await windowEvents(tx, win.id);
  const ids = [...new Set(events.map((event) => event.dutyId))];
  const groups = netGroups(
    events.map((event) => ({
      dutyId: event.dutyId,
      change: event.change as AssignmentChange,
    })),
    await dutyFacts(tx, soldierId, ids),
    now,
    true
  );
  const notice = noticeAnnouncement(groups);
  if (!notice) return;
  // A notice about one duty keeps pointing at it, with the version it was written for.
  const only = ids.length === 1 ? events.at(-1) : undefined;
  const data = {
    accountId: win.recipientAccountId,
    title: notice.title,
    body: notice.body,
    href: notice.href,
    ...(only && { dutyId: only.dutyId, dutyVersion: only.dutyVersion }),
  };
  if (!win.notificationId) {
    const record = await createRecord(tx, "notification", data, soldierId);
    await tx
      .update(assignmentMailWindow)
      .set({ notificationId: record.id, updatedAt: now })
      .where(eq(assignmentMailWindow.id, win.id));
    return;
  }
  await tx
    .update(records)
    .set({
      data: sql`(${records.data} - 'readAt' - 'hiddenAt' - 'dutyId' - 'dutyVersion') || ${JSON.stringify(data)}::jsonb`,
      version: sql`${records.version} + 1`,
      updatedAt: now,
    })
    .where(eq(records.id, win.notificationId));
}

/**
 * Announces a published assignment, its change or its cancellation to the soldier
 * (decision 197). A duty starting within two hours is announced at once, apart,
 * with its own site notice and mail. Anything else joins the soldier's ten-minute
 * window: the site notice is written now, and one mail for the whole window goes
 * out when it closes, built from the state of the duties at that moment.
 * Call it after the change itself is saved, in the same transaction.
 */
export async function announceAssignment(
  tx: DbTransaction,
  input: AssignmentAnnouncement,
  now = new Date()
) {
  const [account] = await tx
    .select()
    .from(user)
    .where(eq(user.soldierId, input.soldierId));
  if (!account || account.deletedAt) return;
  const { duty, change } = input;
  const eventKey = `${keyPrefix[change]}:${duty.id}:${input.dutyVersion}:${account.id}`;
  if (isImmediate(now, input.startsAt ?? duty.start)) {
    const text = singleAnnouncement(change, {
      dutyId: duty.id,
      name: duty.name,
      dutyCancelled: input.dutyCancelled ?? false,
    });
    await createRecord(
      tx,
      "notification",
      {
        accountId: account.id,
        title: text.title,
        body: text.body,
        href: text.href,
        ...(change !== "new" && {
          dutyId: duty.id,
          dutyVersion: input.dutyVersion,
        }),
      },
      input.soldierId
    );
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey,
      kind: change === "new" ? "publication" : "publication-change",
      title: text.title,
      body: text.body,
      href: text.href,
      priority: 1,
      expiresAt: new Date(
        Math.min(now.getTime() + 86_400_000, instant(duty.end).toMillis())
      ),
    });
    return;
  }
  const [known] = await tx
    .select({ id: assignmentMailEvent.id })
    .from(assignmentMailEvent)
    .where(eq(assignmentMailEvent.eventKey, eventKey));
  if (known) return;
  const win = await joinWindow(tx, account.id, now);
  await tx.insert(assignmentMailEvent).values({
    id: randomUUID(),
    windowId: win.id,
    eventKey,
    dutyId: duty.id,
    dutyVersion: input.dutyVersion,
    change,
    occurredAt: now,
  });
  await refreshNotice(tx, win, input.soldierId, now);
}
