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
import { executionPeriod } from "../../domain/execution";
import {
  accountOf,
  nameOf,
  notifyManagers,
  reserveOfferRecipients,
  OPEN_CONSENT,
  openSeatRequests,
  seatCommitted,
  expireSeatRequest,
  performanceEnded,
  PERFORMANCE_ENDED_MESSAGE,
} from "../seat-requests";
import { completeSwap } from "./completion";
import { afterSwap, hasStarted, movable, notify, rulesVersion } from "./rules";
import { type SideReason, type SwapData, type SwapEntry } from "./types";

export async function offerSwap(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const input = z
    .object({
      assignmentId: id,
      targetAssignmentIds: z.array(id).min(1).max(20),
    })
    .parse(payload);
  // By the role at the moment of the action (decision 192).
  invariant(
    actor.role !== "manager",
    "forbidden",
    "אחראי תורנויות אינו משובץ לתורנויות ולכן אינו מציע החלפה",
    403
  );
  invariant(
    actor.soldierId,
    "forbidden",
    "רק חייל המשובץ לתורנות יכול להציע החלפה",
    403
  );
  const state = await loadDomain(tx);
  const seat = state.assignments.find((row) => row.id === input.assignmentId);
  invariant(seat, "not_found", "השיבוץ לא נמצא", 404);
  invariant(
    seat.soldierId === actor.soldierId,
    "forbidden",
    "רק בעל השיבוץ יכול להציע אותו להחלפה",
    403
  );
  currentVersion(seat.version, expectedVersion);
  const duty = state.duties.find((row) => row.id === seat.dutyId);
  invariant(duty, "not_found", "התורנות לא נמצאה", 404);
  invariant(
    seat.status === "reserved" && duty.status === "published",
    "not_swappable",
    "ניתן להציע להחלפה רק שיבוץ בתורנות שפורסמה"
  );
  // After the start an offer is still possible, but it always goes to a manager (decision 183).
  movable(seat, duty, "שלך");
  const open = await openSeatRequests(tx);
  invariant(
    !seatCommitted(open, seat.id),
    "swap_open",
    "כבר קיימת הצעת העברה או החלפה פתוחה לשיבוץ הזה",
    409
  );
  const targetIds = [...new Set(input.targetAssignmentIds)];
  const entries: SwapEntry[] = [];
  for (const targetId of targetIds) {
    const target = state.assignments.find((row) => row.id === targetId);
    invariant(
      target && target.status === "reserved",
      "invalid_target",
      "אחד השיבוצים שנבחרו אינו זמין להחלפה"
    );
    invariant(
      target.soldierId !== actor.soldierId,
      "invalid_target",
      "אי אפשר להחליף עם שיבוץ שלך"
    );
    const other = state.duties.find((row) => row.id === target.dutyId);
    const person = state.soldiers.find((row) => row.id === target.soldierId);
    invariant(
      other && other.status === "published",
      "invalid_target",
      "אפשר להחליף רק עם תורנות שפורסמה"
    );
    movable(target, other, `של ${other.name}`);
    invariant(
      !(target.dutyId === seat.dutyId && hasStarted(other)),
      "invalid_target",
      "אחרי תחילת התורנות אי אפשר להחליף בין שני מקומות באותה תורנות"
    );
    invariant(
      person && !person.deletedAt && (await accountOf(tx, person.id)),
      "invalid_target",
      "אחד החיילים שנבחרו אינו זמין לקבלת הצעות"
    );
    // A seat whose owner already agreed to give it away waits for a manager; it is not on offer.
    invariant(
      !open.some(
        (row) =>
          row.data.status === "awaiting_manager" &&
          (row.data.assignmentId === target.id ||
            row.data.acceptedAssignmentId === target.id)
      ),
      "invalid_target",
      `השיבוץ של ${person.name} כבר ממתין להחלטת אחראי בהעברה או בהחלפה אחרת`
    );
    // The offerer learns only that the other soldier is unsuitable, never why (decision 163).
    invariant(
      afterSwap(state, person.id, seat, target.id).status !== "blocked",
      "candidate_ineligible",
      `${person.name} אינו מתאים לתורנות שלך. אפשר לבחור שיבוץ אחר`
    );
    const mine = afterSwap(state, actor.soldierId, target, seat.id);
    invariant(
      mine.status !== "blocked",
      "offerer_ineligible",
      `אינך עומד בתנאי התורנות ${other.name}, ולכן אי אפשר להציע את ההחלפה`,
      422,
      mine
    );
    entries.push({
      soldierId: person.id,
      assignmentId: target.id,
      dutyId: other.id,
      slotId: target.slotId,
      dutyName: other.name,
      role: other.slots.find((slot) => slot.id === target.slotId)?.role ?? "",
      dutyRulesVersion: rulesVersion(other),
      points: target.points,
      extraPoints: target.extraPoints,
      status: "pending",
    });
  }
  const now = new Date().toISOString();
  const { mailRecipients, mailLimited } = await reserveOfferRecipients(
    tx,
    actor.id,
    entries.map((entry) => entry.soldierId)
  );
  const data: SwapData = {
    type: "swap",
    status: "awaiting_consent",
    mailLimited,
    assignmentId: seat.id,
    dutyId: duty.id,
    slotId: seat.slotId,
    dutyName: duty.name,
    role: duty.slots.find((slot) => slot.id === seat.slotId)?.role ?? "",
    dutyRulesVersion: rulesVersion(duty),
    fromSoldierId: actor.soldierId,
    points: seat.points,
    extraPoints: seat.extraPoints,
    candidates: entries,
    createdAt: now,
  };
  const row = await createRecord(tx, "request", data, actor.soldierId);
  const offerer = nameOf(state.soldiers, actor.soldierId);
  for (const soldierId of new Set(entries.map((item) => item.soldierId))) {
    const theirs = entries.filter((item) => item.soldierId === soldierId);
    await notify(tx, soldierId, {
      event: "offer",
      requestId: row.id,
      title: "הוצעה לך החלפת תורנויות",
      body: `${offerer} מציע לך לקבל את התורנות ${duty.name} במקום ${theirs.map((item) => item.dutyName).join(" או ")}. אפשר להסכים או לדחות במסך ההחלפות.${
        hasStarted(duty) ||
        theirs.some((item) =>
          hasStarted(state.duties.find((row) => row.id === item.dutyId)!)
        )
          ? " אחת התורנויות כבר התחילה, ולכן אחרי ההסכמה אחראי יקבע את מועד החילוף."
          : ""
      }`,
      email: mailRecipients.has(soldierId),
      // Relevant until the first seat involved can no longer change hands.
      expiresAt: Math.min(
        instant(executionPeriod(seat, duty).end).toMillis(),
        ...theirs.map((item) => {
          const other = state.duties.find((row) => row.id === item.dutyId)!;
          const target = state.assignments.find(
            (row) => row.id === item.assignmentId
          )!;
          return instant(
            hasStarted(other) ? executionPeriod(target, other).end : other.start
          ).toMillis();
        }),
        hasStarted(duty)
          ? Number.MAX_SAFE_INTEGER
          : instant(duty.start).toMillis()
      ),
    });
  }
  await audit(
    tx,
    actor,
    "swap.offer",
    row.id,
    {
      assignmentId: seat.id,
      dutyId: duty.id,
      targetAssignmentIds: entries.map((item) => item.assignmentId),
    },
    actor.soldierId
  );
  return { id: row.id, version: row.version };
}

export const expire = (
  tx: DbTransaction,
  row: Workflow,
  reason: string,
  code: string
) => expireSeatRequest(tx, row, "swap", reason, code);

async function closeEntry(
  tx: DbTransaction,
  row: Workflow,
  entry: SwapEntry,
  reason: string,
  code: string
) {
  const data = row.data as SwapData;
  const candidates = data.candidates.map((item) =>
    item.assignmentId === entry.assignmentId
      ? { ...item, status: "closed" as const, closedReason: reason }
      : item
  );
  const pending = candidates.some((item) => item.status === "pending");
  await updateRecord(tx, row, {
    ...data,
    candidates,
    ...(!pending && {
      status: "expired",
      closedAt: new Date().toISOString(),
      closedReason: reason,
    }),
  });
  return { committedError: { code, message: reason, status: 409 } };
}

export async function respondSwap(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const input = z
    .discriminatedUnion("decision", [
      z.object({ id, assignmentId: id, decision: z.literal("decline") }),
      z.object({
        id,
        assignmentId: id,
        decision: z.literal("accept"),
        confirmed: z.literal(true),
      }),
    ])
    .parse(payload);
  const row = await findRecord(tx, "request", input.id);
  const data = row.data as SwapData;
  invariant(data.type === "swap", "not_found", "הבקשה לא נמצאה", 404);
  const entry = data.candidates.find(
    (item) =>
      item.assignmentId === input.assignmentId &&
      item.soldierId === actor.soldierId
  );
  invariant(actor.soldierId && entry, "forbidden", "ההצעה אינה מיועדת לך", 403);
  currentVersion(row.version, expectedVersion);
  invariant(
    data.status === "awaiting_consent" && entry.status === "pending",
    "swap_closed",
    "ההצעה כבר נסגרה או שכבר הגבת עליה",
    409
  );
  const now = new Date().toISOString();
  const state = await loadDomain(tx);
  const me = nameOf(state.soldiers, actor.soldierId);
  if (input.decision === "decline") {
    const candidates = data.candidates.map((item) =>
      item === entry
        ? { ...item, status: "declined" as const, decidedAt: now }
        : item
    );
    const done = !candidates.some((item) => item.status === "pending");
    const updated = await updateRecord(tx, row, {
      ...data,
      candidates,
      ...(done && { status: "declined", closedAt: now }),
    });
    await notify(tx, data.fromSoldierId, {
      event: `decline:${entry.assignmentId}`,
      requestId: row.id,
      title: "הצעת ההחלפה נדחתה",
      body: done
        ? `הצעת ההחלפה לתורנות ${data.dutyName} נסגרה בלי החלפה. השיבוץ שלך נשאר בתוקף.`
        : `${me} דחה את החלפת התורנות ${data.dutyName} בתורנות ${entry.dutyName}.`,
      email: done,
      expiresAt: Date.now() + 86_400_000,
    });
    await audit(
      tx,
      actor,
      "swap.decline",
      row.id,
      { dutyId: data.dutyId, targetAssignmentId: entry.assignmentId },
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
    seat.soldierId !== data.fromSoldierId ||
    !duty ||
    duty.status !== "published" ||
    rulesVersion(duty) !== data.dutyRulesVersion
  )
    return expire(
      tx,
      row,
      "השיבוץ של המציע או התורנות שלו השתנו אחרי ההצעה",
      "swap_changed"
    );
  const checkedAt = Date.now();
  if (performanceEnded(seat, duty, checkedAt))
    return expire(tx, row, PERFORMANCE_ENDED_MESSAGE, "performance_ended");
  const target = state.assignments.find(
    (item) => item.id === entry.assignmentId
  );
  const other = state.duties.find((item) => item.id === entry.dutyId);
  if (
    !target ||
    target.status !== "reserved" ||
    target.soldierId !== actor.soldierId ||
    !other ||
    other.status !== "published" ||
    rulesVersion(other) !== entry.dutyRulesVersion
  )
    return closeEntry(
      tx,
      row,
      entry,
      "השיבוץ שלך או התורנות שלו השתנו אחרי ההצעה",
      "swap_changed"
    );
  if (performanceEnded(target, other, checkedAt))
    return closeEntry(
      tx,
      row,
      entry,
      PERFORMANCE_ENDED_MESSAGE,
      "performance_ended"
    );
  // Recheck at the moment of acceptance; the offer reserved nothing.
  const mine = afterSwap(
    state,
    actor.soldierId,
    seat,
    target.id,
    [],
    checkedAt
  );
  invariant(
    mine.status !== "blocked",
    "candidate_ineligible",
    `אינך עומד כעת בתנאי התורנות ${data.dutyName}, ולכן לא ניתן לקבל את ההחלפה`,
    422,
    mine
  );
  const theirs = afterSwap(
    state,
    data.fromSoldierId,
    target,
    seat.id,
    [],
    checkedAt
  );
  if (theirs.status === "blocked") {
    // The offerer's reasons are private; the acceptor learns only that the swap is not possible.
    await notify(tx, data.fromSoldierId, {
      event: `offerer-ineligible:${entry.assignmentId}`,
      requestId: row.id,
      title: "ההחלפה לא הושלמה",
      body: `${me} הסכים להחלפה, אבל אינך עומד כעת בתנאי התורנות ${entry.dutyName}. ההצעה לשיבוץ הזה נסגרה והשיבוץ שלך בתוקף.`,
      email: false,
      expiresAt: 0,
    });
    return closeEntry(
      tx,
      row,
      entry,
      "ההחלפה אינה אפשרית עוד: המציע אינו עומד כעת בתנאי התורנות שלך",
      "offerer_ineligible"
    );
  }
  const started = hasStarted(duty) || hasStarted(other);
  const candidates = data.candidates.map((item) =>
    item === entry
      ? { ...item, status: "accepted" as const, decidedAt: now }
      : item.status === "pending"
        ? { ...item, status: "closed" as const }
        : item
  );
  const others = data.candidates.filter(
    (item) => item !== entry && item.status === "pending"
  );
  if (
    started ||
    mine.status === "approval_required" ||
    theirs.status === "approval_required"
  ) {
    const managerReasons: SideReason[] = [
      ...(started
        ? [
            {
              code: "started",
              message:
                "ההסכמה התקבלה אחרי תחילת אחת התורנויות. נדרש טיפול אחראי בתקופות הביצוע",
            },
          ]
        : []),
      ...mine.approvalsRequired.map((reason) => ({
        ...reason,
        soldierId: actor.soldierId,
      })),
      ...theirs.approvalsRequired.map((reason) => ({
        ...reason,
        soldierId: data.fromSoldierId,
      })),
    ];
    const updated = await updateRecord(tx, row, {
      ...data,
      status: "awaiting_manager",
      candidates,
      acceptedBy: actor.soldierId,
      acceptedAssignmentId: entry.assignmentId,
      acceptedAt: now,
      managerReasons,
    });
    await notify(tx, data.fromSoldierId, {
      event: "awaiting-manager",
      requestId: row.id,
      title: "ההחלפה ממתינה לאחראי",
      body: `${me} הסכים להחליף את ${data.dutyName} ב${entry.dutyName}. ההחלפה ממתינה לטיפול אחראי, ועד אז שני השיבוצים המקוריים בתוקף.`,
      email: true,
      expiresAt: Math.max(
        instant(duty.end).toMillis(),
        instant(other.end).toMillis()
      ),
    });
    await notify(tx, actor.soldierId, {
      event: "awaiting-manager",
      requestId: row.id,
      title: "ההסכמה שלך ממתינה לאחראי",
      body: `הסכמת להחליף את ${entry.dutyName} ב${data.dutyName}. ההחלפה תושלם רק אחרי טיפול אחראי.`,
      email: false,
      expiresAt: 0,
    });
    await closedForOthers(tx, row.id, data, others, entry);
    await notifyManagers(
      tx,
      row.id,
      "החלפה ממתינה לטיפול",
      `החלפת התורנויות ${data.dutyName} (${nameOf(state.soldiers, data.fromSoldierId)}) ו${entry.dutyName} (${me}) ממתינה להחלטת אחראי.`
    );
    await audit(
      tx,
      actor,
      "swap.accept.pending",
      row.id,
      {
        dutyId: duty.id,
        targetAssignmentId: entry.assignmentId,
        reasons: managerReasons.map((item) => item.code),
      },
      actor.soldierId
    );
    return {
      id: updated.id,
      version: updated.version,
      status: "awaiting_manager",
    };
  }
  return completeSwap(tx, actor, {
    row,
    data,
    state,
    seat,
    target,
    entry,
    candidates,
    acceptedAt: now,
    approvals: [],
  });
}

export async function closedForOthers(
  tx: DbTransaction,
  requestId: string,
  data: SwapData,
  others: SwapEntry[],
  accepted: SwapEntry
) {
  for (const soldierId of new Set(others.map((item) => item.soldierId)))
    await notify(tx, soldierId, {
      event: "closed",
      requestId,
      title: "הצעת ההחלפה נסגרה",
      body:
        soldierId === accepted.soldierId
          ? `הסכמת להחלפה בשיבוץ אחר, ולכן שאר ההצעות לתורנות ${data.dutyName} נסגרו.`
          : `חייל אחר הסכים להחליף את התורנות ${data.dutyName}.`,
      email: false,
      expiresAt: 0,
    });
}

export async function withdrawSwap(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const input = z.object({ id }).parse(payload);
  const row = await findRecord(tx, "request", input.id);
  const data = row.data as SwapData;
  const offerer = data.fromSoldierId === actor.soldierId;
  // Either side may back out until a manager decides (decision 178); only the offerer before consent.
  const acceptor =
    data.status === "awaiting_manager" && data.acceptedBy === actor.soldierId;
  invariant(
    data.type === "swap" && actor.soldierId && (offerer || acceptor),
    "forbidden",
    "רק מי שהציע את ההחלפה או מי שהסכים לה יכול לבטל אותה",
    403
  );
  currentVersion(row.version, expectedVersion);
  invariant(
    OPEN_CONSENT.includes(data.status),
    "swap_closed",
    "אפשר לבטל רק החלפה שעדיין ממתינה להסכמה או להחלטת אחראי",
    409
  );
  const now = new Date().toISOString();
  const waiting = data.status === "awaiting_manager";
  const closedReason = !waiting
    ? "המציע ביטל את ההצעה"
    : offerer
      ? "המציע ביטל את ההחלפה לפני החלטת האחראי"
      : "הצד השני חזר בו מהסכמתו לפני החלטת האחראי";
  const updated = await updateRecord(tx, row, {
    ...data,
    status: "cancelled",
    candidates: data.candidates.map((item) =>
      item.status === "pending"
        ? { ...item, status: "closed" }
        : acceptor && item.assignmentId === data.acceptedAssignmentId
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
        title: "ההחלפה בוטלה",
        body: `${closedReason}. השיבוץ שלך נשאר כפי שהיה.`,
        email: true,
        expiresAt: Date.now() + 86_400_000,
      });
    await notifyManagers(
      tx,
      row.id,
      "החלפה בוטלה לפני החלטה",
      `החלפת התורנות ${data.dutyName} בין ${nameOf(state.soldiers, data.fromSoldierId)} ל${nameOf(state.soldiers, data.acceptedBy ?? "")} בוטלה: ${closedReason}.`
    );
  } else
    for (const soldierId of new Set(
      data.candidates
        .filter((item) => item.status === "pending")
        .map((item) => item.soldierId)
    ))
      await notify(tx, soldierId, {
        event: "withdrawn",
        requestId: row.id,
        title: "הצעת ההחלפה בוטלה",
        body: `ההצעה להחליף עם התורנות ${data.dutyName} בוטלה בידי המציע.`,
        email: false,
        expiresAt: 0,
      });
  await audit(
    tx,
    actor,
    acceptor ? "swap.retract" : "swap.withdraw",
    row.id,
    { dutyId: data.dutyId, status: data.status },
    actor.soldierId
  );
  return { id: updated.id, version: updated.version };
}
