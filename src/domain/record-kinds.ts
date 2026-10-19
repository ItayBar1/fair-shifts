import { z } from "zod";

/**
 * The registry of every kind of general record (decision 237): the shape of
 * its data and what deleting a soldier does to it. A kind exists only here;
 * writing a record of another kind does not compile, and every write is
 * checked against the kind's schema, so a record never holds what its readers
 * and the deletion route do not expect.
 *
 * A schema names the fields the code relies on, with their types; a field it
 * does not name is kept as it is. Names and types follow what the code writes.
 */

export type ErasureAction = "keep" | "delete" | "scrub";
export type ErasurePolicy = { action: ErasureAction; why: string };

const id = z.string().min(1);
const text = z.string();
const time = z.string().min(1);
const count = z.number();
const flag = z.boolean();
const list = <T extends z.ZodType>(item: T) => z.array(item);
const shape = <T extends z.ZodRawShape>(fields: T) => z.looseObject(fields);
const reason = shape({ code: text, message: text });
const approval = shape({
  kind: text,
  dutyId: id,
  reason: text,
  soldierId: id,
  approvedAt: time,
  approvedBy: id,
});
const preferences = shape({
  email: shape({}).optional(),
  reminders: list(
    shape({ email: flag, hours: count, calendar: flag })
  ).optional(),
  reminderHours: list(count).optional(),
});
const constraintVersion = shape({
  version: count,
  start: time.optional(),
  end: time.optional(),
  none: flag.optional(),
  reason: text.optional(),
  submittedAt: time.optional(),
}).nullable();
const constraintFields = {
  status: text,
  pending: constraintVersion.optional(),
  approved: constraintVersion.optional(),
  rejected: constraintVersion.optional(),
  declared: constraintVersion.optional(),
  roundId: id.optional(),
  decisionReason: text.optional(),
  erasedAt: time.optional(),
};
const dutySnapshot = shape({
  id,
  name: text,
  start: time,
  end: time,
  status: text,
  slots: list(shape({ id, role: text })),
});
const rankEntry = shape({
  rankId: id,
  trackId: text,
  effectiveFrom: time,
});
const emailChange = {
  mode: text,
  status: text,
  reason: text,
  accountId: id,
  email: text.optional(),
  attempts: count.optional(),
  expiresAt: time.optional(),
  securityEpoch: count.optional(),
};

const kind = <S extends z.ZodType, A extends ErasureAction>(
  schema: S,
  action: A,
  why: string
) => ({ schema, erasure: { action, why } });

export const recordKinds = {
  audit: kind(
    shape({
      action: text,
      actorId: text.optional(),
      actorName: text.optional(),
      targetId: text.optional(),
      detailId: id.optional(),
    }),
    "keep",
    "מעטפה: מי, מה ומתי. הסיבה למחיקה נשמרת בה בהחרגה מפורשת"
  ),
  audit_detail: kind(
    shape({
      reason: text.optional(),
      changes: list(shape({ field: text })).optional(),
    }),
    "delete",
    "הפירוט האישי של אירוע ביומן"
  ),
  assignment_approval: kind(
    shape({ assignmentId: id, approvals: list(approval) }),
    "scrub",
    "נימוק האישור החריג נמחק; האישור עצמו נשאר"
  ),
  constraint: kind(
    shape(constraintFields),
    "scrub",
    "נימוקי האילוץ וההחלטה נמחקים"
  ),
  constraint_revision: kind(
    shape({ ...constraintFields, constraintId: id, recordVersion: count }),
    "scrub",
    "נימוקי האילוץ וההחלטה נמחקים"
  ),
  deletion_log_entry: kind(
    shape({ at: time, status: text, seq: count.optional() }),
    "keep",
    "תור היומן העצמאי: מזהה פנימי ומועד בלבד, בלי שם או פרטי קשר"
  ),
  departure: kind(
    shape({
      soldierId: id,
      detectedAt: time,
      releaseDate: time,
      flaggedAssignments: count,
    }),
    "keep",
    "מועד שחרור והודעת עזיבה, בלי פרטים אישיים"
  ),
  duty_change: kind(
    shape({
      dutyId: id,
      status: text,
      reason: text,
      createdBy: id,
      baseVersion: count,
      proposed: dutySnapshot,
      seats: list(
        shape({ slotId: id, soldierId: id.nullable(), extraPoints: text })
      ),
    }),
    "keep",
    "היסטוריית תורנות; הסיבה היא של האחראי"
  ),
  duty_revision: kind(
    shape({ dutyId: id, duty: dutySnapshot, assignmentIds: list(id) }),
    "keep",
    "היסטוריית תורנות"
  ),
  eligibility_catalog: kind(
    shape({ kind: text, name: text, description: text.optional() }),
    "keep",
    "קטלוג ליחידה, לא נתוני חייל"
  ),
  email_change: kind(
    shape({
      status: text.optional(),
      email: text.optional(),
      accountId: id.optional(),
      attempts: count.optional(),
      expiresAt: time.optional(),
    }),
    "delete",
    "כתובות מייל וקוד אימות"
  ),
  execution_change: kind(
    shape({
      dutyId: id,
      slotId: id,
      role: text,
      reason: text,
      actorId: id,
      recordedAt: time,
      before: list(shape({ start: time, end: time })),
      after: list(shape({ start: time, end: time })),
      outcomes: list(shape({ kind: text, soldierId: id })),
    }),
    "keep",
    "היסטוריית ביצוע וניקוד"
  ),
  import: kind(
    shape({
      status: text,
      actorId: id,
      filename: text,
      fingerprint: text,
      expiresAt: time,
      created: count,
      updated: count,
    }),
    "keep",
    "מספרים מצטברים של האצווה"
  ),
  import_restore_preview: kind(
    shape({
      actorId: id,
      batchId: id,
      batchVersion: count,
      fingerprint: text,
      expiresAt: time,
    }),
    "keep",
    "טביעות בלבד"
  ),
  import_restore_profile_revision: kind(
    shape({ before: shape({}) }),
    "delete",
    "תמונת פרופיל מלאה לפני שחזור, כולל תנאי התאמה"
  ),
  import_row: kind(
    shape({
      values: shape({}),
      changes: list(shape({ key: text.optional() })),
      batchId: id.optional(),
      rowNumber: count.optional(),
      name: text.optional(),
      mode: text.optional(),
    }),
    "scrub",
    "נשארים מספר שורה, שם, מספר זיהוי ותוצאה בלי פרטי קשר או שינויים"
  ),
  lottery_attempt: kind(
    shape({
      dutyId: id,
      status: text,
      candidateId: id.nullable(),
      candidates: list(
        shape({
          id,
          score: count,
          status: text,
          blockers: list(reason),
          approvalsRequired: list(reason),
        })
      ),
      requirements: list(reason),
    }),
    "scrub",
    "ציון וסטטוס נשארים; סיבות הפסילה ונימוק ההחלטה נמחקים"
  ),
  lottery_exclusion: kind(
    shape({ dutyId: id, reason: text.optional() }),
    "scrub",
    "נימוק הדחייה נמחק"
  ),
  notification: kind(
    shape({
      title: text.optional(),
      body: text.optional(),
      href: text.optional(),
      accountId: id.optional(),
      requestId: id.optional(),
      readAt: time.optional(),
      hiddenAt: time.optional(),
    }),
    "scrub",
    "הודעות שנשלחו לחשבון נמחקות; הודעות על בקשות שלו מאבדות את הנימוק"
  ),
  manager_return: kind(
    shape({ status: text, soldierId: id }),
    "keep",
    "פריט החלטה ביתרה של אחראי שחזר: מזהים ויתרה בלבד. פריט פתוח נסגר במחיקה"
  ),
  notification_defaults: kind(preferences, "keep", "ברירות מחדל ליחידה"),
  performance_correction: kind(
    shape({
      assignmentId: id,
      dutyId: id,
      reason: text,
      actorId: id,
      recordedAt: time,
      before: shape({ performerId: id, start: time, end: time, points: count }),
      after: shape({ performerId: id, start: time, end: time, points: count }),
      outcomes: list(shape({ status: text, soldierId: id })),
    }),
    "keep",
    "היסטוריית ביצוע וניקוד"
  ),
  personnel_change: kind(
    shape({ kind: text, reason: text, actorId: id }),
    "delete",
    "פטורים, כשירויות, אי־פעילות ותנאי התאמה שנרשמו"
  ),
  planning_run: kind(
    shape({
      start: time,
      end: time,
      status: text,
      createdBy: id,
      dutyIds: list(id),
      results: list(shape({ dutyId: id, slotId: id, status: text })),
    }),
    "keep",
    "מזהים של תורנויות ומקומות בלבד"
  ),
  rank_catalog: kind(shape({ name: text }), "keep", "קטלוג ליחידה"),
  rank_deadline: kind(
    shape({ soldierId: id, toRankId: id, dueDate: time, active: flag }),
    "keep",
    "מועד פז״ם; דרגה נשמרת"
  ),
  rank_history_revision: kind(
    shape({
      reason: text,
      actorId: id,
      personVersion: count,
      rankHistory: list(rankEntry),
    }),
    "keep",
    "היסטוריית דרגה נשמרת"
  ),
  rank_reminder: kind(
    shape({
      soldierId: id,
      status: text,
      toRankId: id,
      ruleId: id,
      dueDate: time.nullable(),
    }),
    "delete",
    "תזכורת מערכת לחייל שנמחק"
  ),
  rank_rule: kind(
    shape({
      name: text,
      track: text,
      fromRankId: id,
      toRankId: id,
      months: count,
    }),
    "keep",
    "כלל ליחידה"
  ),
  rank_rule_revision: kind(
    shape({ ruleId: id, ruleVersion: count, name: text }),
    "keep",
    "כלל ליחידה"
  ),
  rank_track: kind(shape({ name: text }), "keep", "מסלול דרגות ליחידה"),
  request: kind(
    shape({
      type: text,
      status: text,
      dutyId: id.optional(),
      candidates: list(shape({ soldierId: id, status: text })).optional(),
      approvals: list(approval).optional(),
      managerReasons: list(reason).optional(),
    }),
    "scrub",
    "נימוקי בקשה, החלטה ואישור חריג נמחקים; הסטטוס נשאר"
  ),
  round: kind(
    shape({
      name: text,
      status: text,
      opensAt: time,
      closesAt: time,
      targetStart: time,
      targetEnd: time,
    }),
    "keep",
    "סבב ליחידה"
  ),
  round_notice: kind(
    shape({
      roundId: id,
      phase: text,
      status: text,
      generation: count,
      at: time,
    }),
    "keep",
    "מי קיבל הודעה, בלי תוכן"
  ),
  score_decision: kind(
    shape({ assignmentId: id, status: text }),
    "keep",
    "היסטוריית ניקוד"
  ),
  score_preview: kind(
    shape({
      actorId: id,
      expiresAt: time,
      input: shape({ operation: text, soldierIds: list(id) }),
      rows: list(shape({ soldierId: id, before: count, after: count })),
    }),
    "keep",
    "תצוגה מקדימה זמנית"
  ),
  seat_execution: kind(
    shape({
      dutyId: id,
      slotId: id,
      updatedAt: time,
      updatedBy: id,
      executionIds: list(id),
    }),
    "keep",
    "היסטוריית ביצוע"
  ),
  settings: kind(
    preferences.extend({ accountId: id, custom: flag }),
    "delete",
    "העדפות אישיות של חשבון שנמחק"
  ),
  technical_email_change: kind(
    shape(emailChange),
    "keep",
    "בקשה להחלפת כתובת של החשבון הטכני, שאינו חייל ואינו נמחק; אחרי הטיפול נשארים סטטוס וסיבה בלבד"
  ),
  manager_email_change: kind(
    shape(emailChange),
    "delete",
    "כתובות וקודי אימות של אחראי שנמחק"
  ),
} as const;

export type RecordKind = keyof typeof recordKinds;
/** The kinds a soldier's deletion changes; each needs a handler there. */
export type ErasedKind = {
  [K in RecordKind]: (typeof recordKinds)[K]["erasure"]["action"] extends "keep"
    ? never
    : K;
}[RecordKind];

export const isRecordKind = (value: string): value is RecordKind =>
  Object.hasOwn(recordKinds, value);

/** The data checked against its kind's schema; the problems name fields, never values. */
export function checkRecordData(
  kind: RecordKind,
  data: unknown
):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; problems: string[] } {
  const result = recordKinds[kind].schema.safeParse(data);
  if (result.success)
    return { ok: true, data: result.data as Record<string, unknown> };
  return {
    ok: false,
    problems: result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(data)"}: ${issue.code}`
    ),
  };
}
