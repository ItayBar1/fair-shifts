import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import {
  assignments,
  balances,
  duties,
  ledger,
  records,
  soldiers,
} from "./schema";
import { user } from "./auth-schema";
import {
  audit,
  createRecord,
  currentVersion,
  loadDomain,
  manager,
  updateRecord,
  type Actor,
} from "./repository";
import { invariant } from "./errors";
import { id, text } from "./validation";
import { parseMoment } from "./duty-service";
import { postScore, settleDue } from "./scoring";
import { calculatePerformedPrice } from "../domain/pricing";
import { interval, instant } from "../domain/time";
import { evaluateEligibility } from "../domain/eligibility";
import type { Performance } from "../domain/types";
import {
  correctionBarriers,
  correctionEffect,
  type LedgerEvent,
} from "../domain/scoring";

const correctionInput = z.object({
  assignmentId: id,
  performerId: id.optional(),
  start: text,
  end: text,
  startOffset: z.number().optional(),
  endOffset: z.number().optional(),
  points: z.number().int().nonnegative().max(2147483647).optional(),
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
  const input = correctionInput.parse(payload);
  await settleDue(tx);
  const [row] = await tx
    .select()
    .from(assignments)
    .where(eq(assignments.id, input.assignmentId));
  invariant(row, "not_found", "השיבוץ לא נמצא", 404);
  currentVersion(row.version, expectedVersion);
  invariant(
    row.status === "credited",
    "not_credited",
    "ניתן לתקן רק ביצוע שהסתיים ונזקף"
  );
  const [duty] = await tx
    .select()
    .from(duties)
    .where(eq(duties.id, row.dutyId));
  invariant(
    duty?.data.status === "published",
    "not_credited",
    "ניתן לתקן רק ביצוע של תורנות שפורסמה"
  );
  // A seat split between performers is corrected as a whole, so periods never overlap (decision 183).
  const siblings = await tx
    .select({ id: assignments.id, status: assignments.status })
    .from(assignments)
    .where(
      and(
        eq(assignments.dutyId, row.dutyId),
        eq(assignments.slotId, row.slotId)
      )
    );
  invariant(
    !row.data.performedStart &&
      !siblings.some(
        (item) => item.id !== row.id && item.status !== "cancelled"
      ),
    "split_execution",
    "בשיבוץ הזה נרשמו תקופות ביצוע. התיקון נעשה בעריכת תקופות הביצוע של המקום"
  );
  const [credit] = await tx
    .select()
    .from(ledger)
    .where(eq(ledger.sourceKey, `performance:${row.id}`));
  invariant(credit, "not_credited", "הביצוע טרם נזקף");
  const current: Performance = row.data.performance ?? {
    performerId: row.soldierId,
    start: row.data.performedStart ?? duty.data.start,
    end: row.data.performedEnd ?? duty.data.end,
    points: credit.amount,
    reflected: { [row.soldierId]: credit.amount },
    corrections: 0,
  };
  const start = parseMoment(input.start, input.startOffset);
  const end = parseMoment(input.end, input.endOffset);
  interval({ start, end });
  const now = Date.now();
  invariant(
    instant(end).toMillis() <= now,
    "future_performance",
    "מועד הסיום המתוקן עדיין לא הגיע. תיקון עבר חל רק על ביצוע שהסתיים"
  );
  const performerId = input.performerId ?? current.performerId;
  const people = await tx.select().from(soldiers);
  const involved = [
    ...new Set([
      current.performerId,
      performerId,
      ...Object.keys(current.reflected),
    ]),
  ];
  for (const soldierId of involved) {
    const person = people.find((item) => item.id === soldierId);
    invariant(person, "not_found", "חייל לא נמצא", 404);
    invariant(
      !person.deletedAt,
      "deleted_soldier",
      "אחד החיילים בתיקון נמחק. תיקון כזה יטופל במסלול המחיקה"
    );
  }
  const price = calculatePerformedPrice(
    duty.data.pricing,
    [{ start, end }],
    row.data.extraPoints ?? "0"
  );
  const points = input.points ?? price.points;
  invariant(
    performerId !== current.performerId ||
      instant(start).toMillis() !== instant(current.start).toMillis() ||
      instant(end).toMillis() !== instant(current.end).toMillis() ||
      points !== current.points,
    "no_change",
    "לא הוזן שינוי בביצוע"
  );
  const entries = await tx.select().from(ledger);
  const events: LedgerEvent[] = entries.map((entry) => ({
    id: entry.id,
    soldierId: entry.soldierId,
    kind: entry.kind,
    effectiveAt: entry.effectiveAt.toISOString(),
    recordedAt: entry.recordedAt.toISOString(),
    barrier: entry.kind === "normalization" || entry.data.barrier === true,
  }));
  const decisions = (
    await tx.select().from(records).where(eq(records.kind, "score_decision"))
  ).filter(
    (item) =>
      item.data.assignmentId === row.id && item.data.status === "pending"
  );
  const balanceRows = await tx.select().from(balances);
  const effects = involved.flatMap((soldierId) => {
    const before = soldierId === current.performerId ? current.points : 0;
    const after = soldierId === performerId ? points : 0;
    if (before === after) return [];
    const balance = balanceRows.find((item) => item.soldierId === soldierId);
    invariant(balance, "missing_balance", "לא נמצאה יתרת החייל");
    const references = [
      ...(soldierId === current.performerId ? [current.end] : []),
      ...(soldierId === performerId ? [end] : []),
    ].sort((a, b) => instant(a).toMillis() - instant(b).toMillis());
    const barriers = correctionBarriers(soldierId, references[0]!, events);
    const decision = decisions.find((item) => item.subjectId === soldierId);
    const reflected = current.reflected[soldierId] ?? 0;
    const effect = correctionEffect({
      balance: balance.current,
      reflected,
      corrected: after,
      barriers,
      openDecision: Boolean(decision),
    });
    return [
      {
        soldierId,
        name: people.find((item) => item.id === soldierId)!.name,
        historyBefore: before,
        historyAfter: after,
        reflected,
        balance: balance.current,
        balanceVersion: balance.version,
        barriers: barriers.map((barrier) => ({
          ...barrier,
          reason: entries.find((item) => item.id === barrier.id)!.reason,
        })),
        from: references[0]!,
        decisionId: decision?.id,
        decisionVersion: decision?.version,
        ...effect,
      },
    ];
  });
  let findings: { code: string; message: string }[] = [];
  if (performerId !== row.soldierId) {
    const state = await loadDomain(tx);
    const person = state.soldiers.find((item) => item.id === performerId)!;
    const slot = duty.data.slots.find((item) => item.id === row.slotId);
    if (slot) {
      const result = evaluateEligibility(
        person,
        { ...duty.data, id: duty.id, version: duty.version, start, end },
        slot,
        {
          duties: state.duties,
          assignments: state.assignments,
          mode: "manual",
          ignoreAssignmentIds: [row.id],
        }
      );
      findings = [...result.blockers, ...result.approvalsRequired].map(
        (reason) => ({ code: reason.code, message: reason.message })
      );
    }
  }
  const proposed = { performerId, start, end, points };
  const token = createHash("sha256")
    .update(
      JSON.stringify({
        version: row.version,
        input: { ...input, token: undefined },
        proposed,
        effects: effects.map((effect) => [
          effect.soldierId,
          effect.status,
          effect.balanceVersion,
          effect.decisionVersion ?? null,
          effect.barriers.map((barrier) => barrier.id),
        ]),
      })
    )
    .digest("hex");
  return {
    input,
    row,
    duty,
    current,
    proposed,
    price,
    manual: input.points !== undefined,
    effects,
    findings,
    token,
  };
}

function view(result: Awaited<ReturnType<typeof plan>>) {
  const { current, proposed, price, manual, effects, findings, token, row } =
    result;
  return {
    token,
    assignmentId: row.id,
    version: row.version,
    drawPoints: row.points,
    current: { ...current, reflected: undefined },
    proposed,
    price,
    computedPoints: price.points,
    manual,
    effects: effects.map((effect) => ({
      ...effect,
      balanceVersion: undefined,
      decisionVersion: undefined,
      from: undefined,
    })),
    findings,
  };
}

export async function previewPerformanceCorrection(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  return view(await plan(tx, actor, payload, expectedVersion));
}

export async function applyPerformanceCorrection(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  const result = await plan(tx, actor, payload, expectedVersion);
  const { input, row, duty, current, proposed, effects } = result;
  invariant(
    input.token === result.token,
    "stale_preview",
    "נתוני הביצוע או היתרות השתנו מאז התצוגה המקדימה. יש לבדוק שוב",
    409
  );
  const correctionId = randomUUID();
  const reflected = { ...current.reflected };
  const outcomes: Record<string, unknown>[] = [];
  for (const effect of effects) {
    if (effect.status === "automatic") {
      const entry = await postScore(tx, {
        soldierId: effect.soldierId,
        sourceKey: `correction:${correctionId}:${effect.soldierId}`,
        kind: "correction",
        actorId: actor.id,
        reason: input.reason,
        effectiveAt: new Date(),
        amount: effect.delta,
        data: {
          assignmentId: row.id,
          dutyId: duty.id,
          correctionId,
          performedEnd: effect.historyAfter ? proposed.end : current.end,
          historyBefore: effect.historyBefore,
          historyAfter: effect.historyAfter,
          barrier: effect.clamped,
        },
      });
      reflected[effect.soldierId] = effect.historyAfter;
      outcomes.push({
        soldierId: effect.soldierId,
        status: "applied",
        ledgerId: entry.id,
        amount: entry.amount,
        clamped: effect.clamped,
      });
      continue;
    }
    const existing = effect.decisionId
      ? (
          await tx
            .select()
            .from(records)
            .where(eq(records.id, effect.decisionId))
        )[0]
      : undefined;
    const earlier = existing ? String(existing.data.from ?? effect.from) : "";
    const decision = {
      assignmentId: row.id,
      dutyId: duty.id,
      soldierId: effect.soldierId,
      status: "pending",
      historyPoints: effect.historyAfter,
      reflectedPoints: effect.reflected,
      rawDelta: effect.rawDelta,
      barrierIds: effect.barriers.map((barrier) => barrier.id),
      // Barriers are searched from the earliest performance end any merged correction touched.
      from:
        earlier && instant(earlier).toMillis() < instant(effect.from).toMillis()
          ? earlier
          : effect.from,
      reason: input.reason,
    };
    const saved = existing
      ? await updateRecord(tx, existing, {
          ...decision,
          correctionIds: [
            ...((existing.data.correctionIds as string[]) ?? []),
            correctionId,
          ],
          createdBy: existing.data.createdBy,
          updatedBy: actor.id,
        })
      : await createRecord(
          tx,
          "score_decision",
          { ...decision, correctionIds: [correctionId], createdBy: actor.id },
          effect.soldierId
        );
    outcomes.push({
      soldierId: effect.soldierId,
      status: "decision_required",
      decisionId: saved.id,
    });
  }
  for (const [soldierId, value] of Object.entries(reflected))
    if (value === 0 && soldierId !== proposed.performerId)
      delete reflected[soldierId];
  const performance: Performance = {
    ...proposed,
    reflected,
    corrections: current.corrections + 1,
  };
  const version = row.version + 1;
  const [updated] = await tx
    .update(assignments)
    .set({
      version,
      data: { ...row.data, version, performance },
      updatedAt: new Date(),
    })
    .where(
      and(eq(assignments.id, row.id), eq(assignments.version, row.version))
    )
    .returning();
  invariant(updated, "stale_version", "המידע השתנה בזמן השמירה", 409);
  await tx.insert(records).values({
    id: correctionId,
    kind: "performance_correction",
    subjectId: row.soldierId,
    data: {
      assignmentId: row.id,
      dutyId: duty.id,
      drawPoints: row.points,
      before: { ...current, reflected: undefined },
      after: proposed,
      manual: result.manual,
      computedPoints: result.price.points,
      findings: result.findings,
      outcomes,
      reason: input.reason,
      actorId: actor.id,
      actorName: actor.name,
      recordedAt: new Date().toISOString(),
    },
  });
  await audit(tx, actor, "performance.correct", row.id, {
    dutyId: duty.id,
    correctionId,
  });
  if (outcomes.some((outcome) => outcome.status === "decision_required")) {
    const managers = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.role, "manager"));
    for (const account of managers)
      await createRecord(tx, "notification", {
        accountId: account.id,
        title: "תיקון ביצוע ממתין להכרעת ניקוד",
        body: `ההיסטוריה של ${duty.name} תוקנה. יש להחליט אם ובכמה לשנות את היתרה כיום.`,
        href: "/manage",
      });
  }
  return { id: correctionId, version, outcomes };
}
