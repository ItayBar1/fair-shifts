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
import { closeSeatRequests, notifyManagers } from "../seat-requests";
import { closeRequestsOfTransferredSeat } from "../cancellation-requests";
import { cancelStaleDutyReminders } from "../duty-reminder-checks";
import { nameOf, notify } from "./rules";
import { type Domain, type TransferData } from "./types";

/**
 * Releases the original seat and gives its full value to the replacement in one transaction.
 * Shared by an automatic acceptance and a manager's approval (decisions 163, 178).
 */
export async function completeTransfer(
  tx: DbTransaction,
  actor: Actor,
  input: {
    row: Workflow;
    data: TransferData;
    state: Domain;
    seat: Assignment;
    duty: Duty;
    candidates: TransferData["candidates"];
    replacementId: string;
    acceptedAt: string;
    approvals: SpecificApproval[];
  }
) {
  const { row, data, state, seat, duty, replacementId: soldierId } = input;
  const decided = actor.role === "manager";
  const now = new Date().toISOString();
  const released = await tx
    .update(assignments)
    .set({
      status: "cancelled",
      version: seat.version + 1,
      data: {
        ...seat,
        status: "cancelled",
        version: seat.version + 1,
        endedBy: {
          kind: "transfer",
          requestId: row.id,
          toSoldierId: soldierId,
        },
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
  const replacementId = randomUUID();
  const replacement: Assignment & {
    transferredFrom: {
      assignmentId: string;
      soldierId: string;
      requestId: string;
    };
  } = {
    id: replacementId,
    dutyId: seat.dutyId,
    slotId: seat.slotId,
    soldierId,
    points: seat.points,
    status: "reserved",
    version: 1,
    extraPoints: seat.extraPoints,
    approvals: input.approvals,
    transferredFrom: {
      assignmentId: seat.id,
      soldierId: seat.soldierId,
      requestId: row.id,
    },
  };
  await tx.insert(assignments).values({ ...replacement, data: replacement });
  if (input.approvals.length)
    await createRecord(
      tx,
      "assignment_approval",
      { assignmentId: replacementId, approvals: input.approvals },
      soldierId
    );
  await tx
    .update(duties)
    .set({
      version: duty.version + 1,
      data: {
        ...duty,
        rulesVersion: duty.rulesVersion ?? duty.version,
        version: duty.version + 1,
      } as Duty & { name: string; location: string; instructions: string },
      updatedAt: new Date(),
    })
    .where(eq(duties.id, duty.id));
  await closeRequestsOfTransferredSeat(tx, duty.id, data.fromSoldierId);
  // Swaps and other offers that rested on the released seat can no longer complete.
  await closeSeatRequests(
    tx,
    { assignmentIds: [seat.id], exceptId: row.id },
    "השיבוץ הועבר לחייל אחר"
  );
  // The original soldier's queued reminders end here; the replacement gets their own.
  await cancelStaleDutyReminders(tx, duty.id);
  const updated = await updateRecord(tx, row, {
    ...data,
    status: "completed",
    candidates: input.candidates,
    acceptedBy: soldierId,
    acceptedAt: input.acceptedAt,
    resultAssignmentId: replacementId,
    closedAt: now,
    ...(decided && {
      decidedBy: actor.id,
      decidedByName: actor.name,
      decidedAt: now,
      approvals: input.approvals,
    }),
  });
  const from = nameOf(state, data.fromSoldierId);
  const to = nameOf(state, soldierId);
  const endsAt = instant(duty.end).toMillis();
  await notify(tx, data.fromSoldierId, {
    event: "completed",
    requestId: row.id,
    title: decided ? "האחראי אישר את ההעברה" : "ההעברה הושלמה",
    body: `התורנות ${data.dutyName} הועברה ל${to}. אינך משובץ לה עוד.`,
    email: true,
    expiresAt: endsAt,
  });
  await notify(tx, soldierId, {
    event: "completed",
    requestId: row.id,
    title: "קיבלת תורנות",
    body: `התורנות ${data.dutyName} הועברה אליך מ${from}${decided ? " באישור אחראי" : ""}, עם מלוא הניקוד (${seat.points} נקודות).`,
    email: true,
    expiresAt: endsAt,
  });
  if (!decided)
    for (const item of data.candidates.filter(
      (candidate) =>
        candidate.soldierId !== soldierId && candidate.status === "pending"
    ))
      await notify(tx, item.soldierId, {
        event: "closed",
        requestId: row.id,
        title: "הצעת ההעברה נסגרה",
        body: `חייל אחר קיבל את התורנות ${data.dutyName}.`,
        email: false,
        expiresAt: 0,
      });
  await notifyManagers(
    tx,
    row.id,
    decided ? "אחראי אישר העברת תורנות" : "הושלמה העברת תורנות",
    decided
      ? `${actor.name} אישר את העברת התורנות ${data.dutyName} מ${from} ל${to}.`
      : `התורנות ${data.dutyName} הועברה מ${from} ל${to} בהסכמה.`
  );
  await audit(
    tx,
    actor,
    decided ? "transfer.approve" : "transfer.complete",
    row.id,
    {
      dutyId: duty.id,
      fromAssignmentId: seat.id,
      toAssignmentId: replacementId,
      points: seat.points,
      ...(decided && {
        approvals: input.approvals.map((item) => item.kind),
      }),
    },
    soldierId
  );
  return {
    id: updated.id,
    version: updated.version,
    status: "completed",
    assignmentId: replacementId,
  };
}
