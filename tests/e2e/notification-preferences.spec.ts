import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  soldiers,
  balances,
  soldierContacts,
  records,
} from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

const hoursLabel = "שעות לפני תורנות, מופרדות בפסיק";
const publicationLabel = "מייל: שיבוץ, שינוי או ביטול של תורנות שפורסמה";
const people = [
  ["אחראי העדפות", "prefs-manager@example.invalid", "manager", "000101"],
  ["חייל העדפות", "prefs-soldier@example.invalid", "soldier", "000102"],
] as const;

test.beforeAll(async () => {
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error("E2E requires a dedicated test database");
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  for (const [name, email, role, personalNumber] of people) {
    const id = randomUUID();
    const data = soldier({ id, name, personalNumber });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(soldierContacts).values({ soldierId: id, email });
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
const panel = (page: Page, title: string) =>
  page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
async function fill(form: Locator, hours: string, publication: boolean) {
  await form.getByLabel(hoursLabel).fill(hours);
  await form.getByLabel(publicationLabel).setChecked(publication);
}

test("unit defaults reach soldiers without personal preferences; a saved personal form and inbox states stay personal", async ({
  page,
  browser,
}) => {
  await login(page, "prefs-manager@example.invalid");
  await page.goto("/settings");
  const defaults = panel(page, "ברירות מחדל להודעות ביחידה");
  await expect(defaults.getByLabel(hoursLabel)).toHaveValue("24, 2");
  await fill(defaults, "12", false);
  await defaults.getByRole("button", { name: "שמירת ברירות המחדל" }).click();
  await expect(defaults.getByLabel(hoursLabel)).toHaveValue("12");

  const soldierContext = await browser.newContext();
  const member = await soldierContext.newPage();
  await login(member, "prefs-soldier@example.invalid");
  await member.goto("/settings");
  const own = panel(member, "העדפות הודעות");
  await expect(own.getByText("חלות עליך ברירות המחדל של היחידה")).toBeVisible();
  await expect(own.getByLabel(hoursLabel)).toHaveValue("12");
  await expect(own.getByLabel(publicationLabel)).not.toBeChecked();
  await expect(
    member.getByRole("heading", { name: "ברירות מחדל להודעות ביחידה" })
  ).toHaveCount(0);

  // The form explains a rejected timing in Hebrew and keeps the defaults.
  await own.getByLabel(hoursLabel).fill("0, 2");
  await own.getByRole("button", { name: "שמירת העדפות אישיות" }).click();
  await expect(
    own.getByText("שעות התזכורת הן מספרים שלמים בין 1 ל־168.")
  ).toBeVisible();
  await fill(own, "6, 3", true);
  await own.getByRole("button", { name: "שמירת העדפות אישיות" }).click();
  await expect(own.getByText("שמרת העדפות אישיות")).toBeVisible();

  await page.reload();
  await fill(defaults, "8", false);
  await defaults.getByRole("button", { name: "שמירת ברירות המחדל" }).click();
  await expect(defaults.getByLabel(hoursLabel)).toHaveValue("8");
  await member.reload();
  await expect(own.getByLabel(hoursLabel)).toHaveValue("6, 3");
  await expect(own.getByLabel(publicationLabel)).toBeChecked();

  await own
    .getByRole("button", { name: "חזרה לברירות המחדל של היחידה" })
    .click();
  await expect(own.getByText("חלות עליך ברירות המחדל של היחידה")).toBeVisible();
  await expect(own.getByLabel(hoursLabel)).toHaveValue("8");

  // Reading and hiding change only the recipient's inbox and unread count.
  const [account] = await db
    .select()
    .from(user)
    .where(eq(user.email, "prefs-soldier@example.invalid"));
  await db.insert(records).values({
    id: randomUUID(),
    kind: "notification",
    subjectId: account.soldierId,
    data: {
      accountId: account.id,
      title: "הודעה סינתטית לבדיקה",
      body: "תוכן סינתטי",
      href: "/calendar",
    },
  });
  await member.goto("/notifications");
  const navLink = member.getByRole("link", { name: /הודעות/ }).first();
  await expect(navLink.locator(".nav-count")).toHaveText("1");
  await member.getByRole("button", { name: "סימון כנקראה" }).click();
  await expect(
    member.getByRole("button", { name: "סימון כנקראה" })
  ).toHaveCount(0);
  await expect(navLink.locator(".nav-count")).toHaveCount(0);
  await member.getByRole("button", { name: "הסתרה", exact: true }).click();
  await expect(member.getByText("אין הודעות להצגה")).toBeVisible();

  // The settings screen fits a phone without horizontal scrolling.
  await member.setViewportSize({ width: 375, height: 812 });
  await member.goto("/settings");
  await expect(own.getByLabel(hoursLabel)).toBeVisible();
  expect(
    await member.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await soldierContext.close();
});
