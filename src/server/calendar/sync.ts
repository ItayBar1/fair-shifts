import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db, type DbTransaction } from "../db";
import { operationsState, user } from "../auth-schema";
import {
  assignments,
  calendarEvent,
  calendarLink,
  duties,
  records,
  soldiers,
} from "../schema";
import { createRecord } from "../repository";
import { openSecret } from "../operations/email";
import { hasAccess } from "../duty-reminder-checks";
import { resolvePreferences } from "../../domain/notification-preferences";
import {
  ACTIVE_SEATS,
  CALENDAR_NAME,
  CALENDAR_ZONE,
  futureEvents,
  permissionLostNotice,
  planIsEmpty,
  planSync,
  retryDelay,
  wantedEvents,
  eventId,
  type DutyView,
  type RecordedEvent,
  type SeatView,
  type SyncPlan,
  type WantedEvent,
} from "../../domain/calendar-sync";
import { calendarSyncEnabled, siteUrl } from "./config";
import {
  GoogleError,
  calendarExists,
  createCalendar,
  insertEvent,
  readEvent,
  refreshAccessToken,
  removeEvent,
  replaceEvent,
} from "./google";

/**
 * The calendar sync (decision 195). Every minute the worker compares, for each soldier
 * who holds a usable permission and keeps the switch on, the events they should have
 * with the events recorded, and changes the difference in Google. It reads the state
 * and not the actions that changed it, so publishing, a changed or cancelled duty, a
 * transfer, a swap and execution periods are all covered, a run that is repeated or
 * that overlaps another changes nothing twice, and a failure never touches the action
 * that caused it: the next run simply finds the difference again.
 */
const LEASE_MS = 5 * 60_000;
const RUN_BUDGET_MS = 4 * 60_000;

type Link = typeof calendarLink.$inferSelect;
type Snapshot = {
  now: Date;
  duties: Map<string, DutyView>;
  seats: Map<string, SeatView[]>;
  accounts: Map<string, typeof user.$inferSelect>;
  people: Map<string, typeof soldiers.$inferSelect>;
  personal: Map<string, unknown>;
  unit: unknown;
};

async function loadSnapshot(now: Date, links: Link[]): Promise<Snapshot> {
  now = effectiveNow(now);
  return db.transaction((tx) => readSnapshot(tx, now, links), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

const effectiveNow = (initial: Date) =>
  new Date(Math.max(initial.getTime(), Date.now()));

async function readSnapshot(
  database: DbTransaction,
  now: Date,
  links: Link[]
): Promise<Snapshot> {
  const dutyViews = new Map<string, DutyView>();
  for (const row of await database.select().from(duties))
    if (
      row.data.status === "published" &&
      Date.parse(row.data.end) > now.getTime()
    )
      dutyViews.set(row.id, {
        id: row.id,
        name: row.name,
        status: row.data.status,
        start: row.data.start,
        end: row.data.end,
        location: row.data.location,
        instructions: row.data.instructions,
      });
  const accounts = new Map(
    (
      await database
        .select()
        .from(user)
        .where(
          inArray(
            user.id,
            links.map((link) => link.accountId)
          )
        )
    ).map((row) => [row.id, row])
  );
  const soldierIds = [...accounts.values()].flatMap((row) =>
    row.soldierId ? [row.soldierId] : []
  );
  const seats = new Map<string, SeatView[]>();
  const people = new Map<string, typeof soldiers.$inferSelect>();
  if (soldierIds.length) {
    for (const row of await database
      .select()
      .from(soldiers)
      .where(inArray(soldiers.id, soldierIds)))
      people.set(row.id, row);
    if (dutyViews.size)
      for (const row of await database
        .select()
        .from(assignments)
        .where(
          and(
            inArray(assignments.dutyId, [...dutyViews.keys()]),
            inArray(assignments.status, [...ACTIVE_SEATS, "credited"])
          )
        )) {
        const performer =
          row.data.performance && !row.data.performance.removed
            ? row.data.performance.performerId
            : row.soldierId;
        if (!soldierIds.includes(performer)) continue;
        const list = seats.get(performer) ?? [];
        list.push({
          ...row.data,
          id: row.id,
          dutyId: row.dutyId,
          soldierId: performer,
          status: row.status as SeatView["status"],
        });
        seats.set(performer, list);
      }
  }
  const settings = await database
    .select()
    .from(records)
    .where(inArray(records.kind, ["settings", "notification_defaults"]));
  return {
    now,
    duties: dutyViews,
    seats,
    accounts,
    people,
    personal: new Map(
      settings
        .filter((row) => row.kind === "settings")
        .map((row) => [String(row.data.accountId), row.data])
    ),
    unit: settings.find((row) => row.kind === "notification_defaults")?.data,
  };
}

/** The events one account should have now: none for a role or an access that ended. */
function wantedFor(
  snapshot: Snapshot,
  link: Link,
  includeEnded = false
): WantedEvent[] {
  const account = snapshot.accounts.get(link.accountId);
  if (
    !account ||
    account.deletedAt ||
    account.role !== "soldier" ||
    !account.soldierId ||
    !hasAccess(snapshot.people.get(account.soldierId), snapshot.now)
  )
    return [];
  const { preferences } = resolvePreferences(
    snapshot.personal.get(account.id),
    snapshot.unit
  );
  return wantedEvents({
    now: snapshot.now.getTime(),
    duties: snapshot.duties,
    seats: snapshot.seats.get(account.soldierId) ?? [],
    reminderHours: preferences.reminders
      .filter((reminder) => reminder.calendar)
      .map((reminder) => reminder.hours),
    siteUrl: siteUrl(),
    includeEnded,
  });
}

type EventRow = typeof calendarEvent.$inferSelect;
const recordedOf = (row: EventRow): RecordedEvent => ({
  dutyId: row.dutyId,
  status: row.status as RecordedEvent["status"],
  generation: row.generation,
  fingerprint: row.fingerprint,
  startsAt: row.startsAt.getTime(),
  endsAt: row.endsAt.getTime(),
});

/** What the soldier asked for and the worker still has to do, for one account. */
export function planFor(
  snapshot: Snapshot,
  link: Link,
  rows: readonly EventRow[]
): { plan: SyncPlan; mode: "sync" | "removal" } {
  const recorded = rows.map(recordedOf);
  if (!link.enabled)
    return {
      mode: "removal",
      plan: {
        create: [],
        update: [],
        remove: link.removeRequestedAt
          ? futureEvents(recorded, snapshot.now.getTime())
          : [],
      },
    };
  return {
    mode: "sync",
    plan: planSync(
      [
        ...wantedFor(snapshot, link),
        ...wantedFor(snapshot, link, true).filter(
          (event) =>
            event.endsAt <= snapshot.now.getTime() &&
            recorded.some(
              (row) => row.dutyId === event.dutyId && row.status === "synced"
            )
        ),
      ],
      recorded,
      snapshot.now.getTime()
    ),
  };
}

export type CalendarSyncResult = {
  /** Accounts that had something to change. */
  accounts: number;
  created: number;
  updated: number;
  removed: number;
};

export async function runCalendarSync(
  now = new Date()
): Promise<CalendarSyncResult> {
  const result = { accounts: 0, created: 0, updated: 0, removed: 0 };
  if (!calendarSyncEnabled() || process.env.RESTORE_MODE === "true")
    return result;
  // Like every worker task, it waits while a restore keeps the system closed (decision 200).
  const [restore] = await db
    .select()
    .from(operationsState)
    .where(eq(operationsState.key, "restore"));
  if (restore?.data.blocked === true) return result;
  const due = await db
    .select()
    .from(calendarLink)
    .where(
      and(
        eq(calendarLink.state, "active"),
        lte(calendarLink.nextAttemptAt, now),
        or(isNull(calendarLink.leaseUntil), lte(calendarLink.leaseUntil, now)),
        or(
          eq(calendarLink.enabled, true),
          isNotNull(calendarLink.removeRequestedAt)
        )
      )
    );
  if (!due.length) return result;
  const snapshot = await loadSnapshot(now, due);
  const events = await db
    .select()
    .from(calendarEvent)
    .where(
      inArray(
        calendarEvent.accountId,
        due.map((link) => link.accountId)
      )
    );
  const deadline = Date.now() + RUN_BUDGET_MS;
  for (const link of due) {
    if (Date.now() > deadline) break;
    const { plan, mode } = planFor(
      snapshot,
      link,
      events.filter((row) => row.accountId === link.accountId)
    );
    // Nothing to change: no lease and no call to Google. A removal asked for with
    // nothing left to remove is simply done.
    if (planIsEmpty(plan) && !link.calendarId) {
      if (mode === "removal" && link.removeRequestedAt)
        await db
          .update(calendarLink)
          .set({ removeRequestedAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(calendarLink.accountId, link.accountId),
              eq(calendarLink.version, link.version),
              isNull(calendarLink.calendarId)
            )
          );
      continue;
    }
    try {
      const done = await syncAccount(link, mode, snapshot, deadline);
      if (done && (done.created || done.updated || done.removed)) {
        result.accounts++;
        result.created += done.created;
        result.updated += done.updated;
        result.removed += done.removed;
      }
    } catch (error) {
      // Only the type of the failure: it can come from a provider answer.
      console.error(
        "Calendar sync failed",
        error instanceof Error ? error.name : "unknown"
      );
    }
  }
  return result;
}

async function stillAllowed(link: Link, mode: "sync" | "removal") {
  if (!calendarSyncEnabled() || process.env.RESTORE_MODE === "true")
    return false;
  const [restore] = await db
    .select()
    .from(operationsState)
    .where(eq(operationsState.key, "restore"));
  if (restore?.data.blocked === true) return false;
  const [row] = await db
    .select({
      state: calendarLink.state,
      enabled: calendarLink.enabled,
      removeRequestedAt: calendarLink.removeRequestedAt,
    })
    .from(calendarLink)
    .where(owned(link));
  if (!row || row.state !== "active") return false;
  // Switching off stops adding and updating at once (decision 195).
  return mode === "sync"
    ? row.enabled
    : !row.enabled && Boolean(row.removeRequestedAt);
}

/** A grant or another worker replaces this fence: the old worker must not write its result. */
function owned(link: Link) {
  return and(
    eq(calendarLink.accountId, link.accountId),
    eq(calendarLink.leaseToken, link.leaseToken!),
    link.refreshToken
      ? eq(calendarLink.refreshToken, link.refreshToken)
      : isNull(calendarLink.refreshToken)
  );
}

async function syncAccount(
  link: Link,
  mode: "sync" | "removal",
  snapshot: Snapshot,
  deadline: number
) {
  const now = snapshot.now;
  const [claimed] = await db
    .update(calendarLink)
    .set({
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      leaseToken: randomUUID(),
    })
    .where(
      and(
        eq(calendarLink.accountId, link.accountId),
        eq(calendarLink.state, "active"),
        lte(calendarLink.nextAttemptAt, now),
        or(isNull(calendarLink.leaseUntil), lte(calendarLink.leaseUntil, now))
      )
    )
    .returning();
  if (!claimed) return undefined;
  const done = { created: 0, updated: 0, removed: 0 };
  try {
    if (!(await stillAllowed(claimed, mode))) return undefined;
    // Claim first, then read again: the pre-claim snapshot is only a scheduling hint.
    const fresh = await loadSnapshot(now, [claimed]);
    const person = fresh.accounts.get(claimed.accountId);
    if (!person || person.deletedAt) return undefined;
    const currentRows = await db
      .select()
      .from(calendarEvent)
      .where(eq(calendarEvent.accountId, claimed.accountId));
    const { plan } = planFor(fresh, claimed, currentRows);
    if (
      !claimed.calendarId &&
      (claimed.errorCode === "calendar_creation_pending" ||
        claimed.errorCode === "calendar_creation_uncertain")
    )
      return undefined;
    if (!claimed.refreshToken) throw new GoogleError("auth");
    let secret: string;
    try {
      secret = openSecret(claimed.refreshToken);
    } catch {
      throw new GoogleError("configuration");
    }
    const accessToken = await refreshAccessToken(secret);
    if (!(await stillAllowed(claimed, mode))) return undefined;
    let calendarId = claimed.calendarId;
    if (calendarId && !(await calendarExists(accessToken, calendarId)))
      return await resetCalendar(claimed);
    if (!calendarId && (plan.create.length || plan.update.length)) {
      // calendars.insert has no idempotency key and app.created cannot list calendars.
      // An uncertain response must be investigated; retrying could create another calendar.
      if (
        claimed.errorCode === "calendar_creation_pending" ||
        claimed.errorCode === "calendar_creation_uncertain"
      )
        return undefined;
      await db
        .update(calendarLink)
        .set({ errorCode: "calendar_creation_pending" })
        .where(owned(claimed));
      calendarId = await createCalendar(
        accessToken,
        CALENDAR_NAME,
        CALENDAR_ZONE
      );
      await db
        .update(calendarLink)
        .set({ calendarId, errorCode: null, updatedAt: new Date() })
        .where(
          and(
            eq(calendarLink.accountId, claimed.accountId),
            isNull(calendarLink.calendarId),
            or(
              owned(claimed),
              and(
                eq(calendarLink.errorCode, "calendar_creation_pending"),
                inArray(
                  calendarLink.accountId,
                  db
                    .select({ id: user.id })
                    .from(user)
                    .where(
                      and(
                        eq(user.id, claimed.accountId),
                        eq(user.securityEpoch, person.securityEpoch)
                      )
                    )
                )
              )
            )
          )
        );
    }
    const context = {
      accountId: claimed.accountId,
      accessToken,
      calendarId,
      link: claimed,
      now,
      mode,
    };
    // False once the run stopped before its plan was done: the switch changed or the time ran out.
    let complete = true;
    const proceed = async () => {
      if (Date.now() > deadline || !(await stillAllowed(claimed, mode))) {
        complete = false;
        return false;
      }
      return true;
    };
    for (const entry of plan.create) {
      if (!calendarId || !(await proceed())) break;
      const latest = await latestWanted(claimed, entry.event.dutyId, now);
      if (!latest) continue;
      const outcome = await createOne(
        { ...context, calendarId },
        { ...entry, event: latest }
      );
      if (outcome === "calendar_gone") return await resetCalendar(claimed);
      if (outcome === "ok") done.created++;
    }
    for (const event of plan.update) {
      if (!calendarId || !(await proceed())) break;
      const latest = await latestWanted(claimed, event.dutyId, now);
      if (
        latest &&
        (await updateOne({ ...context, calendarId }, latest)) === "updated"
      )
        done.updated++;
    }
    for (const row of plan.remove) {
      if (!calendarId || !(await proceed())) break;
      // A seat may have been reinstated while the plan waited for Google.
      if (mode === "sync" && (await latestWanted(claimed, row.dutyId, now)))
        continue;
      await removeOne({ ...context, calendarId }, row);
      done.removed++;
    }
    // Keep ended records: generation and a user-deletion tombstone remain meaningful
    // if a manager later extends the same duty. No history event is deleted in Google.
    // A removal asked for is done once every future event is gone.
    await db
      .update(calendarLink)
      .set({
        attempts: 0,
        errorCode: null,
        nextAttemptAt: now,
        leaseUntil: null,
        leaseToken: null,
        syncedAt: new Date(),
        ...(mode === "removal" && complete && { removeRequestedAt: null }),
        updatedAt: new Date(),
      })
      .where(owned(claimed));
    return done;
  } catch (error) {
    await handleFailure(claimed, error, now);
    return undefined;
  } finally {
    await db
      .update(calendarLink)
      .set({ leaseUntil: null, leaseToken: null })
      .where(owned(claimed));
  }
}

type Context = {
  accountId: string;
  accessToken: string;
  calendarId: string;
  link: Link;
  now: Date;
  mode: "sync" | "removal";
};

async function latestWanted(link: Link, dutyId: string, now: Date) {
  const latest = await loadSnapshot(now, [link]);
  const future = wantedFor(latest, link).find(
    (event) => event.dutyId === dutyId
  );
  if (future) return future;
  const [existing] = await db
    .select()
    .from(calendarEvent)
    .where(
      and(
        eq(calendarEvent.accountId, link.accountId),
        eq(calendarEvent.dutyId, dutyId),
        eq(calendarEvent.status, "synced")
      )
    );
  if (!existing) return undefined;
  return wantedFor(latest, link, true).find((event) => event.dutyId === dutyId);
}

/** The sync's record of an event, written right after Google accepted it. */
async function record(
  context: Context,
  event: WantedEvent,
  generation: number,
  status: "pending" | "synced" | "removed_by_user" | "removed"
) {
  const googleEventId = eventId(context.accountId, event.dutyId, generation);
  const values = {
    dutyId: event.dutyId,
    generation,
    googleEventId,
    status,
    fingerprint: event.fingerprint,
    startsAt: new Date(event.startsAt),
    endsAt: new Date(event.endsAt),
    updatedAt: new Date(),
  };
  try {
    const saved = await db.transaction(async (tx) => {
      // Account first, link second: the same order as grant/deletion, never a network call here.
      const [person] = await tx
        .select()
        .from(user)
        .where(eq(user.id, context.accountId))
        .for("update");
      const [link] = await tx
        .select()
        .from(calendarLink)
        .where(owned(context.link))
        .for("update");
      if (!person || person.deletedAt || !link) return false;
      await tx
        .insert(calendarEvent)
        .values({ id: randomUUID(), accountId: context.accountId, ...values })
        .onConflictDoUpdate({
          target: [calendarEvent.accountId, calendarEvent.dutyId],
          set: values,
        });
      return true;
    });
    if (!saved) {
      // Deletion/unlink/email change may remove the old identity while its request
      // is in flight. Compensate in that old calendar; a fresh grant to the same
      // calendar belongs to the successor and must keep the recoverable event.
      const [person] = await db
        .select()
        .from(user)
        .where(eq(user.id, context.accountId));
      const [currentLink] = await db
        .select()
        .from(calendarLink)
        .where(eq(calendarLink.accountId, context.accountId));
      if (
        !person ||
        person.deletedAt ||
        !currentLink ||
        currentLink.calendarId !== context.calendarId
      )
        await removeEvent(
          context.accessToken,
          context.calendarId,
          googleEventId
        ).catch(() => undefined);
      throw new GoogleError("changed");
    }
  } catch (error) {
    // The account was deleted while the call ran: nothing may be kept, and the event
    // that just went out is removed again, as far as Google answers.
    if ((error as { code?: string }).code === "23503") {
      await removeEvent(
        context.accessToken,
        context.calendarId,
        googleEventId
      ).catch(() => undefined);
      throw new GoogleError("rejected");
    }
    throw error;
  }
}

async function createOne(
  context: Context,
  entry: { event: WantedEvent; generation: number }
): Promise<"ok" | "none" | "calendar_gone"> {
  const { event, generation } = entry;
  const id = eventId(context.accountId, event.dutyId, generation);
  await record(context, event, generation, "pending");
  if (!(await stillAllowed(context.link, "sync"))) return "none";
  try {
    await insertEvent(context.accessToken, context.calendarId, id, event.body);
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error;
    // Insert has no event of its own to miss: the calendar is gone.
    if (error.kind === "missing") return "calendar_gone";
    if (error.kind !== "conflict") throw error;
    // The id exists: a run that stopped before recording it, or an event deleted since.
    const found = await readEvent(context.accessToken, context.calendarId, id);
    if (!found || found.status === "cancelled") {
      await record(context, event, generation, "removed_by_user");
      return "none";
    }
    if (!(await stillAllowed(context.link, "sync"))) return "none";
    await replaceEvent(
      context.accessToken,
      context.calendarId,
      id,
      event.body,
      found.etag
    );
  }
  await record(context, event, generation, "synced");
  // Cancel/transfer/deletion/disable may commit while Google is processing the insert.
  // The durable pending row covers an uncertain response too, so the next run can remove it.
  if (
    !(await latestWanted(context.link, event.dutyId, context.now)) ||
    !(await stillAllowed(context.link, "sync"))
  ) {
    await removeEvent(context.accessToken, context.calendarId, id);
    await record(context, event, generation, "removed");
  }
  return "ok";
}

/** "updated", or "kept deleted" when the soldier deleted the event in Google. */
async function updateOne(
  context: Context,
  event: WantedEvent
): Promise<"updated" | "kept deleted" | "none"> {
  const [row] = await db
    .select()
    .from(calendarEvent)
    .where(
      and(
        eq(calendarEvent.accountId, context.accountId),
        eq(calendarEvent.dutyId, event.dutyId)
      )
    );
  if (!row || row.status !== "synced") return "none";
  // An event the soldier deleted stays deleted (decision 195): look before writing,
  // because a write could bring a deleted event back.
  const found = await readEvent(
    context.accessToken,
    context.calendarId,
    row.googleEventId
  );
  if (!found || found.status === "cancelled") {
    await record(context, event, row.generation, "removed_by_user");
    return "kept deleted";
  }
  try {
    if (!(await stillAllowed(context.link, "sync"))) return "none";
    const latest = await latestWanted(context.link, event.dutyId, context.now);
    if (!latest) return "none";
    event = latest;
    await replaceEvent(
      context.accessToken,
      context.calendarId,
      row.googleEventId,
      event.body,
      found.etag
    );
  } catch (error) {
    if (error instanceof GoogleError && error.kind === "missing") {
      await record(context, event, row.generation, "removed_by_user");
      return "kept deleted";
    }
    throw error;
  }
  await record(context, event, row.generation, "synced");
  if (!(await latestWanted(context.link, event.dutyId, context.now))) {
    await removeEvent(
      context.accessToken,
      context.calendarId,
      row.googleEventId
    );
    await record(context, event, row.generation, "removed");
  }
  return "updated";
}

async function removeOne(context: Context, row: RecordedEvent) {
  const [stored] = await db
    .select()
    .from(calendarEvent)
    .where(
      and(
        eq(calendarEvent.accountId, context.accountId),
        eq(calendarEvent.dutyId, row.dutyId)
      )
    );
  if (!stored) return;
  if (
    context.mode === "removal" &&
    stored.startsAt.getTime() <= effectiveNow(context.now).getTime()
  )
    return;
  await removeEvent(
    context.accessToken,
    context.calendarId,
    stored.googleEventId
  );
  await db
    .update(calendarEvent)
    .set({ status: "removed", updatedAt: new Date() })
    .where(
      and(
        eq(calendarEvent.id, stored.id),
        inArray(
          calendarEvent.accountId,
          db
            .select({ accountId: calendarLink.accountId })
            .from(calendarLink)
            .where(owned(context.link))
        )
      )
    );
}

/** The calendar was deleted in Google: start over with a new one, on the next run. */
async function resetCalendar(link: Link) {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(calendarLink)
      .where(owned(link))
      .for("update");
    if (!current) return;
    await tx
      .delete(calendarEvent)
      .where(eq(calendarEvent.accountId, link.accountId));
    await tx
      .update(calendarLink)
      .set({
        calendarId: null,
        leaseUntil: null,
        leaseToken: null,
        errorCode: null,
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(owned(link));
  });
  return undefined;
}

async function handleFailure(link: Link, error: unknown, now: Date) {
  if (error instanceof GoogleError && error.kind === "auth") {
    await permissionLost(link);
    return;
  }
  const kind = error instanceof GoogleError ? error.kind : "unknown";
  const [current] = await db.select().from(calendarLink).where(owned(link));
  if (!current) return;
  const uncertain =
    !current.calendarId &&
    current.errorCode === "calendar_creation_pending" &&
    ["unknown", "transient"].includes(kind);
  const attempts = link.attempts + 1;
  await db
    .update(calendarLink)
    .set({
      attempts,
      errorCode: uncertain ? "calendar_creation_uncertain" : kind,
      nextAttemptAt: new Date(
        now.getTime() +
          retryDelay(
            attempts,
            error instanceof GoogleError ? error.retryAfterMs : 0
          )
      ),
      leaseUntil: null,
      leaseToken: null,
      updatedAt: new Date(),
    })
    .where(owned(link));
}

/**
 * The permission was revoked or expired: the sync stops without an error, the switch
 * returns to "permission needed" and the soldier gets one site notice (decision 195).
 */
async function permissionLost(link: Link) {
  await db.transaction(async (tx) => {
    const [person] = await tx
      .select({ soldierId: user.soldierId, deletedAt: user.deletedAt })
      .from(user)
      .where(eq(user.id, link.accountId))
      .for("update");
    const [current] = await tx
      .select()
      .from(calendarLink)
      .where(owned(link))
      .for("update");
    if (!person || !current) return;
    const notify = !current.permissionNoticeAt && !person.deletedAt;
    await tx
      .update(calendarLink)
      .set({
        state: "needs_permission",
        refreshToken: null,
        leaseUntil: null,
        leaseToken: null,
        version: current.version + 1,
        errorCode: "permission_lost",
        removeRequestedAt: null,
        ...(notify && { permissionNoticeAt: new Date() }),
        updatedAt: new Date(),
      })
      .where(owned(link));
    if (notify && person.soldierId)
      await createRecord(
        tx,
        "notification",
        { accountId: link.accountId, ...permissionLostNotice },
        person.soldierId
      );
  });
}
