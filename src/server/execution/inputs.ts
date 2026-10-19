import { z } from "zod";
import { AppError } from "../errors";
import { id, text } from "../validation";
import { parseMoment } from "../duty-service";
import { approvalKey } from "../seat-requests";
import type { EligibilityReason } from "../../domain/types";

const segmentInput = z.object({
  soldierId: id.nullable(),
  start: text,
  end: text,
  startOffset: z.number().optional(),
  endOffset: z.number().optional(),
});
export const amount = z
  .string()
  .trim()
  .max(30)
  .regex(/^\d+(?:\.\d+)?$/);
export const fixedAllocationInput = z.object({
  soldierId: id,
  fixedBase: amount.optional(),
  fixedExtra: amount,
});
export type FixedAllocation = z.infer<typeof fixedAllocationInput>;
export const executionInput = z.object({
  dutyId: id,
  slotId: id,
  segments: z.array(segmentInput).min(1).max(24),
  allocations: z.array(fixedAllocationInput).max(24).optional(),
  reason: text,
  reviewPending: z.boolean().default(false),
  approvalReason: z.string().trim().max(2000).optional(),
  approvalKeys: z.array(z.string().max(300)).max(100).default([]),
  token: z.string().max(128).optional(),
});

/** An approval key names the soldier, so each performer's exception is approved on its own. */
export const segmentApprovalKey = (
  soldierId: string,
  reason: EligibilityReason
) => `${soldierId}:${approvalKey(reason)}`;

export const MANUAL_EXCEPTIONS = [
  "exemption",
  "rank",
  "allowed_hours",
  "pending_constraint",
  "near_release",
];
export const VOLUNTEER_EXCEPTIONS = ["exemption", "rank"];

export function parseSegments(input: z.infer<typeof executionInput>) {
  try {
    return input.segments.map((segment) => ({
      soldierId: segment.soldierId,
      start: parseMoment(segment.start, segment.startOffset),
      end: parseMoment(segment.end, segment.endOffset),
    }));
  } catch (error) {
    throw new AppError(
      "invalid_segments",
      error instanceof Error ? error.message : "מועד לא תקין",
      422
    );
  }
}

export const handoverInput = {
  handoverAt: z.string().max(40).optional(),
  handoverOffset: z.number().optional(),
};

export function parseHandover(value?: string, offset?: number) {
  if (!value) return undefined;
  try {
    return parseMoment(value, offset);
  } catch (error) {
    throw new AppError(
      "invalid_handover",
      error instanceof Error ? error.message : "מועד החילוף אינו תקין",
      422
    );
  }
}
