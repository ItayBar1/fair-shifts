import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { user } from "../../src/server/auth-schema";
import { soldiers, soldierContacts, balances } from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { parseImportWorkbook } from "../../src/server/import-workbook";
import { populationAt } from "../../src/domain/eligibility";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

let manager: Actor;
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name: "אחראי staging",
    personalNumber: "0000001",
    data: soldier({ id, name: "אחראי staging", personalNumber: "0000001" }),
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: "staging-manager@example.invalid" });
  await db.insert(balances).values({ soldierId: id });
  const account = await createInvitedAccount({
    name: "אחראי staging",
    role: "manager",
    email: "staging-manager@example.invalid",
    soldierId: id,
  });
  manager = {
    id: account.id,
    name: account.name,
    role: "manager",
    soldierId: id,
    securityEpoch: 1,
  };
});
afterAll(async () => pool.end());

const command = async (
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) =>
  (await executeAction(manager, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as Record<string, unknown> & {
    id: string;
    version: number;
    rows: { mode: string }[];
  };

describe("synthetic soldiers for staging (card #25)", () => {
  it("writes a workbook that the import accepts whole, with the three populations", async () => {
    const folder = await mkdtemp(join(tmpdir(), "staging-soldiers-"));
    const out = join(folder, "soldiers.xlsx");
    try {
      const { stdout } = await promisify(execFile)(
        "node_modules/.bin/tsx",
        [
          "scripts/staging-soldiers.ts",
          "--out",
          out,
          "--extra",
          "tester@example.invalid|חייל בדיקה",
        ],
        { env: process.env }
      );
      expect(stdout).toMatch(/^Wrote 21 synthetic soldiers/);
      const rows = await parseImportWorkbook(await readFile(out));
      expect(rows).toHaveLength(21);
      expect(
        rows.every((row) => row.values.email?.endsWith("@example.invalid"))
      ).toBe(true);

      const preview = await command("import.preview", {
        filename: "staging-soldiers.xlsx",
        rows,
      });
      expect(preview.problems ?? []).toEqual([]);
      expect(preview.rows.every((row) => row.mode === "create")).toBe(true);
      await command(
        "import.apply",
        {
          id: preview.id,
          confirmed: true,
          reason: "נתונים סינתטיים ל־staging",
        },
        preview.version
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }

    const people = await db.select().from(soldiers);
    expect(people).toHaveLength(22);
    const now = new Date().toISOString();
    const count = (population: string) =>
      people.filter(
        (person) =>
          person.personalNumber.startsWith("9") &&
          populationAt(person.data, now) === population
      ).length;
    expect([count("mandatory"), count("career"), count("academic")]).toEqual([
      13, 5, 3,
    ]);
    const [tester] = await db
      .select()
      .from(user)
      .where(eq(user.email, "tester@example.invalid"));
    expect(tester).toMatchObject({ role: "soldier" });
  });
});
