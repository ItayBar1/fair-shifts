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
type Unit = Awaited<ReturnType<typeof loadDomain>>;
type Exclusion = typeof records.$inferSelect;
async function picture(tx: DbTransaction) {
  const state = await loadDomain(tx);
  const exclusions = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "lottery_exclusion"));
  return { state, exclusions };
}
/** Constraints still awaiting review, by version: a changed request is a new item. */
function pendingKeys(state: Unit) {
  return state.soldiers
    .flatMap((person) =>
      person.constraints
        .filter((row) => row.status === "pending")
        .map((row) => `${row.id}:${row.version}`)
    )
    .sort();
}
function occupant(state: Unit, slotId: string) {
  return state.assignments.find(
    (row) => row.slotId === slotId && row.status !== "cancelled"
  );
}
/**
 * One seat's draw and its picture (decision 182): the seat and its value, every
 * candidate's check, the scores of the eligible, the minimum, the band and this
 * duty's exclusions. A pending proposal stays valid while this picture is
 * unchanged, whatever else changes in the unit.
 */
function seatDraw(
  state: Unit,
  exclusions: Exclusion[],
  input: z.infer<typeof drawInput>,
  random: (bandSize: number) => number = () => 0
) {
  const duty = state.duties.find((row) => row.id === input.dutyId);
  const slot = duty?.slots.find((row) => row.id === input.slotId);
  if (!duty || !slot) return undefined;
  const excluded = [
    ...new Set(
      exclusions
        .filter((row) => row.data.dutyId === duty.id)
        .map((row) => row.subjectId!)
    ),
  ].sort();
  const people = state.soldiers.filter((row) => !excluded.includes(row.id));
  const price = calculatePrice(
    duty.pricing,
    duty.start,
    duty.end,
    String(input.callUpBonus)
  );
  const draw = drawCandidate(
    people,
    duty,
    slot,
    price.points,
    {
      duties: state.duties,
      assignments: state.assignments,
      mode: "automatic",
      pendingReviewConfirmed: input.reviewPending,
    },
    random
  );
  const candidates = draw.candidates.map((row) => ({
    id: row.soldier.id,
    score: row.score,
    status: row.eligibility.status,
    blockers: row.eligibility.blockers,
    approvalsRequired: row.eligibility.approvalsRequired,
  }));
  const minimum = "minimum" in draw ? draw.minimum : null;
  const band = "band" in draw ? draw.band : [];
  const fingerprint = createHash("sha256")
    .update(
      canonical({
        ...input,
        start: duty.start,
        end: duty.end,
        weight: price.points,
        minimum,
        band,
        excluded,
        // A blocked candidate's score takes no part in the draw.
        candidates: candidates.map((row) =>
          row.status === "blocked" ? { ...row, score: undefined } : row
        ),
      })
    )
    .digest("hex");
  return {
    duty,
    slot,
    draw,
    weight: price.points,
    minimum,
    band,
    candidates,
    excluded,
    fingerprint,
  };
}
/** Whether a proposal may still become an assignment: a future draft seat that is still vacant. */
function openSeat(state: Unit, seat: NonNullable<ReturnType<typeof seatDraw>>) {
  return (
    seat.duty.status === "draft" &&
    instant(seat.duty.start).toMillis() > Date.now() &&
    !occupant(state, seat.slot.id)
  );
}
/** A proposal awaiting approval that could still be approved as drawn (decision 182). */
function stillWaiting(
  state: Unit,
  exclusions: Exclusion[],
  attempt: { data: Record<string, unknown> }
) {
  if (attempt.data.status !== "approval_required") return false;
  const seat = seatDraw(state, exclusions, drawInput.parse(attempt.data));
  return Boolean(
    seat &&
    openSeat(state, seat) &&
    seat.fingerprint === attempt.data.fingerprint
  );
}
/**
 * Draws and runs for the managers' screens, as of now: a waiting proposal whose
 * picture changed shows as stale before the next action records it, and a run
 * waiting only on such a proposal can continue.
 */
export function projectPlanning(
  state: Unit,
  workflows: (typeof records.$inferSelect)[]
) {
  const exclusions = workflows.filter(
    (row) => row.kind === "lottery_exclusion"
  );
  const attempts = new Map<string, Record<string, unknown> & { id: string }>(
    workflows
      .filter((row) => row.kind === "lottery_attempt")
      .map((row) => {
        const expired =
          row.data.status === "approval_required" &&
          !stillWaiting(state, exclusions, row);
        return [
          row.id,
          {
            ...(row.data as Record<string, unknown>),
            id: row.id,
            version: row.version,
            subjectId: row.subjectId,
            status: expired ? "stale" : row.data.status,
          },
        ];
      })
  );
  const latest = (proposalId: unknown) => {
    let attempt = attempts.get(String(proposalId));
    const seen = new Set<string>();
    while (attempt?.replacementId && !seen.has(attempt.id)) {
      seen.add(attempt.id);
      attempt = attempts.get(String(attempt.replacementId)) ?? attempt;
    }
    return attempt;
  };
  const runs = workflows
    .filter((row) => row.kind === "planning_run")
    .map((row) => ({
      ...row.data,
      id: row.id,
      version: row.version,
      subjectId: row.subjectId,
      status:
        row.data.status === "awaiting_approval" &&
        latest(row.data.proposalId)?.status !== "approval_required"
          ? "running"
          : row.data.status,
    }));
  return { lotteryAttempts: [...attempts.values()], planningRuns: runs };
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
  const { state, exclusions } = await picture(tx);
  const duty = state.duties.find((row) => row.id === input.dutyId);
  invariant(duty, "not_found", "תורנות לא נמצאה", 404);
  currentVersion(duty.version, expectedVersion);
  invariant(
    duty.status === "draft" && instant(duty.start).toMillis() > Date.now(),
    "cannot_plan",
    "אפשר להגריל לטיוטה שטרם התחילה בלבד"
  );
  invariant(
    duty.slots.some((row) => row.id === input.slotId),
    "not_found",
    "מקום לא נמצא",
    404
  );
  invariant(!occupant(state, input.slotId), "occupied", "המקום כבר תפוס", 409);
  invariant(
    input.reviewPending || !pendingKeys(state).length,
    "pending_review_required",
    "יש לאשר המשך לפני השלמת סקירת האילוצים הממתינים"
  );
  const seat = seatDraw(state, exclusions, input, random)!;
  const pending = (
    await tx.select().from(records).where(eq(records.kind, "lottery_attempt"))
  ).filter(
    (row) =>
      row.data.dutyId === duty.id &&
      row.data.slotId === input.slotId &&
      row.data.status === "approval_required"
  );
  for (const previous of pending) {
    if (previous.data.fingerprint === seat.fingerprint)
      return response(previous);
    await updateRecord(tx, previous, { ...previous.data, status: "stale" });
  }
  const { draw } = seat;
  const selected = "selected" in draw ? draw.selected : undefined;
  const attempt = await createRecord(
    tx,
    "lottery_attempt",
    {
      ...input,
      dutyVersion: duty.version,
      fingerprint: seat.fingerprint,
      status: draw.status,
      weight: seat.weight,
      minimum: seat.minimum,
      band: seat.band,
      candidateId: selected?.soldier.id ?? null,
      requirements:
        selected?.eligibility.approvalsRequired.map((reason) => ({
          ...reason,
          key: `${reason.code}:${reason.referenceId ?? ""}:${reason.referenceVersion ?? ""}`,
        })) ?? [],
      candidates: seat.candidates,
      excludedIds: seat.excluded,
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
  const { state, exclusions } = await picture(tx);
  const draw = drawInput.parse(attempt.data);
  const seat = seatDraw(state, exclusions, draw);
  const stale = [
    "stale_proposal",
    "הנתונים השתנו בזמן ההמתנה. יש לבצע הגרלה חדשה",
    409,
  ] as const;
  invariant(seat, ...stale);
  const { duty, slot } = seat;
  invariant(
    instant(duty.start).toMillis() > Date.now(),
    "past_duty",
    "התורנות כבר התחילה ונדרש טיפול בביצוע"
  );
  // A published version stays binding; a proposal never changes it directly.
  invariant(
    openSeat(state, seat) && seat.fingerprint === attempt.data.fingerprint,
    ...stale
  );
  const person = state.soldiers.find(
    (row) => row.id === attempt.data.candidateId
  )!;
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

/**
 * The confirmation to plan before review covers the constraints pending when it
 * was given (decision 182). A later pending request needs a new confirmation,
 * whichever manager continues the run.
 */
function reviewConfirmation(state: Unit, actor: Actor, confirmed: boolean) {
  return confirmed
    ? {
        reviewCovers: pendingKeys(state),
        reviewConfirmedBy: actor.id,
        reviewConfirmedAt: new Date().toISOString(),
      }
    : {};
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
    ...reviewConfirmation(state, actor, input.reviewPending),
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
  const { state, exclusions } = await picture(tx);
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
  if (waitingFor?.data.status === "approval_required") {
    if (stillWaiting(state, exclusions, waitingFor))
      return { ...run.data, id: run.id, version: run.version };
    const stale = await updateRecord(tx, waitingFor, {
      ...waitingFor.data,
      status: "stale",
    });
    attempts.splice(attempts.indexOf(waitingFor), 1, stale);
  }
  const selectedIds = run.data.dutyIds as string[];
  const processed = run.data.processedSlots as string[];
  const pendingNow = pendingKeys(state);
  const confirmation = input.reviewPending
    ? reviewConfirmation(state, actor, true)
    : {
        reviewCovers: run.data.reviewCovers as string[] | undefined,
        reviewConfirmedBy: run.data.reviewConfirmedBy,
        reviewConfirmedAt: run.data.reviewConfirmedAt,
      };
  // Also before completing: a run never closes over an unconfirmed pending request.
  const covered = new Set(confirmation.reviewCovers ?? []);
  invariant(
    pendingNow.every((key) => covered.has(key)),
    "pending_review_required",
    covered.size
      ? "הוגשו אילוצים ממתינים חדשים מאז אישור ההמשך. נדרש אישור המשך חדש לפני סקירתם"
      : "נדרש אישור המשך לפני סקירת האילוצים"
  );
  const reviewPending = pendingNow.length > 0;
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
    const seat = occupant(state, String(row.slotId));
    return {
      ...row,
      proposalId: attempt?.id ?? row.proposalId,
      // A seat filled by another action is reported as such, not as a waiting draw.
      status:
        seat && seat.id !== attempt?.data.assignmentId
          ? "filled"
          : (attempt?.data.status ?? row.status),
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
      ...confirmation,
      proposalId: null,
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
    ...confirmation,
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
