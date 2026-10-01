import { evaluateEligibility } from "./eligibility";
import { instant } from "./time";
import type { Assignment, Duty, EligibilityResult, Soldier } from "./types";

/** What publishing needs from the unit: the soldiers, every duty and every assignment. */
export interface PublicationState {
  soldiers: Soldier[];
  duties: Duty[];
  assignments: Assignment[];
}

/** One reason a draft cannot be published, in the form a single publish raises it. */
export interface PublishBlock {
  code: "cannot_publish" | "invalid_assignment" | "assignment_changed";
  /** The error a single publish raises (kept as it was before batch publishing). */
  message: string;
  status: number;
  /** What a manager reads beside a blocked draft: every seat that needs handling. */
  reason: string;
  /** The first seat that blocks, with the eligibility result a single publish returns. */
  eligibility?: EligibilityResult;
}

export const CANNOT_PUBLISH_MESSAGE = "ניתן לפרסם טיוטה שטרם התחילה";
const ASSIGNMENT_CHANGED_MESSAGE =
  "נתוני השיבוץ השתנו. יש לטפל בהתאמה לפני פרסום";

/**
 * Whether a draft can be published now, by the checks of a single publish:
 * it is still a draft that has not started, and every reserved assignment on
 * it is still eligible with the approvals saved on it. One place for both the
 * single publish and the batch publish (decision 197), so they never disagree.
 */
export function publishBlock(
  state: PublicationState,
  duty: Duty,
  now: number
): PublishBlock | null {
  if (duty.status !== "draft" || instant(duty.start).toMillis() <= now) {
    const reason =
      duty.status === "published"
        ? "התורנות כבר פורסמה"
        : duty.status === "cancelled"
          ? "התורנות בוטלה"
          : "התורנות כבר התחילה";
    return {
      code: "cannot_publish",
      message: CANNOT_PUBLISH_MESSAGE,
      status: 422,
      reason,
    };
  }
  const problems: string[] = [];
  let first: PublishBlock | undefined;
  for (const assignment of state.assignments.filter(
    (item) => item.dutyId === duty.id && item.status === "reserved"
  )) {
    const person = state.soldiers.find(
      (item) => item.id === assignment.soldierId
    );
    const slot = duty.slots.find((item) => item.id === assignment.slotId);
    if (!person || !slot) {
      problems.push("שיבוץ דורש בדיקה לפני פרסום");
      first ??= {
        code: "invalid_assignment",
        message: "שיבוץ דורש בדיקה לפני פרסום",
        status: 422,
        reason: "",
      };
      continue;
    }
    const result = evaluateEligibility(person, duty, slot, {
      duties: state.duties,
      assignments: state.assignments,
      mode: "manual",
      ignoreAssignmentIds: [assignment.id],
      approvals: assignment.approvals,
      pendingReviewConfirmed: assignment.pendingReviewConfirmed,
    });
    if (result.status === "eligible") continue;
    const why = [...result.blockers, ...result.approvalsRequired]
      .map((item) => item.message)
      .join("; ");
    problems.push(
      `השיבוץ של ${person.name} אינו תקין עוד${why ? `: ${why}` : ""}`
    );
    first ??= {
      code: "assignment_changed",
      message: ASSIGNMENT_CHANGED_MESSAGE,
      status: 422,
      reason: "",
      eligibility: result,
    };
  }
  return first ? { ...first, reason: problems.join(" · ") } : null;
}
