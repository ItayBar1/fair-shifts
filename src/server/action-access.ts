import { invariant } from "./errors";
import type { Actor } from "./repository";

/**
 * Who may run each action, by role. The handlers make the finer checks; this
 * map lets a stored result answer only someone who may run the action now
 * (decision 233). Adding a `case` to the action switch requires a line here.
 */
export type ActionAccess =
  "manager" | "technical" | "staff" | "soldier" | "everyone";

export const actionAccess = {
  "import.restore.preview": "manager",
  "import.restore": "manager",
  "import.preview": "manager",
  "import.get": "manager",
  "import.apply": "manager",
  "import.invitations.publish": "manager",
  "soldier.create": "manager",
  "soldier.update.preview": "manager",
  "soldier.update": "manager",
  "soldier.delete.preview": "manager",
  "soldier.delete": "manager",
  "soldier.timeline.preview": "manager",
  "soldier.timeline": "manager",
  "soldier.timeline.edit.preview": "manager",
  "soldier.timeline.edit": "manager",
  "soldier.conditions.preview": "manager",
  "soldier.conditions": "manager",
  "eligibility.catalog.save": "manager",
  "rank.track.save": "manager",
  "rank.track.delete": "manager",
  "rank.catalog.save": "manager",
  "rank.rule.save": "manager",
  "rank.deadline": "manager",
  "rank.set": "manager",
  "rank.approve": "manager",
  "round.create": "manager",
  "round.close": "manager",
  "round.reopen": "manager",
  "constraint.preview": "manager",
  "constraint.review": "manager",
  "dutyType.save": "manager",
  "dutyType.impact.preview": "manager",
  "duty.create": "manager",
  "duty.assign": "manager",
  "duty.assignment.preview": "manager",
  "duty.lottery": "manager",
  "duty.lottery.approve": "manager",
  "planning.run": "manager",
  "planning.step": "manager",
  "duty.publish": "manager",
  "duty.publish.preview": "manager",
  "duty.publish.batch": "manager",
  "duty.change.create": "manager",
  "duty.change.save": "manager",
  "duty.change.rules": "manager",
  "duty.change.preview": "manager",
  "duty.change.publish": "manager",
  "duty.change.apply": "manager",
  "duty.change.discard": "manager",
  "duty.cancel": "manager",
  "cancellation.reject": "manager",
  "cancellation.refer": "manager",
  "cancellation.prepare": "manager",
  "score.preview": "manager",
  "score.apply": "manager",
  "performance.correction.preview": "manager",
  "performance.correction.apply": "manager",
  "execution.preview": "manager",
  "execution.apply": "manager",
  "score.decision.preview": "manager",
  "score.decision.apply": "manager",
  "manager.return.keep": "manager",
  "notification.defaults.save": "manager",
  "transfer.review": "manager",
  "transfer.decide": "manager",
  "swap.review": "manager",
  "swap.decide": "manager",
  // Only the technical account grants a role or asks for a backup (scenario 45).
  "account.role": "technical",
  "technical.user.create": "technical",
  "backup.request": "technical",
  // The technical account moves its own address with a code from each mailbox (decision 204).
  "technical.email.request": "technical",
  "technical.email.confirm": "technical",
  "manager.email.request": "manager",
  "manager.email.confirm": "manager",
  "technical.manager-email.request": "technical",
  "technical.manager-email.confirm": "technical",
  // A manager releases a soldier and the technical account a manager.
  "account.unlock": "staff",
  "account.responsibility": "staff",
  // A soldier's own requests; a manager takes no part in duties (decision 192).
  "constraint.submit": "soldier",
  "cancellation.submit": "soldier",
  "cancellation.withdraw": "soldier",
  "transfer.offer": "soldier",
  "transfer.respond": "soldier",
  "transfer.withdraw": "soldier",
  "swap.offer": "soldier",
  "swap.respond": "soldier",
  "swap.withdraw": "soldier",
  // The calendar belongs to a soldier; a manager takes no seat, so has none (decisions 192 and 195).
  "calendar.switch": "soldier",
  "calendar.remove.future": "soldier",
  // A soldier's own phone and address (decision 222).
  "profile.contact.update": "soldier",
  // A manager changes a soldier's address, after the new one is verified (section 7.1).
  "account.email.request": "manager",
  "account.email.confirm": "manager",
  // Personal matters of whoever is signed in.
  "notification.read": "everyone",
  "notification.hide": "everyone",
  "settings.save": "everyone",
  "settings.reset": "everyone",
} as const satisfies Record<string, ActionAccess>;
export type ActionType = keyof typeof actionAccess;

export const isActionType = (type: string): type is ActionType =>
  Object.hasOwn(actionAccess, type);

export function mayRun(type: ActionType, role: Actor["role"]) {
  const access: ActionAccess = actionAccess[type];
  return (
    access === "everyone" ||
    access === role ||
    (access === "staff" && role !== "soldier")
  );
}

export function assertMayRun(type: string, actor: Actor) {
  invariant(
    isActionType(type) && mayRun(type, actor.role),
    "forbidden",
    "אין הרשאה לפעולה הזו",
    403
  );
}
