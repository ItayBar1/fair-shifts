import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import { soldiers, balances, soldierContacts } from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { createImportTemplate } from "../../src/server/import-workbook";
import { soldier } from "../fixtures";

const managerEmail = "restore-manager@example.invalid";
const activeEmail = "restore-active@example.invalid";
const deleterEmail = "restore-deleter@example.invalid";
const deletedEmail = "restore-deleted@example.invalid";

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
  const id = randomUUID();
  const data = soldier({ id, name: "אחראי שחזור", personalNumber: "000301" });
  await db
    .insert(soldiers)
    .values({ id, name: data.name, personalNumber: data.personalNumber, data });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: managerEmail });
  await db.insert(balances).values({ soldierId: id });
  await createInvitedAccount({
    name: data.name,
    email: managerEmail,
    role: "manager",
    soldierId: id,
  });
  // A second manager for the second test: a sign-in code is sent once a minute.
  const second = randomUUID();
  const secondData = soldier({
    id: second,
    name: "אחראי מחיקה בשחזור",
    personalNumber: "000302",
  });
  await db.insert(soldiers).values({
    id: second,
    name: secondData.name,
    personalNumber: secondData.personalNumber,
    data: secondData,
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId: second, email: deleterEmail });
  await db.insert(balances).values({ soldierId: second });
  await createInvitedAccount({
    name: secondData.name,
    email: deleterEmail,
    role: "manager",
    soldierId: second,
  });
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [account] = await db.select().from(user).where(eq(user.email, email));
  const [message] = (
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, account.id))
  ).filter((row) => row.kind === "login-code");
  await page
    .getByLabel("קוד כניסה", { exact: true })
    .fill(openSecret(message.encryptedSecret!));
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}

test("cancels a new soldier without activity and waits for a decision on one who signed in", async ({
  page,
  browser,
}) => {
  await login(page, managerEmail);
  await page.goto("/manage/imports");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(await createImportTemplate()).buffer);
  const sheet = workbook.getWorksheet("חיילים")!;
  sheet.addRow([
    "000311",
    "קליטה ללא פעילות",
    "restore-quiet@example.invalid",
    "0500000311",
    null,
    3,
  ]);
  sheet.addRow(["000312", "קליטה שנכנסה", activeEmail, "0500000312", null, 4]);
  sheet.addRow([
    "000313",
    "קליטה שנמחקה",
    "restore-erased@example.invalid",
    null,
    null,
    0,
  ]);
  await page.getByLabel("קובץ XLSX").setInputFiles({
    name: "new-soldiers.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(new Uint8Array(await workbook.xlsx.writeBuffer())),
  });
  await page
    .getByRole("button", { name: "הצגת תצוגה מקדימה", exact: true })
    .click();
  await page.getByLabel("סיבת הייבוא").fill("קליטה סינתטית לשחזור");
  await page
    .getByLabel("בדקתי את כל השורות ואת ברירות המחדל לקליטה חדשה")
    .check();
  await page
    .getByRole("button", { name: "אישור ושמירת הייבוא", exact: true })
    .click();
  await expect(page.getByText(/הייבוא נשמר בשלמותו/)).toBeVisible();

  // The second soldier signs in once: that is activity (decision 174).
  const soldierContext = await browser.newContext();
  await login(await soldierContext.newPage(), activeEmail);
  await soldierContext.close();
  // The third soldier was erased in the deletion flow (synthetic stand-in).
  await db
    .update(soldiers)
    .set({ deletedAt: new Date() })
    .where(eq(soldiers.personalNumber, "000313"));

  await page
    .getByRole("button", { name: "בדיקת שחזור הייבוא", exact: true })
    .click();
  const creations = page.getByRole("region", { name: "קליטות חדשות באצווה" });
  const quiet = creations.getByRole("row", { name: /קליטה ללא פעילות/ });
  const active = creations.getByRole("row", { name: /קליטה שנכנסה/ });
  await expect(quiet.getByText("הקליטה תבוטל", { exact: true })).toBeVisible();
  await expect(active.getByText("יש פעילות", { exact: true })).toBeVisible();
  await expect(active.getByText("כניסה לחשבון")).toBeVisible();
  await expect(
    creations
      .getByRole("row", { name: /קליטה שנמחקה/ })
      .getByText("נמחק במסלול המחיקה", { exact: true })
  ).toBeVisible();
  await page.getByLabel("סיבת השחזור וההכרעות").fill("קובץ שגוי");
  await page.getByLabel("בדקתי את השדות ואת ההחלטות ומאשר/ת את השחזור").check();
  await page
    .locator(".import-restore")
    .screenshot({ path: "test-results/import-restore-creations.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.screenshot({
    path: "test-results/import-restore-creations-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  // The active row is left for later; the quiet one is cancelled now.
  await page.getByRole("button", { name: "אישור השחזור", exact: true }).click();
  await expect(page.getByText(/השחזור בוצע בחלקו/)).toBeVisible();
  await expect(page.getByText(/הקליטה בוטלה בשחזור/)).toBeVisible();
  await expect(page.getByText(/נמחק במסלול המחיקה; השורה נסגרה/)).toBeVisible();
  const partial = await (await page.request.get("/api/v1/state")).json();
  const numbers = partial.soldiers.map(
    (person: { personalNumber: string }) => person.personalNumber
  );
  expect(numbers).not.toContain("000311");
  expect(numbers).toContain("000312");

  await page
    .getByRole("button", { name: "בדיקת שחזור הייבוא", exact: true })
    .click();
  // Wait for the new check itself; only then is a later change stale.
  const rest = page.getByRole("region", { name: "קליטות חדשות באצווה" });
  await expect(rest.getByRole("row", { name: /קליטה שנכנסה/ })).toBeVisible();
  await expect(rest.getByRole("row", { name: /קליטה ללא פעילות/ })).toHaveCount(
    0
  );
  const keep = async () => {
    await page.getByLabel("החלטה עבור קליטת קליטה שנכנסה").selectOption("keep");
    await page.getByLabel("סיבת השחזור וההכרעות").fill("החייל כבר פעיל");
    await page
      .getByLabel("בדקתי את השדות ואת ההחלטות ומאשר/ת את השחזור")
      .check();
    await page
      .getByRole("button", { name: "אישור השחזור", exact: true })
      .click();
  };
  // A change between the check and the approval makes the check stale.
  const [activePerson] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.personalNumber, "000312"));
  await db
    .update(soldierContacts)
    .set({ phone: "0500000399" })
    .where(eq(soldierContacts.soldierId, activePerson.id));
  await keep();
  await expect(
    page.getByText(/נתונים השתנו מאז תצוגת השחזור/).first()
  ).toBeVisible();
  await page
    .getByRole("button", { name: "בדיקת שחזור הייבוא", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "קליטות חדשות באצווה" })
      .getByText(/עריכה בפרטי הקשר/)
  ).toBeVisible();
  await keep();
  await expect(page.getByText(/שחזור הייבוא הושלם/)).toBeVisible();
  await expect(page.getByText(/החייל נשאר במערכת בהכרעת שחזור/)).toBeVisible();
  const [kept] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.personalNumber, "000312"));
  expect(kept.name).toBe("קליטה שנכנסה");
});

test("deletes the user of a new soldier with activity when the manager decides so", async ({
  page,
  browser,
}) => {
  await login(page, deleterEmail);
  await page.goto("/manage/imports");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(await createImportTemplate()).buffer);
  workbook
    .getWorksheet("חיילים")!
    .addRow([
      "000321",
      "קליטה למחיקה",
      deletedEmail,
      "0500000321",
      "רחוב ייבוא 5",
      2,
    ]);
  await page.getByLabel("קובץ XLSX").setInputFiles({
    name: "to-delete.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(new Uint8Array(await workbook.xlsx.writeBuffer())),
  });
  await page
    .getByRole("button", { name: "הצגת תצוגה מקדימה", exact: true })
    .click();
  await page.getByLabel("סיבת הייבוא").fill("קליטה סינתטית למחיקה");
  await page
    .getByLabel("בדקתי את כל השורות ואת ברירות המחדל לקליטה חדשה")
    .check();
  await page
    .getByRole("button", { name: "אישור ושמירת הייבוא", exact: true })
    .click();
  await expect(page.getByText(/הייבוא נשמר בשלמותו/)).toBeVisible();
  // The soldier signs in once: activity, so the restore cannot simply cancel the intake.
  const soldierContext = await browser.newContext();
  await login(await soldierContext.newPage(), deletedEmail);
  await soldierContext.close();

  await page
    .getByRole("button", { name: "בדיקת שחזור הייבוא", exact: true })
    .click();
  const creations = page.getByRole("region", { name: "קליטות חדשות באצווה" });
  const row = creations.getByRole("row", { name: /קליטה למחיקה/ });
  await expect(row.getByText("יש פעילות", { exact: true })).toBeVisible();
  // Deleting the user is offered next to keeping the soldier, with its impact.
  await page.getByLabel("החלטה עבור קליטת קליטה למחיקה").selectOption("delete");
  await expect(row.getByText(/מחיקה מפנה 0 מקומות עתידיים/)).toBeVisible();
  await page.getByLabel("סיבת השחזור וההכרעות").fill("לא היה אמור להיקלט");
  await page.getByLabel("בדקתי את השדות ואת ההחלטות ומאשר/ת את השחזור").check();
  await page.getByRole("button", { name: "אישור השחזור", exact: true }).click();
  await expect(page.getByText(/שחזור הייבוא הושלם/)).toBeVisible();
  await expect(page.getByText(/המשתמש נמחק בהכרעת שחזור/)).toBeVisible();

  const [deleted] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.personalNumber, "000321"));
  expect(deleted.deletedAt).not.toBeNull();
  expect(deleted.name).toBe("קליטה למחיקה");
  const [contact] = await db
    .select()
    .from(soldierContacts)
    .where(eq(soldierContacts.soldierId, deleted.id));
  expect([contact.email, contact.phone, contact.address]).toEqual([
    null,
    null,
    null,
  ]);
  const [account] = await db
    .select()
    .from(user)
    .where(eq(user.soldierId, deleted.id));
  expect(account.deletedAt).not.toBeNull();
  // The number stays with the history: it is not free for a new intake.
  await page.screenshot({
    path: "test-results/import-restore-deleted.png",
    fullPage: false,
  });
});
