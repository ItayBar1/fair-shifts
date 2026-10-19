import { and, eq, inArray, sql } from "drizzle-orm";
import { records } from "../schema";
import type { DbTransaction } from "../db";

/**
 * How a soldier's own seat was drawn, in numbers only (decision 240): the
 * seat's value, the minimum among the eligible, the band size, how many were
 * eligible and the soldier's own scheduling score at the draw. No names, no
 * other scores and no reasons leave the server.
 */
export type DrawReceipt = {
  dutyId: string;
  slotId: string;
  weight: number;
  minimum: number;
  bandSize: number;
  eligible: number;
  score: number;
  drawnAt: string;
};

type Candidate = { id?: unknown; score?: unknown; status?: unknown };

/** A seat still held by the soldier: it was not cancelled, moved or swapped away. */
type Seat = {
  dutyId: string;
  slotId: string;
  soldierId: string;
  status: string;
};

export async function ownDrawReceipts(
  tx: DbTransaction,
  soldierId: string | undefined,
  /** The published duties the soldier's read already holds. */
  dutyIds: string[],
  seats: Seat[]
): Promise<DrawReceipt[]> {
  if (!soldierId || !dutyIds.length) return [];
  const held = new Set(
    seats
      .filter(
        (seat) =>
          seat.soldierId === soldierId &&
          ["reserved", "held", "credited"].includes(seat.status)
      )
      .map((seat) => `${seat.dutyId}:${seat.slotId}`)
  );
  if (!held.size) return [];
  const attempts = await tx
    .select()
    .from(records)
    .where(
      and(
        eq(records.kind, "lottery_attempt"),
        sql`${records.data}->>'status' = 'assigned'`,
        sql`${records.data}->>'candidateId' = ${soldierId}`,
        inArray(sql<string>`${records.data}->>'dutyId'`, dutyIds)
      )
    );
  const receipts = new Map<string, DrawReceipt>();
  for (const row of attempts) {
    const data = row.data as Record<string, unknown>;
    const seat = `${String(data.dutyId)}:${String(data.slotId)}`;
    const candidates = Array.isArray(data.candidates)
      ? (data.candidates as Candidate[])
      : [];
    const own = candidates.find((item) => item.id === soldierId);
    if (
      !held.has(seat) ||
      typeof data.weight !== "number" ||
      typeof data.minimum !== "number" ||
      typeof own?.score !== "number"
    )
      continue;
    const receipt: DrawReceipt = {
      dutyId: String(data.dutyId),
      slotId: String(data.slotId),
      weight: data.weight,
      minimum: data.minimum,
      bandSize: Array.isArray(data.band) ? data.band.length : 0,
      eligible: candidates.filter((item) => item.status !== "blocked").length,
      score: own.score,
      drawnAt: row.createdAt.toISOString(),
    };
    // A seat drawn more than once keeps the draw that placed the soldier last.
    const previous = receipts.get(seat);
    if (!previous || previous.drawnAt < receipt.drawnAt)
      receipts.set(seat, receipt);
  }
  return [...receipts.values()];
}
