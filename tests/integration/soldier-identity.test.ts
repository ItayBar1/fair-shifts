import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { emailOutbox } from "../../src/server/auth-schema";
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
import { errorResponse } from "../../src/server/http";
import { soldier, testIdNumber } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// Decision 222 (#175): the issued ID number, the required details, the
// same-name warning and a soldier's own details. Synthetic people only.
let manager: Actor;
let member: Actor;
let other: Actor;
let technical: Actor;
const transport = process.env.MAIL_TRANSPORT;

async function invite(
  key: string,
  name: string,
  role: "soldier" | "manager",
  email: string,
  phone: string | null = null
): Promise<Actor> {
  const id = randomUUID();
  const [firstName, lastName] = name.split(" ");
  await db.insert(soldiers).values({
    id,
    name,
    idNumber: testIdNumber(key),
    data: soldier({ id, name, firstName, lastName, gender: "female" }),
  });
  await db.insert(soldierContacts).values({ soldierId: id, email, phone });
  await db.insert(balances).values({ soldierId: id });
  const row = await createInvitedAccount({ name, role, email, soldierId: id });
  return { id: row.id, name, role, soldierId: id, securityEpoch: 1 };
}
const command = async (
  actor: Actor,
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) =>
  (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as Record<string, unknown> & {
    id: string;
    version: number;
    rows: Record<string, unknown>[];
  };
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
  throw new Error("expected a refusal");
}
const newRow = (rowNumber: number, firstName: string, email: string) => ({
  rowNumber,
  values: {
    firstName,
    lastName: "חדשה",
    gender: "female",
    email,
    phone: `05000003${String(rowNumber).padStart(2, "0")}`,
  },
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite(
    "1",
    "אחראית זיהוי",
    "manager",
    "id-manager@example.invalid"
  );
  member = await invite(
    "2",
    "דנה כהן",
    "soldier",
    "id-member@example.invalid",
    "0501110000"
  );
  other = await invite("3", "נועה לוי", "soldier", "id-other@example.invalid");
  const tech = await createInvitedAccount({
    name: "טכני זיהוי",
    role: "technical",
    email: "id-technical@example.invalid",
  });
  technical = {
    id: tech.id,
    name: tech.name,
    role: "technical",
    securityEpoch: 1,
  };
});
afterEach(() => {
  process.env.MAIL_TRANSPORT = transport;
});
afterAll(async () => pool.end());

describe("import by the issued ID number", () => {
  it("updates the soldier whose number the row carries and creates one for a row without a number", async () => {
    const preview = await command(manager, "import.preview", {
      filename: "identity.xlsx",
      rows: [
        {
          rowNumber: 2,
          values: { idNumber: testIdNumber("2"), releaseDate: "2027-05-31" },
        },
        newRow(3, "רותם", "id-new@example.invalid"),
      ],
    });
    expect(preview.rows.map((row) => row.mode)).toEqual(["update", "create"]);
    await command(
      manager,
      "import.apply",
      {
        id: preview.id,
        confirmed: true,
        overwriteConfirmed: true,
        reason: "עדכון לפי מספר",
      },
      preview.version
    );
    const [updated] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, member.soldierId!));
    expect(updated.data.service.releaseDate).toBe("2027-05-31");
    // An update without names keeps the stored name.
    expect(updated.name).toBe("דנה כהן");
    const [created] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.name, "רותם חדשה"));
    expect(created.idNumber).toBeGreaterThan(0);
    expect(created.data).toMatchObject({
      firstName: "רותם",
      lastName: "חדשה",
      gender: "female",
    });
  });
  it("rejects a number the unit does not have, and a new row without the required details", async () => {
    await expect(
      command(manager, "import.preview", {
        filename: "unknown.xlsx",
        rows: [
          { rowNumber: 2, values: { idNumber: 999_999, firstName: "אין" } },
          {
            rowNumber: 3,
            values: { firstName: "חסר", email: "id-missing@example.invalid" },
          },
        ],
      })
    ).rejects.toMatchObject({
      code: "import_errors",
      details: {
        problems: expect.arrayContaining([
          expect.objectContaining({ row: 2, field: "מספר זיהוי" }),
          expect.objectContaining({ row: 3, field: "שם משפחה" }),
          expect.objectContaining({ row: 3, field: "מגדר" }),
          expect.objectContaining({ row: 3, field: "טלפון" }),
        ]),
      },
    });
    expect(await db.select().from(soldiers)).toHaveLength(3);
  });
  it("warns on the same first and last name, against the unit and within the file, and still saves", async () => {
    const preview = await command(manager, "import.preview", {
      filename: "names.xlsx",
      rows: [
        {
          rowNumber: 2,
          values: {
            firstName: "דנה",
            lastName: "כהן",
            gender: "female",
            email: "id-dana2@example.invalid",
            phone: "0500000402",
          },
        },
        newRow(3, "שירה", "id-shira1@example.invalid"),
        newRow(4, "שירה", "id-shira2@example.invalid"),
      ],
    });
    const warnings = preview.rows.map((row) => row.sameName);
    expect(warnings[0]).toEqual([`דנה כהן (מספר זיהוי ${testIdNumber("2")})`]);
    expect(warnings[1]).toEqual(["שורה 4 בקובץ"]);
    expect(warnings[2]).toEqual(["שורה 3 בקובץ"]);
    expect(preview.sameNames).toBe(3);
    await command(
      manager,
      "import.apply",
      { id: preview.id, confirmed: true, reason: "שמות כפולים" },
      preview.version
    );
    const people = await db.select().from(soldiers);
    expect(people.filter((row) => row.name === "דנה כהן")).toHaveLength(2);
    expect(people.filter((row) => row.name === "שירה חדשה")).toHaveLength(2);
    expect(new Set(people.map((row) => row.idNumber)).size).toBe(people.length);
  });
  it("does not queue an invitation to a reserved test address when the real provider is set", async () => {
    process.env.MAIL_TRANSPORT = "brevo";
    const preview = await command(manager, "import.preview", {
      filename: "reserved.xlsx",
      rows: [
        newRow(2, "שקד", "id-reserved@example.invalid"),
        newRow(3, "אור", "id-real@fairshifts-tests.net"),
      ],
    });
    const batch = await command(
      manager,
      "import.apply",
      { id: preview.id, confirmed: true, reason: "כתובת שמורה" },
      preview.version
    );
    const published = await command(
      manager,
      "import.invitations.publish",
      { id: batch.id, confirmed: true },
      batch.version
    );
    // Decision 190: a reserved address is never handed to the provider, so it
    // is not queued and counts as skipped.
    expect(published).toMatchObject({
      invitationsQueued: 1,
      invitationsSkipped: 1,
    });
    const queued = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, "invitation"));
    expect(queued).toHaveLength(1);
  });
});

describe("a soldier's own details", () => {
  const versions = { phone: 0, address: 0 };
  it("shows the soldier their own number and details, and no one else's", async () => {
    const state = (await readState(member)) as Record<string, unknown>;
    expect(state.myProfile).toMatchObject({
      idNumber: testIdNumber("2"),
      firstName: "דנה",
      lastName: "כהן",
      gender: "female",
      email: "id-member@example.invalid",
      phone: "0501110000",
    });
    const text = JSON.stringify({ ...state, myProfile: undefined });
    for (const hidden of [
      `"idNumber":${testIdNumber("3")}`,
      `"idNumber":${testIdNumber("2")}`,
      "id-other@example.invalid",
    ])
      expect(text).not.toContain(hidden);
  });
  it("saves a new phone and address at once, logs it and tells the managers without the values", async () => {
    // The stored versions start at 0 for a contact that was never edited.
    await command(member, "profile.contact.update", {
      phone: "052-123 4567",
      address: "רחוב סינתטי 3",
      versions,
    });
    const [contact] = await db
      .select()
      .from(soldierContacts)
      .where(eq(soldierContacts.soldierId, member.soldierId!));
    expect(contact).toMatchObject({
      phone: "0521234567",
      address: "רחוב סינתטי 3",
    });
    const notices = await db
      .select()
      .from(records)
      .where(eq(records.kind, "notification"));
    expect(notices).toHaveLength(1);
    expect(notices[0].data).toMatchObject({
      accountId: manager.id,
      title: "עדכון פרטי קשר",
      body: "דנה כהן עדכן/ה בעצמו/ה טלפון וכתובת.",
    });
    expect(JSON.stringify(notices)).not.toContain("0521234567");
    const [event] = await db
      .select()
      .from(records)
      .where(
        and(eq(records.kind, "audit"), eq(records.subjectId, member.soldierId!))
      );
    expect(event.data).toMatchObject({
      action: "soldier.update",
      actorId: member.id,
    });
    expect(JSON.stringify(event.data)).not.toContain("0521234567");
    // The same values again change nothing and tell no one.
    const after = ((await readState(member)) as Record<string, unknown>)
      .myProfile as {
      contactVersions: typeof versions;
    };
    expect(
      await command(member, "profile.contact.update", {
        phone: "0521234567",
        address: "רחוב סינתטי 3",
        versions: after.contactVersions,
      })
    ).toEqual({ changed: false });
  });
  it("refuses a stale screen, a landline number, and anyone but a soldier", async () => {
    expect(
      await refused(
        command(member, "profile.contact.update", {
          phone: "0521234567",
          address: "",
          versions: { phone: 3, address: 0 },
        })
      )
    ).toEqual({ status: 409, code: "stale_version" });
    expect(
      await refused(
        command(member, "profile.contact.update", {
          phone: "03-1234567",
          address: "",
          versions,
        })
      )
    ).toEqual({ status: 422, code: "invalid_input" });
    for (const actor of [manager, technical])
      expect(
        await refused(command(actor, "profile.contact.update", {}))
      ).toEqual({ status: 403, code: "FORBIDDEN" });
    const [contact] = await db
      .select()
      .from(soldierContacts)
      .where(eq(soldierContacts.soldierId, member.soldierId!));
    expect(contact.phone).toBe("0501110000");
    expect(other.soldierId).toBeDefined();
  });
});
