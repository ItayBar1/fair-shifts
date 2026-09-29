import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { assignments, duties, records } from "./schema";
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
import { AppError, invariant } from "./errors";
import { id } from "./validation";
import { evaluateEligibility } from "../domain/eligibility";
import { instant } from "../domain/time";
import type {
  Assignment,
  Duty,
  EligibilityReason,
  Soldier,
  SpecificApproval,
} from "../domain/types";
import { enqueueEmail } from "./operations/email";

// Consensual transfer of a published seat before it starts (decisions 108-109, 149, 163),
// and the manager's decision on a transfer that needs one (decision 168).
type CandidateStatus = "pending" | "declined" | "accepted" | "closed";
type TransferStatus =
  | "awaiting_consent"
  | "awaiting_manager"
  | "completed"
  | "declined"
  | "manager_rejected"
  | "cancelled"
  | "expired";
export type TransferData = {
  type: "transfer";
  status: TransferStatus;
  assignmentId: string;
  dutyId: string;
  slotId: string;
  dutyName: string;
  role: string;
  dutyRulesVersion: number;
  fromSoldierId: string;
  points: number;
  extraPoints?: string;
  candidates: {
    soldierId: string;
    status: CandidateStatus;
    decidedAt?: string;
  }[];
  createdAt: string;
  acceptedBy?: string;
  acceptedAt?: string;
  managerReasons?: EligibilityReason[];
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: string;
  decisionReason?: string;
  approvals?: SpecificApproval[];
  resultAssignmentId?: string;
  closedAt?: string;
  closedReason?: string;
};
const OPEN: TransferStatus[] = ["awaiting_consent", "awaiting_manager"];
type Domain = Awaited<ReturnType<typeof loadDomain>>;

function candidateEligibility(
  state: Domain,
  person: Soldier,
  duty: Duty,
  slotId: string
) {
  const slot = duty.slots.find((row) => row.id === slotId);
  invariant(slot, "not_found", "המקום לא נמצא בתורנות", 404);
  return evaluateEligibility(person, duty, slot, {
    duties: state.duties,
    assignments: state.assignments,
    mode: "volunteer",
  });
}
async function accountOf(tx: DbTransaction, soldierId: string) {
  const [account] = await tx
    .select()
    .from(user)
    .where(and(eq(user.soldierId, soldierId), isNull(user.deletedAt)));
  return account;
}
async function notify(
  tx: DbTransaction,
  soldierId: string,
  input: {
    event: string;
    requestId: string;
    title: string;
    body: string;
    email: boolean;
    expiresAt: number;
  }
) {
  const account = await accountOf(tx, soldierId);
  if (!account) return;
  const href = "/requests";
  await createRecord(
    tx,
    "notification",
    {
      accountId: account.id,
      title: input.title,
      body: input.body,
      href,
      requestId: input.requestId,
    },
    soldierId
  );
  if (input.email && input.expiresAt > Date.now())
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey: `transfer:${input.requestId}:${input.event}:${account.id}`,
      kind: "transfer",
      title: input.title,
      body: input.body,
      href,
      priority: 1,
      expiresAt: new Date(Math.min(Date.now() + 86_400_000, input.expiresAt)),
    });
}
async function notifyManagers(
  tx: DbTransaction,
  requestId: string,
  title: string,
  body: string
) {
  const managers = await tx
    .select()
    .from(user)
    .where(and(eq(user.role, "manager"), isNull(user.deletedAt)));
  // Site notifications only (decision 163); no subject so the soldier never receives the manager copy.
  for (const account of managers)
    await createRecord(tx, "notification", {
      accountId: account.id,
      title,
      body,
      href: "/requests",
      requestId,
    });
}
function nameOf(state: Domain, soldierId: string) {
  return state.soldiers.find((row) => row.id === soldierId)?.name ?? "חייל";
}
async function openTransfers(tx: DbTransaction) {
  const rows = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "request"));
  return rows.filter(
    (row) =>
      row.data.type === "transfer" &&
      OPEN.includes(row.data.status as TransferStatus)
  );
}

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
  invariant(
    instant(duty.start).toMillis() > Date.now(),
    "performance_started",
    "התורנות כבר התחילה. בקשת החלפה במהלך ביצוע מטופלת בידי אחראי"
  );
  invariant(
    !(await openTransfers(tx)).some((row) => row.data.assignmentId === seat.id),
    "transfer_open",
    "כבר קיימת הצעת העברה פתוחה לשיבוץ הזה",
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
      candidateEligibility(state, person, duty, seat.slotId).status !==
        "blocked",
      "candidate_ineligible",
      `${person.name} אינו מתאים לתורנות זו. אפשר לבחור חייל אחר`
    );
  }
  const now = new Date().toISOString();
  const data: TransferData = {
    type: "transfer",
    status: "awaiting_consent",
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
      body: `${offerer} מציע לך לקבל את התורנות ${duty.name}. אפשר להסכים או לדחות במסך ההחלפות.`,
      email: true,
      expiresAt: instant(duty.start).toMillis(),
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

async function expire(
  tx: DbTransaction,
  row: Workflow,
  reason: string,
  code: string
) {
  const data = row.data as TransferData;
  await updateRecord(tx, row, {
    ...data,
    status: "expired",
    candidates: data.candidates.map((item) =>
      item.status === "pending" ? { ...item, status: "closed" } : item
    ),
    closedAt: new Date().toISOString(),
    closedReason: reason,
  });
  for (const soldierId of [data.fromSoldierId, data.acceptedBy])
    if (soldierId)
      await notify(tx, soldierId, {
        event: "expired",
        requestId: row.id,
        title: "הצעת ההעברה פגה",
        body: `הצעת ההעברה לתורנות ${data.dutyName} נסגרה: ${reason}`,
        email: false,
        expiresAt: 0,
      });
  // Returned failures are committed by the command layer before producing the HTTP error.
  return { committedError: { code, message: reason, status: 409 } };
}

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
  const person = state.soldiers.find((item) => item.id === actor.soldierId);
  invariant(person, "not_found", "החייל לא נמצא", 404);
  // Recheck at the moment of acceptance: the offer never reserved anything for the candidate.
  const eligibility = candidateEligibility(state, person, duty, data.slotId);
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

/**
 * Releases the original seat and gives its full value to the replacement in one transaction.
 * Shared by an automatic acceptance and a manager's approval (decisions 163, 168).
 */
async function completeTransfer(
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
  // Either side may back out until a manager decides (decision 168); only the offerer before consent.
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

function approvalKey(reason: EligibilityReason) {
  return `${reason.code}:${reason.referenceId ?? ""}:${reason.referenceVersion ?? ""}`;
}
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

/** Read-only review for a manager: current eligibility of the replacement and the exceptions to approve. */
export async function reviewTransfer(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const input = z.object({ id }).parse(payload);
  const { row, data, state, duty, person, changed } = await awaitingManager(
    tx,
    actor,
    input.id,
    expectedVersion
  );
  if (changed || !duty || !person)
    return { valid: false, message: changed ?? "ההעברה אינה תקפה עוד" };
  const started = instant(duty.start).toMillis() <= Date.now();
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

/** A manager approves a transfer that needs exceptions, or rejects it with a reason visible to both sides (decision 168). */
export async function decideTransfer(
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
      }),
    ])
    .parse(payload);
  const { row, data, state, seat, duty, person, changed } =
    await awaitingManager(tx, actor, input.id, expectedVersion);
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
      email: true,
      expiresAt,
    });
    await notify(tx, replacementId, {
      event: "rejected",
      requestId: row.id,
      title: "האחראי דחה את ההעברה",
      body: `העברת התורנות ${data.dutyName} אליך נדחתה: ${input.reason}.`,
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
      { dutyId: data.dutyId, reason: input.reason },
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
  // After the start the seat moves only through performance periods, never here.
  invariant(
    instant(duty.start).toMillis() > Date.now(),
    "performance_started",
    "התורנות כבר התחילה. העברה אחרי התחלה מטופלת במסלול תקופות הביצוע; עד אז השיבוץ המקורי בתוקף",
    409
  );
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

/** Closes open transfer offers when their duty is cancelled or republished with new details. */
export async function closeTransfersForDuty(
  tx: DbTransaction,
  dutyId: string,
  reason: string
) {
  for (const row of await openTransfers(tx)) {
    if (row.data.dutyId !== dutyId) continue;
    const data = row.data as TransferData;
    await updateRecord(tx, row, {
      ...data,
      status: "expired",
      candidates: data.candidates.map((item) =>
        item.status === "pending" ? { ...item, status: "closed" } : item
      ),
      closedAt: new Date().toISOString(),
      closedReason: reason,
    });
  }
}

/** Soldiers see their own offers and offers addressed to them, without other candidates' outcomes or reasons. */
export function projectRequests(
  rows: Workflow[],
  actor: Actor,
  managing: boolean
) {
  const view = (row: Workflow): Record<string, unknown> => ({
    ...row.data,
    id: row.id,
    version: row.version,
    subjectId: row.subjectId,
  });
  return rows
    .filter((row) => row.kind === "request")
    .flatMap((row): Record<string, unknown>[] => {
      if (managing) return [view(row)];
      if (row.data.type !== "transfer")
        return row.subjectId === actor.soldierId ||
          row.data.accountId === actor.id
          ? [view(row)]
          : [];
      const data = row.data as TransferData;
      const shared = {
        id: row.id,
        version: row.version,
        type: data.type,
        dutyId: data.dutyId,
        dutyName: data.dutyName,
        role: data.role,
        assignmentId: data.assignmentId,
        fromSoldierId: data.fromSoldierId,
        points: data.points,
        createdAt: data.createdAt,
        closedAt: data.closedAt,
      };
      // The manager's decision and its reason reach both sides, never other candidates (decision 168).
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
            candidates: data.candidates,
            ...decision,
          },
        ];
      const mine = data.candidates.find(
        (item) => item.soldierId === actor.soldierId
      );
      if (!mine) return [];
      const accepted = data.acceptedBy === actor.soldierId;
      return [
        {
          ...shared,
          status:
            data.status === "awaiting_consent" && mine.status === "pending"
              ? "awaiting_consent"
              : accepted
                ? data.status
                : mine.status === "declined"
                  ? "declined"
                  : "closed",
          candidates: [mine],
          ...(accepted && {
            acceptedBy: data.acceptedBy,
            managerReasons: data.managerReasons,
            closedReason: data.closedReason,
            ...decision,
          }),
        },
      ];
    });
}
