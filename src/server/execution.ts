import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { assignments, balances, duties, ledger, records } from "./schema";
import {
  audit,
  createRecord,
  loadDomain,
  manager,
  updateRecord,
  type Actor,
  type Workflow,
} from "./repository";
import { AppError, invariant } from "./errors";
import { id, text } from "./validation";
import { parseMoment } from "./duty-service";
import { postScore, settleDue } from "./scoring";
import { approvalKey, closeSeatRequests, notifySoldier } from "./seat-requests";
import { cancelStaleDutyReminders } from "./duty-reminder-checks";
import { evaluateEligibility } from "../domain/eligibility";
import {
  executionPeriod,
  normalizeSegments,
  samePeriod,
  segmentPrice,
  within,
  type ExecutionSegment,
} from "../domain/execution";
import {
  correctionBarriers,
  correctionEffect,
  type LedgerEvent,
} from "../domain/scoring";
import { instant } from "../domain/time";
import type {
  Assignment,
  Duty,
  EligibilityReason,
  InstantRange,
  Performance,
  PriceBreakdown,
  SpecificApproval,
} from "../domain/types";

// Execution periods of a seat in a duty that started (decision 183): who actually covered
// which part, the value of each part, and the path each change takes to the balances.

type Domain = Awaited<ReturnType<typeof loadDomain>>;
type SeatRow = Domain["assignments"][number];
type DutyRow = Domain["duties"][number];

const ACTIVE = ["reserved", "held"];
const SEAT = [...ACTIVE, "credited"];

const segmentInput = z.object({
  soldierId: id.nullable(),
  start: text,
  end: text,
  startOffset: z.number().optional(),
  endOffset: z.number().optional(),
});
const executionInput = z.object({
  dutyId: id,
  slotId: id,
  segments: z.array(segmentInput).min(1).max(24),
  reason: text,
  reviewPending: z.boolean().default(false),
  approvalReason: z.string().trim().max(2000).optional(),
  approvalKeys: z.array(z.string().max(300)).max(100).default([]),
  token: z.string().max(128).optional(),
});

/** An approval key names the soldier, so each performer's exception is approved on its own. */
export const segmentApprovalKey = (
  soldierId: string,
  reason: EligibilityReason
) => `${soldierId}:${approvalKey(reason)}`;

const MANUAL_EXCEPTIONS = [
  "exemption",
  "rank",
  "allowed_hours",
  "pending_constraint",
  "near_release",
];
const VOLUNTEER_EXCEPTIONS = ["exemption", "rank"];

type ChangeKind =
  "keep" | "update" | "create" | "cancel" | "late" | "correct" | "remove";

interface Effect {
  status: "automatic" | "decision_required";
  soldierId: string;
  historyBefore: number;
  historyAfter: number;
  reflected: number;
  balance: number;
  balanceVersion: number;
  delta?: number;
  after?: number;
  clamped?: boolean;
  rawDelta?: number;
  barrierIds: string[];
  barriers: { id: string; reason: string; effectiveAt: string }[];
  from: string;
  decisionId?: string;
  decisionVersion?: number;
}

export interface Change {
  kind: ChangeKind;
  soldierId: string;
  name: string;
  row?: SeatRow;
  /** The row this change writes; a new id when the performer had no row. */
  rowId: string;
  from?: InstantRange;
  to?: InstantRange;
  price?: PriceBreakdown;
  /** Points before the change: stored for an open row, recorded for a credited one. */
  pointsBefore: number;
  effect?: Effect;
  eligibility?: {
    status: string;
    blockers: EligibilityReason[];
    requirements: (EligibilityReason & { key: string })[];
    /** Pending constraints exist and continuing before their review was not confirmed. */
    pendingReview: boolean;
  };
  findings: { code: string; message: string }[];
}

export interface ExecutionPlanOptions {
  mode: "manual" | "volunteer";
  reviewPending?: boolean;
  approvalKeys?: string[];
  /** Assignments of other seats as they will be after the same operation (a swap moves two). */
  overrides?: SeatRow[];
}

const range = (value: InstantRange) => ({ start: value.start, end: value.end });

function currentPerformance(
  row: SeatRow,
  duty: DutyRow,
  credits: Map<string, number>
): Performance {
  if (row.performance) return row.performance;
  const period = executionPeriod(row, duty);
  const amount = credits.get(row.id) ?? row.points;
  return {
    performerId: row.soldierId,
    start: period.start,
    end: period.end,
    points: amount,
    reflected: { [row.soldierId]: amount },
    corrections: 0,
  };
}

/** Segments of a seat as recorded today, with the parts marked as not performed. */
export function seatSegments(
  state: Domain,
  duty: DutyRow,
  slotId: string,
  seatRecord?: Workflow
) {
  const rows = state.assignments.filter(
    (row) =>
      row.dutyId === duty.id &&
      row.slotId === slotId &&
      SEAT.includes(row.status)
  );
  const segments: (ExecutionSegment & { rowId?: string; credited: boolean })[] =
    rows.map((row) => ({
      ...range(executionPeriod(row, duty)),
      soldierId: row.performance?.performerId ?? row.soldierId,
      rowId: row.id,
      credited: row.status === "credited",
    }));
  for (const part of (seatRecord?.data.notPerformed ?? []) as InstantRange[])
    segments.push({ ...range(part), soldierId: null, credited: false });
  return {
    rows,
    segments: segments.sort(
      (a, b) => instant(a.start).toMillis() - instant(b.start).toMillis()
    ),
  };
}

async function seatRecordOf(tx: DbTransaction, dutyId: string, slotId: string) {
  const rows = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "seat_execution"));
  return rows.find(
    (row) => row.data.dutyId === dutyId && row.data.slotId === slotId
  );
}

function hasFixedExtra(row: SeatRow) {
  const extra = new Decimal(row.extraPoints || "0");
  return extra.isFinite() && extra.gt(0);
}

/** Whether a seat can be split at all before fixed shares are supported (#19). */
export function splitBlocker(duty: Duty, rows: SeatRow[]): string | undefined {
  if (duty.pricing.mode !== "daily")
    return "חלוקת ביצוע בתעריף קבוע תתאפשר בהמשך (כרטיס #19). עד אז אפשר לדחות את הבקשה או לתקן ביצוע של מבצע יחיד אחרי הסיום";
  if (rows.some(hasFixedExtra))
    return "לשיבוץ במקום הזה יש תוספת קבועה, כגון הזנקה. חלוקתה בין מבצעים תתאפשר בהמשך (כרטיס #19)";
  return undefined;
}

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
  const blocker = splitBlocker(duty, rows);
  invariant(!blocker, "split_unavailable", blocker!, 422);
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
    const unchanged = samePeriod(from, period);
    if (credited) {
      changes.push({
        ...base,
        kind: unchanged ? "keep" : "correct",
        to: period,
        ...(!unchanged && { price: segmentPrice(duty.pricing, period) }),
      });
      continue;
    }
    const due = instant(period.end).toMillis() <= now;
    changes.push({
      ...base,
      kind: due ? "late" : unchanged ? "keep" : "update",
      to: period,
      price: segmentPrice(duty.pricing, period),
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
      price: segmentPrice(duty.pricing, period),
      pointsBefore: 0,
      findings: [],
    });
  }
  for (const change of changes) {
    const person = state.soldiers.find((row) => row.id === change.soldierId);
    invariant(
      change.kind === "keep" || (person && !person.deletedAt),
      "deleted_soldier",
      "אחד המבצעים נמחק. שינוי הביצוע שלו יטופל במסלול המחיקה"
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
    changes: plan.changes.map((change) => ({
      kind: change.kind,
      soldierId: change.soldierId,
      name: change.name,
      from: change.from,
      to: change.to,
      price: change.price,
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

function approvalsOf(
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

const display = (value: string) => instant(value).toFormat("dd.MM.yyyy HH:mm");

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
  const executionId = randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const outcomes: Record<string, unknown>[] = [];
  const touched: string[] = [];
  const affected = new Map<string, string>();
  for (const change of changes) {
    if (change.kind === "keep") continue;
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
          performedStart: period!.start,
          performedEnd: period!.end,
          approvals: [...(row!.approvals ?? []), ...approvals],
          executionId,
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
        extraPoints: "0",
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
      performedStart: performance.start,
      performedEnd: performance.end,
      performance,
      executionId,
      creditedAt: row?.creditedAt ?? nowIso,
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
        extraPoints: "0",
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
  await tx.insert(records).values({
    id: executionId,
    kind: "execution_change",
    subjectId: subject,
    data: {
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
  });
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

function parseSegments(input: z.infer<typeof executionInput>) {
  try {
    return input.segments.map((segment) => ({
      soldierId: segment.soldierId,
      start: parseMoment(segment.start, segment.startOffset),
      end: parseMoment(segment.end, segment.endOffset),
    }));
  } catch (error) {
    throw new AppError(
      "invalid_segments",
      error instanceof Error ? error.message : "מועד לא תקין",
      422
    );
  }
}

export async function previewExecution(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  manager(actor);
  const input = executionInput.parse(payload);
  const plan = await planExecution(tx, {
    dutyId: input.dutyId,
    slotId: input.slotId,
    segments: parseSegments(input),
    mode: "manual",
    reviewPending: input.reviewPending,
  });
  return executionView(plan);
}

export async function applyExecution(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  manager(actor);
  const input = executionInput.parse(payload);
  const plan = await planExecution(tx, {
    dutyId: input.dutyId,
    slotId: input.slotId,
    segments: parseSegments(input),
    mode: "manual",
    reviewPending: input.reviewPending,
  });
  invariant(
    input.token === plan.token,
    "stale_preview",
    "נתוני הביצוע, השיבוצים או היתרות השתנו מאז התצוגה המקדימה. יש לבדוק שוב",
    409
  );
  invariant(
    plan.changes.some((change) => change.kind !== "keep") ||
      (await pendingReferral(tx, plan)),
    "no_change",
    "לא הוזן שינוי בתקופות הביצוע"
  );
  return commitExecution(tx, actor, plan, {
    reason: input.reason,
    mode: "manual",
    approvalKeys: input.approvalKeys,
    approvalReason: input.approvalReason,
    reviewPending: input.reviewPending,
  });
}

/** A referred request lets the manager confirm the recorded periods without changing them. */
async function pendingReferral(tx: DbTransaction, plan: ExecutionPlan) {
  const seatIds = new Set(plan.rows.map((row) => row.id));
  return (
    await tx.select().from(records).where(eq(records.kind, "request"))
  ).some(
    (row) =>
      row.data.type === "cancellation" &&
      row.data.status === "referred" &&
      !row.data.executionId &&
      seatIds.has(String(row.data.assignmentId))
  );
}

/**
 * The seat after a handover at `at`: the leaving soldier keeps the part before it and the
 * replacement covers the rest of that soldier's period (transfers and swaps after the start).
 */
export function handoverSegments(
  current: ExecutionSegment[],
  leavingId: string,
  replacementId: string,
  at: string
): ExecutionSegment[] {
  const own = current.find((segment) => segment.soldierId === leavingId);
  invariant(own, "not_found", "תקופת הביצוע של המוסר לא נמצאה", 404);
  const moment = instant(at).toMillis();
  invariant(
    moment > instant(own.start).toMillis() &&
      moment < instant(own.end).toMillis(),
    "invalid_handover",
    `מועד החילוף חייב להיות בתוך תקופת הביצוע של המוסר: ${display(own.start)} עד ${display(own.end)}`,
    422
  );
  const handover = instant(at).toISO()!;
  return current.flatMap((segment) =>
    segment === own
      ? [
          { soldierId: leavingId, start: own.start, end: handover },
          { soldierId: replacementId, start: handover, end: own.end },
        ]
      : [
          {
            soldierId: segment.soldierId,
            start: segment.start,
            end: segment.end,
          },
        ]
  );
}

/** The seat of an assignment and its current segments, for flows that move a started seat. */
export async function seatOf(tx: DbTransaction, assignment: Assignment) {
  const state = await loadDomain(tx);
  const duty = state.duties.find((row) => row.id === assignment.dutyId);
  invariant(duty, "not_found", "התורנות לא נמצאה", 404);
  const record = await seatRecordOf(tx, duty.id, assignment.slotId);
  return {
    duty,
    ...seatSegments(state, duty, assignment.slotId, record),
  };
}

export const handoverInput = {
  handoverAt: z.string().max(40).optional(),
  handoverOffset: z.number().optional(),
};

export function parseHandover(value?: string, offset?: number) {
  if (!value) return undefined;
  try {
    return parseMoment(value, offset);
  } catch (error) {
    throw new AppError(
      "invalid_handover",
      error instanceof Error ? error.message : "מועד החילוף אינו תקין",
      422
    );
  }
}

export { ACTIVE as ACTIVE_EXECUTION };
