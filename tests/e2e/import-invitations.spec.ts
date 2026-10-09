import { test, expect } from "@playwright/test";
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
import { signedInHome } from "./auth-submit";

const email = "publish-manager@example.invalid";
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
  const data = soldier({ id, name: "אחראי פרסום", personalNumber: "000401" });
  await db
    .insert(soldiers)
    .values({ id, name: data.name, personalNumber: data.personalNumber, data });
  await db.insert(soldierContacts).values({ soldierId: id, email });
  await db.insert(balances).values({ soldierId: id });
  await createInvitedAccount({
    name: data.name,
    email,
    role: "manager",
    soldierId: id,
  });
});

test("imports without mail and explicitly publishes invitations after reopening the batch", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [account] = await db.select().from(user).where(eq(user.email, email));
  const [code] = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.recipientAccountId, account.id));
  await page.getByLabel("קוד כניסה", { exact: true }).fill(
    openSecret(code.encryptedSecret!, {
      purpose: "mail-code",
      recordId: code.id,
    })
  );
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(page.getByRole("heading", { name: signedInHome })).toBeVisible();
  await page.goto("/manage/imports");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(await createImportTemplate()).buffer);
  workbook
    .getWorksheet("חיילים")!
    .addRow([
      "000402",
      "חייל לפני פרסום",
      "publish-soldier@example.invalid",
      null,
      null,
      0,
    ]);
  await page.getByLabel("קובץ XLSX").setInputFiles({
    name: "deferred.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(new Uint8Array(await workbook.xlsx.writeBuffer())),
  });
  await page
    .getByRole("button", { name: "הצגת תצוגה מקדימה", exact: true })
    .click();
  await page.getByLabel("סיבת הייבוא").fill("קליטה לפני הזמנה");
  await page
    .getByLabel("בדקתי את כל השורות ואת ברירות המחדל לקליטה חדשה")
    .check();
  await page
    .getByRole("button", { name: "אישור ושמירת הייבוא", exact: true })
    .click();
  await expect(page.getByText(/הייבוא נשמר בשלמותו/)).toBeVisible();
  expect(
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, "invitation"))
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(user)
      .where(eq(user.email, "publish-soldier@example.invalid"))
  ).toHaveLength(1);

  await page.reload();
  await page.getByRole("button", { name: "הצגת האצווה", exact: true }).click();
  const publish = page.getByRole("button", {
    name: "פרסום הזמנות",
    exact: true,
  });
  await expect(publish).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText(/החיילים נקלטו ויכולים להתחבר/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page
    .getByLabel("אני מאשר/ת לשלוח הזמנות לחיילים החדשים באצווה")
    .check();
  await expect(publish).toBeEnabled();
  await page.screenshot({
    path: "test-results/import-invitations-mobile.png",
    fullPage: true,
  });
  await publish.click();
  await expect(
    page.getByText(/ההזמנות פורסמו: 1 נוספו לתור המיילים, 0 דולגו/)
  ).toBeVisible();
  expect(
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, "invitation"))
  ).toHaveLength(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.getByRole("button", { name: "הצגת האצווה", exact: true }).click();
  await expect(
    page.getByText(/ההזמנות פורסמו: 1 נוספו לתור המיילים, 0 דולגו/)
  ).toBeVisible();
  await expect(publish).toHaveCount(0);
});
