import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool } from "../../src/server/db";
import {
  balances,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import type { AuditEntry } from "../../src/server/audit-log";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

let manager: Actor;
let secondManager: Actor;
let technical: Actor;
let member: Actor;
let other: Actor;

async function invite(
  name: string,
  role: "soldier" | "manager",
  personalNumber: string
): Promise<Actor> {
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber,
    data: soldier({ id, name, personalNumber }),
  });
  const email = `${personalNumber}@example.invalid`;
  await db.insert(soldierContacts).values({ soldierId: id, email });
  await db.insert(balances).values({ soldierId: id });
  const row = await createInvitedAccount({ name, role, email, soldierId: id });
  return { id: row.id, name, role, soldierId: id, securityEpoch: 1 };
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
  })) as { id: string; version: number; token: string };
}
async function auditOf(actor: Actor) {
  return (await readState(actor)).audit as AuditEntry[];
}
async function envelopes() {
  return db.select().from(records).where(eq(records.kind, "audit"));
}
async function adjust(
  actor: Actor,
  soldierId: string,
  idempotencyKey?: string
) {
  const input = {
    soldierIds: [soldierId],
    operation: "add",
    value: 5,
    reason: "תיקון יתרה סינתטי",
  };
  const preview = await command(actor, "score.preview", input);
  await command(
    actor,
    "score.apply",
    { ...input, token: preview.token },
    undefined,
    idempotencyKey
  );
  return preview.token;
}
async function constraintAwaitingReview() {
  const round = await command(manager, "round.create", {
    name: "סבב סינתטי",
    opensAt: new Date(Date.now() - 60_000).toISOString(),
    closesAt: new Date(Date.now() + 3600_000).toISOString(),
    targetStart: "2026-11-01",
    targetEnd: "2026-11-30",
  });
  return command(member, "constraint.submit", {
    roundId: round.id,
    startDate: "2026-11-10",
    endDate: "2026-11-11",
    reason: "סיבה אישית סינתטית",
  });
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  const tech = await createInvitedAccount({
    name: "טכני לבדיקה",
    role: "technical",
    email: "technical@example.invalid",
  });
  technical = {
    id: tech.id,
    name: tech.name,
    role: "technical",
    securityEpoch: 1,
  };
  manager = await invite("אחראי לבדיקה", "manager", "00002");
  secondManager = await invite("אחראי נוסף", "manager", "00003");
  member = await invite("חייל לבדיקה", "soldier", "00001");
  other = await invite("חייל נוסף", "soldier", "00004");
});
afterAll(async () => pool.end());

describe("audit log", () => {
  it("shows when, who, why and what changed, with the effective date only when it differs", async () => {
    const lower = await command(manager, "rank.catalog.save", {
      name: "דרגה א סינתטית",
      track: "מסלול סינתטי",
      order: 1,
      source: "נתוני בדיקה",
    });
    const upper = await command(manager, "rank.catalog.save", {
      name: "דרגה ב סינתטית",
      track: "מסלול סינתטי",
      order: 2,
      source: "נתוני בדיקה",
    });
    await command(
      manager,
      "rank.set",
      {
        soldierId: member.soldierId,
        rankId: lower.id,
        effectiveDate: "2026-01-31",
        reason: "אישור רטרואקטיבי סינתטי",
      },
      1
    );
    const today = DateTime.now().setZone("Asia/Jerusalem").toISODate()!;
    await command(
      manager,
      "rank.set",
      {
        soldierId: member.soldierId,
        rankId: upper.id,
        effectiveDate: today,
        reason: "קידום סינתטי",
      },
      2
    );
    const ranks = (await auditOf(manager)).filter(
      (entry) => entry.action === "rank.set"
    );
    // Newest first.
    expect(ranks.map((entry) => entry.reason)).toEqual([
      "קידום סינתטי",
      "אישור רטרואקטיבי סינתטי",
    ]);
    const [promotion, backdated] = ranks;
    expect(backdated).toMatchObject({
      label: "עדכון דרגה",
      actorName: "אחראי לבדיקה",
      soldierId: member.soldierId,
      soldierName: "חייל לבדיקה",
      effectiveAt: "2026-01-31",
      changes: [{ label: "דרגה", before: "—", after: "דרגה א סינתטית" }],
    });
    expect(backdated.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(promotion.effectiveAt).toBeUndefined();
    expect(promotion.changes).toEqual([
      { label: "דרגה", before: "דרגה א סינתטית", after: "דרגה ב סינתטית" },
    ]);
    // Reachable from the soldier.
    expect(
      (await auditOf(manager)).filter((entry) =>
        entry.refs.includes(member.soldierId!)
      )
    ).toHaveLength(2);
  });

  it("identifies a decision of another manager and reaches it from the score ledger", async () => {
    const token = await adjust(secondManager, member.soldierId!);
    const state = await readState(manager);
    const entry = (state.audit as AuditEntry[]).find(
      (row) => row.action === "score.apply"
    )!;
    expect(entry).toMatchObject({
      actorId: secondManager.id,
      actorName: "אחראי נוסף",
      actorRole: "manager",
      soldierName: "חייל לבדיקה",
      reason: "תיקון יתרה סינתטי",
      changes: [{ label: "יתרה", before: "0", after: "5" }],
    });
    expect(entry.actorId).not.toBe(manager.id);
    const ledgerRow = (state.ledger as { sourceKey: string }[]).find((row) =>
      row.sourceKey.startsWith("adjustment:")
    )!;
    const source = ledgerRow.sourceKey.split(":")[1];
    expect(source).toBe(token);
    expect(entry.refs).toContain(source);
    expect(entry.refs).toContain(member.soldierId);
  });

  it("keeps personal text out of the envelope, and keeps the envelope when that text is erased", async () => {
    const submission = await constraintAwaitingReview();
    await command(
      manager,
      "constraint.review",
      { id: submission.id, decision: "rejected", reason: "נימוק דחייה סינתטי" },
      1
    );
    await command(
      manager,
      "soldier.update",
      {
        id: member.soldierId,
        name: "חייל לבדיקה",
        personalNumber: "00001",
        phone: "0500000001",
        serviceType: "mandatory",
        population: "mandatory",
      },
      1
    );
    const stored = JSON.stringify(await envelopes());
    for (const personal of [
      "נימוק דחייה סינתטי",
      "סיבה אישית סינתטית",
      "0500000001",
    ])
      expect(stored).not.toContain(personal);
    let log = await auditOf(manager);
    const review = () => log.find((row) => row.action === "constraint.review")!;
    const update = () => log.find((row) => row.action === "soldier.update")!;
    expect(review()).toMatchObject({
      reason: "נימוק דחייה סינתטי",
      details: [{ label: "החלטה", value: "נדחה" }],
      detailRemoved: false,
    });
    expect(update().changes).toEqual([
      { label: "טלפון", before: "—", after: "0500000001" },
    ]);

    // The erasure step removes the soldier's sensitive records, not the envelopes.
    await db
      .delete(records)
      .where(
        and(
          eq(records.subjectId, member.soldierId!),
          inArray(records.kind, [
            "audit_detail",
            "constraint",
            "personnel_change",
          ])
        )
      );
    log = await auditOf(manager);
    expect(review()).toMatchObject({
      actorName: "אחראי לבדיקה",
      soldierName: "חייל לבדיקה",
      detailRemoved: true,
    });
    expect(review().reason).toBeUndefined();
    expect(update()).toMatchObject({
      detailRemoved: true,
      changes: [],
      details: [{ label: "שדות", value: "טלפון" }],
    });
    expect(JSON.stringify(log)).not.toContain("0500000001");
  });

  it("gives soldiers no log and the technical account only operations within its authority", async () => {
    await adjust(manager, member.soldierId!);
    await command(manager, "account.unlock", { id: member.id }, 1);
    await command(
      technical,
      "account.role",
      { id: other.id, role: "manager" },
      1
    );
    await command(
      technical,
      "account.responsibility",
      { id: manager.id, responsibility: "career" },
      1
    );
    // The unlock raised the soldier's security epoch.
    expect(await auditOf({ ...member, securityEpoch: 2 })).toEqual([]);

    const operations = await auditOf(technical);
    expect(operations.map((entry) => entry.action).sort()).toEqual([
      "responsibility:career",
      "role:manager",
    ]);
    expect(
      operations.find((row) => row.action === "role:manager")
    ).toMatchObject({
      label: "הענקת הרשאת אחראי",
      actorName: "טכני לבדיקה",
      details: [{ label: "חשבון", value: "חייל נוסף" }],
    });
    expect(operations.every((entry) => entry.soldierName === undefined)).toBe(
      true
    );
    expect(JSON.stringify(operations)).not.toContain("חייל לבדיקה");

    const managed = (await auditOf(manager)).map((entry) => entry.action);
    expect(managed).toEqual(
      expect.arrayContaining(["score.apply", "unlock", "role:manager"])
    );
  });

  it("records one entry for a retried command and for competing decisions", async () => {
    const key = randomUUID();
    await adjust(manager, member.soldierId!, key);
    const preview = (await envelopes()).find(
      (row) => row.data.action === "score.apply"
    )!.data.targetId as string;
    await command(
      manager,
      "score.apply",
      {
        soldierIds: [member.soldierId],
        operation: "add",
        value: 5,
        reason: "תיקון יתרה סינתטי",
        token: preview,
      },
      undefined,
      key
    );
    expect(
      (await envelopes()).filter((row) => row.data.action === "score.apply")
    ).toHaveLength(1);

    const submission = await constraintAwaitingReview();
    const results = await Promise.allSettled([
      command(
        manager,
        "constraint.review",
        { id: submission.id, decision: "approved" },
        1
      ),
      command(
        secondManager,
        "constraint.review",
        { id: submission.id, decision: "rejected", reason: "דחייה מתחרה" },
        1
      ),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const reviews = (await auditOf(manager)).filter(
      (row) => row.action === "constraint.review"
    );
    expect(reviews).toHaveLength(1);
    // Whoever lost the race left neither an envelope nor a detail record behind.
    const details = await db
      .select()
      .from(records)
      .where(eq(records.kind, "audit_detail"));
    expect(details).toHaveLength(reviews[0].reason ? 1 : 0);
  });
});
