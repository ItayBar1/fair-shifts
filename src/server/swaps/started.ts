import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "../db";
import { duties } from "../schema";
import { audit, updateRecord, type Actor, type Workflow } from "../repository";
import { invariant } from "../errors";
import { id } from "../validation";
import { evaluateEligibility } from "../../domain/eligibility";
import { instant } from "../../domain/time";
import type {
  Assignment,
  Duty,
  EligibilityReason,
  SpecificApproval,
} from "../../domain/types";
import { closeRequestsOfTransferredSeat } from "../cancellation-requests";
import { cancelStaleDutyReminders } from "../duty-reminder-checks";
import {
  commitExecution,
  handoverSegments,
  parseHandover,
  planExecution,
  seatOf,
  fixedAllocationInput,
  type FixedAllocation,
  type ExecutionPlan,
} from "../execution";
import { executionPeriod } from "../../domain/execution";
import {
  approvalKey,
  closeSeatRequests,
  nameOf,
  notifyManagers,
} from "../seat-requests";
import { occupy, release } from "./completion";
import { reviewToken } from "./review";
import { hasStarted, notify, rulesVersion } from "./rules";
import { type Domain, type SwapData, type SwapEntry } from "./types";

export const handovers = {
  handoverAt: z.string().max(40).optional(),
  handoverOffset: z.number().optional(),
  targetHandoverAt: z.string().max(40).optional(),
  targetHandoverOffset: z.number().optional(),
};
export const allocationSidesInput = z
  .array(
    z.object({
      slotId: id,
      allocations: z.array(fixedAllocationInput),
    })
  )
  .max(2);
type AllocationSide = { slotId: string; allocations: FixedAllocation[] };
export function handoverTimes(input: {
  handoverAt?: string;
  handoverOffset?: number;
  targetHandoverAt?: string;
  targetHandoverOffset?: number;
}) {
  return {
    seat: parseHandover(input.handoverAt, input.handoverOffset),
    target: parseHandover(input.targetHandoverAt, input.targetHandoverOffset),
  };
}

/**
 * A swap after the start (decision 183): a side that started is split at the handover the
 * manager sets, and a side that did not start moves whole. Each incoming soldier is checked
 * against their own period, with the other side already as it will be after the swap.
 */
export async function startedSwap(
  tx: DbTransaction,
  input: {
    row: Workflow;
    data: SwapData;
    state: Domain;
    entry: SwapEntry;
    seat: Assignment;
    target: Assignment;
    duty: Duty;
    other: Duty;
    at: { seat?: string; target?: string };
    allocationSides?: AllocationSide[];
  }
) {
  const { data, state, entry } = input;
  const sides = [
    {
      row: input.seat,
      duty: input.duty,
      leaving: data.fromSoldierId,
      incoming: entry.soldierId,
      at: input.at.seat,
      dutyName: data.dutyName,
    },
    {
      row: input.target,
      duty: input.other,
      leaving: entry.soldierId,
      incoming: data.fromSoldierId,
      at: input.at.target,
      dutyName: entry.dutyName,
    },
  ];
  // The seat as it will stand after this side of the swap, for the other side's checks.
  const after = (side: (typeof sides)[number]): Assignment[] => {
    const period = executionPeriod(side.row, side.duty);
    const incoming = {
      id: `swap:${side.row.id}`,
      dutyId: side.row.dutyId,
      slotId: side.row.slotId,
      soldierId: side.incoming,
      points: 0,
      status: "reserved" as const,
      version: 0,
      ...(side.at && { performedStart: side.at, performedEnd: period.end }),
    };
    return side.at
      ? [
          {
            ...side.row,
            performedStart: period.start,
            performedEnd: side.at,
            performance: undefined,
          },
          incoming,
        ]
      : [{ ...side.row, status: "cancelled" as const }, incoming];
  };
  const moves: {
    incoming: string;
    dutyName: string;
    plan?: ExecutionPlan;
    blockers: EligibilityReason[];
    requirements: (EligibilityReason & { key: string })[];
  }[] = [];
  for (const [index, side] of sides.entries()) {
    const counterpart = after(sides[1 - index]!);
    if (side.at) {
      const { segments } = await seatOf(tx, side.row);
      const plan = await planExecution(tx, {
        dutyId: side.duty.id,
        slotId: side.row.slotId,
        segments: handoverSegments(
          segments,
          side.leaving,
          side.incoming,
          side.at
        ),
        mode: "volunteer",
        overrides: counterpart,
        allocations: input.allocationSides?.find(
          (item) => item.slotId === side.row.slotId
        )?.allocations,
      });
      const change = plan.changes.find(
        (item) => item.soldierId === side.incoming
      );
      moves.push({
        incoming: side.incoming,
        dutyName: side.dutyName,
        plan,
        blockers: change?.eligibility?.blockers ?? [],
        requirements: change?.eligibility?.requirements ?? [],
      });
      continue;
    }
    const replaced = new Set(counterpart.map((row) => row.id));
    const person = state.soldiers.find((row) => row.id === side.incoming)!;
    const slot = side.duty.slots.find((row) => row.id === side.row.slotId)!;
    const result = evaluateEligibility(person, side.duty, slot, {
      duties: state.duties,
      assignments: state.assignments
        .filter((row) => !replaced.has(row.id))
        .concat(counterpart),
      mode: "volunteer",
    });
    moves.push({
      incoming: side.incoming,
      dutyName: side.dutyName,
      blockers: result.blockers,
      requirements: result.approvalsRequired.map((reason) => ({
        ...reason,
        key: `${side.incoming}|${approvalKey(reason)}`,
      })),
    });
  }
  const token = createHash("sha256")
    .update(
      JSON.stringify({
        review: reviewToken(state, input.row, data),
        at: input.at,
        plans: moves.map((move) => move.plan?.token ?? null),
        requirements: moves.map((move) => move.requirements.map((r) => r.key)),
      })
    )
    .digest("hex");
  return { sides, moves, token };
}

export async function decideStartedSwap(
  tx: DbTransaction,
  actor: Actor,
  context: {
    input: {
      previewToken: string;
      approvalReason?: string;
      approvalKeys: string[];
      handoverAt?: string;
      handoverOffset?: number;
      targetHandoverAt?: string;
      targetHandoverOffset?: number;
      allocationSides?: AllocationSide[];
      allocationReason?: string;
    };
    row: Workflow;
    data: SwapData;
    state: Domain;
    entry: SwapEntry;
    seat: Assignment;
    target: Assignment;
    duty: Duty;
    other: Duty;
  }
) {
  const { input, row, data, state, entry, seat, target, duty, other } = context;
  invariant(
    seat.dutyId !== target.dutyId,
    "same_duty_started",
    "אחרי תחילת התורנות אי אפשר להחליף בין שני מקומות באותה תורנות. אפשר לדחות את ההחלפה",
    409
  );
  const at = handoverTimes(input);
  invariant(
    (!hasStarted(duty) || at.seat) && (!hasStarted(other) || at.target),
    "handover_required",
    "אחת התורנויות כבר התחילה. יש לבדוק שוב ולהזין את מועד החילוף",
    409
  );
  const planned = await startedSwap(tx, {
    ...context,
    at,
    allocationSides: input.allocationSides,
  });
  invariant(
    planned.moves.every((move) => !move.plan?.allocationRequired) ||
      input.allocationReason,
    "allocation_reason_required",
    "נדרשת סיבה לחלוקת הניקוד בין המבצעים",
    422
  );
  invariant(
    input.previewToken === planned.token,
    "stale_preview",
    "נתוני ההחלפה או הביצוע השתנו מאז הבדיקה. יש לבדוק שוב לפני החלטה",
    409
  );
  invariant(
    planned.moves.every((move) => !move.blockers.length),
    "candidate_ineligible",
    "אחד הצדדים אינו עומד כעת בתנאי התורנות. אפשר לדחות את ההחלפה עם סיבה",
    422
  );
  const required = planned.moves.flatMap((move) => move.requirements);
  if (required.length)
    invariant(
      input.approvalReason,
      "approval_required",
      "נדרשת סיבה לאישור החריגים",
      422
    );
  for (const reason of required) {
    invariant(
      input.approvalKeys.includes(reason.key),
      "approval_required",
      "נדרש אישור נפרד לכל חריג"
    );
    invariant(
      ["exemption", "rank"].includes(reason.code),
      "unknown_exception",
      "אין סמכות לחריגה מהתנאי הזה"
    );
  }
  const now = new Date().toISOString();
  const fromName = nameOf(state.soldiers, data.fromSoldierId);
  const toName = nameOf(state.soldiers, entry.soldierId);
  const results: string[] = [];
  const executionIds: string[] = [];
  for (const [index, side] of planned.sides.entries()) {
    const move = planned.moves[index]!;
    if (side.at) {
      // A second split is planned again on the state the first one left behind.
      const plan =
        index === 0 || !planned.sides[0]!.at
          ? move.plan!
          : await planExecution(tx, {
              dutyId: side.duty.id,
              slotId: side.row.slotId,
              segments: handoverSegments(
                (await seatOf(tx, side.row)).segments,
                side.leaving,
                side.incoming,
                side.at
              ),
              mode: "volunteer",
              allocations: input.allocationSides?.find(
                (item) => item.slotId === side.row.slotId
              )?.allocations,
            });
      const execution = await commitExecution(tx, actor, plan, {
        reason:
          input.allocationReason ??
          `החלפה במהלך ביצוע בין ${fromName} ל${toName}`,
        mode: "volunteer",
        approvalKeys: input.approvalKeys,
        approvalReason: input.approvalReason,
        requestId: row.id,
      });
      executionIds.push(execution.id);
      results.push(
        plan.changes.find((change) => change.soldierId === side.incoming)!.rowId
      );
      continue;
    }
    const person = state.soldiers.find((item) => item.id === side.incoming)!;
    const approvals: SpecificApproval[] = move.requirements.map((reason) => ({
      kind: reason.code as SpecificApproval["kind"],
      soldierId: person.id,
      soldierVersion: person.version,
      dutyId: side.duty.id,
      dutyVersion: rulesVersion(side.duty),
      referenceId: reason.referenceId,
      referenceVersion: reason.referenceVersion,
      reason: input.approvalReason!,
      approvedBy: actor.id,
      approvedAt: now,
    }));
    await release(tx, side.row, row.id, side.incoming);
    results.push(await occupy(tx, side.row, side.incoming, row.id, approvals));
    await tx
      .update(duties)
      .set({
        version: side.duty.version + 1,
        data: {
          ...side.duty,
          rulesVersion: rulesVersion(side.duty),
          version: side.duty.version + 1,
        } as Duty & { name: string; location: string; instructions: string },
        updatedAt: new Date(),
      })
      .where(eq(duties.id, side.duty.id));
    await cancelStaleDutyReminders(tx, side.duty.id);
    await closeSeatRequests(
      tx,
      { assignmentIds: [side.row.id], exceptId: row.id },
      "השיבוץ הוחלף בהסכמה עם חייל אחר"
    );
  }
  await closeRequestsOfTransferredSeat(tx, seat.dutyId, data.fromSoldierId);
  await closeRequestsOfTransferredSeat(tx, target.dutyId, entry.soldierId);
  const updated = await updateRecord(tx, row, {
    ...data,
    status: "completed",
    resultAssignmentIds: results,
    handovers: at,
    executionIds,
    closedAt: now,
    decidedBy: actor.id,
    decidedByName: actor.name,
    decidedAt: now,
  });
  const endsAt =
    Math.max(instant(duty.end).toMillis(), instant(other.end).toMillis()) +
    86_400_000;
  const when = (value?: string) =>
    value ? ` החל מ־${instant(value).toFormat("dd.MM.yyyy HH:mm")}` : "";
  await notify(tx, data.fromSoldierId, {
    event: "completed",
    requestId: row.id,
    title: "האחראי אישר את ההחלפה",
    body: `${toName} מחליף אותך בתורנות ${data.dutyName}${when(at.seat)}, ואת/ה מחליף/ה אותו בתורנות ${entry.dutyName}${when(at.target)}. הניקוד בתורנות שהתחילה יחושב לפי הזמן שכל אחד ביצע.`,
    email: true,
    expiresAt: endsAt,
  });
  await notify(tx, entry.soldierId, {
    event: "completed",
    requestId: row.id,
    title: "האחראי אישר את ההחלפה",
    body: `${fromName} מחליף אותך בתורנות ${entry.dutyName}${when(at.target)}, ואת/ה מחליף/ה אותו בתורנות ${data.dutyName}${when(at.seat)}. הניקוד בתורנות שהתחילה יחושב לפי הזמן שכל אחד ביצע.`,
    email: true,
    expiresAt: endsAt,
  });
  await notifyManagers(
    tx,
    row.id,
    "אחראי אישר החלפת תורנויות",
    `${actor.name} אישר את ההחלפה במהלך ביצוע בין ${fromName} (${data.dutyName}) ל${toName} (${entry.dutyName}).`
  );
  await audit(
    tx,
    actor,
    "swap.approve",
    row.id,
    {
      dutyId: seat.dutyId,
      dutyIds: [seat.dutyId, target.dutyId],
      fromAssignmentIds: [seat.id, target.id],
      toAssignmentIds: results,
      executionIds,
    },
    data.fromSoldierId
  );
  return {
    id: updated.id,
    version: updated.version,
    status: "completed",
    assignmentIds: results,
  };
}
