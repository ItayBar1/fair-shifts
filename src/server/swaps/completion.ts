import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { assignments, duties } from "../schema";
import {
  audit,
  createRecord,
  updateRecord,
  type Actor,
  type Workflow,
} from "../repository";
import { AppError } from "../errors";
import { instant } from "../../domain/time";
import type { Assignment, Duty, SpecificApproval } from "../../domain/types";
import { closeRequestsOfTransferredSeat } from "../cancellation-requests";
import { cancelStaleDutyReminders } from "../duty-reminder-checks";
import { closeSeatRequests, nameOf, notifyManagers } from "../seat-requests";
import { closedForOthers } from "./offer";
import { notify, rulesVersion } from "./rules";
import { type Domain, type SwapData, type SwapEntry } from "./types";

export async function release(
  tx: DbTransaction,
  seat: Assignment,
  requestId: string,
  toSoldierId: string
) {
  const released = await tx
    .update(assignments)
    .set({
      status: "cancelled",
      version: seat.version + 1,
      data: {
        ...seat,
        status: "cancelled",
        version: seat.version + 1,
        endedBy: { kind: "swap", requestId, toSoldierId },
      } as Assignment,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(assignments.id, seat.id),
        eq(assignments.version, seat.version),
        eq(assignments.status, "reserved")
      )
    )
    .returning();
  if (!released.length)
    throw new AppError("stale_version", "השיבוץ השתנה בזמן השמירה", 409);
}

export async function occupy(
  tx: DbTransaction,
  seat: Assignment,
  soldierId: string,
  requestId: string,
  approvals: SpecificApproval[]
) {
  const id = randomUUID();
  const row: Assignment & {
    swappedFrom: { assignmentId: string; soldierId: string; requestId: string };
  } = {
    id,
    dutyId: seat.dutyId,
    slotId: seat.slotId,
    soldierId,
    // The seat keeps its full value, including an existing call-up bonus (decision 106).
    points: seat.points,
    status: "reserved",
    version: 1,
    extraPoints: seat.extraPoints,
    approvals,
    swappedFrom: {
      assignmentId: seat.id,
      soldierId: seat.soldierId,
      requestId,
    },
  };
  await tx.insert(assignments).values({ ...row, data: row });
  if (approvals.length)
    await createRecord(
      tx,
      "assignment_approval",
      { assignmentId: id, approvals },
      soldierId
    );
  return id;
}

/** Both seats change hands in one transaction, or neither does (decision 108). */
export async function completeSwap(
  tx: DbTransaction,
  actor: Actor,
  input: {
    row: Workflow;
    data: SwapData;
    state: Domain;
    seat: Assignment;
    target: Assignment;
    entry: SwapEntry;
    candidates: SwapEntry[];
    acceptedAt: string;
    approvals: SpecificApproval[];
  }
) {
  const { row, data, state, seat, target, entry } = input;
  const from = data.fromSoldierId;
  const to = entry.soldierId;
  const decided = actor.role === "manager";
  const now = new Date().toISOString();
  await release(tx, seat, row.id, to);
  await release(tx, target, row.id, from);
  const own = (soldierId: string) =>
    input.approvals.filter((item) => item.soldierId === soldierId);
  const toSeat = await occupy(tx, seat, to, row.id, own(to));
  const fromSeat = await occupy(tx, target, from, row.id, own(from));
  for (const dutyId of new Set([seat.dutyId, target.dutyId])) {
    const duty = state.duties.find((item) => item.id === dutyId)!;
    await tx
      .update(duties)
      .set({
        version: duty.version + 1,
        data: {
          ...duty,
          rulesVersion: rulesVersion(duty),
          version: duty.version + 1,
        } as Duty & { name: string; location: string; instructions: string },
        updatedAt: new Date(),
      })
      .where(eq(duties.id, duty.id));
    // Queued reminders of the old holders end here; each soldier gets their own.
    await cancelStaleDutyReminders(tx, duty.id);
  }
  await closeRequestsOfTransferredSeat(tx, seat.dutyId, from);
  await closeRequestsOfTransferredSeat(tx, target.dutyId, to);
  await closeSeatRequests(
    tx,
    { assignmentIds: [seat.id, target.id], exceptId: row.id },
    "השיבוץ הוחלף בהסכמה עם חייל אחר"
  );
  const updated = await updateRecord(tx, row, {
    ...data,
    status: "completed",
    candidates: input.candidates,
    acceptedBy: to,
    acceptedAssignmentId: entry.assignmentId,
    acceptedAt: input.acceptedAt,
    resultAssignmentIds: [toSeat, fromSeat],
    closedAt: now,
    ...(decided && {
      decidedBy: actor.id,
      decidedByName: actor.name,
      decidedAt: now,
      approvals: input.approvals,
    }),
  });
  const fromName = nameOf(state.soldiers, from);
  const toName = nameOf(state.soldiers, to);
  const endsAt = (dutyId: string) =>
    instant(state.duties.find((item) => item.id === dutyId)!.end).toMillis();
  const by = decided ? " באישור אחראי" : "";
  await notify(tx, from, {
    event: "completed",
    requestId: row.id,
    title: decided ? "האחראי אישר את ההחלפה" : "ההחלפה הושלמה",
    body: `החלפת${by} את ${data.dutyName} עם ${toName}. עכשיו את/ה משובץ/ת לתורנות ${entry.dutyName} (${target.points} נקודות), ולא לתורנות ${data.dutyName}.`,
    email: true,
    expiresAt: endsAt(target.dutyId),
  });
  await notify(tx, to, {
    event: "completed",
    requestId: row.id,
    title: decided ? "האחראי אישר את ההחלפה" : "ההחלפה הושלמה",
    body: `החלפת${by} את ${entry.dutyName} עם ${fromName}. עכשיו את/ה משובץ/ת לתורנות ${data.dutyName} (${seat.points} נקודות), ולא לתורנות ${entry.dutyName}.`,
    email: true,
    expiresAt: endsAt(seat.dutyId),
  });
  if (!decided)
    await closedForOthers(
      tx,
      row.id,
      data,
      data.candidates.filter(
        (item) => item !== entry && item.status === "pending"
      ),
      entry
    );
  await notifyManagers(
    tx,
    row.id,
    decided ? "אחראי אישר החלפת תורנויות" : "הושלמה החלפת תורנויות",
    `${decided ? `${actor.name} אישר את ההחלפה: ` : ""}${fromName} עבר ל${entry.dutyName} ו${toName} עבר ל${data.dutyName}.`
  );
  await audit(
    tx,
    actor,
    decided ? "swap.approve" : "swap.complete",
    row.id,
    {
      dutyId: seat.dutyId,
      dutyIds: [seat.dutyId, target.dutyId],
      fromAssignmentIds: [seat.id, target.id],
      toAssignmentIds: [toSeat, fromSeat],
      points: [seat.points, target.points],
      ...(decided && {
        approvals: input.approvals.map((item) => item.kind),
      }),
    },
    from
  );
  return {
    id: updated.id,
    version: updated.version,
    status: "completed",
    assignmentIds: [toSeat, fromSeat],
  };
}
