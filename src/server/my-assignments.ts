import { and, eq, gt, gte, inArray } from "drizzle-orm";
import { db } from "./db";
import { assignmentFeed, assignments, duties } from "./schema";
import { emailOutbox, user } from "./auth-schema";
import { assertActorCurrent, type Actor } from "./auth/accounts";
import { invariant } from "./errors";
import {
  personalAssignmentList,
  type PersonalAssignment,
  type FeedEvent,
} from "../domain/my-assignments";

export async function readMyAssignments(
  actor: Actor,
  mailId?: string,
  now = new Date()
) {
  const validMailId =
    mailId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      mailId
    )
      ? mailId
      : undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(
        async (tx) => {
          // Repeatable read keeps the list and cursor in one snapshot. Only this
          // account is locked; domain writes still serialize feed sequence allocation
          // with their unit lock, so later commits cannot overtake unseen feed events.
          const account = await assertActorCurrent(actor, tx);
          invariant(
            actor.role !== "technical" && account.soldierId,
            "forbidden",
            "העמוד אינו זמין לחשבון שלך",
            403
          );
          const soldierId = account.soldierId;
          // A transaction has one PostgreSQL connection; keep its queries sequential.
          const dutyRows = await tx.select().from(duties);
          const assignmentRows = await tx
            .select()
            .from(assignments)
            .where(eq(assignments.soldierId, soldierId));
          const eventRows = await tx
            .select()
            .from(assignmentFeed)
            .where(
              and(
                eq(assignmentFeed.soldierId, soldierId),
                gt(assignmentFeed.id, account.assignmentFeedCursor),
                gte(assignmentFeed.happenedAt, account.invitedAt)
              )
            )
            .orderBy(assignmentFeed.id);
          const mailRows = validMailId
            ? await tx
                .select({ dutyIds: emailOutbox.dutyIds })
                .from(emailOutbox)
                .where(
                  and(
                    eq(emailOutbox.id, validMailId),
                    eq(emailOutbox.recipientAccountId, account.id)
                  )
                )
            : [];
          const highlightedDutyIds = mailRows[0]?.dutyIds ?? [];
          const mailHistory = highlightedDutyIds.length
            ? await tx
                .select()
                .from(assignmentFeed)
                .where(
                  and(
                    eq(assignmentFeed.soldierId, soldierId),
                    inArray(assignmentFeed.dutyId, highlightedDutyIds)
                  )
                )
                .orderBy(assignmentFeed.id)
            : [];
          const dutyById = new Map(dutyRows.map((row) => [row.id, row]));
          const history = assignmentRows.some((row) => {
            const duty = dutyById.get(row.dutyId);
            return (
              duty &&
              (duty.data.status === "published" || duty.data.wasPublished)
            );
          });
          invariant(
            actor.role !== "manager" || history,
            "forbidden",
            "העמוד אינו זמין לחשבון שלך",
            403
          );
          const current: PersonalAssignment[] = assignmentRows.flatMap(
            (row) => {
              const duty = dutyById.get(row.dutyId);
              if (
                !duty ||
                duty.data.status !== "published" ||
                !["reserved", "held", "credited"].includes(row.status)
              )
                return [];
              const slot = duty.data.slots.find(
                (item) => item.id === row.slotId
              );
              return [
                {
                  dutyId: duty.id,
                  assignmentId: row.id,
                  name: duty.name,
                  role: slot?.role ?? "תפקיד",
                  start: row.data.performedStart ?? duty.data.start,
                  end: row.data.performedEnd ?? duty.data.end,
                  location: duty.data.location ?? "",
                },
              ];
            }
          );
          const list = personalAssignmentList(
            current,
            eventRows as FeedEvent[],
            now.toISOString(),
            highlightedDutyIds,
            mailHistory as FeedEvent[]
          );
          const lastId = eventRows.at(-1)?.id;
          if (lastId !== undefined)
            await tx
              .update(user)
              .set({ assignmentFeedCursor: lastId })
              .where(eq(user.id, account.id));
          return {
            ...list,
            viewedThrough: lastId ?? account.assignmentFeedCursor,
          };
        },
        { isolationLevel: "repeatable read" }
      );
    } catch (error) {
      let cause: unknown = error,
        retryable = false;
      for (
        let depth = 0;
        depth < 4 && cause && typeof cause === "object";
        depth++
      ) {
        if ("code" in cause && ["40001", "40P01"].includes(String(cause.code)))
          retryable = true;
        cause = "cause" in cause ? cause.cause : undefined;
      }
      if (!retryable || attempt >= 4) throw error;
    }
  }
}
