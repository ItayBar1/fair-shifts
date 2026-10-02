import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool } from "../../src/server/db";
import { emailOutbox } from "../../src/server/auth-schema";
import {
  assignmentMailEvent,
  assignmentMailWindow,
  assignments,
  balances,
  duties,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { announceAssignment } from "../../src/server/assignment-mail";
import { soldier } from "../fixtures";

// The second announcement of a publish fails, as a database fault in the middle of a batch would.
vi.mock("../../src/server/assignment-mail", async (original) => {
  const actual =
    await original<typeof import("../../src/server/assignment-mail")>();
  return { ...actual, announceAssignment: vi.fn(actual.announceAssignment) };
});

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

let manager: Actor;

async function invite(name: string, role: "soldier" | "manager", n: number) {
  const id = randomUUID();
  const personalNumber = String(n).padStart(5, "0");
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber,
    data: soldier({ id, name, personalNumber }),
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: `${personalNumber}@example.invalid` });
  await db.insert(balances).values({ soldierId: id, current: 100 });
  const row = await createInvitedAccount({
    name,
    role,
    email: `${personalNumber}@example.invalid`,
    soldierId: id,
  });
  return { id: row.id, name, role, soldierId: id, securityEpoch: 1 } as Actor;
}
async function command(
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) {
  return (await executeAction(manager, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  vi.mocked(announceAssignment).mockClear();
  manager = await invite("אחראי", "manager", 10);
});
afterAll(async () => pool.end());

describe("publishing several drafts at once is all or nothing", () => {
  it("leaves every draft a draft, and sends and records nothing, when one publish fails midway", async () => {
    const soldiers = [
      await invite("אביב", "soldier", 11),
      await invite("בר", "soldier", 12),
    ];
    const type = await command("dutyType.save", {
      name: "שמירה",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 1 }],
    });
    const ids: string[] = [];
    for (const [index, person] of soldiers.entries()) {
      const start = DateTime.now()
        .setZone("Asia/Jerusalem")
        .startOf("day")
        .plus({ days: 5 + index, hours: 8 });
      const created = await command("duty.create", {
        typeId: type.id,
        name: `תורנות ${index}`,
        start: start.toISO()!,
        end: start.plus({ hours: 8 }).toISO()!,
      });
      const [row] = await db
        .select()
        .from(duties)
        .where(eq(duties.id, created.id));
      await command(
        "duty.assign",
        {
          dutyId: row.id,
          slotId: row.data.slots[0].id,
          soldierId: person.soldierId,
        },
        row.version
      );
      ids.push(row.id);
    }
    const preview = await command("duty.publish.preview", { dutyIds: ids });
    expect(preview.ready).toBe(2);

    let calls = 0;
    const real = vi.mocked(announceAssignment).getMockImplementation()!;
    vi.mocked(announceAssignment).mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error("synthetic fault");
      return real(...args);
    });
    await expect(
      command("duty.publish.batch", {
        dutyIds: ids,
        token: preview.token,
        confirmed: true,
      })
    ).rejects.toThrow("synthetic fault");
    expect(calls).toBe(2);

    const after = await db.select().from(duties);
    expect(after.map((row) => row.data.status)).toEqual(["draft", "draft"]);
    expect(await db.select().from(emailOutbox)).toEqual([]);
    // No window, no event: the announcement of the first duty went with the rest.
    expect(await db.select().from(assignmentMailWindow)).toEqual([]);
    expect(await db.select().from(assignmentMailEvent)).toEqual([]);
    expect(
      (await db.select().from(records)).filter(
        (row) =>
          row.kind === "notification" ||
          (row.kind === "audit" &&
            String(row.data.action).startsWith("duty.publish"))
      )
    ).toEqual([]);
    expect(
      (await db.select().from(assignments)).every(
        (row) => row.status === "reserved"
      )
    ).toBe(true);

    // The same approval works once the fault is gone: nothing was spent by the failed try.
    vi.mocked(announceAssignment).mockImplementation(real);
    const result = await command("duty.publish.batch", {
      dutyIds: ids,
      token: preview.token,
      confirmed: true,
    });
    expect(result.published).toHaveLength(2);
    // One window and one mail for each of the two soldiers.
    expect(await db.select().from(emailOutbox)).toHaveLength(2);
    expect(await db.select().from(assignmentMailEvent)).toHaveLength(2);
  });
});
