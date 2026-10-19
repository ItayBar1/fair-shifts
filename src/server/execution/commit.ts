import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { assignments, duties, records } from "../schema";
import { audit, createRecord, updateRecord, type Actor } from "../repository";
import { AppError, invariant } from "../errors";
import { postScore } from "../scoring";
import { closeSeatRequests, notifySoldier } from "../seat-requests";
import { cancelStaleDutyReminders } from "../duty-reminder-checks";
import { instant } from "../../domain/time";
import type { Assignment, Duty, Performance } from "../../domain/types";
import { ACTIVE, type Change, type SeatRow, display } from "./model";
import { type ExecutionPlan, approvalsOf } from "./plan";
import { currentPerformance } from "./seats";

/**
 * Writes a plan in one transaction: open periods keep a stored value in proportion to
 * their time, ended periods are credited once, and credited periods change through the
 * correction rules or wait for a manager's decision (decisions 161, 168, 183).
 */
export async function commitExecution(
  tx: DbTransaction,
  actor: Actor,
  plan: ExecutionPlan,
  input: {
    reason: string;
    mode: "manual" | "volunteer";
    approvalKeys: string[];
    approvalReason?: string;
    reviewPending?: boolean;
    requestId?: string;
  }
) {
  const { duty, slot, changes, state } = plan;
  invariant(
    !plan.allocationRequired || plan.allocationExplicit,
    "allocation_required",
    "יש לקבוע במפורש חלוקת בסיס ותוספת קבועה לכל מבצע לפני אישור",
    422
  );
  const executionId = randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const outcomes: Record<string, unknown>[] = [];
  const touched: string[] = [];
  const affected = new Map<string, string>();
  const decidedBy = (change: Change) => {
    const person = state.soldiers.find((row) => row.id === change.soldierId);
    return person?.deletedAt &&
      change.row &&
      ACTIVE.includes(change.row.status) &&
      !change.row.deletionDecidedAt
      ? {
          deletionDecidedAt: nowIso,
          deletionDecidedBy: actor.id,
          // The seat has been handled; the flag of the deletion goes with it.
          needsAttention: [],
        }
      : {};
  };
  for (const change of changes) {
    if (change.kind === "keep") {
      // Confirming a deleted soldier's period as recorded is also the manager's decision.
      const decided = decidedBy(change);
      if (decided.deletionDecidedAt)
        await writeRow(tx, change.row!, { data: decided });
      continue;
    }
    const approvals = approvalsOf(
      plan,
      actor,
      change,
      input.approvalKeys,
      input.approvalReason,
      input.mode
    );
    const row = change.row;
    if (row) touched.push(row.id);
    const period = change.to;
    if (change.kind === "cancel") {
      await writeRow(tx, row!, {
        status: "cancelled",
        data: {
          endedBy: { kind: "execution", executionId, actorId: actor.id },
        },
      });
      affected.set(
        change.soldierId,
        `האחראי רשם שאינך מבצע את התורנות ${duty.name}. השיבוץ שלך בה בוטל.`
      );
      outcomes.push({ soldierId: change.soldierId, kind: "cancel" });
      continue;
    }
    if (change.kind === "update") {
      await writeRow(tx, row!, {
        points: change.price!.points,
        data: {
          originalPoints: row!.originalPoints ?? row!.points,
          performedStart: period!.start,
          performedEnd: period!.end,
          extraPoints: change.allocation!.fixedExtra,
          ...(duty.pricing.mode === "fixed" && {
            fixedBaseAllocation: change.allocation!.fixedBase,
          }),
          approvals: [...(row!.approvals ?? []), ...approvals],
          executionId,
          ...decidedBy(change),
        },
      });
      if (approvals.length)
        await createRecord(
          tx,
          "assignment_approval",
          { assignmentId: row!.id, approvals },
          change.soldierId
        );
      affected.set(
        change.soldierId,
        `תקופת הביצוע שלך בתורנות ${duty.name}: ${display(period!.start)} עד ${display(period!.end)}, ${change.price!.points} נקודות.`
      );
      outcomes.push({
        soldierId: change.soldierId,
        kind: "update",
        points: change.price!.points,
      });
      continue;
    }
    if (change.kind === "create") {
      const created: Assignment & { executionId: string } = {
        id: change.rowId,
        dutyId: duty.id,
        slotId: slot.id,
        soldierId: change.soldierId,
        points: change.price!.points,
        status: "reserved",
        version: 1,
        ...(duty.pricing.mode === "fixed" && {
          fixedBaseAllocation: change.allocation!.fixedBase,
        }),
        extraPoints: change.allocation!.fixedExtra,
        approvals,
        pendingReviewConfirmed: input.reviewPending,
        performedStart: period!.start,
        performedEnd: period!.end,
        executionId,
      };
      await tx.insert(assignments).values({ ...created, data: created });
      if (approvals.length)
        await createRecord(
          tx,
          "assignment_approval",
          { assignmentId: created.id, approvals },
          change.soldierId
        );
      affected.set(
        change.soldierId,
        `נרשמת כמבצע בתורנות ${duty.name} מ־${display(period!.start)} עד ${display(period!.end)}, ${change.price!.points} נקודות.`
      );
      outcomes.push({
        soldierId: change.soldierId,
        kind: "create",
        points: change.price!.points,
      });
      continue;
    }
    // late, correct and remove reach the balance now or wait for a manager's decision.
    const effect = change.effect!;
    const credited = row?.status === "credited";
    const previous = credited
      ? currentPerformance(row!, duty, plan.credits)
      : undefined;
    const reflected = { ...(previous?.reflected ?? {}) };
    let ledgerId: string | undefined;
    if (effect.status === "automatic") {
      const entry =
        change.kind === "late"
          ? await postScore(tx, {
              soldierId: change.soldierId,
              sourceKey: `performance:${change.rowId}`,
              kind: "performance",
              actorId: actor.id,
              reason: `ביצוע ${duty.name}`,
              effectiveAt: new Date(period!.end),
              amount: effect.historyAfter,
              data: {
                assignmentId: change.rowId,
                dutyId: duty.id,
                executionId,
                originalPoints: effect.historyAfter,
              },
            })
          : await postScore(tx, {
              soldierId: change.soldierId,
              sourceKey: `execution:${executionId}:${change.soldierId}`,
              kind: "correction",
              actorId: actor.id,
              reason: input.reason,
              effectiveAt: now,
              amount: effect.delta!,
              data: {
                assignmentId: change.rowId,
                dutyId: duty.id,
                executionId,
                performedEnd: period?.end ?? previous!.end,
                historyBefore: effect.historyBefore,
                historyAfter: effect.historyAfter,
                barrier: effect.clamped,
              },
            });
      ledgerId = entry.id;
      reflected[change.soldierId] = effect.historyAfter;
    } else {
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
        assignmentId: change.rowId,
        dutyId: duty.id,
        soldierId: change.soldierId,
        status: "pending",
        historyPoints: effect.historyAfter,
        reflectedPoints: effect.reflected,
        rawDelta: effect.rawDelta,
        barrierIds: effect.barrierIds,
        from:
          earlier &&
          instant(earlier).toMillis() < instant(effect.from).toMillis()
            ? earlier
            : effect.from,
        reason: input.reason,
        executionIds: [
          ...((existing?.data.executionIds as string[]) ?? []),
          executionId,
        ],
      };
      const saved = existing
        ? await updateRecord(tx, existing, {
            ...existing.data,
            ...decision,
            updatedBy: actor.id,
          })
        : await createRecord(
            tx,
            "score_decision",
            { ...decision, correctionIds: [], createdBy: actor.id },
            change.soldierId
          );
      outcomes.push({
        soldierId: change.soldierId,
        kind: change.kind,
        status: "decision_required",
        decisionId: saved.id,
      });
      reflected[change.soldierId] = effect.reflected;
    }
    if (ledgerId)
      outcomes.push({
        soldierId: change.soldierId,
        kind: change.kind,
        status: "applied",
        ledgerId,
        amount: change.kind === "late" ? effect.historyAfter : effect.delta,
        clamped: effect.clamped,
      });
    for (const [soldierId, value] of Object.entries(reflected))
      if (value === 0 && soldierId !== change.soldierId)
        delete reflected[soldierId];
    const performance: Performance = {
      performerId: change.soldierId,
      start: period?.start ?? previous!.start,
      end: period?.end ?? previous!.end,
      points: effect.historyAfter,
      reflected,
      corrections: (previous?.corrections ?? 0) + (credited ? 1 : 0),
      ...(change.kind === "remove" && { removed: true }),
    };
    const fields = {
      ...(row && { originalPoints: row.originalPoints ?? row.points }),
      performedStart: performance.start,
      performedEnd: performance.end,
      extraPoints:
        change.kind === "remove" ? "0" : change.allocation!.fixedExtra,
      ...(duty.pricing.mode === "fixed" &&
        change.kind !== "remove" && {
          fixedBaseAllocation: change.allocation!.fixedBase,
        }),
      performance,
      executionId,
      creditedAt: row?.creditedAt ?? nowIso,
      ...decidedBy(change),
    };
    if (row)
      await writeRow(tx, row, {
        status: change.kind === "remove" ? "cancelled" : "credited",
        ...(change.kind !== "remove" && !credited
          ? { points: change.price!.points }
          : {}),
        data: {
          ...fields,
          ...(approvals.length && {
            approvals: [...(row.approvals ?? []), ...approvals],
          }),
          ...(change.kind === "remove" && {
            endedBy: { kind: "execution", executionId, actorId: actor.id },
          }),
        },
      });
    else {
      const created: Assignment & Record<string, unknown> = {
        id: change.rowId,
        dutyId: duty.id,
        slotId: slot.id,
        soldierId: change.soldierId,
        points: change.price!.points,
        status: "credited",
        version: 1,
        approvals,
        ...fields,
      };
      await tx
        .insert(assignments)
        .values({ ...created, status: "credited", data: created });
    }
    affected.set(
      change.soldierId,
      change.kind === "remove"
        ? `האחראי רשם שלא ביצעת את התורנות ${duty.name}.`
        : `נרשם ביצוע שלך בתורנות ${duty.name}: ${display(period!.start)} עד ${display(period!.end)}, ${effect.historyAfter} נקודות.`
    );
  }
  const notPerformed = plan.proposed
    .filter((segment) => segment.soldierId === null)
    .map((segment) => ({ start: segment.start, end: segment.end }));
  const seatData = {
    dutyId: duty.id,
    slotId: slot.id,
    notPerformed,
    fixedExtraTotal: plan.extraTotal,
    executionIds: [
      ...((plan.seatRecord?.data.executionIds as string[]) ?? []),
      executionId,
    ],
    updatedBy: actor.id,
    updatedAt: nowIso,
  };
  if (plan.seatRecord) await updateRecord(tx, plan.seatRecord, seatData);
  else await createRecord(tx, "seat_execution", seatData);
  const role = slot.role;
  const subject =
    plan.current.find((segment) => segment.soldierId)?.soldierId ??
    plan.proposed.find((segment) => segment.soldierId)?.soldierId ??
    undefined;
  await createRecord(
    tx,
    "execution_change",
    {
      dutyId: duty.id,
      slotId: slot.id,
      dutyName: duty.name,
      role,
      before: plan.current.map(({ soldierId, start, end, credited }) => ({
        soldierId,
        start,
        end,
        credited,
      })),
      after: plan.proposed,
      allocationBefore: plan.rows.map((row) => ({
        soldierId: row.soldierId,
        fixedBase: row.fixedBaseAllocation,
        fixedExtra: row.extraPoints ?? "0",
      })),
      allocationAfter: plan.allocation,
      fixedExtraTotal: plan.extraTotal,
      prices: changes
        .filter((change) => change.price)
        .map((change) => ({
          soldierId: change.soldierId,
          start: change.to!.start,
          end: change.to!.end,
          price: change.price,
        })),
      findings: changes
        .filter((change) => change.findings.length)
        .map((change) => ({
          soldierId: change.soldierId,
          findings: change.findings,
        })),
      outcomes,
      reason: input.reason,
      requestId: input.requestId,
      actorId: actor.id,
      actorName: actor.name,
      recordedAt: nowIso,
    },
    subject,
    { id: executionId }
  );
  const [bumped] = await tx
    .update(duties)
    .set({
      version: duty.version + 1,
      data: {
        ...duty,
        rulesVersion: duty.rulesVersion ?? duty.version,
        version: duty.version + 1,
      } as Duty & { name: string; location: string; instructions: string },
      updatedAt: now,
    })
    .where(and(eq(duties.id, duty.id), eq(duties.version, duty.version)))
    .returning();
  invariant(bumped, "stale_version", "התורנות השתנתה בזמן השמירה", 409);
  // Offers that rested on a period that changed can no longer complete as offered.
  if (touched.length)
    await closeSeatRequests(
      tx,
      { assignmentIds: touched, exceptId: input.requestId },
      "תקופת הביצוע של השיבוץ השתנתה"
    );
  await markReferralsHandled(tx, plan, executionId);
  await cancelStaleDutyReminders(tx, duty.id);
  const expiresAt = instant(duty.end).toMillis() + 86_400_000;
  for (const [soldierId, body] of affected)
    if (!state.soldiers.find((row) => row.id === soldierId)?.deletedAt)
      await notifySoldier(tx, soldierId, {
        event: "execution",
        requestId: executionId,
        title: "עדכון בביצוע תורנות",
        body,
        email: true,
        expiresAt,
        scope: "execution",
        href: `/duties/${duty.id}`,
      });
  await audit(tx, actor, "execution.save", executionId, {
    dutyId: duty.id,
    slotId: slot.id,
    recordId: executionId,
  });
  return { id: executionId, outcomes };
}

async function writeRow(
  tx: DbTransaction,
  row: SeatRow,
  change: {
    status?: string;
    points?: number;
    data: Record<string, unknown>;
  }
) {
  const version = row.version + 1;
  const status = change.status ?? row.status;
  const points = change.points ?? row.points;
  const [updated] = await tx
    .update(assignments)
    .set({
      status,
      points,
      version,
      data: {
        ...row,
        ...change.data,
        status,
        points,
        version,
      } as Assignment,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(assignments.id, row.id),
        eq(assignments.version, row.version),
        eq(assignments.status, row.status)
      )
    )
    .returning();
  if (!updated)
    throw new AppError("stale_version", "השיבוץ השתנה בזמן השמירה", 409);
}

/** A cancellation request referred to execution handling leaves the queue once its seat is recorded. */
async function markReferralsHandled(
  tx: DbTransaction,
  plan: ExecutionPlan,
  executionId: string
) {
  const seatIds = new Set(plan.rows.map((row) => row.id));
  const referred = (
    await tx.select().from(records).where(eq(records.kind, "request"))
  ).filter(
    (row) =>
      row.data.type === "cancellation" &&
      row.data.status === "referred" &&
      !row.data.executionId &&
      seatIds.has(String(row.data.assignmentId))
  );
  for (const row of referred)
    await updateRecord(tx, row, {
      ...row.data,
      executionId,
      executionHandledAt: new Date().toISOString(),
    });
}
