import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { unitTransaction } from "./db";
import { commandResults } from "./schema";
import {
  expireCommandResults,
  linkCommandResult,
  RESULT_RETENTION_MS,
} from "./command-results";
import { commandSchema, id } from "./validation";
import {
  assertActorCurrent,
  setResponsibility,
  unlockAccount,
  type Actor,
} from "./auth/accounts";
import { changeRole, keepReturnedBalance } from "./manager-role";
import { currentVersion, manager } from "./repository";
import { invariant, AppError } from "./errors";
import {
  createTechnicalUser,
  previewSoldierUpdate,
  saveSoldier,
} from "./people";
import { deleteSoldier, previewSoldierDeletion } from "./soldier-deletion";
import {
  saveDutyType,
  createDuty,
  previewAssignment,
  assignDuty,
  publishDuty,
} from "./duty-service";
import { previewPublishDrafts, publishDrafts } from "./duty-publishing";
import { previewScore, applyScore } from "./scoring";
import {
  previewPerformanceCorrection,
  applyPerformanceCorrection,
} from "./performance-corrections";
import { previewScoreDecision, applyScoreDecision } from "./score-decisions";
import { applyExecution, previewExecution } from "./execution";
import { requestEmailChange, confirmEmailChange } from "./auth/email-change";
import {
  confirmTechnicalEmailChange,
  requestTechnicalEmailChange,
  requestManagerEmailChange,
  confirmManagerEmailChange,
} from "./auth/technical-email";
import { user } from "./auth-schema";
import {
  saveEligibilityCatalog,
  updateTimeline,
  previewTimelineAdd,
  previewTimelineEdit,
  editTimeline,
  previewSoldierConditions,
  saveSoldierConditions,
} from "./personnel";
import {
  createRound,
  closeRound,
  reopenRound,
  submitConstraint,
  previewConstraint,
  reviewConstraint,
} from "./constraints";
import {
  saveRankCatalog,
  saveRankRule,
  setRankDeadline,
  setSoldierRank,
  approveRank,
} from "./ranks";
import { drawLottery, decideLottery, createPlan, stepPlan } from "./planning";
import {
  createDutyChange,
  saveDutyChange,
  saveDutyChangeRules,
  previewDutyChange,
  publishDutyChange,
  applyDraftDutyChange,
  cancelDuty,
  discardDutyChange,
  previewCatalogImpact,
} from "./duty-changes";
import { previewImport, applyImport, getImport } from "./imports";
import { previewImportRestore, applyImportRestore } from "./import-restores";
import {
  decideTransfer,
  offerTransfer,
  respondTransfer,
  reviewTransfer,
  withdrawTransfer,
} from "./transfers";
import {
  decideSwap,
  offerSwap,
  respondSwap,
  reviewSwap,
  withdrawSwap,
} from "./swaps";
import { requestBackup } from "./operations/backup";
import {
  prepareCancellationChange,
  referCancellationRequest,
  rejectCancellationRequest,
  submitCancellationRequest,
  withdrawCancellationRequest,
} from "./cancellation-requests";
import {
  markNotification,
  resetPreferences,
  saveDefaults,
  savePreferences,
} from "./notifications";
import {
  requestFutureRemoval,
  scheduleCalendarCleanup,
  setCalendarSwitch,
  type CalendarCleanup,
} from "./calendar/link";

export async function executeAction(actor: Actor, value: unknown) {
  const command = commandSchema.parse(value);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        type: command.type,
        payload: command.payload,
        expectedVersion: command.expectedVersion,
      })
    )
    .digest("hex");
  // What a deletion leaves to remove from Google, run only after its commit (decision 195).
  const calendarCleanups: CalendarCleanup[] = [];
  const result = await unitTransaction(async (tx) => {
    await assertActorCurrent(actor, tx);
    const [previous] = await tx
      .select()
      .from(commandResults)
      .where(
        and(
          eq(commandResults.actorId, actor.id),
          eq(commandResults.requestKey, command.idempotencyKey)
        )
      );
    if (previous) {
      invariant(
        previous.payloadHash === hash,
        "idempotency_conflict",
        "מפתח הפעולה כבר שימש לבקשה אחרת",
        409
      );
      const now = new Date();
      if (
        !previous.contentExpiredAt &&
        previous.createdAt.getTime() <= now.getTime() - RESULT_RETENTION_MS
      ) {
        await expireCommandResults(tx, now, previous.id);
        return { expiredAt: now.toISOString() };
      }
      return previous.result;
    }
    const { payload, expectedVersion } = command;
    let result: unknown;
    switch (command.type) {
      case "import.restore.preview":
        result = await previewImportRestore(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "import.restore":
        result = await applyImportRestore(tx, actor, payload, expectedVersion);
        break;
      case "import.preview":
        result = await previewImport(tx, actor, payload);
        break;
      case "import.get":
        result = await getImport(tx, actor, payload);
        break;
      case "import.apply":
        result = await applyImport(tx, actor, payload, expectedVersion);
        break;
      case "technical.user.create":
        result = await createTechnicalUser(tx, actor, payload);
        break;
      case "soldier.create":
        manager(actor);
        invariant(
          !payload.id,
          "invalid_input",
          "יצירת חייל אינה כוללת מזהה קיים"
        );
        result = await saveSoldier(tx, actor, payload);
        break;
      case "soldier.update.preview":
        manager(actor);
        id.parse(payload.id);
        result = await previewSoldierUpdate(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "soldier.update":
        manager(actor);
        id.parse(payload.id);
        result = await saveSoldier(tx, actor, payload, expectedVersion);
        break;
      case "soldier.delete.preview":
        result = await previewSoldierDeletion(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "soldier.delete":
        result = await deleteSoldier(
          tx,
          actor,
          payload,
          expectedVersion,
          calendarCleanups
        );
        break;
      case "soldier.timeline.preview":
        result = await previewTimelineAdd(tx, actor, payload, expectedVersion);
        break;
      case "soldier.timeline":
        result = await updateTimeline(tx, actor, payload, expectedVersion);
        break;
      case "eligibility.catalog.save":
        result = await saveEligibilityCatalog(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "soldier.timeline.edit.preview":
        result = await previewTimelineEdit(tx, actor, payload, expectedVersion);
        break;
      case "soldier.timeline.edit":
        result = await editTimeline(tx, actor, payload, expectedVersion);
        break;
      case "soldier.conditions.preview":
        result = await previewSoldierConditions(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "soldier.conditions":
        result = await saveSoldierConditions(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "rank.catalog.save":
        result = await saveRankCatalog(tx, actor, payload, expectedVersion);
        break;
      case "rank.rule.save":
        result = await saveRankRule(tx, actor, payload, expectedVersion);
        break;
      case "rank.deadline":
        result = await setRankDeadline(tx, actor, payload, expectedVersion);
        break;
      case "rank.set":
        result = await setSoldierRank(tx, actor, payload, expectedVersion);
        break;
      case "rank.approve":
        result = await approveRank(tx, actor, payload, expectedVersion);
        break;
      case "round.create":
        result = await createRound(tx, actor, payload);
        break;
      case "round.close":
        result = await closeRound(tx, actor, payload, expectedVersion);
        break;
      case "round.reopen":
        result = await reopenRound(tx, actor, payload, expectedVersion);
        break;
      case "constraint.submit":
        result = await submitConstraint(tx, actor, payload, expectedVersion);
        break;
      case "constraint.preview":
        result = await previewConstraint(tx, actor, payload, expectedVersion);
        break;
      case "constraint.review":
        result = await reviewConstraint(tx, actor, payload, expectedVersion);
        break;
      case "dutyType.save":
        result = await saveDutyType(tx, actor, payload, expectedVersion);
        break;
      case "dutyType.impact.preview":
        result = await previewCatalogImpact(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "duty.create":
        result = await createDuty(tx, actor, payload);
        break;
      case "duty.assign":
        result = await assignDuty(tx, actor, payload, expectedVersion);
        break;
      case "duty.assignment.preview":
        result = await previewAssignment(tx, actor, payload, expectedVersion);
        break;
      case "duty.lottery":
        result = await drawLottery(tx, actor, payload, expectedVersion);
        break;
      case "duty.lottery.approve":
        result = await decideLottery(tx, actor, payload, expectedVersion);
        break;
      case "planning.run":
        result = await createPlan(tx, actor, payload);
        break;
      case "planning.step":
        result = await stepPlan(tx, actor, payload, expectedVersion);
        break;
      case "duty.publish":
        result = await publishDuty(tx, actor, payload, expectedVersion);
        break;
      case "duty.publish.preview":
        result = await previewPublishDrafts(tx, actor, payload);
        break;
      case "duty.publish.batch":
        result = await publishDrafts(tx, actor, payload);
        break;
      case "duty.change.create":
        result = await createDutyChange(tx, actor, payload, expectedVersion);
        break;
      case "duty.change.save":
        result = await saveDutyChange(tx, actor, payload, expectedVersion);
        break;
      case "duty.change.rules":
        result = await saveDutyChangeRules(tx, actor, payload, expectedVersion);
        break;
      case "duty.change.preview":
        result = await previewDutyChange(tx, actor, payload, expectedVersion);
        break;
      case "duty.change.publish":
        result = await publishDutyChange(tx, actor, payload, expectedVersion);
        break;
      case "duty.change.apply":
        result = await applyDraftDutyChange(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "duty.cancel":
        result = await cancelDuty(tx, actor, payload, expectedVersion);
        break;
      case "duty.change.discard":
        result = await discardDutyChange(tx, actor, payload, expectedVersion);
        break;
      case "transfer.offer":
        result = await offerTransfer(tx, actor, payload, expectedVersion);
        break;
      case "transfer.respond":
        result = await respondTransfer(tx, actor, payload, expectedVersion);
        break;
      case "transfer.withdraw":
        result = await withdrawTransfer(tx, actor, payload, expectedVersion);
        break;
      case "transfer.review":
        result = await reviewTransfer(tx, actor, payload, expectedVersion);
        break;
      case "transfer.decide":
        result = await decideTransfer(tx, actor, payload, expectedVersion);
        break;
      case "swap.offer":
        result = await offerSwap(tx, actor, payload, expectedVersion);
        break;
      case "swap.respond":
        result = await respondSwap(tx, actor, payload, expectedVersion);
        break;
      case "swap.withdraw":
        result = await withdrawSwap(tx, actor, payload, expectedVersion);
        break;
      case "swap.review":
        result = await reviewSwap(tx, actor, payload, expectedVersion);
        break;
      case "swap.decide":
        result = await decideSwap(tx, actor, payload, expectedVersion);
        break;
      case "cancellation.submit":
        result = await submitCancellationRequest(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "cancellation.withdraw":
        result = await withdrawCancellationRequest(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "cancellation.reject":
        result = await rejectCancellationRequest(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "cancellation.refer":
        result = await referCancellationRequest(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "cancellation.prepare":
        result = await prepareCancellationChange(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "score.preview":
        result = await previewScore(tx, actor, payload);
        break;
      case "score.apply":
        result = await applyScore(tx, actor, payload);
        break;
      case "performance.correction.preview":
        result = await previewPerformanceCorrection(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "performance.correction.apply":
        result = await applyPerformanceCorrection(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "execution.preview":
        result = await previewExecution(tx, actor, payload);
        break;
      case "execution.apply":
        result = await applyExecution(tx, actor, payload);
        break;
      case "score.decision.preview":
        result = await previewScoreDecision(
          tx,
          actor,
          payload,
          expectedVersion
        );
        break;
      case "score.decision.apply":
        result = await applyScoreDecision(tx, actor, payload, expectedVersion);
        break;
      case "account.role":
        result = await changeRole(tx, actor, payload, expectedVersion);
        break;
      case "manager.return.keep":
        result = await keepReturnedBalance(tx, actor, payload, expectedVersion);
        break;
      case "account.responsibility": {
        invariant(
          actor.role !== "soldier",
          "FORBIDDEN",
          "תחום אחריות קובעים המנהל הטכני או האחראי עצמו",
          403
        );
        const input = z
          .object({
            id: z.string(),
            responsibility: z.enum(["mandatory", "career"]).nullable(),
          })
          .parse(payload);
        await setResponsibility(
          actor,
          input.id,
          input.responsibility,
          expectedVersion,
          tx
        );
        result = { success: true };
        break;
      }
      case "account.unlock": {
        invariant(
          actor.role !== "soldier",
          "FORBIDDEN",
          "אין הרשאה לשחרר חשבון זה",
          403
        );
        const targetId = z.string().parse(payload.id);
        const [target] = await tx
          .select()
          .from(user)
          .where(eq(user.id, targetId))
          .for("update");
        invariant(target, "not_found", "חשבון לא נמצא", 404);
        invariant(
          target.role === "soldier"
            ? actor.role === "manager"
            : target.role === "manager" && actor.role === "technical",
          "FORBIDDEN",
          "אין הרשאה לשחרר חשבון זה",
          403
        );
        currentVersion(target.securityEpoch, expectedVersion);
        await unlockAccount(actor, targetId, tx);
        result = { success: true };
        break;
      }
      case "account.email.request":
        result = await requestEmailChange(tx, actor, payload, expectedVersion);
        break;
      case "account.email.confirm":
        result = await confirmEmailChange(
          tx,
          actor,
          payload,
          expectedVersion,
          calendarCleanups
        );
        break;
      case "technical.email.request":
        result = await requestTechnicalEmailChange(tx, actor, payload);
        break;
      case "technical.email.confirm":
        result = await confirmTechnicalEmailChange(
          tx,
          actor,
          payload,
          calendarCleanups
        );
        break;
      case "manager.email.request":
      case "technical.manager-email.request":
        result = await requestManagerEmailChange(
          tx,
          actor,
          payload,
          command.type === "technical.manager-email.request"
        );
        break;
      case "manager.email.confirm":
      case "technical.manager-email.confirm":
        result = await confirmManagerEmailChange(
          tx,
          actor,
          payload,
          command.type === "technical.manager-email.confirm",
          calendarCleanups
        );
        break;
      case "notification.read":
        result = await markNotification(tx, actor, payload, "readAt");
        break;
      case "notification.hide":
        result = await markNotification(tx, actor, payload, "hiddenAt");
        break;
      case "settings.save":
        result = await savePreferences(tx, actor, payload, expectedVersion);
        break;
      case "settings.reset":
        result = await resetPreferences(tx, actor, expectedVersion);
        break;
      case "notification.defaults.save":
        result = await saveDefaults(tx, actor, payload, expectedVersion);
        break;
      case "calendar.switch":
        result = await setCalendarSwitch(tx, actor, payload, expectedVersion);
        break;
      case "calendar.remove.future":
        result = await requestFutureRemoval(tx, actor, expectedVersion);
        break;
      case "backup.request":
        result = await requestBackup(tx, actor);
        break;
      default:
        throw new AppError(
          "not_implemented",
          "המסלול הזה עדיין בבנייה ואינו זמין לשמירה",
          501
        );
    }
    const resultId = randomUUID();
    await tx.insert(commandResults).values({
      id: resultId,
      actorId: actor.id,
      requestKey: command.idempotencyKey,
      payloadHash: hash,
      result,
      linkageComplete: true,
    });
    await linkCommandResult(tx, resultId, command.type, payload, result);
    return result;
  });
  if (result && typeof result === "object" && "committedError" in result) {
    const failure = result.committedError as {
      code: string;
      message: string;
      status: number;
    };
    throw new AppError(failure.code, failure.message, failure.status);
  }
  for (const cleanup of calendarCleanups) void scheduleCalendarCleanup(cleanup);
  return result;
}
