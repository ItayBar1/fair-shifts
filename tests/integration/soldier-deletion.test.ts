import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import {
  account as linkedAccount,
  emailOutbox,
  loginCode,
  recoveryCode,
  session,
  user,
} from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  commandResults,
  duties,
  ledger,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { requestCode } from "../../src/server/auth/otp";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import { settleDue } from "../../src/server/scoring";
import { eraseSoldier } from "../../src/server/soldier-deletion";
import { ERASED_NOTE, ERASED_REASON } from "../../src/domain/erasure";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// Deleting a user (ticket #33, decision 192). Synthetic people only.
const DAY = 86_400_000;
let manager: Actor;
let secondManager: Actor;
let member: Actor;
let other: Actor;
let third: Actor;

async function invite(
  name: string,
  role: "soldier" | "manager",
  personalNumber: string
): Promise<Actor> {
  const soldierId = randomUUID();
  await db.insert(soldiers).values({
    id: soldierId,
    name,
    personalNumber,
    data: soldier({ id: soldierId, name, personalNumber }),
  });
  await db.insert(soldierContacts).values({
    soldierId,
    email: `${personalNumber}@example.invalid`,
    phone: `050${personalNumber}`,
    address: `רחוב הדגמה ${personalNumber}`,
  });
  await db.insert(balances).values({ soldierId });
  const row = await createInvitedAccount({
    name,
    role,
    email: `${personalNumber}@example.invalid`,
    soldierId,
  });
  return { id: row.id, name, role, soldierId, securityEpoch: 1 };
}
async function command(
  actor: Actor,
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number,
  idempotencyKey: string = randomUUID()
) {
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey,
  })) as { id: string; version: number } & Record<string, unknown>;
}
async function soldierRow(person: Actor) {
  const [row] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, person.soldierId!));
  return row;
}
async function dutyRow(id: string) {
  const [row] = await db.select().from(duties).where(eq(duties.id, id));
  return row;
}
async function seatsOf(person: Actor) {
  return db
    .select()
    .from(assignments)
    .where(eq(assignments.soldierId, person.soldierId!));
}
/** A published duty with one seat per person. */
async function publishedDuty(
  seats: Actor[],
  startInDays = 2,
  name = "תורנות לבדיקה"
) {
  const type = await command(manager, "dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: seats.length }],
  });
  const duty = await command(manager, "duty.create", {
    typeId: type.id,
    name,
    start: new Date(Date.now() + startInDays * DAY).toISOString(),
    end: new Date(Date.now() + (startInDays + 1) * DAY).toISOString(),
  });
  const created = await dutyRow(duty.id);
  let version = 1;
  for (const [index, person] of seats.entries())
    await command(
      manager,
      "duty.assign",
      {
        dutyId: duty.id,
        slotId: created.data.slots[index].id,
        soldierId: person.soldierId,
      },
      version++
    );
  await command(
    manager,
    "duty.publish",
    { id: duty.id, confirmed: true },
    version
  );
  return dutyRow(duty.id);
}
async function moveDuty(dutyId: string, start: number, end: number) {
  const row = await dutyRow(dutyId);
  await db
    .update(duties)
    .set({
      data: {
        ...row.data,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      },
    })
    .where(eq(duties.id, dutyId));
}
async function preview(actor: Actor, person: Actor) {
  const row = await soldierRow(person);
  return (await command(
    actor,
    "soldier.delete.preview",
    { id: person.soldierId },
    row.version
  )) as unknown as {
    previewToken: string;
    vacated: { assignmentId: string }[];
    inProgress: { assignmentId: string }[];
    openRequests: number;
  };
}
async function remove(
  actor: Actor,
  person: Actor,
  reason = "שוחרר מהשירות",
  key?: string
) {
  const { previewToken } = await preview(actor, person);
  const row = await soldierRow(person);
  return command(
    actor,
    "soldier.delete",
    { id: person.soldierId, previewToken, reason, confirmed: true },
    row.version,
    key
  );
}
async function recordsOf(person: Actor, kind: string) {
  return db
    .select()
    .from(records)
    .where(
      and(eq(records.kind, kind), eq(records.subjectId, person.soldierId!))
    );
}
async function titles(person: Actor) {
  return (await readState(person)).notifications.map(
    (item) => (item as { title?: string }).title
  );
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("אחראי ראשון", "manager", "00201");
  secondManager = await invite("אחראי שני", "manager", "00202");
  member = await invite("חייל למחיקה", "soldier", "00203");
  other = await invite("חייל אחר", "soldier", "00204");
  third = await invite("חייל שלישי", "soldier", "00205");
});
afterAll(async () => pool.end());

describe("impact view", () => {
  it("lists the seats a deletion vacates and the seats it leaves, and saves nothing", async () => {
    const future = await publishedDuty([member, other], 2, "תורנות עתידית");
    const running = await publishedDuty([member], 3, "תורנות שהחלה");
    await moveDuty(running.id, Date.now() - 3_600_000, Date.now() + 3_600_000);
    const impact = await preview(manager, member);
    expect(impact.vacated).toHaveLength(1);
    expect(impact.inProgress).toHaveLength(1);
    expect(impact.previewToken).toHaveLength(64);
    expect(
      (await seatsOf(member)).filter((row) => row.status === "reserved")
    ).toHaveLength(2);
    expect((await soldierRow(member)).deletedAt).toBeNull();
    expect((await dutyRow(future.id)).version).toBe(future.version);
  });
  it("is for managers only, never for oneself and never for a manager account", async () => {
    await expect(preview(member, other)).rejects.toMatchObject({ status: 403 });
    await expect(preview(manager, manager)).rejects.toMatchObject({
      code: "self_delete",
    });
    await expect(preview(manager, secondManager)).rejects.toMatchObject({
      code: "manager_account",
    });
    await expect(
      command(manager, "soldier.delete.preview", { id: randomUUID() }, 1)
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("deleting a user", () => {
  async function loadSensitive() {
    const row = await soldierRow(member);
    await db
      .update(soldiers)
      .set({
        data: {
          ...row.data,
          gender: "female",
          capabilities: ["driver"],
          exemptions: [
            {
              exemptionId: randomUUID(),
              start: "2026-01-01",
              end: "2030-12-31",
            },
          ],
          qualifications: [
            {
              qualificationId: randomUUID(),
              start: "2026-01-01",
              end: "2030-12-31",
            },
          ],
          inactivePeriods: [{ start: "2026-03-01", end: "2026-03-05" }],
          allowedHours: [
            {
              id: randomUUID(),
              start: "2026-01-01",
              end: "2030-12-31",
              windows: [{ startTime: "08:00", endTime: "16:00" }],
            },
          ],
          rankHistory: [
            {
              effectiveFrom: "2026-01-01",
              rankId: "r",
              trackId: "t",
              order: 2,
            },
          ],
        },
      })
      .where(eq(soldiers.id, row.id));
    await db.insert(session).values({
      id: randomUUID(),
      userId: member.id,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + DAY),
      securityEpoch: 1,
    });
    await db.insert(recoveryCode).values({
      id: randomUUID(),
      userId: member.id,
      digest: randomUUID(),
    });
    await requestCode("00203@example.invalid");
  }
  it("ends access and mail at once", async () => {
    await loadSensitive();
    expect(
      await db.select().from(loginCode).where(eq(loginCode.userId, member.id))
    ).toHaveLength(1);
    await remove(manager, member);
    await expect(readState(member)).rejects.toMatchObject({ status: 401 });
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.id, member.id));
    expect(account.deletedAt).not.toBeNull();
    expect(account.email).not.toContain("00203");
    expect(account.securityEpoch).toBeGreaterThan(1);
    for (const table of [session, loginCode, recoveryCode])
      expect(
        await db.select().from(table).where(eq(table.userId, member.id))
      ).toHaveLength(0);
    const mail = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, member.id));
    expect(mail.length).toBeGreaterThan(0);
    for (const row of mail) {
      expect(row.status).toBe("cancelled");
      expect(row.body).toBe("");
      expect(row.destination).toBeNull();
      expect(row.encryptedSecret).toBeNull();
    }
    await expect(requestCode("00203@example.invalid")).resolves.toMatchObject({
      success: true,
    });
    expect(
      await db.select().from(loginCode).where(eq(loginCode.userId, member.id))
    ).toHaveLength(0);
  });
  it("removes contact details and conditions, and keeps name, number and history", async () => {
    await loadSensitive();
    await db
      .update(balances)
      .set({ current: 25 })
      .where(eq(balances.soldierId, member.soldierId!));
    await db.insert(ledger).values({
      id: randomUUID(),
      soldierId: member.soldierId!,
      sourceKey: `test:${randomUUID()}`,
      kind: "performance",
      before: 0,
      after: 25,
      amount: 25,
      actorId: "system",
      reason: "סיום תורנות קודמת",
      effectiveAt: new Date(),
    });
    await remove(manager, member);
    const row = await soldierRow(member);
    expect(row.deletedAt).not.toBeNull();
    expect(row.name).toBe("חייל למחיקה");
    expect(row.personalNumber).toBe("00203");
    expect(row.data.exemptions).toEqual([]);
    expect(row.data.qualifications).toEqual([]);
    expect(row.data.inactivePeriods).toEqual([]);
    expect(row.data.allowedHours).toEqual([]);
    expect(row.data.capabilities).toEqual([]);
    expect(row.data.gender).toBeUndefined();
    // Employment facts stay with the history.
    expect(row.data.rankHistory).toHaveLength(1);
    const [contact] = await db
      .select()
      .from(soldierContacts)
      .where(eq(soldierContacts.soldierId, member.soldierId!));
    expect([contact.email, contact.phone, contact.address]).toEqual([
      null,
      null,
      null,
    ]);
    const [balance] = await db
      .select()
      .from(balances)
      .where(eq(balances.soldierId, member.soldierId!));
    expect(balance.current).toBe(25);
    expect(
      await db
        .select()
        .from(ledger)
        .where(eq(ledger.soldierId, member.soldierId!))
    ).toHaveLength(1);
  });
  it("vacates future seats, keeps seats of a duty that started, and warns the managers", async () => {
    const future = await publishedDuty([member, other], 2, "תורנות עתידית");
    const running = await publishedDuty([member], 3, "תורנות שהחלה");
    await moveDuty(running.id, Date.now() - 3_600_000, Date.now() + 3_600_000);
    const result = await remove(manager, member);
    expect(result).toMatchObject({ vacated: 1, inProgress: 1 });
    const seats = await seatsOf(member);
    const futureSeat = seats.find((row) => row.dutyId === future.id)!;
    expect(futureSeat.status).toBe("cancelled");
    expect(futureSeat.data.status).toBe("cancelled");
    expect(
      (futureSeat.data as unknown as { endedBy: { kind: string } }).endedBy.kind
    ).toBe("deletion");
    // The other soldier keeps theirs; the duty moved to a new version.
    expect(
      (await seatsOf(other)).find((row) => row.dutyId === future.id)!.status
    ).toBe("reserved");
    expect((await dutyRow(future.id)).version).toBe(future.version + 1);
    // A started duty is not vacated: it is flagged for the urgent handling.
    const runningSeat = seats.find((row) => row.dutyId === running.id)!;
    const [kept] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, runningSeat.id));
    expect(kept.status).toBe("reserved");
    expect(kept.data.needsAttention).toContain("deleted");
    for (const person of [manager, secondManager])
      expect(await titles(person)).toContain(
        "נמחק חייל: נדרש טיפול במקומות פנויים"
      );
  });
  it("never credits a seat of a deleted soldier by itself", async () => {
    const running = await publishedDuty([member], 3, "תורנות שהסתיימה");
    await moveDuty(running.id, Date.now() - 7_200_000, Date.now() - 3_600_000);
    await remove(manager, member);
    await unitTransaction((tx) => settleDue(tx));
    const [seat] = await seatsOf(member);
    expect(seat.status).toBe("reserved");
    expect(
      await db
        .select()
        .from(ledger)
        .where(eq(ledger.soldierId, member.soldierId!))
    ).toHaveLength(0);
  });
  it("closes the offers and requests that rested on the soldier", async () => {
    // Two duties on different days, so the soldiers can take each other's seat.
    const dutyA = await publishedDuty([other], 2, "תורנות א");
    const dutyB = await publishedDuty([member], 4, "תורנות ב");
    const mine = (await seatsOf(member))[0];
    const theirs = (await seatsOf(other))[0];
    const owned = await command(
      member,
      "transfer.offer",
      { assignmentId: mine.id, candidateIds: [third.soldierId] },
      mine.version
    );
    const received = await command(
      other,
      "transfer.offer",
      {
        assignmentId: theirs.id,
        candidateIds: [member.soldierId, third.soldierId],
      },
      theirs.version
    );
    await remove(manager, member);
    const status = async (id: string) =>
      (await db.select().from(records).where(eq(records.id, id)))[0].data as {
        status: string;
        candidates: { soldierId: string; status: string }[];
      };
    // The offer of the deleted soldier's own seat is closed with the seat.
    expect((await status(owned.id)).status).toBe("expired");
    expect((await dutyRow(dutyB.id)).version).toBe(dutyB.version + 1);
    // The other offer stays open for the remaining candidate.
    const open = await status(received.id);
    expect(open.status).toBe("awaiting_consent");
    expect(
      open.candidates.find((item) => item.soldierId === member.soldierId)!
        .status
    ).toBe("closed");
    expect(
      open.candidates.find((item) => item.soldierId === third.soldierId)!.status
    ).toBe("pending");
    // The last candidate leaving closes it and tells the owner.
    await remove(manager, third);
    expect((await status(received.id)).status).toBe("expired");
    expect(await titles(other)).toContain("הצעת ההעברה נסגרה");
    expect((await dutyRow(dutyA.id)).version).toBe(dutyA.version);
  });
  it("closes a pending cancellation request of a vacated seat", async () => {
    await publishedDuty([member, other], 2);
    const seat = (await seatsOf(member))[0];
    const request = await command(
      member,
      "cancellation.submit",
      { assignmentId: seat.id, kind: "cancel", reason: "אירוע משפחתי" },
      seat.version
    );
    await remove(manager, member);
    const [row] = await db
      .select()
      .from(records)
      .where(eq(records.id, request.id));
    expect(row.data.status).toBe("closed");
    expect(row.data.reason).toBeUndefined();
    expect(row.data.erasedAt).toBeDefined();
  });
});

describe("what is deletion and what is not", () => {
  it("unlinks the provider account together with the access", async () => {
    await db.insert(linkedAccount).values({
      id: randomUUID(),
      userId: member.id,
      accountId: "google-subject-synthetic",
      providerId: "google",
    });
    await remove(manager, member);
    expect(
      await db
        .select()
        .from(linkedAccount)
        .where(eq(linkedAccount.userId, member.id))
    ).toHaveLength(0);
  });
  it("is not what locking and unlocking do", async () => {
    const row = await soldierRow(member);
    await db
      .update(soldiers)
      .set({
        data: {
          ...row.data,
          exemptions: [
            {
              exemptionId: randomUUID(),
              start: "2026-01-01",
              end: "2030-12-31",
            },
          ],
        },
      })
      .where(eq(soldiers.id, row.id));
    await db
      .update(user)
      .set({ lockedAt: new Date(), failedAttempts: 5 })
      .where(eq(user.id, member.id));
    await command(manager, "account.unlock", { id: member.id }, 1);
    const after = await soldierRow(member);
    expect(after.deletedAt).toBeNull();
    expect(after.data.exemptions).toHaveLength(1);
    const [contact] = await db
      .select()
      .from(soldierContacts)
      .where(eq(soldierContacts.soldierId, member.soldierId!));
    expect(contact.phone).toBe("05000203");
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.id, member.id));
    expect(account.deletedAt).toBeNull();
  });
  it("cannot be undone by an import that was reviewed before the deletion", async () => {
    const reviewed = await command(manager, "import.preview", {
      filename: "לפני המחיקה.xlsx",
      rows: [
        {
          rowNumber: 2,
          values: {
            personalNumber: "00203",
            name: "חייל למחיקה",
            phone: "0509998888",
          },
        },
      ],
    });
    await remove(manager, member);
    await expect(
      command(
        manager,
        "import.apply",
        {
          id: reviewed.id,
          confirmed: true,
          overwriteConfirmed: true,
          reason: "ייבוא",
        },
        reviewed.version
      )
    ).rejects.toBeDefined();
    const [contact] = await db
      .select()
      .from(soldierContacts)
      .where(eq(soldierContacts.soldierId, member.soldierId!));
    expect(contact.phone).toBeNull();
    expect((await soldierRow(member)).deletedAt).not.toBeNull();
    // A new file for the same number is refused too: the number stays with the history.
    await expect(
      command(manager, "import.preview", {
        filename: "אחרי המחיקה.xlsx",
        rows: [
          { rowNumber: 2, values: { personalNumber: "00203", name: "חייל" } },
        ],
      })
    ).rejects.toBeDefined();
  });
});

describe("every active copy of the sensitive data", () => {
  it("is removed, while the event and the history stay", async () => {
    const duty = await publishedDuty([member, other], 2);
    const seat = (await seatsOf(member))[0];
    const row = await soldierRow(member);
    // A profile edit: its contact changes live in an erasable detail record.
    await command(
      manager,
      "soldier.update",
      {
        id: member.soldierId,
        name: row.name,
        personalNumber: row.personalNumber,
        phone: "0501234567",
        address: "רחוב חדש 9",
      },
      row.version
    );
    expect((await recordsOf(member, "audit_detail")).length).toBeGreaterThan(0);
    // A constraint with a reason and a decision with a reason.
    const round = await command(manager, "round.create", {
      name: "סבב סינתטי",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 3_600_000).toISOString(),
      targetStart: "2030-11-01",
      targetEnd: "2030-11-30",
    });
    const submitted = await command(member, "constraint.submit", {
      roundId: round.id,
      startDate: "2030-11-10",
      endDate: "2030-11-11",
      reason: "טיפול רפואי סינתטי",
    });
    await command(
      manager,
      "constraint.review",
      { id: submitted.id, decision: "approved", reason: "אושר בגלל מצב אישי" },
      submitted.version
    );
    // Preferences, a request with a reason, and records written directly in their real shape.
    await command(member, "settings.save", {
      reminderHours: [2],
      email: {
        dutyReminder: false,
        roundOpening: true,
        roundClosing: true,
        publication: true,
        transfer: true,
        departure: true,
      },
    });
    // The earlier steps may have re-checked the seat, so read its version again.
    const [current] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, seat.id));
    await command(
      member,
      "cancellation.submit",
      { assignmentId: seat.id, kind: "postpone", reason: "בקשה אישית סינתטית" },
      current.version
    );
    await db.insert(records).values([
      {
        id: randomUUID(),
        kind: "personnel_change",
        subjectId: member.soldierId,
        data: { kind: "exemption", reason: "פטור סינתטי", actorId: manager.id },
      },
      {
        id: randomUUID(),
        kind: "email_change",
        subjectId: member.soldierId,
        data: { email: "new@example.invalid", digest: "x", reason: "שינוי" },
      },
      {
        id: randomUUID(),
        kind: "import_restore_profile_revision",
        subjectId: member.soldierId,
        data: { before: { exemptions: [{ exemptionId: "x" }] } },
      },
      {
        id: randomUUID(),
        kind: "lottery_exclusion",
        subjectId: member.soldierId,
        data: { dutyId: duty.id, reason: "נדחה בגלל מצב אישי" },
      },
      {
        id: randomUUID(),
        kind: "notification",
        subjectId: member.soldierId,
        data: { title: "הודעה אישית", body: "גוף" },
      },
      {
        id: randomUUID(),
        kind: "notification",
        data: { accountId: member.id, title: "הודעה לחשבון", body: "גוף" },
      },
    ]);
    const attemptId = randomUUID();
    await db.insert(records).values({
      id: attemptId,
      kind: "lottery_attempt",
      subjectId: member.soldierId,
      data: {
        dutyId: duty.id,
        status: "approval_required",
        candidateId: member.soldierId,
        reason: "אושר למרות פטור",
        requirements: [{ code: "exemption", message: "נדרש אישור חריג לפטור" }],
        candidates: [
          {
            id: member.soldierId,
            score: 33,
            status: "approval_required",
            blockers: [],
            approvalsRequired: [{ code: "exemption", message: "פטור" }],
          },
          {
            id: other.soldierId,
            score: 50,
            status: "blocked",
            blockers: [{ code: "inactive", message: "אי־פעילות" }],
            approvalsRequired: [],
          },
        ],
      },
    });
    const approvals = [
      {
        kind: "exemption",
        soldierId: member.soldierId,
        dutyId: duty.id,
        dutyVersion: 1,
        reason: "אושר חריג בגלל פטור",
        approvedBy: manager.id,
        approvedAt: new Date().toISOString(),
      },
    ];
    await db
      .update(assignments)
      .set({ data: { ...current.data, approvals } as typeof seat.data })
      .where(eq(assignments.id, seat.id));
    await db.insert(records).values({
      id: randomUUID(),
      kind: "assignment_approval",
      subjectId: member.soldierId,
      data: { assignmentId: seat.id, approvals },
    });
    const importRowId = randomUUID();
    await db.insert(records).values({
      id: importRowId,
      kind: "import_row",
      subjectId: member.soldierId,
      data: {
        batchId: randomUUID(),
        rowNumber: 2,
        mode: "update",
        name: row.name,
        values: { personalNumber: row.personalNumber, phone: "0509999999" },
        changes: [{ key: "phone", before: "1", after: "0509999999" }],
      },
    });
    // The manager's stored command result holds the soldier's id and contact data.
    const keyed = randomUUID();
    await command(
      manager,
      "soldier.delete.preview",
      { id: member.soldierId },
      (await soldierRow(member)).version,
      keyed
    );
    expect(
      (
        await db
          .select()
          .from(commandResults)
          .where(sql`position(${member.soldierId!} in result::text) > 0`)
      ).length
    ).toBeGreaterThan(0);

    await remove(manager, member, "שוחרר");

    // Sensitive records are gone.
    for (const kind of [
      "audit_detail",
      "personnel_change",
      "email_change",
      "import_restore_profile_revision",
      "settings",
    ])
      expect(await recordsOf(member, kind), kind).toHaveLength(0);
    const notices = await db
      .select()
      .from(records)
      .where(eq(records.kind, "notification"));
    expect(
      notices.filter(
        (item) =>
          item.subjectId === member.soldierId ||
          item.data.accountId === member.id
      )
    ).toHaveLength(0);
    // Constraints keep their dates, never their reasons.
    const [constraint] = await recordsOf(member, "constraint");
    const text = JSON.stringify(constraint.data);
    expect(text).toContain("2030-11-10");
    expect(text).not.toContain("טיפול רפואי");
    expect(text).not.toContain("אושר בגלל מצב אישי");
    expect(constraint.data.status).toBe("approved");
    expect(constraint.data.erasedAt).toBeDefined();
    // The request keeps its status and loses its reason.
    const request = (await recordsOf(member, "request"))[0];
    expect(request.data.reason).toBeUndefined();
    expect(JSON.stringify(request.data)).not.toContain("בקשה אישית סינתטית");
    // The lottery picture keeps the score, never the reasons.
    const [attempt] = await db
      .select()
      .from(records)
      .where(eq(records.id, attemptId));
    const picture = attempt.data as {
      status: string;
      reason?: string;
      requirements: unknown[];
      candidates: { id: string; score: number; blockers: unknown[] }[];
    };
    expect(picture.status).toBe("stale");
    expect(picture.reason).toBeUndefined();
    expect(picture.requirements).toEqual([]);
    expect(picture.candidates[0]).toMatchObject({ score: 33, blockers: [] });
    expect(picture.candidates[1].blockers).toHaveLength(1);
    expect(
      (await recordsOf(member, "lottery_exclusion"))[0].data.reason
    ).toBeUndefined();
    // Approval reasons are replaced, so an approval stays well formed.
    const [seatNow] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, seat.id));
    expect(
      (seatNow.data.approvals as { reason: string }[]).map((a) => a.reason)
    ).toEqual([ERASED_REASON]);
    expect(
      (
        (await recordsOf(member, "assignment_approval"))[0].data.approvals as {
          reason: string;
        }[]
      )[0].reason
    ).toBe(ERASED_REASON);
    // The import row keeps its number, name and outcome only.
    const [importRow] = await db
      .select()
      .from(records)
      .where(eq(records.id, importRowId));
    expect(importRow.data).toMatchObject({
      rowNumber: 2,
      name: "חייל למחיקה",
      erased: true,
      changes: [],
    });
    expect(JSON.stringify(importRow.data)).not.toContain("0509999999");
    // Stored command results no longer carry the soldier. The deletion's own
    // result only names the id, which stays.
    expect(
      (
        await db
          .select()
          .from(commandResults)
          .where(sql`position(${member.soldierId!} in result::text) > 0`)
      ).filter((item) => !("removedRecords" in (item.result as object)))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(commandResults)
        .where(sql`position('0501234567' in result::text) > 0`)
    ).toHaveLength(0);
    const [replayed] = await db
      .select()
      .from(commandResults)
      .where(eq(commandResults.requestKey, keyed));
    expect(replayed.result).toMatchObject({ erasedAt: expect.any(String) });
    // The event stays, with the reason kept by decision; earlier details read as removed.
    const log = (await readState(manager)).audit as {
      action: string;
      reason?: string;
      label: string;
      detailRemoved: boolean;
      soldierName?: string;
    }[];
    const deletion = log.find((entry) => entry.action === "soldier.delete")!;
    expect(deletion).toMatchObject({
      label: "מחיקת משתמש",
      reason: "שוחרר",
      soldierName: "חייל למחיקה",
    });
    expect(
      log.find((entry) => entry.action === "soldier.update")!.detailRemoved
    ).toBe(true);
    expect(
      log.find((entry) => entry.action === "constraint.review")!.detailRemoved
    ).toBe(true);
    // The soldier's duty history stays.
    expect((await seatsOf(member)).length).toBeGreaterThan(0);
  });
  it("also removes a notice that quoted the reason of a request about the soldier", async () => {
    await publishedDuty([other], 2, "תורנות א");
    await publishedDuty([member], 4, "תורנות ב");
    const theirs = (await seatsOf(other))[0];
    const offer = await command(
      other,
      "transfer.offer",
      { assignmentId: theirs.id, candidateIds: [member.soldierId] },
      theirs.version
    );
    const noticeId = randomUUID();
    await db.insert(records).values({
      id: noticeId,
      kind: "notification",
      subjectId: other.soldierId,
      data: {
        accountId: other.id,
        title: "ההעברה נדחתה",
        body: "נדחתה: הסיבה האישית של המועמד",
        requestId: offer.id,
      },
    });
    await remove(manager, member);
    const [notice] = await db
      .select()
      .from(records)
      .where(eq(records.id, noticeId));
    expect(notice.data.body).toBe(ERASED_NOTE);
    expect(notice.data.title).toBe("ההעברה נדחתה");
  });
});

describe("repeating and racing", () => {
  it("refuses a second deletion and an unreviewed or stale one", async () => {
    await publishedDuty([member, other], 2);
    const first = await preview(manager, member);
    // A seat added after the review changes the impact.
    const extra = await publishedDuty([member, third], 3, "תורנות נוספת");
    const row = await soldierRow(member);
    await expect(
      command(
        manager,
        "soldier.delete",
        {
          id: member.soldierId,
          previewToken: first.previewToken,
          reason: "שוחרר",
          confirmed: true,
        },
        row.version
      )
    ).rejects.toMatchObject({ code: "stale_preview" });
    expect((await soldierRow(member)).deletedAt).toBeNull();
    await expect(
      command(
        manager,
        "soldier.delete",
        {
          id: member.soldierId,
          previewToken: first.previewToken,
          reason: "שוחרר",
          confirmed: false,
        },
        row.version
      )
    ).rejects.toBeDefined();
    await expect(
      command(
        manager,
        "soldier.delete",
        {
          id: member.soldierId,
          previewToken: first.previewToken,
          reason: "שוחרר",
          confirmed: true,
        },
        row.version + 1
      )
    ).rejects.toMatchObject({ status: 409 });
    await remove(manager, member);
    await expect(remove(manager, member)).rejects.toMatchObject({
      code: "already_deleted",
    });
    expect((await dutyRow(extra.id)).version).toBeGreaterThan(extra.version);
  });
  it("returns the stored result of the same request and acts once", async () => {
    await publishedDuty([member, other], 2);
    const { previewToken } = await preview(manager, member);
    const request = {
      type: "soldier.delete",
      payload: {
        id: member.soldierId,
        previewToken,
        reason: "שוחרר",
        confirmed: true,
      },
      expectedVersion: (await soldierRow(member)).version,
      idempotencyKey: randomUUID(),
    };
    const first = await executeAction(manager, request);
    const again = await executeAction(manager, request);
    expect(again).toEqual(first);
    expect(first).toMatchObject({ vacated: 1 });
    expect(
      (await db.select().from(records)).filter(
        (item) => item.data.action === "soldier.delete"
      )
    ).toHaveLength(1);
    // Another payload under the same key is refused, not replayed.
    await expect(
      executeAction(manager, {
        ...request,
        payload: { ...request.payload, reason: "אחר" },
      })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("lets only one of two simultaneous deletions win", async () => {
    await publishedDuty([member, other], 2);
    const { previewToken } = await preview(manager, member);
    const row = await soldierRow(member);
    const attempt = (actor: Actor) =>
      command(
        actor,
        "soldier.delete",
        {
          id: member.soldierId,
          previewToken,
          reason: "שוחרר",
          confirmed: true,
        },
        row.version
      );
    const results = await Promise.allSettled([
      attempt(manager),
      attempt(secondManager),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    expect(
      (await db.select().from(records)).filter(
        (item) => item.data.action === "soldier.delete"
      )
    ).toHaveLength(1);
  });
  it("leaves no live seat for a soldier who agrees to a transfer while being deleted", async () => {
    await publishedDuty([other], 2);
    const theirs = (await seatsOf(other))[0];
    const offer = await command(
      other,
      "transfer.offer",
      { assignmentId: theirs.id, candidateIds: [third.soldierId] },
      theirs.version
    );
    await Promise.allSettled([
      command(
        third,
        "transfer.respond",
        { id: offer.id, decision: "accept", confirmed: true },
        offer.version
      ),
      unitTransaction((tx) =>
        eraseSoldier(tx, manager, third.soldierId!, { reason: "שוחרר" })
      ),
    ]);
    // Whichever came first, the deleted soldier holds no live seat afterwards.
    expect(
      (await seatsOf(third)).filter((item) =>
        ["reserved", "held"].includes(item.status)
      )
    ).toHaveLength(0);
    expect((await soldierRow(third)).deletedAt).not.toBeNull();
  });
  it("does not credit twice when settlement races with the deletion", async () => {
    const running = await publishedDuty([member], 3, "תורנות שהסתיימה");
    await moveDuty(running.id, Date.now() - 7_200_000, Date.now() - 3_600_000);
    await Promise.allSettled([
      unitTransaction((tx) => settleDue(tx)),
      unitTransaction((tx) =>
        eraseSoldier(tx, manager, member.soldierId!, { reason: "שוחרר" })
      ),
    ]);
    await unitTransaction((tx) => settleDue(tx));
    const credits = await db
      .select()
      .from(ledger)
      .where(
        and(
          eq(ledger.soldierId, member.soldierId!),
          eq(ledger.kind, "performance")
        )
      );
    const [seat] = await seatsOf(member);
    // Settled before the deletion: credited once. Deleted first: held for a decision.
    expect(credits).toHaveLength(seat.status === "credited" ? 1 : 0);
    expect((await soldierRow(member)).deletedAt).not.toBeNull();
  });
});

describe("import restore: deleting the user of a new soldier with activity", () => {
  type Planned = {
    id: string;
    creation: {
      status: string;
      activity: string[];
      deletion?: { deletable: boolean; vacated?: number };
    };
  };
  /** An imported soldier who has signed in, so the restore cannot cancel the intake. */
  async function importedWithActivity() {
    const batch = await command(manager, "import.preview", {
      filename: "יבוא סינתטי.xlsx",
      rows: [
        {
          rowNumber: 2,
          values: {
            personalNumber: "00777",
            name: "נקלט בייבוא",
            email: "import-777@example.invalid",
            phone: "0507770000",
            address: "כתובת בייבוא",
            currentScore: 5,
          },
        },
      ],
    });
    const applied = await command(
      manager,
      "import.apply",
      { id: batch.id, confirmed: true, reason: "ייבוא ראשוני" },
      batch.version
    );
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.personalNumber, "00777"));
    await db
      .update(user)
      .set({ firstSignInAt: new Date() })
      .where(eq(user.soldierId, person.id));
    return { batch: applied, person };
  }
  async function restorePreview(batch: { id: string; version: number }) {
    return (await command(
      manager,
      "import.restore.preview",
      { id: batch.id },
      batch.version
    )) as unknown as { token: string; version: number; rows: Planned[] };
  }
  it("shows the deletion's impact, and deletes the user only on an explicit decision", async () => {
    const { batch, person } = await importedWithActivity();
    const plan = await restorePreview(batch);
    expect(plan.rows[0].creation.status).toBe("activity");
    expect(plan.rows[0].creation.activity).toContain("כניסה לחשבון");
    expect(plan.rows[0].creation.deletion).toMatchObject({
      deletable: true,
      vacated: 0,
    });
    // Without a decision the row only waits.
    await expect(
      command(
        manager,
        "import.restore",
        {
          id: batch.id,
          token: plan.token,
          confirmed: true,
          reason: "בדיקה",
          decisions: [],
          creations: [],
        },
        plan.version
      )
    ).rejects.toMatchObject({ code: "nothing_to_restore" });
    expect(
      (await soldierRow({ soldierId: person.id } as Actor)).deletedAt
    ).toBeNull();
    const restored = (await command(
      manager,
      "import.restore",
      {
        id: batch.id,
        token: plan.token,
        confirmed: true,
        reason: "לא היה אמור להיקלט",
        decisions: [],
        creations: [{ rowId: plan.rows[0].id, action: "delete" }],
      },
      plan.version
    )) as unknown as { status: string };
    expect(restored.status).toBe("restored");
    const row = await soldierRow({ soldierId: person.id } as Actor);
    expect(row.deletedAt).not.toBeNull();
    expect(row.name).toBe("נקלט בייבוא");
    expect(row.personalNumber).toBe("00777");
    const [contact] = await db
      .select()
      .from(soldierContacts)
      .where(eq(soldierContacts.soldierId, person.id));
    expect([contact.email, contact.phone, contact.address]).toEqual([
      null,
      null,
      null,
    ]);
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.soldierId, person.id));
    expect(account.deletedAt).not.toBeNull();
    // The import row keeps its number, name and the outcome, not the contact data.
    const [importRow] = await recordsOf(
      { soldierId: person.id } as Actor,
      "import_row"
    );
    expect(importRow.data).toMatchObject({
      rowNumber: 2,
      name: "נקלט בייבוא",
      erased: true,
      newRowRestored: { action: "deleted", reason: "לא היה אמור להיקלט" },
    });
    expect(JSON.stringify(importRow.data)).not.toMatch(
      /0507770000|import-777|כתובת בייבוא/
    );
    // The history of the deletion records how it was made.
    const log = (await readState(manager)).audit as {
      action: string;
      reason?: string;
      details: { label: string; value: string }[];
    }[];
    const deletion = log.find((entry) => entry.action === "soldier.delete")!;
    expect(deletion.reason).toBe("לא היה אמור להיקלט");
    expect(deletion.details).toContainEqual({
      label: "דרך",
      value: "שחזור ייבוא",
    });
    // A closed row cannot be restored again, and the number stays with the history.
    await expect(
      command(
        manager,
        "import.restore.preview",
        { id: batch.id },
        restored.status === "restored" ? plan.version + 1 : plan.version
      )
    ).rejects.toBeDefined();
  });
  it("does not offer deletion for an account that became a manager account", async () => {
    const { batch, person } = await importedWithActivity();
    await db
      .update(user)
      .set({ role: "manager" })
      .where(eq(user.soldierId, person.id));
    const plan = await restorePreview(batch);
    expect(plan.rows[0].creation.status).toBe("activity");
    expect(plan.rows[0].creation.deletion).toEqual({ deletable: false });
    await expect(
      command(
        manager,
        "import.restore",
        {
          id: batch.id,
          token: plan.token,
          confirmed: true,
          reason: "בדיקה",
          decisions: [],
          creations: [{ rowId: plan.rows[0].id, action: "delete" }],
        },
        plan.version
      )
    ).rejects.toMatchObject({ code: "invalid_decision" });
    expect(
      (await soldierRow({ soldierId: person.id } as Actor)).deletedAt
    ).toBeNull();
  });
  it("still lets the manager keep the soldier", async () => {
    const { batch, person } = await importedWithActivity();
    const plan = await restorePreview(batch);
    await command(
      manager,
      "import.restore",
      {
        id: batch.id,
        token: plan.token,
        confirmed: true,
        reason: "להשאיר",
        decisions: [],
        creations: [{ rowId: plan.rows[0].id, action: "keep" }],
      },
      plan.version
    );
    const row = await soldierRow({ soldierId: person.id } as Actor);
    expect(row.deletedAt).toBeNull();
  });
});

describe("a review that time overtook", () => {
  it("is refused when a duty started after the review, because its seat is no longer vacated", async () => {
    const duty = await publishedDuty([member, other], 2);
    const { previewToken, vacated } = await preview(manager, member);
    expect(vacated).toHaveLength(1);
    await moveDuty(duty.id, Date.now() - 3_600_000, Date.now() + 3_600_000);
    const row = await soldierRow(member);
    await expect(
      command(
        manager,
        "soldier.delete",
        {
          id: member.soldierId,
          previewToken,
          reason: "שוחרר",
          confirmed: true,
        },
        row.version
      )
    ).rejects.toMatchObject({ code: "stale_preview" });
    expect((await soldierRow(member)).deletedAt).toBeNull();
    // A new review shows the seat as one that stays, flagged.
    const again = await preview(manager, member);
    expect(again.vacated).toHaveLength(0);
    expect(again.inProgress).toHaveLength(1);
  });
});
