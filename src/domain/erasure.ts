import type { Soldier } from "./types";

/**
 * Rules for deleting a soldier (decision 192). They are pure: the server finds
 * the records, these functions say what stays and what is removed.
 *
 * What survives a deletion is the name, the personal number and the history of
 * duties and score. Contact details, the eligibility conditions a manager
 * recorded about the soldier and every free-text reason that can reveal a
 * personal situation are removed from every active copy.
 */

type Json = Record<string, unknown>;

/** Replaces an approval reason; an approval without a reason stops being valid. */
export const ERASED_REASON = "הנימוק הוסר במחיקת משתמש";
/** Replaces the text of a closed request or a notice that quoted a reason. */
export const ERASED_NOTE = "הפירוט הוסר במחיקת משתמש";

export type ErasureAction = "keep" | "delete" | "scrub";
export type ErasurePolicy = { action: ErasureAction; why: string };

/**
 * The registry of every record kind and what deletion does to it. A new kind
 * must be listed here (a unit test enforces it), so no new copy of personal
 * data escapes the deletion route.
 */
export const recordPolicies: Record<string, ErasurePolicy> = {
  audit: {
    action: "keep",
    why: "מעטפה: מי, מה ומתי. הסיבה למחיקה נשמרת בה בהחרגה מפורשת",
  },
  audit_detail: { action: "delete", why: "הפירוט האישי של אירוע ביומן" },
  assignment_approval: {
    action: "scrub",
    why: "נימוק האישור החריג נמחק; האישור עצמו נשאר",
  },
  constraint: { action: "scrub", why: "נימוקי האילוץ וההחלטה נמחקים" },
  constraint_revision: { action: "scrub", why: "נימוקי האילוץ וההחלטה נמחקים" },
  deletion_log_entry: {
    action: "keep",
    why: "תור היומן העצמאי: מזהה פנימי ומועד בלבד, בלי שם או פרטי קשר",
  },
  departure: {
    action: "keep",
    why: "מועד שחרור והודעת עזיבה, בלי פרטים אישיים",
  },
  duty_change: { action: "keep", why: "היסטוריית תורנות; הסיבה היא של האחראי" },
  duty_revision: { action: "keep", why: "היסטוריית תורנות" },
  eligibility_catalog: { action: "keep", why: "קטלוג ליחידה, לא נתוני חייל" },
  email_change: { action: "delete", why: "כתובות מייל וקוד אימות" },
  execution_change: { action: "keep", why: "היסטוריית ביצוע וניקוד" },
  import: { action: "keep", why: "מספרים מצטברים של האצווה" },
  import_restore_preview: { action: "keep", why: "טביעות בלבד" },
  import_restore_profile_revision: {
    action: "delete",
    why: "תמונת פרופיל מלאה לפני שחזור, כולל תנאי התאמה",
  },
  import_row: {
    action: "scrub",
    why: "נשארים מספר שורה, שם, מספר אישי ותוצאה בלי פרטי קשר או שינויים",
  },
  lottery_attempt: {
    action: "scrub",
    why: "ציון וסטטוס נשארים; סיבות הפסילה ונימוק ההחלטה נמחקים",
  },
  lottery_exclusion: { action: "scrub", why: "נימוק הדחייה נמחק" },
  notification: {
    action: "scrub",
    why: "הודעות שנשלחו לחשבון נמחקות; הודעות על בקשות שלו מאבדות את הנימוק",
  },
  manager_return: {
    action: "keep",
    why: "פריט החלטה ביתרה של אחראי שחזר: מזהים ויתרה בלבד. פריט פתוח נסגר במחיקה",
  },
  notification_defaults: { action: "keep", why: "ברירות מחדל ליחידה" },
  performance_correction: { action: "keep", why: "היסטוריית ביצוע וניקוד" },
  personnel_change: {
    action: "delete",
    why: "פטורים, כשירויות, אי־פעילות ותנאי התאמה שנרשמו",
  },
  planning_run: { action: "keep", why: "מזהים של תורנויות ומקומות בלבד" },
  rank_catalog: { action: "keep", why: "קטלוג ליחידה" },
  rank_deadline: { action: "keep", why: "מועד פז״ם; דרגה נשמרת" },
  rank_history_revision: { action: "keep", why: "היסטוריית דרגה נשמרת" },
  rank_reminder: { action: "delete", why: "תזכורת מערכת לחייל שנמחק" },
  rank_rule: { action: "keep", why: "כלל ליחידה" },
  rank_rule_revision: { action: "keep", why: "כלל ליחידה" },
  request: {
    action: "scrub",
    why: "נימוקי בקשה, החלטה ואישור חריג נמחקים; הסטטוס נשאר",
  },
  round: { action: "keep", why: "סבב ליחידה" },
  round_notice: { action: "keep", why: "מי קיבל הודעה, בלי תוכן" },
  score_decision: { action: "keep", why: "היסטוריית ניקוד" },
  score_preview: { action: "keep", why: "תצוגה מקדימה זמנית" },
  seat_execution: { action: "keep", why: "היסטוריית ביצוע" },
  settings: { action: "delete", why: "העדפות אישיות של חשבון שנמחק" },
  technical_email_change: {
    action: "keep",
    why: "בקשה להחלפת כתובת של החשבון הטכני, שאינו חייל ואינו נמחק; אחרי הטיפול נשארים סטטוס וסיבה בלבד",
  },
};

const object = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
function without(source: Json, ...keys: string[]) {
  const copy = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}

/** The soldier, minus the conditions a manager recorded about them. */
export function withoutConditions(person: Soldier): Soldier {
  const next: Soldier = {
    ...person,
    exemptions: [],
    qualifications: [],
    inactivePeriods: [],
    constraints: [],
    capabilities: [],
    allowedHours: [],
  };
  delete next.gender;
  return next;
}

/** Whether a stored profile still holds any of the conditions to be removed. */
export function hasConditions(person: Soldier) {
  return (
    person.exemptions.length > 0 ||
    person.qualifications.length > 0 ||
    person.inactivePeriods.length > 0 ||
    Boolean(person.gender) ||
    (person.capabilities ?? []).length > 0 ||
    (person.allowedHours ?? []).length > 0
  );
}

/** The soldier's approvals, each with its reason replaced. */
export function scrubApprovals(approvals: unknown, soldierId?: string) {
  let changed = false;
  const next = list(approvals).map((item) => {
    const approval = object(item);
    if (
      !approval ||
      (soldierId !== undefined && approval.soldierId !== soldierId) ||
      approval.reason === ERASED_REASON
    )
      return item;
    changed = true;
    return { ...approval, reason: ERASED_REASON };
  });
  return changed ? next : undefined;
}

/** What an erasure changed in a record: the new data, or nothing. */
export type Scrubbed = Json | undefined;

/** An approved, pending, rejected or declared constraint keeps its dates, never its reasons. */
export function scrubConstraint(data: Json, at: string): Scrubbed {
  const versions = ["pending", "approved", "rejected", "declared"] as const;
  const hasReason = (value: unknown) =>
    value !== undefined && value !== null && value !== "";
  if (
    !versions.some((key) => hasReason(object(data[key])?.reason)) &&
    !hasReason(data.decisionReason)
  )
    return undefined;
  const next: Json = { ...data, erasedAt: at };
  for (const key of versions) {
    const version = object(data[key]);
    if (version) next[key] = without(version, "reason");
  }
  delete next.decisionReason;
  return next;
}

/** Candidate entry of a lottery draw: the score and status stay, the reasons do not. */
export function scrubLotteryAttempt(data: Json, soldierId: string): Scrubbed {
  let changed = false;
  const next: Json = { ...data };
  const candidates = list(data.candidates).map((item) => {
    const entry = object(item);
    if (
      !entry ||
      entry.id !== soldierId ||
      (list(entry.blockers).length === 0 &&
        list(entry.approvalsRequired).length === 0)
    )
      return item;
    changed = true;
    return { ...entry, blockers: [], approvalsRequired: [] };
  });
  if (changed) next.candidates = candidates;
  if (data.candidateId === soldierId) {
    if (list(data.requirements).length) {
      next.requirements = [];
      changed = true;
    }
    if (data.reason !== undefined) {
      delete next.reason;
      changed = true;
    }
    // A proposal for a deleted soldier can no longer be approved.
    if (data.status === "approval_required") {
      next.status = "stale";
      changed = true;
    }
  }
  return changed ? next : undefined;
}

export function scrubLotteryExclusion(data: Json): Scrubbed {
  return data.reason === undefined ? undefined : without(data, "reason");
}

export function scrubAssignmentApproval(data: Json): Scrubbed {
  const approvals = scrubApprovals(data.approvals);
  return approvals ? { ...data, approvals } : undefined;
}

const requestTexts = ["reason", "approvalReason", "allocationReason"] as const;
/**
 * A transfer, swap or cancellation request that concerns the soldier. The
 * requester's own reasons, the decision's reason and the approvals of the
 * soldier's exceptions are removed; the status and the dates stay.
 */
export function scrubRequest(
  data: Json,
  soldierId: string,
  isSubject: boolean,
  at: string
): Scrubbed {
  const candidates = list(data.candidates).map(object);
  const owner =
    isSubject ||
    data.soldierId === soldierId ||
    data.fromSoldierId === soldierId;
  const candidate =
    data.acceptedBy === soldierId ||
    candidates.some((entry) => entry?.soldierId === soldierId);
  if (!owner && !candidate) return undefined;
  const next: Json = { ...data };
  let changed = false;
  const drop = (...keys: string[]) => {
    for (const key of keys)
      if (next[key] !== undefined) {
        delete next[key];
        changed = true;
      }
  };
  const note = (key: string) => {
    if (typeof next[key] === "string" && next[key] !== ERASED_NOTE) {
      next[key] = ERASED_NOTE;
      changed = true;
    }
  };
  if (owner) drop(...requestTexts);
  note("decisionReason");
  note("closedReason");
  const decision = object(next.decision);
  if (decision?.reason && decision.reason !== ERASED_REASON) {
    next.decision = { ...decision, reason: ERASED_REASON };
    changed = true;
  }
  const approvals = scrubApprovals(next.approvals, soldierId);
  if (approvals) {
    next.approvals = approvals;
    changed = true;
  }
  if (list(next.managerReasons).length) {
    const reasons = list(next.managerReasons);
    // Swap reasons name the side they concern; a transfer's concern its replacement.
    const kept =
      data.type === "swap"
        ? reasons.filter((item) => object(item)?.soldierId !== soldierId)
        : candidate
          ? []
          : reasons;
    if (kept.length !== reasons.length) {
      next.managerReasons = kept;
      changed = true;
    }
  }
  if (
    candidates.some(
      (entry) => entry?.soldierId === soldierId && entry.closedReason
    )
  ) {
    next.candidates = list(data.candidates).map((item) => {
      const entry = object(item);
      return entry?.soldierId === soldierId && entry.closedReason
        ? { ...entry, closedReason: ERASED_NOTE }
        : item;
    });
    changed = true;
  }
  if (changed) next.erasedAt = data.erasedAt ?? at;
  return changed ? next : undefined;
}

/** An import row of an erased soldier: row number, name, personal number and outcome. */
export function scrubImportRow(data: Json): Scrubbed {
  const keep: Json = {
    batchId: data.batchId,
    rowNumber: data.rowNumber,
    mode: data.mode,
    name: data.name,
    erased: true,
    values: { personalNumber: object(data.values)?.personalNumber },
    changes: [],
  };
  const restored = object(data.newRowRestored);
  if (restored?.action) keep.newRowRestored = { action: restored.action };
  return JSON.stringify(keep) === JSON.stringify(data) ? undefined : keep;
}

/** Whether a notification must disappear with the soldier's account. */
export function notificationIsFor(
  data: Json,
  subjectId: string | null,
  soldierId: string,
  accountId: string | undefined
) {
  return (
    subjectId === soldierId ||
    (accountId !== undefined && data.accountId === accountId)
  );
}

/** A notice that quoted a request's reason loses the quotation. */
export function scrubNotification(
  data: Json,
  requestIds: ReadonlySet<string>,
  at: string
): Scrubbed {
  if (
    typeof data.requestId !== "string" ||
    !requestIds.has(data.requestId) ||
    data.body === ERASED_NOTE
  )
    return undefined;
  return { ...data, body: ERASED_NOTE, erasedAt: at };
}

/** The values that identify a soldier's sensitive data inside a stored JSON result. */
export function needlesOf(
  soldierId: string,
  contact?: {
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  }
) {
  const escaped = (value: string) => JSON.stringify(value).slice(1, -1);
  return [
    soldierId,
    ...[contact?.email, contact?.phone, contact?.address]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => escaped(value.trim())),
  ];
}
