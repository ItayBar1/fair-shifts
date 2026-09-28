import { createHash, randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { records } from "./schema";
import { user } from "./auth-schema";
import {
  audit,
  createRecord,
  currentVersion,
  findRecord,
  loadDomain,
  manager,
  updateRecord,
  type Actor,
  type Workflow,
} from "./repository";
import { id, date, text } from "./validation";
import { invariant } from "./errors";
import { drawCandidate } from "../domain/scheduling";
import { evaluateEligibility } from "../domain/eligibility";
import { calculatePrice } from "../domain/pricing";
import { instant } from "../domain/time";
import { assignDuty, previewAssignment } from "./duty-service";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
async function picture(tx: DbTransaction) {
  const state = await loadDomain(tx);
  const exclusions = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "lottery_exclusion"));
  const snapshot = {
    soldiers: [...state.soldiers].sort((a, b) => a.id.localeCompare(b.id)),
    duties: [...state.duties].sort((a, b) => a.id.localeCompare(b.id)),
    assignments: [...state.assignments].sort((a, b) =>
      a.id.localeCompare(b.id)
    ),
    exclusions: exclusions
      .map((row) => ({ id: row.id, data: row.data }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return {
    state,
    exclusions,
    fingerprint: createHash("sha256").update(canonical(snapshot)).digest("hex"),
  };
}
function response(attempt: Workflow): Record<string, unknown> & {
  proposalId: string;
  version: number;
  status: string;
} {
  return {
    ...attempt.data,
    proposalId: attempt.id,
    version: attempt.version,
    status: String(attempt.data.status),
  };
}
const drawInput = z.object({
  dutyId: id,
  slotId: id,
  reviewPending: z.boolean().default(false),
  callUpBonus: z.number().finite().nonnegative().default(0),
});
export async function drawLottery(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number,
  random = (bandSize: number) => (randomInt(bandSize) + 0.5) / bandSize
) {
  manager(actor);
  const input = drawInput.parse(payload);
  const { state, exclusions, fingerprint } = await picture(tx);
  const duty = state.duties.find((row) => row.id === input.dutyId);
  invariant(duty, "not_found", "תורנות לא נמצאה", 404);
  currentVersion(duty.version, expectedVersion);
  invariant(
    duty.status === "draft" && instant(duty.start).toMillis() > Date.now(),
    "cannot_plan",
    "אפשר להגריל לטיוטה שטרם התחילה בלבד"
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
  invariant(
    input.reviewPending ||
      !state.soldiers.some((row) =>
        row.constraints.some((c) => c.status === "pending")
      ),
    "pending_review_required",
    "יש לאשר המשך לפני השלמת סקירת האילוצים הממתינים"
  );
  const pending = (
    await tx.select().from(records).where(eq(records.kind, "lottery_attempt"))
  ).filter(
    (row) =>
      row.data.dutyId === duty.id &&
      row.data.slotId === slot.id &&
      row.data.status === "approval_required"
  );
  for (const previous of pending) {
    if (
      previous.data.fingerprint === fingerprint &&
      previous.data.callUpBonus === input.callUpBonus &&
      previous.data.reviewPending === input.reviewPending
    )
      return response(previous);
    await updateRecord(tx, previous, { ...previous.data, status: "stale" });
  }
  const excluded = new Set(
    exclusions
      .filter((row) => row.data.dutyId === duty.id)
      .map((row) => row.subjectId)
  );
  const people = state.soldiers.filter((row) => !excluded.has(row.id));
  const price = calculatePrice(
    duty.pricing,
    duty.start,
    duty.end,
    String(input.callUpBonus)
  );
  const context = {
    duties: state.duties,
    assignments: state.assignments,
    mode: "automatic" as const,
    pendingReviewConfirmed: input.reviewPending,
  };
  const draw = drawCandidate(people, duty, slot, price.points, context, random);
  const selected = "selected" in draw ? draw.selected : undefined;
  const attempt = await createRecord(
    tx,
    "lottery_attempt",
    {
      ...input,
      dutyVersion: duty.version,
      fingerprint,
      status: draw.status,
      weight: price.points,
      minimum: "minimum" in draw ? draw.minimum : null,
      band: "band" in draw ? draw.band : [],
      candidateId: selected?.soldier.id ?? null,
      requirements:
        selected?.eligibility.approvalsRequired.map((reason) => ({
          ...reason,
          key: `${reason.code}:${reason.referenceId ?? ""}:${reason.referenceVersion ?? ""}`,
        })) ?? [],
      candidates: draw.candidates.map((row) => ({
        id: row.soldier.id,
        score: row.score,
        status: row.eligibility.status,
        blockers: row.eligibility.blockers,
        approvalsRequired: row.eligibility.approvalsRequired,
      })),
      excludedIds: [...excluded],
      drawnBy: actor.id,
    },
    selected?.soldier.id
  );
  if (draw.status === "selected") {
    const assigned = await assignDuty(
      tx,
      actor,
      { ...input, soldierId: draw.selected.soldier.id },
      duty.version
    );
    return response(
      await updateRecord(tx, attempt, {
        ...attempt.data,
        status: "assigned",
        assignmentId: assigned.id,
      })
    );
  }
  await audit(tx, actor, "lottery.draw", attempt.id, {
    dutyId: duty.id,
    status: draw.status,
  });
  return response(attempt);
}
export async function decideLottery(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({
      proposalId: id,
      decision: z.enum(["approve", "reject"]),
      reason: text,
      approvalKeys: z.array(z.string()).default([]),
    })
    .parse(payload);
  const attempt = await findRecord(tx, "lottery_attempt", input.proposalId);
  currentVersion(attempt.version, expectedVersion);
  invariant(
    attempt.data.status === "approval_required",
    "already_decided",
    "ההצעה כבר נסגרה או התיישנה",
    409
  );
  const { state, fingerprint } = await picture(tx);
  invariant(
    fingerprint === attempt.data.fingerprint,
    "stale_proposal",
    "הנתונים השתנו בזמן ההמתנה. יש לבצע הגרלה חדשה",
    409
  );
  const duty = state.duties.find((row) => row.id === attempt.data.dutyId)!;
  const slot = duty.slots.find((row) => row.id === attempt.data.slotId)!;
  invariant(
    instant(duty.start).toMillis() > Date.now(),
    "past_duty",
    "התורנות כבר התחילה ונדרש טיפול בביצוע"
  );
  const person = state.soldiers.find(
    (row) => row.id === attempt.data.candidateId
  )!;
  const draw = drawInput.parse(attempt.data);
  if (input.decision === "reject") {
    await createRecord(
      tx,
      "lottery_exclusion",
      {
        dutyId: duty.id,
        proposalId: attempt.id,
        reason: input.reason,
        decidedBy: actor.id,
      },
      person.id
    );
    const rejected = await updateRecord(tx, attempt, {
      ...attempt.data,
      status: "rejected",
      decidedBy: actor.id,
      reason: input.reason,
    });
    const replacement = await drawLottery(tx, actor, draw, duty.version);
    await updateRecord(tx, rejected, {
      ...rejected.data,
      replacementId: replacement.proposalId,
    });
    return replacement;
  }
  const eligibility = evaluateEligibility(person, duty, slot, {
    duties: state.duties,
    assignments: state.assignments,
    mode: "automatic",
    pendingReviewConfirmed: draw.reviewPending,
  });
  invariant(
    eligibility.status !== "blocked",
    "candidate_changed",
    "המועמד אינו מתאים עוד",
    409
  );
  const payloadForAssignment = { ...draw, soldierId: person.id };
  const preview = await previewAssignment(
    tx,
    actor,
    payloadForAssignment,
    duty.version
  );
  invariant(
    preview.requirements.every((row) => input.approvalKeys.includes(row.key)),
    "approval_required",
    "נדרש אישור מפורש לכל התנגשות ולכל תנאי הדורש אישור"
  );
  const assigned = await assignDuty(
    tx,
    actor,
    {
      ...payloadForAssignment,
      previewToken: preview.previewToken,
      approvalKeys: input.approvalKeys,
      approvalReason: input.reason,
    },
    duty.version
  );
  return response(
    await updateRecord(tx, attempt, {
      ...attempt.data,
      status: "assigned",
      assignmentId: assigned.id,
      decidedBy: actor.id,
      reason: input.reason,
    })
  );
}

export async function createPlan(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  manager(actor);
  const input = z
    .object({
      start: date,
      end: date,
      dutyIds: z.array(id).optional(),
      reviewPending: z.boolean().default(false),
    })
    .parse(payload);
  invariant(
    input.end >= input.start,
    "invalid_period",
    "תקופת התכנון אינה תקינה"
  );
  const state = await loadDomain(tx);
  const duties = state.duties.filter(
    (row) =>
      row.status === "draft" &&
      instant(row.start).toMillis() > Date.now() &&
      instant(row.start).toISODate()! >= input.start &&
      instant(row.start).toISODate()! <= input.end &&
      (!input.dutyIds || input.dutyIds.includes(row.id))
  );
  invariant(
    !input.dutyIds ||
      input.dutyIds.every((id) => duties.some((row) => row.id === id)),
    "invalid_duties",
    "נבחרו תורנויות שאינן טיוטות עתידיות בתקופה"
  );
  const run = await createRecord(tx, "planning_run", {
    ...input,
    dutyIds: duties.map((row) => row.id),
    processedSlots: [],
    status: "running",
    results: [],
    createdBy: actor.id,
  });
  await audit(tx, actor, "planning.create", run.id);
  return { id: run.id, version: run.version, status: "running" };
}
/** One seat per command/transaction. The client can resume after a disconnect. */
export async function stepPlan(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({ id, reviewPending: z.boolean().optional() })
    .parse(payload);
  const run = await findRecord(tx, "planning_run", input.id);
  currentVersion(run.version, expectedVersion);
  if (run.data.status === "completed")
    return { id: run.id, version: run.version, ...run.data };
  const { state, exclusions, fingerprint } = await picture(tx);
  const attempts = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "lottery_attempt"));
  const latestAttempt = (proposalId: unknown) => {
    let attempt = attempts.find((row) => row.id === proposalId);
    const seen = new Set<string>();
    while (attempt?.data.replacementId && !seen.has(attempt.id)) {
      seen.add(attempt.id);
      attempt =
        attempts.find((row) => row.id === attempt!.data.replacementId) ??
        attempt;
    }
    return attempt;
  };
  const waitingFor = latestAttempt(run.data.proposalId);
  if (
    waitingFor?.data.status === "approval_required" &&
    waitingFor.data.fingerprint === fingerprint
  )
    return { ...run.data, id: run.id, version: run.version };
  if (waitingFor?.data.status === "approval_required")
    await updateRecord(tx, waitingFor, { ...waitingFor.data, status: "stale" });
  const selectedIds = run.data.dutyIds as string[];
  const processed = run.data.processedSlots as string[];
  const reviewPending = input.reviewPending ?? Boolean(run.data.reviewPending);
  invariant(
    reviewPending ||
      !state.soldiers.some((row) =>
        row.constraints.some((c) => c.status === "pending")
      ),
    "pending_review_required",
    "נדרש אישור המשך לפני סקירת האילוצים"
  );
  const pendingSlots = state.duties
    .filter(
      (row) =>
        selectedIds.includes(row.id) &&
        row.status === "draft" &&
        instant(row.start).toMillis() > Date.now()
    )
    .flatMap((duty) => {
      const excluded = new Set(
        exclusions
          .filter((row) => row.data.dutyId === duty.id)
          .map((row) => row.subjectId)
      );
      const slots = duty.slots
        .filter(
          (slot) =>
            !processed.includes(slot.id) &&
            !state.assignments.some(
              (row) => row.slotId === slot.id && row.status !== "cancelled"
            )
        )
        .map((slot) => ({
          duty,
          slot,
          candidates: state.soldiers
            .filter(
              (person) =>
                !excluded.has(person.id) &&
                evaluateEligibility(person, duty, slot, {
                  duties: state.duties,
                  assignments: state.assignments,
                  mode: "automatic",
                  pendingReviewConfirmed: reviewPending,
                }).status !== "blocked"
            )
            .map((person) => person.id),
        }));
      const difficulty = new Set(slots.flatMap((row) => row.candidates)).size;
      return slots.map((row) => ({ ...row, difficulty }));
    })
    .sort(
      (a, b) =>
        a.difficulty - b.difficulty ||
        instant(a.duty.start).toMillis() - instant(b.duty.start).toMillis() ||
        a.duty.id.localeCompare(b.duty.id) ||
        a.candidates.length - b.candidates.length ||
        a.slot.id.localeCompare(b.slot.id)
    );
  const next = pendingSlots[0];
  const results: Record<string, unknown>[] = (
    run.data.results as Record<string, unknown>[]
  ).map((row) => {
    const attempt = latestAttempt(row.proposalId);
    return {
      ...row,
      proposalId: attempt?.id ?? row.proposalId,
      status: attempt?.data.status ?? row.status,
    };
  });
  if (!next) {
    const missing = state.duties
      .filter(
        (row) => selectedIds.includes(row.id) && row.status !== "cancelled"
      )
      .flatMap((duty) =>
        duty.slots
          .filter(
            (slot) =>
              !state.assignments.some(
                (row) => row.slotId === slot.id && row.status !== "cancelled"
              )
          )
          .map((slot) => ({ dutyId: duty.id, slotId: slot.id }))
      );
    const done = await updateRecord(tx, run, {
      ...run.data,
      results,
      status: "completed",
      missing,
      completedAt: new Date().toISOString(),
    });
    if (missing.length)
      for (const recipient of await tx
        .select()
        .from(user)
        .where(eq(user.role, "manager")))
        if (!recipient.deletedAt)
          await createRecord(tx, "notification", {
            accountId: recipient.id,
            title: "נותרו מקומות לא מאוישים בתכנון",
            body: `${missing.length} מקומות נותרו לטיפול. הסיבות מופיעות בניסיונות ההגרלה.`,
            href: "/manage/planning",
            runId: run.id,
          });
    await audit(tx, actor, "planning.complete", run.id, {
      missing: missing.length,
    });
    return { ...done.data, id: done.id, version: done.version };
  }
  const result = await drawLottery(
    tx,
    actor,
    { dutyId: next.duty.id, slotId: next.slot.id, reviewPending },
    next.duty.version
  );
  const waiting = result.status === "approval_required";
  const updated = await updateRecord(tx, run, {
    ...run.data,
    reviewPending,
    status: waiting ? "awaiting_approval" : "running",
    proposalId: waiting ? result.proposalId : null,
    processedSlots: waiting ? processed : [...processed, next.slot.id],
    results: [
      ...results.filter((row) => row.slotId !== next.slot.id),
      {
        dutyId: next.duty.id,
        slotId: next.slot.id,
        proposalId: result.proposalId,
        status: result.status,
      },
    ],
  });
  return { ...updated.data, id: updated.id, version: updated.version };
}
