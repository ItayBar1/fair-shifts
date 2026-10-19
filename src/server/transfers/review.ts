import { createHash } from "node:crypto";
import { z } from "zod";
import type { DbTransaction } from "../db";
import {
  audit,
  currentVersion,
  findRecord,
  loadDomain,
  manager,
  updateRecord,
  type Actor,
  type Workflow,
} from "../repository";
import { invariant } from "../errors";
import { id } from "../validation";
import { evaluateEligibility } from "../../domain/eligibility";
import { instant } from "../../domain/time";
import type { Assignment, Duty, SpecificApproval } from "../../domain/types";
import {
  approvalKey,
  notifyManagers,
  performanceEnded,
  PERFORMANCE_ENDED_MESSAGE,
} from "../seat-requests";
import { closeRequestsOfTransferredSeat } from "../cancellation-requests";
import {
  commitExecution,
  executionView,
  handoverInput,
  handoverSegments,
  parseHandover,
  planExecution,
  seatOf,
  fixedAllocationInput,
  type FixedAllocation,
} from "../execution";
import { executionPeriod } from "../../domain/execution";
import { completeTransfer } from "./completion";
import { expire } from "./offer";
import { candidateEligibility, nameOf, notify } from "./rules";
import { type Domain, type TransferData } from "./types";

/** Everything a manager's decision rests on; any change requires a fresh review. */
function reviewToken(
  state: Domain,
  row: Workflow,
  data: TransferData,
  duty: Duty
) {
  const soldierId = data.acceptedBy;
  const seats = state.assignments.filter(
    (item) => item.id === data.assignmentId || item.soldierId === soldierId
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        request: [row.id, row.version],
        duty,
        soldier: state.soldiers.find((item) => item.id === soldierId),
        seats,
        duties: state.duties.filter((item) =>
          seats.some((seat) => seat.dutyId === item.id)
        ),
      })
    )
    .digest("hex");
}
async function awaitingManager(
  tx: DbTransaction,
  actor: Actor,
  requestId: string,
  expectedVersion?: number
) {
  manager(actor);
  const row = await findRecord(tx, "request", requestId);
  const data = row.data as TransferData;
  invariant(data.type === "transfer", "not_found", "הבקשה לא נמצאה", 404);
  currentVersion(row.version, expectedVersion);
  invariant(
    data.status === "awaiting_manager" && data.acceptedBy,
    "transfer_closed",
    "ההעברה כבר אינה ממתינה להחלטת אחראי",
    409
  );
  const state = await loadDomain(tx);
  const seat = state.assignments.find((item) => item.id === data.assignmentId);
  const duty = state.duties.find((item) => item.id === data.dutyId);
  const person = state.soldiers.find((item) => item.id === data.acceptedBy);
  const changed =
    !seat || seat.status !== "reserved" || seat.soldierId !== data.fromSoldierId
      ? "השיבוץ המקורי השתנה או הוסר אחרי ההסכמה"
      : !duty ||
          duty.status !== "published" ||
          (duty.rulesVersion ?? duty.version) !== data.dutyRulesVersion
        ? "התורנות עודכנה או בוטלה אחרי ההסכמה"
        : !person || person.deletedAt
          ? "המחליף אינו זמין עוד"
          : undefined;
  return { row, data, state, seat, duty, person, changed };
}

/** Current review for a manager (ended offers expire): current eligibility of the replacement and the exceptions to approve. */
export async function reviewTransfer(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  // Permission first: a caller who may not decide learns nothing from the input check.
  manager(actor);
  const input = z
    .object({
      id,
      ...handoverInput,
      allocations: z.array(fixedAllocationInput).optional(),
    })
    .parse(payload);
  const { row, data, state, seat, duty, person, changed } =
    await awaitingManager(tx, actor, input.id, expectedVersion);
  if (seat && duty && performanceEnded(seat, duty))
    return expire(tx, row, PERFORMANCE_ENDED_MESSAGE, "performance_ended");
  if (changed || !duty || !person || !seat)
    return { valid: false, message: changed ?? "ההעברה אינה תקפה עוד" };
  const started = instant(duty.start).toMillis() <= Date.now();
  if (started) {
    // After the start the manager sets the handover and sees both periods before approving.
    const period = executionPeriod(seat, duty);
    const handoverAt = parseHandover(input.handoverAt, input.handoverOffset);
    if (!handoverAt)
      return { valid: true, started, handoverRequired: true, period };
    const plan = await startedPlan(
      tx,
      data,
      seat,
      handoverAt,
      input.allocations
    );
    const replacement = plan.changes.find(
      (change) => change.soldierId === data.acceptedBy
    );
    return {
      valid: true,
      started,
      period,
      handoverAt,
      status: replacement?.eligibility?.blockers.length
        ? "blocked"
        : replacement?.eligibility?.requirements.length
          ? "approval_required"
          : "eligible",
      blockers: replacement?.eligibility?.blockers ?? [],
      requirements: replacement?.eligibility?.requirements ?? [],
      execution: executionView(plan),
      previewToken: startedToken(plan, row, data, duty),
    };
  }
  const eligibility = candidateEligibility(state, person, duty, data.slotId);
  return {
    valid: true,
    started,
    status: eligibility.status,
    blockers: eligibility.blockers,
    requirements: eligibility.approvalsRequired.map((reason) => ({
      ...reason,
      key: approvalKey(reason),
    })),
    previewToken: reviewToken(state, row, data, duty),
  };
}

/** A manager approves a transfer that needs exceptions, or rejects it with a reason visible to both sides (decision 178). */
export async function decideTransfer(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  // Permission first: a caller who may not decide learns nothing from the input check.
  manager(actor);
  const input = z
    .discriminatedUnion("decision", [
      z.object({
        id,
        decision: z.literal("reject"),
        reason: z.string().trim().min(1).max(2000),
      }),
      z.object({
        id,
        decision: z.literal("approve"),
        previewToken: z.string().min(1),
        approvalReason: z.string().trim().max(2000).optional(),
        approvalKeys: z.array(z.string()).default([]),
        confirmed: z.literal(true),
        ...handoverInput,
        allocations: z.array(fixedAllocationInput).optional(),
        allocationReason: z.string().trim().min(1).max(2000).optional(),
      }),
    ])
    .parse(payload);
  const { row, data, state, seat, duty, person, changed } =
    await awaitingManager(tx, actor, input.id, expectedVersion);
  if (seat && duty && performanceEnded(seat, duty))
    return expire(tx, row, PERFORMANCE_ENDED_MESSAGE, "performance_ended");
  const now = new Date().toISOString();
  const replacementId = data.acceptedBy!;
  const from = nameOf(state, data.fromSoldierId);
  const to = nameOf(state, replacementId);
  if (input.decision === "reject") {
    const updated = await updateRecord(tx, row, {
      ...data,
      status: "manager_rejected",
      decidedBy: actor.id,
      decidedByName: actor.name,
      decidedAt: now,
      decisionReason: input.reason,
      closedAt: now,
      closedReason: `האחראי דחה את ההעברה: ${input.reason}`,
    });
    const expiresAt = duty ? instant(duty.end).toMillis() : 0;
    await notify(tx, data.fromSoldierId, {
      event: "rejected",
      requestId: row.id,
      title: "האחראי דחה את ההעברה",
      body: `העברת התורנות ${data.dutyName} ל${to} נדחתה: ${input.reason}. השיבוץ שלך נשאר בתוקף.`,
      mailBody: `האחראי דחה את העברת התורנות ${data.dutyName}. פרטי ההחלטה באתר. השיבוץ שלך נשאר בתוקף.`,
      email: true,
      expiresAt,
    });
    await notify(tx, replacementId, {
      event: "rejected",
      requestId: row.id,
      title: "האחראי דחה את ההעברה",
      body: `העברת התורנות ${data.dutyName} אליך נדחתה: ${input.reason}.`,
      mailBody: `האחראי דחה את העברת התורנות ${data.dutyName}. פרטי ההחלטה באתר.`,
      email: true,
      expiresAt,
    });
    await notifyManagers(
      tx,
      row.id,
      "אחראי דחה העברת תורנות",
      `${actor.name} דחה את העברת התורנות ${data.dutyName} מ${from} ל${to}: ${input.reason}`
    );
    await audit(
      tx,
      actor,
      "transfer.reject",
      row.id,
      { dutyId: data.dutyId },
      replacementId
    );
    return {
      id: updated.id,
      version: updated.version,
      status: "manager_rejected",
    };
  }
  if (changed || !seat || !duty || !person)
    return expire(
      tx,
      row,
      changed ?? "ההעברה אינה תקפה עוד",
      "transfer_invalid"
    );
  // After the start the seat is split at the handover the manager sets (decision 183).
  if (instant(duty.start).toMillis() <= Date.now()) {
    const handoverAt = parseHandover(input.handoverAt, input.handoverOffset);
    invariant(
      handoverAt,
      "handover_required",
      "התורנות כבר התחילה. יש לבדוק שוב ולהזין את מועד החילוף",
      409
    );
    const plan = await startedPlan(
      tx,
      data,
      seat,
      handoverAt,
      input.allocations
    );
    invariant(
      !plan.allocationRequired || input.allocationReason,
      "allocation_reason_required",
      "נדרשת סיבה לחלוקת הניקוד בין המבצעים",
      422
    );
    invariant(
      input.previewToken === startedToken(plan, row, data, duty),
      "stale_preview",
      "נתוני ההעברה או הביצוע השתנו מאז הבדיקה. יש לבדוק שוב לפני החלטה",
      409
    );
    const execution = await commitExecution(tx, actor, plan, {
      reason: input.allocationReason ?? `העברה במהלך ביצוע מ${from} ל${to}`,
      mode: "volunteer",
      approvalKeys: input.approvalKeys,
      approvalReason: input.approvalReason,
      requestId: row.id,
    });
    const created = plan.changes.find(
      (change) => change.soldierId === replacementId
    )!;
    await closeRequestsOfTransferredSeat(tx, duty.id, data.fromSoldierId);
    const updated = await updateRecord(tx, row, {
      ...data,
      status: "completed",
      resultAssignmentId: created.rowId,
      handoverAt,
      executionId: execution.id,
      closedAt: now,
      decidedBy: actor.id,
      decidedByName: actor.name,
      decidedAt: now,
    });
    const endsAt = instant(duty.end).toMillis() + 86_400_000;
    const at = instant(handoverAt).toFormat("dd.MM.yyyy HH:mm");
    await notify(tx, data.fromSoldierId, {
      event: "completed",
      requestId: row.id,
      title: "האחראי אישר את החילוף",
      body: `${to} מחליף אותך בתורנות ${data.dutyName} החל מ־${at}. הניקוד שלך יחושב לפי הזמן שביצעת.`,
      email: true,
      expiresAt: endsAt,
    });
    await notify(tx, replacementId, {
      event: "completed",
      requestId: row.id,
      title: "קיבלת חלק מתורנות",
      body: `אתה מחליף את ${from} בתורנות ${data.dutyName} החל מ־${at}, באישור אחראי. הניקוד יחושב לפי הזמן שתבצע.`,
      email: true,
      expiresAt: endsAt,
    });
    await audit(
      tx,
      actor,
      "transfer.approve",
      row.id,
      {
        dutyId: duty.id,
        fromAssignmentId: seat.id,
        toAssignmentId: created.rowId,
        executionId: execution.id,
      },
      replacementId
    );
    return {
      id: updated.id,
      version: updated.version,
      status: "completed",
      assignmentId: created.rowId,
    };
  }
  invariant(
    input.previewToken === reviewToken(state, row, data, duty),
    "stale_preview",
    "נתוני ההעברה השתנו מאז הבדיקה. יש לבדוק שוב לפני החלטה",
    409
  );
  const eligibility = candidateEligibility(state, person, duty, data.slotId);
  invariant(
    eligibility.status !== "blocked",
    "candidate_ineligible",
    "המחליף אינו עומד כעת בתנאי התורנות. אפשר לדחות את ההעברה עם סיבה",
    422,
    eligibility
  );
  const approvals: SpecificApproval[] = [];
  if (eligibility.approvalsRequired.length)
    invariant(
      input.approvalReason,
      "approval_required",
      "נדרשת סיבה לאישור החריגים",
      422,
      eligibility
    );
  for (const reason of eligibility.approvalsRequired) {
    invariant(
      input.approvalKeys.includes(approvalKey(reason)),
      "approval_required",
      "נדרש אישור נפרד לכל חריג"
    );
    invariant(
      ["exemption", "rank"].includes(reason.code),
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
      reason: input.approvalReason!,
      approvedBy: actor.id,
      approvedAt: now,
    });
  }
  const slot = duty.slots.find((item) => item.id === data.slotId);
  invariant(slot, "not_found", "המקום לא נמצא בתורנות", 404);
  const confirmed = evaluateEligibility(person, duty, slot, {
    duties: state.duties,
    assignments: state.assignments,
    mode: "volunteer",
    approvals,
  });
  invariant(
    confirmed.status === "eligible",
    "approval_required",
    "בדיקת ההתאמה לא הושלמה",
    422,
    confirmed
  );
  return completeTransfer(tx, actor, {
    row,
    data,
    state,
    seat,
    duty,
    candidates: data.candidates,
    replacementId,
    acceptedAt: data.acceptedAt ?? now,
    // The approval reason concerns the replacement's own exemption or rank, so it stays in the
    // manager-only approvals and never reaches the offerer (decision 163).
    approvals,
  });
}

/** The seat split at the handover: the offerer keeps the part before it, the replacement the rest. */
async function startedPlan(
  tx: DbTransaction,
  data: TransferData,
  seat: Assignment,
  handoverAt: string,
  allocations?: FixedAllocation[]
) {
  const { segments } = await seatOf(tx, seat);
  return planExecution(tx, {
    dutyId: data.dutyId,
    slotId: data.slotId,
    segments: handoverSegments(
      segments,
      data.fromSoldierId,
      data.acceptedBy!,
      handoverAt
    ),
    mode: "volunteer",
    allocations,
  });
}
function startedToken(
  plan: Awaited<ReturnType<typeof planExecution>>,
  row: Workflow,
  data: TransferData,
  duty: Duty
) {
  return createHash("sha256")
    .update(`${reviewToken(plan.state, row, data, duty)}:${plan.token}`)
    .digest("hex");
}
