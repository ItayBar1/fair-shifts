import { and, eq, isNull, sql } from "drizzle-orm";
import { projectAudit, technicalScope, type AuditAccount } from "./audit-log";
import { db } from "./db";
import { assertActorCurrent, type Actor } from "./auth/accounts";
import { loadDomain } from "./repository";
import { soldierContacts, dutyTypes, records, ledger } from "./schema";
import { operationsState, user } from "./auth-schema";
import { populationAt, rankAt, serviceSummary } from "../domain/eligibility";
import { interveningActions } from "./score-decisions";
import { readHealth } from "./operations/health";
import { readMailStatus } from "./operations/email";
import { backupState } from "./operations/backup";
import { projectRequests } from "./transfers";
import { projectSwaps } from "./swaps";
import { projectCancellationRequests } from "./cancellation-requests";
import { projectPlanning } from "./planning";
import { effectivePreferences } from "./notifications";
import { resolvePreferences } from "../domain/notification-preferences";
import type { DbTransaction } from "./db";

async function preferencesState(tx: DbTransaction, actor: Actor) {
  const current = await effectivePreferences(tx, actor.id);
  return {
    ...current.preferences,
    source: current.source,
    version: current.version,
  };
}
function unitDefaults(workflows: (typeof records.$inferSelect)[]) {
  const row = workflows.find((item) => item.kind === "notification_defaults");
  return {
    ...resolvePreferences(null, row?.data).preferences,
    version: row?.version,
  };
}

async function auditAccountsOf(tx: DbTransaction): Promise<AuditAccount[]> {
  return tx
    .select({
      id: user.id,
      name: user.name,
      role: user.role,
      soldierId: user.soldierId,
    })
    .from(user);
}

export async function readState(actor: Actor) {
  return db.transaction(async (tx) => {
    const current = await assertActorCurrent(actor, tx);
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
      notificationDefaults: undefined as
        ReturnType<typeof unitDefaults> | undefined,
      accounts: [],
      audit: [],
      imports: [],
      operations: [],
      rankRules: [],
      rankReminders: [],
      departures: [],
      rankCatalog: [],
      performanceCorrections: [],
      scoreDecisions: [],
    };
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
        accounts,
        // Account operations within technical authority; no soldier data is resolved.
        audit: projectAudit(
          {
            workflows: await tx
              .select()
              .from(records)
              .where(eq(records.kind, "audit")),
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
          .filter((row) => row.key !== "worker" && row.key !== "mail")
          .map((row) => ({ id: row.key, ...row.data })),
        health: await readHealth(tx),
        mail: await readMailStatus(tx),
      };
    }
    const state = await loadDomain(tx);
    const contacts = await tx.select().from(soldierContacts);
    const catalog = await tx.select().from(dutyTypes);
    const workflows = await tx.select().from(records);
    const scoreRows = await tx.select().from(ledger);
    const managing = actor.role === "manager";
    const now = base.serverNow;
    const soldiers = state.soldiers.map((person) => {
      const rank = rankAt(person, now);
      const summary = {
        id: person.id,
        name: person.name,
        version: person.version,
        currentScore: person.currentScore,
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
    return {
      ...base,
      soldiers,
      duties: visibleDuties.map((row) =>
        managing
          ? {
              ...row,
              slots: row.slots.map((slot) => ({ ...slot, name: slot.role })),
            }
          : {
              id: row.id,
              name: row.name,
              start: row.start,
              end: row.end,
              status: row.status,
              wasPublished: row.wasPublished,
              location: row.location,
              instructions: row.instructions,
              version: row.version,
              slots: row.slots.map((slot) => ({
                id: slot.id,
                name: slot.role,
              })),
            }
      ),
      assignments: state.assignments
        .filter(
          (row) =>
            visibleIds.has(row.dutyId) &&
            (managing || row.status !== "cancelled")
        )
        .map((row) =>
          managing
            ? row
            : {
                id: row.id,
                dutyId: row.dutyId,
                slotId: row.slotId,
                soldierId: row.soldierId,
                status: row.status,
                points: row.points,
                version: row.version,
                ...(row.performance && {
                  performance: {
                    performerId: row.performance.performerId,
                    start: row.performance.start,
                    end: row.performance.end,
                    points: row.performance.points,
                  },
                }),
              }
        ),
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
      requests: [
        ...projectRequests(
          workflows.filter(
            (row) =>
              row.data.type !== "cancellation" && row.data.type !== "swap"
          ),
          actor,
          managing
        ),
        ...projectSwaps(workflows, actor, managing),
        ...projectCancellationRequests(workflows, actor, managing),
      ],
      // A notification addressed to an account belongs to it alone; hidden copies leave the inbox.
      notifications: workflows
        .filter(
          (row) =>
            row.kind === "notification" &&
            !row.data.hiddenAt &&
            (typeof row.data.accountId === "string"
              ? row.data.accountId === actor.id
              : Boolean(actor.soldierId) && row.subjectId === actor.soldierId)
        )
        .map((row) => ({ ...row.data, id: row.id, version: row.version })),
      settings: await preferencesState(tx, actor),
      notificationDefaults: managing ? unitDefaults(workflows) : undefined,
      ledger: managing
        ? scoreRows
        : scoreRows
            .filter((row) => row.soldierId === actor.soldierId)
            .map((row) => ({
              id: row.id,
              amount: row.amount,
              before: row.before,
              after: row.after,
              effectiveAt: row.effectiveAt,
              kind: row.kind,
            })),
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
      rankRules: managing ? workflow("rank_rule") : [],
      rankReminders: managing ? workflow("rank_reminder") : [],
      departures: managing ? workflow("departure") : [],
      ...(managing
        ? projectPlanning(state, workflows)
        : { lotteryAttempts: [], planningRuns: [] }),
      dutyChanges: managing ? workflow("duty_change") : [],
      performanceCorrections: managing
        ? workflow("performance_correction")
        : [],
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
  });
}
