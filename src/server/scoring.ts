import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Decimal from "decimal.js";
import type { DbTransaction } from "./db";
import { assignments, balances, duties, ledger, soldiers } from "./schema";
import {
  audit,
  createRecord,
  findRecord,
  manager,
  updateRecord,
  type Actor,
} from "./repository";
import { invariant } from "./errors";
import { scoreInput } from "./validation";
import { closeReturnsAfterScore } from "./manager-role";

export async function postScore(
  tx: DbTransaction,
  input: {
    soldierId: string;
    sourceKey: string;
    kind: string;
    actorId: string;
    reason: string;
    effectiveAt: Date;
    amount?: number;
    absolute?: number;
    data?: Record<string, unknown>;
  }
) {
  const [existing] = await tx
    .select()
    .from(ledger)
    .where(eq(ledger.sourceKey, input.sourceKey));
  if (existing) return existing;
  const [balance] = await tx
    .select()
    .from(balances)
    .where(eq(balances.soldierId, input.soldierId));
  invariant(balance, "missing_balance", "לא נמצאה יתרת החייל");
  const after = Math.max(
    0,
    input.absolute ?? balance.current + (input.amount ?? 0)
  );
  invariant(
    Number.isSafeInteger(after) && after <= 2147483647,
    "invalid_score",
    "הניקוד חורג מהטווח הנתמך"
  );
  const [entry] = await tx
    .insert(ledger)
    .values({
      id: randomUUID(),
      soldierId: input.soldierId,
      sourceKey: input.sourceKey,
      kind: input.kind,
      before: balance.current,
      after,
      amount: after - balance.current,
      actorId: input.actorId,
      reason: input.reason,
      effectiveAt: input.effectiveAt,
      data: input.data ?? {},
    })
    .returning();
  await tx
    .update(balances)
    .set({ current: after, version: balance.version + 1 })
    .where(eq(balances.soldierId, input.soldierId));
  return entry;
}

export async function settleDue(tx: DbTransaction, now = new Date()) {
  const dutyRows = await tx.select().from(duties);
  const assignmentRows = await tx
    .select()
    .from(assignments)
    .where(eq(assignments.status, "reserved"));
  const map = new Map(dutyRows.map((duty) => [duty.id, duty]));
  let count = 0;
  const endTime = (assignment: (typeof assignmentRows)[number]) =>
    new Date(
      assignment.data.performedEnd ??
        map.get(assignment.dutyId)?.data.end ??
        "9999-12-31"
    ).getTime();
  for (const assignment of assignmentRows.sort(
    (a, b) => endTime(a) - endTime(b) || a.id.localeCompare(b.id)
  )) {
    const duty = map.get(assignment.dutyId);
    if (!duty || duty.data.status !== "published") continue;
    const end = new Date(assignment.data.performedEnd ?? duty.data.end);
    if (end > now) continue;
    const [person] = await tx
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, assignment.soldierId));
    if (person?.deletedAt) continue;
    await postScore(tx, {
      soldierId: assignment.soldierId,
      sourceKey: `performance:${assignment.id}`,
      kind: "performance",
      actorId: "system",
      reason: `סיום ${duty.name}`,
      effectiveAt: end,
      amount: assignment.points,
      data: {
        assignmentId: assignment.id,
        dutyId: duty.id,
        originalPoints: assignment.points,
      },
    });
    await tx
      .update(assignments)
      .set({
        status: "credited",
        version: assignment.version + 1,
        data: {
          ...assignment.data,
          status: "credited",
          creditedAt: now.toISOString(),
          version: assignment.version + 1,
        },
        updatedAt: now,
      })
      .where(eq(assignments.id, assignment.id));
    count++;
  }
  return count;
}

function adjusted(before: number, operation: string, value: number) {
  let amount = new Decimal(before);
  if (operation === "add") amount = amount.plus(value);
  if (operation === "subtract") amount = amount.minus(value);
  if (operation === "set") amount = new Decimal(value);
  if (operation === "percent") {
    invariant(
      value <= 100,
      "invalid_percent",
      "אחוז ההפחתה חייב להיות בין 0 ל־100"
    );
    amount = amount.mul(new Decimal(100).minus(value)).div(100);
  }
  return Math.max(
    0,
    amount.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
  );
}

export async function previewScore(
  tx: DbTransaction,
  actor: Actor,
  payload: Record<string, unknown>
) {
  manager(actor);
  const input = scoreInput.parse(payload);
  await settleDue(tx);
  invariant(
    new Set(input.soldierIds).size === input.soldierIds.length,
    "duplicate_soldier",
    "רשימת החיילים מכילה כפילות"
  );
  const all = await tx
    .select({
      id: soldiers.id,
      name: soldiers.name,
      deletedAt: soldiers.deletedAt,
      current: balances.current,
      version: balances.version,
    })
    .from(soldiers)
    .innerJoin(balances, eq(soldiers.id, balances.soldierId));
  const rows = input.soldierIds.map((id) => {
    const row = all.find((x) => x.id === id);
    invariant(row && !row.deletedAt, "not_found", "אחד החיילים אינו פעיל");
    return {
      soldierId: id,
      name: row.name,
      before: row.current,
      after: adjusted(row.current, input.operation, input.value),
      version: row.version,
    };
  });
  const preview = await createRecord(tx, "score_preview", {
    actorId: actor.id,
    input,
    rows,
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
  });
  return { rows, token: preview.id };
}

export async function applyScore(
  tx: DbTransaction,
  actor: Actor,
  payload: Record<string, unknown>
) {
  manager(actor);
  const input = scoreInput.parse(payload);
  invariant(
    input.token,
    "preview_required",
    "יש להציג ולאשר את השינוי לפני החלתו"
  );
  const preview = await findRecord(tx, "score_preview", input.token);
  invariant(
    preview.data.actorId === actor.id &&
      !preview.data.applied &&
      new Date(String(preview.data.expiresAt)) > new Date(),
    "stale_preview",
    "התצוגה המקדימה פגה. יש לחשב מחדש",
    409
  );
  const stored = scoreInput.parse(preview.data.input);
  invariant(
    JSON.stringify({ ...input, token: undefined }) ===
      JSON.stringify({ ...stored, token: undefined }),
    "changed_preview",
    "פרטי הפעולה השתנו מאז התצוגה המקדימה",
    409
  );
  await settleDue(tx);
  const rows = preview.data.rows as {
    soldierId: string;
    before: number;
    after: number;
    version: number;
  }[];
  for (const row of rows) {
    const [balance] = await tx
      .select()
      .from(balances)
      .where(eq(balances.soldierId, row.soldierId));
    const [person] = await tx
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, row.soldierId));
    invariant(
      person && !person.deletedAt,
      "stale_preview",
      "אחד החשבונות נמחק מאז התצוגה. יש לחשב מחדש",
      409
    );
    invariant(
      balance?.version === row.version,
      "stale_preview",
      "יתרה השתנתה מאז התצוגה. יש לחשב מחדש",
      409
    );
    const barrier =
      input.operation === "set" ||
      input.operation === "percent" ||
      (input.operation === "subtract" && input.value > row.before) ||
      rows.length > 1;
    await postScore(tx, {
      soldierId: row.soldierId,
      sourceKey: `adjustment:${preview.id}:${row.soldierId}`,
      kind: rows.length > 1 ? "normalization" : "adjustment",
      actorId: actor.id,
      reason: input.reason,
      absolute: row.after,
      effectiveAt: new Date(),
      data: { operation: input.operation, value: input.value, barrier },
    });
  }
  // The decision about a returned manager's balance is made by any balance operation on them.
  await closeReturnsAfterScore(tx, actor, rows, preview.id);
  await updateRecord(tx, preview, { ...preview.data, applied: true });
  await audit(tx, actor, "score.apply", preview.id, {
    count: rows.length,
    operation: input.operation,
  });
  return { changed: rows.length };
}
