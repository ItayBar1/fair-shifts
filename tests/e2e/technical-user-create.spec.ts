import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox, loginCode } from "../../src/server/auth-schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";

const technicalEmail = "technical-intake-114@example.invalid";
const newEmail = "new-manager-114@example.invalid";
const accountOf = async (email: string) =>
  (await db.select().from(user).where(eq(user.email, email)))[0];
test.beforeEach(async () => {
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error("E2E requires a dedicated test database");
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  await createInvitedAccount({
    name: "טכני לקליטת משתמש",
    email: technicalEmail,
    role: "technical",
  });
});
async function login(page: Page, email: string, home: string) {
  const account = await accountOf(email);
  await db
    .update(loginCode)
    .set({ sentAt: new Date(Date.now() - 120000) })
    .where(eq(loginCode.userId, account.id));
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const messages = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.recipientAccountId, account.id));
  const code = messages
    .filter((row) => row.kind === "login-code")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  await page.getByLabel("קוד כניסה", { exact: true }).fill(
    openSecret(code.encryptedSecret!, {
      purpose: "mail-code",
      recordId: code.id,
    })
  );
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: home, exact: true })
  ).toBeVisible();
}

for (const width of [1280, 390]) {
  test(`technical intake without managers, validation, keyboard and promotion on ${width}px`, async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page, technicalEmail, "תמונת מצב");
    await page.goto("/technical/permissions");
    const trigger = page.getByRole("button", {
      name: "הוספת משתמש",
      exact: true,
    });
    await trigger.click();
    let dialog = page.getByRole("dialog", { name: "הוספת משתמש" });
    await expect(
      dialog.getByRole("button", { name: "סגירה", exact: true })
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByLabel("שם מלא", { exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    dialog = page.getByRole("dialog", { name: "הוספת משתמש" });
    await expect(dialog.locator("input")).toHaveCount(3);
    await dialog.getByLabel("שם מלא", { exact: true }).fill("אחראי חדש מהטכני");
    await dialog.getByLabel("מספר אישי", { exact: true }).fill("invalid");
    await dialog.getByLabel("מייל מאושר", { exact: true }).fill(newEmail);
    const submit = dialog.getByRole("button", { name: "יצירת משתמש מוזמן" });
    await submit.click();
    await expect(dialog.getByRole("alert")).toContainText("יש לבדוק את השדות");
    await dialog.getByLabel("מספר אישי", { exact: true }).fill("00000114");
    await submit.click();
    await expect(dialog).toHaveCount(0);
    const row = page
      .locator(".task-item")
      .filter({ has: page.getByText("אחראי חדש מהטכני", { exact: true }) });
    await expect(row.getByText("חייל", { exact: true })).toBeVisible();
    await trigger.click();
    dialog = page.getByRole("dialog", { name: "הוספת משתמש" });
    await dialog.getByLabel("שם מלא", { exact: true }).fill("כפילות לבדיקה");
    await dialog.getByLabel("מספר אישי", { exact: true }).fill("00000114");
    await dialog
      .getByLabel("מייל מאושר", { exact: true })
      .fill("duplicate-114@example.invalid");
    await dialog.getByRole("button", { name: "יצירת משתמש מוזמן" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "המספר האישי כבר רשום"
    );
    await page.keyboard.press("Escape");

    const context = await browser.newContext();
    const fresh = await context.newPage();
    await login(fresh, newEmail, "לוח התורנויות");
    const forbidden = () =>
      fresh.request.post("/api/v1/actions", {
        headers: { origin: "http://127.0.0.1:3000" },
        data: {
          type: "technical.user.create",
          payload: {},
          idempotencyKey: randomUUID(),
        },
      });
    expect((await forbidden()).status()).toBe(403);
    await row.getByRole("button", { name: "הענקת הרשאת אחראי" }).click();
    await expect(
      row.getByText("אחראי תורנויות", { exact: true })
    ).toBeVisible();
    await fresh.reload();
    await expect(fresh).toHaveURL(/\/login$/);
    await login(fresh, newEmail, "לוח התורנויות");
    expect((await forbidden()).status()).toBe(403);
    await fresh.goto("/manage/soldiers");
    await fresh
      .getByRole("button", { name: "הוספת חייל", exact: true })
      .click();
    const intake = fresh.getByRole("dialog", { name: "הוספת חייל" });
    await intake
      .getByLabel("שם מלא", { exact: true })
      .fill("חייל מהאחראי החדש");
    await intake.getByLabel("מספר אישי", { exact: true }).fill("00000115");
    await intake
      .getByLabel("מייל מאושר להזמנה", { exact: true })
      .fill("managed-114@example.invalid");
    await intake
      .getByLabel("אוכלוסיית שיבוץ", { exact: true })
      .selectOption("mandatory");
    await intake
      .getByLabel("סוג שירות", { exact: true })
      .selectOption("mandatory");
    await intake.getByRole("button", { name: "שמירה", exact: true }).click();
    await expect(intake).toHaveCount(0);
    await expect(
      fresh.getByText("חייל מהאחראי החדש", { exact: true })
    ).toBeVisible();
    await context.close();
    await page.screenshot({
      path: `test-results/technical-user-create-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
  });
}
