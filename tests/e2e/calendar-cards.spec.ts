import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
  dutySlots,
  dutyTypes,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { assignment, duty, soldier } from "../fixtures";
import { signedInHome } from "./auth-submit";

// A deterministic synthetic calendar, behind real sign-in and state permissions.
const month = DateTime.now().setZone("Asia/Jerusalem").startOf("month");
const now = month.plus({ days: 14, hours: 12 }).toJSDate();
const people = {
  manager: {
    name: "אחראי ללא היסטוריה",
    email: "cards-manager@example.invalid",
    role: "manager",
  },
  me: {
    name: "חייל המשבצות",
    email: "cards-soldier@example.invalid",
    role: "soldier",
  },
  other: {
    name: "חייל נוסף",
    email: "cards-other@example.invalid",
    role: "soldier",
  },
  history: {
    name: "אחראי עם היסטוריה",
    email: "cards-history@example.invalid",
    role: "manager",
  },
} as const;
const ids = {
  manager: randomUUID(),
  me: randomUUID(),
  other: randomUUID(),
  history: randomUUID(),
};

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
  for (const [index, key] of (
    Object.keys(people) as (keyof typeof people)[]
  ).entries()) {
    const person = people[key];
    const data = soldier({
      id: ids[key],
      name: person.name,
      personalNumber: `84000${index}`,
    });
    await db.insert(soldiers).values({
      id: data.id,
      name: data.name,
      personalNumber: data.personalNumber,
      data,
    });
    await db
      .insert(soldierContacts)
      .values({ soldierId: data.id, email: person.email });
    await db
      .insert(balances)
      .values({ soldierId: data.id, current: key === "me" ? 12 : 4 });
    await createInvitedAccount({ ...person, soldierId: data.id });
  }
  const typeId = randomUUID();
  await db
    .insert(dutyTypes)
    .values({ id: typeId, name: "סוג סינתטי", data: {} });
  const fixtures = [
    { name: "שמירה מהעבר", day: 4, holder: "me" },
    { name: "שמירה שלי", day: 19, holder: "me" },
    { name: "מטווח חלקי", day: 20, holder: "other", seats: 3 },
    { name: "היסטוריית האחראי", day: 5, holder: "history" },
    { name: "בדיוק הסתיימה", day: 14, holder: "other", endsNow: true },
    { name: "החודש הבא", day: 19, nextMonth: true },
    { name: "שמירה בוטלה", day: 21, cancelled: true },
    { name: "טיוטה מוסתרת", day: 22, draft: true },
  ];
  for (const item of fixtures) {
    const base = item.nextMonth ? month.plus({ months: 1 }) : month;
    const start = base.plus({ days: item.day, hours: 8 });
    const slots = Array.from({ length: item.seats ?? 1 }, () => ({
      id: randomUUID(),
      role: "תורן",
    }));
    const data = {
      ...duty({
        id: randomUUID(),
        typeId,
        name: item.name,
        start: start.toISO()!,
        end: start.plus({ hours: item.endsNow ? 4 : 8 }).toISO()!,
        status: item.cancelled
          ? "cancelled"
          : item.draft
            ? "draft"
            : "published",
        slots,
      }),
      location: "מיקום סינתטי",
      instructions: "לבדיקה בלבד",
      wasPublished: !!item.cancelled,
    };
    await db
      .insert(duties)
      .values({ id: data.id, typeId, name: data.name, data });
    for (const slot of slots)
      await db
        .insert(dutySlots)
        .values({ id: slot.id, dutyId: data.id, data: slot });
    if (item.holder) {
      const row = assignment({
        id: randomUUID(),
        dutyId: data.id,
        slotId: slots[0].id,
        soldierId: ids[item.holder as keyof typeof ids],
        status: item.day < 14 ? "credited" : "reserved",
      });
      await db.insert(assignments).values({
        ...row,
        data: {
          ...row,
          ...(item.name === "מטווח חלקי"
            ? { needsAttention: ["qualification"] }
            : {}),
        },
      });
    }
  }
});

async function login(page: Page, key: keyof typeof people) {
  await page.clock.setFixedTime(now);
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(people[key].email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [account] = await db
    .select()
    .from(user)
    .where(eq(user.email, people[key].email));
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
  // The cards are the calendar's; a manager lands at the care centre (decision 218).
  await page.goto("/calendar");
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}
const card = (page: Page, label: string) =>
  page.getByRole("button", { name: `סינון לפי ${label}`, exact: true });
const list = (page: Page) => page.locator(".duty-list .duty-row");
// The view a card restores: a phone opens the calendar as a list (decision 218).
const startView = (width: number) =>
  width <= 760 ? "תצוגת רשימה" : "תצוגת חודש";
const fits = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth
  );

for (const width of [1280, 390]) {
  test(`soldier summary cards filter, restore and focus the score at width ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page, "me");
    await expect(card(page, "תורנויות החודש").locator("strong")).toHaveText(
      "5"
    );
    await expect(card(page, "בהמשך הדרך").locator("strong")).toHaveText("2");
    // Keyboard activation, accessible pressed state, and no draft/cancelled duty in the selection.
    await card(page, "תורנויות החודש").focus();
    await page.keyboard.press("Enter");
    await expect(card(page, "תורנויות החודש")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(list(page)).toHaveCount(5);
    await expect(page.locator(".calendar-panel")).not.toContainText(
      "טיוטה מוסתרת"
    );
    await expect(page.locator(".duty-list")).not.toContainText("שמירה בוטלה");
    await card(page, "תורנויות החודש").click();
    await expect(
      page.getByRole("button", { name: startView(width), exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    await card(page, "התורנויות שלי").click();
    await expect(list(page)).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "התורנויות שלי", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    await card(page, "בהמשך הדרך").click();
    await expect(list(page)).toHaveCount(1);
    await expect(list(page)).toContainText("שמירה שלי");
    await expect(card(page, "בהמשך הדרך").locator("strong")).toHaveText("1");
    // Monthly selection resets the personal scope but preserves search.
    await page.getByLabel("חיפוש תורנות").fill("מטווח");
    await card(page, "תורנויות החודש").click();
    await expect(list(page)).toHaveCount(1);
    await expect(list(page)).toContainText("מטווח חלקי");
    await expect(card(page, "תורנויות החודש").locator("strong")).toHaveText(
      "1"
    );
    await page.getByRole("button", { name: "החודש הבא", exact: true }).click();
    await expect(card(page, "תורנויות החודש").locator("strong")).toHaveText(
      "0"
    );
    await expect(
      page.getByText("אין תורנויות להצגה", { exact: true })
    ).toBeVisible();
    await page.getByLabel("חיפוש תורנות").fill("");
    await expect(list(page)).toHaveCount(1);
    await expect(list(page)).toContainText("החודש הבא");
    await card(page, "תורנויות החודש").click();
    await expect(
      page.getByRole("button", { name: startView(width), exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    expect(await fits(page)).toBe(true);
    await page.screenshot({
      path: `test-results/calendar-cards-soldier-${width}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "הצגת הניקוד שלי בטבלת הצדק", exact: true })
      .click();
    await expect(page).toHaveURL(/\/fairness#my-score$/);
    await expect(page.locator("#my-score")).toBeFocused();
    await expect(page.locator("#my-score")).toContainText("חייל המשבצות");
    await expect(page.locator("#my-score .score-number")).toHaveText("12");
    // No military rank on record: the rank column says so, not the place (#153).
    await expect(page.locator("#my-score td").nth(3)).toHaveText("—");
    await expect(page.locator("tbody")).not.toContainText("אחראי");
    expect(await fits(page)).toBe(true);
    await page.screenshot({
      path: `test-results/calendar-cards-score-${width}.png`,
      fullPage: true,
    });
  });

  test(`manager cards count vacant seats and open handling at width ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page, "manager");
    await expect(
      card(page, "מקומות פנויים בחודש").locator("strong")
    ).toHaveText("2");
    await card(page, "מקומות פנויים בחודש").click();
    await expect(list(page)).toHaveCount(1);
    await expect(list(page)).toContainText("מטווח חלקי");
    await expect(page.getByRole("status")).toContainText(
      "1 תורנויות · 2 מקומות פנויים"
    );
    await page.getByLabel("חיפוש תורנות").fill("שמירה");
    await expect(
      card(page, "מקומות פנויים בחודש").locator("strong")
    ).toHaveText("0");
    await expect(
      page.getByText("אין תורנויות להצגה", { exact: true })
    ).toBeVisible();
    await page.getByLabel("חיפוש תורנות").fill("");
    expect(await fits(page)).toBe(true);
    await page.screenshot({
      path: `test-results/calendar-cards-manager-${width}.png`,
      fullPage: true,
    });
    await card(page, "מקומות פנויים בחודש").click();
    await expect(
      page.getByRole("button", { name: startView(width), exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page
        .getByRole("button", { name: "הצגת ממתינים לטיפול", exact: true })
        .locator("strong")
    ).toHaveText("1");
    await page
      .getByRole("button", { name: "הצגת ממתינים לטיפול", exact: true })
      .click();
    await expect(page).toHaveURL(/\/manage$/);
    await expect(
      page.getByRole("heading", { name: "מרכז טיפול", exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("חייל נוסף — שיבוץ דורש טיפול", { exact: true })
    ).toBeVisible();
    expect(await fits(page)).toBe(true);
  });
}

test("a manager with duty history can open and focus their frozen balance", async ({
  page,
}) => {
  await login(page, "history");
  await card(page, "התורנויות שלי").click();
  await expect(list(page)).toHaveCount(1);
  await expect(list(page)).toContainText("היסטוריית האחראי");
  await page
    .getByRole("button", { name: "הצגת הניקוד שלי בטבלת הצדק", exact: true })
    .click();
  await expect(page.locator("#my-score")).toBeFocused();
  await expect(page.locator("#my-score")).toContainText("אחראי, לא משתתף");
  await expect(page.locator("#my-score")).toContainText("מוקפאת");
});
