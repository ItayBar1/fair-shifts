import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Soldier } from "../domain/types";
import { balances, records, soldierContacts, soldiers } from "./schema";
import { user } from "./auth-schema";
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
async function restoreRows(
  tx: DbTransaction,
  batchId: string
): Promise<RestoreRow[]> {
  const details = (
    await tx.select().from(records).where(eq(records.kind, "import_row"))
  )
    .filter((row) => row.data.batchId === batchId)
    .sort((a, b) => Number(a.data.rowNumber) - Number(b.data.rowNumber));
  const people = await tx.select().from(soldiers);
  const contacts = await tx.select().from(soldierContacts);
  const scores = await tx.select().from(balances);
  return details.map((row) => {
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
    return {
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
      pendingNew: row.data.mode === "create" && !row.data.newRowRestored,
    };
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
  invariant(
    rows.some((row) => row.fields.length > 0) ||
      rows.every((row) => !row.pendingNew),
    "nothing_to_restore",
    "אין עדכונים לרשומות קיימות שנותרו לשחזור"
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
  await refreshRankReminders(tx);
  await updateRecord(tx, preview, { ...preview.data, applied: true });
  await updateRecord(tx, batch, {
    ...batch.data,
    status: rows.some((row) => row.pendingNew)
      ? "partially_restored"
      : "restored",
    restoredBy: actor.id,
    restoredAt: new Date().toISOString(),
    restoreReason: input.reason,
  });
  await audit(tx, actor, "import.restore", batch.id, {
    changed,
    kept,
    populationMoves: populationMoved,
    pendingNew: rows.filter((row) => row.pendingNew).length,
  });
  return getImport(tx, actor, { id: batch.id });
}
