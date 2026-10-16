import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
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
import { evaluateEligibility, populationTimeline } from "../domain/eligibility";
import { executionDuty } from "../domain/execution";
import type { DailyWindow, Soldier } from "../domain/types";
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
    // A deleted soldier's seat that a manager decided no longer needs attention (decision 196).
    const decided = Boolean(person.deletedAt && assignment.deletionDecidedAt);
    const result = decided
      ? { blockers: [], approvalsRequired: [] }
      : evaluateEligibility(person, executionDuty(duty, assignment), slot, {
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
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "שעה לא תקינה");
const hoursWindows = z
  .array(
    z.object({
      startTime: clock,
      endTime: clock,
      weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    })
  )
  .min(1)
  .max(7);
function normalWindows(windows: DailyWindow[]): DailyWindow[] {
  return windows.map((window) => ({
    startTime: window.startTime,
    endTime: window.endTime,
    weekdays: [...new Set(window.weekdays ?? [])].sort(),
  }));
}
/** The windows an hours exemption in the catalog carries (decision 226). */
function catalogWindows(data: Record<string, unknown>) {
  return Array.isArray(data.windows) && data.windows.length
    ? (data.windows as DailyWindow[])
    : undefined;
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
      kind: z.enum(["exemption", "capability"]),
      name: text,
      description: z.string().max(2000).default(""),
      // Present only for an hours exemption; it limits every duty to these windows.
      windows: hoursWindows.optional(),
    })
    .parse(payload);
  invariant(
    !input.windows || input.kind === "exemption",
    "catalog_kind",
    "חלון שעות שייך לפטור שעות בלבד"
  );
  const windows = input.windows && normalWindows(input.windows);
  if (input.id) {
    const existing = await findRecord(tx, "eligibility_catalog", input.id);
    currentVersion(existing.version, expectedVersion);
    invariant(
      existing.data.kind === input.kind &&
        Boolean(catalogWindows(existing.data)) === Boolean(windows),
      "catalog_kind",
      "אין לשנות את סוג ההגדרה הקיימת"
    );
    const updated = await updateRecord(tx, existing, {
      ...existing.data,
      name: input.name,
      description: input.description,
      ...(windows ? { windows } : {}),
    });
    await audit(tx, actor, "eligibility.catalog.update", existing.id);
    // Each soldier holds a copy of the windows; a changed window reaches all of
    // them, and their reserved assignments are checked again.
    let flagged = 0;
    if (
      windows &&
      JSON.stringify(windows) !== JSON.stringify(catalogWindows(existing.data))
    )
      flagged = await spreadWindows(tx, existing.id, windows);
    return { id: updated.id, version: updated.version, flagged };
  }
  const record = await createRecord(tx, "eligibility_catalog", {
    kind: input.kind,
    name: input.name,
    description: input.description,
    ...(windows ? { windows } : {}),
  });
  await audit(tx, actor, "eligibility.catalog.create", record.id);
  return { id: record.id };
}
async function spreadWindows(
  tx: DbTransaction,
  exemptionId: string,
  windows: DailyWindow[]
) {
  let flagged = 0;
  for (const person of await tx.select().from(soldiers)) {
    if (
      person.deletedAt ||
      !person.data.exemptions.some((row) => row.exemptionId === exemptionId)
    )
      continue;
    const data: Soldier = {
      ...person.data,
      version: person.version + 1,
      exemptions: person.data.exemptions.map((row) =>
        row.exemptionId === exemptionId ? { ...row, windows } : row
      ),
    };
    await tx
      .update(soldiers)
      .set({ data, version: data.version, updatedAt: new Date() })
      .where(eq(soldiers.id, person.id));
    flagged += await reassessAssignments(tx, person.id);
  }
  return flagged;
}
/** An empty date field means no date: open validity for capabilities and exemptions. */
const optionalDate = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  date.optional()
);
const timelineEditInput = z.object({
  soldierId: id,
  kind: z.enum(["capability", "exemption", "inactive"]),
  index: z.number().int().nonnegative().max(10000),
  operation: z.enum(["replace", "remove"]),
  startDate: optionalDate,
  endDate: optionalDate,
  value: id.optional(),
  reason: text,
});
/**
 * Capabilities and exemptions may leave out either date (decision 224); an
 * inactivity period needs both. Given dates must not run backwards.
 */
function validityOf(
  kind: "capability" | "exemption" | "inactive",
  startDate?: string,
  endDate?: string
) {
  if (kind === "inactive")
    invariant(
      startDate && endDate,
      "date_range",
      "נדרש טווח תוקף תקין עם תאריך סיום"
    );
  invariant(
    !startDate || !endDate || startDate <= endDate,
    "date_range",
    "תאריך הסיום קודם לתאריך ההתחלה"
  );
  return {
    ...(startDate ? { start: startDate } : {}),
    ...(endDate ? { end: endDate } : {}),
  };
}
/** An hours exemption carries its catalog windows onto the soldier (decision 226). */
function hoursOf(catalog?: { data: Record<string, unknown> }) {
  const windows = catalog && catalogWindows(catalog.data);
  return windows ? { windows } : {};
}
function replaceEntry<T>(entries: T[], index: number, replacement?: T) {
  return entries.flatMap((entry, i) =>
    i !== index ? [entry] : replacement ? [replacement] : []
  );
}
export type DomainState = Awaited<ReturnType<typeof loadDomain>>;
/**
 * Compares every reserved assignment of the soldier before and after a proposed
 * change. `basis` lists the compared assignments and duties with their versions,
 * so a stored preview can tell that they changed since.
 */
export function impactOf(state: DomainState, soldierId: string, data: Soldier) {
  const existing = state.soldiers.find((item) => item.id === soldierId)!;
  const proposed = {
    ...existing,
    ...data,
    currentScore: existing.currentScore,
    constraints: existing.constraints,
  };
  const reserved = state.assignments.filter(
    (item) => item.soldierId === soldierId && item.status === "reserved"
  );
  const impact = reserved.map((assignment) => {
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
    const own = executionDuty(duty, assignment);
    const before = evaluateEligibility(existing, own, slot, context);
    const after = evaluateEligibility(proposed, own, slot, context);
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
      end: duty.end,
      before: before.status,
      after: after.status,
      affected: codes(before) !== codes(after),
      reasons: [...after.blockers, ...after.approvalsRequired],
    };
  });
  const basis = reserved.map((assignment) => ({
    assignmentId: assignment.id,
    version: assignment.version,
    dutyVersion: state.duties.find((item) => item.id === assignment.dutyId)!
      .version,
  }));
  return { impact, basis };
}
/** The token binds the confirmation to the exact input and domain state. */
async function assessPeriodImpact(
  tx: DbTransaction,
  soldierId: string,
  data: Soldier,
  input: unknown
) {
  const state = await loadDomain(tx);
  const { impact } = impactOf(state, soldierId, data);
  const previewToken = createHash("sha256")
    .update(JSON.stringify({ input, state }))
    .digest("hex");
  return { previewToken, impact };
}
export function populationChange(before: Soldier, after: Soldier) {
  return {
    before: populationTimeline(before),
    after: populationTimeline(after),
  };
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
      capability: "capabilities",
      exemption: "exemptions",
      inactive: "inactivePeriods",
    } as const
  )[input.kind];
  const original = (person.data[field] ?? [])[input.index];
  invariant(original, "not_found", "התקופה שנבחרה לא נמצאה", 404);
  const removing = input.operation === "remove";
  const range = removing
    ? {}
    : validityOf(input.kind, input.startDate, input.endDate);
  let catalog: Awaited<ReturnType<typeof findRecord>> | undefined;
  if (!removing) {
    if (input.kind !== "inactive") {
      catalog = await findRecord(
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
  const data: Soldier = { ...person.data, version: person.version + 1 };
  if (input.kind === "capability")
    data.capabilities = replaceEntry(
      data.capabilities ?? [],
      input.index,
      removing ? undefined : { ...range, capabilityId: input.value! }
    );
  else if (input.kind === "exemption")
    data.exemptions = replaceEntry(
      data.exemptions,
      input.index,
      removing
        ? undefined
        : { ...range, exemptionId: input.value!, ...hoursOf(catalog) }
    );
  else
    data.inactivePeriods = replaceEntry(
      data.inactivePeriods,
      input.index,
      removing ? undefined : { start: input.startDate!, end: input.endDate! }
    );
  const { previewToken, impact } = await assessPeriodImpact(
    tx,
    person.id,
    data,
    input
  );
  const replaced = removing ? null : (data[field] ?? [])[input.index];
  return { input, person, data, original, replaced, previewToken, impact };
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
  const { input, person, data, original, replaced, previewToken } =
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
  const change = await createRecord(
    tx,
    "personnel_change",
    {
      kind: input.kind,
      operation: input.operation,
      before: original,
      after: replaced,
      reason: input.reason,
      actorId: actor.id,
    },
    person.id
  );
  // The period kind (an exemption, say) stays in the erasable change record.
  await audit(
    tx,
    actor,
    "soldier.timeline.edit",
    person.id,
    { operation: input.operation, recordId: change.id },
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
  kind: z.enum(["population", "inactive", "capability", "exemption", "rank"]),
  startDate: optionalDate,
  endDate: optionalDate,
  value: z.string().max(200).optional(),
  name: text.optional(),
  track: text.optional(),
  order: z.number().int().nonnegative().optional(),
  reason: z.string().trim().max(2000).default(""),
});
/** Additions that are saved only against the impact the manager reviewed. */
const reviewedKinds = [
  "inactive",
  "capability",
  "exemption",
  "population",
] as const;
function isReviewedKind(kind: string): kind is (typeof reviewedKinds)[number] {
  return (reviewedKinds as readonly string[]).includes(kind);
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
/**
 * Builds a proposed period or population transition without saving it. The
 * population transition keeps every earlier transition as it was.
 */
async function inspectTimelineAdd(
  tx: DbTransaction,
  payload: unknown,
  expectedVersion?: number
) {
  const input = timelineInput.parse(payload);
  invariant(
    isReviewedKind(input.kind),
    "period_kind",
    "תצוגת השפעה זמינה להוספת כשירות, פטור, אי־פעילות או מעבר אוכלוסייה"
  );
  const person = await loadSoldierForTimeline(
    tx,
    input.soldierId,
    expectedVersion
  );
  const data: Soldier = { ...person.data, version: person.version + 1 };
  if (input.kind === "population") {
    invariant(input.reason, "reason_required", "נדרשת סיבה למעבר");
    invariant(input.startDate, "date_required", "נדרש תאריך המעבר");
    const effectiveFrom = input.startDate;
    invariant(
      !data.populationHistory.some(
        (row) => row.effectiveFrom === effectiveFrom
      ),
      "existing_effective_date",
      "כבר קיים מעבר בתאריך הזה"
    );
    data.populationHistory = [
      ...data.populationHistory,
      { effectiveFrom, population: population.parse(input.value) },
    ];
  } else {
    const range = validityOf(input.kind, input.startDate, input.endDate);
    if (input.kind === "inactive")
      data.inactivePeriods = [
        ...data.inactivePeriods,
        { start: input.startDate!, end: input.endDate! },
      ];
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
      if (input.kind === "capability")
        data.capabilities = [
          ...(data.capabilities ?? []),
          { ...range, capabilityId: catalog.id },
        ];
      else
        data.exemptions = [
          ...data.exemptions,
          { ...range, exemptionId: catalog.id, ...hoursOf(catalog) },
        ];
    }
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
  const checked = await inspectTimelineAdd(tx, payload, expectedVersion);
  return {
    previewToken: checked.previewToken,
    impact: checked.impact,
    ...(checked.input.kind === "population"
      ? { population: populationChange(checked.person.data, checked.data) }
      : {}),
  };
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
  if (isReviewedKind(input.kind)) {
    const confirmation = z
      .object({
        previewToken: z.string().length(64),
        confirmed: z.literal(true),
      })
      .parse(payload);
    const checked = await inspectTimelineAdd(tx, payload, expectedVersion);
    invariant(
      confirmation.previewToken === checked.previewToken,
      "stale_preview",
      "נתוני החייל או השיבוצים השתנו. יש לבדוק שוב את השפעת השינוי",
      409
    );
    ({ person, data } = checked);
  } else {
    person = await loadSoldierForTimeline(tx, input.soldierId, expectedVersion);
    data = { ...person.data, version: person.version + 1 };
    invariant(
      input.name &&
        input.track &&
        input.order !== undefined &&
        input.reason &&
        input.startDate,
      "rank_details",
      "נדרשים דרגה, מסלול, סדר, תאריך ומקור אישור"
    );
    const effectiveFrom = input.startDate;
    data.rankHistory = [
      ...data.rankHistory.filter((row) => row.effectiveFrom !== effectiveFrom),
      {
        effectiveFrom,
        rankId: input.name,
        trackId: input.track,
        order: input.order,
      },
    ];
  }
  await tx
    .update(soldiers)
    .set({ data, version: person.version + 1, updatedAt: new Date() })
    .where(eq(soldiers.id, person.id));
  const change = await createRecord(
    tx,
    "personnel_change",
    {
      kind: input.kind,
      startDate: input.startDate,
      endDate: input.endDate,
      value: input.kind === "rank" ? input.name : input.value,
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
    { recordId: change.id },
    person.id
  );
  await refreshRankReminders(tx);
  return {
    id: person.id,
    version: person.version + 1,
    flagged: await reassessAssignments(tx, person.id),
  };
}
const conditionsInput = z.object({
  soldierId: id,
  gender: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    gender.optional()
  ),
  reason: z.string().trim().max(2000).default(""),
});
function conditionsOf(data: Soldier) {
  return {
    gender: data.gender ?? null,
  };
}
/**
 * Gender is replaced only against the impact the manager reviewed (decision
 * 164). Capabilities and exemptions, hours exemptions among them (decision
 * 226), are dated entries and change through the timeline actions.
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
  const data: Soldier = { ...person.data, version: person.version + 1 };
  // Gender is a required profile field (decision 222): it can change here but
  // not be cleared; only a record from before the rule may still lack it.
  invariant(
    input.gender || !person.data.gender,
    "gender_required",
    "מגדר הוא שדה חובה; אפשר לשנות אותו אך לא למחוק"
  );
  if (input.gender) data.gender = input.gender;
  else delete data.gender;
  const before = conditionsOf(person.data);
  const after = conditionsOf(data);
  invariant(
    JSON.stringify(before) !== JSON.stringify(after),
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
  const change = await createRecord(
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
  await audit(
    tx,
    actor,
    "soldier.conditions",
    person.id,
    { recordId: change.id },
    person.id
  );
  return {
    id: person.id,
    version: data.version,
    flagged: await reassessAssignments(tx, person.id),
  };
}
export function effectiveToday() {
  return DateTime.now().setZone("Asia/Jerusalem").toISODate()!;
}
