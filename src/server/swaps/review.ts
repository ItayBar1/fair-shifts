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
import { instant } from "../../domain/time";
import type { SpecificApproval } from "../../domain/types";
import { executionView } from "../execution";
import { executionPeriod } from "../../domain/execution";
import {
  approvalKey,
  nameOf,
  notifyManagers,
  performanceEnded,
  PERFORMANCE_ENDED_MESSAGE,
} from "../seat-requests";
import { completeSwap } from "./completion";
import { expire } from "./offer";
import { hasStarted, notify, rulesVersion, sides } from "./rules";
import {
  allocationSidesInput,
  decideStartedSwap,
  handoverTimes,
  handovers,
  startedSwap,
} from "./started";
import { type Domain, type SwapData } from "./types";

/** Everything a manager's decision rests on; any change requires a fresh review. */
export function reviewToken(state: Domain, row: Workflow, data: SwapData) {
  const people = [data.fromSoldierId, data.acceptedBy];
  const seats = state.assignments.filter(
    (item) =>
      item.id === data.assignmentId ||
      item.id === data.acceptedAssignmentId ||
      people.includes(item.soldierId)
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        request: [row.id, row.version],
        soldiers: state.soldiers.filter((item) => people.includes(item.id)),
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
  const data = row.data as SwapData;
  invariant(data.type === "swap", "not_found", "הבקשה לא נמצאה", 404);
  currentVersion(row.version, expectedVersion);
  invariant(
    data.status === "awaiting_manager" &&
      data.acceptedBy &&
      data.acceptedAssignmentId,
    "swap_closed",
    "ההחלפה כבר אינה ממתינה להחלטת אחראי",
    409
  );
  const state = await loadDomain(tx);
  const entry = data.candidates.find(
    (item) => item.assignmentId === data.acceptedAssignmentId
  )!;
  const seat = state.assignments.find((item) => item.id === data.assignmentId);
  const target = state.assignments.find(
    (item) => item.id === entry.assignmentId
  );
  const duty = state.duties.find((item) => item.id === data.dutyId);
  const other = state.duties.find((item) => item.id === entry.dutyId);
  const people = [data.fromSoldierId, entry.soldierId].map((soldierId) =>
    state.soldiers.find((item) => item.id === soldierId)
  );
  const changed =
    !seat ||
    seat.status !== "reserved" ||
    seat.soldierId !== data.fromSoldierId ||
    !target ||
    target.status !== "reserved" ||
    target.soldierId !== entry.soldierId
      ? "אחד השיבוצים השתנה או הוסר אחרי ההסכמה"
      : !duty ||
          !other ||
          duty.status !== "published" ||
          other.status !== "published" ||
          rulesVersion(duty) !== data.dutyRulesVersion ||
          rulesVersion(other) !== entry.dutyRulesVersion
        ? "אחת התורנויות עודכנה או בוטלה אחרי ההסכמה"
        : people.some((person) => !person || person.deletedAt)
          ? "אחד החיילים אינו זמין עוד"
          : undefined;
  return { row, data, state, entry, seat, target, duty, other, changed };
}

/** Current review for a manager (ended offers expire): both sides' eligibility after the swap and the exceptions to approve. */
export async function reviewSwap(
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
      ...handovers,
      allocationSides: allocationSidesInput.optional(),
    })
    .parse(payload);
  const { row, data, state, entry, seat, target, duty, other, changed } =
    await awaitingManager(tx, actor, input.id, expectedVersion);
  if (
    (seat && duty && performanceEnded(seat, duty)) ||
    (target && other && performanceEnded(target, other))
  )
    return expire(tx, row, PERFORMANCE_ENDED_MESSAGE, "performance_ended");
  if (changed || !seat || !target || !duty || !other)
    return { valid: false, message: changed ?? "ההחלפה אינה תקפה עוד" };
  if (hasStarted(duty) || hasStarted(other)) {
    const periods = {
      seat: hasStarted(duty) ? executionPeriod(seat, duty) : undefined,
      target: hasStarted(other) ? executionPeriod(target, other) : undefined,
    };
    const at = handoverTimes(input);
    if (seat.dutyId === target.dutyId)
      return {
        valid: false,
        message:
          "אחרי תחילת התורנות אי אפשר להחליף בין שני מקומות באותה תורנות. אפשר לדחות את ההחלפה",
      };
    if ((periods.seat && !at.seat) || (periods.target && !at.target))
      return { valid: true, started: true, handoverRequired: true, periods };
    const planned = await startedSwap(tx, {
      row,
      data,
      state,
      entry,
      seat,
      target,
      duty,
      other,
      at,
      allocationSides: input.allocationSides,
    });
    return {
      valid: true,
      started: true,
      periods,
      handovers: at,
      status: planned.moves.some((move) => move.blockers.length)
        ? "blocked"
        : planned.moves.some((move) => move.requirements.length)
          ? "approval_required"
          : "eligible",
      sides: planned.moves.map((move) => ({
        soldierId: move.incoming,
        dutyName: move.dutyName,
        status: move.blockers.length
          ? "blocked"
          : move.requirements.length
            ? "approval_required"
            : "eligible",
        blockers: move.blockers,
        requirements: move.requirements,
        execution: move.plan && executionView(move.plan),
      })),
      previewToken: planned.token,
    };
  }
  const checked = sides(state, data, entry, seat, target);
  return {
    valid: true,
    started: hasStarted(duty) || hasStarted(other),
    status: checked.some((side) => side.eligibility.status === "blocked")
      ? "blocked"
      : checked.some((side) => side.eligibility.status === "approval_required")
        ? "approval_required"
        : "eligible",
    sides: checked.map((side) => ({
      soldierId: side.soldierId,
      dutyName: side.dutyName,
      status: side.eligibility.status,
      blockers: side.eligibility.blockers,
      requirements: side.eligibility.approvalsRequired.map((reason) => ({
        ...reason,
        key: `${side.soldierId}|${approvalKey(reason)}`,
      })),
    })),
    previewToken: reviewToken(state, row, data),
  };
}

/** A manager approves a swap that needs exceptions, or rejects it with a reason visible to both sides (decisions 178, 181). */
export async function decideSwap(
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
        ...handovers,
        allocationSides: allocationSidesInput.optional(),
        allocationReason: z.string().trim().min(1).max(2000).optional(),
      }),
    ])
    .parse(payload);
  const { row, data, state, entry, seat, target, duty, other, changed } =
    await awaitingManager(tx, actor, input.id, expectedVersion);
  if (
    (seat && duty && performanceEnded(seat, duty)) ||
    (target && other && performanceEnded(target, other))
  )
    return expire(tx, row, PERFORMANCE_ENDED_MESSAGE, "performance_ended");
  const now = new Date().toISOString();
  const fromName = nameOf(state.soldiers, data.fromSoldierId);
  const toName = nameOf(state.soldiers, entry.soldierId);
  if (input.decision === "reject") {
    const updated = await updateRecord(tx, row, {
      ...data,
      status: "manager_rejected",
      decidedBy: actor.id,
      decidedByName: actor.name,
      decidedAt: now,
      decisionReason: input.reason,
      closedAt: now,
      closedReason: `האחראי דחה את ההחלפה: ${input.reason}`,
    });
    const expiresAt = Math.max(
      duty ? instant(duty.end).toMillis() : 0,
      other ? instant(other.end).toMillis() : 0
    );
    for (const soldierId of [data.fromSoldierId, entry.soldierId])
      await notify(tx, soldierId, {
        event: "rejected",
        requestId: row.id,
        title: "האחראי דחה את ההחלפה",
        body: `החלפת התורנויות ${data.dutyName} ו${entry.dutyName} נדחתה: ${input.reason}. השיבוץ שלך נשאר בתוקף.`,
        mailBody: `האחראי דחה את החלפת התורנויות ${data.dutyName} ו${entry.dutyName}. פרטי ההחלטה באתר. השיבוץ שלך נשאר בתוקף.`,
        email: true,
        expiresAt,
      });
    await notifyManagers(
      tx,
      row.id,
      "אחראי דחה החלפת תורנויות",
      `${actor.name} דחה את ההחלפה בין ${fromName} (${data.dutyName}) ל${toName} (${entry.dutyName}): ${input.reason}`
    );
    await audit(
      tx,
      actor,
      "swap.reject",
      row.id,
      { dutyId: data.dutyId },
      entry.soldierId
    );
    return {
      id: updated.id,
      version: updated.version,
      status: "manager_rejected",
    };
  }
  if (changed || !seat || !target || !duty || !other)
    return expire(tx, row, changed ?? "ההחלפה אינה תקפה עוד", "swap_invalid");
  // After either start a started seat is split at the handover the manager sets (decision 183).
  if (hasStarted(duty) || hasStarted(other))
    return decideStartedSwap(tx, actor, {
      input,
      row,
      data,
      state,
      entry,
      seat,
      target,
      duty,
      other,
    });
  invariant(
    input.previewToken === reviewToken(state, row, data),
    "stale_preview",
    "נתוני ההחלפה השתנו מאז הבדיקה. יש לבדוק שוב לפני החלטה",
    409
  );
  const checked = sides(state, data, entry, seat, target);
  invariant(
    checked.every((side) => side.eligibility.status !== "blocked"),
    "candidate_ineligible",
    "אחד הצדדים אינו עומד כעת בתנאי התורנות. אפשר לדחות את ההחלפה עם סיבה",
    422
  );
  const approvals: SpecificApproval[] = [];
  const required = checked.flatMap((side) =>
    side.eligibility.approvalsRequired.map((reason) => ({ side, reason }))
  );
  if (required.length)
    invariant(
      input.approvalReason,
      "approval_required",
      "נדרשת סיבה לאישור החריגים",
      422
    );
  for (const { side, reason } of required) {
    invariant(
      input.approvalKeys.includes(`${side.soldierId}|${approvalKey(reason)}`),
      "approval_required",
      "נדרש אישור נפרד לכל חריג"
    );
    invariant(
      ["exemption", "rank"].includes(reason.code),
      "unknown_exception",
      "אין סמכות לחריגה מהתנאי הזה"
    );
    const person = state.soldiers.find((item) => item.id === side.soldierId)!;
    const into = side.soldierId === entry.soldierId ? duty : other;
    approvals.push({
      kind: reason.code as SpecificApproval["kind"],
      soldierId: person.id,
      soldierVersion: person.version,
      dutyId: into.id,
      dutyVersion: rulesVersion(into),
      referenceId: reason.referenceId,
      referenceVersion: reason.referenceVersion,
      reason: input.approvalReason!,
      approvedBy: actor.id,
      approvedAt: now,
    });
  }
  invariant(
    sides(state, data, entry, seat, target, approvals).every(
      (side) => side.eligibility.status === "eligible"
    ),
    "approval_required",
    "בדיקת ההתאמה לא הושלמה",
    422
  );
  return completeSwap(tx, actor, {
    row,
    data,
    state,
    seat,
    target,
    entry,
    candidates: data.candidates,
    acceptedAt: data.acceptedAt ?? now,
    // Approval reasons concern a soldier's own exemption or rank: managers only (decision 178).
    approvals,
  });
}
