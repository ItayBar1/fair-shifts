import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import { soldiers, balances } from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

const managerEmail = "restore-manager@example.invalid";
const soldierEmail = "restore-soldier@example.invalid";
test.beforeAll(async () => {
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error("E2E requires a dedicated test database");
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  for (const [name, personalNumber, email, role] of [
    ["אחראי שחזור", "540001", managerEmail, "manager"],
    ["חייל קבע משוחזר", "540002", soldierEmail, "soldier"],
  ] as const) {
    const id = randomUUID();
    const data = soldier({ id, name, personalNumber });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(balances).values({ soldierId: id });
    await createInvitedAccount({ name, email, role, soldierId: id });
  }
});
// The pool is shared by every spec in the worker; the worker exit closes it.
async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [person] = await db.select().from(user).where(eq(user.email, email));
  const [message] = (
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, person.id))
  )
    .filter((row) => row.kind === "login-code")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  await page.getByLabel("קוד כניסה", { exact: true }).fill(
    openSecret(message.encryptedSecret!, {
      purpose: "mail-code",
      recordId: message.id,
    })
  );
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}

test("a restore that moves the population shows its assignments per the chosen decision and flags them after confirmation", async ({
  page,
  browser,
}) => {
  await login(page, managerEmail);
  const api = async (
    type: string,
    payload: Record<string, unknown>,
    expectedVersion?: number,
    on = page
  ) => {
    const response = await on.request.post("/api/v1/actions", {
      headers: { origin: "http://127.0.0.1:3000" },
      data: { type, payload, expectedVersion, idempotencyKey: randomUUID() },
    });
    return response;
  };
  const ok = async (...args: Parameters<typeof api>) => {
    const response = await api(...args);
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).result as Record<string, unknown> & {
      id: string;
      version: number;
    };
  };
  const [person] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.personalNumber, "540002"));
  const zone = "Asia/Jerusalem";
  const day = (days: number) =>
    DateTime.now().setZone(zone).plus({ days }).startOf("day");
  const imported = day(10);
  const edited = day(12);
  const careerDay = day(15);

  // The import sets a permanent-service date; later the soldier is assigned
  // to a career-only duty, and the date is edited again.
  const preview = await ok("import.preview", {
    filename: "career.xlsx",
    rows: [
      {
        rowNumber: 2,
        values: {
          personalNumber: "540002",
          permanentDate: imported.toISODate(),
        },
      },
    ],
  });
  await ok(
    "import.apply",
    {
      id: preview.id,
      confirmed: true,
      overwriteConfirmed: true,
      populationImpactConfirmed: true,
      reason: "ייבוא תאריך קבע סינתטי",
    },
    1
  );
  const type = await ok("dutyType.save", {
    name: "שמירה לקבע בלבד",
    populations: ["career"],
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 1 }],
  });
  const duty = await ok("duty.create", {
    typeId: type.id,
    name: "תורנות קבע אחרי הייבוא",
    start: careerDay.set({ hour: 8 }).toISO(),
    end: careerDay.set({ hour: 16 }).toISO(),
    location: "אתר שחזור",
  });
  const state = await (await page.request.get("/api/v1/state")).json();
  const row = state.duties.find((item: { id: string }) => item.id === duty.id);
  await ok(
    "duty.assign",
    { dutyId: duty.id, slotId: row.slots[0].id, soldierId: person.id },
    1
  );
  const [current] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, person.id));
  await db
    .update(soldiers)
    .set({
      data: {
        ...current.data,
        service: {
          ...current.data.service,
          permanentFrom: edited.toISODate()!,
        },
      },
    })
    .where(eq(soldiers.id, person.id));

  await page.goto("/manage/imports");
  await page
    .getByRole("button", { name: "הצגת האצווה", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "בדיקת שחזור הייבוא", exact: true })
    .click();
  await expect(page.getByText("השתנה מאז", { exact: true })).toBeVisible();
  const region = page.getByRole("region", {
    name: "מעבר אוכלוסייה בשחזור — חייל קבע משוחזר",
  });
  // Undecided, the conflict keeps the current date: nothing moves yet.
  await expect(region).toHaveCount(0);
  await page
    .getByLabel("החלטה עבור חייל קבע משוחזר — תחילת קבע", { exact: true })
    .selectOption("restore");
  await expect(page.getByText(/ההכרעות בשדות הפרופיל השתנו/)).toBeVisible();
  await page.getByLabel("סיבת השחזור וההכרעות").fill("ביטול תאריך הקבע");
  await page.getByLabel("בדקתי את השדות ואת ההחלטות ומאשר/ת את השחזור").check();
  const save = page.getByRole("button", {
    name: "אישור השחזור",
    exact: true,
  });
  await expect(save).toBeDisabled();
  await page
    .getByRole("button", { name: "חישוב השפעה לפי ההכרעות", exact: true })
    .click();
  await expect(region).toContainText("תורנות קבע אחרי הייבוא");
  await expect(region).toContainText("דורש טיפול");
  await expect(region).toContainText("קבע / קצינים");
  await page.getByLabel("בדקתי את השדות ואת ההחלטות ומאשר/ת את השחזור").check();
  await expect(save).toBeDisabled();
  await page
    .getByLabel(/בדקתי את מעברי האוכלוסייה ואת השיבוצים שיסומנו/)
    .check();
  await page
    .locator(".import-restore")
    .screenshot({ path: "test-results/import-restore-population.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.screenshot({
    path: "test-results/import-restore-population-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  // Nothing is saved before the confirmation.
  const [before] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, person.id));
  expect(before.data.service.permanentFrom).toBe(edited.toISODate());
  await save.click();
  await expect(page.getByText(/שחזור הייבוא הושלם/)).toBeVisible();
  const [after] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, person.id));
  expect(after.data.service.permanentFrom).toBeUndefined();
  await page.goto(`/duties/${duty.id}`);
  await expect(
    page.locator(".badge", { hasText: "דורשת טיפול" })
  ).toBeVisible();

  // A soldier cannot preview a restore or see another soldier's history.
  const context = await browser.newContext();
  const member = await context.newPage();
  await login(member, soldierEmail);
  const forbidden = await api(
    "import.restore.preview",
    { id: preview.id },
    3,
    member
  );
  expect(forbidden.status()).toBe(403);
  const visible = JSON.stringify(
    await (await member.request.get("/api/v1/state")).json()
  );
  for (const hidden of ["populationHistory", "540001", "career.xlsx"])
    expect(visible).not.toContain(hidden);
  await context.close();
});
