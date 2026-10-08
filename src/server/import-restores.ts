import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Soldier } from "../domain/types";
import {
  assignments,
  balances,
  ledger,
  records,
  soldierContacts,
  soldiers,
  commandResultSubjects,
} from "./schema";
import { eraseRelatedCopies } from "./soldier-deletion";
import {
  account,
  emailOutbox,
  recoveryCode,
  session,
  user,
} from "./auth-schema";
import type { DbTransaction } from "./db";
import { invariant } from "./errors";
import {
  audit,
  createRecord,
  currentVersion,
  findRecord,
  loadDomain,
  manager,
  updateRecord,
  type Actor,
} from "./repository";
import { populationMoves } from "../domain/eligibility";
import { getImport, personImportFields } from "./imports";
import { postScore, settleDue } from "./scoring";
import {
  impactOf,
  populationChange,
  reassessAssignments,
  type DomainState,
} from "./personnel";
import { refreshRankReminders } from "./ranks";
import { deletionSummary, eraseSoldier } from "./soldier-deletion";
import { date, id, population, text } from "./validation";

const changeSchema = z.object({
  key: z.string(),
  label: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  version: z.number().int().nonnegative(),
  source: z.enum(["person", "contact", "score"]),
});
type Change = z.infer<typeof changeSchema>;
type RestoreField = Change & {
  current: unknown;
  actualVersion: number;
  proposed: unknown;
  status: "automatic" | "conflict" | "erased";
};
type RestoreRow = {
  id: string;
  version: number;
  soldierId: string | null;
  name: string;
  rowNumber: number;
  mode: string;
  fields: RestoreField[];
  personVersion?: number;
  balanceVersion?: number;
  contactVersions?: Record<string, number>;
  pendingNew: boolean;
  personalNumber?: string;
  /** Only for a new soldier from this batch whose row is not closed yet. */
  creation?: Creation;
};
/**
 * Decision 174: a new soldier without activity since the import is cancelled
 * by full removal; with activity the row waits for the manager, who keeps the
 * soldier or deletes the user (decision 192); a soldier erased through the
 * deletion flow closes without action.
 */
type Creation = {
  status: "cancel" | "activity" | "erased";
  activity: string[];
  /** For a row with activity: what a deletion decision would do (ticket #33). */
  deletion?: Awaited<ReturnType<typeof deletionSummary>>;
};
type RecordRow = typeof records.$inferSelect;
type Context = {
  batchId: string;
  assignments: (typeof assignments.$inferSelect)[];
  ledger: (typeof ledger.$inferSelect)[];
  records: RecordRow[];
  accounts: (typeof user.$inferSelect)[];
  sessions: (typeof session.$inferSelect)[];
  linked: (typeof account.$inferSelect)[];
  recovery: (typeof recoveryCode.$inferSelect)[];
};

/** Undo only entries touched by the import; later history entries remain intact. */
function restoredHistory(change: Change, current: unknown) {
  const before = z
    .array(z.record(z.string(), z.unknown()))
    .parse(change.before ?? []);
  const after = z
    .array(z.record(z.string(), z.unknown()))
    .parse(change.after ?? []);
  const now = z.array(z.record(z.string(), z.unknown())).parse(current ?? []);
  const at = (row: Record<string, unknown>) => String(row.effectiveFrom);
  const dates = [...new Set([...before, ...after].map(at))].filter(
    (date) =>
      JSON.stringify(before.find((row) => at(row) === date) ?? null) !==
      JSON.stringify(after.find((row) => at(row) === date) ?? null)
  );
  return [
    ...now.filter((row) => !dates.includes(at(row))),
    ...before.filter((row) => dates.includes(at(row))),
  ].sort((a, b) => at(a).localeCompare(at(b)));
}
/**
 * Records the system creates for a soldier without anyone acting on them.
 * They are not activity; a cancelled import removes or detaches them.
 */
const systemKinds = new Set([
  "audit",
  "notification",
  "rank_reminder",
  "departure",
  "round_notice",
  "score_preview",
  "planning_run",
  "import",
  "import_restore_preview",
]);
const activityLabels: Record<string, string> = {
  constraint: "אילוץ או הצהרת ״אין לי אילוצים״",
  constraint_revision: "אילוץ או הצהרת ״אין לי אילוצים״",
  request: "בקשה או הצעת העברה",
  email_change: "שינוי מייל",
  settings: "העדפות הודעות אישיות",
  personnel_change: "עריכה בנתוני החייל",
  rank_history_revision: "עריכה בנתוני החייל",
  rank_deadline: "עריכה בנתוני החייל",
  import_restore_profile_revision: "עריכה בנתוני החייל",
  import_row: "עדכון בייבוא מאוחר",
  lottery_attempt: "הצעה או שיבוץ בהגרלה",
  lottery_exclusion: "הצעה או שיבוץ בהגרלה",
  assignment_approval: "הצעה או שיבוץ בהגרלה",
  duty_change: "שיבוץ בשינוי לתורנות",
  duty_revision: "שיבוץ בשינוי לתורנות",
  score_decision: "פעולת ניקוד",
};
const versionsDiffer = (
  before: Record<string, number>,
  after: Record<string, number>
) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].some(
    (key) => (before[key] ?? 0) !== (after[key] ?? 0)
  );
/** Everything since the import that decision 174 counts as activity. */
function creationActivity(
  context: Context,
  row: RecordRow,
  person: typeof soldiers.$inferSelect,
  contact: typeof soldierContacts.$inferSelect | undefined,
  balance: typeof balances.$inferSelect | undefined
) {
  const found = new Set<string>();
  const soldierId = person.id;
  const login = context.accounts.find((item) => item.soldierId === soldierId);
  const changes = z.array(changeSchema).parse(row.data.changes ?? []);
  if (context.assignments.some((item) => item.soldierId === soldierId))
    found.add("שיבוץ");
  if (
    context.ledger.some(
      (entry) =>
        entry.soldierId === soldierId &&
        entry.sourceKey !== `import:${context.batchId}:${soldierId}`
    ) ||
    (balance?.version ?? 0) !==
      Number(
        row.data.appliedBalanceVersion ??
          changes.find((change) => change.source === "score")?.version ??
          0
      )
  )
    found.add("פעולת ניקוד");
  const fieldVersions = row.data.appliedFieldVersions as
    Record<string, number> | undefined;
  if (
    person.version !== Number(row.data.appliedVersion) ||
    (fieldVersions && versionsDiffer(fieldVersions, person.fieldVersions))
  )
    found.add("עריכה בנתוני החייל");
  const contactVersions =
    (row.data.appliedContactVersions as Record<string, number> | undefined) ??
    Object.fromEntries(
      changes
        .filter((change) => change.source === "contact")
        .map((change) => [change.key, change.version])
    );
  if (versionsDiffer(contactVersions, contact?.fieldVersions ?? {}))
    found.add("עריכה בפרטי הקשר");
  if (
    login &&
    (login.firstSignInAt ||
      login.emailVerified ||
      context.sessions.some((item) => item.userId === login.id) ||
      context.linked.some((item) => item.userId === login.id) ||
      context.recovery.some((item) => item.userId === login.id))
  )
    found.add("כניסה לחשבון");
  if (login && login.role !== "soldier") found.add("שינוי הרשאה");
  for (const item of context.records) {
    if (item.id === row.id || systemKinds.has(item.kind)) continue;
    const text = JSON.stringify(item.data);
    const refers =
      item.subjectId === soldierId ||
      text.includes(soldierId) ||
      (login !== undefined && text.includes(login.id));
    if (!refers) continue;
    // User decision (29.09.2026): being only a candidate in a lottery picture is
    // not activity; being drawn, proposed or rejected is.
    // The rank the import itself set is part of the import, not an edit.
    if (
      item.kind === "rank_history_revision" &&
      Number(item.data.personVersion) < Number(row.data.appliedVersion)
    )
      continue;
    // A later file that was only previewed never changed the soldier.
    if (
      item.kind === "import_row" &&
      context.records.find((batch) => batch.id === item.data.batchId)?.data
        .status === "preview"
    )
      continue;
    if (
      item.kind === "lottery_attempt" &&
      item.subjectId !== soldierId &&
      item.data.candidateId !== soldierId
    )
      continue;
    found.add(activityLabels[item.kind] ?? "פעילות אחרת במערכת");
  }
  return [...found];
}
async function restoreContext(
  tx: DbTransaction,
  batchId: string
): Promise<Context> {
  return {
    batchId,
    assignments: await tx.select().from(assignments),
    ledger: await tx.select().from(ledger),
    records: await tx.select().from(records),
    accounts: await tx.select().from(user),
    sessions: await tx.select().from(session),
    linked: await tx.select().from(account),
    recovery: await tx.select().from(recoveryCode),
  };
}
async function batchDetails(tx: DbTransaction, batchId: string) {
  return (await tx.select().from(records).where(eq(records.kind, "import_row")))
    .filter((row) => row.data.batchId === batchId)
    .sort((a, b) => Number(a.data.rowNumber) - Number(b.data.rowNumber));
}
async function restoreRows(
  tx: DbTransaction,
  batchId: string
): Promise<RestoreRow[]> {
  const details = await batchDetails(tx, batchId);
  const people = await tx.select().from(soldiers);
  const contacts = await tx.select().from(soldierContacts);
  const scores = await tx.select().from(balances);
  const context = details.some(
    (row) => row.data.mode === "create" && !row.data.newRowRestored
  )
    ? await restoreContext(tx, batchId)
    : undefined;
  const result: RestoreRow[] = [];
  for (const row of details) {
    const person = people.find((item) => item.id === row.subjectId);
    const contact = contacts.find((item) => item.soldierId === row.subjectId);
    const balance = scores.find((item) => item.soldierId === row.subjectId);
    const erased = !person || !!person.deletedAt;
    const restoredKeys = Object.keys(
      z.record(z.string(), z.unknown()).parse(row.data.restoredFields ?? {})
    );
    const fields =
      row.data.mode === "create"
        ? []
        : z
            .array(changeSchema)
            .parse(row.data.changes ?? [])
            .filter((change) => !restoredKeys.includes(change.key))
            .map((change): RestoreField => {
              if (erased)
                return {
                  ...change,
                  before: null,
                  after: null,
                  current: null,
                  proposed: null,
                  actualVersion: 0,
                  status: "erased",
                };
              const current =
                (change.source === "person"
                  ? personImportFields(person.data)[change.key]
                  : change.source === "contact"
                    ? contact?.[change.key as "phone" | "address"]
                    : balance?.current) ?? null;
              const version =
                change.source === "person"
                  ? (person.fieldVersions[change.key] ?? 0)
                  : change.source === "contact"
                    ? (contact?.fieldVersions[change.key] ?? 0)
                    : (balance?.version ?? 0);
              return {
                ...change,
                current,
                actualVersion: version,
                proposed: ["populationHistory", "rankHistory"].includes(
                  change.key
                )
                  ? restoredHistory(change, current)
                  : change.before,
                status: version === change.version ? "automatic" : "conflict",
              };
            });
    const pendingNew = row.data.mode === "create" && !row.data.newRowRestored;
    let creation: Creation | undefined;
    if (pendingNew) {
      const activity =
        erased || !context
          ? []
          : creationActivity(context, row, person, contact, balance);
      creation = {
        status: erased ? "erased" : activity.length ? "activity" : "cancel",
        activity,
      };
      if (creation.status === "activity" && person)
        creation.deletion = await deletionSummary(tx, person.id);
    }
    result.push({
      id: row.id,
      version: row.version,
      soldierId: row.subjectId,
      name: person?.name ?? String(row.data.name),
      rowNumber: Number(row.data.rowNumber),
      mode: String(row.data.mode),
      fields,
      personVersion: person?.version,
      balanceVersion: balance?.version,
      contactVersions: contact?.fieldVersions,
      pendingNew,
      ...(pendingNew
        ? {
            personalNumber: String(
              z.record(z.string(), z.unknown()).parse(row.data.values ?? {})
                .personalNumber ?? ""
            ),
            creation,
          }
        : {}),
    });
  }
  return result;
}
const contactKeys = ["email", "phone", "address"];
function withoutContact(value: unknown) {
  return Object.fromEntries(
    Object.entries(z.record(z.string(), z.unknown()).parse(value ?? {})).filter(
      ([key]) => !contactKeys.includes(key)
    )
  );
}
/**
 * Removes a soldier created by the import as if never imported (decision 174).
 * The import row keeps its number, name, personal number and outcome only.
 */
async function cancelCreation(
  tx: DbTransaction,
  actor: Actor,
  batchId: string,
  row: RestoreRow,
  reason: string
) {
  const soldierId = row.soldierId!;
  const [login] = await tx
    .select()
    .from(user)
    .where(eq(user.soldierId, soldierId));
  await eraseRelatedCopies(
    tx,
    soldierId,
    login?.id,
    [],
    new Date().toISOString()
  );
  await tx
    .delete(commandResultSubjects)
    .where(eq(commandResultSubjects.soldierId, soldierId));
  const reminders = (
    await tx.select().from(records).where(eq(records.subjectId, soldierId))
  )
    .filter((item) => item.kind === "rank_reminder")
    .map((item) => item.id);
  const notices = (
    await tx.select().from(records).where(eq(records.kind, "notification"))
  ).filter(
    (item) =>
      item.subjectId === soldierId ||
      (login && item.data.accountId === login.id) ||
      reminders.includes(String(item.data.reminderId))
  );
  if (notices.length)
    await tx.delete(records).where(
      inArray(
        records.id,
        notices.map((item) => item.id)
      )
    );
  await tx.delete(records).where(
    and(
      eq(records.subjectId, soldierId),
      // The only rank revision left is the one the import itself made.
      inArray(records.kind, [
        "rank_reminder",
        "departure",
        "rank_history_revision",
      ])
    )
  );
  // History stays; it only stops pointing at a record that no longer exists.
  await tx
    .update(records)
    .set({ subjectId: null })
    .where(and(eq(records.subjectId, soldierId), eq(records.kind, "audit")));
  const detail = await findRecord(tx, "import_row", row.id);
  // This row, and rows of later files that were only previewed; applying such
  // a preview now finds the soldier gone and asks for a new preview.
  await tx
    .update(records)
    .set({ subjectId: null })
    .where(
      and(eq(records.subjectId, soldierId), eq(records.kind, "import_row"))
    );
  const remaining = await tx
    .select({ id: records.id })
    .from(records)
    .where(eq(records.subjectId, soldierId));
  invariant(
    remaining.length === 0,
    "stale_restore",
    "נוספה פעילות לחייל מאז תצוגת השחזור; יש לבדוק שוב",
    409
  );
  if (login) {
    // Queued mail (the invitation included) is cancelled with the account.
    await tx
      .delete(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, login.id));
    await tx.delete(recoveryCode).where(eq(recoveryCode.userId, login.id));
    // Sessions, sign-in codes and linked providers cascade.
    await tx.delete(user).where(eq(user.id, login.id));
  }
  await tx.delete(ledger).where(eq(ledger.soldierId, soldierId));
  await tx.delete(balances).where(eq(balances.soldierId, soldierId));
  await tx
    .delete(soldierContacts)
    .where(eq(soldierContacts.soldierId, soldierId));
  await tx.delete(soldiers).where(eq(soldiers.id, soldierId));
  await updateRecord(tx, detail, {
    ...detail.data,
    values: withoutContact(detail.data.values),
    profile: withoutContact(detail.data.profile),
    changes: z
      .array(changeSchema)
      .parse(detail.data.changes ?? [])
      .filter((change) => !contactKeys.includes(change.key)),
    newRowRestored: {
      action: "cancelled",
      reason,
      actorId: actor.id,
      at: new Date().toISOString(),
    },
  });
}
function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
const decisionSchema = z.object({
  rowId: id,
  key: z.string().min(1).max(100),
  action: z.enum(["keep", "restore", "set_score"]),
  value: z.number().int().nonnegative().max(2147483647).optional(),
});
type Decision = z.infer<typeof decisionSchema>;
const decisionsSchema = z.array(decisionSchema).max(10000).default([]);
/** Every decision must belong to a restorable field and fit its kind. */
function checkDecisions(rows: RestoreRow[], decisions: Decision[]) {
  const decisionKeys = decisions.map(
    (decision) => `${decision.rowId}:${decision.key}`
  );
  invariant(
    new Set(decisionKeys).size === decisionKeys.length,
    "duplicate_decision",
    "נשלחה החלטת שדה כפולה"
  );
  for (const decision of decisions) {
    const field = rows
      .find((row) => row.id === decision.rowId)
      ?.fields.find((field) => field.key === decision.key);
    invariant(
      field && field.status !== "erased",
      "invalid_decision",
      "ההחלטה אינה שייכת לשדה שניתן לשחזר"
    );
    invariant(
      decision.action !== "set_score" ||
        (field.source === "score" && decision.value !== undefined),
      "invalid_decision",
      "קביעת יתרה מחייבת ערך ניקוד מפורש"
    );
    invariant(
      !(
        field.status === "conflict" &&
        field.source === "score" &&
        decision.action === "restore"
      ),
      "score_decision_required",
      "יתרה שהשתנתה מחייבת קביעה מפורשת או השארת היתרה הנוכחית"
    );
  }
}
/**
 * The action taken on a field: an automatic field is restored unless kept, and
 * a conflict is left as it is until the manager decides it.
 */
function actionOf(row: RestoreRow, field: RestoreField, decisions: Decision[]) {
  if (field.status === "erased") return "erased";
  const decision = decisions.find(
    (decision) => decision.rowId === row.id && decision.key === field.key
  );
  return decision?.action ?? (field.status === "conflict" ? "keep" : "restore");
}
type PopulationImpact = ReturnType<typeof populationChange> &
  ReturnType<typeof impactOf>;
/**
 * For each row whose restore, under the given decisions, moves the soldier's
 * population timeline: the timeline before and after, and the reserved
 * assignments whose eligibility changes (decision 165).
 */
function populationImpacts(
  rows: RestoreRow[],
  decisions: Decision[],
  domain: DomainState
) {
  const impacts: Record<string, PopulationImpact> = {};
  for (const row of rows) {
    const person = domain.soldiers.find(
      (item) => item.id === row.soldierId && !item.deletedAt
    );
    if (!person) continue;
    const current = structuredClone(person) as Soldier;
    const proposed = structuredClone(person) as Soldier;
    for (const field of row.fields)
      if (
        field.source === "person" &&
        actionOf(row, field, decisions) === "restore"
      )
        applyPersonField(proposed, field);
    if (populationMoves(current, proposed))
      impacts[row.id] = {
        ...populationChange(current, proposed),
        ...impactOf(domain, person.id, proposed),
      };
  }
  return impacts;
}
export async function previewImportRestore(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z.object({ id, decisions: decisionsSchema }).parse(payload);
  const batch = await findRecord(tx, "import", input.id);
  currentVersion(batch.version, expectedVersion);
  invariant(
    ["applied", "partially_restored"].includes(String(batch.data.status)),
    "invalid_restore",
    "ניתן לשחזר אצווה שנשמרה ושטרם נסגר שחזורה",
    409
  );
  await settleDue(tx);
  const rows = await restoreRows(tx, batch.id);
  checkDecisions(rows, input.decisions);
  const impacts = populationImpacts(
    rows,
    input.decisions,
    await loadDomain(tx)
  );
  const preview = await createRecord(tx, "import_restore_preview", {
    batchId: batch.id,
    batchVersion: batch.version,
    actorId: actor.id,
    fingerprint: fingerprint(rows),
    impactFingerprint: fingerprint(impacts),
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
  });
  return {
    token: preview.id,
    id: batch.id,
    version: batch.version,
    rows: rows.map((row) => ({ ...row, populationImpact: impacts[row.id] })),
    populationMoves: Object.keys(impacts).length,
    decisionsPending: rows.some((row) =>
      row.fields.some(
        (field) =>
          field.status === "conflict" &&
          !input.decisions.some(
            (decision) =>
              decision.rowId === row.id && decision.key === field.key
          )
      )
    ),
  };
}
function applyPersonField(person: Soldier, field: RestoreField) {
  if (field.key === "name") person.name = text.parse(field.proposed);
  else if (field.key === "populationHistory")
    person.populationHistory = z
      .array(z.object({ effectiveFrom: date, population }))
      .parse(field.proposed);
  else if (field.key === "rankHistory")
    person.rankHistory = z
      .array(
        z.object({
          effectiveFrom: date,
          rankId: id,
          trackId: z.string(),
          order: z.number().int(),
        })
      )
      .parse(field.proposed);
  else if (field.key.startsWith("service."))
    person.service = {
      ...person.service,
      [field.key.slice(8)]: field.proposed ?? undefined,
    };
  else invariant(false, "invalid_restore_field", "שדה השחזור אינו נתמך");
}
export async function applyImportRestore(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({
      id,
      token: id,
      confirmed: z.literal(true),
      reason: text,
      decisions: decisionsSchema,
      populationImpactConfirmed: z.boolean().default(false),
      // A new soldier with activity is kept or deleted only by an explicit row decision.
      creations: z
        .array(z.object({ rowId: id, action: z.enum(["keep", "delete"]) }))
        .max(10000)
        .default([]),
    })
    .parse(payload);
  const batch = await findRecord(tx, "import", input.id);
  currentVersion(batch.version, expectedVersion);
  const preview = await findRecord(tx, "import_restore_preview", input.token);
  invariant(
    preview.data.batchId === batch.id &&
      preview.data.batchVersion === batch.version &&
      preview.data.actorId === actor.id &&
      !preview.data.applied &&
      new Date(String(preview.data.expiresAt)) > new Date(),
    "stale_restore",
    "תצוגת השחזור פגה או כבר הוחלה; יש לחשב מחדש",
    409
  );
  await settleDue(tx);
  // A first sign-in commits under this row lock, so it either shows in the
  // fingerprint below or finds the account removed.
  const created = (await batchDetails(tx, batch.id)).flatMap((row) =>
    row.data.mode === "create" && !row.data.newRowRestored && row.subjectId
      ? [row.subjectId]
      : []
  );
  if (created.length)
    await tx
      .select({ id: user.id })
      .from(user)
      .where(inArray(user.soldierId, created))
      .for("update");
  const rows = await restoreRows(tx, batch.id);
  invariant(
    fingerprint(rows) === preview.data.fingerprint,
    "stale_restore",
    "נתונים השתנו מאז תצוגת השחזור; יש לבדוק שוב את ההתנגשויות",
    409
  );
  checkDecisions(rows, input.decisions);
  for (const row of rows)
    for (const field of row.fields)
      invariant(
        field.status !== "conflict" ||
          input.decisions.some(
            (decision) =>
              decision.rowId === row.id && decision.key === field.key
          ),
        "restore_decision_required",
        "יש להכריע בכל שדה שהשתנה מאז הייבוא"
      );
  const creationIds = input.creations.map((decision) => decision.rowId);
  invariant(
    new Set(creationIds).size === creationIds.length,
    "duplicate_decision",
    "נשלחה החלטה כפולה לשורת קליטה"
  );
  for (const decision of input.creations) {
    const creation = rows.find((row) => row.id === decision.rowId)?.creation;
    invariant(
      creation?.status === "activity",
      "invalid_decision",
      "ההחלטה אינה שייכת לקליטה עם פעילות שממתינה להכרעה"
    );
    invariant(
      decision.action !== "delete" || creation.deletion?.deletable,
      "invalid_decision",
      "אי אפשר למחוק את החייל הזה במסלול השחזור. המנהל הטכני מסיר קודם את הרשאת האחראי"
    );
  }
  invariant(
    rows.some((row) => row.fields.length > 0) ||
      rows.some((row) => row.creation && row.creation.status !== "activity") ||
      input.creations.length > 0 ||
      rows.every((row) => !row.pendingNew),
    "nothing_to_restore",
    "אין שדות או קליטות שנותרו לשחזור. קליטה עם פעילות נשארת עד להכרעה בשורה"
  );
  // A restore that moves a population saves only against the impact reviewed
  // for these decisions, with its assignments unchanged since (decision 165).
  const impacts = populationImpacts(
    rows,
    input.decisions,
    await loadDomain(tx)
  );
  const populationMoved = Object.keys(impacts).length;
  invariant(
    !populationMoved || fingerprint(impacts) === preview.data.impactFingerprint,
    "stale_restore_impact",
    "ההכרעות או השיבוצים של החייל השתנו מאז תצוגת ההשפעה; יש לחשב מחדש את השפעת השחזור",
    409
  );
  invariant(
    !populationMoved || input.populationImpactConfirmed,
    "population_impact_confirmation_required",
    "יש לאשר במפורש את מעבר האוכלוסייה ואת השיבוצים שהשחזור משפיע עליהם"
  );
  let changed = 0;
  let kept = 0;
  for (const row of rows.filter((row) => row.fields.length > 0)) {
    const detail = await findRecord(tx, "import_row", row.id);
    const [person] = row.soldierId
      ? await tx.select().from(soldiers).where(eq(soldiers.id, row.soldierId))
      : [];
    const data = person ? structuredClone(person.data) : undefined;
    const contactChanges: { phone?: string | null; address?: string | null } =
      {};
    const resolutions: Record<string, unknown> = {
      ...z
        .record(z.string(), z.unknown())
        .parse(detail.data.restoredFields ?? {}),
    };
    let profileChanged = false;
    for (const field of row.fields) {
      const decision = input.decisions.find(
        (decision) => decision.rowId === row.id && decision.key === field.key
      );
      const action =
        field.status === "erased" ? "erased" : (decision?.action ?? "restore");
      resolutions[field.key] = {
        action,
        reason: input.reason,
        actorId: actor.id,
        at: new Date().toISOString(),
      };
      if (action === "erased" || action === "keep") {
        kept++;
        continue;
      }
      invariant(
        person && data && !person.deletedAt,
        "erased_person",
        "אין להחזיר מידע לחשבון שנמחק"
      );
      if (field.source === "score") {
        await postScore(tx, {
          soldierId: person.id,
          sourceKey: `import_restore:${batch.id}:${row.id}`,
          kind: "import_restore",
          actorId: actor.id,
          reason: input.reason,
          absolute:
            decision?.action === "set_score"
              ? decision.value
              : Number(field.before),
          effectiveAt: new Date(),
          data: { batchId: batch.id, barrier: true },
        });
      } else if (field.source === "contact") {
        invariant(
          field.key === "phone" || field.key === "address",
          "invalid_restore_field",
          "מייל אינו ניתן לשחזור ללא אימות"
        );
        contactChanges[field.key] =
          field.proposed === null ? null : String(field.proposed);
      } else {
        applyPersonField(data, field);
        profileChanged = true;
      }
      changed++;
    }
    if (person && data && !person.deletedAt) {
      if (profileChanged) {
        invariant(
          !data.service.releaseDate ||
            ((!data.service.arrivalDate ||
              data.service.releaseDate >= data.service.arrivalDate) &&
              (!data.service.enlistmentDate ||
                data.service.releaseDate >= data.service.enlistmentDate)),
          "restore_service_conflict",
          "השחזור יוצר סתירה בתאריכי השירות; יש להשאיר את השדה המתאים ללא שחזור"
        );
        await createRecord(
          tx,
          "import_restore_profile_revision",
          {
            batchId: batch.id,
            before: person.data,
            reason: input.reason,
            actorId: actor.id,
          },
          person.id
        );
        data.version = person.version + 1;
        await tx
          .update(soldiers)
          .set({
            name: data.name,
            data,
            version: data.version,
            updatedAt: new Date(),
          })
          .where(eq(soldiers.id, person.id));
        await tx
          .update(user)
          .set({ name: data.name })
          .where(eq(user.soldierId, person.id));
        await reassessAssignments(tx, person.id);
      }
      if (Object.keys(contactChanges).length)
        await tx
          .insert(soldierContacts)
          .values({ soldierId: person.id, ...contactChanges })
          .onConflictDoUpdate({
            target: soldierContacts.soldierId,
            set: contactChanges,
          });
    }
    await updateRecord(tx, detail, {
      ...detail.data,
      restoredFields: resolutions,
    });
    await audit(
      tx,
      actor,
      "import.restore.row",
      row.id,
      { batchId: batch.id, fields: Object.keys(resolutions) },
      row.soldierId ?? undefined
    );
  }
  let cancelled = 0;
  let deleted = 0;
  let waiting = 0;
  for (const row of rows) {
    if (!row.creation) continue;
    const decision = input.creations.find((item) => item.rowId === row.id);
    const keep = decision?.action === "keep";
    const remove = decision?.action === "delete";
    if (row.creation.status === "activity" && !keep && !remove) {
      waiting++;
      continue;
    }
    if (row.creation.status === "cancel") {
      await cancelCreation(tx, actor, batch.id, row, input.reason);
      cancelled++;
    } else if (remove) {
      // Deleting the user (decision 192): the soldier's data leaves every
      // active copy and the future seats are vacated, with the managers told.
      await eraseSoldier(tx, actor, row.soldierId!, {
        reason: input.reason,
        via: "import.restore",
      });
      const detail = await findRecord(tx, "import_row", row.id);
      await updateRecord(tx, detail, {
        ...detail.data,
        newRowRestored: {
          action: "deleted",
          reason: input.reason,
          actorId: actor.id,
          at: new Date().toISOString(),
        },
      });
      deleted++;
    } else {
      const detail = await findRecord(tx, "import_row", row.id);
      await updateRecord(tx, detail, {
        ...detail.data,
        newRowRestored: {
          action: row.creation.status === "erased" ? "erased" : "kept",
          reason: input.reason,
          actorId: actor.id,
          at: new Date().toISOString(),
          ...(keep ? { activity: row.creation.activity } : {}),
        },
      });
      if (keep) kept++;
    }
    await audit(tx, actor, "import.restore.row", row.id, {
      batchId: batch.id,
      creation:
        row.creation.status === "cancel"
          ? "cancelled"
          : row.creation.status === "erased"
            ? "erased"
            : remove
              ? "deleted"
              : "kept",
    });
  }
  await refreshRankReminders(tx);
  await updateRecord(tx, preview, { ...preview.data, applied: true });
  await updateRecord(tx, batch, {
    ...batch.data,
    status: waiting ? "partially_restored" : "restored",
    restoredBy: actor.id,
    restoredAt: new Date().toISOString(),
    restoreReason: input.reason,
  });
  await audit(tx, actor, "import.restore", batch.id, {
    changed,
    kept,
    cancelled,
    deleted,
    populationMoves: populationMoved,
    pendingNew: waiting,
  });
  return getImport(tx, actor, { id: batch.id });
}
