import type { DbTransaction } from "../db";
import { manager, type Actor } from "../repository";
import { invariant } from "../errors";
import { commitExecution } from "./commit";
import { executionInput, parseSegments } from "./inputs";
import { executionView, planExecution } from "./plan";
import { deletionPending, pendingReferral } from "./seats";

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
    allocations: input.allocations,
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
    allocations: input.allocations,
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
      (await pendingReferral(tx, plan)) ||
      deletionPending(plan),
    "no_change",
    "לא הוזן שינוי בתקופות הביצוע"
  );
  invariant(
    !plan.allocationRequired || plan.allocationExplicit,
    "allocation_required",
    "יש לקבוע במפורש חלוקת בסיס ותוספת קבועה לכל מבצע לפני אישור",
    422
  );
  return commitExecution(tx, actor, plan, {
    reason: input.reason,
    mode: "manual",
    approvalKeys: input.approvalKeys,
    approvalReason: input.approvalReason,
    reviewPending: input.reviewPending,
  });
}
