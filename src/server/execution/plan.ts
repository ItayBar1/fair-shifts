import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import type { DbTransaction } from "../db";
import { balances, ledger, records } from "../schema";
import { loadDomain, type Actor } from "../repository";
import { AppError, invariant } from "../errors";
import { settleDue } from "../scoring";
import { evaluateEligibility } from "../../domain/eligibility";
import {
  executionPeriod,
  normalizeSegments,
  samePeriod,
  within,
  type ExecutionSegment,
} from "../../domain/execution";
import {
  correctionBarriers,
  correctionEffect,
  type LedgerEvent,
} from "../../domain/scoring";
import { instant } from "../../domain/time";
import { priceSplitExecution } from "../../domain/pricing";
import type { PriceBreakdown, SpecificApproval } from "../../domain/types";
import {
  MANUAL_EXCEPTIONS,
  VOLUNTEER_EXCEPTIONS,
  segmentApprovalKey,
} from "./inputs";
import {
  type Change,
  type ExecutionPlanOptions,
  type SeatRow,
  range,
} from "./model";
import {
  allocationDraft,
  currentPerformance,
  fixedExtraTotal,
  seatRecordOf,
  seatSegments,
} from "./seats";

/**
 * Plans a complete set of execution periods for one seat. Nothing is written: the plan
 * lists what happens to each performer, the value of each period, the eligibility of
 * everyone who covers new time, and how credited periods reach the balances.
 */
export async function planExecution(
  tx: DbTransaction,
  params: {
    dutyId: string;
    slotId: string;
    segments: ExecutionSegment[];
  } & ExecutionPlanOptions
) {
  await settleDue(tx);
  const state = await loadDomain(tx);
  const now = Date.now();
  const duty = state.duties.find((row) => row.id === params.dutyId);
  invariant(duty, "not_found", "התורנות לא נמצאה", 404);
  invariant(
    duty.status === "published",
    "not_published",
    "תקופות ביצוע נרשמות רק לתורנות שפורסמה"
  );
  invariant(
    instant(duty.start).toMillis() <= now,
    "not_started",
    "התורנות טרם התחילה. לפני ההתחלה משנים את השיבוץ דרך ״עדכן ופרסם״ או העברה"
  );
  const slot = duty.slots.find((row) => row.id === params.slotId);
  invariant(slot, "not_found", "המקום לא נמצא בתורנות", 404);
  const seatRecord = await seatRecordOf(tx, duty.id, slot.id);
  const { rows, segments: current } = seatSegments(
    state,
    duty,
    slot.id,
    seatRecord
  );
  let proposed: ExecutionSegment[];
  try {
    proposed = normalizeSegments(duty, params.segments);
  } catch (error) {
    throw new AppError(
      "invalid_segments",
      error instanceof Error ? error.message : "תקופות הביצוע אינן תקינות",
      422
    );
  }
  const byPerformer = new Map<string, SeatRow>();
  for (const row of rows) {
    const performer = row.performance?.performerId ?? row.soldierId;
    invariant(
      !byPerformer.has(performer),
      "inconsistent_seat",
      "לאותו חייל יש שתי רשומות במקום הזה. יש לפנות לתמיכה לפני עריכה",
      409
    );
    byPerformer.set(performer, row);
  }
  const credits = new Map(
    (
      await tx
        .select()
        .from(ledger)
        .where(
          inArray(
            ledger.sourceKey,
            rows.length
              ? rows.map((row) => `performance:${row.id}`)
              : ["performance:none"]
          )
        )
    ).map((entry) => [String(entry.data.assignmentId), entry.amount])
  );
  const nameOf = (soldierId: string) =>
    state.soldiers.find((row) => row.id === soldierId)?.name ?? "חייל";
  const changes: Change[] = [];
  const target = new Map(
    proposed.flatMap((segment) =>
      segment.soldierId ? [[segment.soldierId, segment] as const] : []
    )
  );
  const extraTotal = fixedExtraTotal(rows, seatRecord);
  const allocationRequired =
    target.size > 1 &&
    (duty.pricing.mode === "fixed" || new Decimal(extraTotal).gt(0));
  const allocation =
    params.allocations ??
    allocationDraft(duty, target, byPerformer, extraTotal);
  invariant(
    allocation.length === target.size &&
      new Set(allocation.map((item) => item.soldierId)).size === target.size &&
      allocation.every((item) => target.has(item.soldierId)),
    "invalid_allocation",
    "נדרשת חלוקה אחת לכל מבצע בפועל",
    422
  );
  let priced: { soldierId: string; price: PriceBreakdown }[];
  try {
    priced = target.size
      ? priceSplitExecution(
          duty.pricing,
          duty,
          allocation.map((item) => ({
            ...item,
            periods: [target.get(item.soldierId)!],
          })),
          extraTotal
        )
      : [];
  } catch (error) {
    throw new AppError(
      "invalid_allocation",
      error instanceof Error ? error.message : "חלוקת הניקוד אינה תקינה",
      422
    );
  }
  const priceOf = new Map(priced.map((item) => [item.soldierId, item.price]));
  const allocationOf = new Map(
    allocation.map((item) => [item.soldierId, item])
  );
  for (const [soldierId, row] of byPerformer) {
    const from = executionPeriod(row, duty);
    const to = target.get(soldierId);
    const credited = row.status === "credited";
    const base = {
      soldierId,
      name: nameOf(soldierId),
      row,
      rowId: row.id,
      from: range(from),
      pointsBefore: credited
        ? currentPerformance(row, duty, credits).points
        : row.points,
      findings: [],
    };
    if (!to) {
      changes.push({ ...base, kind: credited ? "remove" : "cancel" });
      continue;
    }
    const period = range(to);
    const price = priceOf.get(soldierId)!;
    const share = allocationOf.get(soldierId)!;
    const beforeBase = row.fixedBaseAllocation ?? duty.pricing.basePoints;
    const unchanged =
      samePeriod(from, period) &&
      (credited
        ? currentPerformance(row, duty, credits).points
        : row.points) === price.points &&
      new Decimal(row.extraPoints || "0").eq(share.fixedExtra) &&
      (duty.pricing.mode !== "fixed" ||
        new Decimal(beforeBase).eq(share.fixedBase!));
    if (credited) {
      changes.push({
        ...base,
        kind: unchanged ? "keep" : "correct",
        to: period,
        allocation: share,
        ...(!unchanged && { price }),
      });
      continue;
    }
    const due = instant(period.end).toMillis() <= now;
    changes.push({
      ...base,
      kind: due ? "late" : unchanged ? "keep" : "update",
      to: period,
      price,
      allocation: share,
    });
  }
  for (const [soldierId, segment] of target) {
    if (byPerformer.has(soldierId)) continue;
    const person = state.soldiers.find((row) => row.id === soldierId);
    invariant(person, "not_found", "חייל לא נמצא", 404);
    invariant(
      !person.deletedAt,
      "deleted_soldier",
      "אי אפשר לרשום ביצוע לחשבון שנמחק"
    );
    const period = range(segment);
    changes.push({
      kind: instant(period.end).toMillis() <= now ? "late" : "create",
      soldierId,
      name: person.name,
      rowId: randomUUID(),
      to: period,
      price: priceOf.get(soldierId)!,
      allocation: allocationOf.get(soldierId)!,
      pointsBefore: 0,
      findings: [],
    });
  }
  for (const change of changes) {
    const person = state.soldiers.find((row) => row.id === change.soldierId);
    if (!person?.deletedAt || change.kind === "keep") continue;
    // The seat of a soldier deleted while the duty ran is decided here by the
    // manager (decision 196): the part they performed is recorded, or they are
    // removed from the seat. A period that was already credited changes only
    // through the correction rules, which stay closed for a deleted account.
    invariant(
      ["update", "late", "cancel"].includes(change.kind),
      "deleted_soldier",
      "תקופה שכבר נזקפה לחייל שנמחק אינה ניתנת לשינוי"
    );
  }

  // Eligibility is checked against everyone's periods after this change (decision 183).
  const planned = new Map<string, SeatRow>();
  for (const change of changes) {
    if (change.kind === "cancel" || change.kind === "remove") continue;
    const period = change.to!;
    const row: SeatRow = {
      ...(change.row ?? {
        id: change.rowId,
        dutyId: duty.id,
        slotId: slot.id,
        soldierId: change.soldierId,
        points: change.price!.points,
        status: "reserved" as const,
        version: 0,
      }),
      performedStart: period.start,
      performedEnd: period.end,
      performance: undefined,
    };
    planned.set(row.id, row);
  }
  const overrides = new Map(
    (params.overrides ?? []).map((row) => [row.id, row])
  );
  const context = state.assignments
    .filter(
      (row) =>
        !(row.dutyId === duty.id && row.slotId === slot.id) &&
        !overrides.has(row.id)
    )
    .concat([...overrides.values()], [...planned.values()]);
  const allowed =
    params.mode === "manual" ? MANUAL_EXCEPTIONS : VOLUNTEER_EXCEPTIONS;
  for (const change of changes) {
    if (!["create", "update", "late"].includes(change.kind)) continue;
    const period = change.to!;
    if (change.from && within(period, change.from)) continue;
    const person = state.soldiers.find((row) => row.id === change.soldierId)!;
    const result = evaluateEligibility(person, { ...duty, ...period }, slot, {
      duties: state.duties,
      assignments: context,
      mode: params.mode,
      ignoreAssignmentIds: [change.rowId],
      approvals: change.row?.approvals,
      pendingReviewConfirmed: params.reviewPending,
    });
    const history = instant(period.end).toMillis() <= now;
    if (history) {
      // A period that already ended is a record of what happened, like a past correction
      // (decision 161): findings are shown and kept, never blocking.
      change.findings = [...result.blockers, ...result.approvalsRequired].map(
        (reason) => ({ code: reason.code, message: reason.message })
      );
      continue;
    }
    change.eligibility = {
      status: result.status,
      pendingReview: result.approvalsRequired.some(
        (reason) => reason.code === "pending_review"
      ),
      blockers: result.blockers,
      requirements: result.approvalsRequired
        .filter((reason) => reason.code !== "pending_review")
        .map((reason) => ({
          ...reason,
          key: segmentApprovalKey(change.soldierId, reason),
        })),
    };
    if (
      result.approvalsRequired.some(
        (reason) =>
          reason.code !== "pending_review" && !allowed.includes(reason.code)
      )
    )
      change.eligibility.blockers = [
        ...result.blockers,
        ...result.approvalsRequired.filter(
          (reason) =>
            reason.code !== "pending_review" && !allowed.includes(reason.code)
        ),
      ];
  }

  // Credited periods change through the correction rules; a new past period is a late credit.
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
  ).filter((item) => item.data.status === "pending");
  const balanceRows = await tx.select().from(balances);
  for (const change of changes) {
    if (!["late", "correct", "remove"].includes(change.kind)) continue;
    const balance = balanceRows.find(
      (item) => item.soldierId === change.soldierId
    );
    invariant(balance, "missing_balance", "לא נמצאה יתרת החייל");
    const credited = change.row?.status === "credited";
    const performance = credited
      ? currentPerformance(change.row!, duty, credits)
      : undefined;
    const historyAfter = change.kind === "remove" ? 0 : change.price!.points;
    const references = [
      ...(performance ? [performance.end] : []),
      ...(change.to ? [change.to.end] : []),
    ].sort((a, b) => instant(a).toMillis() - instant(b).toMillis());
    const barriers = correctionBarriers(
      change.soldierId,
      references[0]!,
      events
    );
    const decision = credited
      ? decisions.find(
          (item) =>
            item.data.assignmentId === change.rowId &&
            item.subjectId === change.soldierId
        )
      : undefined;
    const reflected = performance?.reflected[change.soldierId] ?? 0;
    const effect = correctionEffect({
      balance: balance.current,
      reflected,
      corrected: historyAfter,
      barriers,
      openDecision: Boolean(decision),
    });
    change.effect = {
      ...effect,
      soldierId: change.soldierId,
      historyBefore: performance?.points ?? 0,
      historyAfter,
      reflected,
      balance: balance.current,
      balanceVersion: balance.version,
      barrierIds: barriers.map((barrier) => barrier.id),
      barriers: barriers.map((barrier) => ({
        id: barrier.id,
        effectiveAt: barrier.effectiveAt,
        reason: entries.find((item) => item.id === barrier.id)!.reason,
      })),
      from: references[0]!,
      decisionId: decision?.id,
      decisionVersion: decision?.version,
    };
  }
  const token = createHash("sha256")
    .update(
      JSON.stringify({
        duty: [duty.id, duty.version],
        seat: rows.map((row) => [row.id, row.version, row.status]),
        record: seatRecord ? [seatRecord.id, seatRecord.version] : null,
        proposed,
        allocation,
        mode: params.mode,
        changes: changes.map((change) => [
          change.kind,
          change.soldierId,
          change.price?.points ?? null,
          change.eligibility?.status ?? null,
          change.eligibility?.requirements.map((item) => item.key) ?? [],
          change.effect
            ? [
                change.effect.status,
                change.effect.balanceVersion,
                change.effect.decisionVersion ?? null,
                change.effect.barrierIds,
              ]
            : null,
        ]),
      })
    )
    .digest("hex");
  return {
    state,
    duty,
    slot,
    seatRecord,
    rows,
    current,
    proposed,
    changes,
    credits,
    allocation,
    allocationRequired,
    allocationExplicit: params.allocations !== undefined,
    extraTotal,
    token,
  };
}

export type ExecutionPlan = Awaited<ReturnType<typeof planExecution>>;

/** What the manager sees before saving; the stored version is checked again on save. */
export function executionView(plan: ExecutionPlan) {
  const blocked = plan.changes.filter(
    (change) => change.eligibility?.blockers.length
  );
  return {
    token: plan.token,
    dutyId: plan.duty.id,
    slotId: plan.slot.id,
    current: plan.current.map(({ soldierId, start, end, credited }) => ({
      soldierId,
      start,
      end,
      credited,
    })),
    proposed: plan.proposed,
    allocationRequired: plan.allocationRequired,
    allocationExplicit: plan.allocationExplicit,
    allocation: plan.allocation,
    fixedBaseTotal:
      plan.duty.pricing.mode === "fixed"
        ? plan.duty.pricing.basePoints
        : undefined,
    fixedExtraTotal: plan.extraTotal,
    changes: plan.changes.map((change) => ({
      kind: change.kind,
      soldierId: change.soldierId,
      name: change.name,
      from: change.from,
      to: change.to,
      price: change.price,
      allocation: change.allocation,
      pointsBefore: change.pointsBefore,
      credited: change.row?.status === "credited",
      eligibility: change.eligibility,
      findings: change.findings,
      effect: change.effect && {
        ...change.effect,
        balanceVersion: undefined,
        decisionVersion: undefined,
        barrierIds: undefined,
      },
    })),
    blocked: blocked.length > 0,
    reviewPendingRequired: plan.changes.some(
      (change) => change.eligibility?.pendingReview
    ),
  };
}

export function approvalsOf(
  plan: ExecutionPlan,
  actor: Actor,
  change: Change,
  keys: string[],
  reason: string | undefined,
  mode: "manual" | "volunteer"
): SpecificApproval[] {
  const eligibility = change.eligibility;
  if (!eligibility) return [];
  invariant(
    !eligibility.blockers.length,
    "segment_ineligible",
    `${change.name} אינו עומד בתנאי התורנות לתקופה שנבחרה`,
    422,
    eligibility
  );
  invariant(
    !eligibility.pendingReview,
    "pending_review_required",
    "יש אילוצים ממתינים. נדרש אישור מפורש להמשך לפני השלמת סקירתם",
    422,
    eligibility
  );
  if (!eligibility.requirements.length) return [];
  invariant(
    reason,
    "approval_required",
    "נדרשת סיבה לאישור החריגים",
    422,
    eligibility
  );
  const allowed = mode === "manual" ? MANUAL_EXCEPTIONS : VOLUNTEER_EXCEPTIONS;
  const person = plan.state.soldiers.find(
    (row) => row.id === change.soldierId
  )!;
  const now = new Date().toISOString();
  return eligibility.requirements.map((requirement) => {
    invariant(
      keys.includes(requirement.key),
      "approval_required",
      "נדרש אישור נפרד לכל חריג",
      422,
      eligibility
    );
    invariant(
      allowed.includes(requirement.code),
      "unknown_exception",
      "אין סמכות לחריגה מהתנאי הזה"
    );
    return {
      kind: requirement.code as SpecificApproval["kind"],
      soldierId: person.id,
      soldierVersion: person.version,
      dutyId: plan.duty.id,
      dutyVersion: plan.duty.rulesVersion ?? plan.duty.version,
      referenceId: requirement.referenceId,
      referenceVersion: requirement.referenceVersion,
      reason,
      approvedBy: actor.id,
      approvedAt: now,
    };
  });
}
