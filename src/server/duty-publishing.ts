import { createHash, randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { duties } from "./schema";
import { audit, loadDomain, manager, type Actor } from "./repository";
import { invariant } from "./errors";
import { id } from "./validation";
import { publishRow } from "./duty-service";
import { publishBlock, type PublishBlock } from "../domain/publication";
import { instant } from "../domain/time";
import type { Assignment, Duty } from "../domain/types";

/** Drafts one publish covers; the same ceiling as a score change. */
const MAX_DRAFTS = 500;
const selection = z.object({ dutyIds: z.array(id).min(1).max(MAX_DRAFTS) });
const batchInput = selection.extend({
  token: z.string().min(1).max(200),
  confirmed: z.literal(true),
});

interface Judged {
  duty: Duty;
  block: PublishBlock | null;
  seats: Assignment[];
}

/** Each selected duty with whether it can be published now, by the checks of a single publish. */
async function judge(tx: DbTransaction, dutyIds: string[]): Promise<Judged[]> {
  const state = await loadDomain(tx);
  const now = Date.now();
  return [...new Set(dutyIds)]
    .map((dutyId) => {
      const duty = state.duties.find((item) => item.id === dutyId);
      invariant(duty, "not_found", "תורנות לא נמצאה", 404);
      return {
        duty,
        block: publishBlock(state, duty, now),
        seats: state.assignments.filter(
          (item) => item.dutyId === dutyId && item.status !== "cancelled"
        ),
      };
    })
    .sort(
      (a, b) =>
        instant(a.duty.start).toMillis() - instant(b.duty.start).toMillis() ||
        a.duty.id.localeCompare(b.duty.id)
    );
}

/**
 * Binds an approval to what the manager saw: every selected duty with its
 * version, whether and why it is blocked, and the seats on it. A change to any
 * of them since the preview, by either manager, makes the token differ.
 */
function previewToken(judged: Judged[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        judged.map(({ duty, block, seats }) => ({
          id: duty.id,
          version: duty.version,
          status: duty.status,
          start: duty.start,
          blocked: block && `${block.code}:${block.reason}`,
          seats: seats
            .map((seat) => [seat.id, seat.version, seat.soldierId])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        }))
      )
    )
    .digest("hex");
}

/** Shows, for each selected draft, whether it is ready to publish or blocked and why. Saves nothing. */
export async function previewPublishDrafts(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  manager(actor);
  const input = selection.parse(payload);
  const judged = await judge(tx, input.dutyIds);
  return {
    token: previewToken(judged),
    ready: judged.filter((item) => !item.block).length,
    blocked: judged.filter((item) => item.block).length,
    duties: judged.map(({ duty, block, seats }) => ({
      id: duty.id,
      name: duty.name,
      start: duty.start,
      end: duty.end,
      version: duty.version,
      ready: !block,
      code: block?.code,
      reason: block?.reason,
      seated: seats.length,
      vacant: Math.max(0, duty.slots.length - seats.length),
    })),
  };
}

/**
 * Publishes the ready drafts of an approved preview in one transaction. A draft
 * that is blocked stays a draft. Each published duty is recorded and announced
 * exactly as a single publish does, and the batch itself gets one more record.
 */
export async function publishDrafts(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  manager(actor);
  const input = batchInput.parse(payload);
  const judged = await judge(tx, input.dutyIds);
  invariant(
    previewToken(judged) === input.token,
    "stale_publish_preview",
    "אחת הטיוטות שנבחרו השתנתה מאז התצוגה. יש לחשב תצוגה חדשה",
    409
  );
  const ready = judged.filter((item) => !item.block);
  invariant(
    ready.length,
    "nothing_to_publish",
    "אין בבחירה טיוטה מוכנה לפרסום"
  );
  const rows = await tx
    .select()
    .from(duties)
    .where(
      inArray(
        duties.id,
        ready.map((item) => item.duty.id)
      )
    );
  const batchId = randomUUID();
  const published = [];
  for (const { duty } of ready) {
    const row = rows.find((item) => item.id === duty.id);
    invariant(row, "not_found", "תורנות לא נמצאה", 404);
    published.push(await publishRow(tx, actor, row, { batchId }));
  }
  const blocked = judged.filter((item) => item.block);
  // Ids only: the reasons name soldiers, and the audit envelope must stay free of personal text.
  await audit(tx, actor, "duty.publish.batch", batchId, {
    dutyIds: published.map((item) => item.id),
    blockedIds: blocked.map((item) => item.duty.id),
  });
  return {
    batchId,
    published,
    blocked: blocked.map(({ duty, block }) => ({
      id: duty.id,
      name: duty.name,
      reason: block?.reason,
    })),
  };
}
