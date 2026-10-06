import {
  MAX_REMINDERS,
  MAX_REMINDER_HOURS,
  preferenceTypes,
  managerPreferenceTypes,
  staffPreferenceTypes,
  technicalPreferenceTypes,
  type PreferenceType,
  type Reminder,
} from "../domain/notification-preferences";

export const emailTypeLabels: Record<PreferenceType, string> = {
  roundOpening: "פתיחת סבב אילוצים",
  roundClosing: "תזכורת לפני סגירת סבב, למי שלא הגיש",
  publication: "שיבוץ, שינוי או ביטול של תורנות שפורסמה",
  transfer: "החלפות והעברות של תורנויות",
  departure: "סיום שירות של חייל (לאחראים)",
  operations: "תקלות תפעול, כמו גיבוי שנכשל",
  deletion: "מחיקת חייל שנשאר בה שיבוץ או מקום שהתפנה (לאחראים)",
  restore: "שחזור המערכת מגיבוי (לאחראים ולטכני)",
};

type Row = Record<string, unknown>;

/** Hidden copies and read copies are separate states; neither is changed by an email delivery. */
export function unreadCount(notifications: Row[]) {
  return notifications.filter((row) => !row.readAt && !row.hiddenAt).length;
}

/** The form always shows this many reminder rows; an empty hours field is an unused row. */
export const reminderRowCount = MAX_REMINDERS;
export const reminderFieldName = (
  index: number,
  part: "hours" | "email" | "calendar"
) => `reminder.${index}.${part}`;

type ReminderRow = { hours: number | ""; email: boolean; calendar: boolean };
/** The stored reminders as form rows, closest last, padded with unused rows. */
export function reminderRows(value: unknown): ReminderRow[] {
  const stored = Array.isArray(value) ? (value as Row[]) : [];
  return Array.from({ length: reminderRowCount }, (_, index) => {
    const reminder = stored[index];
    return reminder
      ? {
          hours: Number(reminder.hours),
          email: reminder.email !== false,
          calendar: reminder.calendar !== false,
        }
      : { hours: "", email: true, calendar: true };
  });
}

/**
 * Mirrors the server rules so the form can explain a rejection in Hebrew. A row
 * without hours is not a reminder. When the calendar column is not shown, a reminder
 * keeps the calendar slot it has for the same hours, or is marked as by default.
 */
export function parseReminders(
  values: Row,
  currentReminders: unknown = [],
  calendarShown = true
): { reminders: Reminder[] } | { error: string } {
  const current = Array.isArray(currentReminders)
    ? (currentReminders as Row[])
    : [];
  const reminders: Reminder[] = [];
  for (let index = 0; index < reminderRowCount; index++) {
    const raw = values[reminderFieldName(index, "hours")];
    if (raw === undefined || raw === null || String(raw).trim() === "")
      continue;
    const hours = Number(raw);
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_REMINDER_HOURS)
      return {
        error: `שעות התזכורת הן מספרים שלמים בין 1 ל־${MAX_REMINDER_HOURS}.`,
      };
    reminders.push({
      hours,
      email: values[reminderFieldName(index, "email")] === true,
      calendar: calendarShown
        ? values[reminderFieldName(index, "calendar")] === true
        : current.find((reminder) => reminder.hours === hours)?.calendar !==
          false,
    });
  }
  if (
    new Set(reminders.map((reminder) => reminder.hours)).size !==
    reminders.length
  )
    return { error: "אין לחזור על אותה שעת תזכורת." };
  return { reminders };
}

/** A type the form does not show keeps its current value instead of turning off. */
export function preferencesPayload(
  values: Row,
  hidden: readonly PreferenceType[] = [],
  current: { email?: Row; reminders?: unknown } = {},
  calendarShown = true
) {
  const parsed = parseReminders(values, current.reminders, calendarShown);
  if ("error" in parsed) throw new Error(parsed.error);
  return {
    reminders: parsed.reminders,
    email: Object.fromEntries(
      preferenceTypes.map((type) => [
        type,
        hidden.includes(type)
          ? current.email?.[type] !== false
          : values[`email.${type}`] === true,
      ])
    ),
  };
}

/**
 * Types a role's form does not show: departure and deletion emails reach
 * managers only (decisions 170 and 196), operational alerts the technical
 * account only (decision 173), and the restore notice managers and the
 * technical account but not soldiers (decision 200).
 */
export function hiddenPreferenceTypes(role: unknown): PreferenceType[] {
  return preferenceTypes.filter(
    (type) =>
      (managerPreferenceTypes.includes(type) && role !== "manager") ||
      (technicalPreferenceTypes.includes(type) && role !== "technical") ||
      (staffPreferenceTypes.includes(type) &&
        role !== "manager" &&
        role !== "technical")
  );
}
