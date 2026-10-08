import { and, eq, isNull } from "drizzle-orm";
import type { DbTransaction } from "./db";
import { records } from "./schema";
import { user } from "./auth-schema";
import { createRecord, updateRecord, type Workflow } from "./repository";
import { enqueueEmail } from "./operations/email";
import { staffNotificationRecipients } from "./notification-audience";
import { reserveDailyBudget } from "./auth/budgets";
import type { EligibilityReason, Soldier } from "../domain/types";

// Helpers shared by the consent flows that move a published seat: a transfer to another
// soldier (decisions 163, 178) and a mutual swap of two seats (decision 181).
export type ConsentStatus =
  | "awaiting_consent"
  | "awaiting_manager"
  | "completed"
  | "declined"
  | "manager_rejected"
  | "cancelled"
  | "expired";
export const OPEN_CONSENT: ConsentStatus[] = [
  "awaiting_consent",
  "awaiting_manager",
];

export async function accountOf(tx: DbTransaction, soldierId: string) {
  const [account] = await tx
    .select()
    .from(user)
    .where(and(eq(user.soldierId, soldierId), isNull(user.deletedAt)));
  return account;
}

/** A site notification, and a mail of the "swaps and transfers" type while it is still relevant. */
export async function reserveOfferRecipients(
  tx: DbTransaction,
  senderAccountId: string,
  soldierIds: readonly string[]
) {
  const mailRecipients = new Set<string>();
  let mailLimited = false;
  for (const soldierId of new Set(soldierIds)) {
    if (!(await accountOf(tx, soldierId))) continue;
    if (
      await reserveDailyBudget(
        tx,
        "seat-offer:issue",
        senderAccountId,
        1,
        30,
        undefined
      )
    )
      mailRecipients.add(soldierId);
    else mailLimited = true;
  }
  return { mailRecipients, mailLimited };
}

export async function notifySoldier(
  tx: DbTransaction,
  soldierId: string,
  input: {
    event: string;
    requestId: string;
    title: string;
    body: string;
    /** Decision reasons stay on site; mail can carry a separate neutral body. */
    mailBody?: string;
    email: boolean;
    expiresAt: number;
    /** Mail event namespace, so a swap and a transfer never share a key. */
    scope?: "transfer" | "swap" | "execution";
    href?: string;
  }
) {
  const account = await accountOf(tx, soldierId);
  if (!account) return;
  const href = input.href ?? "/requests";
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
      eventKey: `${input.scope ?? "transfer"}:${input.requestId}:${input.event}:${account.id}`,
      kind: "transfer",
      title: input.title,
      body: input.mailBody ?? input.body,
      href,
      priority: 1,
      expiresAt: new Date(Math.min(Date.now() + 86_400_000, input.expiresAt)),
    });
}

export async function notifyManagers(
  tx: DbTransaction,
  requestId: string,
  title: string,
  body: string
) {
  const managers = await staffNotificationRecipients(tx);
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

export function nameOf(soldiers: Soldier[], soldierId: string) {
  return soldiers.find((row) => row.id === soldierId)?.name ?? "חייל";
}

export function approvalKey(reason: EligibilityReason) {
  return `${reason.code}:${reason.referenceId ?? ""}:${reason.referenceVersion ?? ""}`;
}

/** Open transfers and swaps. */
export async function openSeatRequests(tx: DbTransaction) {
  const rows = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "request"));
  return rows.filter(
    (row) =>
      (row.data.type === "transfer" || row.data.type === "swap") &&
      OPEN_CONSENT.includes(row.data.status as ConsentStatus)
  );
}

type SwapEntry = {
  assignmentId: string;
  dutyId: string;
  status: string;
};

/**
 * Seats a soldier can no longer offer: their own seat in an open transfer or swap, and a seat
 * they already agreed to give in a swap that waits for a manager.
 */
export function seatCommitted(rows: Workflow[], assignmentId: string) {
  return rows.some(
    (row) =>
      row.data.assignmentId === assignmentId ||
      (row.data.type === "swap" &&
        row.data.status === "awaiting_manager" &&
        row.data.acceptedAssignmentId === assignmentId)
  );
}

/**
 * Closes open transfers and swaps that rest on a duty that changed or on seats that moved.
 * A swap entry for another seat stays open while the offer still has somewhere to go.
 */
export async function closeSeatRequests(
  tx: DbTransaction,
  target: { dutyId?: string; assignmentIds?: string[]; exceptId?: string },
  reason: string
) {
  const seats = new Set(target.assignmentIds ?? []);
  const hit = (dutyId: unknown, assignmentId: unknown) =>
    (target.dutyId !== undefined && dutyId === target.dutyId) ||
    seats.has(String(assignmentId));
  const now = new Date().toISOString();
  for (const row of await openSeatRequests(tx)) {
    if (row.id === target.exceptId) continue;
    const data = row.data;
    const candidates = (data.candidates ?? []) as (SwapEntry & {
      soldierId: string;
    })[];
    const closeAll = () =>
      updateRecord(tx, row, {
        ...data,
        status: "expired",
        candidates: candidates.map((item) =>
          item.status === "pending" ? { ...item, status: "closed" } : item
        ),
        closedAt: now,
        closedReason: reason,
      });
    if (hit(data.dutyId, data.assignmentId)) {
      await closeAll();
      continue;
    }
    if (data.type !== "swap") continue;
    if (data.status === "awaiting_manager") {
      const accepted = candidates.find(
        (item) => item.assignmentId === data.acceptedAssignmentId
      );
      if (accepted && hit(accepted.dutyId, accepted.assignmentId))
        await closeAll();
      continue;
    }
    if (!candidates.some((item) => hit(item.dutyId, item.assignmentId)))
      continue;
    const next = candidates.map((item) =>
      item.status === "pending" && hit(item.dutyId, item.assignmentId)
        ? { ...item, status: "closed" }
        : item
    );
    const pending = next.some((item) => item.status === "pending");
    await updateRecord(tx, row, {
      ...data,
      candidates: next,
      ...(!pending && {
        status: "expired",
        closedAt: now,
        closedReason: reason,
      }),
    });
  }
}
