import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { duties, records } from "./schema";
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
import { invariant } from "./errors";
import { id, text } from "./validation";
import { instant } from "../domain/time";
import { enqueueEmail } from "./operations/email";
import { createDutyChange } from "./duty-changes";

// A soldier's cancellation or postponement request (decision 172). Submitting changes nothing;
// the manager rejects it or completes it through "update and publish" or cancelling the duty.
type RequestStatus =
  "pending" | "rejected" | "completed" | "referred" | "cancelled" | "closed";
export type Outcome =
  "rejected" | "removed" | "rescheduled" | "duty_cancelled" | "referred";
export type CancellationData = {
  type: "cancellation";
  kind: "cancel" | "postpone";
  status: RequestStatus;
  soldierId: string;
  dutyId: string;
  assignmentId: string;
  slotId: string;
  dutyName: string;
  role: string;
  points: number;
  dutyStart: string;
  dutyEnd: string;
  reason: string;
  createdAt: string;
  decision?: {
    outcome: Outcome;
    reason: string;
    deciderId: string;
    deciderName: string;
    decidedAt: string;
    changeId?: string;
  };
  closedAt?: string;
  closedReason?: string;
};
const kindLabel = { cancel: "ביטול", postpone: "דחייה" } as const;
const outcomeText: Record<Outcome, string> = {
  rejected: "נדחתה",
  removed: "הושלמה: הוסרת מהשיבוץ לתורנות",
  rescheduled: "הושלמה: מועד התורנות שונה",
  duty_cancelled: "הושלמה: התורנות בוטלה",
  referred: "הופנתה לטיפול בביצוע בפועל, כי התורנות כבר התחילה",
};

async function pendingRequests(tx: DbTransaction, dutyId: string) {
  const rows = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "request"));
  return rows.filter(
    (row) =>
      row.data.type === "cancellation" &&
      row.data.status === "pending" &&
      row.data.dutyId === dutyId
  );
}
async function findRequest(tx: DbTransaction, requestId: string) {
  const row = await findRecord(tx, "request", requestId);
  invariant(
    row.data.type === "cancellation",
    "not_found",
    "הבקשה לא נמצאה",
    404
  );
  return { row, data: row.data as CancellationData };
}
function assertPending(data: CancellationData) {
  invariant(
    data.status === "pending",
    "request_closed",
    data.decision
      ? `הבקשה כבר הוכרעה בידי ${data.decision.deciderName}: ${outcomeText[data.decision.outcome]}`
      : "הבקשה כבר נסגרה",
    409
  );
}
async function notifySoldier(
  tx: DbTransaction,
  requestId: string,
  data: CancellationData,
  input: { event: string; title: string; body: string; email: boolean }
) {
  const [account] = await tx
    .select()
    .from(user)
    .where(and(eq(user.soldierId, data.soldierId), isNull(user.deletedAt)));
  if (!account) return;
  await createRecord(
    tx,
    "notification",
    {
      accountId: account.id,
      title: input.title,
      body: input.body,
      href: "/requests",
      requestId,
    },
    data.soldierId
  );
  const [duty] = await tx
    .select()
    .from(duties)
    .where(eq(duties.id, data.dutyId));
  const endsAt = instant(duty?.data.end ?? data.dutyEnd).toMillis();
  // Decision mail follows the "swaps and transfers" preference (decision 172).
  if (input.email && endsAt > Date.now())
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey: `cancellation:${requestId}:${input.event}:${account.id}`,
      kind: "transfer",
      title: input.title,
      body: input.body,
      href: "/requests",
      priority: 1,
      expiresAt: new Date(Math.min(Date.now() + 86_400_000, endsAt)),
    });
}
async function close(
  tx: DbTransaction,
  row: Workflow,
  actor: Actor,
  outcome: Outcome,
  reason: string,
  changeId?: string
) {
  const data = row.data as CancellationData;
  const now = new Date().toISOString();
  const status: RequestStatus =
    outcome === "rejected"
      ? "rejected"
      : outcome === "referred"
        ? "referred"
        : "completed";
  const updated = await updateRecord(tx, row, {
    ...data,
    status,
    decision: {
      outcome,
      reason,
      deciderId: actor.id,
      deciderName: actor.name,
      decidedAt: now,
      ...(changeId && { changeId }),
    },
    closedAt: now,
  });
  const title =
    outcome === "rejected"
      ? `בקשת ה${kindLabel[data.kind]} נדחתה`
      : outcome === "referred"
        ? `בקשת ה${kindLabel[data.kind]} הופנתה לטיפול בביצוע`
        : `בקשת ה${kindLabel[data.kind]} הושלמה`;
  const body =
    outcome === "rejected"
      ? `הבקשה לתורנות ${data.dutyName} נדחתה: ${reason}. השיבוץ שלך נשאר בתוקף.`
      : outcome === "referred"
        ? `התורנות ${data.dutyName} כבר התחילה, ולכן לא ניתן לבטל או לדחות אותה. האחראי יטפל בביצוע בפועל: ${reason}`
        : `הבקשה לתורנות ${data.dutyName} ${outcomeText[outcome]}.`;
  // A completed request is also announced by the published change itself; that mail is not repeated.
  await notifySoldier(tx, row.id, data, {
    event: status,
    title,
    body,
    email: status !== "completed",
  });
  await audit(
    tx,
    actor,
    `cancellation.${status}`,
    row.id,
    // The reason stays in the request record, which is erased with the soldier.
    { dutyId: data.dutyId, outcome, ...(changeId && { changeId }) },
    data.soldierId
  );
  return updated;
}

export async function submitCancellationRequest(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const input = z
    .object({
      assignmentId: id,
      kind: z.enum(["cancel", "postpone"]),
      reason: text,
    })
    .parse(payload);
  invariant(
    actor.soldierId,
    "forbidden",
    "רק חייל המשובץ לתורנות יכול לבקש ביטול או דחייה",
    403
  );
  const state = await loadDomain(tx);
  const seat = state.assignments.find((row) => row.id === input.assignmentId);
  invariant(seat, "not_found", "השיבוץ לא נמצא", 404);
  invariant(
    seat.soldierId === actor.soldierId,
    "forbidden",
    "אפשר לבקש ביטול או דחייה רק לשיבוץ שלך",
    403
  );
  currentVersion(seat.version, expectedVersion);
  const duty = state.duties.find((row) => row.id === seat.dutyId);
  invariant(duty, "not_found", "התורנות לא נמצאה", 404);
  invariant(
    seat.status === "reserved" && duty.status === "published",
    "not_requestable",
    "אפשר לבקש ביטול או דחייה רק לשיבוץ בתורנות שפורסמה"
  );
  // Requests are accepted only before the start (decision 172).
  invariant(
    instant(duty.start).toMillis() > Date.now(),
    "performance_started",
    "התורנות כבר התחילה. לשינוי במהלך הביצוע יש לפנות לאחראי"
  );
  invariant(
    !(await pendingRequests(tx, duty.id)).some(
      (row) => row.data.soldierId === actor.soldierId
    ),
    "request_open",
    "כבר קיימת בקשה פתוחה לתורנות הזו",
    409
  );
  const data: CancellationData = {
    type: "cancellation",
    kind: input.kind,
    status: "pending",
    soldierId: actor.soldierId,
    dutyId: duty.id,
    assignmentId: seat.id,
    slotId: seat.slotId,
    dutyName: duty.name,
    role: duty.slots.find((slot) => slot.id === seat.slotId)?.role ?? "",
    points: seat.points,
    dutyStart: duty.start,
    dutyEnd: duty.end,
    reason: input.reason,
    createdAt: new Date().toISOString(),
  };
  const row = await createRecord(tx, "request", data, actor.soldierId);
  const name =
    state.soldiers.find((item) => item.id === actor.soldierId)?.name ?? "חייל";
  const managers = await tx
    .select()
    .from(user)
    .where(and(eq(user.role, "manager"), isNull(user.deletedAt)));
  // Managers get a site notice only; no subject, so the soldier never sees the manager copy.
  for (const account of managers)
    await createRecord(tx, "notification", {
      accountId: account.id,
      title: `בקשת ${kindLabel[input.kind]} חדשה`,
      body: `${name} ביקש ${kindLabel[input.kind]} של התורנות ${duty.name}. השיבוץ בתוקף עד החלטת אחראי.`,
      href: "/requests",
      requestId: row.id,
    });
  await audit(
    tx,
    actor,
    "cancellation.submit",
    row.id,
    { dutyId: duty.id, assignmentId: seat.id, kind: input.kind },
    actor.soldierId
  );
  return { id: row.id, version: row.version };
}

export async function withdrawCancellationRequest(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const input = z.object({ id }).parse(payload);
  const { row, data } = await findRequest(tx, input.id);
  invariant(
    actor.soldierId && data.soldierId === actor.soldierId,
    "forbidden",
    "רק מי שהגיש את הבקשה יכול לבטל אותה",
    403
  );
  currentVersion(row.version, expectedVersion);
  assertPending(data);
  const updated = await updateRecord(tx, row, {
    ...data,
    status: "cancelled",
    closedAt: new Date().toISOString(),
    closedReason: "החייל ביטל את הבקשה",
  });
  await audit(
    tx,
    actor,
    "cancellation.withdraw",
    row.id,
    { dutyId: data.dutyId },
    data.soldierId
  );
  return { id: updated.id, version: updated.version };
}

export async function rejectCancellationRequest(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z.object({ id, reason: text }).parse(payload);
  const { row, data } = await findRequest(tx, input.id);
  assertPending(data);
  currentVersion(row.version, expectedVersion);
  const updated = await close(tx, row, actor, "rejected", input.reason);
  return { id: updated.id, version: updated.version };
}

/** After the start a request cannot cancel or postpone; the manager refers it to performance handling. */
export async function referCancellationRequest(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z.object({ id, reason: text }).parse(payload);
  const { row, data } = await findRequest(tx, input.id);
  assertPending(data);
  currentVersion(row.version, expectedVersion);
  const [duty] = await tx
    .select()
    .from(duties)
    .where(eq(duties.id, data.dutyId));
  invariant(
    duty && instant(duty.data.start).toMillis() <= Date.now(),
    "not_started",
    "לפני תחילת התורנות מטפלים בבקשה בעדכון ופרסום או בביטול התורנות"
  );
  const updated = await close(tx, row, actor, "referred", input.reason);
  return { id: updated.id, version: updated.version };
}

/**
 * Opens a change proposal for the request. Nothing is saved to the duty until the manager
 * previews it and uses "update and publish" (or discards it and the request stays pending).
 */
export async function prepareCancellationChange(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({ id, outcome: z.enum(["remove", "reschedule"]), reason: text })
    .parse(payload);
  const { row, data } = await findRequest(tx, input.id);
  assertPending(data);
  currentVersion(row.version, expectedVersion);
  const proposals = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "duty_change"));
  invariant(
    !proposals.some(
      (item) => item.data.requestId === row.id && item.data.status === "open"
    ),
    "change_open",
    "כבר קיימת הצעת שינוי פתוחה לבקשה הזו",
    409
  );
  const [duty] = await tx
    .select()
    .from(duties)
    .where(eq(duties.id, data.dutyId));
  invariant(duty, "not_found", "התורנות לא נמצאה", 404);
  invariant(
    duty.data.status === "published",
    "not_requestable",
    "התורנות אינה מפורסמת עוד",
    409
  );
  // The existing change flow enforces the regular limit: nothing changes after the start.
  const created = await createDutyChange(
    tx,
    actor,
    { dutyId: duty.id, reason: input.reason },
    duty.version
  );
  const change = await findRecord(tx, "duty_change", created.id);
  const seats = (change.data.seats as { soldierId: string | null }[]).map(
    (seat) =>
      input.outcome === "remove" && seat.soldierId === data.soldierId
        ? { ...seat, soldierId: null, extraPoints: "0" }
        : seat
  );
  const linked = await updateRecord(tx, change, {
    ...change.data,
    seats,
    requestId: row.id,
    requestOutcome: input.outcome,
  });
  await audit(
    tx,
    actor,
    "cancellation.prepare",
    row.id,
    { dutyId: duty.id, changeId: change.id, outcome: input.outcome },
    data.soldierId
  );
  return { id: linked.id, version: linked.version, dutyId: duty.id };
}

/** The request a change proposal handles, as the preview shows it before "update and publish". */
export async function linkedRequest(tx: DbTransaction, requestId: unknown) {
  if (typeof requestId !== "string") return undefined;
  const [row] = await tx
    .select()
    .from(records)
    .where(and(eq(records.id, requestId), eq(records.kind, "request")));
  if (!row) return undefined;
  const data = row.data as CancellationData;
  return {
    id: row.id,
    status: data.status,
    kind: data.kind,
    soldierId: data.soldierId,
  };
}

/**
 * Called inside "update and publish". The linked request completes when the requester left
 * the duty or its dates moved; any pending request whose requester was removed completes too.
 */
export async function settleAfterPublishedChange(
  tx: DbTransaction,
  actor: Actor,
  input: {
    dutyId: string;
    changeId: string;
    requestId?: unknown;
    reason: string;
    assignedAfter: string[];
    rescheduled: boolean;
  }
) {
  for (const row of await pendingRequests(tx, input.dutyId)) {
    const data = row.data as CancellationData;
    const removed = !input.assignedAfter.includes(data.soldierId);
    const outcome: Outcome | undefined = removed
      ? "removed"
      : row.id === input.requestId && input.rescheduled
        ? "rescheduled"
        : undefined;
    if (outcome)
      await close(tx, row, actor, outcome, input.reason, input.changeId);
  }
}

/** Called inside a duty cancellation: every pending request on it is completed by that decision. */
export async function settleAfterCancelledDuty(
  tx: DbTransaction,
  actor: Actor,
  dutyId: string,
  reason: string,
  requestId?: string
) {
  if (requestId) {
    const { data } = await findRequest(tx, requestId);
    invariant(
      data.dutyId === dutyId,
      "invalid_request",
      "הבקשה אינה שייכת לתורנות הזו"
    );
    assertPending(data);
  }
  for (const row of await pendingRequests(tx, dutyId))
    await close(tx, row, actor, "duty_cancelled", reason);
}

/** A seat that left its owner by consent no longer carries that owner's request. */
export async function closeRequestsOfTransferredSeat(
  tx: DbTransaction,
  dutyId: string,
  soldierId: string
) {
  for (const row of await pendingRequests(tx, dutyId)) {
    if (row.data.soldierId !== soldierId) continue;
    await updateRecord(tx, row, {
      ...row.data,
      status: "closed",
      closedAt: new Date().toISOString(),
      closedReason: "התורנות הועברה לחייל אחר בהסכמה",
    });
  }
}

/** Soldiers see their own requests and the decision's reason, without the deciding manager. */
export function projectCancellationRequests(
  rows: Workflow[],
  actor: Actor,
  managing: boolean
) {
  return rows
    .filter(
      (row) =>
        row.kind === "request" &&
        row.data.type === "cancellation" &&
        (managing || row.data.soldierId === actor.soldierId)
    )
    .map((row): Record<string, unknown> => {
      const data = row.data as CancellationData;
      const view = { ...data, id: row.id, version: row.version };
      if (managing || !data.decision) return view;
      const { outcome, reason, decidedAt } = data.decision;
      return { ...view, decision: { outcome, reason, decidedAt } };
    });
}
