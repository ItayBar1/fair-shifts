import {
  MAX_REMINDERS,
  MAX_REMINDER_HOURS,
  preferenceTypes,
  managerPreferenceTypes,
  staffPreferenceTypes,
  technicalPreferenceTypes,
  type PreferenceType,
} from "../domain/notification-preferences";

export const emailTypeLabels: Record<PreferenceType, string> = {
  dutyReminder: "תזכורת לפני תורנות",
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

export function reminderHoursText(value: unknown) {
  return Array.isArray(value) ? value.join(", ") : "";
}

/** Mirrors the server rules so the form can explain a rejection in Hebrew. */
export function parseReminderHours(
  text: string
): { hours: number[] } | { error: string } {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const hours = parts.map(Number);
  if (
    hours.some(
      (hour) => !Number.isInteger(hour) || hour < 1 || hour > MAX_REMINDER_HOURS
    )
  )
    return {
      error: `שעות התזכורת הן מספרים שלמים בין 1 ל־${MAX_REMINDER_HOURS}.`,
    };
  if (new Set(hours).size !== hours.length)
    return { error: "אין לחזור על אותה שעת תזכורת." };
  if (hours.length > MAX_REMINDERS)
    return { error: `אפשר לבחור עד ${MAX_REMINDERS} תזכורות.` };
  return { hours };
}

/** A type the form does not show keeps its current value instead of turning off. */
export function preferencesPayload(
  values: Row,
  hidden: readonly PreferenceType[] = [],
  current: Row = {}
) {
  const parsed = parseReminderHours(String(values.reminderHours ?? ""));
  if ("error" in parsed) throw new Error(parsed.error);
  return {
    reminderHours: parsed.hours,
    email: Object.fromEntries(
      preferenceTypes.map((type) => [
        type,
        hidden.includes(type)
          ? current[type] !== false
          : values[`email.${type}`] === true,
      ])
    ),
  };
}

/**
 * Types a role's form does not show: departure and deletion emails reach
 * managers only (decisions 170 and 196), operational alerts the technical
 * account only (decision 173), and the restore notice managers and the
 * technical account but not soldiers (decision 199).
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
