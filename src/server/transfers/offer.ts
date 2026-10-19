import { z } from "zod";
import type { DbTransaction } from "../db";
import {
  audit,
  createRecord,
  currentVersion,
  findRecord,
  loadDomain,
  updateRecord,
  type Actor,
  type Workflow,
} from "../repository";
import { invariant } from "../errors";
import { id } from "../validation";
import { instant } from "../../domain/time";
import type { EligibilityReason } from "../../domain/types";
import {
  accountOf,
  closeSeatRequests,
  notifyManagers,
  reserveOfferRecipients,
  OPEN_CONSENT as OPEN,
  openSeatRequests,
  seatCommitted,
  expireSeatRequest,
  performanceEnded,
  PERFORMANCE_ENDED_MESSAGE,
  remainingPeriod,
} from "../seat-requests";
import { completeTransfer } from "./completion";
import { candidateEligibility, nameOf, notify } from "./rules";
import { type TransferData } from "./types";

export async function offerTransfer(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const input = z
    .object({
      assignmentId: id,
      candidateIds: z.array(id).min(1).max(20),
    })
    .parse(payload);
  // By the role at the moment of the action (decision 192).
  invariant(
    actor.role !== "manager",
    "forbidden",
    "אחראי תורנויות אינו משובץ לתורנויות ולכן אינו מציע העברה",
    403
  );
  invariant(
    actor.soldierId,
    "forbidden",
    "רק חייל המשובץ לתורנות יכול להציע אותה להעברה",
    403
  );
  const state = await loadDomain(tx);
  const seat = state.assignments.find((row) => row.id === input.assignmentId);
  invariant(seat, "not_found", "השיבוץ לא נמצא", 404);
  invariant(
    seat.soldierId === actor.soldierId,
    "forbidden",
    "רק בעל השיבוץ יכול להציע אותו להעברה",
    403
  );
  currentVersion(seat.version, expectedVersion);
  const duty = state.duties.find((row) => row.id === seat.dutyId);
  invariant(duty, "not_found", "התורנות לא נמצאה", 404);
  invariant(
    seat.status === "reserved" && duty.status === "published",
    "not_transferable",
    "ניתן להציע להעברה רק שיבוץ בתורנות שפורסמה"
  );
  // After the start an offer is still possible, but it always goes to a manager (decision 183).
  const remaining = remainingPeriod(seat, duty);
  invariant(
    !seatCommitted(await openSeatRequests(tx), seat.id),
    "transfer_open",
    "כבר קיימת הצעת העברה או החלפה פתוחה לשיבוץ הזה",
    409
  );
  const candidateIds = [...new Set(input.candidateIds)];
  invariant(
    !candidateIds.includes(actor.soldierId),
    "invalid_candidate",
    "אי אפשר להציע את התורנות לעצמך"
  );
  for (const candidateId of candidateIds) {
    const person = state.soldiers.find((row) => row.id === candidateId);
    invariant(
      person && !person.deletedAt && (await accountOf(tx, candidateId)),
      "invalid_candidate",
      "אחד החיילים שנבחרו אינו זמין לקבלת הצעות"
    );
    // The offerer learns only that the candidate is unsuitable, never why (decision 163).
    invariant(
      candidateEligibility(state, person, duty, seat.slotId, remaining)
        .status !== "blocked",
      "candidate_ineligible",
      `${person.name} אינו מתאים לתורנות זו. אפשר לבחור חייל אחר`
    );
  }
  const now = new Date().toISOString();
  const { mailRecipients, mailLimited } = await reserveOfferRecipients(
    tx,
    actor.id,
    candidateIds
  );
  const data: TransferData = {
    type: "transfer",
    status: "awaiting_consent",
    mailLimited,
    assignmentId: seat.id,
    dutyId: duty.id,
    slotId: seat.slotId,
    dutyName: duty.name,
    role: duty.slots.find((slot) => slot.id === seat.slotId)?.role ?? "",
    dutyRulesVersion: duty.rulesVersion ?? duty.version,
    fromSoldierId: actor.soldierId,
    points: seat.points,
    extraPoints: seat.extraPoints,
    candidates: candidateIds.map((soldierId) => ({
      soldierId,
      status: "pending",
    })),
    createdAt: now,
  };
  const row = await createRecord(tx, "request", data, actor.soldierId);
  const offerer = nameOf(state, actor.soldierId);
  for (const candidateId of candidateIds)
    await notify(tx, candidateId, {
      event: "offer",
      requestId: row.id,
      title: "הוצעה לך תורנות",
      body: remaining
        ? `${offerer} מבקש שתחליף אותו בתורנות ${duty.name}, שכבר התחילה. אם תסכים, אחראי יקבע את מועד החילוף.`
        : `${offerer} מציע לך לקבל את התורנות ${duty.name}. אפשר להסכים או לדחות במסך ההחלפות.`,
      email: mailRecipients.has(candidateId),
      expiresAt: remaining
        ? instant(remaining.end).toMillis()
        : instant(duty.start).toMillis(),
    });
  await audit(
    tx,
    actor,
    "transfer.offer",
    row.id,
    { assignmentId: seat.id, dutyId: duty.id, candidateIds },
    actor.soldierId
  );
  return { id: row.id, version: row.version };
}

export const expire = (
  tx: DbTransaction,
  row: Workflow,
  reason: string,
  code: string
) => expireSeatRequest(tx, row, "transfer", reason, code);

export async function respondTransfer(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const input = z
    .discriminatedUnion("decision", [
      z.object({ id, decision: z.literal("decline") }),
      z.object({
        id,
        decision: z.literal("accept"),
        confirmed: z.literal(true),
      }),
    ])
    .parse(payload);
  const row = await findRecord(tx, "request", input.id);
  const data = row.data as TransferData;
  invariant(data.type === "transfer", "not_found", "הבקשה לא נמצאה", 404);
  const mine = data.candidates.find(
    (item) => item.soldierId === actor.soldierId
  );
  invariant(actor.soldierId && mine, "forbidden", "ההצעה אינה מיועדת לך", 403);
  currentVersion(row.version, expectedVersion);
  invariant(
    data.status === "awaiting_consent" && mine.status === "pending",
    "transfer_closed",
    "ההצעה כבר נסגרה או שכבר הגבת עליה",
    409
  );
  const now = new Date().toISOString();
  const state = await loadDomain(tx);
  const me = nameOf(state, actor.soldierId);
  if (input.decision === "decline") {
    const candidates = data.candidates.map((item) =>
      item === mine
        ? { ...item, status: "declined" as const, decidedAt: now }
        : item
    );
    const allDeclined = candidates.every((item) => item.status === "declined");
    const updated = await updateRecord(tx, row, {
      ...data,
      candidates,
      ...(allDeclined && { status: "declined", closedAt: now }),
    });
    await notify(tx, data.fromSoldierId, {
      event: `decline:${actor.soldierId}`,
      requestId: row.id,
      title: "הצעת ההעברה נדחתה",
      body: allDeclined
        ? `כל החיילים דחו את הצעת ההעברה לתורנות ${data.dutyName}. השיבוץ שלך נשאר בתוקף.`
        : `${me} דחה את הצעת ההעברה לתורנות ${data.dutyName}.`,
      email: allDeclined,
      expiresAt: Date.now() + 86_400_000,
    });
    await audit(
      tx,
      actor,
      "transfer.decline",
      row.id,
      { dutyId: data.dutyId },
      actor.soldierId
    );
    return {
      id: updated.id,
      version: updated.version,
      status: updated.data.status,
    };
  }

  const seat = state.assignments.find((item) => item.id === data.assignmentId);
  const duty = state.duties.find((item) => item.id === data.dutyId);
  if (
    !seat ||
    seat.status !== "reserved" ||
    seat.soldierId !== data.fromSoldierId
  )
    return expire(
      tx,
      row,
      "השיבוץ המקורי השתנה או הוסר אחרי ההצעה",
      "assignment_changed"
    );
  if (
    !duty ||
    duty.status !== "published" ||
    (duty.rulesVersion ?? duty.version) !== data.dutyRulesVersion
  )
    return expire(
      tx,
      row,
      "התורנות עודכנה או בוטלה אחרי ההצעה",
      "duty_changed"
    );
  const checkedAt = Date.now();
  if (performanceEnded(seat, duty, checkedAt))
    return expire(tx, row, PERFORMANCE_ENDED_MESSAGE, "performance_ended");
  const person = state.soldiers.find((item) => item.id === actor.soldierId);
  invariant(person, "not_found", "החייל לא נמצא", 404);
  // Recheck at the moment of acceptance: the offer never reserved anything for the candidate.
  const eligibility = candidateEligibility(
    state,
    person,
    duty,
    data.slotId,
    remainingPeriod(seat, duty, checkedAt)
  );
  invariant(
    eligibility.status !== "blocked",
    "candidate_ineligible",
    "אינך עומד כעת בתנאי התורנות, ולכן לא ניתן לקבל אותה",
    422,
    eligibility
  );
  const started = instant(duty.start).toMillis() <= Date.now();
  const candidates = data.candidates.map((item) =>
    item === mine
      ? { ...item, status: "accepted" as const, decidedAt: now }
      : item.status === "pending"
        ? { ...item, status: "closed" as const }
        : item
  );
  const others = data.candidates.filter(
    (item) => item !== mine && item.status === "pending"
  );
  if (started || eligibility.status === "approval_required") {
    const managerReasons: EligibilityReason[] = [
      ...(started
        ? [
            {
              code: "started",
              message:
                "ההסכמה התקבלה אחרי תחילת התורנות. נדרש טיפול אחראי בתקופות הביצוע",
            },
          ]
        : []),
      ...eligibility.approvalsRequired,
    ];
    const updated = await updateRecord(tx, row, {
      ...data,
      status: "awaiting_manager",
      candidates,
      acceptedBy: actor.soldierId,
      acceptedAt: now,
      managerReasons,
    });
    const body = `${me} הסכים לקבל את התורנות ${data.dutyName}. ההעברה ממתינה לטיפול אחראי, ועד אז השיבוץ המקורי בתוקף.`;
    await notify(tx, data.fromSoldierId, {
      event: "awaiting-manager",
      requestId: row.id,
      title: "ההעברה ממתינה לאחראי",
      body,
      email: true,
      expiresAt: instant(duty.end).toMillis(),
    });
    await notify(tx, actor.soldierId, {
      event: "awaiting-manager",
      requestId: row.id,
      title: "ההסכמה שלך ממתינה לאחראי",
      body: `הסכמת לקבל את התורנות ${data.dutyName}. ההעברה תושלם רק אחרי טיפול אחראי.`,
      email: false,
      expiresAt: 0,
    });
    for (const item of others)
      await notify(tx, item.soldierId, {
        event: "closed",
        requestId: row.id,
        title: "הצעת ההעברה נסגרה",
        body: `חייל אחר הסכים לקבל את התורנות ${data.dutyName}.`,
        email: false,
        expiresAt: 0,
      });
    await notifyManagers(
      tx,
      row.id,
      "העברה ממתינה לטיפול",
      `העברת התורנות ${data.dutyName} מ${nameOf(state, data.fromSoldierId)} ל${me} ממתינה להחלטת אחראי.`
    );
    await audit(
      tx,
      actor,
      "transfer.accept.pending",
      row.id,
      { dutyId: duty.id, reasons: managerReasons.map((item) => item.code) },
      actor.soldierId
    );
    return {
      id: updated.id,
      version: updated.version,
      status: "awaiting_manager",
    };
  }

  return completeTransfer(tx, actor, {
    row,
    data,
    state,
    seat,
    duty,
    candidates,
    replacementId: actor.soldierId,
    acceptedAt: now,
    approvals: [],
  });
}

export async function withdrawTransfer(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const input = z.object({ id }).parse(payload);
  const row = await findRecord(tx, "request", input.id);
  const data = row.data as TransferData;
  const offerer = data.fromSoldierId === actor.soldierId;
  // Either side may back out until a manager decides (decision 178); only the offerer before consent.
  const replacement =
    data.status === "awaiting_manager" && data.acceptedBy === actor.soldierId;
  invariant(
    data.type === "transfer" && actor.soldierId && (offerer || replacement),
    "forbidden",
    "רק מי שהציע את ההעברה או מי שהסכים לקבל אותה יכול לבטל אותה",
    403
  );
  currentVersion(row.version, expectedVersion);
  invariant(
    OPEN.includes(data.status),
    "transfer_closed",
    "אפשר לבטל רק העברה שעדיין ממתינה להסכמה או להחלטת אחראי",
    409
  );
  const now = new Date().toISOString();
  const waiting = data.status === "awaiting_manager";
  const closedReason = !waiting
    ? "המציע ביטל את ההצעה"
    : offerer
      ? "המציע ביטל את ההעברה לפני החלטת האחראי"
      : "המחליף חזר בו מהסכמתו לפני החלטת האחראי";
  const updated = await updateRecord(tx, row, {
    ...data,
    status: "cancelled",
    candidates: data.candidates.map((item) =>
      item.status === "pending"
        ? { ...item, status: "closed" }
        : replacement && item.soldierId === actor.soldierId
          ? { ...item, status: "declined", decidedAt: now }
          : item
    ),
    closedAt: now,
    closedReason,
  });
  const state = await loadDomain(tx);
  if (waiting) {
    const other = offerer ? data.acceptedBy : data.fromSoldierId;
    if (other)
      await notify(tx, other, {
        event: "withdrawn",
        requestId: row.id,
        title: "ההעברה בוטלה",
        body: `${closedReason}. ${
          offerer
            ? `לא תקבל את התורנות ${data.dutyName}.`
            : `השיבוץ שלך לתורנות ${data.dutyName} נשאר בתוקף.`
        }`,
        email: true,
        expiresAt: Date.now() + 86_400_000,
      });
    await notifyManagers(
      tx,
      row.id,
      "העברה בוטלה לפני החלטה",
      `העברת התורנות ${data.dutyName} מ${nameOf(state, data.fromSoldierId)} ל${nameOf(state, data.acceptedBy ?? "")} בוטלה: ${closedReason}.`
    );
  } else
    for (const item of data.candidates.filter((c) => c.status === "pending"))
      await notify(tx, item.soldierId, {
        event: "withdrawn",
        requestId: row.id,
        title: "הצעת ההעברה בוטלה",
        body: `ההצעה לקבל את התורנות ${data.dutyName} בוטלה בידי המציע.`,
        email: false,
        expiresAt: 0,
      });
  await audit(
    tx,
    actor,
    replacement ? "transfer.retract" : "transfer.withdraw",
    row.id,
    { dutyId: data.dutyId, status: data.status },
    actor.soldierId
  );
  return { id: updated.id, version: updated.version };
}

/** Closes open transfer and swap offers when their duty is cancelled or republished with new details. */
export async function closeTransfersForDuty(
  tx: DbTransaction,
  dutyId: string,
  reason: string
) {
  await closeSeatRequests(tx, { dutyId }, reason);
}
