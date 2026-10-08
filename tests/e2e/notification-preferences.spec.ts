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
import { signedInHome } from "./auth-submit";

const hoursLabel = (row: number) => `תזכורת ${row}: שעות לפני תורנות`;
const siteSlot = (row: number) => `תזכורת ${row}: באתר`;
const emailSlot = (row: number) => `תזכורת ${row}: במייל`;
const calendarSlot = (row: number) => `תזכורת ${row}: ביומן Google`;
const publicationLabel = "מייל: שיבוץ, שינוי או ביטול של תורנות שפורסמה";
const departureLabel = "מייל: סיום שירות של חייל (לאחראים)";
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
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
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
  await page.getByLabel("קוד כניסה", { exact: true }).fill(
    openSecret(message.encryptedSecret!, {
      purpose: "mail-code",
      recordId: message.id,
    })
  );
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(page.getByRole("heading", { name: signedInHome })).toBeVisible();
}
const panel = (page: Page, title: string) =>
  page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
/** Fills the three reminder rows; a row without hours is left empty. */
async function fill(form: Locator, hours: number[], publication: boolean) {
  for (const row of [1, 2, 3])
    await form
      .getByLabel(hoursLabel(row))
      .fill(hours[row - 1] === undefined ? "" : String(hours[row - 1]));
  await form.getByLabel(publicationLabel).setChecked(publication);
}
async function expectHours(form: Locator, hours: number[]) {
  for (const row of [1, 2, 3])
    await expect(form.getByLabel(hoursLabel(row))).toHaveValue(
      hours[row - 1] === undefined ? "" : String(hours[row - 1])
    );
}

test("unit defaults reach soldiers without personal preferences; a saved personal form and inbox states stay personal", async ({
  page,
  browser,
}) => {
  await login(page, "prefs-manager@example.invalid");
  await page.goto("/settings");
  // A duty manager takes no part in duties, so has no calendar of their own (decision 192).
  await expect(
    page.getByRole("heading", { name: "יומן Google", exact: true })
  ).toHaveCount(0);
  const defaults = panel(page, "ברירות מחדל להודעות ביחידה");
  await expectHours(defaults, [24, 2]);
  // Each reminder has a site slot that is always marked and locked, and email and calendar slots (decision 195).
  for (const row of [1, 2]) {
    await expect(defaults.getByLabel(siteSlot(row))).toBeChecked();
    await expect(defaults.getByLabel(siteSlot(row))).toBeDisabled();
    await expect(defaults.getByLabel(emailSlot(row))).toBeChecked();
    await expect(defaults.getByLabel(calendarSlot(row))).toBeChecked();
  }
  await fill(defaults, [12], false);
  await defaults.getByRole("button", { name: "שמירת ברירות המחדל" }).click();
  await expectHours(defaults, [12]);

  const soldierContext = await browser.newContext();
  const member = await soldierContext.newPage();
  await login(member, "prefs-soldier@example.invalid");
  await member.goto("/settings");
  const own = panel(member, "העדפות הודעות");
  await expect(own.getByText("חלות עליך ברירות המחדל של היחידה")).toBeVisible();
  await expectHours(own, [12]);
  await expect(own.getByLabel(publicationLabel)).not.toBeChecked();
  await expect(
    member.getByRole("heading", { name: "ברירות מחדל להודעות ביחידה" })
  ).toHaveCount(0);
  // The departure email reaches managers only, so a soldier's form omits it.
  await expect(own.getByLabel(departureLabel)).toHaveCount(0);
  await expect(defaults.getByLabel(departureLabel)).toBeChecked();

  // The form explains a rejected timing in Hebrew and keeps the defaults.
  await fill(own, [0, 2], true);
  await own.getByRole("button", { name: "שמירת העדפות אישיות" }).click();
  await expect(
    own.getByText("שעות התזכורת הן מספרים שלמים בין 1 ל־168.")
  ).toBeVisible();
  await fill(own, [3, 3], true);
  await own.getByRole("button", { name: "שמירת העדפות אישיות" }).click();
  await expect(own.getByText("אין לחזור על אותה שעת תזכורת.")).toBeVisible();
  // Each reminder keeps its own channels: the first goes to the calendar only, the second to mail only.
  await fill(own, [6, 3], true);
  await own.getByLabel(emailSlot(1)).setChecked(false);
  await own.getByLabel(calendarSlot(2)).setChecked(false);
  await own.getByRole("button", { name: "שמירת העדפות אישיות" }).click();
  await expect(own.getByText("שמרת העדפות אישיות")).toBeVisible();

  await page.reload();
  await fill(defaults, [8], false);
  await defaults.getByRole("button", { name: "שמירת ברירות המחדל" }).click();
  await expectHours(defaults, [8]);
  await member.reload();
  await expectHours(own, [6, 3]);
  await expect(own.getByLabel(emailSlot(1))).not.toBeChecked();
  await expect(own.getByLabel(calendarSlot(1))).toBeChecked();
  await expect(own.getByLabel(emailSlot(2))).toBeChecked();
  await expect(own.getByLabel(calendarSlot(2))).not.toBeChecked();
  await expect(own.getByLabel(publicationLabel)).toBeChecked();

  await own
    .getByRole("button", { name: "חזרה לברירות המחדל של היחידה" })
    .click();
  await expect(own.getByText("חלות עליך ברירות המחדל של היחידה")).toBeVisible();
  await expectHours(own, [8]);

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
  await expect(own.getByLabel(hoursLabel(1))).toBeVisible();
  expect(
    await member.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await soldierContext.close();
});
