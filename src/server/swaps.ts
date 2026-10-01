import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { assignments, duties } from "./schema";
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
import { AppError, invariant } from "./errors";
import { id } from "./validation";
import { evaluateEligibility } from "../domain/eligibility";
import { instant } from "../domain/time";
import type {
  Assignment,
  Duty,
  EligibilityReason,
  SpecificApproval,
} from "../domain/types";
import { closeRequestsOfTransferredSeat } from "./cancellation-requests";
import { cancelStaleDutyReminders } from "./duty-reminder-checks";
import {
  commitExecution,
  executionView,
  handoverSegments,
  parseHandover,
  planExecution,
  seatOf,
  splitBlocker,
  type ExecutionPlan,
} from "./execution";
import { remainingPeriod } from "./transfers";
import { executionPeriod } from "../domain/execution";
import {
  accountOf,
  approvalKey,
  closeSeatRequests,
  nameOf,
  notifyManagers,
  notifySoldier,
  OPEN_CONSENT,
  openSeatRequests,
  seatCommitted,
  type ConsentStatus,
} from "./seat-requests";

// Mutual swap of two published seats by consent (decisions 108-109, 181): both sides move
// together or not at all, each seat keeps its full value, and no score band is checked.
type EntryStatus = "pending" | "declined" | "accepted" | "closed";
type SwapEntry = {
  soldierId: string;
  assignmentId: string;
  dutyId: string;
  slotId: string;
  dutyName: string;
  role: string;
  dutyRulesVersion: number;
  points: number;
  extraPoints?: string;
  status: EntryStatus;
  decidedAt?: string;
  closedReason?: string;
};
type SideReason = EligibilityReason & { soldierId?: string };
export type SwapData = {
  type: "swap";
  status: ConsentStatus;
  assignmentId: string;
  dutyId: string;
  slotId: string;
  dutyName: string;
  role: string;
  dutyRulesVersion: number;
  fromSoldierId: string;
  points: number;
  extraPoints?: string;
  candidates: SwapEntry[];
  createdAt: string;
  acceptedBy?: string;
  acceptedAssignmentId?: string;
  acceptedAt?: string;
  managerReasons?: SideReason[];
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: string;
  decisionReason?: string;
  approvals?: SpecificApproval[];
  resultAssignmentIds?: string[];
  closedAt?: string;
  closedReason?: string;
};
type Domain = Awaited<ReturnType<typeof loadDomain>>;

const rulesVersion = (duty: Duty) => duty.rulesVersion ?? duty.version;
const hasStarted = (duty: Duty) => instant(duty.start).toMillis() <= Date.now();
const notify = (
  tx: DbTransaction,
  soldierId: string,
  input: Omit<Parameters<typeof notifySoldier>[2], "scope">
) => notifySoldier(tx, soldierId, { ...input, scope: "swap" });

/**
 * Eligibility of `soldierId` for `seat` as it would stand after the swap: the soldier's own
 * source seat is ignored, so the two seats never conflict with each other.
 */
function afterSwap(
  state: Domain,
  soldierId: string,
  seat: Assignment,
  leaving: string,
  approvals: SpecificApproval[] = []
) {
  const person = state.soldiers.find((row) => row.id === soldierId);
  const duty = state.duties.find((row) => row.id === seat.dutyId);
  invariant(person && duty, "not_found", "החייל או התורנות לא נמצאו", 404);
  const slot = duty.slots.find((row) => row.id === seat.slotId);
  invariant(slot, "not_found", "המקום לא נמצא בתורנות", 404);
  // A seat that started can only be taken over for what is left of it (decision 183).
  const rest = remainingPeriod(seat, duty);
  return evaluateEligibility(person, rest ? { ...duty, ...rest } : duty, slot, {
    duties: state.duties,
    assignments: state.assignments,
    // Both soldiers consented, so both are volunteers (decision 163).
    mode: "volunteer",
    ignoreAssignmentIds: [leaving],
    approvals,
  });
}

/** A seat can be offered until its own period ends; after the start only if it can be split. */
function movable(state: Domain, seat: Assignment, duty: Duty, whose: string) {
  invariant(
    instant(executionPeriod(seat, duty).end).toMillis() > Date.now(),
    "performance_ended",
    `הביצוע בתורנות ${whose} כבר הסתיים. תיקון ביצוע נעשה בידי אחראי`
  );
  if (!hasStarted(duty)) return;
  const blocker = splitBlocker(
    duty,
    state.assignments.filter(
      (row) =>
        row.dutyId === duty.id &&
        row.slotId === seat.slotId &&
        row.status !== "cancelled"
    )
  );
  invariant(!blocker, "not_swappable", blocker!);
}

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
  movable(state, seat, duty, "שלך");
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
    movable(state, target, other, `של ${other.name}`);
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
  const data: SwapData = {
    type: "swap",
    status: "awaiting_consent",
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
      email: true,
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

async function expire(
  tx: DbTransaction,
  row: Workflow,
  reason: string,
  code: string
) {
  const data = row.data as SwapData;
  await updateRecord(tx, row, {
    ...data,
    status: "expired",
    candidates: data.candidates.map((item) =>
      item.status === "pending" ? { ...item, status: "closed" } : item
    ),
    closedAt: new Date().toISOString(),
    closedReason: reason,
  });
  for (const soldierId of new Set([data.fromSoldierId, data.acceptedBy]))
    if (soldierId)
      await notify(tx, soldierId, {
        event: "expired",
        requestId: row.id,
        title: "הצעת ההחלפה פגה",
        body: `הצעת ההחלפה לתורנות ${data.dutyName} נסגרה: ${reason}`,
        email: false,
        expiresAt: 0,
      });
  // Returned failures are committed by the command layer before producing the HTTP error.
  return { committedError: { code, message: reason, status: 409 } };
}

/** One seat of the offer can no longer be swapped; the rest of the offer stays open. */
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
  // Recheck at the moment of acceptance; the offer reserved nothing.
  const mine = afterSwap(state, actor.soldierId, seat, target.id);
  invariant(
    mine.status !== "blocked",
    "candidate_ineligible",
    `אינך עומד כעת בתנאי התורנות ${data.dutyName}, ולכן לא ניתן לקבל את ההחלפה`,
    422,
    mine
  );
  const theirs = afterSwap(state, data.fromSoldierId, target, seat.id);
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

async function closedForOthers(
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

async function release(
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

async function occupy(
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
async function completeSwap(
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

/** Everything a manager's decision rests on; any change requires a fresh review. */
function reviewToken(state: Domain, row: Workflow, data: SwapData) {
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

function sides(
  state: Domain,
  data: SwapData,
  entry: SwapEntry,
  seat: Assignment,
  target: Assignment,
  approvals: SpecificApproval[] = []
) {
  return [
    {
      soldierId: entry.soldierId,
      dutyName: data.dutyName,
      eligibility: afterSwap(
        state,
        entry.soldierId,
        seat,
        target.id,
        approvals
      ),
    },
    {
      soldierId: data.fromSoldierId,
      dutyName: entry.dutyName,
      eligibility: afterSwap(
        state,
        data.fromSoldierId,
        target,
        seat.id,
        approvals
      ),
    },
  ];
}

const handovers = {
  handoverAt: z.string().max(40).optional(),
  handoverOffset: z.number().optional(),
  targetHandoverAt: z.string().max(40).optional(),
  targetHandoverOffset: z.number().optional(),
};
function handoverTimes(input: {
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
async function startedSwap(
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

async function decideStartedSwap(
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
  const planned = await startedSwap(tx, { ...context, at });
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
            });
      const execution = await commitExecution(tx, actor, plan, {
        reason: `החלפה במהלך ביצוע בין ${fromName} ל${toName}`,
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

/** Read-only review for a manager: both sides' eligibility after the swap and the exceptions to approve. */
export async function reviewSwap(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const input = z.object({ id, ...handovers }).parse(payload);
  const { row, data, state, entry, seat, target, duty, other, changed } =
    await awaitingManager(tx, actor, input.id, expectedVersion);
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
      }),
    ])
    .parse(payload);
  const { row, data, state, entry, seat, target, duty, other, changed } =
    await awaitingManager(tx, actor, input.id, expectedVersion);
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

/**
 * The offerer sees every seat they offered; the other soldier sees only their own seats in
 * the offer. Exception reasons of one side never reach the other (decisions 163, 178).
 */
export function projectSwaps(
  rows: Workflow[],
  actor: Actor,
  managing: boolean
) {
  return rows
    .filter((row) => row.kind === "request" && row.data.type === "swap")
    .flatMap((row): Record<string, unknown>[] => {
      const data = row.data as SwapData;
      if (managing) return [{ ...data, id: row.id, version: row.version }];
      const reasonsFor = (soldierId?: string) =>
        (data.managerReasons ?? []).filter(
          (item) => !item.soldierId || item.soldierId === soldierId
        );
      const shared = {
        id: row.id,
        version: row.version,
        type: data.type,
        assignmentId: data.assignmentId,
        dutyId: data.dutyId,
        dutyName: data.dutyName,
        role: data.role,
        fromSoldierId: data.fromSoldierId,
        points: data.points,
        createdAt: data.createdAt,
        closedAt: data.closedAt,
      };
      const decision = {
        decidedByName: data.decidedByName,
        decidedAt: data.decidedAt,
        decisionReason: data.decisionReason,
      };
      if (data.fromSoldierId === actor.soldierId)
        return [
          {
            ...shared,
            status: data.status,
            closedReason: data.closedReason,
            acceptedBy: data.acceptedBy,
            acceptedAssignmentId: data.acceptedAssignmentId,
            candidates: data.candidates,
            managerReasons: reasonsFor(actor.soldierId),
            ...decision,
          },
        ];
      const mine = data.candidates.filter(
        (item) => item.soldierId === actor.soldierId
      );
      if (!mine.length) return [];
      const accepted = data.acceptedBy === actor.soldierId;
      const pending = mine.some((item) => item.status === "pending");
      return [
        {
          ...shared,
          status:
            data.status === "awaiting_consent" && pending
              ? "awaiting_consent"
              : accepted
                ? data.status
                : mine.some((item) => item.status === "declined")
                  ? "declined"
                  : "closed",
          candidates: mine,
          ...(accepted && {
            acceptedBy: data.acceptedBy,
            acceptedAssignmentId: data.acceptedAssignmentId,
            managerReasons: reasonsFor(actor.soldierId),
            closedReason: data.closedReason,
            ...decision,
          }),
        },
      ];
    });
}
