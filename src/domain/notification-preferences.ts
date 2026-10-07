import { z } from "zod";

/**
 * Notification preferences (decisions 162 and 195). Site notifications are always
 * created; the per-type switches decide only whether an email is sent. Each duty
 * reminder carries its own channel slots: the site (always), the email and the
 * Google calendar of the soldier.
 */
export const preferenceTypes = [
  "roundOpening",
  "roundClosing",
  "publication",
  "transfer",
  "departure",
  "operations",
  "deletion",
  "restore",
] as const;
export type PreferenceType = (typeof preferenceTypes)[number];
/** Emails only managers receive; a soldier's form keeps their stored value (decision 170). */
export const managerPreferenceTypes: readonly PreferenceType[] = [
  "departure",
  "deletion",
];
/** Emails the managers and the technical account receive, and soldiers never do (decision 200). */
export const staffPreferenceTypes: readonly PreferenceType[] = ["restore"];

export const MAX_REMINDERS = 3;
export const MAX_REMINDER_HOURS = 168;

/** One reminder before a duty and where it is delivered besides the site (decision 195). */
export const reminderSchema = z
  .object({
    hours: z.number().int().min(1).max(MAX_REMINDER_HOURS),
    email: z.boolean(),
    calendar: z.boolean(),
  })
  .strict();
export type Reminder = z.infer<typeof reminderSchema>;

export const preferencesSchema = z
  .object({
    reminders: z
      .array(reminderSchema)
      .max(MAX_REMINDERS)
      .refine(
        (reminders) =>
          new Set(reminders.map((reminder) => reminder.hours)).size ===
          reminders.length,
        "אין לחזור על אותה שעת תזכורת"
      )
      .transform((reminders) =>
        [...reminders].sort((a, b) => b.hours - a.hours)
      ),
    email: z
      .object({
        roundOpening: z.boolean(),
        roundClosing: z.boolean(),
        publication: z.boolean(),
        transfer: z.boolean(),
        departure: z.boolean(),
        // Added with decision 173; a form sent without it keeps the default.
        operations: z.boolean().default(true),
        // Added with decision 196, like operations.
        deletion: z.boolean().default(true),
        // Added with decision 200, like operations.
        restore: z.boolean().default(true),
      })
      .strict(),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;

export const systemDefaults: Preferences = {
  reminders: [
    { hours: 24, email: true, calendar: true },
    { hours: 2, email: true, calendar: true },
  ],
  email: {
    roundOpening: true,
    roundClosing: true,
    publication: true,
    transfer: true,
    departure: true,
    operations: true,
    deletion: true,
    restore: true,
  },
};

/** The reminder hours of a form, closest last, as the schedule of site reminders uses them. */
export function reminderHours(preferences: Pick<Preferences, "reminders">) {
  return preferences.reminders.map((reminder) => reminder.hours);
}

/** Operational alerts go to the technical account only (decision 173). */
export const technicalPreferenceTypes: readonly PreferenceType[] = [
  "operations",
];

/** Security and account emails are never subject to preferences. */
export const mandatoryEmailKinds = [
  "login-code",
  "invitation",
  "email-change",
] as const;
const preferenceByKind = {
  "round-opening": "roundOpening",
  "round-closing": "roundClosing",
  publication: "publication",
  "publication-change": "publication",
  "publication-digest": "publication",
  transfer: "transfer",
  departure: "departure",
  deletion: "deletion",
  restore: "restore",
  "backup-alert": "operations",
} as const satisfies Record<string, PreferenceType>;
export type EmailKind =
  | (typeof mandatoryEmailKinds)[number]
  | keyof typeof preferenceByKind
  // Decided by the email slot of the reminder with the same hours (decision 195).
  | "duty-reminder";

/** Types added after preferences were first stored (decisions 163, 170, 173, 196 and 200). */
const newTypeDefaults: Partial<Preferences["email"]> = {
  transfer: systemDefaults.email.transfer,
  departure: systemDefaults.email.departure,
  operations: systemDefaults.email.operations,
  deletion: systemDefaults.email.deletion,
  restore: systemDefaults.email.restore,
};

export type PreferenceSource = "personal" | "unit" | "system";

/**
 * Whole-form semantics: a saved personal form is used as a unit, and unit defaults
 * apply only to accounts that have not saved one (or returned to the defaults).
 */
export function resolvePreferences(
  personal: unknown,
  unit: unknown
): { preferences: Preferences; source: PreferenceSource } {
  const own = storedPreferences(personal);
  if (own) return { preferences: own, source: "personal" };
  const defaults = storedPreferences(unit, false);
  if (defaults) return { preferences: defaults, source: "unit" };
  return { preferences: systemDefaults, source: "system" };
}

/**
 * A form saved before decision 195 has plain hours and one email switch for the duty
 * reminder. It becomes one reminder per hour: the email slot follows the old switch
 * and the calendar slot is marked, as every reminder is by default.
 */
function remindersOf(data: Record<string, unknown>, email: unknown) {
  if (Array.isArray(data.reminders)) return data.reminders;
  if (!Array.isArray(data.reminderHours)) return data.reminders;
  const reminderEmail =
    !email ||
    typeof email !== "object" ||
    (email as Record<string, unknown>).dutyReminder !== false;
  return data.reminderHours.map((hours) => ({
    hours,
    email: reminderEmail,
    calendar: true,
  }));
}

function storedPreferences(value: unknown, requireCustom = true) {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (requireCustom && data.custom !== true) return null;
  const stored =
    data.email && typeof data.email === "object"
      ? (data.email as Record<string, unknown>)
      : undefined;
  // A form saved before a type existed keeps its choices; the new type starts from the system default (decisions 163, 170, 173, 196 and 200).
  // The old switch of the duty reminder email is not an email type any more.
  const merged: Record<string, unknown> = { ...newTypeDefaults, ...stored };
  const { dutyReminder: _dutyReminder, ...email } = merged;
  void _dutyReminder;
  const parsed = preferencesSchema.safeParse({
    reminders: remindersOf(data, stored),
    email: stored ? email : data.email,
  });
  return parsed.success ? parsed.data : null;
}

/** Checked immediately before delivery, against the current preferences. */
export function emailAllowed(
  preferences: Preferences,
  kind: EmailKind,
  reminderHours?: number | null
): boolean {
  if ((mandatoryEmailKinds as readonly string[]).includes(kind)) return true;
  if (kind === "duty-reminder")
    return (
      typeof reminderHours === "number" &&
      preferences.reminders.some(
        (reminder) => reminder.hours === reminderHours && reminder.email
      )
    );
  const type = preferenceByKind[kind as keyof typeof preferenceByKind];
  return preferences.email[type];
}
