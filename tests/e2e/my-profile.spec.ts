import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import { soldiers, balances, soldierContacts } from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { soldier, testIdNumber } from "../fixtures";
import { signedInHome } from "./auth-submit";

// "My details" (decision 222, #175). Synthetic people only.
const people = {
  manager: {
    key: "610001",
    name: "אחראית פרטים",
    email: "me-manager@example.invalid",
    role: "manager" as const,
  },
  member: {
    key: "610002",
    name: "נועה פרטים",
    email: "me-member@example.invalid",
    role: "soldier" as const,
  },
};
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
  for (const person of Object.values(people)) {
    const id = randomUUID();
    const [firstName, lastName] = person.name.split(" ");
    const data = soldier({
      id,
      name: person.name,
      firstName,
      lastName,
      gender: "female",
    });
    await db.insert(soldiers).values({
      id,
      name: person.name,
      idNumber: testIdNumber(person.key),
      data,
    });
    await db.insert(soldierContacts).values({
      soldierId: id,
      email: person.email,
      phone: "0501234567",
    });
    await db.insert(balances).values({ soldierId: id });
    await createInvitedAccount({
      name: person.name,
      email: person.email,
      role: person.role,
      soldierId: id,
    });
  }
});
async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [account] = await db.select().from(user).where(eq(user.email, email));
  const [code] = (
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, account.id))
  ).filter((row) => row.kind === "login-code");
  await page.getByLabel("קוד כניסה", { exact: true }).fill(
    openSecret(code.encryptedSecret!, {
      purpose: "mail-code",
      recordId: code.id,
    })
  );
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(page.getByRole("heading", { name: signedInHome })).toBeVisible();
}

test("a soldier sees their own number and changes phone and address, and the manager is told", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, people.member.email);
  // On a phone the account link sits under "more".
  await page.getByRole("button", { name: "עוד", exact: true }).click();
  await page.getByRole("link", { name: "הפרטים שלי", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "הפרטים שלי", level: 1 })
  ).toBeVisible();
  const details = page.locator(".detail-list");
  await expect(details).toContainText(String(testIdNumber("610002")));
  await expect(details).toContainText("נקבה");
  await expect(details).toContainText(people.member.email);
  await page.getByLabel("טלפון נייד").fill("abc");
  await page.getByRole("button", { name: "שמירת טלפון וכתובת" }).click();
  // The form's own message; the page may also show a general notice.
  await expect(page.locator("form").getByRole("alert")).toBeVisible();
  await page.getByLabel("טלפון נייד").fill("052-765 4321");
  await page.getByLabel("כתובת (לא חובה)").fill("רחוב הפרטים 4");
  await page.getByRole("button", { name: "שמירת טלפון וכתובת" }).click();
  await expect(page.getByLabel("טלפון נייד")).toHaveValue("0527654321");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.screenshot({ path: "test-results/my-profile-phone.png" });

  const context = await browser.newContext();
  const managerPage = await context.newPage();
  await login(managerPage, people.manager.email);
  await managerPage.goto("/notifications");
  await expect(
    managerPage.getByText("נועה פרטים עדכן/ה בעצמו/ה טלפון וכתובת.")
  ).toBeVisible();
  // The profile shows the new phone and the email to the manager.
  await managerPage.goto("/manage/soldiers");
  await managerPage
    .locator("tr", { hasText: "נועה פרטים" })
    .getByRole("button", { name: "פרופיל ועריכה" })
    .click();
  const profile = managerPage.getByRole("dialog");
  await profile.getByText("ניהול כתובת מייל וחשבון").click();
  await expect(profile.getByText(people.member.email)).toBeVisible();
  await expect(profile.getByLabel("טלפון נייד")).toHaveValue("0527654321");
  // A manager keeps their own details in the soldiers list, not on this screen.
  await managerPage.goto("/me");
  await expect(
    managerPage.getByText("המסך הזה אינו זמין לחשבון שלך")
  ).toBeVisible();
  await context.close();
});
