import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { unitTransaction } from "./db";
import { commandResults } from "./schema";
import { commandSchema, id } from "./validation";
import {
  assertActorCurrent,
  setRole,
  setResponsibility,
  unlockAccount,
  type Actor,
} from "./auth/accounts";
import { currentVersion } from "./repository";
import { invariant, AppError } from "./errors";
import { saveSoldier } from "./people";
import {
  saveDutyType,
  createDuty,
  previewAssignment,
  assignDuty,
  publishDuty,
} from "./duty-service";
import { previewScore, applyScore } from "./scoring";
import {
  previewPerformanceCorrection,
  applyPerformanceCorrection,
} from "./performance-corrections";
import { requestEmailChange, confirmEmailChange } from "./auth/email-change";
import { user } from "./auth-schema";
import {
  saveEligibilityCatalog,
  updateTimeline,
  previewTimelineAdd,
  previewTimelineEdit,
  editTimeline,
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
  markNotification,
  resetPreferences,
  saveDefaults,
  savePreferences,
} from "./notifications";

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
      case "soldier.create":
        invariant(
          !payload.id,
          "invalid_input",
          "יצירת חייל אינה כוללת מזהה קיים"
        );
        result = await saveSoldier(tx, actor, payload);
        break;
      case "soldier.update":
        id.parse(payload.id);
        result = await saveSoldier(tx, actor, payload, expectedVersion);
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
      case "duty.change.create":
        result = await createDutyChange(tx, actor, payload, expectedVersion);
        break;
      case "duty.change.save":
        result = await saveDutyChange(tx, actor, payload, expectedVersion);
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
      case "account.role": {
        const input = z
          .object({ id: z.string(), role: z.enum(["soldier", "manager"]) })
          .parse(payload);
        const [target] = await tx
          .select()
          .from(user)
          .where(eq(user.id, input.id))
          .for("update");
        invariant(target, "not_found", "חשבון לא נמצא", 404);
        currentVersion(target.securityEpoch, expectedVersion);
        await setRole(actor, input.id, input.role, tx);
        result = { success: true };
        break;
      }
      case "account.responsibility": {
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
        const targetId = z.string().parse(payload.id);
        const [target] = await tx
          .select()
          .from(user)
          .where(eq(user.id, targetId))
          .for("update");
        invariant(target, "not_found", "חשבון לא נמצא", 404);
        currentVersion(target.securityEpoch, expectedVersion);
        await unlockAccount(actor, targetId, tx);
        result = { success: true };
        break;
      }
      case "account.email.request":
        result = await requestEmailChange(tx, actor, payload, expectedVersion);
        break;
      case "account.email.confirm":
        result = await confirmEmailChange(tx, actor, payload, expectedVersion);
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
      default:
        throw new AppError(
          "not_implemented",
          "המסלול הזה עדיין בבנייה ואינו זמין לשמירה",
          501
        );
    }
    await tx.insert(commandResults).values({
      id: randomUUID(),
      actorId: actor.id,
      requestKey: command.idempotencyKey,
      payloadHash: hash,
      result,
    });
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
  return result;
}
