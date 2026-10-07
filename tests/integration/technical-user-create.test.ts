import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import {
  user,
  session,
  loginCode,
  emailOutbox,
} from "../../src/server/auth-schema";
import {
  soldiers,
  soldierContacts,
  balances,
  records,
  commandResults,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import { errorResponse } from "../../src/server/http";
import * as email from "../../src/server/operations/email";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

let technical: Actor;
const form = {
  name: "משתמש חדש לבדיקה",
  personalNumber: "00000114",
  email: "New.Technical.User@Example.invalid",
};
const invalidIdentityFields = [
  { name: "" },
  { name: "   " },
  { personalNumber: "12a" },
  { personalNumber: "" },
  { email: "" },
  { email: undefined },
  { email: "bad" },
  { id: randomUUID() },
  { role: "technical" },
  { currentScore: 50 },
  { phone: "123" },
  { serviceType: "career" },
];
const send = (
  actor: Actor,
  type: string,
  payload: Record<string, unknown>,
  key = randomUUID(),
  expectedVersion?: number
) =>
  executeAction(actor, { type, payload, idempotencyKey: key, expectedVersion });
const create = (payload: Record<string, unknown> = form, key = randomUUID()) =>
  send(technical, "technical.user.create", payload, key) as Promise<{
    id: string;
    version: number;
  }>;
async function refused(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const response = errorResponse(error);
    return {
      status: response.status,
      code: (await response.json()).error.code,
    };
  }
  throw new Error("Expected rejection");
}
async function snapshot() {
  return Promise.all([
    db.select().from(soldiers),
    db.select().from(soldierContacts),
    db.select().from(balances),
    db.select().from(user),
    db.select().from(emailOutbox),
    db.select().from(records),
    db.select().from(commandResults),
  ]);
}
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  const row = await createInvitedAccount({
    name: "טכני לבדיקה",
    email: "technical-114@example.invalid",
    role: "technical",
  });
  technical = {
    id: row.id,
    name: row.name,
    role: "technical",
    securityEpoch: row.securityEpoch,
  };
});
afterAll(async () => pool.end());

describe("technical single-user intake", () => {
  it("creates an invited identity with zero balance without any manager and projects a private account audit", async () => {
    const created = await create();
    const [person] = await db.select().from(soldiers);
    expect(person).toMatchObject({
      id: created.id,
      name: form.name,
      personalNumber: form.personalNumber,
      version: 1,
    });
    expect(person.data).toMatchObject({
      qualifications: [],
      exemptions: [],
      rankHistory: [],
      service: { graceEligible: false },
    });
    expect(await db.select().from(soldierContacts)).toMatchObject([
      {
        soldierId: created.id,
        email: form.email.toLowerCase(),
        phone: null,
        address: null,
      },
    ]);
    expect(await db.select().from(balances)).toMatchObject([
      { soldierId: created.id, current: 0 },
    ]);
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.soldierId, created.id));
    expect(account).toMatchObject({
      role: "soldier",
      email: form.email.toLowerCase(),
      securityEpoch: 1,
    });
    expect(await db.select().from(emailOutbox)).toMatchObject([
      { kind: "invitation", recipientAccountId: account.id },
    ]);
    const [event] = (await db.select().from(records)).filter(
      (row) => row.kind === "audit"
    );
    expect(event.data).toMatchObject({
      actorId: technical.id,
      action: "account.create",
      targetId: account.id,
    });
    expect(JSON.stringify(event.data)).not.toContain(form.email);
    expect(JSON.stringify(event.data)).not.toContain(form.personalNumber);
    const state = await readState(technical);
    expect(state.soldiers).toEqual([]);
    expect(state.ledger).toEqual([]);
    expect(state.audit).toMatchObject([
      {
        action: "account.create",
        label: "הוספת משתמש בידי המנהל הטכני",
        category: "account",
        targetId: account.id,
      },
    ]);
    expect(JSON.stringify(state)).not.toContain(form.email.toLowerCase());
    expect(JSON.stringify(state)).not.toContain(form.personalNumber);
  });
  it("grants the existing manager role, revokes old access and lets a fresh manager intake another soldier", async () => {
    const created = await create();
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.soldierId, created.id));
    const oldActor: Actor = {
      id: account.id,
      name: account.name,
      role: "soldier",
      soldierId: created.id,
      securityEpoch: account.securityEpoch,
    };
    await db.insert(session).values({
      id: randomUUID(),
      userId: account.id,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 86400000),
      securityEpoch: account.securityEpoch,
    });
    await db.insert(loginCode).values({
      userId: account.id,
      digest: "synthetic",
      expiresAt: new Date(Date.now() + 600000),
      sentAt: new Date(),
      securityEpoch: account.securityEpoch,
    });
    await send(
      technical,
      "account.role",
      { id: account.id, role: "manager" },
      randomUUID(),
      account.securityEpoch
    );
    expect(await db.select().from(session)).toEqual([]);
    expect(await db.select().from(loginCode)).toEqual([]);
    expect(await refused(readState(oldActor))).toMatchObject({ status: 401 });
    const [updated] = await db
      .select()
      .from(user)
      .where(eq(user.id, account.id));
    const manager: Actor = {
      ...oldActor,
      role: "manager",
      securityEpoch: updated.securityEpoch,
    };
    await send(manager, "soldier.create", {
      name: "קליטה על ידי אחראי חדש",
      personalNumber: "00000115",
      email: "next-114@example.invalid",
    });
    expect(await db.select().from(soldiers)).toHaveLength(2);
    expect(
      await refused(send(manager, "technical.user.create", {}))
    ).toMatchObject({ status: 403 });
    expect(
      await refused(send(oldActor, "technical.user.create", {}))
    ).toMatchObject({ status: 401 });
  });
  it("refuses soldier and manager actors before validating payload and leaves existing data intact", async () => {
    const created = await create();
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.soldierId, created.id));
    for (const role of ["soldier", "manager"] as const) {
      await db.update(user).set({ role }).where(eq(user.id, account.id));
      const before = await snapshot();
      const actor: Actor = {
        id: account.id,
        name: account.name,
        role,
        soldierId: created.id,
        securityEpoch: 1,
      };
      expect(await refused(send(actor, "technical.user.create", {}))).toEqual({
        status: 403,
        code: "FORBIDDEN",
      });
      expect(await snapshot()).toEqual(before);
    }
  });
  it.each(invalidIdentityFields)(
    "rejects invalid or out-of-scope identity fields without writing: %j",
    async (change) => {
      const before = await snapshot();
      expect(await refused(create({ ...form, ...change }))).toEqual({
        status: 422,
        code: "invalid_input",
      });
      expect(await snapshot()).toEqual(before);
    }
  );
  it("rejects duplicate identity and normalized email, including a deleted personal number", async () => {
    const created = await create();
    await db
      .update(balances)
      .set({ current: 37 })
      .where(eq(balances.soldierId, created.id));
    const before = await snapshot();
    expect(
      await refused(create({ ...form, email: "other@example.invalid" }))
    ).toEqual({ status: 409, code: "personal_number_exists" });
    expect(
      await refused(
        create({
          ...form,
          personalNumber: "00000116",
          email: form.email.toLowerCase(),
        })
      )
    ).toEqual({ status: 409, code: "email_exists" });
    expect(await snapshot()).toEqual(before);
    await db
      .update(soldiers)
      .set({ deletedAt: new Date() })
      .where(eq(soldiers.id, created.id));
    const erased = await snapshot();
    expect(
      await refused(create({ ...form, email: "other@example.invalid" }))
    ).toEqual({ status: 409, code: "personal_number_exists" });
    expect(await snapshot()).toEqual(erased);
  });
  it("replays one idempotent result and refuses a reused key for a different identity", async () => {
    const key = randomUUID();
    const first = await create(form, key);
    const before = await snapshot();
    expect(await create(form, key)).toEqual(first);
    expect(await snapshot()).toEqual(before);
    expect(await refused(create({ ...form, name: "אחר" }, key))).toMatchObject({
      status: 409,
      code: "idempotency_conflict",
    });
  });
  it.each([
    {},
    { personalNumber: "00000999" },
    { email: "same-number-114@example.invalid" },
  ])(
    "serializes competing creations from two technical accounts without duplicate invitations: %j",
    async (change) => {
      const other = await createInvitedAccount({
        name: "טכני נוסף",
        email: "other-tech-114@example.invalid",
        role: "technical",
      });
      const actor: Actor = {
        id: other.id,
        name: other.name,
        role: "technical",
        securityEpoch: other.securityEpoch,
      };
      const results = await Promise.allSettled([
        create(),
        send(actor, "technical.user.create", { ...form, ...change }),
      ]);
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(
        1
      );
      expect(await db.select().from(soldiers)).toHaveLength(1);
      expect(await db.select().from(emailOutbox)).toHaveLength(1);
    }
  );
  it("rolls back person, contact, balance and account when invitation persistence fails", async () => {
    const before = await snapshot();
    const mock = vi
      .spyOn(email, "enqueueEmail")
      .mockRejectedValueOnce(new Error("Synthetic persistence failure"));
    try {
      await expect(create()).rejects.toThrow("Synthetic persistence failure");
    } finally {
      mock.mockRestore();
    }
    expect(await snapshot()).toEqual(before);
  });
});
