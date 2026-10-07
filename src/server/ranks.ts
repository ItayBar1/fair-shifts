import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { staffNotificationRecipients } from "./notification-audience";
import { records, soldiers } from "./schema";
import {
  audit,
  createRecord,
  currentVersion,
  findRecord,
  manager,
  updateRecord,
  type Actor,
  type Workflow,
} from "./repository";
import { invariant } from "./errors";
import { date, id, text } from "./validation";
import { rankAt } from "../domain/eligibility";
import { localDate, instant, releaseBoundary } from "../domain/time";
import { reassessAssignments } from "./personnel";
import type { EffectiveRank } from "../domain/types";

function rankKey(rank: EffectiveRank) {
  return `${rank.trackId}:${rank.rankId}:${rank.effectiveFrom}`;
}
export async function saveRankCatalog(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({
      id: id.optional(),
      name: text,
      track: text,
      order: z.number().int().nonnegative(),
      source: text,
    })
    .parse(payload);
  const catalog = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "rank_catalog"));
  invariant(
    !catalog.some(
      (row) =>
        row.id !== input.id &&
        row.data.track === input.track &&
        (row.data.name === input.name || row.data.order === input.order)
    ),
    "duplicate_rank",
    "במסלול כבר קיימת דרגה בשם או במיקום הזה"
  );
  let record: Workflow;
  if (input.id) {
    const existing = await findRecord(tx, "rank_catalog", input.id);
    currentVersion(existing.version, expectedVersion);
    invariant(
      existing.data.track === input.track &&
        existing.data.order === input.order,
      "rank_identity",
      "מסלול וסדר של דרגה קיימת נשמרים בהיסטוריה; להגדרה אחרת יש ליצור דרגה חדשה"
    );
    record = await updateRecord(tx, existing, input);
  } else record = await createRecord(tx, "rank_catalog", input);
  await audit(tx, actor, "rank.catalog.save", record.id);
  await refreshRankReminders(tx);
  return { id: record.id, version: record.version };
}
export async function saveRankRule(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({
      id: id.optional(),
      name: text,
      fromRankId: id,
      toRankId: id,
      months: z.number().int().min(1).max(600),
      base: z.enum(["enlistment", "rank"]),
      source: text,
    })
    .parse(payload);
  const from = await findRecord(tx, "rank_catalog", input.fromRankId);
  const to = await findRecord(tx, "rank_catalog", input.toRankId);
  invariant(
    from.data.track === to.data.track &&
      Number(to.data.order) > Number(from.data.order),
    "rank_transition",
    "מעבר פז״ם חייב להיות לדרגה גבוהה יותר באותו מסלול"
  );
  const rules = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "rank_rule"));
  invariant(
    !rules.some(
      (row) => row.id !== input.id && row.data.fromRankId === from.id
    ),
    "duplicate_rule",
    "כבר קיים כלל לדרגת המוצא. יש לערוך אותו כדי לשמור על מקור אחד לחישוב"
  );
  const data = { ...input, track: from.data.track };
  let record: Workflow;
  if (input.id) {
    const previous = await findRecord(tx, "rank_rule", input.id);
    currentVersion(previous.version, expectedVersion);
    await createRecord(tx, "rank_rule_revision", {
      ruleId: previous.id,
      ruleVersion: previous.version,
      ...previous.data,
    });
    record = await updateRecord(tx, previous, data);
  } else record = await createRecord(tx, "rank_rule", data);
  await audit(tx, actor, "rank.rule.save", record.id);
  await refreshRankReminders(tx);
  return { id: record.id, version: record.version };
}
export async function setRankDeadline(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({ soldierId: id, toRankId: id, dueDate: date, source: text })
    .parse(payload);
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, input.soldierId));
  invariant(person && !person.deletedAt, "not_found", "חייל לא נמצא", 404);
  currentVersion(person.version, expectedVersion);
  const rank = rankAt(person.data, new Date().toISOString());
  invariant(rank, "missing_rank", "נדרשת דרגה מאושרת לפני קביעת מועד");
  const target = await findRecord(tx, "rank_catalog", input.toRankId);
  invariant(
    target.data.track === rank.trackId &&
      Number(target.data.order) > rank.order,
    "rank_transition",
    "יש לבחור דרגה גבוהה יותר באותו מסלול"
  );
  const deadlines = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "rank_deadline"));
  for (const previous of deadlines.filter(
    (row) =>
      row.subjectId === person.id &&
      row.data.sourceRank === rankKey(rank) &&
      row.data.active === true
  ))
    await updateRecord(tx, previous, { ...previous.data, active: false });
  const record = await createRecord(
    tx,
    "rank_deadline",
    { ...input, sourceRank: rankKey(rank), active: true },
    person.id
  );
  await tx
    .update(soldiers)
    .set({
      version: person.version + 1,
      data: { ...person.data, version: person.version + 1 },
      updatedAt: new Date(),
    })
    .where(eq(soldiers.id, person.id));
  await audit(tx, actor, "rank.deadline", person.id);
  await refreshRankReminders(tx);
  return { id: record.id };
}
/** Scheduling creates review work only. It never writes rank history. Caller holds the unit lock. */
export async function refreshRankReminders(
  tx: DbTransaction,
  now = new Date()
) {
  const people = await tx.select().from(soldiers);
  const all = await tx.select().from(records);
  const rules = all.filter((row) => row.kind === "rank_rule");
  const catalog = all.filter((row) => row.kind === "rank_catalog");
  const reminders = all.filter((row) => row.kind === "rank_reminder");
  const desiredIds = new Set<string>();
  const today = instant(now.toISOString()).toISODate()!;
  for (const person of people) {
    if (
      person.deletedAt ||
      (person.data.service.releaseDate &&
        now >= new Date(releaseBoundary(person.data.service.releaseDate)))
    )
      continue;
    const rank = rankAt(person.data, now.toISOString());
    if (!rank) continue;
    // A confirmed future rank is already a decision; no reminder can supersede it.
    if (person.data.rankHistory.some((row) => row.effectiveFrom > today))
      continue;
    const rule = rules.find(
      (row) =>
        row.data.fromRankId === rank.rankId && row.data.track === rank.trackId
    );
    const manual = all.find(
      (row) =>
        row.kind === "rank_deadline" &&
        row.subjectId === person.id &&
        row.data.sourceRank === rankKey(rank) &&
        row.data.active === true
    );
    if (!rule && !manual) continue;
    const toRankId = String(manual?.data.toRankId ?? rule!.data.toRankId);
    const target = catalog.find((row) => row.id === toRankId);
    if (!target) continue;
    const base =
      rule?.data.base === "enlistment"
        ? person.data.service.enlistmentDate
        : rank.effectiveFrom;
    const dueDate = manual
      ? String(manual.data.dueDate)
      : base
        ? localDate(base)
            .plus({ months: Number(rule!.data.months) })
            .toISODate()!
        : null;
    const transition = `${rankKey(rank)}:${target.id}`;
    const previous = reminders.find(
      (row) =>
        row.subjectId === person.id &&
        row.data.transition === transition &&
        !["approved", "superseded"].includes(String(row.data.status))
    );
    const status = !dueDate
      ? "missing_data"
      : dueDate <= today
        ? "pending"
        : "scheduled";
    const data = {
      soldierId: person.id,
      sourceRank: rankKey(rank),
      transition,
      toRankId: target.id,
      toRank: target.data.name,
      track: target.data.track,
      dueDate,
      status,
      personVersion: person.version,
      ruleId: rule?.id ?? null,
      ruleVersion: rule?.version ?? null,
      deadlineId: manual?.id ?? null,
      source: manual?.data.source ?? rule?.data.source,
      notified: previous?.data.notified === true || status === "pending",
    };
    const unchanged =
      previous &&
      Object.entries(data).every(
        ([key, value]) => previous.data[key] === value
      );
    const reminder = previous
      ? unchanged
        ? previous
        : await updateRecord(tx, previous, data)
      : await createRecord(tx, "rank_reminder", data, person.id);
    desiredIds.add(reminder.id);
    if (status === "pending" && previous?.data.notified !== true) {
      const managers = await staffNotificationRecipients(tx, ["manager"], now);
      for (const recipient of managers.filter((row) => !row.deletedAt))
        await createRecord(tx, "notification", {
          accountId: recipient.id,
          title: "מועד פז״ם לבדיקה",
          body: `יש לבדוק עדכון דרגה עבור ${person.name}. הדרגה לא השתנתה.`,
          href: "/manage/ranks",
          reminderId: reminder.id,
        });
    }
  }
  for (const reminder of reminders)
    if (
      !desiredIds.has(reminder.id) &&
      !["approved", "superseded"].includes(String(reminder.data.status))
    )
      await updateRecord(tx, reminder, {
        ...reminder.data,
        status: "superseded",
      });
}
export async function setSoldierRank(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({ soldierId: id, rankId: id, effectiveDate: date, reason: text })
    .parse(payload);
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, input.soldierId));
  invariant(person && !person.deletedAt, "not_found", "חייל לא נמצא", 404);
  currentVersion(person.version, expectedVersion);
  const rank = await findRecord(tx, "rank_catalog", input.rankId);
  const data = {
    ...person.data,
    version: person.version + 1,
    rankHistory: [
      ...person.data.rankHistory.filter(
        (row) => row.effectiveFrom !== input.effectiveDate
      ),
      {
        effectiveFrom: input.effectiveDate,
        rankId: rank.id,
        trackId: String(rank.data.track),
        order: Number(rank.data.order),
      },
    ],
  };
  const revision = await createRecord(
    tx,
    "rank_history_revision",
    {
      rankHistory: person.data.rankHistory,
      personVersion: person.version,
      reason: input.reason,
      actorId: actor.id,
    },
    person.id
  );
  await tx
    .update(soldiers)
    .set({ data, version: person.version + 1, updatedAt: new Date() })
    .where(eq(soldiers.id, person.id));
  await audit(
    tx,
    actor,
    "rank.set",
    person.id,
    {
      rankId: rank.id,
      previousRankId: rankAt(
        person.data,
        localDate(input.effectiveDate).toISO()!
      )?.rankId,
      effectiveDate: input.effectiveDate,
      recordId: revision.id,
    },
    person.id
  );
  await reassessAssignments(tx, person.id);
  await refreshRankReminders(tx);
  return { id: person.id, version: person.version + 1 };
}
export async function approveRank(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({ id, effectiveDate: date, reason: text })
    .parse(payload);
  await refreshRankReminders(tx);
  const reminder = await findRecord(tx, "rank_reminder", input.id);
  currentVersion(reminder.version, expectedVersion);
  invariant(
    reminder.data.status === "pending" || reminder.data.status === "scheduled",
    "rank_changed",
    "התזכורת אינה ממתינה לאישור או שחסר מידע",
    409
  );
  // Close first so refreshing after the explicit rank change cannot reopen this decision.
  await updateRecord(tx, reminder, {
    ...reminder.data,
    status: "approved",
    approvedBy: actor.id,
    effectiveDate: input.effectiveDate,
    reason: input.reason,
  });
  return setSoldierRank(
    tx,
    actor,
    {
      soldierId: reminder.subjectId,
      rankId: reminder.data.toRankId,
      effectiveDate: input.effectiveDate,
      reason: input.reason,
    },
    Number(reminder.data.personVersion)
  );
}
