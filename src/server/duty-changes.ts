import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { assignments, duties, dutySlots, dutyTypes, records } from "./schema";
import { emailOutbox, user } from "./auth-schema";
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
import { invariant } from "./errors";
import { id, text } from "./validation";
import { parseMoment } from "./duty-service";
import { instant, interval } from "../domain/time";
import { calculatePrice } from "../domain/pricing";
import { evaluateEligibility } from "../domain/eligibility";
import type {
  Assignment,
  DutySlot,
  Pricing,
  Requirements,
  SpecificApproval,
} from "../domain/types";
import { enqueueEmail } from "./operations/email";
import { closeTransfersForDuty } from "./transfers";

type SavedDuty = (typeof duties.$inferSelect)["data"];
type Seat = { slotId: string; soldierId: string | null; extraPoints: string };
type Change = {
  dutyId: string;
  baseVersion: number;
  status: string;
  proposed: SavedDuty;
  seats: Seat[];
  reason: string;
  catalogVersion?: number;
};
const seatInput = z.object({
  slotId: id,
  soldierId: id.nullable(),
  extraPoints: z
    .union([
      z.number().nonnegative().finite(),
      z.string().regex(/^\d+(\.\d+)?$/),
    ])
    .transform(String),
});
async function liveDuty(tx: DbTransaction, dutyId: string, version: number) {
  const [row] = await tx.select().from(duties).where(eq(duties.id, dutyId));
  invariant(row, "not_found", "תורנות לא נמצאה", 404);
  currentVersion(row.version, version);
  invariant(
    (row.data.status === "published" || row.data.status === "draft") &&
      instant(row.data.start).toMillis() > Date.now(),
    "cannot_change",
    "ניתן לשנות טיוטה או תורנות שפורסמה וטרם התחילה"
  );
  return row;
}
async function openChange(
  tx: DbTransaction,
  changeId: string,
  expectedVersion?: number
) {
  const row = await findRecord(tx, "duty_change", changeId);
  currentVersion(row.version, expectedVersion);
  const change = row.data as Change;
  invariant(
    change.status === "open",
    "closed_change",
    "הצעת השינוי כבר נסגרה",
    409
  );
  const live = await liveDuty(tx, change.dutyId, change.baseVersion);
  return { row, change, live };
}
function catalogSnapshot(
  source: SavedDuty,
  catalog: typeof dutyTypes.$inferSelect
): SavedDuty {
  const unused = [...source.slots];
  const slots: DutySlot[] = (
    catalog.data.roles as {
      name: string;
      count: number;
      requirements?: Requirements;
    }[]
  ).flatMap((role) =>
    Array.from({ length: role.count }, () => {
      const index = unused.findIndex((slot) => slot.role === role.name);
      const previous = index < 0 ? undefined : unused.splice(index, 1)[0];
      return {
        id: previous?.id ?? randomUUID(),
        role: role.name,
        requirements: role.requirements,
      };
    })
  );
  return {
    ...source,
    slots,
    pricing: catalog.data.pricing as Pricing,
    requirements: catalog.data.requirements as Requirements,
    restBeforeMinutes: Number(catalog.data.restBeforeMinutes),
    restAfterMinutes: Number(catalog.data.restAfterMinutes),
  };
}
export async function createDutyChange(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({
      dutyId: id,
      reason: text,
      applyCatalog: z.boolean().default(false),
    })
    .parse(payload);
  const live = await liveDuty(tx, input.dutyId, expectedVersion ?? -1);
  let proposed: SavedDuty = {
    ...live.data,
    version: live.version + 1,
    rulesVersion: (live.data.rulesVersion ?? live.version) + 1,
  };
  let catalogVersion: number | undefined;
  if (input.applyCatalog) {
    const [catalog] = await tx
      .select()
      .from(dutyTypes)
      .where(eq(dutyTypes.id, live.typeId));
    invariant(catalog, "not_found", "סוג התורנות לא נמצא", 404);
    proposed = catalogSnapshot(proposed, catalog);
    catalogVersion = catalog.version;
  }
  const current = await tx
    .select()
    .from(assignments)
    .where(
      and(eq(assignments.dutyId, live.id), eq(assignments.status, "reserved"))
    );
  const seats: Seat[] = proposed.slots.map((slot) => {
    const assigned = current.find((row) => row.slotId === slot.id);
    return {
      slotId: slot.id,
      soldierId: assigned?.soldierId ?? null,
      extraPoints: assigned?.data.extraPoints ?? "0",
    };
  });
  const row = await createRecord(tx, "duty_change", {
    dutyId: live.id,
    baseVersion: live.version,
    status: "open",
    reason: input.reason,
    proposed,
    seats,
    catalogVersion,
    createdBy: actor.id,
  });
  await audit(tx, actor, "duty.change.create", row.id, { dutyId: live.id });
  return { id: row.id, version: row.version };
}
export async function saveDutyChange(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({
      id,
      name: text,
      start: text,
      end: text,
      startOffset: z.number().optional(),
      endOffset: z.number().optional(),
      location: z.string().max(500),
      instructions: z.string().max(4000),
      reason: text,
      seats: z.array(seatInput),
    })
    .parse(payload);
  const { row, change } = await openChange(tx, input.id, expectedVersion);
  const start = parseMoment(input.start, input.startOffset);
  const end = parseMoment(input.end, input.endOffset);
  interval({ start, end });
  invariant(
    instant(start).toMillis() > Date.now(),
    "past_duty",
    "מועד ההתחלה החדש חייב להיות בעתיד"
  );
  invariant(
    input.seats.length === change.proposed.slots.length &&
      new Set(input.seats.map((seat) => seat.slotId)).size ===
        input.seats.length &&
      input.seats.every((seat) =>
        change.proposed.slots.some((slot) => slot.id === seat.slotId)
      ),
    "invalid_seats",
    "יש לבחור במפורש את המצב הרצוי לכל מקום"
  );
  const selected = input.seats.flatMap((seat) =>
    seat.soldierId ? [seat.soldierId] : []
  );
  invariant(
    new Set(selected).size === selected.length,
    "duplicate_soldier",
    "חייל אינו יכול לתפוס שני מקומות באותו מופע"
  );
  const proposed = {
    ...change.proposed,
    name: input.name,
    start,
    end,
    location: input.location,
    instructions: input.instructions,
  };
  const updated = await updateRecord(tx, row, {
    ...row.data,
    proposed,
    seats: input.seats,
    reason: input.reason,
  });
  await audit(tx, actor, "duty.change.save", row.id, {
    dutyId: change.dutyId,
    version: updated.version,
  });
  return { id: updated.id, version: updated.version };
}
const previewInput = z.object({
  id,
  reviewPending: z.boolean().default(false),
});
async function inspectChange(
  tx: DbTransaction,
  changeId: string,
  version: number | undefined,
  reviewPending: boolean
) {
  const { row, change, live } = await openChange(tx, changeId, version);
  invariant(
    instant(change.proposed.start).toMillis() > Date.now(),
    "past_duty",
    "מועד ההתחלה החדש כבר חלף"
  );
  const state = await loadDomain(tx);
  const original = state.assignments.filter(
    (item) => item.dutyId === live.id && item.status !== "cancelled"
  );
  invariant(
    original.every((item) => item.status === "reserved"),
    "performance_started",
    "נדרש טיפול בביצוע לפני שינוי זה"
  );
  const simulated: Assignment[] = change.seats
    .filter((seat): seat is Seat & { soldierId: string } =>
      Boolean(seat.soldierId)
    )
    .map((seat) => ({
      id: `proposed:${seat.slotId}`,
      dutyId: live.id,
      slotId: seat.slotId,
      soldierId: seat.soldierId,
      points: calculatePrice(
        change.proposed.pricing,
        change.proposed.start,
        change.proposed.end,
        seat.extraPoints
      ).points,
      status: "reserved",
      version: 1,
      extraPoints: seat.extraPoints,
    }));
  const context = {
    duties: state.duties.map((duty) =>
      duty.id === live.id ? change.proposed : duty
    ),
    assignments: [
      ...state.assignments.filter((item) => item.dutyId !== live.id),
      ...simulated,
    ],
    mode: "manual" as const,
    pendingReviewConfirmed: reviewPending,
  };
  const checks = simulated.map((assignment) => {
    const person = state.soldiers.find(
      (person) => person.id === assignment.soldierId
    );
    const slot = change.proposed.slots.find(
      (slot) => slot.id === assignment.slotId
    )!;
    invariant(person, "missing_soldier", "חייל בהצעת השינוי אינו קיים");
    const result = evaluateEligibility(person, change.proposed, slot, {
      ...context,
      ignoreAssignmentIds: [assignment.id],
    });
    return {
      slotId: slot.id,
      soldierId: person.id,
      points: assignment.points,
      price: calculatePrice(
        change.proposed.pricing,
        change.proposed.start,
        change.proposed.end,
        assignment.extraPoints
      ),
      status: result.status,
      blockers: result.blockers,
      requirements: result.approvalsRequired.map((reason) => ({
        ...reason,
        key: `${slot.id}:${reason.code}:${reason.referenceId ?? ""}:${reason.referenceVersion ?? ""}`,
      })),
    };
  });
  const pendingReviewRequired =
    state.soldiers.some((person) =>
      person.constraints.some((item) => item.status === "pending")
    ) && !reviewPending;
  const previewToken = createHash("sha256")
    .update(
      JSON.stringify({
        state,
        change: row.data,
        version: row.version,
        reviewPending,
      })
    )
    .digest("hex");
  const affectedIds = [
    ...new Set([
      ...original.map((item) => item.soldierId),
      ...simulated.map((item) => item.soldierId),
    ]),
  ];
  const affected = affectedIds.map((soldierId) => ({
    soldierId,
    before: original
      .filter((item) => item.soldierId === soldierId)
      .map((item) => ({ slotId: item.slotId, points: item.points })),
    after: simulated
      .filter((item) => item.soldierId === soldierId)
      .map((item) => ({ slotId: item.slotId, points: item.points })),
  }));
  return {
    row,
    change,
    live,
    state,
    original,
    simulated,
    checks,
    pendingReviewRequired,
    previewToken,
    affected,
  };
}
export async function previewDutyChange(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = previewInput.parse(payload);
  const checked = await inspectChange(
    tx,
    input.id,
    expectedVersion,
    input.reviewPending
  );
  return {
    before: checked.live.data,
    after: checked.change.proposed,
    checks: checked.checks,
    affected: checked.affected,
    pendingReviewRequired: checked.pendingReviewRequired,
    previewToken: checked.previewToken,
  };
}
async function applyDutyChange(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion: number | undefined,
  mode: "draft" | "published"
) {
  manager(actor);
  const input = previewInput
    .extend({
      previewToken: text,
      confirmed: z.literal(true),
      approvalKeys: z.array(z.string()).default([]),
    })
    .parse(payload);
  const checked = await inspectChange(
    tx,
    input.id,
    expectedVersion,
    input.reviewPending
  );
  const { row, change, live, state, original, simulated, checks, affected } =
    checked;
  invariant(
    live.data.status === mode,
    "wrong_change_mode",
    mode === "draft"
      ? "שמירת שינוי בטיוטה אינה מיועדת לתורנות שפורסמה"
      : "עדכן ופרסם אינו מפרסם טיוטה. יש לשמור אותה ולפרסם במפורש"
  );
  invariant(
    input.previewToken === checked.previewToken,
    "stale_preview",
    "הנתונים השתנו. יש לבדוק שוב את השפעת השינוי",
    409
  );
  invariant(
    !checked.pendingReviewRequired,
    "pending_review_required",
    "נדרש אישור המשך לפני השלמת סקירת האילוצים"
  );
  invariant(
    checks.every((check) => check.status !== "blocked"),
    "blocked_change",
    "יש שיבוצים חסומים. יש לטפל בהם במפורש לפני השלמת השינוי",
    422,
    checks
  );
  invariant(
    checks.every((check) =>
      check.requirements.every(
        (reason) =>
          reason.code !== "pending_review" &&
          input.approvalKeys.includes(reason.key)
      )
    ),
    "approval_required",
    "נדרש אישור נפרד לכל חריג בהצעה החדשה"
  );
  const revision = await createRecord(tx, "duty_revision", {
    dutyId: live.id,
    duty: live.data,
    assignmentIds: original.map((item) => item.id),
    replacedBy: row.id,
    actorId: actor.id,
  });
  await releaseReservations(tx, original);
  for (const slot of change.proposed.slots)
    await tx
      .insert(dutySlots)
      .values({ id: slot.id, dutyId: live.id, data: { ...slot } })
      .onConflictDoUpdate({ target: dutySlots.id, set: { data: { ...slot } } });
  for (const item of simulated) {
    const person = state.soldiers.find(
      (person) => person.id === item.soldierId
    )!;
    const approvals: SpecificApproval[] = checks
      .find((check) => check.slotId === item.slotId)!
      .requirements.map((reason) => ({
        kind: reason.code as SpecificApproval["kind"],
        soldierId: person.id,
        soldierVersion: person.version,
        dutyId: live.id,
        dutyVersion: change.proposed.rulesVersion!,
        referenceId: reason.referenceId,
        referenceVersion: reason.referenceVersion,
        reason: change.reason,
        approvedBy: actor.id,
        approvedAt: new Date().toISOString(),
      }));
    const assignment: Assignment = {
      ...item,
      id: randomUUID(),
      approvals,
      pendingReviewConfirmed: input.reviewPending,
    };
    await tx.insert(assignments).values({ ...assignment, data: assignment });
    if (approvals.length)
      await createRecord(
        tx,
        "assignment_approval",
        { assignmentId: assignment.id, approvals },
        person.id
      );
  }
  await tx
    .update(duties)
    .set({
      name: change.proposed.name,
      data: change.proposed,
      version: live.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(duties.id, live.id));
  const href = `/duties/${live.id}`;
  if (mode === "published") {
    await cancelDutyEmails(tx, href);
    await closeTransfersForDuty(tx, live.id, "התורנות עודכנה אחרי ההצעה");
  }
  for (const item of mode === "published" ? affected : []) {
    const [account] = await tx
      .select()
      .from(user)
      .where(eq(user.soldierId, item.soldierId));
    if (!account || account.deletedAt) continue;
    const title = "עודכנה תורנות שפורסמה";
    const body = item.after.length
      ? `עודכן השיבוץ לתורנות ${change.proposed.name}. יש לבדוק את הפרטים החדשים.`
      : `השיבוץ שלך לתורנות ${live.name} הוסר במסגרת עדכון שפורסם.`;
    await createRecord(
      tx,
      "notification",
      {
        accountId: account.id,
        title,
        body,
        href,
        dutyId: live.id,
        dutyVersion: live.version + 1,
      },
      item.soldierId
    );
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey: `update:${live.id}:${live.version + 1}:${account.id}`,
      kind: "publication-change",
      title,
      body,
      href,
      priority: 1,
      expiresAt: new Date(
        Math.min(
          Date.now() + 86400_000,
          instant(change.proposed.end).toMillis()
        )
      ),
    });
  }
  const closed = await updateRecord(tx, row, {
    ...row.data,
    status: mode === "published" ? "published" : "applied",
    appliedBy: actor.id,
    appliedAt: new Date().toISOString(),
  });
  await audit(
    tx,
    actor,
    mode === "published" ? "duty.update.publish" : "duty.update.draft",
    live.id,
    {
      changeId: row.id,
      version: live.version + 1,
      previousVersion: live.version,
      recordId: revision.id,
    }
  );
  return { id: closed.id, version: closed.version, dutyId: live.id };
}
export function publishDutyChange(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  return applyDutyChange(tx, actor, payload, expectedVersion, "published");
}
export function applyDraftDutyChange(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  return applyDutyChange(tx, actor, payload, expectedVersion, "draft");
}
async function releaseReservations(tx: DbTransaction, original: Assignment[]) {
  for (const item of original)
    await tx
      .update(assignments)
      .set({
        status: "cancelled",
        version: item.version + 1,
        data: { ...item, status: "cancelled", version: item.version + 1 },
        updatedAt: new Date(),
      })
      .where(eq(assignments.id, item.id));
}
async function cancelDutyEmails(tx: DbTransaction, href: string) {
  await tx
    .update(emailOutbox)
    .set({ status: "cancelled", leaseUntil: null, updatedAt: new Date() })
    .where(
      and(
        eq(emailOutbox.href, href),
        inArray(emailOutbox.status, ["pending", "sending"])
      )
    );
}
export async function cancelDuty(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z
    .object({ id, reason: text, confirmed: z.literal(true) })
    .parse(payload);
  const [live] = await tx.select().from(duties).where(eq(duties.id, input.id));
  invariant(live, "not_found", "תורנות לא נמצאה", 404);
  currentVersion(live.version, expectedVersion);
  invariant(
    live.data.status !== "cancelled",
    "already_cancelled",
    "התורנות כבר בוטלה",
    409
  );
  invariant(
    live.data.status === "draft" ||
      instant(live.data.start).toMillis() > Date.now(),
    "performance_started",
    "ביטול תורנות שפורסמה והתחילה מחייב טיפול בביצוע"
  );
  const state = await loadDomain(tx);
  const original = state.assignments.filter(
    (item) => item.dutyId === live.id && item.status !== "cancelled"
  );
  invariant(
    original.every((item) => item.status === "reserved"),
    "performance_started",
    "נדרש טיפול בביצוע לפני ביטול זה"
  );
  const version = live.version + 1;
  const revision = await createRecord(tx, "duty_revision", {
    dutyId: live.id,
    duty: live.data,
    assignmentIds: original.map((item) => item.id),
    cancelledBy: actor.id,
    reason: input.reason,
  });
  await releaseReservations(tx, original);
  await tx
    .update(duties)
    .set({
      version,
      data: {
        ...live.data,
        status: "cancelled",
        wasPublished: live.data.status === "published",
        version,
        rulesVersion: (live.data.rulesVersion ?? live.version) + 1,
      },
      updatedAt: new Date(),
    })
    .where(eq(duties.id, live.id));
  const proposals = await tx
    .select()
    .from(records)
    .where(eq(records.kind, "duty_change"));
  for (const proposal of proposals.filter(
    (item) => item.data.dutyId === live.id && item.data.status === "open"
  ))
    await updateRecord(tx, proposal, {
      ...proposal.data,
      status: "cancelled",
      cancelledBy: actor.id,
    });
  const href = `/duties/${live.id}`;
  await cancelDutyEmails(tx, href);
  await closeTransfersForDuty(tx, live.id, "התורנות בוטלה");
  if (live.data.status === "published") {
    for (const soldierId of new Set(original.map((item) => item.soldierId))) {
      const [account] = await tx
        .select()
        .from(user)
        .where(eq(user.soldierId, soldierId));
      if (!account || account.deletedAt) continue;
      const title = "התורנות בוטלה";
      const body = `התורנות ${live.name} בוטלה. השיבוץ שלך לתורנות זו אינו בתוקף.`;
      await createRecord(
        tx,
        "notification",
        {
          accountId: account.id,
          title,
          body,
          href,
          dutyId: live.id,
          dutyVersion: version,
        },
        soldierId
      );
      await enqueueEmail(tx, {
        recipientAccountId: account.id,
        eventKey: `cancel:${live.id}:${version}:${account.id}`,
        kind: "publication-change",
        title,
        body,
        href,
        priority: 1,
        expiresAt: new Date(Date.now() + 86400_000),
      });
    }
  }
  await audit(tx, actor, "duty.cancel", live.id, {
    version,
    previousVersion: live.version,
    recordId: revision.id,
  });
  return { id: live.id, version };
}
export async function discardDutyChange(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z.object({ id }).parse(payload);
  const row = await findRecord(tx, "duty_change", input.id);
  currentVersion(row.version, expectedVersion);
  invariant(
    row.data.status === "open",
    "closed_change",
    "הצעת השינוי כבר נסגרה",
    409
  );
  const discarded = await updateRecord(tx, row, {
    ...row.data,
    status: "discarded",
    discardedBy: actor.id,
  });
  await audit(tx, actor, "duty.change.discard", row.id, {
    dutyId: row.data.dutyId,
  });
  return discarded;
}
export async function previewCatalogImpact(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z.object({ id }).parse(payload);
  const [catalog] = await tx
    .select()
    .from(dutyTypes)
    .where(eq(dutyTypes.id, input.id));
  invariant(catalog, "not_found", "סוג תורנות לא נמצא", 404);
  currentVersion(catalog.version, expectedVersion);
  const state = await loadDomain(tx);
  const impacted = state.duties
    .filter(
      (duty) =>
        duty.typeId === catalog.id &&
        duty.status !== "cancelled" &&
        instant(duty.start).toMillis() > Date.now()
    )
    .map((duty) => {
      const proposed = catalogSnapshot(
        { ...duty, rulesVersion: (duty.rulesVersion ?? duty.version) + 1 },
        catalog
      );
      const checks = state.assignments
        .filter(
          (item) => item.dutyId === duty.id && item.status !== "cancelled"
        )
        .map((item) => {
          const slot = proposed.slots.find((slot) => slot.id === item.slotId);
          const person = state.soldiers.find(
            (person) => person.id === item.soldierId
          )!;
          const result = slot
            ? evaluateEligibility(person, proposed, slot, {
                duties: state.duties.map((row) =>
                  row.id === duty.id ? proposed : row
                ),
                assignments: state.assignments,
                mode: "manual",
                ignoreAssignmentIds: [item.id],
                pendingReviewConfirmed: true,
              })
            : null;
          return {
            soldierId: item.soldierId,
            slotId: item.slotId,
            removed: !slot,
            beforePoints: item.points,
            afterPoints: slot
              ? calculatePrice(
                  proposed.pricing,
                  proposed.start,
                  proposed.end,
                  item.extraPoints
                ).points
              : 0,
            status: result?.status ?? "removed",
            reasons: result
              ? [...result.blockers, ...result.approvalsRequired]
              : [],
          };
        });
      return {
        id: duty.id,
        name: duty.name,
        status: duty.status,
        start: duty.start,
        beforeSlots: duty.slots.length,
        afterSlots: proposed.slots.length,
        checks,
      };
    });
  return { catalogVersion: catalog.version, duties: impacted };
}
