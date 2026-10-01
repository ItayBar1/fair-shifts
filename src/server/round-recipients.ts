import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "./db";
import { records, soldiers } from "./schema";
import { user } from "./auth-schema";
import type { Workflow } from "./repository";
import type { Soldier } from "../domain/types";
import { canAccessAfterService } from "../domain/eligibility";
import {
  acceptsSubmissions,
  parseRoundEventKey,
  roundGeneration,
  servesDuringRound,
  type RoundWindow,
} from "../domain/round-notices";

type RoundData = RoundWindow & { targetStart: string; targetEnd: string };

function receives(
  person: typeof soldiers.$inferSelect,
  round: RoundData,
  now: Date
) {
  const data = {
    ...person.data,
    deletedAt: person.deletedAt?.toISOString(),
  } as Soldier;
  return (
    canAccessAfterService(data, now.toISOString()) &&
    servesDuringRound(data.service, round)
  );
}

/**
 * Soldiers whose service overlaps the target period and who still have access.
 * A duty manager is not assigned to duties and so is not a recipient (decision
 * 192, which replaces the inclusion in decision 169). Soldiers without an
 * account get the site notice only.
 */
export async function roundRecipients(
  tx: DbTransaction,
  round: Workflow,
  now: Date
) {
  const people = (
    await tx.select().from(soldiers).where(isNull(soldiers.deletedAt))
  ).filter((person) => receives(person, round.data as RoundData, now));
  const accounts = people.length
    ? await tx
        .select({
          id: user.id,
          soldierId: user.soldierId,
          role: user.role,
        })
        .from(user)
        .where(
          and(
            inArray(
              user.soldierId,
              people.map((person) => person.id)
            ),
            isNull(user.deletedAt)
          )
        )
    : [];
  const managers = new Set(
    accounts
      .filter((account) => account.role === "manager")
      .map((account) => account.soldierId)
  );
  return people
    .filter((person) => !managers.has(person.id))
    .map((person) => ({
      soldierId: person.id,
      accountId:
        accounts.find((account) => account.soldierId === person.id)?.id ?? null,
    }));
}

/** Any item or "no constraints" declaration in the round, including a rejected one. */
export async function roundSubmitters(tx: DbTransaction, roundId: string) {
  const rows = await tx
    .select({ subjectId: records.subjectId })
    .from(records)
    .where(
      and(
        eq(records.kind, "constraint"),
        sql`${records.data}->>'roundId' = ${roundId}`
      )
    );
  return new Set(rows.map((row) => row.subjectId));
}

/**
 * Checked right before delivery: the round is still open in the same generation,
 * the recipient still belongs to it, and reminders go only to non-submitters.
 */
export async function roundEmailRelevant(
  tx: DbTransaction,
  eventKey: string,
  accountId: string,
  now: Date
) {
  const key = parseRoundEventKey(eventKey);
  if (!key || key.accountId !== accountId) return false;
  const [round] = await tx
    .select()
    .from(records)
    .where(and(eq(records.id, key.roundId), eq(records.kind, "round")));
  if (!round) return false;
  const data = round.data as RoundData;
  if (
    !acceptsSubmissions(data, now.getTime()) ||
    roundGeneration(data) !== key.generation
  )
    return false;
  const [account] = await tx
    .select({ soldierId: user.soldierId, role: user.role })
    .from(user)
    .where(eq(user.id, accountId));
  // By the role at delivery time: a soldier appointed after the notice is queued no longer receives it.
  if (!account?.soldierId || account.role === "manager") return false;
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, account.soldierId));
  if (!person || person.deletedAt || !receives(person, data, now)) return false;
  return (
    key.notice === "opening" ||
    !(await roundSubmitters(tx, round.id)).has(person.id)
  );
}
