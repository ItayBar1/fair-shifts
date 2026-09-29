import { eq } from "drizzle-orm";
import type { DbTransaction } from "./db";
import { soldiers, records, assignments } from "./schema";
import { user } from "./auth-schema";
import { createRecord } from "./repository";
import { revokeAccess } from "./auth/accounts";
import { enqueueEmail } from "./operations/email";
import { reassessAssignments } from "./personnel";
import { canAccessAfterService } from "../domain/eligibility";
import { localDate } from "../domain/time";

/**
 * Worker step after the end of a release day. Access is already refused on
 * every request by `accountAvailable`; this records one departure per soldier
 * and release date and tells the managers once. The caller holds the unit lock,
 * so a repeated run, or a run after downtime, finds the earlier record and adds
 * nothing. Each manager also gets an email subject to the "departure" switch
 * (decision 170). Nothing is deleted: deletion stays a manager's decision.
 */
export async function announceDepartures(tx: DbTransaction, now = new Date()) {
  const people = await tx.select().from(soldiers);
  const departures = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "departure"));
  let announced = 0;
  for (const person of people) {
    const releaseDate = person.data.service.releaseDate;
    if (
      person.deletedAt ||
      !releaseDate ||
      canAccessAfterService(person.data, now.toISOString()) ||
      departures.some(
        (row) =>
          row.subjectId === person.id && row.data.releaseDate === releaseDate
      )
    )
      continue;
    // Reservations that run past the boundary are flagged, never released here.
    await reassessAssignments(tx, person.id);
    const flagged = (
      await tx
        .select()
        .from(assignments)
        .where(eq(assignments.soldierId, person.id))
    ).filter(
      (row) =>
        row.status === "reserved" &&
        (row.data.needsAttention ?? []).includes("released")
    ).length;
    const departure = await createRecord(
      tx,
      "departure",
      {
        soldierId: person.id,
        releaseDate,
        detectedAt: now.toISOString(),
        flaggedAssignments: flagged,
      },
      person.id
    );
    const accounts = await tx.select().from(user);
    // Clears sessions and pending sign-in codes the request check already refuses.
    for (const account of accounts.filter((row) => row.soldierId === person.id))
      await revokeAccess(tx, account.id);
    const date = localDate(releaseDate).toFormat("dd.MM.yyyy");
    const title = "סיום שירות";
    const body =
      `השירות של ${person.name} הסתיים ב־${date}. הגישה לחשבון נחסמה והרשומה נשמרה; מחיקה היא החלטת אחראי.` +
      (flagged
        ? ` ${flagged} שיבוצים שמורים חורגים ממועד השחרור ומסומנים לטיפול.`
        : "");
    const href = "/manage/soldiers";
    for (const recipient of accounts.filter(
      (row) =>
        row.role === "manager" && !row.deletedAt && row.soldierId !== person.id
    )) {
      await createRecord(tx, "notification", {
        accountId: recipient.id,
        title,
        body,
        href,
        departureId: departure.id,
      });
      // Sent only if the manager's "departure" switch is on at delivery time.
      await enqueueEmail(tx, {
        recipientAccountId: recipient.id,
        eventKey: `departure:${departure.id}:${recipient.id}`,
        kind: "departure",
        title,
        body,
        href,
        expiresAt: new Date(now.getTime() + 86_400_000),
      });
    }
    announced++;
  }
  return announced;
}
