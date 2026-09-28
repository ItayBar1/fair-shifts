import { eq } from "drizzle-orm";
import { z } from "zod";
import { DateTime } from "luxon";
import type { DbTransaction } from "./db";
import { soldiers, assignments } from "./schema";
import {
  audit,
  createRecord,
  currentVersion,
  findRecord,
  loadDomain,
  manager,
  type Actor,
} from "./repository";
import { id, date, population, text } from "./validation";
import { invariant } from "./errors";
import { evaluateEligibility } from "../domain/eligibility";
import type { Soldier } from "../domain/types";
import { refreshRankReminders } from "./ranks";

/** Changed rules flag existing reservations; they never silently remove an assignee. */
export async function reassessAssignments(
  tx: DbTransaction,
  soldierId?: string
) {
  const state = await loadDomain(tx);
  let flagged = 0;
  for (const assignment of state.assignments.filter(
    (row) =>
      row.status === "reserved" && (!soldierId || row.soldierId === soldierId)
  )) {
    const person = state.soldiers.find(
      (row) => row.id === assignment.soldierId
    );
    const duty = state.duties.find((row) => row.id === assignment.dutyId);
    const slot = duty?.slots.find((row) => row.id === assignment.slotId);
    if (!person || !duty || !slot) continue;
    const result = evaluateEligibility(person, duty, slot, {
      duties: state.duties,
      assignments: state.assignments,
      mode: "manual",
      ignoreAssignmentIds: [assignment.id],
      approvals: assignment.approvals,
      pendingReviewConfirmed: assignment.pendingReviewConfirmed,
    });
    const reasons = [...result.blockers, ...result.approvalsRequired].map(
      (row) => row.code
    );
    if (
      JSON.stringify(assignment.needsAttention ?? []) ===
      JSON.stringify(reasons)
    )
      continue;
    await tx
      .update(assignments)
      .set({
        version: assignment.version + 1,
        data: { ...assignment, needsAttention: reasons },
        updatedAt: new Date(),
      })
      .where(eq(assignments.id, assignment.id));
    if (reasons.length) flagged++;
  }
  return flagged;
}
export async function saveEligibilityCatalog(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  manager(actor);
  const input = z
    .object({
      kind: z.enum(["qualification", "exemption"]),
      name: text,
      description: z.string().max(2000).default(""),
    })
    .parse(payload);
  const record = await createRecord(tx, "eligibility_catalog", input);
  await audit(tx, actor, "eligibility.catalog.create", record.id);
  return { id: record.id };
}
export async function updateTimeline(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({
      soldierId: id,
      kind: z.enum([
        "population",
        "inactive",
        "qualification",
        "exemption",
        "rank",
      ]),
      startDate: date,
      endDate: z.preprocess(
        (value) => (value === "" ? undefined : value),
        date.optional()
      ),
      value: z.string().max(200).optional(),
      name: text.optional(),
      track: text.optional(),
      order: z.number().int().nonnegative().optional(),
      reason: z.string().trim().max(2000).default(""),
    })
    .parse(payload);
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, input.soldierId));
  invariant(person && !person.deletedAt, "not_found", "חייל לא נמצא", 404);
  currentVersion(person.version, expectedVersion);
  const data: Soldier = { ...person.data, version: person.version + 1 };
  if (input.kind === "population") {
    invariant(input.reason, "reason_required", "נדרשת סיבה למעבר");
    invariant(
      !data.populationHistory.some(
        (row) => row.effectiveFrom === input.startDate
      ),
      "existing_effective_date",
      "כבר קיים מעבר בתאריך הזה"
    );
    data.populationHistory = [
      ...data.populationHistory,
      {
        effectiveFrom: input.startDate,
        population: population.parse(input.value),
      },
    ];
  } else if (input.kind === "rank") {
    invariant(
      input.name && input.track && input.order !== undefined && input.reason,
      "rank_details",
      "נדרשים דרגה, מסלול, סדר ומקור אישור"
    );
    data.rankHistory = [
      ...data.rankHistory.filter(
        (row) => row.effectiveFrom !== input.startDate
      ),
      {
        effectiveFrom: input.startDate,
        rankId: input.name,
        trackId: input.track,
        order: input.order,
      },
    ];
  } else {
    invariant(
      input.endDate && input.endDate >= input.startDate,
      "date_range",
      "נדרש טווח תוקף תקין עם תאריך סיום"
    );
    const range = { start: input.startDate, end: input.endDate };
    if (input.kind === "inactive")
      data.inactivePeriods = [...data.inactivePeriods, range];
    else {
      const catalog = await findRecord(
        tx,
        "eligibility_catalog",
        id.parse(input.value)
      );
      invariant(
        catalog.data.kind === input.kind,
        "catalog_kind",
        "סוג ההגדרה אינו מתאים לשיוך"
      );
      if (input.kind === "qualification")
        data.qualifications = [
          ...data.qualifications,
          { ...range, qualificationId: catalog.id },
        ];
      else
        data.exemptions = [
          ...data.exemptions,
          { ...range, exemptionId: catalog.id },
        ];
    }
  }
  await tx
    .update(soldiers)
    .set({ data, version: person.version + 1, updatedAt: new Date() })
    .where(eq(soldiers.id, person.id));
  await createRecord(
    tx,
    "personnel_change",
    {
      kind: input.kind,
      startDate: input.startDate,
      reason: input.reason,
      actorId: actor.id,
    },
    person.id
  );
  await audit(
    tx,
    actor,
    "soldier.timeline",
    person.id,
    { kind: input.kind },
    person.id
  );
  await refreshRankReminders(tx);
  return {
    id: person.id,
    version: person.version + 1,
    flagged: await reassessAssignments(tx, person.id),
  };
}
export function effectiveToday() {
  return DateTime.now().setZone("Asia/Jerusalem").toISODate()!;
}
