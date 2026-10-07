import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { emailOutbox, user } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  ledger,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { errorResponse } from "../../src/server/http";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// Adding one soldier with the form (stories 1 and 4, scenarios 4 and 5). Synthetic people only.
let manager: Actor;
const form = {
  name: "חייל בטופס",
  personalNumber: "0007001",
  email: "New.Soldier@Example.invalid",
  phone: "050-0000001",
  address: "רחוב הטופס 1",
};
async function create(
  payload: Record<string, unknown>,
  key = randomUUID(),
  actor = manager
) {
  return (await executeAction(actor, {
    type: "soldier.create",
    payload,
    idempotencyKey: key,
  })) as { id: string; version: number };
}
/** The status the browser would see, and whether anything was written. */
async function refused(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const response = errorResponse(error);
    return {
      status: response.status,
      code: ((await response.json()) as { error: { code: string } }).error.code,
    };
  }
  throw new Error("expected the form to be refused");
}
async function counts() {
  return {
    soldiers: (await db.select().from(soldiers)).length,
    contacts: (await db.select().from(soldierContacts)).length,
    balances: (await db.select().from(balances)).length,
    accounts: (await db.select().from(user)).length,
    mail: (await db.select().from(emailOutbox)).length,
  };
}

async function invite(
  name: string,
  personalNumber: string,
  email: string
): Promise<Actor> {
  const soldierId = randomUUID();
  await db.insert(soldiers).values({
    id: soldierId,
    name,
    personalNumber,
    data: soldier({ id: soldierId, name, personalNumber }),
  });
  await db.insert(soldierContacts).values({ soldierId, email });
  await db.insert(balances).values({ soldierId });
  const row = await createInvitedAccount({
    name,
    role: "manager",
    email,
    soldierId,
  });
  return { id: row.id, name, role: "manager", soldierId, securityEpoch: 1 };
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("אחראי לבדיקה", "0000001", "manager@example.invalid");
});
afterAll(async () => pool.end());

describe("adding a soldier with the form", () => {
  it("creates the record, the contact, a zero balance, an invited account and its invitation", async () => {
    const created = await create(form);
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, created.id));
    expect(person).toMatchObject({
      name: form.name,
      personalNumber: form.personalNumber,
      version: 1,
    });
    // The address that was typed is stored in lower case, for the invitation and for sign-in.
    const [contact] = await db
      .select()
      .from(soldierContacts)
      .where(eq(soldierContacts.soldierId, created.id));
    expect(contact).toMatchObject({
      email: "new.soldier@example.invalid",
      phone: form.phone,
      address: form.address,
    });
    const [balance] = await db
      .select()
      .from(balances)
      .where(eq(balances.soldierId, created.id));
    expect(balance.current).toBe(0);
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.soldierId, created.id));
    expect(account).toMatchObject({
      role: "soldier",
      email: "new.soldier@example.invalid",
      lockedAt: null,
    });
    const mail = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, account.id));
    expect(mail).toMatchObject([
      { kind: "invitation", eventKey: `invitation:${account.id}` },
    ]);
  });
  it("starts without history, rank, grace or duties", async () => {
    const created = await create(form);
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, created.id));
    expect(person.data).toMatchObject({
      service: {
        type: "mandatory",
        basePopulation: "mandatory",
        graceEligible: false,
      },
      populationHistory: [],
      rankHistory: [],
      qualifications: [],
      exemptions: [],
      inactivePeriods: [],
    });
    expect(await db.select().from(assignments)).toEqual([]);
    expect(
      (await db.select().from(ledger)).filter(
        (row) => row.soldierId === created.id
      )
    ).toEqual([]);
  });
  it("takes an opening balance as the only history", async () => {
    const created = await create({
      ...form,
      personalNumber: "0007002",
      email: "opening@example.invalid",
      currentScore: 40,
    });
    const [balance] = await db
      .select()
      .from(balances)
      .where(eq(balances.soldierId, created.id));
    expect(balance.current).toBe(40);
    expect(
      (await db.select().from(ledger)).filter(
        (row) => row.soldierId === created.id
      )
    ).toMatchObject([{ kind: "opening", amount: 40, before: 0, after: 40 }]);
    expect(await db.select().from(assignments)).toEqual([]);
  });
  it("keeps the population the form chose", async () => {
    const created = await create({
      ...form,
      personalNumber: "0007003",
      email: "career@example.invalid",
      population: "career",
      serviceType: "career",
    });
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, created.id));
    expect(person.data.service).toMatchObject({
      type: "career",
      basePopulation: "career",
      graceEligible: false,
    });
  });
});

describe("a form that cannot be saved", () => {
  const bad: [string, Record<string, unknown>, number, string][] = [
    [
      "without an address to invite",
      { email: undefined },
      422,
      "email_required",
    ],
    [
      "with an address that is not one",
      { email: "not-an-address" },
      422,
      "invalid_input",
    ],
    [
      "with a personal number of letters",
      { personalNumber: "12ab" },
      422,
      "invalid_input",
    ],
    ["without a personal number", { personalNumber: "" }, 422, "invalid_input"],
    ["without a name", { name: "   " }, 422, "invalid_input"],
    [
      "with a negative opening balance",
      { currentScore: -5 },
      422,
      "invalid_input",
    ],
    [
      "with an existing soldier's id",
      { id: randomUUID() },
      422,
      "invalid_input",
    ],
  ];
  it.each(bad)(
    "refuses a form %s and writes nothing",
    async (_name, change, status, code) => {
      const before = await counts();
      expect(await refused(create({ ...form, ...change }))).toEqual({
        status,
        code,
      });
      expect(await counts()).toEqual(before);
    }
  );
  it("refuses a personal number that is taken, and an address that is taken, without a trace", async () => {
    await create(form);
    const before = await counts();
    expect(
      await refused(create({ ...form, email: "other@example.invalid" }))
    ).toEqual({ status: 409, code: "personal_number_exists" });
    expect(
      await refused(create({ ...form, personalNumber: "0007999" }))
    ).toEqual({ status: 409, code: "email_exists" });
    expect(await counts()).toEqual(before);
  });
  it("creates one soldier when the same form is sent twice, and refuses the key for another form", async () => {
    const key = randomUUID();
    const first = await create(form, key);
    expect(await create(form, key)).toEqual(first);
    expect((await db.select().from(soldiers)).length).toBe(2);
    expect(
      await refused(create({ ...form, name: "שם אחר" }, key))
    ).toMatchObject({ status: 409, code: "idempotency_conflict" });
  });
  it("creates one soldier when two managers send the same form at once", async () => {
    const second = await invite(
      "אחראי נוסף",
      "0000002",
      "other-manager@example.invalid"
    );
    const results = await Promise.allSettled([
      create(form, randomUUID(), manager),
      create(form, randomUUID(), second),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(
      (await db.select().from(soldiers)).filter(
        (row) => row.personalNumber === form.personalNumber
      )
    ).toHaveLength(1);
  });
});
