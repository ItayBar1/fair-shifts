import { z } from "zod";
export const id = z.string().uuid();
export const text = z.string().trim().min(1).max(500);
export const date = z.iso.date();
export const instant = z.iso.datetime({ offset: true });
export const population = z.enum(["mandatory", "career", "academic"]);
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
export const profileInput = z.object({
  id: id.optional(),
  name: text,
  personalNumber: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/, "מספר אישי חייב להכיל ספרות"),
  email: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.email().optional()
  ),
  currentScore: z.number().int().nonnegative().max(2147483647).optional(),
  phone: z.string().max(30).optional(),
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
});
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
