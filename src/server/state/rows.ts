/** What each role's read loads, and how a soldier's copy is cut down (decision 235). */
import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { AuditAccount } from "../audit-log";
import type { Actor } from "../auth/accounts";
import {
  domainOf,
  loadDomain,
  managerSoldierIds,
  type Workflow,
} from "../repository";
import {
  assignments,
  balances,
  duties,
  dutyTypes,
  ledger,
  records,
  soldierContacts,
  soldiers,
} from "../schema";
import { user } from "../auth-schema";
import { projectRequests } from "../transfers";
import { projectSwaps } from "../swaps";
import { projectCancellationRequests } from "../cancellation-requests";
import { effectivePreferences } from "../notifications";
import { resolvePreferences } from "../../domain/notification-preferences";
import type { DbTransaction } from "../db";

export async function preferencesState(tx: DbTransaction, actor: Actor) {
  const current = await effectivePreferences(tx, actor.id);
  return {
    ...current.preferences,
    source: current.source,
    version: current.version,
  };
}
export function unitDefaults(workflows: (typeof records.$inferSelect)[]) {
  const row = workflows.find((item) => item.kind === "notification_defaults");
  return {
    ...resolvePreferences(null, row?.data).preferences,
    version: row?.version,
  };
}

export async function auditAccountsOf(
  tx: DbTransaction
): Promise<AuditAccount[]> {
  return tx
    .select({
      id: user.id,
      name: user.name,
      role: user.role,
      soldierId: user.soldierId,
    })
    .from(user);
}

export type DomainState = ReturnType<typeof domainOf>;
export type DutyView = DomainState["duties"][number];
export type SeatView = DomainState["assignments"][number];

/** What a soldier sees of a published duty. */
export function soldierDuty(row: DutyView) {
  return {
    id: row.id,
    name: row.name,
    start: row.start,
    end: row.end,
    status: row.status,
    wasPublished: row.wasPublished,
    location: row.location,
    instructions: row.instructions,
    version: row.version,
    slots: row.slots.map((slot) => ({ id: slot.id, name: slot.role })),
  };
}
/** What a soldier sees of a seat on a published duty. */
export function soldierAssignment(row: SeatView) {
  return {
    id: row.id,
    dutyId: row.dutyId,
    slotId: row.slotId,
    soldierId: row.soldierId,
    status: row.status,
    points: row.points,
    version: row.version,
    // Who covers which part of a split seat is part of the published schedule.
    ...(row.performedStart && {
      performedStart: row.performedStart,
      performedEnd: row.performedEnd,
    }),
    ...(row.performance && {
      performance: {
        performerId: row.performance.performerId,
        start: row.performance.start,
        end: row.performance.end,
        points: row.performance.points,
      },
    }),
  };
}
/** No reason: a soldier sees no manager's reasons (decision 168). */
export function soldierLedger(row: typeof ledger.$inferSelect) {
  return {
    id: row.id,
    soldierId: row.soldierId,
    amount: row.amount,
    before: row.before,
    after: row.after,
    effectiveAt: row.effectiveAt,
    kind: row.kind,
  };
}
export function unitRequests(
  workflows: Workflow[],
  actor: Actor,
  managing: boolean
) {
  return [
    ...projectRequests(
      workflows.filter(
        (row) => row.data.type !== "cancellation" && row.data.type !== "swap"
      ),
      actor,
      managing
    ),
    ...projectSwaps(workflows, actor, managing),
    ...projectCancellationRequests(workflows, actor, managing),
  ];
}
/** A notification addressed to an account belongs to it alone; hidden copies leave the inbox. */
export function ownNotifications(workflows: Workflow[], actor: Actor) {
  return workflows
    .filter(
      (row) =>
        row.kind === "notification" &&
        !row.data.hiddenAt &&
        (typeof row.data.accountId === "string"
          ? row.data.accountId === actor.id
          : Boolean(actor.soldierId) && row.subjectId === actor.soldierId)
    )
    .map((row) => ({ ...row.data, id: row.id, version: row.version }));
}

/** The records whose notifications are the reader's own: an account's or the soldier's. */
export function ownNotice(actor: Actor) {
  return and(
    eq(records.kind, "notification"),
    or(
      sql`${records.data}->>'accountId' = ${actor.id}`,
      actor.soldierId
        ? and(
            sql`${records.data}->>'accountId' is null`,
            eq(records.subjectId, actor.soldierId)
          )
        : undefined
    )
  );
}
/** A duty a soldier may see: published, or cancelled after it was published. */
export const visibleDuty = or(
  sql`${duties.data}->>'status' = 'published'`,
  and(
    sql`${duties.data}->>'status' = 'cancelled'`,
    sql`${duties.data}->>'wasPublished' = 'true'`
  )
);
export const dutyEnd = sql`(${duties.data}->>'end')::timestamptz`;

/** Everything a manager works with; other accounts' notices stay out. */
export async function staffRows(tx: DbTransaction, actor: Actor) {
  return {
    state: await loadDomain(tx),
    contacts: await tx.select().from(soldierContacts),
    catalog: await tx.select().from(dutyTypes),
    workflows: await tx
      .select()
      .from(records)
      .where(or(sql`${records.kind} <> 'notification'`, ownNotice(actor))),
    scoreRows: await tx.select().from(ledger),
  };
}
/**
 * Only what a soldier's screens show, read by query and not filtered out of
 * the whole unit afterwards: the duties that ended since `from` or still hold
 * points, the soldier's own score history, notices and constraints since then,
 * and the unit's rounds and requests (decision 235).
 */
export async function soldierRows(tx: DbTransaction, actor: Actor, from: Date) {
  const holding = tx
    .select({ dutyId: assignments.dutyId })
    .from(assignments)
    .where(inArray(assignments.status, ["reserved", "held"]));
  const dutyRows = await tx
    .select()
    .from(duties)
    .where(
      and(visibleDuty, or(gte(dutyEnd, from), inArray(duties.id, holding)))
    );
  const dutyIds = dutyRows.map((row) => row.id);
  const state = domainOf({
    people: await tx.select().from(soldiers),
    scoreRows: await tx.select().from(balances),
    dutyRows,
    assignmentRows: dutyIds.length
      ? await tx
          .select()
          .from(assignments)
          .where(inArray(assignments.dutyId, dutyIds))
      : [],
    constraintRows: [],
    managers: await managerSoldierIds(tx),
  });
  const workflows = await tx
    .select()
    .from(records)
    .where(
      or(
        inArray(records.kind, ["round", "rank_catalog", "request"]),
        actor.soldierId
          ? and(
              eq(records.kind, "constraint"),
              eq(records.subjectId, actor.soldierId)
            )
          : undefined,
        and(ownNotice(actor), gte(records.createdAt, from))
      )
    );
  const shown = new Set(dutyIds);
  return {
    state,
    contacts: actor.soldierId
      ? await tx
          .select()
          .from(soldierContacts)
          .where(eq(soldierContacts.soldierId, actor.soldierId))
      : [],
    catalog: [],
    // A request stays while it changed lately or its duty is still shown.
    workflows: workflows.filter(
      (row) =>
        row.kind !== "request" ||
        row.updatedAt >= from ||
        shown.has(String(row.data.dutyId))
    ),
    scoreRows: actor.soldierId
      ? await tx
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.soldierId, actor.soldierId),
              gte(ledger.effectiveAt, from)
            )
          )
      : [],
  };
}
/** Whether anything of the soldier's lists is older than `from`. */
export async function olderAvailable(
  tx: DbTransaction,
  actor: Actor,
  from: Date
) {
  const found = async (query: Promise<unknown[]>) => (await query).length > 0;
  return (
    (actor.soldierId !== undefined &&
      (await found(
        tx
          .select({ id: ledger.id })
          .from(ledger)
          .where(
            and(
              eq(ledger.soldierId, actor.soldierId),
              lt(ledger.effectiveAt, from)
            )
          )
          .limit(1)
      ))) ||
    (await found(
      tx
        .select({ id: duties.id })
        .from(duties)
        .where(and(visibleDuty, lt(dutyEnd, from)))
        .limit(1)
    )) ||
    (await found(
      tx
        .select({ id: records.id })
        .from(records)
        .where(
          or(
            and(ownNotice(actor), lt(records.createdAt, from)),
            and(eq(records.kind, "request"), lt(records.updatedAt, from))
          )
        )
        .limit(1)
    ))
  );
}
