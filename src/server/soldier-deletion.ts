import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import {
  assignments,
  commandResults,
  duties,
  records,
  soldierContacts,
  soldiers,
} from "./schema";
import { user } from "./auth-schema";
import { deleteAccountAuth } from "./auth/accounts";
import {
  audit,
  createRecord,
  currentVersion,
  manager,
  updateRecord,
  type Actor,
} from "./repository";
import { invariant } from "./errors";
import { id, text } from "./validation";
import { reassessAssignments } from "./personnel";
import { enqueueEmail } from "./operations/email";
import { queueDeletionLog } from "./operations/deletion-log";
import { refreshRankReminders } from "./ranks";
import { closeRequestsOfTransferredSeat } from "./cancellation-requests";
import {
  closeSeatRequests,
  notifySoldier,
  openSeatRequests,
} from "./seat-requests";
import {
  hasConditions,
  needlesOf,
  notificationIsFor,
  recordPolicies,
  scrubApprovals,
  scrubAssignmentApproval,
  scrubConstraint,
  scrubImportRow,
  scrubLotteryAttempt,
  scrubLotteryExclusion,
  scrubNotification,
  scrubRequest,
  withoutConditions,
  type Scrubbed,
} from "../domain/erasure";
import type { Assignment, Duty } from "../domain/types";

// Deleting a soldier (decision 192, ticket #33): access and mail end at once,
// future seats become vacant with an urgent notice to the managers, and the
// sensitive data leaves every active copy. Name, personal number and the
// history of duties and score stay. Locking, restore and idle states are not
// deletion.
const ACTIVE = ["reserved", "held"];
const ERASED_CLOSE = "החייל נמחק מהמערכת";

type DutyRow = typeof duties.$inferSelect;
type AssignmentRow = typeof assignments.$inferSelect;
type RecordRow = typeof records.$inferSelect;

function seatView(row: AssignmentRow, duty: DutyRow | undefined) {
  return {
    assignmentId: row.id,
    version: row.version,
    status: row.status,
    dutyId: row.dutyId,
    dutyName: duty?.name ?? "תורנות",
    dutyStatus: duty?.data.status,
    start: duty?.data.start,
    end: duty?.data.end,
    role:
      duty?.data.slots.find((slot) => slot.id === row.slotId)?.role ?? "תורן",
  };
}

/** Every request that names the soldier as owner, subject or candidate. */
async function requestsOf(tx: DbTransaction, soldierId: string) {
  return tx
    .select()
    .from(records)
    .where(
      and(
        eq(records.kind, "request"),
        sql`(${records.subjectId} = ${soldierId} or position(${soldierId} in ${records.data}::text) > 0)`
      )
    );
}

/**
 * What deleting the soldier would do now, with a token that binds a save to it.
 * `force` applies a deletion the live system already made (decision 196): the
 * account's role then no longer decides.
 */
async function assess(
  tx: DbTransaction,
  soldierId: string,
  options: { force?: boolean } = {}
) {
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, soldierId))
    .for("update");
  invariant(person, "not_found", "חייל לא נמצא", 404);
  invariant(!person.deletedAt, "already_deleted", "החייל כבר נמחק", 409);
  const [login] = await tx
    .select()
    .from(user)
    .where(eq(user.soldierId, soldierId))
    .for("update");
  invariant(
    options.force || !login || login.role === "soldier",
    "manager_account",
    "אי אפשר למחוק חשבון אחראי או טכני במסלול הזה. המנהל הטכני מסיר קודם את הרשאת האחראי",
    403
  );
  const seats = (
    await tx
      .select()
      .from(assignments)
      .where(eq(assignments.soldierId, soldierId))
  ).filter((row) => ACTIVE.includes(row.status));
  const dutyRows = seats.length
    ? await tx
        .select()
        .from(duties)
        .where(
          inArray(
            duties.id,
            seats.map((row) => row.dutyId)
          )
        )
    : [];
  const dutyById = new Map(dutyRows.map((row) => [row.id, row]));
  const now = Date.now();
  // A seat of a duty that has not started is vacated. A seat of a duty that
  // started, or of one split into execution periods, is left for the urgent
  // handling of execution (ticket #34); it is flagged, never released here.
  const vacated: AssignmentRow[] = [];
  const running: AssignmentRow[] = [];
  for (const row of seats) {
    const duty = dutyById.get(row.dutyId);
    if (
      duty &&
      duty.data.status !== "cancelled" &&
      !row.data.performedStart &&
      new Date(duty.data.start).getTime() > now
    )
      vacated.push(row);
    else running.push(row);
  }
  const requests = await requestsOf(tx, soldierId);
  const open = (await openSeatRequests(tx)).filter(
    (row) =>
      row.data.fromSoldierId === soldierId ||
      row.data.acceptedBy === soldierId ||
      (Array.isArray(row.data.candidates) &&
        row.data.candidates.some(
          (entry: { soldierId?: string }) => entry.soldierId === soldierId
        ))
  );
  const pendingCancellations = requests.filter(
    (row) => row.data.type === "cancellation" && row.data.status === "pending"
  );
  const impact = {
    soldier: {
      id: person.id,
      name: person.name,
      personalNumber: person.personalNumber,
      version: person.version,
    },
    hasAccount: Boolean(login),
    vacated: vacated.map((row) => seatView(row, dutyById.get(row.dutyId))),
    inProgress: running.map((row) => seatView(row, dutyById.get(row.dutyId))),
    openRequests: new Set([
      ...open.map((row) => row.id),
      ...pendingCancellations.map((row) => row.id),
    ]).size,
    removes: {
      contact: true,
      conditions: hasConditions(person.data),
      requests: requests.length,
    },
  };
  const previewToken = createHash("sha256")
    .update(
      JSON.stringify({
        version: person.version,
        login: login ? [login.id, login.securityEpoch] : null,
        seats: [...vacated, ...running]
          .map((row) => [row.id, row.version, row.status])
          .sort(),
        // A duty that starts after the review moves its seat from vacated to flagged.
        vacated: vacated.map((row) => row.id).sort(),
        requests: requests.map((row) => [row.id, row.version]).sort(),
        open: open.map((row) => [row.id, row.version]).sort(),
      })
    )
    .digest("hex");
  return { impact, previewToken, person, login, vacated, running, requests };
}

/**
 * What a restore row's deletion would do, for the restore preview. A soldier
 * whose account became a manager account is not deletable here.
 */
export async function deletionSummary(tx: DbTransaction, soldierId: string) {
  const [login] = await tx
    .select()
    .from(user)
    .where(eq(user.soldierId, soldierId));
  if (login && login.role !== "soldier") return { deletable: false as const };
  const { impact } = await assess(tx, soldierId);
  return {
    deletable: true as const,
    vacated: impact.vacated.length,
    inProgress: impact.inProgress.length,
    openRequests: impact.openRequests,
  };
}

/** The deletion screen's impact view; nothing is saved. */
export async function previewSoldierDeletion(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = z.object({ id }).parse(payload);
  invariant(
    input.id !== actor.soldierId,
    "self_delete",
    "אי אפשר למחוק את החשבון שלך",
    403
  );
  const { impact, previewToken, person } = await assess(tx, input.id);
  currentVersion(person.version, expectedVersion);
  return { ...impact, previewToken };
}

async function rewrite(tx: DbTransaction, row: RecordRow, data: Scrubbed) {
  if (!data) return false;
  await tx
    .update(records)
    .set({ data, version: row.version + 1, updatedAt: new Date() })
    .where(eq(records.id, row.id));
  return true;
}

/** Closes what rests on the soldier's vacated seats and on their candidacy. */
async function closeOpenRequests(
  tx: DbTransaction,
  soldierId: string,
  vacated: AssignmentRow[]
) {
  await closeSeatRequests(
    tx,
    { assignmentIds: vacated.map((row) => row.id) },
    ERASED_CLOSE
  );
  for (const seat of vacated)
    await closeRequestsOfTransferredSeat(
      tx,
      seat.dutyId,
      soldierId,
      "הבקשה נסגרה כי החייל נמחק מהמערכת"
    );
  const now = new Date().toISOString();
  for (const row of await openSeatRequests(tx)) {
    const data = row.data;
    const entries = (data.candidates ?? []) as {
      soldierId: string;
      status: string;
    }[];
    // An offer of the deleted soldier's own seat, whether or not the duty started.
    if (data.fromSoldierId === soldierId) {
      await updateRecord(tx, row, {
        ...data,
        status: "expired",
        candidates: entries.map((item) =>
          item.status === "pending" ? { ...item, status: "closed" } : item
        ),
        closedAt: now,
        closedReason: ERASED_CLOSE,
      });
      continue;
    }
    if (data.type !== "transfer") continue;
    const waitingOnHim =
      data.status === "awaiting_manager" && data.acceptedBy === soldierId;
    if (!waitingOnHim && !entries.some((item) => item.soldierId === soldierId))
      continue;
    const candidates = entries.map((item) =>
      item.soldierId === soldierId && item.status === "pending"
        ? { ...item, status: "closed" }
        : item
    );
    const exhausted = !candidates.some((item) => item.status === "pending");
    await updateRecord(tx, row, {
      ...data,
      candidates,
      ...((waitingOnHim || exhausted) && {
        status: "expired",
        closedAt: now,
        closedReason: ERASED_CLOSE,
      }),
    });
    if (waitingOnHim || exhausted)
      await notifySoldier(tx, String(data.fromSoldierId), {
        event: "closed",
        requestId: row.id,
        title: "הצעת ההעברה נסגרה",
        body: `הצעת ההעברה של ${String(data.dutyName)} נסגרה כי המועמד אינו זמין עוד. השיבוץ שלך נשאר בתוקף.`,
        email: false,
        expiresAt: 0,
      });
  }
}

/** Frees the vacated seats and bumps each duty so open proposals on it go stale. */
async function vacateSeats(
  tx: DbTransaction,
  vacated: AssignmentRow[],
  soldierId: string
) {
  const now = new Date();
  for (const row of vacated)
    await tx
      .update(assignments)
      .set({
        status: "cancelled",
        version: row.version + 1,
        data: {
          ...row.data,
          status: "cancelled",
          version: row.version + 1,
          endedBy: { kind: "deletion", soldierId },
        } as Assignment,
        updatedAt: now,
      })
      .where(eq(assignments.id, row.id));
  for (const dutyId of new Set(vacated.map((row) => row.dutyId))) {
    const [duty] = await tx.select().from(duties).where(eq(duties.id, dutyId));
    await tx
      .update(duties)
      .set({
        version: duty.version + 1,
        data: {
          ...duty.data,
          rulesVersion: duty.data.rulesVersion ?? duty.version,
          version: duty.version + 1,
        } as Duty & { name: string; location: string; instructions: string },
        updatedAt: now,
      })
      .where(eq(duties.id, dutyId));
  }
}

/**
 * The reasons of the soldier's exception approvals also sit inside their own
 * assignments, past and present. The approval stays; its reason is replaced.
 */
async function eraseSeatApprovals(tx: DbTransaction, soldierId: string) {
  let changed = 0;
  for (const row of await tx
    .select()
    .from(assignments)
    .where(eq(assignments.soldierId, soldierId))) {
    const approvals = scrubApprovals(row.data.approvals, soldierId);
    if (!approvals) continue;
    await tx
      .update(assignments)
      .set({ data: { ...row.data, approvals } as Assignment })
      .where(eq(assignments.id, row.id));
    changed++;
  }
  return changed;
}

/**
 * A returned manager's open decision about the balance (decision 192) has no
 * one left to decide for; it closes with the deletion.
 */
async function closeManagerReturns(
  tx: DbTransaction,
  actor: Actor,
  soldierId: string,
  at: string
) {
  for (const row of await tx
    .select()
    .from(records)
    .where(
      and(eq(records.kind, "manager_return"), eq(records.subjectId, soldierId))
    ))
    if (row.data.status === "pending")
      await updateRecord(tx, row, {
        ...row.data,
        status: "closed",
        outcome: "deleted",
        closedAt: at,
        closedBy: actor.id,
        closedByName: actor.name,
      });
}

/** Removes the sensitive data from the soldier's records and from the notices that quote it. */
async function eraseRecords(
  tx: DbTransaction,
  soldierId: string,
  accountId: string | undefined,
  requests: RecordRow[],
  at: string
) {
  const mention = (value: string) =>
    sql`position(${value} in ${records.data}::text) > 0`;
  const touching = or(
    eq(records.subjectId, soldierId),
    mention(soldierId),
    accountId ? mention(accountId) : undefined
  );
  const kinds = Object.entries(recordPolicies)
    .filter(([, policy]) => policy.action !== "keep")
    .map(([kind]) => kind);
  const rows = await tx
    .select()
    .from(records)
    .where(and(inArray(records.kind, kinds), touching));
  const requestIds = new Set(requests.map((row) => row.id));
  const reminderIds = new Set(
    rows.filter((row) => row.kind === "rank_reminder").map((row) => row.id)
  );
  // Notices that point at a request or a reminder of the soldier, whoever got
  // them, are found by that link: they need not name the soldier at all.
  const links = [
    ...(requestIds.size
      ? [inArray(sql<string>`${records.data}->>'requestId'`, [...requestIds])]
      : []),
    ...(reminderIds.size
      ? [inArray(sql<string>`${records.data}->>'reminderId'`, [...reminderIds])]
      : []),
  ];
  const known = new Set(rows.map((row) => row.id));
  const linked = links.length
    ? (
        await tx
          .select()
          .from(records)
          .where(and(eq(records.kind, "notification"), or(...links)))
      ).filter((row) => !known.has(row.id))
    : [];
  const gone: string[] = [];
  let changed = 0;
  for (const row of [...rows, ...linked]) {
    const own = row.subjectId === soldierId;
    switch (row.kind) {
      case "audit_detail":
      case "email_change":
      case "import_restore_profile_revision":
      case "personnel_change":
      case "rank_reminder":
        if (own) gone.push(row.id);
        break;
      case "settings":
        if (own || (accountId && row.data.accountId === accountId))
          gone.push(row.id);
        break;
      case "notification":
        if (
          notificationIsFor(row.data, row.subjectId, soldierId, accountId) ||
          reminderIds.has(String(row.data.reminderId))
        )
          gone.push(row.id);
        else if (
          await rewrite(tx, row, scrubNotification(row.data, requestIds, at))
        )
          changed++;
        break;
      case "assignment_approval":
        if (own && (await rewrite(tx, row, scrubAssignmentApproval(row.data))))
          changed++;
        break;
      case "constraint":
      case "constraint_revision":
        if (own && (await rewrite(tx, row, scrubConstraint(row.data, at))))
          changed++;
        break;
      case "import_row":
        if (own && (await rewrite(tx, row, scrubImportRow(row.data))))
          changed++;
        break;
      case "lottery_attempt":
        if (await rewrite(tx, row, scrubLotteryAttempt(row.data, soldierId)))
          changed++;
        break;
      case "lottery_exclusion":
        if (own && (await rewrite(tx, row, scrubLotteryExclusion(row.data))))
          changed++;
        break;
      case "request":
        if (await rewrite(tx, row, scrubRequest(row.data, soldierId, own, at)))
          changed++;
        break;
      default:
        invariant(
          false,
          "unclassified_record",
          `סוג רשומה ללא מדיניות מחיקה: ${row.kind}`
        );
    }
  }
  if (gone.length) await tx.delete(records).where(inArray(records.id, gone));
  return { removed: gone.length, scrubbed: changed };
}

/**
 * The stored result of an earlier command may still hold the soldier's data (an
 * import preview lists contact details, a timeline preview lists exemptions).
 * Such results keep their key, so a repeated request is still recognized, but
 * return only an erasure marker.
 */
async function eraseCommandResults(
  tx: DbTransaction,
  needles: string[],
  at: string
) {
  const hits = needles.map(
    (needle) => sql`position(${needle} in ${commandResults.result}::text) > 0`
  );
  await tx
    .update(commandResults)
    .set({ result: { erasedAt: at } })
    .where(or(...hits));
}

/**
 * Deletes the soldier as one transaction. `confirm` is the token of the impact
 * the manager reviewed; a restore that deletes a row passes none, because the
 * restore preview already binds its save to the impact it showed.
 */
export async function eraseSoldier(
  tx: DbTransaction,
  actor: Actor,
  soldierId: string,
  options: {
    reason: string;
    previewToken?: string;
    via?: string;
    /**
     * A deletion the live system made before a restore (decision 196): it is
     * applied again at its original time, by the restore and not by a manager,
     * and it is not logged a second time.
     */
    restored?: { at: string };
  }
) {
  if (!options.restored) {
    manager(actor);
    invariant(
      soldierId !== actor.soldierId,
      "self_delete",
      "אי אפשר למחוק את החשבון שלך",
      403
    );
  }
  const { impact, previewToken, person, login, vacated, requests } =
    await assess(tx, soldierId, { force: Boolean(options.restored) });
  invariant(
    options.previewToken === undefined || options.previewToken === previewToken,
    "stale_preview",
    "השיבוצים, הבקשות או נתוני החייל השתנו. יש לבדוק שוב את השפעת המחיקה",
    409
  );
  const [contact] = await tx
    .select()
    .from(soldierContacts)
    .where(eq(soldierContacts.soldierId, soldierId));
  const needles = needlesOf(soldierId, contact);
  const now = new Date();
  const at = now.toISOString();
  const deletedAt = options.restored ? new Date(options.restored.at) : now;

  await vacateSeats(tx, vacated, soldierId);
  await closeOpenRequests(tx, soldierId, vacated);
  await closeManagerReturns(tx, actor, soldierId, at);

  const data = withoutConditions(person.data);
  data.version = person.version + 1;
  await tx
    .update(soldiers)
    .set({ data, version: data.version, deletedAt, updatedAt: now })
    .where(eq(soldiers.id, soldierId));
  // The independent log learns of the deletion in the same commit (decision 196).
  if (!options.restored) await queueDeletionLog(tx, soldierId, deletedAt);
  if (contact)
    await tx
      .update(soldierContacts)
      .set({ email: null, phone: null, address: null, fieldVersions: {} })
      .where(eq(soldierContacts.soldierId, soldierId));
  // Access, sign-in codes, recovery codes, linked providers and queued mail end here.
  if (login) await deleteAccountAuth(login.id, tx);

  const erased = await eraseRecords(tx, soldierId, login?.id, requests, at);
  erased.scrubbed += await eraseSeatApprovals(tx, soldierId);
  await eraseCommandResults(tx, needles, at);
  // Seats of a started duty stay; their eligibility now reads "deleted".
  await reassessAssignments(tx, soldierId);
  await refreshRankReminders(tx);

  await audit(
    tx,
    actor,
    "soldier.delete",
    soldierId,
    {
      reason: options.reason,
      vacated: impact.vacated.length,
      inProgress: impact.inProgress.length,
      ...(options.via && { via: options.via }),
      ...(options.restored && { via: "restore" }),
    },
    soldierId
  );
  if (impact.vacated.length || impact.inProgress.length) {
    const title = "נמחק חייל: נדרש טיפול במקומות פנויים";
    const body =
      `${person.name} נמחק${options.restored ? " (המחיקה הוחלה מחדש אחרי שחזור)" : ""}. ${impact.vacated.length} מקומות עתידיים התפנו` +
      (impact.inProgress.length
        ? `, ו־${impact.inProgress.length} שיבוצים בתורנויות שכבר התחילו נשארו ומסומנים לטיפול דחוף: יש לרשום תקופות ביצוע, מחליף ואת הניקוד.`
        : ".");
    for (const recipient of await tx
      .select()
      .from(user)
      .where(eq(user.role, "manager")))
      if (!recipient.deletedAt) {
        await createRecord(tx, "notification", {
          accountId: recipient.id,
          title,
          body,
          href: "/manage",
          deletedSoldierId: soldierId,
        });
        // Sent only if the manager's "deletion" switch is on at delivery time (decision 196).
        await enqueueEmail(tx, {
          recipientAccountId: recipient.id,
          eventKey: `deletion:${soldierId}${options.restored ? ":restored" : ""}:${recipient.id}`,
          kind: "deletion",
          title,
          body,
          href: "/manage",
          priority: 1,
          expiresAt: new Date(now.getTime() + 86_400_000),
        });
      }
  }
  return {
    id: soldierId,
    version: data.version,
    vacated: impact.vacated.length,
    inProgress: impact.inProgress.length,
    removedRecords: erased.removed,
    scrubbedRecords: erased.scrubbed,
  };
}

const deleteInput = z.object({
  id,
  previewToken: z.string().length(64),
  confirmed: z.literal(true),
  reason: text,
});
export async function deleteSoldier(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = deleteInput.parse(payload);
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, input.id));
  invariant(person, "not_found", "חייל לא נמצא", 404);
  invariant(!person.deletedAt, "already_deleted", "החייל כבר נמחק", 409);
  currentVersion(person.version, expectedVersion);
  return eraseSoldier(tx, actor, input.id, {
    reason: input.reason,
    previewToken: input.previewToken,
  });
}
