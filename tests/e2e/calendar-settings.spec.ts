import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { account, emailOutbox, user } from "../../src/server/auth-schema";
import {
  balances,
  calendarLink,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret, sealSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

/**
 * The calendar switch of the settings screen in its four states (decision 195). Google
 * itself is never reached: the permission is seeded as the sync would hold it, and the
 * button that goes to Google is answered by the test.
 */
const people = [
  ["חייל בכניסה בקוד", "calendar-code@example.invalid", "000701"],
  ["חייל בלי הרשאה", "calendar-needs@example.invalid", "000702"],
  ["חייל עם יומן", "calendar-on@example.invalid", "000703"],
] as const;
const ids: Record<string, string> = {};
const contexts: Record<string, BrowserContext> = {};
const pages: Record<string, Page> = {};

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [row] = await db.select().from(user).where(eq(user.email, email));
  const [message] = (
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, row.id))
  ).filter((item) => item.kind === "login-code");
  await page
    .getByLabel("קוד כניסה", { exact: true })
    .fill(openSecret(message.encryptedSecret!));
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error("E2E requires a dedicated test database");
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  for (const [name, email, personalNumber] of people) {
    const id = randomUUID();
    await db.insert(soldiers).values({
      id,
      name,
      personalNumber,
      data: soldier({ id, name, personalNumber }),
    });
    await db.insert(soldierContacts).values({ soldierId: id, email });
    await db.insert(balances).values({ soldierId: id });
    const row = await createInvitedAccount({
      name,
      email,
      role: "soldier",
      soldierId: id,
    });
    ids[email] = row.id;
  }
  // Linked to Google without the permission, and linked with it.
  for (const email of [people[1][1], people[2][1]])
    await db.insert(account).values({
      id: randomUUID(),
      userId: ids[email],
      accountId: `sub-${ids[email]}`,
      providerId: "google",
      proofEpoch: 1,
      googleLinkGeneration: 1,
      needsEmailVerification: false,
    });
  await db.insert(calendarLink).values({
    accountId: ids[people[2][1]],
    refreshToken: sealSecret("synthetic-refresh-token"),
    state: "active",
    enabled: true,
  });
  // One sign-in for each person, before any test: sign-ins are rate limited.
  for (const [, email] of people) {
    contexts[email] = await browser.newContext();
    pages[email] = await contexts[email].newPage();
    await signIn(pages[email], email);
  }
});
test.afterAll(async () => {
  for (const context of Object.values(contexts)) await context.close();
});

const panel = (page: Page) =>
  page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "יומן Google", exact: true }),
  });
const linkOf = async (email: string) =>
  (
    await db
      .select()
      .from(calendarLink)
      .where(eq(calendarLink.accountId, ids[email]))
  )[0];

test("a person who signed in with a code only sees the switch blocked, with the reason", async () => {
  const page = pages[people[0][1]];
  await page.goto("/settings");
  const calendar = panel(page);
  await expect(
    calendar.getByLabel("הוספת תורנויות ליומן Google")
  ).toBeDisabled();
  await expect(
    calendar.getByLabel("הוספת תורנויות ליומן Google")
  ).not.toBeChecked();
  await expect(
    calendar.getByText("כדי להוסיף את התורנויות ליומן Google יש להיכנס לאתר עם")
  ).toBeVisible();
  await expect(
    calendar.getByRole("button", { name: "אישור הרשאה ליומן" })
  ).toHaveCount(0);
  // The calendar slot of each reminder is offered next to the email slot.
  await expect(page.getByLabel("תזכורת 1: ביומן Google").first()).toBeChecked();
});

test("a person who did not grant the permission sees a button that goes to Google and asks for the consent again", async () => {
  const page = pages[people[1][1]];
  await page.goto("/settings");
  const calendar = panel(page);
  await expect(
    calendar.getByLabel("הוספת תורנויות ליומן Google")
  ).toBeDisabled();
  await expect(calendar.getByText("עדיין אינו מורשה")).toBeVisible();

  let body: Record<string, unknown> | undefined;
  await page.route("**/api/auth/sign-in/social", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({
      json: { url: "https://accounts.example.invalid/consent" },
    });
  });
  await page.route("https://accounts.example.invalid/**", (route) =>
    route.fulfill({ body: "<title>Google</title>", contentType: "text/html" })
  );
  await calendar.getByRole("button", { name: "אישור הרשאה ליומן" }).click();
  await expect(page).toHaveURL(/accounts\.example\.invalid\/consent/);
  expect(body).toMatchObject({
    provider: "google",
    callbackURL: "/settings",
    additionalParams: { prompt: "consent" },
  });
  // Nothing was granted here: the permission is only ever given at Google.
  expect(await linkOf(people[1][1])).toBeUndefined();
});

test("a person with the permission turns the sync off and on, and asks to remove the future duties only while it is off", async () => {
  const email = people[2][1];
  const page = pages[email];
  await page.goto("/settings");
  const calendar = panel(page);
  const toggle = calendar.getByLabel("הוספת תורנויות ליומן Google");
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(
    calendar.getByRole("button", { name: "הסרת התורנויות העתידיות מהיומן" })
  ).toHaveCount(0);

  // The switch follows the server, so its state changes after the answer: click, then wait.
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await toggle.press("Space");
  await expect(toggle).not.toBeChecked();
  await expect(calendar.getByText("הסנכרון כבוי")).toBeVisible();
  await expect.poll(async () => (await linkOf(email)).enabled).toBe(false);

  await calendar
    .getByRole("button", { name: "הסרת התורנויות העתידיות מהיומן" })
    .click();
  await expect(
    calendar.getByText("התורנויות העתידיות יוסרו מהיומן בדקות הקרובות")
  ).toBeVisible();
  await expect
    .poll(async () => (await linkOf(email)).removeRequestedAt)
    .not.toBeNull();

  // The state is the server's: it survives a reload.
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await expect(
    calendar.getByText("התורנויות העתידיות יוסרו מהיומן בדקות הקרובות")
  ).toBeVisible();

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(async () => (await linkOf(email)).enabled).toBe(true);
  // Switching on again drops the request that was not done.
  expect((await linkOf(email)).removeRequestedAt).toBeNull();
  // The sync keeps no token in plain form.
  expect((await linkOf(email)).refreshToken).not.toContain(
    "synthetic-refresh-token"
  );

  // Saving and resetting the whole reminder form never changes the personal sync switch.
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  const preferences = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "העדפות הודעות", exact: true }),
  });
  await preferences.getByLabel("תזכורת 1: שעות לפני תורנות").fill("12");
  await preferences.getByLabel("תזכורת 1: במייל").uncheck();
  await preferences.getByLabel("תזכורת 1: ביומן Google").uncheck();
  await preferences
    .getByRole("button", { name: "שמירת העדפות אישיות" })
    .click();
  await expect(preferences.getByText("שמרת העדפות אישיות")).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await preferences
    .getByRole("button", { name: "חזרה לברירות המחדל של היחידה" })
    .click();
  await expect(
    preferences.getByText("חלות עליך ברירות המחדל של היחידה")
  ).toBeVisible();
  await expect(
    preferences.getByLabel("תזכורת 1: שעות לפני תורנות")
  ).toHaveValue("24");
  await expect(toggle).not.toBeChecked();
  expect((await linkOf(email)).enabled).toBe(false);
});

test("a legacy mail-off reminder form keeps every email slot off after saving the current form", async () => {
  const email = people[0][1];
  const page = pages[email];
  await db.insert(records).values({
    id: randomUUID(),
    kind: "settings",
    data: {
      accountId: ids[email],
      custom: true,
      reminderHours: [24, 2],
      email: {
        dutyReminder: false,
        roundOpening: true,
        roundClosing: true,
        publication: true,
        transfer: true,
        departure: true,
      },
    },
  });
  await page.goto("/settings");
  const preferences = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "העדפות הודעות", exact: true }),
  });
  for (const row of [1, 2]) {
    await expect(
      preferences.getByLabel(`תזכורת ${row}: במייל`)
    ).not.toBeChecked();
    await expect(
      preferences.getByLabel(`תזכורת ${row}: ביומן Google`)
    ).toBeChecked();
    await expect(preferences.getByLabel(`תזכורת ${row}: באתר`)).toBeChecked();
    await expect(preferences.getByLabel(`תזכורת ${row}: באתר`)).toBeDisabled();
  }
  await preferences
    .getByRole("button", { name: "שמירת העדפות אישיות" })
    .click();
  await expect
    .poll(async () => {
      const [stored] = await db
        .select()
        .from(records)
        .where(
          sql`${records.data}->>'accountId' = ${ids[email]} and ${records.kind} = 'settings'`
        );
      return stored?.data.reminders;
    })
    .toEqual([
      { hours: 24, email: false, calendar: true },
      { hours: 2, email: false, calendar: true },
    ]);
  await page.reload();
  for (const row of [1, 2])
    await expect(
      preferences.getByLabel(`תזכורת ${row}: במייל`)
    ).not.toBeChecked();
});

test("an uncertain calendar creation shows a safe technical check notice without exposing provider details", async () => {
  const email = people[2][1];
  const page = pages[email];
  await db
    .update(calendarLink)
    .set({ errorCode: "calendar_creation_uncertain", enabled: false })
    .where(eq(calendarLink.accountId, ids[email]));
  await page.goto("/settings");
  const calendar = panel(page);
  await expect(
    calendar.getByText("הסנכרון ממתין לבדיקה של המנהל הטכני")
  ).toBeVisible();
  await expect(
    calendar.getByLabel("הוספת תורנויות ליומן Google")
  ).not.toBeChecked();
  await expect(
    calendar.getByLabel("הוספת תורנויות ליומן Google")
  ).toBeEnabled();
  await expect(
    page.getByText("calendar_creation_uncertain", { exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByText("synthetic-refresh-token", { exact: true })
  ).toHaveCount(0);
});

test("the calendar switch and the reminder slots fit a phone without horizontal scrolling", async () => {
  const page = pages[people[2][1]];
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/settings");
  await expect(panel(page)).toBeVisible();
  await expect(
    page.getByLabel("תזכורת 1: שעות לפני תורנות").first()
  ).toBeVisible();
  await expect(page.getByLabel("תזכורת 3: ביומן Google").first()).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
