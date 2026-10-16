import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { staffNotificationRecipients } from "./notification-audience";
import { duties, dutyTypes, records, soldiers } from "./schema";
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
import {
  membershipIn,
  rankClausesIn,
  rankMemberships,
  sharedHigherTracks,
  splitRankChoice,
} from "../domain/rank-tracks";
import { localDate, instant, releaseBoundary } from "../domain/time";
import { reassessAssignments } from "./personnel";
import type { EffectiveRank } from "../domain/types";

function rankKey(rank: EffectiveRank) {
  return `${rank.trackId}:${rank.rankId}:${rank.effectiveFrom}`;
}
const trackNames = async (tx: DbTransaction) =>
  (await tx.select().from(records).where(eq(records.kind, "rank_track"))).map(
    (row) => String(row.data.name)
  );
/**
 * What still leans on a rank in a track, or on a whole track. Removing or
 * moving a rank there changes their meaning, so the manager confirms first.
 */
async function trackUsage(tx: DbTransaction, track: string, rankId?: string) {
  const today = instant(new Date().toISOString()).toISODate()!;
  const people = (await tx.select().from(soldiers)).filter(
    (person) =>
      !person.deletedAt &&
      person.data.rankHistory.some(
        (row, _, all) =>
          row.trackId === track &&
          (!rankId || row.rankId === rankId) &&
          // The current or a future rank; a past one is history only.
          (row.effectiveFrom > today ||
            row ===
              [...all]
                .filter((item) => item.effectiveFrom <= today)
                .sort((a, b) =>
                  b.effectiveFrom.localeCompare(a.effectiveFrom)
                )[0])
      )
  );
  const rules = (
    await tx.select().from(records).where(eq(records.kind, "rank_rule"))
  ).filter(
    (row) =>
      row.data.track === track &&
      (!rankId ||
        row.data.fromRankId === rankId ||
        row.data.toRankId === rankId)
  );
  // A list names its ranks; a range covers whatever sits between its places.
  const leans = (data: unknown) =>
    rankClausesIn(data).some(
      (clause) =>
        clause.trackId === track &&
        (!rankId ||
          !Array.isArray(clause.rankIds) ||
          clause.rankIds.includes(rankId))
    );
  const types = (await tx.select().from(dutyTypes)).filter((row) =>
    leans(row.data)
  );
  const upcoming = (await tx.select().from(duties)).filter(
    (row) =>
      row.data.status !== "cancelled" &&
      new Date(row.data.end) > new Date() &&
      leans(row.data)
  );
  return {
    soldiers: people.map((row) => row.name),
    rules: rules.map((row) => String(row.data.name)),
    dutyTypes: types.map((row) => row.name),
    duties: upcoming.map((row) => row.name),
    soldierIds: people.map((row) => row.id),
  };
}
type Usage = Awaited<ReturnType<typeof trackUsage>>;
const used = (usage: Usage) =>
  usage.soldiers.length +
  usage.rules.length +
  usage.dutyTypes.length +
  usage.duties.length;
function describeUsage(usage: Usage) {
  const list = (label: string, names: string[]) =>
    names.length
      ? [
          `${label}: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` ועוד ${names.length - 5}` : ""}`,
        ]
      : [];
  return [
    ...list("חיילים שמחזיקים בדרגה במסלול", usage.soldiers),
    ...list("כללי פז״ם", usage.rules),
    ...list("תנאי דרגה בסוגי תורנות", usage.dutyTypes),
    ...list("תנאי דרגה בתורנויות שטרם הסתיימו", usage.duties),
  ].join(" · ");
}
export async function saveRankTrack(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({ id: id.optional(), name: text, source: text })
    .parse(payload);
  const tracks = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "rank_track"));
  invariant(
    !tracks.some((row) => row.id !== input.id && row.data.name === input.name),
    "duplicate_track",
    "כבר קיים מסלול בשם הזה"
  );
  let record: Workflow;
  if (input.id) {
    const existing = await findRecord(tx, "rank_track", input.id);
    currentVersion(existing.version, expectedVersion);
    const previous = String(existing.data.name);
    if (previous !== input.name) {
      // The track name is what soldiers, rules and conditions store.
      invariant(
        !used(await trackUsage(tx, previous)),
        "rank_track_in_use",
        "אפשר לשנות שם רק למסלול שאין בו חיילים, כללי פז״ם או תנאי תורנות"
      );
      for (const rank of await tx
        .select()
        .from(records)
        .where(eq(records.kind, "rank_catalog")))
        if (membershipIn(rank.data, previous))
          await updateRecord(tx, rank, {
            ...rank.data,
            tracks: rankMemberships(rank.data).map((row) =>
              row.track === previous ? { ...row, track: input.name } : row
            ),
          });
    }
    record = await updateRecord(tx, existing, {
      name: input.name,
      source: input.source,
    });
  } else
    record = await createRecord(tx, "rank_track", {
      name: input.name,
      source: input.source,
    });
  await audit(tx, actor, "rank.track.save", record.id);
  return { id: record.id, version: record.version };
}
export async function deleteRankTrack(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z.object({ id }).parse(payload);
  const track = await findRecord(tx, "rank_track", input.id);
  currentVersion(track.version, expectedVersion);
  const name = String(track.data.name);
  invariant(
    !(
      await tx.select().from(records).where(eq(records.kind, "rank_catalog"))
    ).some((rank) => membershipIn(rank.data, name)),
    "rank_track_not_empty",
    "יש להסיר תחילה את הדרגות מהמסלול"
  );
  const usage = await trackUsage(tx, name);
  invariant(
    !used(usage),
    "rank_track_in_use",
    `המסלול עדיין בשימוש. יש לעדכן אותם לפני המחיקה: ${describeUsage(usage)}`,
    409
  );
  await tx.delete(records).where(eq(records.id, track.id));
  await audit(tx, actor, "rank.track.delete", track.id, { name });
  return { id: track.id };
}
/** A rank in one track may still be sent as a track and an order. */
const singleTrack = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return payload;
  const { track, order, ...rest } = payload as Record<string, unknown>;
  return "tracks" in rest || track === undefined
    ? payload
    : { ...rest, tracks: [{ track, order }] };
};
export async function saveRankCatalog(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .preprocess(
      singleTrack,
      z.object({
        id: id.optional(),
        name: text,
        tracks: z
          .array(
            z.object({ track: text, order: z.number().int().nonnegative() })
          )
          .min(1, "יש לשייך את הדרגה למסלול אחד לפחות"),
        source: text,
        usageConfirmed: z.boolean().optional(),
      })
    )
    .parse(payload);
  invariant(
    new Set(input.tracks.map((row) => row.track)).size === input.tracks.length,
    "duplicate_track",
    "כל מסלול נבחר פעם אחת לכל דרגה"
  );
  const known = await trackNames(tx);
  invariant(
    input.tracks.every((row) => known.includes(row.track)),
    "unknown_track",
    "יש להגדיר את המסלול בניהול המסלולים לפני שמשייכים אליו דרגה"
  );
  const catalog = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "rank_catalog"));
  for (const membership of input.tracks)
    invariant(
      !catalog.some((row) => {
        if (row.id === input.id) return false;
        const other = membershipIn(row.data, membership.track);
        return (
          other &&
          (row.data.name === input.name || other.order === membership.order)
        );
      }),
      "duplicate_rank",
      `במסלול ${membership.track} כבר קיימת דרגה בשם או במיקום הזה`
    );
  let record: Workflow;
  const data = {
    name: input.name,
    tracks: input.tracks,
    source: input.source,
  };
  if (input.id) {
    const existing = await findRecord(tx, "rank_catalog", input.id);
    currentVersion(existing.version, expectedVersion);
    const before = rankMemberships(existing.data);
    // Removing a rank from a track or moving it there changes what leans on it.
    const changed = before.filter(
      (row) =>
        input.tracks.find((item) => item.track === row.track)?.order !==
        row.order
    );
    const usages = await Promise.all(
      changed.map(async (row) => ({
        ...row,
        usage: await trackUsage(tx, row.track, existing.id),
      }))
    );
    const conflicts = usages.filter((row) => used(row.usage));
    invariant(
      !conflicts.length || input.usageConfirmed,
      "rank_track_in_use",
      `השינוי משפיע על שימושים קיימים. ${conflicts
        .map((row) => `מסלול ${row.track}: ${describeUsage(row.usage)}`)
        .join(" | ")}. יש לאשר כדי לשמור.`,
      409,
      {
        conflicts: conflicts.map((row) => ({
          track: row.track,
          ...row.usage,
        })),
      }
    );
    record = await updateRecord(tx, existing, data);
    // A soldier's rank keeps its track; its place follows the catalog.
    const moved = changed
      .map((row) => ({
        track: row.track,
        order: input.tracks.find((item) => item.track === row.track)?.order,
      }))
      .filter((row) => row.order !== undefined);
    if (moved.length) {
      const people = await tx.select().from(soldiers);
      for (const person of people) {
        const rankHistory = person.data.rankHistory.map((row) => {
          const place = moved.find(
            (item) => row.rankId === existing.id && row.trackId === item.track
          );
          return place ? { ...row, order: place.order! } : row;
        });
        if (rankHistory.some((row, i) => row !== person.data.rankHistory[i]))
          await tx
            .update(soldiers)
            .set({
              data: {
                ...person.data,
                rankHistory,
                version: person.version + 1,
              },
              version: person.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(soldiers.id, person.id));
      }
    }
    if (conflicts.length) {
      await audit(tx, actor, "rank.catalog.usage_confirmed", record.id, {
        tracks: conflicts.map((row) => row.track),
      });
      await reassessAssignments(tx);
    }
  } else record = await createRecord(tx, "rank_catalog", data);
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
      track: z.preprocess(
        (value) => (value === "" ? undefined : value),
        text.optional()
      ),
      months: z.number().int().min(1).max(600),
      base: z.enum(["enlistment", "rank"]),
      source: text,
    })
    .parse(payload);
  const from = await findRecord(tx, "rank_catalog", input.fromRankId);
  const to = await findRecord(tx, "rank_catalog", input.toRankId);
  const shared = sharedHigherTracks(from.data, to.data);
  const track = input.track ?? (shared.length === 1 ? shared[0] : undefined);
  invariant(
    input.track || shared.length < 2,
    "rank_track_required",
    "שתי הדרגות נמצאות יחד בכמה מסלולים. יש לבחור את מסלול הכלל"
  );
  invariant(
    track && shared.includes(track),
    "rank_transition",
    "מעבר פז״ם חייב להיות לדרגה גבוהה יותר באותו מסלול"
  );
  const rules = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "rank_rule"));
  invariant(
    !rules.some(
      (row) =>
        row.id !== input.id &&
        row.data.fromRankId === from.id &&
        row.data.track === track
    ),
    "duplicate_rule",
    "כבר קיים כלל לדרגת המוצא במסלול הזה. יש לערוך אותו כדי לשמור על מקור אחד לחישוב"
  );
  const data = { ...input, track };
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
/** The catalog rank and the track a soldier holds it in. */
export async function resolveRankChoice(
  tx: DbTransaction,
  rankId: string,
  trackId?: string
) {
  const rank = await findRecord(tx, "rank_catalog", rankId);
  const memberships = rankMemberships(rank.data);
  invariant(
    trackId || memberships.length < 2,
    "rank_track_required",
    "הדרגה שייכת לכמה מסלולים. יש לבחור את המסלול של החייל"
  );
  const membership = trackId
    ? memberships.find((row) => row.track === trackId)
    : memberships[0];
  invariant(membership, "rank_track", "הדרגה אינה שייכת למסלול שנבחר");
  return { rank, membership };
}
export const rankChoice = <T extends z.ZodRawShape>(shape: T) =>
  z.preprocess(
    splitRankChoice,
    z.object({
      ...shape,
      trackId: z.preprocess(
        (value) => (value === "" ? undefined : value),
        text.optional()
      ),
    })
  );
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
    (membershipIn(target.data, rank.trackId)?.order ?? -1) > rank.order,
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
      track: String(rule?.data.track ?? rank.trackId),
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
  const input = rankChoice({
    soldierId: id,
    rankId: id,
    effectiveDate: date,
    reason: text,
  }).parse(payload);
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, input.soldierId));
  invariant(person && !person.deletedAt, "not_found", "חייל לא נמצא", 404);
  currentVersion(person.version, expectedVersion);
  const { rank, membership } = await resolveRankChoice(
    tx,
    input.rankId,
    input.trackId
  );
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
        trackId: membership.track,
        order: membership.order,
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
      trackId: reminder.data.track,
      effectiveDate: input.effectiveDate,
      reason: input.reason,
    },
    Number(reminder.data.personVersion)
  );
}
