import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { assignments, balances, duties, ledger, soldiers } from "./schema";
import {
  audit,
  currentVersion,
  findRecord,
  manager,
  updateRecord,
  type Actor,
} from "./repository";
import { invariant } from "./errors";
import { id, text } from "./validation";
import { postScore, settleDue } from "./scoring";
import type { Performance } from "../domain/types";
import {
  barrierLabel,
  correctionBarriers,
  correctionDecision,
} from "../domain/scoring";

/** Operations since `from` that change the meaning of a correction delta, in effective order with their recording time. */
export function interveningActions(
  soldierId: string,
  from: string,
  entries: (typeof ledger.$inferSelect)[]
) {
  return correctionBarriers(
    soldierId,
    from,
    entries.map((entry) => ({
      id: entry.id,
      soldierId: entry.soldierId,
      kind: entry.kind,
      effectiveAt: entry.effectiveAt.toISOString(),
      recordedAt: entry.recordedAt.toISOString(),
      barrier: entry.kind === "normalization" || entry.data.barrier === true,
    }))
  ).map((barrier) => {
    const entry = entries.find((item) => item.id === barrier.id)!;
    return {
      id: entry.id,
      label: barrierLabel(entry.kind, entry.data),
      effectiveAt: barrier.effectiveAt,
      recordedAt: barrier.recordedAt,
      before: entry.before,
      after: entry.after,
      reason: entry.reason,
    };
  });
}

const decisionInput = z.object({
  decisionId: id,
  choice: z.enum(["keep", "adjust", "set"]),
  value: z.number().int().min(-2147483647).max(2147483647).optional(),
  reason: text,
  token: z.string().max(128).optional(),
});

async function plan(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = decisionInput.parse(payload);
  await settleDue(tx);
  const decision = await findRecord(tx, "score_decision", input.decisionId);
  invariant(
    decision.data.status === "pending",
    "already_decided",
    `ההחלטה כבר הוכרעה בידי ${String(decision.data.decidedByName ?? "אחראי אחר")}`,
    409
  );
  currentVersion(decision.version, expectedVersion);
  const soldierId = String(decision.data.soldierId);
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, soldierId));
  invariant(person, "not_found", "חייל לא נמצא", 404);
  invariant(
    !person.deletedAt,
    "deleted_soldier",
    "החשבון נמחק. הכרעה כזו תטופל במסלול המחיקה"
  );
  const [balance] = await tx
    .select()
    .from(balances)
    .where(eq(balances.soldierId, soldierId));
  invariant(balance, "missing_balance", "לא נמצאה יתרת החייל");
  const [row] = await tx
    .select()
    .from(assignments)
    .where(eq(assignments.id, String(decision.data.assignmentId)));
  invariant(row?.data.performance, "not_found", "הביצוע לא נמצא", 404);
  const [duty] = await tx
    .select()
    .from(duties)
    .where(eq(duties.id, row.dutyId));
  invariant(duty, "not_found", "התורנות לא נמצאה", 404);
  const performance: Performance = row.data.performance;
  const [credit] = await tx
    .select()
    .from(ledger)
    .where(eq(ledger.sourceKey, `performance:${row.id}`));
  const entries = await tx
    .select()
    .from(ledger)
    .where(eq(ledger.soldierId, soldierId));
  const barriers = interveningActions(
    soldierId,
    String(decision.data.from ?? performance.end),
    entries
  );
  let outcome: ReturnType<typeof correctionDecision>;
  try {
    outcome = correctionDecision({
      balance: balance.current,
      choice: input.choice,
      value: input.value,
    });
  } catch (error) {
    invariant(false, "invalid_decision", (error as Error).message);
  }
  invariant(
    input.choice === "keep" || outcome.after !== balance.current,
    "no_change",
    "הבחירה אינה משנה את היתרה. כדי להשאיר אותה יש לבחור ״לא לשנות״"
  );
  invariant(
    outcome.after <= 2147483647,
    "invalid_score",
    "הניקוד חורג מהטווח הנתמך"
  );
  const token = createHash("sha256")
    .update(
      JSON.stringify({
        decision: decision.version,
        balance: balance.version,
        input: { ...input, token: undefined },
        after: outcome.after,
        barriers: barriers.map((barrier) => barrier.id),
      })
    )
    .digest("hex");
  return {
    input,
    decision,
    row,
    duty,
    performance,
    balance,
    outcome,
    view: {
      token,
      decisionId: decision.id,
      version: decision.version,
      soldierId,
      name: person.name,
      duty: { id: duty.id, name: duty.name },
      drawPoints: row.points,
      performance: {
        performerId: performance.performerId,
        start: performance.start,
        end: performance.end,
        points: performance.points,
        creditedAt: credit?.recordedAt.toISOString(),
      },
      historyPoints: Number(decision.data.historyPoints),
      reflectedPoints: Number(decision.data.reflectedPoints),
      historyDelta:
        Number(decision.data.historyPoints) -
        Number(decision.data.reflectedPoints),
      barriers,
      balance: balance.current,
      choice: input.choice,
      after: outcome.after,
      delta: outcome.delta,
      clamped: outcome.clamped,
    },
  };
}

export async function previewScoreDecision(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  return (await plan(tx, actor, payload, expectedVersion)).view;
}

/**
 * Closes a pending correction decision exactly once. Either choice settles the history the manager
 * saw, so a later correction of the same performance only weighs the new difference.
 */
export async function applyScoreDecision(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const { input, decision, row, duty, performance, balance, outcome, view } =
    await plan(tx, actor, payload, expectedVersion);
  invariant(
    input.token === view.token,
    "stale_preview",
    "היתרה, הפעולות המתערבות או ההחלטה השתנו מאז התצוגה המקדימה. יש לבדוק שוב",
    409
  );
  const decidedAt = new Date();
  const entry =
    input.choice === "keep"
      ? undefined
      : await postScore(tx, {
          soldierId: view.soldierId,
          sourceKey: `score_decision:${decision.id}`,
          kind: "correction_decision",
          actorId: actor.id,
          reason: input.reason,
          effectiveAt: decidedAt,
          absolute: outcome.after,
          data: {
            assignmentId: row.id,
            dutyId: duty.id,
            decisionId: decision.id,
            choice: input.choice,
            value: input.value,
            performedEnd: performance.end,
            barrier: outcome.barrier,
          },
        });
  const saved = await updateRecord(tx, decision, {
    ...decision.data,
    status: "decided",
    resolution: {
      choice: input.choice,
      value: input.value,
      balanceBefore: balance.current,
      balanceAfter: outcome.after,
      clamped: outcome.clamped,
      ledgerId: entry?.id,
      barriers: view.barriers,
      reason: input.reason,
    },
    decidedBy: actor.id,
    decidedByName: actor.name,
    decidedAt: decidedAt.toISOString(),
  });
  const reflected = {
    ...performance.reflected,
    [view.soldierId]: view.historyPoints,
  };
  if (
    reflected[view.soldierId] === 0 &&
    view.soldierId !== performance.performerId
  )
    delete reflected[view.soldierId];
  const version = row.version + 1;
  const [updated] = await tx
    .update(assignments)
    .set({
      version,
      data: {
        ...row.data,
        version,
        performance: { ...performance, reflected },
      },
      updatedAt: decidedAt,
    })
    .where(
      and(eq(assignments.id, row.id), eq(assignments.version, row.version))
    )
    .returning();
  invariant(updated, "stale_version", "המידע השתנה בזמן השמירה", 409);
  await audit(
    tx,
    actor,
    "score.decision",
    decision.id,
    {
      assignmentId: row.id,
      dutyId: duty.id,
      choice: input.choice,
      before: balance.current,
      after: outcome.after,
    },
    view.soldierId
  );
  return {
    id: decision.id,
    version: saved.version,
    status: "decided",
    balance: outcome.after,
    decidedAt: decidedAt.toISOString(),
  };
}
