import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { records, soldiers } from "./schema";
import {
  audit,
  createRecord,
  currentVersion,
  findRecord,
  loadDomain,
  manager,
  updateRecord,
  type Actor,
  type Workflow,
} from "./repository";
import {
  constraintInput,
  constraintItemInput,
  date,
  id,
  text,
} from "./validation";
import { invariant } from "./errors";
import { parseMoment } from "./duty-service";
import { reassessAssignments } from "./personnel";
import { cancelRoundEmails } from "./round-notices";
import { datesToInstants, interval, overlaps } from "../domain/time";

export async function createRound(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  manager(actor);
  const input = z
    .object({
      name: text,
      opensAt: text,
      closesAt: text,
      targetStart: date,
      targetEnd: date,
    })
    .parse(payload);
  const opensAt = parseMoment(input.opensAt);
  const closesAt = parseMoment(input.closesAt);
  invariant(
    new Date(closesAt) > new Date(opensAt),
    "invalid_window",
    "סוף חלון ההגשה חייב להיות אחרי תחילתו"
  );
  invariant(
    input.targetEnd >= input.targetStart,
    "invalid_period",
    "תקופת היעד אינה תקינה"
  );
  const round = await createRecord(tx, "round", {
    ...input,
    opensAt,
    closesAt,
    status: "open",
  });
  await audit(tx, actor, "round.create", round.id);
  return { id: round.id };
}
export async function closeRound(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const round = await findRecord(
    tx,
    "round",
    id.parse((payload as Record<string, unknown>).id)
  );
  currentVersion(round.version, expectedVersion);
  invariant(
    round.data.status !== "closed",
    "already_closed",
    "הסבב כבר נסגר",
    409
  );
  await updateRecord(tx, round, {
    ...round.data,
    status: "closed",
    closedAt: new Date().toISOString(),
    closedByName: actor.name,
  });
  await cancelRoundEmails(tx, round.id);
  await audit(tx, actor, "round.close", round.id);
  return { id: round.id };
}
export async function reopenRound(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z.object({ id, closesAt: text }).parse(payload);
  const round = await findRecord(tx, "round", input.id);
  currentVersion(round.version, expectedVersion);
  const closesAt = parseMoment(input.closesAt);
  invariant(
    new Date(closesAt) > new Date() &&
      new Date(closesAt) > new Date(String(round.data.opensAt)),
    "invalid_window",
    "נדרש מועד סגירה עתידי לאחר פתיחת הסבב"
  );
  const reopenedAt = new Date().toISOString();
  // A new generation of notices: "reopening" after closing, "extension" while still open.
  const reopenKind =
    round.data.status === "closed" ||
    new Date(reopenedAt) >= new Date(String(round.data.closesAt))
      ? "reopen"
      : "extension";
  await updateRecord(tx, round, {
    ...round.data,
    status: "open",
    reopenKind,
    closesAt,
    closedAt: null,
    reopenedAt,
    reopenedByName: actor.name,
    reopenCount: Number(round.data.reopenCount ?? 0) + 1,
  });
  await cancelRoundEmails(tx, round.id);
  await audit(tx, actor, "round.reopen", round.id, { reopenKind, closesAt });
  return { id: round.id };
}
function hasRange(value: unknown) {
  const version = value as { start?: unknown; none?: boolean } | null;
  return Boolean(version && typeof version.start === "string" && !version.none);
}
/** A row still binds or awaits review: an approved range or a pending change. */
function isActive(row: Workflow) {
  return hasRange(row.data.approved) || Boolean(row.data.pending);
}
async function archiveRevision(tx: DbTransaction, record: Workflow) {
  await createRecord(
    tx,
    "constraint_revision",
    { constraintId: record.id, recordVersion: record.version, ...record.data },
    record.subjectId!
  );
}
export async function submitConstraint(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  invariant(
    actor.role !== "technical" && actor.soldierId,
    "forbidden",
    "הגשת אילוצים זמינה לחיילים בלבד",
    403
  );
  const input = constraintInput.parse(payload);
  invariant(
    !input.soldierId || input.soldierId === actor.soldierId,
    "forbidden",
    "אפשר להגיש רק את האילוצים שלך",
    403
  );
  const round = await findRecord(tx, "round", input.roundId);
  const now = new Date();
  invariant(
    round.data.status !== "closed" &&
      now >= new Date(String(round.data.opensAt)) &&
      now < new Date(String(round.data.closesAt)),
    "round_closed",
    "חלון ההגשה אינו פתוח"
  );
  invariant(
    !(input.none && input.items),
    "invalid_submission",
    "הגשת אין אילוצים אינה יכולה לכלול טווחים"
  );
  invariant(
    !(input.id && input.items),
    "invalid_submission",
    "עריכת אילוץ נעשית לפריט אחד בכל פעם"
  );
  const items = input.none
    ? []
    : (input.items ?? [constraintItemInput.parse(input)]);
  for (const item of items)
    invariant(
      item.endDate >= item.startDate &&
        item.startDate >= String(round.data.targetStart) &&
        item.endDate <= String(round.data.targetEnd),
      "outside_target",
      "כל האילוצים חייבים להיות בתוך תקופת היעד"
    );
  const existingRows = (
    await tx
      .select()
      .from(records)
      .where(
        and(
          eq(records.kind, "constraint"),
          eq(records.subjectId, actor.soldierId)
        )
      )
  ).filter((row) => row.data.roundId === round.id);
  const existing = input.id
    ? existingRows.find((row) => row.id === input.id)
    : undefined;
  if (input.id) {
    invariant(
      existing,
      "invalid_submission",
      "ההגשה אינה שייכת לחייל או לסבב",
      403
    );
    currentVersion(existing.version, expectedVersion);
    invariant(
      !input.none || isActive(existing),
      "nothing_to_cancel",
      "אין בפריט זה אילוץ בתוקף או ממתין לביטול",
      409
    );
  } else
    invariant(
      expectedVersion === undefined,
      "stale_submission",
      "הגשה חדשה אינה כוללת גרסת פריט קיים",
      409
    );
  if (input.none && !input.id && existingRows.length) {
    const supplied = input.existingVersions ?? [];
    invariant(
      supplied.length === existingRows.length &&
        new Set(supplied.map((row) => row.id)).size === supplied.length &&
        existingRows.every((row) =>
          supplied.some(
            (value) => value.id === row.id && value.version === row.version
          )
        ),
      "stale_submission",
      "רשימת האילוצים השתנתה. יש לרענן לפני בקשת ביטול כולם",
      409
    );
  }
  const saved: Workflow[] = [];
  const active = existingRows.filter(isActive);
  const declaration = existingRows.find(
    (row) => row.data.status === "declared"
  );
  if (input.none && !input.id && !active.length) {
    // Nothing to review: the declaration completes the submission directly.
    if (declaration) await archiveRevision(tx, declaration);
    const data = {
      ...declaration?.data,
      roundId: round.id,
      status: "declared",
      pending: null,
      declared: {
        version: (declaration?.version ?? 0) + 1,
        none: true,
        submittedAt: now.toISOString(),
      },
      submittedAt: now.toISOString(),
    };
    const record = declaration
      ? await updateRecord(tx, declaration, data)
      : await createRecord(tx, "constraint", data, actor.soldierId);
    saved.push(record);
    await audit(
      tx,
      actor,
      "constraint.declare_none",
      record.id,
      { roundId: round.id },
      actor.soldierId
    );
  }
  const changes = saved.length
    ? []
    : input.none
      ? (existing ? [existing] : active).map((row) => ({
          row,
          item: undefined,
        }))
      : items.map((item, index) => ({
          // A later item replaces an earlier "no constraints" declaration.
          row: existing ?? (index === 0 ? declaration : undefined),
          item,
        }));
  for (const { row, item } of changes) {
    if (row) await archiveRevision(tx, row);
    const pending = {
      version: (row?.version ?? 0) + 1,
      none: input.none,
      ...(item
        ? { start: item.startDate, end: item.endDate, reason: item.reason }
        : {}),
      submittedAt: now.toISOString(),
    };
    const data = {
      ...row?.data,
      roundId: round.id,
      status: "pending",
      pending,
      declared: null,
      submittedAt: now.toISOString(),
    };
    const record = row
      ? await updateRecord(tx, row, data)
      : await createRecord(tx, "constraint", data, actor.soldierId);
    saved.push(record);
    await audit(
      tx,
      actor,
      "constraint.submit",
      record.id,
      { roundId: round.id },
      actor.soldierId
    );
  }
  await reassessAssignments(tx, actor.soldierId);
  return {
    id: saved[0].id,
    version: saved[0].version,
    items: saved.map((row) => ({ id: row.id, version: row.version })),
  };
}
async function reviewImpact(tx: DbTransaction, record: Workflow) {
  const pending = record.data.pending as {
    start?: string;
    end?: string;
    none?: boolean;
  };
  const state = await loadDomain(tx);
  const conflicts =
    pending?.start && pending.end && !pending.none
      ? state.assignments
          .filter(
            (row) =>
              row.soldierId === record.subjectId &&
              ["reserved", "held"].includes(row.status)
          )
          .flatMap((assignment) => {
            const duty = state.duties.find(
              (row) => row.id === assignment.dutyId
            );
            if (
              !duty ||
              duty.status === "cancelled" ||
              !overlaps(
                interval(duty),
                datesToInstants({ start: pending.start!, end: pending.end! })
              )
            )
              return [];
            return [
              {
                id: assignment.id,
                assignmentVersion: assignment.version,
                dutyId: duty.id,
                dutyVersion: duty.version,
                name: duty.name,
                start: duty.start,
                end: duty.end,
              },
            ];
          })
          .sort((a, b) => a.id.localeCompare(b.id))
      : [];
  return {
    conflicts,
    impactToken: createHash("sha256")
      .update(
        JSON.stringify({ id: record.id, version: record.version, conflicts })
      )
      .digest("hex"),
  };
}
export async function previewConstraint(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z.object({ id }).parse(payload);
  const record = await findRecord(tx, "constraint", input.id);
  currentVersion(record.version, expectedVersion);
  invariant(
    record.data.pending,
    "already_decided",
    "אין גרסה ממתינה להחלטה",
    409
  );
  return reviewImpact(tx, record);
}
export async function reviewConstraint(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({
      id,
      decision: z.enum(["approved", "rejected"]),
      reason: z.string().trim().max(2000).default(""),
      impactToken: z.string().optional(),
    })
    .parse(payload);
  const record = await findRecord(tx, "constraint", input.id);
  currentVersion(record.version, expectedVersion);
  invariant(
    record.data.pending && record.subjectId,
    "already_decided",
    "אין גרסה ממתינה להחלטה",
    409
  );
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, record.subjectId));
  invariant(person && !person.deletedAt, "deleted", "רשומת החייל אינה פעילה");
  if (input.decision === "approved") {
    const impact = await reviewImpact(tx, record);
    invariant(
      (!impact.conflicts.length && !input.impactToken) ||
        input.impactToken === impact.impactToken,
      "impact_confirmation_required",
      "יש לבדוק את רשימת השיבוצים המושפעים העדכנית לפני האישור",
      409
    );
  } else invariant(input.reason, "reason_required", "נדרשת סיבה לדחיית האילוץ");
  await archiveRevision(tx, record);
  const data = {
    ...record.data,
    status: input.decision,
    approved:
      input.decision === "approved"
        ? record.data.pending
        : record.data.approved,
    pending: null,
    rejected: input.decision === "rejected" ? record.data.pending : null,
    decisionReason: input.reason,
    decidedBy: actor.id,
    decidedByName: actor.name,
    decidedAt: new Date().toISOString(),
  };
  await updateRecord(tx, record, data);
  const cancellation = Boolean(
    (record.data.pending as { none?: boolean }).none
  );
  const keepsApproved = hasRange(record.data.approved);
  await createRecord(
    tx,
    "notification",
    {
      title:
        input.decision === "approved"
          ? cancellation
            ? "ביטול האילוץ אושר"
            : "האילוץ אושר"
          : keepsApproved
            ? "השינוי באילוץ נדחה"
            : "האילוץ נדחה",
      body:
        input.decision === "rejected" && keepsApproved
          ? "הגרסה המאושרת הקודמת נשארת בתוקף. ההחלטה זמינה במסך האילוצים."
          : "ההחלטה זמינה במסך האילוצים.",
      href: "/constraints",
    },
    person.id
  );
  await audit(
    tx,
    actor,
    "constraint.review",
    record.id,
    { decision: input.decision },
    person.id
  );
  return { id: record.id, flagged: await reassessAssignments(tx, person.id) };
}
