import { z } from "zod";
import { splitRankChoice } from "../domain/rank-tracks";
export const id = z.string().uuid();
export const text = z.string().trim().min(1).max(500);
export const date = z.iso.date();
export const instant = z.iso.datetime({ offset: true });
export const population = z.enum(["mandatory", "career", "academic"]);
export const gender = z.enum(["male", "female", "other"]);
const optionalDate = z.preprocess(
  (value) => (value === "" ? undefined : value),
  date.optional()
);
export const commandSchema = z.object({
  type: z.string().min(1).max(80),
  payload: z.record(z.string(), z.unknown()).default({}),
  expectedVersion: z.number().int().positive().optional(),
  idempotencyKey: z.string().uuid(),
});
export type Command = z.infer<typeof commandSchema>;
/** Separators people type are dropped before the check. */
export function normalizePhone(value: string) {
  return value.replace(/[\s\-().]/g, "");
}
/** An Israeli mobile number, or an international one with its + prefix (decision 222). */
export const phone = z
  .string()
  .transform(normalizePhone)
  .pipe(
    z
      .string()
      .regex(
        /^(05\d{8}|\+\d{8,15})$/,
        "נדרש טלפון נייד ישראלי בן 10 ספרות שמתחיל ב־05, או מספר בינלאומי שמתחיל ב־+"
      )
  );
const personName = z.string().trim().min(1).max(100);
// Names, gender and phone are required when a soldier is created (decision
// 222); an edit that leaves one out keeps the stored value.
const blank = (value: unknown) =>
  typeof value === "string" && !value.trim() ? undefined : value;
export const profileInput = z.object({
  id: id.optional(),
  firstName: z.preprocess(blank, personName.optional()),
  lastName: z.preprocess(blank, personName.optional()),
  gender: z.preprocess(blank, gender.optional()),
  email: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.email().optional()
  ),
  currentScore: z.number().int().nonnegative().max(2147483647).optional(),
  phone: z.preprocess(blank, phone.optional()),
  address: z.string().max(500).optional(),
  population: population.default("mandatory"),
  serviceType: z.enum(["mandatory", "career"]).default("mandatory"),
  arrivalDate: optionalDate,
  enlistmentDate: optionalDate,
  releaseDate: optionalDate,
  officerDate: optionalDate,
  permanentDate: optionalDate,
  graceEligible: z.boolean().default(false),
  rankTrack: z.string().max(100).optional(),
  /** The manager saw the same-name warning and saves anyway. */
  duplicateNameConfirmed: z.boolean().optional(),
});
/** Initial rank is optional, but a chosen rank always has an explicit date. */
export const initialRankInput = z
  .preprocess(
    splitRankChoice,
    z.object({
      rankId: z.preprocess(blank, id.optional()),
      trackId: z.preprocess(blank, z.string().trim().min(1).optional()),
      rankEffectiveDate: optionalDate,
    })
  )
  .refine(
    (input) => Boolean(input.rankId) === Boolean(input.rankEffectiveDate),
    {
      message: "יש לבחור דרגה ותאריך תחולה יחד, או להשאיר את שניהם ריקים",
      path: ["rankEffectiveDate"],
    }
  );
// The technical form asks for the same required details as any intake
// (decision 222); extra fields cannot grant roles, edit a person, supply a
// balance or attach sensitive personnel information.
export const technicalUserInput = profileInput
  .pick({
    firstName: true,
    lastName: true,
    gender: true,
    email: true,
    phone: true,
  })
  .extend({
    firstName: personName,
    lastName: personName,
    gender,
    email: z.email(),
    phone,
    duplicateNameConfirmed: z.boolean().optional(),
  })
  .strict();
/** The full name shown everywhere, from its two required parts. */
export function fullName(firstName: string, lastName: string) {
  return `${firstName.trim()} ${lastName.trim()}`;
}
/** Two people count as the same name when first and last name match (decision 222). */
export function nameKey(firstName: string, lastName: string) {
  return fullName(firstName, lastName)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
export const scoreInput = z.object({
  soldierIds: z.array(id).min(1).max(500),
  operation: z.enum(["add", "subtract", "set", "percent"]),
  value: z.number().finite().min(0).max(1000000),
  reason: text,
  token: id.optional(),
});
export const roundInput = z.object({
  name: text,
  opensAt: instant,
  closesAt: instant,
  targetStart: date,
  targetEnd: date,
});
export const constraintItemInput = z.object({
  startDate: date,
  endDate: date,
  reason: z.string().trim().min(1).max(2000),
});
export const constraintInput = z.object({
  id: id.optional(),
  roundId: id,
  soldierId: id.optional(),
  startDate: date.optional(),
  endDate: date.optional(),
  reason: z.string().trim().max(2000).optional(),
  none: z.boolean().default(false),
  items: z.array(constraintItemInput).min(1).max(100).optional(),
  existingVersions: z
    .array(z.object({ id, version: z.number().int().positive() }))
    .max(500)
    .optional(),
});
export const requestInput = z.object({
  kind: z.enum(["transfer", "swap", "cancel", "defer"]),
  assignmentId: id,
  targetSoldierId: id.optional(),
  targetAssignmentId: id.optional(),
  reason: z.string().trim().max(2000).optional(),
});
