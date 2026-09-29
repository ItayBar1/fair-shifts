import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Soldier } from "../domain/types";
import { populationAt, populationMoves } from "../domain/eligibility";
import type { DbTransaction } from "./db";
import { user } from "./auth-schema";
import { balances, records, soldierContacts, soldiers } from "./schema";
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
import {
  importColumns,
  importRows,
  type ImportProblem,
  type ImportRow,
  type ImportValues,
} from "./import-workbook";
import { profileInput, id, text } from "./validation";
import {
  effectiveToday,
  impactOf,
  populationChange,
  type DomainState,
} from "./personnel";
import { saveSoldier } from "./people";
import { setSoldierRank } from "./ranks";
import { postScore, settleDue } from "./scoring";

export type ImportChange = {
  key: string;
  label: string;
  before: unknown;
  after: unknown;
  version: number;
  source: "person" | "contact" | "score";
};
type PersonRow = typeof soldiers.$inferSelect;
type ContactRow = typeof soldierContacts.$inferSelect;
type RankRow = typeof records.$inferSelect;
type PlannedRow = {
  rowNumber: number;
  values: ImportValues;
  soldierId?: string;
  personVersion?: number;
  balanceVersion?: number;
  contactVersions?: Record<string, number>;
  name: string;
  mode: "create" | "update";
  profile: z.infer<typeof profileInput>;
  changes: ImportChange[];
  rank?: { id: string; version: number; effectiveDate: string };
  populationImpact?: PopulationImpact;
};
/**
 * A row that moves the soldier's population carries the reviewed impact on
 * that soldier's reserved assignments. It is part of the preview fingerprint,
 * so a change in those assignments between preview and approval is stale.
 */
type PopulationImpact = ReturnType<typeof populationChange> &
  ReturnType<typeof impactOf>;

const fieldLabels: Record<string, string> = {
  name: "שם מלא",
  populationHistory: "היסטוריית אוכלוסייה",
  rankHistory: "היסטוריית דרגות",
  "service.type": "סוג שירות",
  "service.basePopulation": "אוכלוסיית שיבוץ",
  "service.arrivalDate": "תאריך הגעה",
  "service.enlistmentDate": "תאריך גיוס",
  "service.releaseDate": "תאריך שחרור",
  "service.officerFrom": "תחילת קצונה",
  "service.permanentFrom": "תחילת קבע",
  "service.graceEligible": "זכאות לחסד",
  email: "מייל",
  phone: "טלפון",
  address: "כתובת",
  currentScore: "ניקוד נוכחי",
};
export function personImportFields(person: Soldier): Record<string, unknown> {
  return {
    name: person.name,
    populationHistory: person.populationHistory,
    rankHistory: person.rankHistory,
    ...Object.fromEntries(
      Object.entries(person.service).map(([key, value]) => [
        `service.${key}`,
        value,
      ])
    ),
  };
}
function differences(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  versions: Record<string, number>,
  source: ImportChange["source"]
): ImportChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(
      (key) =>
        JSON.stringify(before[key] ?? null) !==
        JSON.stringify(after[key] ?? null)
    )
    .map((key) => ({
      key,
      label: fieldLabels[key] ?? key,
      before: before[key] ?? null,
      after: after[key] ?? null,
      version: versions[key] ?? 0,
      source,
    }));
}
function profileFor(
  values: ImportValues,
  person?: PersonRow,
  contact?: ContactRow
) {
  const service = person?.data.service;
  return {
    id: person?.id,
    name: values.name ?? person?.name,
    personalNumber: values.personalNumber,
    email: values.email ?? contact?.email,
    phone: values.phone ?? contact?.phone ?? undefined,
    address: values.address ?? contact?.address ?? undefined,
    population:
      values.population ??
      (person
        ? populationAt(person.data, new Date().toISOString())
        : "mandatory"),
    serviceType: values.serviceType ?? service?.type ?? "mandatory",
    arrivalDate: values.arrivalDate ?? service?.arrivalDate,
    enlistmentDate: values.enlistmentDate ?? service?.enlistmentDate,
    releaseDate: values.releaseDate ?? service?.releaseDate,
    officerDate: values.officerDate ?? service?.officerFrom,
    permanentDate: values.permanentDate ?? service?.permanentFrom,
    graceEligible: values.graceEligible ?? service?.graceEligible ?? false,
  };
}
function proposedPerson(
  person: PersonRow,
  profile: z.infer<typeof profileInput>,
  rank?: RankRow,
  rankDate?: string
): Soldier {
  const data = structuredClone(person.data);
  data.name = profile.name;
  data.service = {
    type: profile.serviceType,
    basePopulation: data.service.basePopulation,
    arrivalDate: profile.arrivalDate,
    enlistmentDate: profile.enlistmentDate,
    releaseDate: profile.releaseDate,
    officerFrom: profile.officerDate,
    permanentFrom: profile.permanentDate,
    graceEligible: profile.graceEligible,
  };
  if (
    populationAt(person.data, new Date().toISOString()) !== profile.population
  )
    data.populationHistory = [
      ...data.populationHistory.filter(
        (item) => item.effectiveFrom !== effectiveToday()
      ),
      { effectiveFrom: effectiveToday(), population: profile.population },
    ];
  if (rank && rankDate)
    data.rankHistory = [
      ...data.rankHistory.filter((item) => item.effectiveFrom !== rankDate),
      {
        effectiveFrom: rankDate,
        rankId: rank.id,
        trackId: String(rank.data.track),
        order: Number(rank.data.order),
      },
    ];
  return data;
}

async function planRows(tx: DbTransaction, inputs: ImportRow[]) {
  const people = await tx.select().from(soldiers);
  const contacts = await tx.select().from(soldierContacts);
  const scores = await tx.select().from(balances);
  const accounts = await tx.select().from(user);
  const ranks = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "rank_catalog"));
  let domain: DomainState | undefined;
  const planned: PlannedRow[] = [];
  const problems: ImportProblem[] = [];
  const numbers = new Set<string>();
  const emails = new Set<string>();
  const problem = (row: ImportRow, key: string, reason: string, fix: string) =>
    problems.push({
      row: row.rowNumber,
      field: importColumns.find((item) => item.key === key)?.label ?? key,
      value: String(row.values[key as keyof ImportValues] ?? ""),
      reason,
      fix,
    });
  for (const row of inputs) {
    const values = row.values;
    if (numbers.has(values.personalNumber))
      problem(
        row,
        "personalNumber",
        "מספר אישי כפול בקובץ",
        "יש להשאיר שורה אחת לכל חייל"
      );
    numbers.add(values.personalNumber);
    const person = people.find(
      (item) => item.personalNumber === values.personalNumber
    );
    const contact = contacts.find((item) => item.soldierId === person?.id);
    const balance = scores.find((item) => item.soldierId === person?.id);
    if (person?.deletedAt) {
      problem(
        row,
        "personalNumber",
        "הרשומה נמחקה ואינה ניתנת לקליטה מחדש בייבוא",
        "יש לפנות לאחראי; הייבוא אינו משחזר מידע שנמחק"
      );
      continue;
    }
    if (!person && !values.name)
      problem(row, "name", "שם חובה בקליטה חדשה", "יש למלא שם מלא");
    if (!person && !values.email)
      problem(
        row,
        "email",
        "מייל חובה להזמנת חייל חדש",
        "יש למלא כתובת מאושרת להזמנה"
      );
    if (person && values.email && values.email !== contact?.email)
      problem(
        row,
        "email",
        "שינוי מייל מחייב אימות הכתובת החדשה",
        "יש לשנות מייל במסלול האימות באתר ולהשאיר תא זה ריק בייבוא"
      );
    if (values.email) {
      if (
        emails.has(values.email) ||
        accounts.some(
          (item) =>
            item.email.toLowerCase() === values.email &&
            item.soldierId !== person?.id
        )
      )
        problem(
          row,
          "email",
          "המייל כבר משויך לחשבון אחר או לשורה אחרת",
          "יש להזין כתובת ייחודית לכל חשבון"
        );
      emails.add(values.email);
    }
    const rankParts = [
      values.rankName,
      values.rankTrack,
      values.rankEffectiveDate,
    ];
    let rank: RankRow | undefined;
    if (rankParts.some((value) => value !== undefined)) {
      if (rankParts.some((value) => !value))
        problem(
          row,
          "rankName",
          "דרגה, מסלול ותאריך תחולה נדרשים יחד",
          "יש למלא את שלושת השדות או להשאיר את כולם ריקים"
        );
      else {
        rank = ranks.find(
          (item) =>
            item.data.name === values.rankName &&
            item.data.track === values.rankTrack
        );
        if (!rank)
          problem(
            row,
            "rankName",
            "הדרגה והמסלול אינם קיימים בקטלוג",
            "יש להשתמש בקטלוג הדרגות או להגדיר דרגה לפני הייבוא"
          );
      }
    }
    const result = profileInput.safeParse(profileFor(values, person, contact));
    if (!result.success) {
      for (const issue of result.error.issues)
        problem(
          row,
          String(issue.path[0]),
          issue.message,
          "יש לתקן את השדה לפי התבנית"
        );
      continue;
    }
    const profile = result.data;
    if (
      profile.releaseDate &&
      ((profile.arrivalDate && profile.releaseDate < profile.arrivalDate) ||
        (profile.enlistmentDate &&
          profile.releaseDate < profile.enlistmentDate))
    )
      problem(
        row,
        "releaseDate",
        "שחרור קודם להגעה או לגיוס",
        "יש לתקן את תאריכי השירות"
      );
    let changes: ImportChange[];
    let populationImpact: PopulationImpact | undefined;
    if (person) {
      const proposed = proposedPerson(
        person,
        profile,
        rank,
        values.rankEffectiveDate
      );
      if (populationMoves(person.data, proposed)) {
        domain ??= await loadDomain(tx);
        populationImpact = {
          ...populationChange(person.data, proposed),
          ...impactOf(domain, person.id, proposed),
        };
      }
      changes = differences(
        personImportFields(person.data),
        personImportFields(proposed),
        person.fieldVersions,
        "person"
      );
      changes.push(
        ...differences(
          { phone: contact?.phone, address: contact?.address },
          { phone: profile.phone, address: profile.address },
          contact?.fieldVersions ?? {},
          "contact"
        )
      );
      if (values.currentScore !== undefined)
        changes.push({
          key: "currentScore",
          label: "ניקוד נוכחי",
          before: balance?.current ?? 0,
          after: values.currentScore,
          version: balance?.version ?? 0,
          source: "score",
        });
    } else {
      changes = Object.entries(profile)
        .filter(([key, value]) => key !== "id" && value !== undefined)
        .map(([key, value]) => ({
          key,
          label: importColumns.find((item) => item.key === key)?.label ?? key,
          before: null,
          after: value,
          version: 0,
          source: ["email", "phone", "address"].includes(key)
            ? "contact"
            : "person",
        }));
      changes.push({
        key: "currentScore",
        label: "יתרת פתיחה",
        before: null,
        after: values.currentScore ?? 0,
        version: 0,
        source: "score",
      });
      if (rank)
        changes.push({
          key: "rankHistory",
          label: "דרגה",
          before: null,
          after: `${values.rankName} / ${values.rankTrack} / ${values.rankEffectiveDate}`,
          version: 0,
          source: "person",
        });
    }
    planned.push({
      rowNumber: row.rowNumber,
      values,
      soldierId: person?.id,
      personVersion: person?.version,
      balanceVersion: balance?.version,
      contactVersions: contact?.fieldVersions,
      name: profile.name,
      mode: person ? "update" : "create",
      profile,
      changes,
      rank:
        rank && values.rankEffectiveDate
          ? {
              id: rank.id,
              version: rank.version,
              effectiveDate: values.rankEffectiveDate,
            }
          : undefined,
      populationImpact,
    });
  }
  invariant(
    problems.length === 0,
    "import_errors",
    "הקובץ נדחה בשל שגיאות. לא נשמרו שינויים",
    422,
    { problems }
  );
  return planned;
}
function fingerprint(planned: PlannedRow[]) {
  return createHash("sha256").update(JSON.stringify(planned)).digest("hex");
}
function present(
  batch: typeof records.$inferSelect,
  rows: (typeof records.$inferSelect)[]
) {
  return {
    id: batch.id,
    version: batch.version,
    ...batch.data,
    rows: rows.map((row) => ({
      id: row.id,
      version: row.version,
      subjectId: row.subjectId,
      ...row.data,
    })),
  };
}
async function batchRows(tx: DbTransaction, batchId: string) {
  return (await tx.select().from(records).where(eq(records.kind, "import_row")))
    .filter((row) => row.data.batchId === batchId)
    .sort((a, b) => Number(a.data.rowNumber) - Number(b.data.rowNumber));
}
export async function getImport(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  manager(actor);
  const input = z.object({ id }).parse(payload);
  const people = await tx.select().from(soldiers);
  const details = (await batchRows(tx, input.id)).map((row) => {
    const person = people.find((item) => item.id === row.subjectId);
    return person?.deletedAt
      ? {
          ...row,
          data: {
            batchId: input.id,
            rowNumber: row.data.rowNumber,
            mode: row.data.mode,
            name: person.name,
            erased: true,
            changes: [],
          },
        }
      : row;
  });
  return present(await findRecord(tx, "import", input.id), details);
}
export async function previewImport(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  manager(actor);
  const input = z
    .object({ filename: z.string().trim().min(1).max(200), rows: importRows })
    .parse(payload);
  await settleDue(tx);
  const planned = await planRows(tx, input.rows);
  const batch = await createRecord(tx, "import", {
    filename: input.filename,
    status: "preview",
    actorId: actor.id,
    fingerprint: fingerprint(planned),
    expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    created: planned.filter((row) => row.mode === "create").length,
    updated: planned.filter(
      (row) => row.mode === "update" && row.changes.length > 0
    ).length,
    populationMoves: planned.filter((row) => row.populationImpact).length,
  });
  const details = [];
  for (const row of planned)
    details.push(
      await createRecord(
        tx,
        "import_row",
        { ...row, batchId: batch.id },
        row.soldierId
      )
    );
  return present(batch, details);
}
export async function applyImport(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({
      id,
      confirmed: z.literal(true),
      overwriteConfirmed: z.boolean().default(false),
      populationImpactConfirmed: z.boolean().default(false),
      reason: text,
    })
    .parse(payload);
  const batch = await findRecord(tx, "import", input.id);
  currentVersion(batch.version, expectedVersion);
  invariant(
    batch.data.status === "preview" &&
      new Date(String(batch.data.expiresAt)) > new Date(),
    "stale_import",
    "התצוגה פגה או כבר הוחלה; יש לייבא מחדש",
    409
  );
  const details = await batchRows(tx, batch.id);
  const inputs = importRows.parse(
    details.map((row) => ({
      rowNumber: row.data.rowNumber,
      values: row.data.values,
    }))
  );
  await settleDue(tx);
  const planned = await planRows(tx, inputs);
  invariant(
    fingerprint(planned) === batch.data.fingerprint,
    "stale_import",
    "נתונים השתנו מאז התצוגה המקדימה; יש להציג את הקובץ מחדש",
    409
  );
  invariant(
    !planned.some((row) => row.mode === "update" && row.changes.length) ||
      input.overwriteConfirmed,
    "overwrite_confirmation_required",
    "יש לאשר במפורש את דריסת השדות והיתרות הקיימים"
  );
  invariant(
    !planned.some((row) => row.populationImpact) ||
      input.populationImpactConfirmed,
    "population_impact_confirmation_required",
    "יש לאשר במפורש את מעבר האוכלוסייה ואת השיבוצים שהוא משפיע עליהם"
  );
  for (const row of planned) {
    const detail = details.find(
      (item) => item.data.rowNumber === row.rowNumber
    )!;
    let personId = row.soldierId;
    let version = row.personVersion;
    if (
      row.mode === "create" ||
      row.changes.some(
        (change) => change.source !== "score" && change.key !== "rankHistory"
      )
    ) {
      // The batch fingerprint already binds this save to the reviewed impact.
      const result = await saveSoldier(
        tx,
        actor,
        row.profile,
        row.personVersion,
        { populationReviewed: true }
      );
      personId = result.id;
      version = result.version;
    }
    invariant(personId, "invalid_import", "חסרה רשומת חייל לייבוא");
    if (row.rank) {
      const result = await setSoldierRank(
        tx,
        actor,
        {
          soldierId: personId,
          rankId: row.rank.id,
          effectiveDate: row.rank.effectiveDate,
          reason: input.reason,
        },
        version
      );
      version = result.version;
    }
    if (row.mode === "create" || row.values.currentScore !== undefined)
      await postScore(tx, {
        soldierId: personId,
        sourceKey: `import:${batch.id}:${personId}`,
        kind: row.mode === "create" ? "opening" : "import_set",
        actorId: actor.id,
        reason: input.reason,
        absolute: row.values.currentScore ?? 0,
        effectiveAt: new Date(),
        data: { batchId: batch.id, barrier: true },
      });
    const [person] = await tx
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, personId));
    const [contact] = await tx
      .select()
      .from(soldierContacts)
      .where(eq(soldierContacts.soldierId, personId));
    const [balance] = await tx
      .select()
      .from(balances)
      .where(eq(balances.soldierId, personId));
    const appliedChanges = row.changes.map((change) => ({
      ...change,
      version:
        change.source === "score"
          ? balance.version
          : ((change.source === "contact"
              ? contact.fieldVersions
              : person.fieldVersions)[change.key] ?? 0),
    }));
    await tx
      .update(records)
      .set({ subjectId: personId })
      .where(eq(records.id, detail.id));
    await updateRecord(tx, detail, {
      ...detail.data,
      changes: appliedChanges,
      appliedVersion: version,
      appliedAt: new Date().toISOString(),
    });
  }
  const updated = await updateRecord(tx, batch, {
    ...batch.data,
    status: "applied",
    reason: input.reason,
    appliedBy: actor.id,
    appliedAt: new Date().toISOString(),
  });
  await audit(tx, actor, "import.apply", batch.id, {
    created: batch.data.created,
    updated: batch.data.updated,
  });
  return present(updated, await batchRows(tx, batch.id));
}
