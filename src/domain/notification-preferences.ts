import { z } from "zod";

/**
 * Notification preferences (decision 162). Site notifications are always created;
 * the per-type switches decide only whether an email is sent. Reminder hours apply
 * to duty reminders on both channels.
 */
export const preferenceTypes = [
  "dutyReminder",
  "roundOpening",
  "roundClosing",
  "publication",
  "transfer",
  "departure",
  "operations",
] as const;
export type PreferenceType = (typeof preferenceTypes)[number];
/** Emails only managers receive; a soldier's form keeps their stored value (decision 170). */
export const managerPreferenceTypes: readonly PreferenceType[] = ["departure"];

export const MAX_REMINDERS = 3;
export const MAX_REMINDER_HOURS = 168;

export const preferencesSchema = z
  .object({
    reminderHours: z
      .array(z.number().int().min(1).max(MAX_REMINDER_HOURS))
      .max(MAX_REMINDERS)
      .refine(
        (hours) => new Set(hours).size === hours.length,
        "אין לחזור על אותה שעת תזכורת"
      )
      .transform((hours) => [...hours].sort((a, b) => b - a)),
    email: z
      .object({
        dutyReminder: z.boolean(),
        roundOpening: z.boolean(),
        roundClosing: z.boolean(),
        publication: z.boolean(),
        transfer: z.boolean(),
        departure: z.boolean(),
        // Added with decision 173; a form sent without it keeps the default.
        operations: z.boolean().default(true),
      })
      .strict(),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;

export const systemDefaults: Preferences = {
  reminderHours: [24, 2],
  email: {
    dutyReminder: true,
    roundOpening: true,
    roundClosing: true,
    publication: true,
    transfer: true,
    departure: true,
    operations: true,
  },
};

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
  "duty-reminder": "dutyReminder",
  "round-opening": "roundOpening",
  "round-closing": "roundClosing",
  publication: "publication",
  "publication-change": "publication",
  transfer: "transfer",
  departure: "departure",
  "backup-alert": "operations",
} as const satisfies Record<string, PreferenceType>;
export type EmailKind =
  (typeof mandatoryEmailKinds)[number] | keyof typeof preferenceByKind;

/** Types added after preferences were first stored (decisions 163, 170 and 173). */
const newTypeDefaults: Partial<Preferences["email"]> = {
  transfer: systemDefaults.email.transfer,
  departure: systemDefaults.email.departure,
  operations: systemDefaults.email.operations,
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

function storedPreferences(value: unknown, requireCustom = true) {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (requireCustom && data.custom !== true) return null;
  // A form saved before a type existed keeps its choices; the new type starts from the system default (decisions 163, 170 and 173).
  const parsed = preferencesSchema.safeParse({
    reminderHours: data.reminderHours,
    email:
      data.email && typeof data.email === "object"
        ? { ...newTypeDefaults, ...data.email }
        : data.email,
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
  const type = preferenceByKind[kind as keyof typeof preferenceByKind];
  if (!preferences.email[type]) return false;
  if (type === "dutyReminder")
    return (
      typeof reminderHours === "number" &&
      preferences.reminderHours.includes(reminderHours)
    );
  return true;
}
