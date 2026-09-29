import { eq } from "drizzle-orm";
import { db } from "./db";
import { assertActorCurrent, type Actor } from "./auth/accounts";
import { loadDomain } from "./repository";
import { soldierContacts, dutyTypes, records, ledger } from "./schema";
import { emailOutbox, operationsState, user } from "./auth-schema";
import { populationAt, rankAt } from "../domain/eligibility";
import { projectRequests } from "./transfers";
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
        .from(user);
      const mail = await tx
        .select({
          id: emailOutbox.id,
          kind: emailOutbox.kind,
          status: emailOutbox.status,
          attempts: emailOutbox.attempts,
          error: emailOutbox.error,
          createdAt: emailOutbox.createdAt,
        })
        .from(emailOutbox);
      const operations = await tx.select().from(operationsState);
      return {
        ...base,
        settings: await preferencesState(tx, actor),
        accounts,
        operations: [
          ...mail,
          ...operations.map((row) => ({ id: row.key, ...row.data })),
        ],
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
      return {
        ...person,
        ...summary,
        ...contact,
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
      constraints: managing ? workflow("constraint") : own("constraint"),
      requests: projectRequests(workflows, actor, managing),
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
      audit: managing ? workflow("audit") : [],
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
            .where(eq(user.role, "soldier"))
        : [],
      eligibilityCatalog: managing ? workflow("eligibility_catalog") : [],
      rankCatalog: managing ? workflow("rank_catalog") : [],
      rankRules: managing ? workflow("rank_rule") : [],
      rankReminders: managing ? workflow("rank_reminder") : [],
      lotteryAttempts: managing ? workflow("lottery_attempt") : [],
      planningRuns: managing ? workflow("planning_run") : [],
      dutyChanges: managing ? workflow("duty_change") : [],
      performanceCorrections: managing
        ? workflow("performance_correction")
        : [],
      scoreDecisions: managing ? workflow("score_decision") : [],
    };
  });
}
