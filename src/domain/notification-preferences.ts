import { z } from "zod";

/**
 * Notification preferences (decision 161). Site notifications are always created;
 * the per-type switches decide only whether an email is sent. Reminder hours apply
 * to duty reminders on both channels.
 */
export const preferenceTypes = [
  "dutyReminder",
  "roundOpening",
  "roundClosing",
  "publication",
] as const;
export type PreferenceType = (typeof preferenceTypes)[number];

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
  },
};

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
} as const satisfies Record<string, PreferenceType>;
export type EmailKind =
  (typeof mandatoryEmailKinds)[number] | keyof typeof preferenceByKind;

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
  const parsed = preferencesSchema.safeParse({
    reminderHours: data.reminderHours,
    email: data.email,
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
