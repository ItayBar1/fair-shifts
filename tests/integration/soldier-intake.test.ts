import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { emailOutbox, user } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  ledger,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { errorResponse } from "../../src/server/http";
import { soldier, testIdNumber } from "../fixtures";
import { rankAt } from "../../src/domain/eligibility";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// Adding one soldier with the form (stories 1 and 4, scenarios 4 and 5). Synthetic people only.
let manager: Actor;
// Required at intake: first and last name, gender, email and phone (decision 222).
const form = {
  firstName: "חייל",
  lastName: "בטופס",
  gender: "male",
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
    idNumber: testIdNumber(personalNumber),
    data: soldier({ id: soldierId, name }),
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
  it("stores an initial approved rank from the catalog with its effective date, once across retries", async () => {
    const rankId = randomUUID();
    await db.insert(records).values({
      id: rankId,
      kind: "rank_catalog",
      data: { name: "סמל לבדיקה", track: "חוגרים", order: 2 },
    });
    const key = randomUUID();
    const payload = { ...form, rankId, rankEffectiveDate: "2026-01-15" };
    const created = await create(payload, key);
    expect(await create(payload, key)).toEqual(created);
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, created.id));
    expect(person.data.rankHistory).toEqual([
      { rankId, trackId: "חוגרים", order: 2, effectiveFrom: "2026-01-15" },
    ]);
    expect(created.version).toBe(1);
    expect(rankAt(person.data, "2026-01-14T21:59:59Z")).toBeUndefined();
    expect(rankAt(person.data, "2026-01-14T22:00:00Z")?.rankId).toBe(rankId);
  });

  it("keeps a confirmed future rank out of the current rank until its effective date", async () => {
    const rankId = randomUUID();
    await db.insert(records).values({
      id: rankId,
      kind: "rank_catalog",
      data: { name: "קא״ב לבדיקה", track: "קמ״א", order: 1 },
    });
    const created = await create({
      ...form,
      population: "academic",
      rankId,
      rankEffectiveDate: "2099-06-01",
    });
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, created.id));
    expect(rankAt(person.data, "2099-05-31T20:59:59Z")).toBeUndefined();
    expect(rankAt(person.data, "2099-05-31T21:00:00Z")?.rankId).toBe(rankId);
    expect(person.data.service.basePopulation).toBe("academic");
  });

  it("creates the record, the contact, a zero balance, an invited account and its invitation", async () => {
    const created = await create(form);
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, created.id));
    expect(person).toMatchObject({ name: "חייל בטופס", version: 1 });
    expect(person.idNumber).toBeGreaterThan(0);
    expect(person.data).toMatchObject({
      firstName: "חייל",
      lastName: "בטופס",
      gender: "male",
    });
    expect(person.data).not.toHaveProperty("personalNumber");
    // The address that was typed is stored in lower case, for the invitation and for sign-in.
    const [contact] = await db
      .select()
      .from(soldierContacts)
      .where(eq(soldierContacts.soldierId, created.id));
    // The phone is kept without the separators that were typed.
    expect(contact).toMatchObject({
      email: "new.soldier@example.invalid",
      phone: "0500000001",
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
      capabilities: [],
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
    ["without a first name", { firstName: "   " }, 422, "invalid_input"],
    ["without a last name", { lastName: undefined }, 422, "invalid_input"],
    ["without a gender", { gender: undefined }, 422, "invalid_input"],
    ["with an unknown gender", { gender: "unknown" }, 422, "invalid_input"],
    ["without a phone", { phone: undefined }, 422, "invalid_input"],
    ["with a landline number", { phone: "03-1234567" }, 422, "invalid_input"],
    ["with a short mobile number", { phone: "050123" }, 422, "invalid_input"],
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
    [
      "with a rank but no effective date",
      { rankId: randomUUID() },
      422,
      "invalid_input",
    ],
    [
      "with an effective date but no rank",
      { rankEffectiveDate: "2026-01-15" },
      422,
      "invalid_input",
    ],
    [
      "with an invalid rank date",
      { rankId: randomUUID(), rankEffectiveDate: "2026-02-30" },
      422,
      "invalid_input",
    ],
    [
      "with an unknown rank",
      { rankId: randomUUID(), rankEffectiveDate: "2026-01-15" },
      404,
      "not_found",
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
  it("refuses an address that is taken, and warns on the same name until the manager confirms", async () => {
    const first = await create(form);
    const before = await counts();
    expect(await refused(create({ ...form, firstName: "אחר" }))).toEqual({
      status: 409,
      code: "email_exists",
    });
    // The same first and last name stops the save with a warning only (decision 222).
    expect(
      await refused(create({ ...form, email: "other@example.invalid" }))
    ).toEqual({ status: 409, code: "duplicate_name" });
    expect(await counts()).toEqual(before);
    const second = await create({
      ...form,
      email: "other@example.invalid",
      duplicateNameConfirmed: true,
    });
    const people = await db.select().from(soldiers);
    const same = people.filter((row) => row.name === "חייל בטופס");
    expect(same).toHaveLength(2);
    // Each one gets its own issued number, which tells them apart.
    const numbers = same.map((row) => row.idNumber);
    expect(new Set(numbers).size).toBe(2);
    expect(same.map((row) => row.id).sort()).toEqual(
      [first.id, second.id].sort()
    );
  });
  it("issues a number that ignores one sent with the form", async () => {
    const created = await create({ ...form, idNumber: 987654 });
    const [person] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, created.id));
    expect(person.idNumber).not.toBe(987654);
  });
  it("rejects a record of another kind as a rank without creating a soldier", async () => {
    const rankId = randomUUID();
    await db
      .insert(records)
      .values({ id: rankId, kind: "notification", data: {} });
    const before = await counts();
    expect(
      await refused(
        create({ ...form, rankId, rankEffectiveDate: "2026-01-15" })
      )
    ).toMatchObject({ status: 404, code: "not_found" });
    expect(await counts()).toEqual(before);
  });
  it("creates one soldier when the same form is sent twice, and refuses the key for another form", async () => {
    const key = randomUUID();
    const first = await create(form, key);
    expect(await create(form, key)).toEqual(first);
    expect((await db.select().from(soldiers)).length).toBe(2);
    expect(
      await refused(create({ ...form, firstName: "שם אחר" }, key))
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
        (row) => row.name === "חייל בטופס"
      )
    ).toHaveLength(1);
  });
});
