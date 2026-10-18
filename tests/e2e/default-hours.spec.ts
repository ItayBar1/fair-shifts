import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import { balances, duties, dutyTypes, soldiers } from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier, testIdNumber } from "../fixtures";
import { submitAuth, signedInHome } from "./auth-submit";

// Default hours of a duty type (decision 229). Synthetic people only.
const ZONE = "Asia/Jerusalem";
const D = DateTime.now().setZone(ZONE).plus({ days: 10 }).startOf("day");
const day = (offset = 0) => D.plus({ days: offset }).toISODate()!;
const manager = {
  number: "880300",
  name: "אחראי שעות",
  email: "hours-manager@example.invalid",
};
let actor: Actor;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await submitAuth(
    page,
    "/api/auth/request-code",
    page.getByRole("button", { name: "שליחת קוד למייל" })
  );
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
  await submitAuth(
    page,
    "/api/auth/verify-code",
    page.getByRole("button", { name: "כניסה לחשבון", exact: true })
  );
  await expect(page.getByRole("heading", { name: signedInHome })).toBeVisible();
}
// One sign-in code a minute per account: the session is reused by every test here.
let session: Page | undefined;
async function signedIn(browser: Browser) {
  if (session && !session.isClosed()) return session;
  session = await (await browser.newContext()).newPage();
  await login(session, manager.email);
  return session;
}

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
  await db.execute(sql`delete from records where kind = 'eligibility_catalog'`);
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name: manager.name,
    idNumber: testIdNumber(manager.number),
    data: soldier({ id, name: manager.name }),
  });
  await db.insert(balances).values({ soldierId: id });
  const account = await createInvitedAccount({
    name: manager.name,
    email: manager.email,
    role: "manager",
    soldierId: id,
  });
  actor = {
    id: account.id,
    name: manager.name,
    role: "manager",
    soldierId: id,
    securityEpoch: 1,
  };
  for (const [name, startTime, endTime] of [
    ["פטור שעות בוקר", "08:00", "14:00"],
    ["פטור שעות רחב", "00:00", "00:00"],
  ])
    await executeAction(actor, {
      type: "eligibility.catalog.save",
      payload: {
        kind: "exemption",
        name,
        windows: [{ startTime, endTime, weekdays: [1, 2, 3, 4, 5, 6, 7] }],
      },
      idempotencyKey: randomUUID(),
    });
});

test("sets default hours on a duty type, lists the hours exemptions they exceed and prefills a new instance", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  await page.goto("/manage/catalog");
  await page
    .getByRole("button", { name: "סוג תורנות חדש", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("שם סוג התורנות").fill("שמירת יממה");
  await dialog.getByLabel("ניקוד בסיס").fill("4");
  await dialog.getByLabel("שעת התחלה", { exact: true }).fill("08:00");
  await dialog.getByLabel("שעת סיום", { exact: true }).fill("08:00");
  // The same day cannot end at its start; the form says so before saving.
  await expect(dialog.getByText("צריכה להסתיים אחרי שעת ההתחלה")).toBeVisible();
  await dialog.getByLabel("ימים עד הסיום").fill("1");
  const relevant = dialog.getByText(
    /אינו מתאים לתורנות בשעות 08:00–08:00 למחרת/
  );
  await expect(relevant).toBeVisible();
  await expect(
    dialog.getByText("פטור שעות בוקר — בתורנות שמתחילה בכל יום")
  ).toBeVisible();
  // A window of a full day on every day covers the duty, so it is not listed.
  await expect(dialog.getByText(/פטור שעות רחב/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("שעות: 08:00–08:00 למחרת")).toBeVisible();
  const [type] = await db.select().from(dutyTypes);
  expect(type.data.defaultHours).toEqual({
    startTime: "08:00",
    endTime: "08:00",
    endDays: 1,
  });

  await page.goto("/manage/planning");
  await page
    .getByLabel("סוג תורנות", { exact: true })
    .selectOption({ label: "שמירת יממה" });
  await page.getByLabel("שם המופע").fill("יממה מברירת המחדל");
  await page.getByLabel("תאריך התחלה", { exact: true }).fill(day());
  const start = page.getByLabel("תחילת התורנות", { exact: true });
  const end = page.getByLabel("סיום התורנות", { exact: true });
  await expect(start).toHaveValue(`${day()}T08:00`);
  await expect(end).toHaveValue(`${day(1)}T08:00`);
  // Each moment stays editable on the instance.
  await end.fill(`${day(1)}T06:00`);
  await page.getByLabel("מיקום", { exact: true }).fill("אתר בדיקה");
  await page.getByRole("button", { name: "יצירת טיוטה" }).click();
  await expect(
    page.getByRole("link").filter({ hasText: "יממה מברירת המחדל" })
  ).toBeVisible();
  const [created] = await db.select().from(duties);
  expect(DateTime.fromISO(created.data.start).setZone(ZONE).toISO()).toBe(
    D.set({ hour: 8 }).toISO()
  );
  expect(DateTime.fromISO(created.data.end).setZone(ZONE).toISO()).toBe(
    D.plus({ days: 1 }).set({ hour: 6 }).toISO()
  );

  // The date field fits a phone screen without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("תאריך התחלה", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

// Decision 230: a new type starts at one point and one call-up point.
test("a new duty type starts at one point and one call-up point, either can change and the call-up can be cleared", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  await page.setViewportSize({ width: 1280, height: 720 });
  const stored = async (name: string) =>
    (await db.select().from(dutyTypes).where(eq(dutyTypes.name, name)))[0];
  const create = async (name: string, change?: () => Promise<void>) => {
    await page.goto("/manage/catalog");
    await page
      .getByRole("button", { name: "סוג תורנות חדש", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("ניקוד בסיס")).toHaveValue("1");
    await expect(dialog.getByLabel("סכום הזנקה שמור (רשות)")).toHaveValue("1");
    await dialog.getByLabel("שם סוג התורנות").fill(name);
    await change?.();
    await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    return stored(name);
  };

  const kept = await create("סוג עם ברירות המחדל");
  expect(kept.data.pricing).toMatchObject({
    basePoints: "1",
    callUpPoints: "1",
  });
  const changed = await create("סוג בלי הזנקה", async () => {
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("ניקוד בסיס").fill("3");
    await dialog.getByLabel("סכום הזנקה שמור (רשות)").fill("");
  });
  expect(changed.data.pricing).toMatchObject({ basePoints: "3" });
  expect(changed.data.pricing).not.toHaveProperty("callUpPoints");

  // Editing a type shows what it saved, not the defaults of a new one.
  await page.goto("/manage/catalog");
  await page
    .locator("section.panel", {
      has: page.getByRole("heading", { name: "סוג בלי הזנקה", exact: true }),
    })
    .getByRole("button", { name: "פרטים ועריכה", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("ניקוד בסיס")).toHaveValue("3");
  await expect(dialog.getByLabel("סכום הזנקה שמור (רשות)")).toHaveValue("");
});

// Decision 231: rest is entered in hours and stored in minutes.
test("rest before and after a duty type is entered in hours, saved in minutes and shown in hours", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/manage/catalog");
  await page
    .getByRole("button", { name: "סוג תורנות חדש", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("מנוחה לפני (שעות)")).toHaveValue("0:00");
  await dialog.getByLabel("שם סוג התורנות").fill("שמירת לילה עם מנוחה");
  await dialog.getByLabel("מנוחה לפני (שעות)").fill("12 שעות");
  await dialog.getByLabel("מנוחה אחרי (שעות)").fill("0:30");
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  // Text that is not hours is refused before anything is saved.
  await expect(dialog.getByText("מנוחה לפני: יש להזין שעות")).toBeVisible();
  await dialog.getByLabel("מנוחה לפני (שעות)").fill("12");
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const [type] = await db
    .select()
    .from(dutyTypes)
    .where(eq(dutyTypes.name, "שמירת לילה עם מנוחה"));
  expect(type.data).toMatchObject({
    restBeforeMinutes: 720,
    restAfterMinutes: 30,
  });
  const card = page.locator("section.panel", {
    has: page.getByRole("heading", {
      name: "שמירת לילה עם מנוחה",
      exact: true,
    }),
  });
  await expect(card).toContainText("מנוחה: 12 שעות לפני · 30 דקות אחרי");
  await card.getByRole("button", { name: "פרטים ועריכה", exact: true }).click();
  await expect(dialog.getByLabel("מנוחה לפני (שעות)")).toHaveValue("12:00");
  await expect(dialog.getByLabel("מנוחה אחרי (שעות)")).toHaveValue("0:30");
});

// Decision 232: the catalog holds no seats; each instance sets its own.
test("the catalog has no seats or roles, and a new instance sets its seats or splits them into roles", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/manage/catalog");
  await page
    .getByRole("button", { name: "סוג תורנות חדש", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("שם סוג התורנות").fill("שמירת שער");
  await expect(dialog.getByText("שם תפקיד")).toHaveCount(0);
  await expect(dialog.getByText("מקומות", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const [type] = await db
    .select()
    .from(dutyTypes)
    .where(eq(dutyTypes.name, "שמירת שער"));
  expect(type.data).not.toHaveProperty("roles");
  await expect(
    page.locator("section.panel", {
      has: page.getByRole("heading", { name: "שמירת שער", exact: true }),
    })
  ).not.toContainText("מקומות");

  const create = async (name: string, seats: () => Promise<void>) => {
    await page.goto("/manage/planning");
    await page
      .getByLabel("סוג תורנות", { exact: true })
      .selectOption({ label: "שמירת שער" });
    await page.getByLabel("שם המופע").fill(name);
    await page
      .getByLabel("תחילת התורנות", { exact: true })
      .fill(`${day(3)}T08:00`);
    await page
      .getByLabel("סיום התורנות", { exact: true })
      .fill(`${day(3)}T16:00`);
    await page.getByLabel("מיקום", { exact: true }).fill("שער ראשי");
    await expect(page.getByLabel("מספר מקומות")).toHaveValue("1");
    await seats();
    await page.getByRole("button", { name: "יצירת טיוטה" }).click();
    await expect(
      page.getByRole("link").filter({ hasText: name })
    ).toBeVisible();
    const [row] = await db.select().from(duties).where(eq(duties.name, name));
    return row.data.slots;
  };

  const plain = await create("שער בשלושה", () =>
    page.getByLabel("מספר מקומות").fill("3")
  );
  expect(plain.map((slot) => slot.role)).toEqual(["תורן", "תורן", "תורן"]);

  const split = await create("שער עם מפקד", async () => {
    await page.getByLabel("מספר מקומות").fill("2");
    await page
      .getByLabel("חלוקה לתפקידים, עם מכסה ותנאי התאמה לכל תפקיד")
      .check();
    // The split starts as one role holding the seats entered so far.
    await expect(page.getByLabel("מספר מקומות")).toHaveCount(0);
    await expect(page.getByLabel("מכסה", { exact: true })).toHaveValue("2");
    await page.getByLabel("שם תפקיד").fill("שומר");
    await page.getByRole("button", { name: "הוספת תפקיד" }).click();
    await page.getByLabel("שם תפקיד").nth(1).fill("מפקד");
    await page
      .getByRole("group", { name: "מגדר מותר לתפקיד מפקד" })
      .getByLabel("נקבה")
      .check();
  });
  expect(split.map((slot) => [slot.role, slot.requirements?.genders])).toEqual([
    ["שומר", undefined],
    ["שומר", undefined],
    ["מפקד", ["female"]],
  ]);
});
