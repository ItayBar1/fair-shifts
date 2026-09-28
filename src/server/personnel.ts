import { eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
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
  updateRecord,
  type Actor,
} from "./repository";
import { id, date, population, text, gender } from "./validation";
import { invariant } from "./errors";
import { evaluateEligibility } from "../domain/eligibility";
import type { AllowedHours, Soldier } from "../domain/types";
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
        data: {
          ...assignment,
          version: assignment.version + 1,
          needsAttention: reasons,
        },
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
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({
      id: id.optional(),
      kind: z.enum(["qualification", "exemption", "capability"]),
      name: text,
      description: z.string().max(2000).default(""),
    })
    .parse(payload);
  if (input.id) {
    const existing = await findRecord(tx, "eligibility_catalog", input.id);
    currentVersion(existing.version, expectedVersion);
    invariant(
      existing.data.kind === input.kind,
      "catalog_kind",
      "אין לשנות את סוג ההגדרה הקיימת"
    );
    const updated = await updateRecord(tx, existing, {
      ...existing.data,
      name: input.name,
      description: input.description,
    });
    await audit(tx, actor, "eligibility.catalog.update", existing.id);
    return { id: updated.id, version: updated.version };
  }
  const record = await createRecord(tx, "eligibility_catalog", input);
  await audit(tx, actor, "eligibility.catalog.create", record.id);
  return { id: record.id };
}
const timelineEditInput = z.object({
  soldierId: id,
  kind: z.enum(["qualification", "exemption", "inactive"]),
  index: z.number().int().nonnegative().max(10000),
  operation: z.enum(["replace", "remove"]),
  startDate: date.optional(),
  endDate: date.optional(),
  value: id.optional(),
  reason: text,
});
function replaceEntry<T>(entries: T[], index: number, replacement?: T) {
  return entries.flatMap((entry, i) =>
    i !== index ? [entry] : replacement ? [replacement] : []
  );
}
/**
 * Compares every reserved assignment of the soldier before and after a proposed
 * change. The token binds the confirmation to the exact input and domain state.
 */
async function assessPeriodImpact(
  tx: DbTransaction,
  soldierId: string,
  data: Soldier,
  input: unknown
) {
  const state = await loadDomain(tx);
  const existing = state.soldiers.find((item) => item.id === soldierId)!;
  const proposed = {
    ...existing,
    ...data,
    currentScore: existing.currentScore,
    constraints: existing.constraints,
  };
  const impact = state.assignments
    .filter(
      (item) => item.soldierId === soldierId && item.status === "reserved"
    )
    .map((assignment) => {
      const duty = state.duties.find((item) => item.id === assignment.dutyId)!;
      const slot = duty.slots.find((item) => item.id === assignment.slotId)!;
      const context = {
        duties: state.duties,
        assignments: state.assignments,
        mode: "manual" as const,
        ignoreAssignmentIds: [assignment.id],
        approvals: assignment.approvals,
        pendingReviewConfirmed: assignment.pendingReviewConfirmed,
      };
      const before = evaluateEligibility(existing, duty, slot, context);
      const after = evaluateEligibility(proposed, duty, slot, context);
      const codes = (result: typeof before) =>
        JSON.stringify(
          [...result.blockers, ...result.approvalsRequired].map(
            (row) => `${row.code}:${row.referenceId ?? ""}`
          )
        );
      return {
        assignmentId: assignment.id,
        dutyId: duty.id,
        dutyName: duty.name,
        start: duty.start,
        before: before.status,
        after: after.status,
        affected: codes(before) !== codes(after),
        reasons: [...after.blockers, ...after.approvalsRequired],
      };
    });
  const previewToken = createHash("sha256")
    .update(JSON.stringify({ input, state }))
    .digest("hex");
  return { previewToken, impact };
}
async function inspectTimelineEdit(
  tx: DbTransaction,
  payload: unknown,
  expectedVersion?: number
) {
  const input = timelineEditInput.parse(payload);
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, input.soldierId));
  invariant(person && !person.deletedAt, "not_found", "חייל לא נמצא", 404);
  currentVersion(person.version, expectedVersion);
  const field = (
    {
      qualification: "qualifications",
      exemption: "exemptions",
      inactive: "inactivePeriods",
    } as const
  )[input.kind];
  const original = person.data[field][input.index];
  invariant(original, "not_found", "התקופה שנבחרה לא נמצאה", 404);
  const removing = input.operation === "remove";
  if (!removing) {
    invariant(
      input.startDate && input.endDate && input.startDate <= input.endDate,
      "date_range",
      "נדרש טווח תוקף תקין עם תאריך סיום"
    );
    if (input.kind !== "inactive") {
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
    }
  }
  const range = { start: input.startDate!, end: input.endDate! };
  const data: Soldier = { ...person.data, version: person.version + 1 };
  if (input.kind === "qualification")
    data.qualifications = replaceEntry(
      data.qualifications,
      input.index,
      removing ? undefined : { ...range, qualificationId: input.value! }
    );
  else if (input.kind === "exemption")
    data.exemptions = replaceEntry(
      data.exemptions,
      input.index,
      removing ? undefined : { ...range, exemptionId: input.value! }
    );
  else
    data.inactivePeriods = replaceEntry(
      data.inactivePeriods,
      input.index,
      removing ? undefined : range
    );
  const { previewToken, impact } = await assessPeriodImpact(
    tx,
    person.id,
    data,
    input
  );
  return { input, person, data, original, previewToken, impact };
}
export async function previewTimelineEdit(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const checked = await inspectTimelineEdit(tx, payload, expectedVersion);
  return { previewToken: checked.previewToken, impact: checked.impact };
}
export async function editTimeline(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const confirmation = z
    .object({ previewToken: z.string().length(64), confirmed: z.literal(true) })
    .parse(payload);
  const { input, person, data, original, previewToken } =
    await inspectTimelineEdit(tx, payload, expectedVersion);
  invariant(
    confirmation.previewToken === previewToken,
    "stale_preview",
    "נתוני התקופה או השיבוצים השתנו. יש לבדוק שוב את השפעת השינוי",
    409
  );
  await tx
    .update(soldiers)
    .set({ data, version: data.version, updatedAt: new Date() })
    .where(eq(soldiers.id, person.id));
  await createRecord(
    tx,
    "personnel_change",
    {
      kind: input.kind,
      operation: input.operation,
      before: original,
      reason: input.reason,
      actorId: actor.id,
    },
    person.id
  );
  await audit(
    tx,
    actor,
    "soldier.timeline.edit",
    person.id,
    { kind: input.kind, operation: input.operation },
    person.id
  );
  await refreshRankReminders(tx);
  return {
    id: person.id,
    version: data.version,
    flagged: await reassessAssignments(tx, person.id),
  };
}
const timelineInput = z.object({
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
});
const periodKinds = ["inactive", "qualification", "exemption"] as const;
function isPeriodKind(kind: string): kind is (typeof periodKinds)[number] {
  return (periodKinds as readonly string[]).includes(kind);
}
async function loadSoldierForTimeline(
  tx: DbTransaction,
  soldierId: string,
  expectedVersion?: number
) {
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, soldierId));
  invariant(person && !person.deletedAt, "not_found", "חייל לא נמצא", 404);
  currentVersion(person.version, expectedVersion);
  return person;
}
/** A new period is only saved against the impact the manager reviewed. */
async function inspectPeriodAdd(
  tx: DbTransaction,
  payload: unknown,
  expectedVersion?: number
) {
  const input = timelineInput.parse(payload);
  invariant(
    isPeriodKind(input.kind),
    "period_kind",
    "תצוגת השפעה זמינה להוספת כשירות, פטור או אי־פעילות"
  );
  const person = await loadSoldierForTimeline(
    tx,
    input.soldierId,
    expectedVersion
  );
  invariant(
    input.endDate && input.endDate >= input.startDate,
    "date_range",
    "נדרש טווח תוקף תקין עם תאריך סיום"
  );
  const data: Soldier = { ...person.data, version: person.version + 1 };
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
  const { previewToken, impact } = await assessPeriodImpact(
    tx,
    person.id,
    data,
    input
  );
  return { input, person, data, previewToken, impact };
}
export async function previewTimelineAdd(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const checked = await inspectPeriodAdd(tx, payload, expectedVersion);
  return { previewToken: checked.previewToken, impact: checked.impact };
}
export async function updateTimeline(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = timelineInput.parse(payload);
  let person: typeof soldiers.$inferSelect;
  let data: Soldier;
  if (isPeriodKind(input.kind)) {
    const confirmation = z
      .object({
        previewToken: z.string().length(64),
        confirmed: z.literal(true),
      })
      .parse(payload);
    const checked = await inspectPeriodAdd(tx, payload, expectedVersion);
    invariant(
      confirmation.previewToken === checked.previewToken,
      "stale_preview",
      "נתוני החייל או השיבוצים השתנו. יש לבדוק שוב את השפעת התקופה",
      409
    );
    ({ person, data } = checked);
  } else {
    person = await loadSoldierForTimeline(tx, input.soldierId, expectedVersion);
    data = { ...person.data, version: person.version + 1 };
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
    } else {
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
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "שעה לא תקינה");
const conditionsInput = z.object({
  soldierId: id,
  gender: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    gender.optional()
  ),
  capabilityIds: z.array(id).max(50).default([]),
  allowedHours: z
    .array(
      z.object({
        id: id.optional(),
        start: date,
        end: date,
        windows: z
          .array(
            z.object({
              startTime: clock,
              endTime: clock,
              weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
            })
          )
          .min(1)
          .max(7),
      })
    )
    .max(20)
    .default([]),
  reason: z.string().trim().max(2000).default(""),
});
function conditionsOf(data: Soldier) {
  return {
    gender: data.gender ?? null,
    capabilities: data.capabilities ?? [],
    allowedHours: data.allowedHours ?? [],
  };
}
/**
 * Gender, capabilities and personal hours limits are replaced as one set, and
 * only against the impact the manager reviewed (decision 163).
 */
async function inspectConditions(
  tx: DbTransaction,
  payload: unknown,
  expectedVersion?: number
) {
  const input = conditionsInput.parse(payload);
  const person = await loadSoldierForTimeline(
    tx,
    input.soldierId,
    expectedVersion
  );
  const capabilities = [...new Set(input.capabilityIds)].sort();
  for (const capabilityId of capabilities) {
    const catalog = await findRecord(tx, "eligibility_catalog", capabilityId);
    invariant(
      catalog.data.kind === "capability",
      "catalog_kind",
      "היכולת שנבחרה אינה מוגדרת בקטלוג היכולות"
    );
  }
  const existingIds = new Set(
    (person.data.allowedHours ?? []).map((limit) => limit.id)
  );
  const allowedHours: AllowedHours[] = input.allowedHours.map((limit) => {
    invariant(
      limit.start <= limit.end,
      "date_range",
      "נדרש טווח תוקף תקין להגבלת השעות"
    );
    invariant(
      !limit.id || existingIds.has(limit.id),
      "not_found",
      "הגבלת השעות שנבחרה לא נמצאה",
      404
    );
    return {
      id: limit.id ?? randomUUID(),
      start: limit.start,
      end: limit.end,
      windows: limit.windows.map((window) => ({
        startTime: window.startTime,
        endTime: window.endTime,
        weekdays: [...new Set(window.weekdays)].sort(),
      })),
    };
  });
  invariant(
    new Set(allowedHours.map((limit) => limit.id)).size === allowedHours.length,
    "invalid_input",
    "הגבלת שעות מופיעה פעמיים"
  );
  const data: Soldier = {
    ...person.data,
    version: person.version + 1,
    capabilities,
    allowedHours,
  };
  if (input.gender) data.gender = input.gender;
  else delete data.gender;
  const before = conditionsOf(person.data);
  const after = conditionsOf(data);
  const comparable = (value: typeof before) =>
    JSON.stringify({
      ...value,
      allowedHours: value.allowedHours.map(({ start, end, windows }) => ({
        start,
        end,
        windows,
      })),
    });
  invariant(
    comparable(before) !== comparable(after),
    "no_change",
    "לא בוצע שינוי בתנאי ההתאמה"
  );
  const { previewToken, impact } = await assessPeriodImpact(
    tx,
    person.id,
    data,
    input
  );
  return { input, person, data, before, after, previewToken, impact };
}
export async function previewSoldierConditions(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const checked = await inspectConditions(tx, payload, expectedVersion);
  return { previewToken: checked.previewToken, impact: checked.impact };
}
export async function saveSoldierConditions(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const confirmation = z
    .object({ previewToken: z.string().length(64), confirmed: z.literal(true) })
    .parse(payload);
  const { input, person, data, before, after, previewToken } =
    await inspectConditions(tx, payload, expectedVersion);
  invariant(
    confirmation.previewToken === previewToken,
    "stale_preview",
    "נתוני החייל או השיבוצים השתנו. יש לבדוק שוב את השפעת השינוי",
    409
  );
  await tx
    .update(soldiers)
    .set({ data, version: data.version, updatedAt: new Date() })
    .where(eq(soldiers.id, person.id));
  await createRecord(
    tx,
    "personnel_change",
    {
      kind: "conditions",
      before,
      after,
      reason: input.reason,
      actorId: actor.id,
    },
    person.id
  );
  await audit(tx, actor, "soldier.conditions", person.id, {}, person.id);
  return {
    id: person.id,
    version: data.version,
    flagged: await reassessAssignments(tx, person.id),
  };
}
export function effectiveToday() {
  return DateTime.now().setZone("Asia/Jerusalem").toISODate()!;
}
