import { DateTime } from "luxon";
import type { records } from "./schema";
import { UNIT_ZONE, effectiveDiffers } from "../domain/time";
import { emailTypeLabels } from "../client/notifications";

type Record_ = typeof records.$inferSelect;
type Data = Record<string, unknown>;
export type AuditAccount = {
  id: string;
  name: string;
  role: string;
  soldierId?: string | null;
};
export type AuditContext = {
  /** Every workflow record, to resolve the records an envelope points to. */
  workflows: Record_[];
  soldiers: { id: string; name: string }[];
  duties: { id: string; name: string }[];
  dutyTypes: { id: string; name: string }[];
  assignments: { id: string; dutyId: string; soldierId: string }[];
  accounts: AuditAccount[];
};
export type AuditChange = { label: string; before: string; after: string };
export type AuditEntry = {
  id: string;
  action: string;
  label: string;
  category: "business" | "account";
  recordedAt: string;
  /** Business effective time, present only when it differs from the recording time. */
  effectiveAt?: string;
  actorId: string;
  actorName: string;
  actorRole?: string;
  targetId: string;
  soldierId?: string;
  soldierName?: string;
  dutyId?: string;
  dutyName?: string;
  assignmentId?: string;
  /** Business version the event produced, e.g. the duty version after publishing. */
  version?: number;
  reason?: string;
  details: { label: string; value: string }[];
  changes: AuditChange[];
  /** The personal detail was erased; the envelope remains. */
  detailRemoved: boolean;
  /** Ids an entry is reachable from: soldier, duty, assignment, decision, batch… */
  refs: string[];
};

const labels: Record<string, string> = {
  "round.create": "פתיחת סבב אילוצים",
  "round.close": "סגירת סבב אילוצים",
  "round.reopen": "פתיחה מחדש של סבב אילוצים",
  "constraint.submit": "הגשת אילוץ",
  "constraint.declare_none": "הצהרה שאין אילוצים",
  "constraint.review": "החלטה באילוץ",
  "dutyType.create": "יצירת סוג תורנות",
  "dutyType.update": "עדכון סוג תורנות",
  "duty.create": "יצירת תורנות",
  "duty.assign": "שיבוץ ידני",
  "duty.publish": "פרסום תורנות",
  "duty.publish.batch": "פרסום כמה תורנויות",
  "duty.change.create": "פתיחת הצעת שינוי",
  "duty.change.save": "שמירת הצעת שינוי",
  "duty.change.rules": "עריכת הרכב ותמחור בהצעת שינוי",
  "duty.change.discard": "ביטול הצעת שינוי",
  "duty.update.publish": "עדכון ופרסום תורנות",
  "duty.update.draft": "החלת שינוי בטיוטה",
  "duty.cancel": "ביטול תורנות",
  "assignment.gender_flag.clear": "ניקוי סימון מגדר שנבע מתנאי עם כל המגדרים",
  "lottery.draw": "הגרלה",
  "planning.create": "התחלת תכנון תקופה",
  "planning.complete": "סיום תכנון תקופה",
  "performance.correct": "תיקון ביצוע עבר",
  "score.apply": "שינוי יתרה",
  "score.decision": "הכרעה בתיקון שממתין",
  "manager.return.keep": "השארת היתרה של אחראי שחזר",
  "soldier.create": "קליטת חייל",
  "account.create": "הוספת משתמש בידי המנהל הטכני",
  "soldier.update": "עדכון פרטי חייל",
  "soldier.delete": "מחיקת משתמש",
  "soldier.timeline": "הוספת תקופה בפרופיל",
  "soldier.timeline.edit": "עריכת תקופה בפרופיל",
  "soldier.conditions": "עדכון תנאים אישיים",
  "eligibility.catalog.create": "הוספה לקטלוג פטורים וכשירויות",
  "eligibility.catalog.update": "עדכון בקטלוג פטורים וכשירויות",
  "rank.catalog.save": "עדכון קטלוג דרגות",
  "rank.rule.save": "עדכון כלל פז״ם",
  "rank.deadline": "קביעת מועד פז״ם אישי",
  "rank.set": "עדכון דרגה",
  "import.apply": "החלת ייבוא",
  "import.restore": "שחזור ייבוא",
  "import.restore.row": "שחזור שורת ייבוא",
  "notification.defaults.save": "ברירות מחדל להודעות ביחידה",
  "transfer.offer": "הצעת העברת תורנות",
  "transfer.decline": "סירוב להעברה",
  "transfer.accept.pending": "הסכמה להעברה שממתינה לאחראי",
  "transfer.complete": "השלמת העברת תורנות",
  "transfer.withdraw": "משיכת הצעת העברה",
  "transfer.retract": "ביטול הסכמה להעברה",
  "transfer.approve": "אישור אחראי להעברת תורנות",
  "transfer.reject": "דחיית העברה בידי אחראי",
  "swap.offer": "הצעת החלפת תורנויות",
  "swap.decline": "סירוב להחלפה",
  "swap.accept.pending": "הסכמה להחלפה שממתינה לאחראי",
  "swap.complete": "השלמת החלפת תורנויות",
  "swap.withdraw": "משיכת הצעת החלפה",
  "swap.retract": "ביטול הסכמה להחלפה",
  "swap.approve": "אישור אחראי להחלפת תורנויות",
  "swap.reject": "דחיית החלפה בידי אחראי",
  "cancellation.submit": "בקשת ביטול או דחייה",
  "cancellation.withdraw": "משיכת בקשת ביטול או דחייה",
  "cancellation.prepare": "הכנת שינוי לבקשת ביטול או דחייה",
  "cancellation.rejected": "דחיית בקשת ביטול או דחייה",
  "cancellation.completed": "השלמת בקשת ביטול או דחייה",
  "cancellation.referred": "הפניית בקשה לטיפול בביצוע",
  "backup.request": "בקשת גיבוי ידני",
  "restore.complete": "שחזור מגיבוי הושלם",
  "restore.deletions.apply": "החלת מחיקות מהיומן העצמאי אחרי שחזור",
  "restore.deletions.acknowledge": "פתיחת שחזור בלי יומן מחיקות מאומת",
  "account.email.request": "בקשה לשינוי מייל",
  "account.email.confirm": "אישור שינוי מייל",
  "technical.email.request": "בקשה להחלפת כתובת החשבון הטכני",
  "technical.email.confirm": "החלפת כתובת החשבון הטכני",
  "manager.email.request": "בקשה להחלפת כתובת עצמית של אחראי",
  "manager.email.confirm": "החלפת כתובת עצמית של אחראי",
  "technical.manager-email.request": "בקשה לחילוץ כתובת אחראי",
  "technical.manager-email.confirm": "חילוץ כתובת אחראי",
  "role:manager": "הענקת הרשאת אחראי",
  "role:soldier": "הסרת הרשאת אחראי",
  unlock: "שחרור חשבון נעול",
  "recovery-code": "כניסה בקוד שחזור",
  "technical.server-recovery": "שחזור גישה טכנית דרך השרת",
};
const periodKinds: Record<string, string> = {
  qualification: "כשירות",
  exemption: "פטור",
  inactive: "אי־פעילות",
  population: "מעבר אוכלוסייה",
  rank: "דרגה",
};
const populations: Record<string, string> = {
  mandatory: "חובה",
  career: "קבע / קצינים",
  academic: "קמ״א",
};
const genders: Record<string, string> = {
  male: "זכר",
  female: "נקבה",
  other: "אחר",
};
const profileLabels: Record<string, string> = {
  name: "שם",
  personalNumber: "מספר אישי",
  serviceType: "סוג שירות",
  basePopulation: "אוכלוסיית בסיס",
  arrivalDate: "הגעה ליחידה",
  enlistmentDate: "גיוס",
  releaseDate: "שחרור",
  officerFrom: "תחילת קצונה",
  permanentFrom: "כניסה לקבע",
  graceEligible: "זכאות לחסד",
  phone: "טלפון",
  address: "כתובת",
};
const responsibilities: Record<string, string> = {
  mandatory: "חובה וקמ״א",
  career: "קבע/קצינים וקמ״א",
  unset: "לא נקבע",
};
const choices: Record<string, string> = {
  keep: "ללא שינוי ביתרה",
  adjust: "הוספה או הפחתה",
  set: "קביעת יתרה",
};
const drawResults: Record<string, string> = {
  selected: "נבחר מועמד ושובץ",
  approval_required: "נבחר מועמד שממתין לאישור",
  unfilled: "אין מועמד מתאים",
  manual_only: "שיבוץ ידני בלבד",
};
const requestKinds: Record<string, string> = {
  cancel: "ביטול",
  postpone: "דחייה",
};
const requestOutcomes: Record<string, string> = {
  rejected: "נדחתה",
  removed: "החייל הוסר מהשיבוץ",
  rescheduled: "מועד התורנות שונה",
  duty_cancelled: "התורנות בוטלה",
  referred: "הופנתה לטיפול בביצוע",
};
const operations: Record<string, string> = {
  add: "הוספה",
  subtract: "הפחתה",
  set: "קביעה",
  percent: "הפחתת אחוזים",
  replace: "עריכה",
  remove: "הסרה",
};

const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
const data = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
function formatDate(value: unknown) {
  const raw = text(value);
  if (!raw) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw))
    return DateTime.fromISO(raw).toFormat("dd.MM.yyyy");
  const parsed = DateTime.fromISO(raw, { zone: UNIT_ZONE });
  return parsed.isValid
    ? parsed.setZone(UNIT_ZONE).toFormat("dd.MM.yyyy HH:mm")
    : raw;
}
function range(value: unknown) {
  const row = data(value);
  if (!row.start) return "—";
  return row.end
    ? `${formatDate(row.start)} – ${formatDate(row.end)}`
    : `מ־${formatDate(row.start)}`;
}
function accountCategory(action: string) {
  return (
    action.startsWith("role:") ||
    action.startsWith("responsibility:") ||
    action.startsWith("account.") ||
    action === "unlock" ||
    action === "recovery-code" ||
    action === "technical.server-recovery" ||
    action.startsWith("technical.email.") ||
    action.startsWith("manager.email.") ||
    action.startsWith("technical.manager-email.")
  );
}
const soldierTargets = new Set([
  "soldier.create",
  "soldier.update",
  "soldier.delete",
  "soldier.timeline",
  "soldier.timeline.edit",
  "soldier.conditions",
  "rank.set",
  "rank.deadline",
]);
const dutyTargets = new Set([
  "duty.create",
  "duty.publish",
  "duty.cancel",
  "duty.update.publish",
  "duty.update.draft",
]);

/**
 * Turns stored audit envelopes into readable entries. Personal text comes only
 * from the records an envelope references, so erasing those records leaves the
 * envelope (who, what, when) intact and marks the entry as erased.
 */
export function projectAudit(
  context: AuditContext,
  filter: (entry: AuditEntry) => boolean = () => true
): AuditEntry[] {
  const byId = new Map(context.workflows.map((row) => [row.id, row]));
  const soldierName = new Map(
    context.soldiers.map((row) => [row.id, row.name])
  );
  const dutyName = new Map(context.duties.map((row) => [row.id, row.name]));
  const typeName = new Map(context.dutyTypes.map((row) => [row.id, row.name]));
  const assignment = new Map(context.assignments.map((row) => [row.id, row]));
  const account = new Map(context.accounts.map((row) => [row.id, row]));
  const recordName = (id: unknown) =>
    text(data(byId.get(String(id))?.data).name) ?? "—";
  const person = (id: unknown) => (id && soldierName.get(String(id))) || "—";
  return context.workflows
    .filter((row) => row.kind === "audit")
    .map((row) => {
      const envelope = row.data;
      const action = String(envelope.action);
      const actorId = String(envelope.actorId);
      const recordedAt = row.createdAt.toISOString();
      const referenced = (key: string) => {
        const id = envelope[key];
        return typeof id === "string" ? byId.get(id) : undefined;
      };
      // Pointed at a record that is gone or erased: the personal part was removed.
      const missing = (key: string) => {
        if (typeof envelope[key] !== "string") return false;
        const found = referenced(key);
        return !found || Boolean(found.data.erasedAt);
      };
      const record = data(referenced("recordId")?.data);
      const detail = data(referenced("detailId")?.data);
      const target = data(byId.get(String(envelope.targetId))?.data);
      const details: AuditEntry["details"] = [];
      const changes: AuditChange[] = [];
      const add = (label: string, value: unknown) => {
        const shown = text(value);
        if (shown !== undefined && shown !== "")
          details.push({ label, value: shown });
      };
      const change = (label: string, before: unknown, after: unknown) =>
        changes.push({
          label,
          before: text(before) ?? "—",
          after: text(after) ?? "—",
        });
      let soldierId =
        text(envelope.soldierId) ??
        row.subjectId ??
        (soldierTargets.has(action) ? text(envelope.targetId) : undefined);
      let dutyId =
        text(envelope.dutyId) ??
        (dutyTargets.has(action) ? text(envelope.targetId) : undefined);
      const assignmentId =
        text(envelope.assignmentId) ??
        (["duty.assign", "performance.correct"].includes(action)
          ? text(envelope.targetId)
          : undefined);
      const seat = assignmentId ? assignment.get(assignmentId) : undefined;
      soldierId ??= seat?.soldierId;
      dutyId ??= seat?.dutyId;
      let reason: string | undefined;
      let effectiveAt: string | undefined;
      let label = labels[action] ?? action;
      const refs = new Set<string>();
      switch (action) {
        case "round.reopen":
          add("נסגר ב־", formatDate(envelope.closesAt));
          break;
        case "constraint.review":
          add("החלטה", envelope.decision === "approved" ? "אושר" : "נדחה");
          reason = text(detail.reason);
          break;
        case "duty.assign":
          add("נקודות", envelope.points);
          break;
        case "duty.publish.batch": {
          const ids = (key: string) =>
            Array.isArray(envelope[key]) ? envelope[key].map(String) : [];
          add("תורנויות שפורסמו", ids("dutyIds").length);
          add("נשארו טיוטה", ids("blockedIds").length);
          for (const dutyRef of [...ids("dutyIds"), ...ids("blockedIds")])
            refs.add(dutyRef);
          break;
        }
        case "duty.change.save":
        case "duty.change.rules":
        case "duty.change.create":
          reason = text(target.reason);
          break;
        case "duty.update.publish":
        case "duty.update.draft":
        case "duty.cancel": {
          if (envelope.previousVersion !== undefined)
            change("גרסת התורנות", envelope.previousVersion, envelope.version);
          const proposal = data(byId.get(String(envelope.changeId))?.data);
          reason =
            text(record.reason) ??
            text(proposal.reason) ??
            text(envelope.reason);
          break;
        }
        case "lottery.draw":
          add("תוצאה", drawResults[String(envelope.status)] ?? envelope.status);
          break;
        case "planning.complete":
          add("מקומות שנותרו פנויים", envelope.missing);
          break;
        case "performance.correct": {
          const correction = data(
            byId.get(String(envelope.correctionId))?.data
          );
          const before = data(correction.before);
          const after = data(correction.after);
          if (before.performerId !== after.performerId)
            change(
              "מבצע",
              person(before.performerId),
              person(after.performerId)
            );
          if (before.start !== after.start)
            change("התחלה", formatDate(before.start), formatDate(after.start));
          if (before.end !== after.end)
            change("סיום", formatDate(before.end), formatDate(after.end));
          if (before.points !== after.points)
            change("שווי ביצוע", before.points, after.points);
          reason = text(correction.reason);
          effectiveAt = text(after.end);
          soldierId ??= text(after.performerId);
          if (typeof after.performerId === "string")
            refs.add(after.performerId);
          break;
        }
        case "score.apply": {
          const input = data(target.input);
          const rows = Array.isArray(target.rows) ? target.rows.map(data) : [];
          if (rows.length > 1) label = "נרמול יתרות";
          add("פעולה", operations[String(input.operation)] ?? input.operation);
          add("ערך", input.value);
          add("חיילים", rows.length || envelope.count);
          if (rows.length === 1) {
            soldierId ??= text(rows[0].soldierId);
            change("יתרה", rows[0].before, rows[0].after);
          }
          for (const item of rows)
            if (typeof item.soldierId === "string") refs.add(item.soldierId);
          reason = text(input.reason);
          break;
        }
        case "manager.return.keep":
          add("הכרעה", "ללא שינוי ביתרה");
          add("יתרה", record.balanceAtReturn);
          reason = text(record.reason);
          break;
        case "score.decision": {
          const resolution = data(target.resolution);
          add("הכרעה", choices[String(envelope.choice)] ?? envelope.choice);
          change("יתרה", envelope.before, envelope.after);
          reason = text(resolution.reason);
          break;
        }
        case "soldier.update": {
          const listed = Array.isArray(detail.changes)
            ? detail.changes.map(data)
            : [];
          for (const item of listed) {
            const field = String(item.field);
            const format = (value: unknown) =>
              field === "graceEligible"
                ? value
                  ? "כן"
                  : "לא"
                : field === "serviceType" || field === "basePopulation"
                  ? (populations[String(value)] ?? value)
                  : /Date|From$/.test(field)
                    ? value
                      ? formatDate(value)
                      : "—"
                    : value;
            change(
              profileLabels[field] ?? field,
              format(item.before),
              format(item.after)
            );
          }
          if (!listed.length && Array.isArray(envelope.fields))
            add(
              "שדות",
              envelope.fields
                .map((field) => profileLabels[String(field)] ?? field)
                .join(", ")
            );
          break;
        }
        case "soldier.timeline": {
          const kind = String(record.kind ?? envelope.kind ?? "");
          add("סוג", periodKinds[kind]);
          const value =
            kind === "population"
              ? populations[String(record.value)]
              : kind === "rank" ||
                  kind === "qualification" ||
                  kind === "exemption"
                ? recordName(record.value)
                : undefined;
          add("ערך", value);
          if (record.startDate)
            add(
              "תקופה",
              range({ start: record.startDate, end: record.endDate })
            );
          reason = text(record.reason);
          effectiveAt = text(record.startDate);
          break;
        }
        case "soldier.timeline.edit": {
          const kind = String(record.kind ?? envelope.kind ?? "");
          add("סוג", periodKinds[kind]);
          add(
            "פעולה",
            operations[String(record.operation ?? envelope.operation)]
          );
          const catalogOf = (value: unknown) => {
            const row = data(value);
            const id = row.qualificationId ?? row.exemptionId;
            return id ? `${recordName(id)}, ` : "";
          };
          if (record.before !== undefined)
            change(
              "תקופה",
              `${catalogOf(record.before)}${range(record.before)}`,
              record.after
                ? `${catalogOf(record.after)}${range(record.after)}`
                : "הוסרה"
            );
          reason = text(record.reason);
          effectiveAt = text(
            data(record.after).start ?? data(record.before).start
          );
          break;
        }
        case "soldier.conditions": {
          const before = data(record.before);
          const after = data(record.after);
          const names = (value: unknown) =>
            Array.isArray(value) && value.length
              ? value.map(recordName).join(", ")
              : "—";
          const hours = (value: unknown) =>
            Array.isArray(value) && value.length
              ? `${value.length} הגבלות`
              : "ללא הגבלה";
          if (before.gender !== after.gender)
            change(
              "מגדר",
              genders[String(before.gender)] ?? "—",
              genders[String(after.gender)] ?? "—"
            );
          if (names(before.capabilities) !== names(after.capabilities))
            change(
              "יכולות",
              names(before.capabilities),
              names(after.capabilities)
            );
          if (
            JSON.stringify(before.allowedHours) !==
            JSON.stringify(after.allowedHours)
          )
            change(
              "טווח שעות מותר",
              hours(before.allowedHours),
              hours(after.allowedHours)
            );
          reason = text(record.reason);
          break;
        }
        case "rank.set":
          change(
            "דרגה",
            envelope.previousRankId ? recordName(envelope.previousRankId) : "—",
            recordName(envelope.rankId)
          );
          reason = text(record.reason);
          effectiveAt = text(envelope.effectiveDate);
          break;
        case "eligibility.catalog.create":
        case "eligibility.catalog.update":
        case "rank.catalog.save":
          add("שם", recordName(envelope.targetId));
          break;
        case "dutyType.create":
        case "dutyType.update":
          add("סוג", typeName.get(String(envelope.targetId)));
          break;
        case "import.apply":
          add("נקלטו", envelope.created);
          add("עודכנו", envelope.updated);
          reason = text(target.reason);
          break;
        case "import.restore":
          add("שוחזרו", envelope.changed);
          add("נשמרו", envelope.kept);
          add("קליטות שממתינות", envelope.pendingNew);
          reason = text(target.restoreReason);
          break;
        case "import.restore.row":
          if (typeof envelope.batchId === "string") refs.add(envelope.batchId);
          break;
        case "notification.defaults.save": {
          const before = data(envelope.before);
          const after = data(envelope.after);
          // Entries written before decision 195 hold plain hours and no channels.
          const reminders = (form: Record<string, unknown>) =>
            Array.isArray(form.reminders)
              ? form.reminders.map(data)
              : Array.isArray(form.reminderHours)
                ? form.reminderHours.map((hours) => ({ hours }))
                : [];
          const hours = (value: Record<string, unknown>[]) =>
            value.length
              ? value.map((reminder) => `${reminder.hours} ש׳`).join(", ")
              : "ללא";
          const beforeReminders = reminders(before);
          const afterReminders = reminders(after);
          if (
            JSON.stringify(
              beforeReminders.map((reminder) => reminder.hours)
            ) !==
            JSON.stringify(afterReminders.map((reminder) => reminder.hours))
          )
            change(
              "שעות תזכורת",
              hours(beforeReminders),
              hours(afterReminders)
            );
          const channels = (value: Record<string, unknown>[]) =>
            value
              .filter((reminder) => "email" in reminder)
              .map(
                (reminder) =>
                  `${reminder.hours} ש׳: ${[
                    "באתר",
                    reminder.email ? "מייל" : undefined,
                    reminder.calendar ? "יומן Google" : undefined,
                  ]
                    .filter(Boolean)
                    .join(", ")}`
              )
              .join("; ");
          if (channels(beforeReminders) !== channels(afterReminders))
            change(
              "ערוצי תזכורת",
              channels(beforeReminders) || "ללא שינוי ערוצים",
              channels(afterReminders) || "ללא"
            );
          const beforeEmail = data(before.email);
          const afterEmail = data(after.email);
          // The reminder switch of entries written before decision 195.
          for (const [key, title] of Object.entries({
            ...emailTypeLabels,
            dutyReminder: "תזכורת לפני תורנות",
          }))
            if (Boolean(beforeEmail[key]) !== Boolean(afterEmail[key]))
              change(
                `מייל: ${title}`,
                beforeEmail[key] ? "פעיל" : "כבוי",
                afterEmail[key] ? "פעיל" : "כבוי"
              );
          break;
        }
        case "cancellation.submit":
          add("סוג", requestKinds[String(envelope.kind ?? target.kind)]);
          reason = text(target.reason);
          break;
        case "cancellation.prepare":
        case "cancellation.rejected":
        case "cancellation.completed":
        case "cancellation.referred":
          add("תוצאה", requestOutcomes[String(envelope.outcome)]);
          reason =
            action === "cancellation.prepare"
              ? undefined
              : (text(data(target.decision).reason) ?? text(envelope.reason));
          break;
        case "transfer.offer":
          add(
            "מועמדים",
            Array.isArray(envelope.candidateIds)
              ? envelope.candidateIds.length
              : undefined
          );
          break;
        case "transfer.complete":
        case "transfer.approve": {
          const from = assignment.get(String(envelope.fromAssignmentId));
          const to = assignment.get(String(envelope.toAssignmentId));
          change("משובץ", person(from?.soldierId), person(to?.soldierId));
          add("נקודות", envelope.points);
          for (const id of [from?.soldierId, to?.soldierId])
            if (id) refs.add(id);
          // The approval reason lives on the request record, not in the audit envelope (decision 178).
          if (action === "transfer.approve" && Array.isArray(target.approvals))
            reason = text(data(target.approvals[0]).reason);
          break;
        }
        case "swap.offer":
          add(
            "שיבוצים מוצעים",
            Array.isArray(envelope.targetAssignmentIds)
              ? envelope.targetAssignmentIds.length
              : undefined
          );
          break;
        case "swap.complete":
        case "swap.approve": {
          const ids = (key: string) =>
            Array.isArray(envelope[key]) ? envelope[key].map(String) : [];
          const to = ids("toAssignmentIds");
          for (const [index, id] of ids("fromAssignmentIds").entries()) {
            const from = assignment.get(id);
            const next = assignment.get(to[index]);
            change(
              `משובץ ב${dutyName.get(String(from?.dutyId)) ?? "תורנות"}`,
              person(from?.soldierId),
              person(next?.soldierId)
            );
            for (const ref of [from?.soldierId, from?.dutyId, id, to[index]])
              if (ref) refs.add(ref);
          }
          add(
            "נקודות",
            Array.isArray(envelope.points)
              ? envelope.points.join(" / ")
              : undefined
          );
          if (action === "swap.approve" && Array.isArray(target.approvals))
            reason = text(data(target.approvals[0]).reason);
          break;
        }
        case "transfer.reject":
        case "swap.reject":
          reason = text(target.decisionReason);
          break;
        case "transfer.withdraw":
        case "transfer.retract":
        case "swap.withdraw":
        case "swap.retract":
          reason = text(target.closedReason);
          break;
        case "swap.accept.pending":
        case "transfer.accept.pending":
          add(
            "סיבות לאישור",
            Array.isArray(envelope.reasons)
              ? envelope.reasons.length
              : undefined
          );
          break;
        case "technical.server-recovery":
          reason = text(envelope.reason);
          break;
        case "technical.email.request":
        case "technical.email.confirm":
          // The technical account's own reason, not a soldier's text, so it stays in the envelope (decision 204).
          reason = text(envelope.reason);
          if (envelope.via === "server") add("דרך", "פקודת שרת");
          break;
        case "manager.email.request":
        case "manager.email.confirm":
        case "technical.manager-email.request":
        case "technical.manager-email.confirm":
          reason = text(detail.reason);
          break;
        case "soldier.delete":
          // The one reason kept past an erasure, by the user's decision (192).
          reason = text(envelope.reason);
          add("מקומות עתידיים שהתפנו", envelope.vacated);
          add("שיבוצים בתורנות שהחלה", envelope.inProgress);
          if (envelope.via === "import.restore") add("דרך", "שחזור ייבוא");
          break;
        default:
          if (action.startsWith("responsibility:")) {
            label = "עדכון תחום אחריות";
            add(
              "תחום",
              responsibilities[action.split(":")[1]] ?? action.split(":")[1]
            );
          }
      }
      const targetAccount = accountCategory(action)
        ? account.get(String(envelope.targetId))
        : undefined;
      if (targetAccount) {
        add("חשבון", targetAccount.name);
        soldierId ??= targetAccount.soldierId ?? undefined;
      }
      if (effectiveAt && !effectiveDiffers(effectiveAt, recordedAt))
        effectiveAt = undefined;
      for (const id of [
        envelope.targetId,
        soldierId,
        dutyId,
        assignmentId,
        envelope.changeId,
        envelope.correctionId,
        envelope.batchId,
        envelope.roundId,
        envelope.fromAssignmentId,
        envelope.toAssignmentId,
        envelope.recordId,
      ])
        if (typeof id === "string" && id) refs.add(id);
      const actor = account.get(actorId);
      return {
        id: row.id,
        action,
        label,
        category: accountCategory(action) ? "account" : "business",
        recordedAt,
        effectiveAt,
        actorId,
        actorName: text(envelope.actorName) ?? actor?.name ?? "—",
        actorRole: actor?.role,
        targetId: String(envelope.targetId),
        soldierId,
        soldierName: soldierId ? soldierName.get(soldierId) : undefined,
        dutyId,
        dutyName: dutyId ? dutyName.get(dutyId) : undefined,
        assignmentId,
        version:
          typeof envelope.version === "number" ? envelope.version : undefined,
        reason,
        details,
        changes,
        detailRemoved: missing("recordId") || missing("detailId"),
        refs: [...refs],
      } satisfies AuditEntry;
    })
    .filter(filter)
    .sort(
      (a, b) =>
        b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id)
    );
}

/**
 * The technical account sees account operations within its authority: what it
 * did itself and what concerns manager or technical accounts. Soldier business
 * events and soldier-account events stay with the managers.
 */
export function technicalScope(accounts: AuditAccount[]) {
  const role = new Map(accounts.map((row) => [row.id, row.role]));
  return (entry: AuditEntry) =>
    entry.category === "account" &&
    (role.get(entry.actorId) === "technical" ||
      ["manager", "technical"].includes(role.get(entry.targetId) ?? ""));
}
