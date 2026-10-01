import { randomUUID, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { assignments, duties, dutySlots, dutyTypes, records } from "./schema";
import { user } from "./auth-schema";
import {
  audit,
  currentVersion,
  loadDomain,
  manager,
  type Actor,
} from "./repository";
import { invariant } from "./errors";
import { id, text, population, gender } from "./validation";
import {
  MANAGER_BLOCKER_MESSAGE,
  evaluateEligibility,
  genderCondition,
} from "../domain/eligibility";
import { calculatePrice } from "../domain/pricing";
import { instant, resolveLocalTime, interval } from "../domain/time";
import type {
  Assignment,
  Duty,
  Pricing,
  Requirements,
  SpecificApproval,
  EligibilityReason,
} from "../domain/types";
import { enqueueEmail } from "./operations/email";

const priceValue = z
  .union([z.number().finite().nonnegative(), z.string().regex(/^\d+(\.\d+)?$/)])
  .transform(String);
/** An optional amount; an empty or zero value means none is saved. */
export const optionalPrice = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  priceValue.optional()
);
const rankClause = z
  .object({
    trackId: text,
    rankIds: z.array(id).min(1).optional(),
    minOrder: z.number().int().nonnegative().optional(),
    maxOrder: z.number().int().nonnegative().optional(),
  })
  .refine(
    (row) =>
      (row.rankIds?.length ||
        row.minOrder !== undefined ||
        row.maxOrder !== undefined) &&
      !(
        row.minOrder !== undefined &&
        row.maxOrder !== undefined &&
        row.maxOrder < row.minOrder
      ),
    "נדרש תנאי דרגה תקין בתוך מסלול"
  );
/** Every gender is no gender condition, saved as an empty list (decision 198). */
const genderList = z
  .array(gender)
  .max(3)
  .transform((list) => genderCondition(list) ?? []);
export const requirementsInput = z.object({
  populations: z.array(population).min(1).optional(),
  ranks: z.array(rankClause).optional(),
  qualificationIds: z.array(id).optional(),
  blockingExemptionIds: z.array(id).optional(),
  genders: genderList.optional(),
  capabilityIds: z.array(id).max(50).optional(),
});
const catalogInput = z.object({
  id: id.optional(),
  name: text,
  description: z.string().max(2000).default(""),
  populations: z.array(population).min(1).optional(),
  ranks: z.array(rankClause).default([]),
  qualificationIds: z.array(id).default([]),
  exemptionIds: z.array(id).default([]),
  genders: genderList.default([]),
  capabilityIds: z.array(id).max(50).default([]),
  restBeforeMinutes: z.number().int().nonnegative().default(0),
  restAfterMinutes: z.number().int().nonnegative().default(0),
  roles: z
    .array(
      z.object({
        name: text,
        count: z.number().int().min(1).max(120),
        requirements: requirementsInput.optional(),
      })
    )
    .min(1),
  pricing: z.object({
    mode: z.enum(["fixed", "daily"]),
    base: priceValue,
    callUp: optionalPrice,
    supplements: z
      .array(
        z.object({
          id: z.string(),
          name: text,
          points: priceValue,
          windowStart: z.string(),
          windowEnd: z.string(),
          weekdays: z.array(z.number().int().min(0).max(6)).optional(),
          minimumHours: z.coerce.number().nonnegative().optional(),
          recurrence: z.enum(["per_day", "once"]).default("per_day"),
        })
      )
      .default([]),
  }),
});
/** Rank, qualification, exemption and capability conditions must name existing catalog entries. */
export async function assertRequirementReferences(
  tx: DbTransaction,
  conditions: Requirements[]
) {
  const catalog = await tx.select().from(records);
  for (const condition of conditions) {
    for (const clause of condition.ranks ?? []) {
      const track = catalog.filter(
        (row) =>
          row.kind === "rank_catalog" && row.data.track === clause.trackId
      );
      invariant(
        track.length &&
          (!clause.rankIds ||
            clause.rankIds.every((id) => track.some((row) => row.id === id))),
        "invalid_rank_requirement",
        "תנאי הדרגה חייב להתייחס לדרגות קיימות באותו מסלול"
      );
    }
    for (const [kind, ids] of [
      ["qualification", condition.qualificationIds],
      ["exemption", condition.blockingExemptionIds],
      ["capability", condition.capabilityIds],
    ] as const)
      for (const id of ids ?? [])
        invariant(
          catalog.some(
            (row) =>
              row.id === id &&
              row.kind === "eligibility_catalog" &&
              row.data.kind === kind
          ),
          "invalid_requirement",
          "תנאי הכשירות, הפטור או היכולת אינו קיים בקטלוג"
        );
  }
}
export async function saveDutyType(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = catalogInput.parse(payload);
  const pricing: Pricing = {
    mode: input.pricing.mode,
    basePoints: input.pricing.base,
    ...(input.pricing.callUp && Number(input.pricing.callUp) > 0
      ? { callUpPoints: input.pricing.callUp }
      : {}),
    surcharges: input.pricing.supplements.map((item) => ({
      id: item.id,
      name: item.name,
      points: item.points,
      window: {
        startTime: item.windowStart,
        endTime: item.windowEnd,
        weekdays: item.weekdays?.map((day) => day || 7),
      },
      frequency: item.recurrence === "once" ? "once" : "per_window",
      threshold: item.minimumHours
        ? { kind: "minimum_hours", hours: String(item.minimumHours) }
        : { kind: "any_overlap" },
    })),
  };
  // Validate window syntax, thresholds, decimal values and the supported integer range.
  calculatePrice(
    pricing,
    "2026-01-01T00:00:00+02:00",
    "2026-01-02T00:00:00+02:00"
  );
  const requirements: Requirements = {
    populations: input.populations,
    ranks: input.ranks,
    qualificationIds: input.qualificationIds,
    blockingExemptionIds: input.exemptionIds,
    genders: input.genders,
    capabilityIds: input.capabilityIds,
  };
  await assertRequirementReferences(tx, [
    requirements,
    ...input.roles.map((role) => role.requirements ?? {}),
  ]);
  const data = { ...input, pricing, uiPricing: input.pricing, requirements };
  if (input.id) {
    const [existing] = await tx
      .select()
      .from(dutyTypes)
      .where(eq(dutyTypes.id, input.id));
    invariant(existing, "not_found", "סוג תורנות לא נמצא", 404);
    currentVersion(existing.version, expectedVersion);
    await tx
      .update(dutyTypes)
      .set({
        name: input.name,
        data,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(dutyTypes.id, input.id));
    await audit(tx, actor, "dutyType.update", input.id);
    return { id: input.id };
  }
  const typeId = randomUUID();
  await tx.insert(dutyTypes).values({ id: typeId, name: input.name, data });
  await audit(tx, actor, "dutyType.create", typeId);
  return { id: typeId };
}
export function parseMoment(value: string, offset?: number) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
    ? resolveLocalTime(value.slice(0, 10), value.slice(11), offset)
    : instant(value).toISO()!;
}
export async function createDuty(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  manager(actor);
  const input = z
    .object({
      typeId: id,
      name: text,
      start: text,
      end: text,
      startOffset: z.number().optional(),
      endOffset: z.number().optional(),
      location: z.string().max(500).default(""),
      instructions: z.string().max(4000).default(""),
    })
    .parse(payload);
  const [type] = await tx
    .select()
    .from(dutyTypes)
    .where(eq(dutyTypes.id, input.typeId));
  invariant(type, "not_found", "סוג תורנות לא נמצא", 404);
  const start = parseMoment(input.start, input.startOffset);
  const end = parseMoment(input.end, input.endOffset);
  interval({ start, end });
  const dutyId = randomUUID();
  const roles = type.data.roles as {
    name: string;
    count: number;
    requirements?: Requirements;
  }[];
  const data: Duty & { location: string; instructions: string } = {
    id: dutyId,
    typeId: type.id,
    name: input.name,
    start,
    end,
    location: input.location,
    instructions: input.instructions,
    version: 1,
    rulesVersion: 1,
    status: "draft",
    pricing: type.data.pricing as Pricing,
    requirements: type.data.requirements as Requirements,
    restBeforeMinutes: Number(type.data.restBeforeMinutes),
    restAfterMinutes: Number(type.data.restAfterMinutes),
    slots: roles.flatMap((role) =>
      Array.from({ length: role.count }, () => ({
        id: randomUUID(),
        role: role.name,
        requirements: role.requirements,
      }))
    ),
  };
  await tx
    .insert(duties)
    .values({ id: dutyId, typeId: type.id, name: data.name, data });
  await tx
    .insert(dutySlots)
    .values(
      data.slots.map((slot) => ({ id: slot.id, dutyId, data: { ...slot } }))
    );
  await audit(tx, actor, "duty.create", dutyId);
  return { id: dutyId };
}
const assignmentInput = z.object({
  dutyId: id,
  slotId: id,
  soldierId: id.optional(),
  callUpBonus: z.coerce.number().finite().nonnegative().default(0),
  reviewPending: z.boolean().default(false),
  previewToken: z.string().optional(),
  approvalReason: z.string().trim().max(2000).optional(),
  approvalKeys: z.array(z.string()).default([]),
});
function approvalKey(reason: EligibilityReason) {
  return `${reason.code}:${reason.referenceId ?? ""}:${reason.referenceVersion ?? ""}`;
}
function assignmentToken(
  state: Awaited<ReturnType<typeof loadDomain>>,
  input: z.infer<typeof assignmentInput>
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        state,
        dutyId: input.dutyId,
        slotId: input.slotId,
        soldierId: input.soldierId,
        callUpBonus: input.callUpBonus,
        reviewPending: input.reviewPending,
      })
    )
    .digest("hex");
}
export async function previewAssignment(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = assignmentInput.parse(payload);
  const state = await loadDomain(tx);
  const duty = state.duties.find((row) => row.id === input.dutyId);
  invariant(duty, "not_found", "תורנות לא נמצאה", 404);
  currentVersion(duty.version, expectedVersion);
  const slot = duty.slots.find((row) => row.id === input.slotId);
  const person = state.soldiers.find((row) => row.id === input.soldierId);
  invariant(slot && person, "not_found", "חייל או מקום לא נמצאו", 404);
  invariant(
    duty.status === "draft" && instant(duty.start).toMillis() > Date.now(),
    "published_change",
    "שיבוץ במסלול זה אפשרי בטיוטה שטרם התחילה"
  );
  invariant(
    !state.assignments.some(
      (row) => row.slotId === slot.id && row.status !== "cancelled"
    ),
    "occupied",
    "המקום כבר תפוס",
    409
  );
  const pendingReviewRequired = state.soldiers.some((row) =>
    row.constraints.some((item) => item.status === "pending")
  );
  const result = evaluateEligibility(person, duty, slot, {
    duties: state.duties,
    assignments: state.assignments,
    mode: "manual",
    pendingReviewConfirmed: input.reviewPending,
  });
  return {
    ...result,
    pendingReviewRequired,
    requirements: result.approvalsRequired.map((reason) => ({
      ...reason,
      key: approvalKey(reason),
    })),
    price: calculatePrice(
      duty.pricing,
      duty.start,
      duty.end,
      String(input.callUpBonus)
    ),
    previewToken: assignmentToken(state, input),
  };
}
export async function assignDuty(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = assignmentInput.parse(payload);
  const state = await loadDomain(tx);
  const duty = state.duties.find((row) => row.id === input.dutyId);
  invariant(duty, "not_found", "תורנות לא נמצאה", 404);
  currentVersion(duty.version, expectedVersion);
  invariant(
    duty.status === "draft",
    "published_change",
    "שינוי תורנות שפורסמה מחייב עדכן ופרסם"
  );
  invariant(
    instant(duty.start).toMillis() > Date.now(),
    "past_duty",
    "שיבוץ לאחר התחלה דורש מסלול טיפול בביצוע"
  );
  const slot = duty.slots.find((row) => row.id === input.slotId);
  invariant(slot, "not_found", "מקום לא נמצא", 404);
  invariant(
    !state.assignments.some(
      (row) => row.slotId === slot.id && row.status !== "cancelled"
    ),
    "occupied",
    "המקום כבר תפוס",
    409
  );
  const points = calculatePrice(
    duty.pricing,
    duty.start,
    duty.end,
    String(input.callUpBonus)
  );
  invariant(
    input.reviewPending ||
      !state.soldiers.some((row) =>
        row.constraints.some((item) => item.status === "pending")
      ),
    "pending_review_required",
    "יש אילוצים ממתינים. נדרש אישור מפורש להמשך לפני השלמת סקירתם"
  );
  const context = {
    duties: state.duties,
    assignments: state.assignments,
    mode: "manual" as const,
    pendingReviewConfirmed: input.reviewPending,
  };
  const person = state.soldiers.find((row) => row.id === input.soldierId);
  invariant(person, "not_found", "חייל לא נמצא", 404);
  const eligibility = evaluateEligibility(person, duty, slot, context);
  invariant(
    eligibility.status !== "blocked",
    eligibility.status,
    eligibility.blockers.some((row) => row.code === "manager")
      ? MANAGER_BLOCKER_MESSAGE
      : "לא ניתן להשלים שיבוץ: נדרשת בדיקת התאמה",
    422,
    eligibility
  );
  const approvals: SpecificApproval[] = [];
  if (input.previewToken)
    invariant(
      input.previewToken === assignmentToken(state, input),
      "stale_preview",
      "נתוני השיבוץ השתנו. יש לבדוק את ההתאמה מחדש",
      409
    );
  if (eligibility.approvalsRequired.length) {
    invariant(
      input.previewToken === assignmentToken(state, input) &&
        input.approvalReason,
      "approval_required",
      "לא ניתן להשלים שיבוץ: נדרשת בדיקת התאמה ואישור חריג מנומק",
      422,
      eligibility
    );
    for (const reason of eligibility.approvalsRequired) {
      invariant(
        reason.code !== "pending_review" &&
          input.approvalKeys.includes(approvalKey(reason)),
        "approval_required",
        "נדרש אישור נפרד לכל חריג"
      );
      invariant(
        [
          "exemption",
          "rank",
          "allowed_hours",
          "pending_constraint",
          "near_release",
        ].includes(reason.code),
        "unknown_exception",
        "אין סמכות לחריגה מהתנאי הזה"
      );
      approvals.push({
        kind: reason.code as SpecificApproval["kind"],
        soldierId: person.id,
        soldierVersion: person.version,
        dutyId: duty.id,
        dutyVersion: duty.rulesVersion ?? duty.version,
        referenceId: reason.referenceId,
        referenceVersion: reason.referenceVersion,
        reason: input.approvalReason,
        approvedBy: actor.id,
        approvedAt: new Date().toISOString(),
      });
    }
  }
  const confirmed = evaluateEligibility(person, duty, slot, {
    ...context,
    approvals,
  });
  invariant(
    confirmed.status === "eligible",
    "approval_required",
    "בדיקת ההתאמה לא הושלמה",
    422,
    confirmed
  );
  const assignmentId = randomUUID();
  const data: Assignment = {
    id: assignmentId,
    dutyId: duty.id,
    slotId: slot.id,
    soldierId: person.id,
    points: points.points,
    status: "reserved",
    version: 1,
    extraPoints: String(input.callUpBonus),
    approvals,
    pendingReviewConfirmed: input.reviewPending,
  };
  await tx.insert(assignments).values({ ...data, data });
  await tx
    .update(duties)
    .set({
      version: duty.version + 1,
      data: {
        ...duty,
        rulesVersion: duty.rulesVersion ?? duty.version,
        version: duty.version + 1,
      },
      updatedAt: new Date(),
    })
    .where(eq(duties.id, duty.id));
  await audit(tx, actor, "duty.assign", assignmentId, {
    dutyId: duty.id,
    points: points.points,
  });
  if (approvals.length)
    await tx.insert(records).values({
      id: randomUUID(),
      kind: "assignment_approval",
      subjectId: person.id,
      data: { assignmentId, approvals },
    });
  return { id: assignmentId };
}
export async function publishDuty(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z.object({ id, confirmed: z.literal(true) }).parse(payload);
  const [row] = await tx.select().from(duties).where(eq(duties.id, input.id));
  invariant(row, "not_found", "תורנות לא נמצאה", 404);
  currentVersion(row.version, expectedVersion);
  invariant(
    row.data.status === "draft" &&
      instant(row.data.start).toMillis() > Date.now(),
    "cannot_publish",
    "ניתן לפרסם טיוטה שטרם התחילה"
  );
  const state = await loadDomain(tx);
  for (const assignment of state.assignments.filter(
    (item) => item.dutyId === row.id && item.status === "reserved"
  )) {
    const person = state.soldiers.find(
      (item) => item.id === assignment.soldierId
    );
    const slot = row.data.slots.find((item) => item.id === assignment.slotId);
    invariant(
      person && slot,
      "invalid_assignment",
      "שיבוץ דורש בדיקה לפני פרסום"
    );
    const result = evaluateEligibility(person, row.data, slot, {
      duties: state.duties,
      assignments: state.assignments,
      mode: "manual",
      ignoreAssignmentIds: [assignment.id],
      approvals: assignment.approvals,
      pendingReviewConfirmed: assignment.pendingReviewConfirmed,
    });
    invariant(
      result.status === "eligible",
      "assignment_changed",
      "נתוני השיבוץ השתנו. יש לטפל בהתאמה לפני פרסום",
      422,
      result
    );
  }
  const version = row.version + 1;
  await tx
    .update(duties)
    .set({
      data: {
        ...row.data,
        status: "published",
        version,
        publishedAt: new Date().toISOString(),
      },
      version,
      updatedAt: new Date(),
    })
    .where(eq(duties.id, row.id));
  const assigned = await tx
    .select()
    .from(assignments)
    .where(
      and(eq(assignments.dutyId, row.id), eq(assignments.status, "reserved"))
    );
  for (const item of assigned) {
    const [account] = await tx
      .select()
      .from(user)
      .where(eq(user.soldierId, item.soldierId));
    if (!account) continue;
    const title = "פורסם שיבוץ לתורנות";
    const body = `שובצת לתורנות ${row.name}`;
    const href = `/duties/${row.id}`;
    await tx.insert(records).values({
      id: randomUUID(),
      kind: "notification",
      subjectId: item.soldierId,
      data: { accountId: account.id, title, body, href },
    });
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey: `publish:${row.id}:${version}:${account.id}`,
      kind: "publication",
      title,
      body,
      href,
      priority: 1,
      expiresAt: new Date(
        Math.min(Date.now() + 86_400_000, instant(row.data.end).toMillis())
      ),
    });
  }
  await audit(tx, actor, "duty.publish", row.id);
  return { id: row.id, version };
}
