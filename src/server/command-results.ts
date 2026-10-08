import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DbTransaction } from "./db";
import {
  assignments,
  commandResults,
  commandResultSubjects,
  records,
  soldierContacts,
  soldiers,
} from "./schema";
import { user } from "./auth-schema";

export const RESULT_RETENTION_MS = 30 * 86_400_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function strings(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === "string") result.add(value);
  else if (Array.isArray(value))
    for (const item of value) strings(item, result);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) strings(item, result);
  return result;
}

/** Resolve subjects before sensitive workflow/contact data is erased. */
export async function linkCommandResult(
  tx: DbTransaction,
  commandId: string,
  type: string,
  payload: unknown,
  result: unknown
) {
  const references = strings(payload, strings(result));
  const ids = [...references].filter((value) => uuid.test(value));
  const [stored] = await tx
    .select()
    .from(commandResults)
    .where(eq(commandResults.id, commandId));
  const workflows = ids.length
    ? await tx.select().from(records).where(inArray(records.id, ids))
    : [];
  const batch = type.startsWith("import.")
    ? (workflows.find((row) => ["import", "import_restore"].includes(row.kind))
        ?.id ?? stored.importBatchId)
    : stored.importBatchId;
  if (batch)
    await tx
      .update(commandResults)
      .set({ importBatchId: batch })
      .where(eq(commandResults.id, commandId));
  const details = batch
    ? await tx
        .select()
        .from(records)
        .where(
          and(
            eq(records.kind, "import_row"),
            sql`${records.data}->>'batchId' = ${batch}`
          )
        )
    : [];
  for (const row of [...workflows, ...details]) {
    if (row.subjectId) references.add(row.subjectId);
    strings(row.data, references);
  }
  const referencedIds = [...references].filter((value) => uuid.test(value));
  const seats = referencedIds.length
    ? await tx
        .select()
        .from(assignments)
        .where(
          or(
            inArray(assignments.id, referencedIds),
            inArray(assignments.dutyId, referencedIds)
          )
        )
    : [];
  for (const seat of seats) {
    references.add(seat.soldierId);
    strings(seat.data, references);
  }
  const accounts = references.size
    ? await tx
        .select()
        .from(user)
        .where(inArray(user.id, [...references]))
    : [];
  for (const account of accounts)
    if (account.soldierId) references.add(account.soldierId);
  const people = await tx
    .select({ id: soldiers.id, number: soldiers.personalNumber })
    .from(soldiers);
  const contacts = await tx.select().from(soldierContacts);
  const contactSubjects = new Set(
    contacts
      .filter((contact) =>
        [contact.email, contact.phone, contact.address].some(
          (value) => value && references.has(value)
        )
      )
      .map((contact) => contact.soldierId)
  );
  const subjects = people.filter(
    (person) =>
      references.has(person.id) ||
      references.has(person.number) ||
      contactSubjects.has(person.id)
  );
  // Applying a new import completes earlier preview/get results' links atomically.
  const commands = batch
    ? await tx
        .select({ id: commandResults.id })
        .from(commandResults)
        .where(eq(commandResults.importBatchId, batch))
    : [{ id: commandId }];
  for (const command of commands)
    for (const subject of subjects)
      await tx
        .insert(commandResultSubjects)
        .values({
          id: randomUUID(),
          commandId: command.id,
          soldierId: subject.id,
        })
        .onConflictDoNothing();
}

export async function expireCommandResults(
  tx: DbTransaction,
  now = new Date(),
  commandId?: string
) {
  await tx
    .update(commandResults)
    .set({ result: { expiredAt: now.toISOString() }, contentExpiredAt: now })
    .where(
      and(
        isNull(commandResults.contentExpiredAt),
        lte(
          commandResults.createdAt,
          new Date(now.getTime() - RESULT_RETENTION_MS)
        ),
        commandId ? eq(commandResults.id, commandId) : undefined
      )
    );
}

export async function eraseLinkedCommandResults(
  tx: DbTransaction,
  soldierId: string,
  needles: string[],
  at: string
) {
  const links = await tx
    .select({ id: commandResultSubjects.commandId })
    .from(commandResultSubjects)
    .where(eq(commandResultSubjects.soldierId, soldierId));
  await tx
    .update(commandResults)
    .set({ result: { erasedAt: at }, contentExpiredAt: new Date(at) })
    .where(
      and(
        isNull(commandResults.contentExpiredAt),
        or(
          eq(commandResults.linkageComplete, false),
          links.length
            ? inArray(
                commandResults.id,
                links.map((link) => link.id)
              )
            : undefined,
          ...needles
            .filter(Boolean)
            .map(
              (needle) =>
                sql`position(${needle} in ${commandResults.result}::text) > 0`
            )
        )
      )
    );
}
