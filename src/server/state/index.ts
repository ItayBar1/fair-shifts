import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { projectAudit, technicalScope } from "../audit-log";
import { db } from "../db";
import { assertActorCurrent, type Actor } from "../auth/accounts";
import { MAX_FAILURES } from "../auth/policy";
import { domainOf } from "../repository";
import { assignments, duties, ledger, records } from "../schema";
import { operationsState, user } from "../auth-schema";
import { populationAt, rankAt, serviceSummary } from "../../domain/eligibility";
import { interveningActions } from "../score-decisions";
import { readHealth } from "../operations/health";
import { readMailStatus } from "../operations/email";
import { backupConfig, backupState } from "../operations/backup";
import { readDeletionLogStatus } from "../operations/deletion-log";
import { readDrillStatus } from "../operations/restore";
import { projectPlanning } from "../planning";
import { calendarSettings } from "../calendar/link";
import {
  preferencesState,
  unitDefaults,
  auditAccountsOf,
  soldierDuty,
  soldierAssignment,
  soldierLedger,
  unitRequests,
  ownNotifications,
  ownNotice,
  visibleDuty,
  dutyEnd,
  staffRows,
  soldierRows,
  olderAvailable,
} from "./rows";
import { ownDrawReceipts } from "./draw-receipts";

/** A soldier's history arrives in slices of this length (decision 235). */
export const HISTORY_DAYS = 90;
const HISTORY_MS = HISTORY_DAYS * 86_400_000;
/**
 * Every query of one read sees the same version of the unit (decision 235):
 * a publication between two of them cannot show a duty without its seats.
 */
const snapshot = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

export async function readState(actor: Actor) {
  return db.transaction(async (tx) => {
    const current = await assertActorCurrent(actor, tx, { lock: false });
    const publicActor: {
      id: string;
      name: string;
      role: Actor["role"];
      soldierId?: string;
      responsibility?: string;
      responsibilityVersion?: number;
    } = {
      id: actor.id,
      name: actor.name,
      role: actor.role,
      soldierId: actor.soldierId,
      ...(actor.role === "manager" && {
        responsibility: current.responsibility ?? undefined,
        responsibilityVersion: current.responsibilityVersion,
      }),
    };
    const base = {
      actor: publicActor,
      serverNow: new Date().toISOString(),
      soldiers: [],
      dutyTypes: [],
      duties: [],
      assignments: [],
      rounds: [],
      roundNotices: [],
      constraints: [],
      requests: [],
      ledger: [],
      notifications: [],
      settings: {},
      calendar: { available: false } as Awaited<
        ReturnType<typeof calendarSettings>
      >,
      notificationDefaults: undefined as
        ReturnType<typeof unitDefaults> | undefined,
      // The technical account's own address and open request to change it (decision 204).
      ownAccount: undefined as
        | {
            email: string;
            pendingEmailChange: { email: unknown; expiresAt: unknown } | null;
          }
        | undefined,
      accounts: [],
      audit: [],
      imports: [],
      operations: [],
      rankRules: [],
      rankReminders: [],
      departures: [],
      rankCatalog: [],
      rankTracks: [],
      performanceCorrections: [],
      scoreDecisions: [],
      managerReturns: [],
      names: {},
      // A soldier's lists start here; "load more" reads earlier slices (decision 235).
      history: undefined as
        { from: string; olderAvailable: boolean } | undefined,
    };
    if (actor.role === "manager" || actor.role === "technical") {
      const [pending] = (
        await tx
          .select()
          .from(records)
          .where(
            and(
              eq(
                records.kind,
                actor.role === "manager"
                  ? "manager_email_change"
                  : "technical_email_change"
              ),
              sql`${records.data}->>'accountId' = ${actor.id}`,
              sql`${records.data}->>'mode' = ${actor.role === "manager" ? "manager-self" : "web"}`,
              sql`${records.data}->>'status' = 'pending'`
            )
          )
      ).filter(
        (row) =>
          row.data.securityEpoch === current.securityEpoch &&
          new Date(String(row.data.expiresAt)) > new Date() &&
          Number(row.data.attempts) < MAX_FAILURES
      );
      base.ownAccount = {
        email: current.email,
        pendingEmailChange: pending
          ? { email: pending.data.email, expiresAt: pending.data.expiresAt }
          : null,
      };
    }
    if (actor.role === "technical") {
      const accounts = await tx
        .select({
          id: user.id,
          name: user.name,
          role: user.role,
          responsibility: user.responsibility,
          responsibilityVersion: user.responsibilityVersion,
          lockedAt: user.lockedAt,
          version: user.securityEpoch,
        })
        .from(user)
        .where(isNull(user.deletedAt));
      const operations = await tx.select().from(operationsState);
      const auditAccounts = await auditAccountsOf(tx);
      const auditRows = await tx
        .select()
        .from(records)
        .where(eq(records.kind, "audit"));
      const emailDetailIds = auditRows
        .filter(
          (row) =>
            String(row.data.action).startsWith("manager.email.") ||
            String(row.data.action).startsWith("technical.manager-email.")
        )
        .map((row) => String(row.data.detailId));
      const emailDetails = emailDetailIds.length
        ? await tx
            .select()
            .from(records)
            .where(
              and(
                eq(records.kind, "audit_detail"),
                inArray(records.id, emailDetailIds)
              )
            )
        : [];
      // Operational alerts are addressed to each technical account (decision 173).
      const notices = await tx
        .select()
        .from(records)
        .where(
          and(
            eq(records.kind, "notification"),
            sql`${records.data}->>'accountId' = ${actor.id}`
          )
        );
      return {
        ...base,
        notifications: notices
          .filter((row) => !row.data.hiddenAt)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((row) => ({ ...row.data, id: row.id, version: row.version })),
        backups: await backupState(tx),
        settings: await preferencesState(tx, actor),
        calendar: await calendarSettings(tx, actor),
        accounts,
        // Account operations within technical authority; no soldier data is resolved.
        audit: projectAudit(
          {
            workflows: [...auditRows, ...emailDetails],
            soldiers: [],
            duties: [],
            dutyTypes: [],
            assignments: [],
            accounts: auditAccounts,
          },
          technicalScope(auditAccounts)
        ),
        // The worker heartbeat and mail state are presented through `health` and `mail`.
        operations: operations
          .filter(
            (row) =>
              row.key !== "worker" &&
              row.key !== "mail" &&
              row.key !== "deletion-log" &&
              row.key !== "restore-drill" &&
              row.key !== "restore-report"
          )
          .map((row) => ({ id: row.key, ...row.data })),
        health: await readHealth(tx),
        mail: await readMailStatus(tx),
        // Counts and times only: no soldier, id or content (decision 196).
        deletionLog: await readDeletionLogStatus(tx),
        // Dates and a verdict only (decision 200).
        restoreDrill: await readDrillStatus(tx, backupConfig()),
      };
    }
    const managing = actor.role === "manager";
    const now = base.serverNow;
    const historyFrom = new Date(Date.parse(now) - HISTORY_MS);
    const { state, contacts, catalog, workflows, scoreRows } = managing
      ? await staffRows(tx, actor)
      : await soldierRows(tx, actor, historyFrom);
    // A duty manager takes no part in duties (decision 192). A soldier's lists
    // therefore leave managers out, and only their names stay, for the duties and
    // requests that still mention them. Nothing about the role is sent.
    const names = managing
      ? {}
      : Object.fromEntries(
          state.soldiers
            .filter((person) => person.isManager)
            .map((person) => [person.id, person.name])
        );
    // Points held by seats not yet credited, the F(i) of the scheduling score.
    // A manager gets all of them, drafts included; a soldier only those on
    // published duties, since a draft never reaches a soldier (decision 220).
    const publishedIds = new Set(
      state.duties
        .filter((duty) => duty.status === "published")
        .map((duty) => duty.id)
    );
    const futureScores = new Map<string, number>();
    for (const seat of state.assignments) {
      if (seat.status !== "reserved" && seat.status !== "held") continue;
      if (!managing && !publishedIds.has(seat.dutyId)) continue;
      futureScores.set(
        seat.soldierId,
        (futureScores.get(seat.soldierId) ?? 0) + seat.points
      );
    }
    const soldiers = state.soldiers
      .filter((person) => managing || !person.isManager)
      .map((person) => {
        const rank = rankAt(person, now);
        const summary = {
          id: person.id,
          name: person.name,
          version: person.version,
          currentScore: person.currentScore,
          futureScore: futureScores.get(person.id) ?? 0,
          deletedAt: person.deletedAt,
          population: populationAt(person, now),
          rankName:
            workflows.find(
              (row) => row.kind === "rank_catalog" && row.id === rank?.rankId
            )?.data.name ?? rank?.rankId,
        };
        if (!managing) return summary;
        const contact = contacts.find((row) => row.soldierId === person.id);
        const service = serviceSummary(person, now);
        return {
          ...person,
          ...summary,
          ...contact,
          serviceStatus: service.status,
          graceUntil: service.graceUntil,
          preReleaseFrom: service.preReleaseFrom,
          rankId: rank?.rankId,
          rankTrack: rank?.trackId,
          serviceType: person.service.type,
          arrivalDate: person.service.arrivalDate,
          enlistmentDate: person.service.enlistmentDate,
          releaseDate: person.service.releaseDate,
          officerDate: person.service.officerFrom,
          permanentDate: person.service.permanentFrom,
          graceEligible: person.service.graceEligible,
        };
      });
    const visibleDuties = state.duties.filter(
      (row) =>
        managing ||
        row.status === "published" ||
        (row.status === "cancelled" && row.wasPublished)
    );
    const visibleIds = new Set(visibleDuties.map((row) => row.id));
    const workflow = (kind: string) =>
      workflows
        .filter((row) => row.kind === kind)
        .map((row) => ({
          ...row.data,
          id: row.id,
          version: row.version,
          subjectId: row.subjectId,
        }));
    const own = (kind: string) =>
      workflows
        .filter(
          (row) =>
            row.kind === kind &&
            (row.data.accountId === actor.id ||
              row.subjectId === actor.soldierId)
        )
        .map((row) => ({ ...row.data, id: row.id, version: row.version }));
    // The signed-in person's own details and issued number (decision 222);
    // no one else's contact details reach a soldier.
    const me = state.soldiers.find(
      (person) => person.id === actor.soldierId && !person.deletedAt
    );
    const myContact = contacts.find((row) => row.soldierId === me?.id);
    const myProfile = me && {
      id: me.id,
      idNumber: me.idNumber,
      name: me.name,
      firstName: me.firstName,
      lastName: me.lastName,
      gender: me.gender,
      email: myContact?.email,
      phone: myContact?.phone,
      address: myContact?.address,
      contactVersions: {
        phone: myContact?.fieldVersions.phone ?? 0,
        address: myContact?.fieldVersions.address ?? 0,
      },
    };
    return {
      ...base,
      soldiers,
      names,
      myProfile,
      duties: visibleDuties.map((row) =>
        managing
          ? {
              ...row,
              slots: row.slots.map((slot) => ({ ...slot, name: slot.role })),
            }
          : soldierDuty(row)
      ),
      assignments: state.assignments
        .filter(
          (row) =>
            visibleIds.has(row.dutyId) &&
            (managing || row.status !== "cancelled")
        )
        .map((row) => (managing ? row : soldierAssignment(row))),
      dutyTypes: managing
        ? catalog.map((row) => ({
            ...row.data,
            id: row.id,
            name: row.name,
            version: row.version,
            pricing: row.data.uiPricing,
          }))
        : [],
      rounds: workflow("round"),
      // Delivery bookkeeping (who was reached) is operational: managers only.
      roundNotices: managing ? workflow("round_notice") : [],
      constraints: managing ? workflow("constraint") : own("constraint"),
      requests: unitRequests(workflows, actor, managing),
      notifications: ownNotifications(workflows, actor),
      settings: await preferencesState(tx, actor),
      calendar: await calendarSettings(tx, actor),
      notificationDefaults: managing ? unitDefaults(workflows) : undefined,
      ledger: managing
        ? scoreRows
        : scoreRows
            .filter((row) => row.soldierId === actor.soldierId)
            .map(soldierLedger),
      history: managing
        ? undefined
        : {
            from: historyFrom.toISOString(),
            olderAvailable: await olderAvailable(tx, actor, historyFrom),
          },
      audit: managing
        ? projectAudit({
            workflows,
            soldiers: state.soldiers,
            duties: state.duties,
            dutyTypes: catalog,
            assignments: state.assignments,
            accounts: await auditAccountsOf(tx),
          })
        : [],
      imports: managing ? workflow("import") : [],
      accounts: managing
        ? await tx
            .select({
              id: user.id,
              name: user.name,
              role: user.role,
              lockedAt: user.lockedAt,
              version: user.securityEpoch,
            })
            .from(user)
            .where(and(eq(user.role, "soldier"), isNull(user.deletedAt)))
        : [],
      eligibilityCatalog: managing ? workflow("eligibility_catalog") : [],
      rankCatalog: managing ? workflow("rank_catalog") : [],
      rankTracks: managing ? workflow("rank_track") : [],
      rankRules: managing ? workflow("rank_rule") : [],
      rankReminders: managing ? workflow("rank_reminder") : [],
      departures: managing ? workflow("departure") : [],
      ...(managing
        ? projectPlanning(state, workflows)
        : { lotteryAttempts: [], planningRuns: [] }),
      // A soldier sees how their own seats were drawn, in numbers only (decision 240).
      drawReceipts: managing
        ? []
        : await ownDrawReceipts(
            tx,
            actor.soldierId,
            [...publishedIds],
            state.assignments
          ),
      dutyChanges: managing ? workflow("duty_change") : [],
      performanceCorrections: managing
        ? workflow("performance_correction")
        : [],
      managerReturns: managing ? workflow("manager_return") : [],
      seatExecutions: managing ? workflow("seat_execution") : [],
      executionChanges: managing ? workflow("execution_change") : [],
      scoreDecisions: managing
        ? workflow("score_decision").map((row) => {
            const data = workflows.find((item) => item.id === row.id)!.data;
            if (data.status !== "pending") return row;
            // Pending decisions show the intervening operations as they stand now, in effective order.
            const end = state.assignments.find(
              (item) => item.id === data.assignmentId
            )?.performance?.end;
            const from = String(data.from ?? end ?? "");
            return {
              ...row,
              barriers: from
                ? interveningActions(String(data.soldierId), from, scoreRows)
                : [],
            };
          })
        : [],
    };
  }, snapshot);
}

/**
 * An earlier slice of a soldier's history, before `before` (decision 235):
 * the duties that ended then, with their seats, and the soldier's score
 * history, notices and closed requests of that time, seen exactly as in the
 * current state. A manager already has all of it.
 */
export async function readHistory(actor: Actor, before: Date) {
  return db.transaction(async (tx) => {
    await assertActorCurrent(actor, tx, { lock: false });
    const from = new Date(before.getTime() - HISTORY_MS);
    if (actor.role !== "soldier")
      return {
        from: from.toISOString(),
        olderAvailable: false,
        duties: [],
        assignments: [],
        requests: [],
        notifications: [],
        ledger: [],
      };
    const dutyRows = await tx
      .select()
      .from(duties)
      .where(and(visibleDuty, gte(dutyEnd, from), lt(dutyEnd, before)));
    const dutyIds = dutyRows.map((row) => row.id);
    const seats = dutyIds.length
      ? await tx
          .select()
          .from(assignments)
          .where(inArray(assignments.dutyId, dutyIds))
      : [];
    const view = domainOf({
      people: [],
      scoreRows: [],
      dutyRows,
      assignmentRows: seats,
      constraintRows: [],
      managers: new Set(),
    });
    const workflows = await tx
      .select()
      .from(records)
      .where(
        or(
          and(
            eq(records.kind, "request"),
            gte(records.updatedAt, from),
            lt(records.updatedAt, before)
          ),
          and(
            ownNotice(actor),
            gte(records.createdAt, from),
            lt(records.createdAt, before)
          )
        )
      );
    const scoreRows = actor.soldierId
      ? await tx
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.soldierId, actor.soldierId),
              gte(ledger.effectiveAt, from),
              lt(ledger.effectiveAt, before)
            )
          )
      : [];
    return {
      from: from.toISOString(),
      olderAvailable: await olderAvailable(tx, actor, from),
      duties: view.duties.map(soldierDuty),
      assignments: view.assignments
        .filter((row) => row.status !== "cancelled")
        .map(soldierAssignment),
      requests: unitRequests(workflows, actor, false),
      notifications: ownNotifications(workflows, actor),
      ledger: scoreRows.map(soldierLedger),
    };
  }, snapshot);
}
