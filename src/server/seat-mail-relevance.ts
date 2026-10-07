import { and, eq, inArray } from "drizzle-orm";
import type { DbTransaction } from "./db";
import { emailOutbox, user } from "./auth-schema";
import { records } from "./schema";

type Mail = typeof emailOutbox.$inferSelect;

/** Event and recipient matter: a completed offer has valid completion mail. */
export async function seatRequestMailRelevant(
  tx: DbTransaction,
  message: Mail,
  recipient: typeof user.$inferSelect
) {
  if (
    !message.requestId ||
    !["transfer", "swap"].includes(message.requestScope ?? "")
  )
    return true;
  const [request] = await tx
    .select()
    .from(records)
    .where(and(eq(records.id, message.requestId), eq(records.kind, "request")));
  if (
    !request ||
    request.data.type !== message.requestScope ||
    !recipient.soldierId
  )
    return false;
  const data = request.data;
  const event = message.requestEvent;
  const participants = [data.fromSoldierId, data.acceptedBy];
  if (event === "offer") {
    const candidates = data.candidates as {
      soldierId: string;
      status: string;
    }[];
    return (
      data.status === "awaiting_consent" &&
      candidates.some(
        (candidate) =>
          candidate.soldierId === recipient.soldierId &&
          candidate.status === "pending"
      )
    );
  }
  if (!participants.includes(recipient.soldierId)) return false;
  if (event === "awaiting-manager") return data.status === "awaiting_manager";
  if (event === "completed") return data.status === "completed";
  if (event === "rejected") return data.status === "manager_rejected";
  if (event === "withdrawn") return data.status === "cancelled";
  if (event?.startsWith("decline:"))
    return (
      data.status === "declined" && data.fromSoldierId === recipient.soldierId
    );
  return false;
}

/** The request update and cancellation commit together; budget is never refunded. */
export async function cancelObsoleteSeatRequestMail(
  tx: DbTransaction,
  requestId: string
) {
  const pending = await tx
    .select()
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.requestId, requestId),
        inArray(emailOutbox.status, ["pending", "sending"])
      )
    )
    .for("update");
  for (const message of pending) {
    const [recipient] = await tx
      .select()
      .from(user)
      .where(eq(user.id, message.recipientAccountId));
    if (recipient && (await seatRequestMailRelevant(tx, message, recipient)))
      continue;
    await tx
      .update(emailOutbox)
      .set({
        status: "cancelled",
        error: "not_relevant",
        title: "",
        body: "",
        href: null,
        encryptedSecret: null,
        destination: null,
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(emailOutbox.id, message.id));
  }
}
