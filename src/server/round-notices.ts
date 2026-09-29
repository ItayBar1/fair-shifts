import { and, eq, like } from "drizzle-orm";
import type { DbTransaction } from "./db";
import { records } from "./schema";
import { emailOutbox } from "./auth-schema";
import { createRecord, type Workflow } from "./repository";
import { enqueueEmail } from "./operations/email";
import { roundRecipients, roundSubmitters } from "./round-recipients";
import {
  acceptsSubmissions,
  closingReminderAt,
  roundEventKey,
  roundGeneration,
  roundNoticeText,
  windowStart,
  type RoundNotice,
  type RoundNoticePhase,
  type RoundWindow,
} from "../domain/round-notices";

async function send(
  tx: DbTransaction,
  round: Workflow,
  notice: RoundNotice,
  now: Date
) {
  const data = round.data as RoundWindow;
  const generation = roundGeneration(data);
  const recipients = await roundRecipients(tx, round, now);
  // Only the opening reaches everyone; the rest are for soldiers who have not submitted.
  const submitted =
    notice === "opening"
      ? new Set<string | null>()
      : await roundSubmitters(tx, round.id);
  const targets = recipients.filter(
    (person) => !submitted.has(person.soldierId)
  );
  const { title, body } = roundNoticeText(notice, {
    name: round.data.name,
    closesAt: data.closesAt,
  });
  const href = "/constraints";
  let emails = 0;
  for (const person of targets) {
    await createRecord(
      tx,
      "notification",
      {
        ...(person.accountId && { accountId: person.accountId }),
        title,
        body,
        href,
        roundId: round.id,
        generation,
        notice,
      },
      person.soldierId
    );
    if (!person.accountId) continue;
    // The site notice stays even when preferences later cancel the email.
    await enqueueEmail(tx, {
      recipientAccountId: person.accountId,
      eventKey: roundEventKey(round.id, generation, notice, person.accountId),
      kind: notice === "closing" ? "round-closing" : "round-opening",
      title,
      body,
      href,
      expiresAt: new Date(data.closesAt),
    });
    emails++;
  }
  return { recipients: targets.length, emails };
}

async function mark(
  tx: DbTransaction,
  round: Workflow,
  phase: RoundNoticePhase,
  notice: RoundNotice,
  now: Date,
  result: { recipients: number; emails: number } | "merged"
) {
  await createRecord(tx, "round_notice", {
    roundId: round.id,
    generation: roundGeneration(round.data as RoundWindow),
    phase,
    notice,
    at: now.toISOString(),
    ...(result === "merged"
      ? { status: "merged", recipients: 0, emails: 0 }
      : { status: "sent", ...result }),
  });
}

/**
 * Creates due round notices once per generation. Runs inside the unit transaction,
 * so it never interleaves with a submission. After downtime, a closed round is
 * skipped, and a start notice that is due together with the closing reminder is
 * merged into it.
 */
export async function refreshRoundNotices(tx: DbTransaction, now = new Date()) {
  const rounds = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "round"));
  const markers = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "round_notice"));
  let created = 0;
  for (const round of rounds) {
    const data = round.data as RoundWindow;
    if (!acceptsSubmissions(data, now.getTime())) continue;
    const generation = roundGeneration(data);
    const own = markers.filter((row) => row.data.roundId === round.id);
    const done = (phase: RoundNoticePhase) =>
      own.some(
        (row) => row.data.generation === generation && row.data.phase === phase
      );
    const closingAt = closingReminderAt(data);
    const closingDue = closingAt !== null && now.getTime() >= closingAt;
    if (!done("start") && now.getTime() >= windowStart(data)) {
      const notice: RoundNotice = !own.some((row) => row.data.phase === "start")
        ? "opening"
        : round.data.reopenKind === "extension"
          ? "extension"
          : "reopening";
      await mark(
        tx,
        round,
        "start",
        notice,
        now,
        closingDue ? "merged" : await send(tx, round, notice, now)
      );
      created++;
    }
    if (closingDue && !done("closing")) {
      await mark(
        tx,
        round,
        "closing",
        "closing",
        now,
        await send(tx, round, "closing", now)
      );
      created++;
    }
  }
  return created;
}

/** Closing or changing the window cancels queued emails of the old window. */
export async function cancelRoundEmails(tx: DbTransaction, roundId: string) {
  await tx
    .update(emailOutbox)
    .set({
      status: "cancelled",
      error: "superseded",
      destination: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(emailOutbox.status, "pending"),
        like(emailOutbox.eventKey, `round:${roundId}:%`)
      )
    );
}
