import { test, expect, type Page } from "@playwright/test";
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
import ExcelJS from "exceljs";
import { DateTime } from "luxon";
import { createImportTemplate } from "../../src/server/import-workbook";

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
  const id = randomUUID();
  const data = soldier({ id, name: "אחראי בדיקה", personalNumber: "000001" });
  await db
    .insert(soldiers)
    .values({ id, name: data.name, personalNumber: data.personalNumber, data });
  await db.insert(balances).values({ soldierId: id });
  await createInvitedAccount({
    name: data.name,
    email: "manager@example.invalid",
    role: "manager",
    soldierId: id,
  });
});
// The pool is shared by every spec in the worker; the worker exit closes it.
async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [person] = await db.select().from(user).where(eq(user.email, email));
  const messages = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.recipientAccountId, person.id));
  const message = messages
    .filter((row) => row.kind === "login-code")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  await page
    .getByLabel("קוד כניסה", { exact: true })
    .fill(openSecret(message.encryptedSecret!));
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: person.role === "technical" ? "תמונת מצב" : "לוח התורנויות",
      exact: true,
    })
  ).toBeVisible();
}
test("technical account lands on its own overview after login", async ({
  page,
}) => {
  await createInvitedAccount({
    name: "טכני לבדיקה",
    email: "technical-home@example.invalid",
    role: "technical",
  });
  await login(page, "technical-home@example.invalid");
  await expect(
    page.getByRole("heading", { name: "תמונת מצב", exact: true })
  ).toBeVisible();
  await expect(page.getByText("המסך הזה אינו זמין לחשבון שלך")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "תמונת מצב", exact: true })
  ).toHaveAttribute("aria-current", "page");
});
test("manager invites, assigns and publishes; soldier sees only published duties", async ({
  page,
  browser,
}) => {
  await login(page, "manager@example.invalid");
  await page.goto("/manage/soldiers");
  await page
    .getByRole("button", { name: /הוספת חייל|חייל חדש/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("שם מלא").fill("חייל סינתטי");
  await dialog.getByLabel("מספר אישי").fill("000007");
  await dialog.getByLabel("מייל מאושר להזמנה").fill("soldier@example.invalid");
  await dialog.getByLabel("אוכלוסיית שיבוץ").selectOption("mandatory");
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("חייל סינתטי", { exact: true })).toBeVisible();
  await page.goto("/manage/catalog");
  await page
    .getByRole("button", { name: "סוג תורנות חדש", exact: true })
    .click();
  await page.getByLabel("שם סוג התורנות").fill("שמירה לדוגמה");
  await page.getByLabel("ניקוד בסיס").fill("4");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.goto("/manage/planning");
  await page
    .getByLabel("סוג תורנות", { exact: true })
    .selectOption({ label: "שמירה לדוגמה" });
  await page.getByLabel("שם המופע").fill("שמירת בדיקה");
  const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel("תחילת התורנות", { exact: true }).fill(`${date}T08:00`);
  await page.getByLabel("סיום התורנות", { exact: true }).fill(`${date}T16:00`);
  await page.getByLabel("מיקום", { exact: true }).fill("אתר בדיקה");
  await page.getByRole("button", { name: "יצירת טיוטה" }).click();
  await page.getByRole("link").filter({ hasText: "שמירת בדיקה" }).click();
  await page.getByRole("button", { name: "שיבוץ ידני", exact: true }).click();
  await page.getByLabel("בחירת חייל").selectOption({ label: "חייל סינתטי" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await page.getByLabel("בדקתי את ההתאמה ואת הניקוד").check();
  await page.getByRole("button", { name: "אישור השיבוץ", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const soldierContext = await browser.newContext();
  const memberPage = await soldierContext.newPage();
  await login(memberPage, "soldier@example.invalid");
  expect(
    (await (await memberPage.request.get("/api/v1/state")).json()).duties
  ).toHaveLength(0);
  await page.getByRole("button", { name: "עריכת טיוטה", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("סיבת השינוי")
    .fill("שינוי טיוטה לבדיקה");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "עריכת ההצעה והשיבוצים" }).click();
  await page.getByLabel("המיקום המוצע").fill("אתר טיוטה מעודכן");
  await page.getByRole("button", { name: "שמירת הצעה בלבד" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "בדיקת השפעת השינוי" }).click();
  await expect(
    page.getByRole("dialog", { name: "השוואה לפני שמירת הטיוטה" })
  ).toBeVisible();
  await page
    .getByLabel("בדקתי את השינויים, הסרת השיבוצים והניקוד ומאשר לשמור בטיוטה")
    .check();
  await page
    .getByRole("button", { name: "שמירת השינוי בטיוטה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    (await (await memberPage.request.get("/api/v1/state")).json()).duties
  ).toHaveLength(0);
  expect(
    (await (await memberPage.request.get("/api/v1/state")).json()).notifications
  ).toHaveLength(0);
  await page.getByRole("button", { name: "פרסום לחיילים" }).click();
  await page.getByLabel("בדקתי את הפרטים והשיבוצים").check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await memberPage.reload();
  const state = await (await memberPage.request.get("/api/v1/state")).json();
  expect(state.duties).toHaveLength(1);
  expect(state.assignments).toHaveLength(1);
  expect(JSON.stringify(state)).not.toContain("personalNumber");
  await memberPage.goto(`/duties/${state.duties[0].id}`);
  await expect(
    memberPage.getByRole("heading", { name: "שמירת בדיקה" })
  ).toBeVisible();
  await expect(
    memberPage.getByRole("button", { name: "פרסום לחיילים" })
  ).toHaveCount(0);
  await memberPage.setViewportSize({ width: 390, height: 844 });
  await memberPage.reload();
  await expect(
    memberPage.getByRole("heading", { name: "שמירת בדיקה" })
  ).toBeVisible();
  expect(
    await memberPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await memberPage.getByRole("button", { name: "פתיחת תפריט" }).click();
  await memberPage
    .getByRole("button", { name: "סגירת תפריט", exact: true })
    .last()
    .click();
  await memberPage.screenshot({
    path: "test-results/mobile-duty.png",
    fullPage: true,
    animations: "disabled",
  });
  await expect(page.locator(".detail-grid")).toContainText("4 נקודות");
  await page.goto("/manage/eligibility");
  await page.getByRole("button", { name: "הגדרה חדשה", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("סוג ההגדרה")
    .selectOption("qualification");
  await page
    .getByRole("dialog")
    .getByLabel("שם", { exact: true })
    .fill("כשירות לדוגמה");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByLabel("חייל", { exact: true })
    .selectOption({ label: "חייל סינתטי" });
  await page.getByLabel("מה משייכים").selectOption("qualification");
  await page
    .getByLabel("סוג מהקטלוג", { exact: true })
    .selectOption({ label: "כשירות לדוגמה" });
  await page.getByLabel("תחילת תוקף", { exact: true }).fill("2026-01-01");
  await page.getByLabel("סיום תוקף (כולל)", { exact: true }).fill("2030-12-31");
  await page
    .getByRole("button", { name: "בדיקת השפעת השיוך", exact: true })
    .click();
  const addition = page.getByRole("region", { name: "השפעת התקופה החדשה" });
  await expect(addition).toContainText(
    "התקופה אינה משנה את ההתאמה של שיבוצים קיימים."
  );
  await expect(addition).toContainText(
    "שיבוצים נוספים שנבדקו ואינם מושפעים: 1"
  );
  await addition.getByLabel("בדקתי את ההשפעה ומאשר את הוספת התקופה").check();
  await addition
    .getByRole("button", { name: "אישור הוספת התקופה", exact: true })
    .click();
  await expect(addition).toHaveCount(0);
  const history = page.locator(".subsection").filter({
    has: page.getByRole("heading", { name: "חייל סינתטי", exact: true }),
  });
  await history
    .getByRole("button", { name: "עריכת כשירות לדוגמה", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("סיום תוקף (כולל)")
    .fill("2031-12-31");
  await page
    .getByRole("dialog")
    .getByLabel("סיבת השינוי")
    .fill("עדכון כשירות לבדיקה");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "בדיקת השפעת השינוי" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("שמירת בדיקה");
  await page
    .getByRole("dialog")
    .screenshot({ path: "test-results/personnel-impact.png" });
  await page.getByLabel("בדקתי את ההשפעה ומאשר את השינוי").check();
  await page.getByRole("button", { name: "אישור שינוי התקופה" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await history
    .getByRole("button", { name: "הסרת כשירות לדוגמה", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("סיבת השינוי")
    .fill("הסרת שיוך סינתטי");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "בדיקת השפעת השינוי" })
    .click();
  await page.getByLabel("בדקתי את ההשפעה ומאשר את השינוי").check();
  await page.getByRole("button", { name: "אישור הסרת התקופה" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "הסרת כשירות לדוגמה", exact: true })
  ).toHaveCount(0);
  await page.goto(`/duties/${state.duties[0].id}`);
  await page.screenshot({
    path: "test-results/manager-duty.png",
    fullPage: true,
  });
  const attention = page.locator(".badge", { hasText: "דורשת טיפול" });
  await expect(attention).toHaveCount(0);
  await page.goto("/manage/soldiers");
  await page
    .getByRole("row")
    .filter({ hasText: "חייל סינתטי" })
    .getByRole("button", { name: "פרופיל ועריכה" })
    .click();
  const profile = page.getByRole("dialog");
  await profile.getByText("מועדי שירות, כשירות והיסטוריה").click();
  await profile.getByLabel("אי־פעילות מתאריך", { exact: true }).fill(date);
  await profile
    .getByLabel("אי־פעילות עד תאריך (כולל)", { exact: true })
    .fill(date);
  await profile.getByLabel("סיבת אי־הפעילות").fill("קורס סינתטי");
  await profile.getByRole("button", { name: "בדיקת השפעת אי־הפעילות" }).click();
  const inactivity = profile.getByRole("region", {
    name: "השפעת התקופה החדשה",
  });
  await expect(inactivity).toContainText("שמירת בדיקה");
  await expect(inactivity).toContainText("דורש טיפול");
  await expect(inactivity).toContainText("התורנות חופפת לתקופת אי־פעילות");
  const [previewed] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.name, "חייל סינתטי"));
  expect(previewed.data.inactivePeriods).toHaveLength(0);
  await inactivity.screenshot({ path: "test-results/add-period-impact.png" });
  await inactivity.getByLabel("בדקתי את ההשפעה ומאשר את הוספת התקופה").check();
  await inactivity
    .getByRole("button", { name: "אישור הוספת התקופה", exact: true })
    .click();
  await expect(inactivity).toHaveCount(0);
  const [inactive] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.name, "חייל סינתטי"));
  expect(inactive.data.inactivePeriods).toEqual([{ start: date, end: date }]);
  await page.goto(`/duties/${state.duties[0].id}`);
  await expect(attention).toBeVisible();
  await page.goto("/manage/eligibility");
  await page
    .locator(".subsection")
    .filter({
      has: page.getByRole("heading", { name: "חייל סינתטי", exact: true }),
    })
    .getByRole("button", { name: "הסרת אי־פעילות", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("סיבת השינוי")
    .fill("סיום קורס סינתטי");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "בדיקת השפעת השינוי" })
    .click();
  await page.getByLabel("בדקתי את ההשפעה ומאשר את השינוי").check();
  await page.getByRole("button", { name: "אישור הסרת התקופה" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.goto(`/duties/${state.duties[0].id}`);
  await expect(attention).toHaveCount(0);
  await page.goto("/manage/constraints");
  await page.getByRole("button", { name: "פתיחת סבב" }).click();
  await page.getByLabel("שם הסבב").fill("סבב אילוצים לדוגמה");
  const yesterday = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  await page.getByLabel("פתיחת הגשות").fill(`${yesterday}T00:00`);
  await page.getByLabel("סגירת הגשות").fill(`${date}T23:00`);
  await page.getByLabel("תחילת תקופת יעד").fill(date);
  await page.getByLabel("סיום תקופת יעד").fill(date);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await memberPage.goto("/constraints");
  await memberPage
    .getByLabel("בחירת סבב")
    .selectOption({ label: "סבב אילוצים לדוגמה" });
  await memberPage.getByLabel("מיום", { exact: true }).fill(date);
  await memberPage.getByLabel("עד יום (כולל)").fill(date);
  await memberPage.getByLabel("סיבת האילוץ").fill("אילוץ סינתטי לבדיקה");
  await memberPage.getByRole("button", { name: "שליחת הגשה" }).click();
  await expect(
    memberPage.getByText(/^ממתין:.*אילוץ סינתטי לבדיקה/)
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "אישור", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("שמירת בדיקה");
  await page.getByLabel("בדקתי את השפעת האישור").check();
  await page.getByRole("button", { name: "אישור האילוץ", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText(/^מאושר:/)).toBeVisible();
  await memberPage.reload();
  await expect(memberPage.getByText(/^מאושר:/)).toBeVisible();
  const managerState = await (await page.request.get("/api/v1/state")).json();
  expect(
    managerState.assignments.find(
      (item: { status: string; dutyId: string }) =>
        item.status === "reserved" && item.dutyId === state.duties[0].id
    ).needsAttention
  ).toContain("approved_constraint");
  await page.goto("/manage/ranks");
  for (const [name, order] of [
    ["דרגה א לבדיקה", 1],
    ["דרגה ב לבדיקה", 2],
  ] as const) {
    await page.getByRole("button", { name: "הוספת דרגה לקטלוג" }).click();
    await page.getByLabel("שם הדרגה", { exact: true }).fill(name);
    await page.getByLabel("מסלול הדרגות", { exact: true }).fill("מסלול סינתטי");
    await page.getByLabel("סדר בתוך המסלול").fill(String(order));
    await page.getByLabel("מקור ההגדרה המאומת").fill("נתוני בדיקה בלבד");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "שמירה", exact: true })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  await page
    .getByLabel("חייל לעדכון דרגה")
    .selectOption({ label: "חייל סינתטי" });
  await page
    .getByLabel("דרגה מאושרת", { exact: true })
    .selectOption({ label: "דרגה א לבדיקה · מסלול סינתטי" });
  await page.getByLabel("תאריך תחולת הדרגה").fill("2026-01-31");
  await page.getByLabel("מקור ואישור העדכון").fill("אישור סינתטי");
  await page.getByRole("button", { name: "שמירת הדרגה המאושרת" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/v1/state")).json()).soldiers.find(
          (person: { name: string }) => person.name === "חייל סינתטי"
        ).rankName
    )
    .toBe("דרגה א לבדיקה");
  await page.getByRole("button", { name: "הוספת כלל פז״ם" }).click();
  await page.getByLabel("שם כלל הפז״ם").fill("כלל תזכורת לדוגמה");
  await page
    .getByLabel("דרגת מוצא")
    .selectOption({ label: "דרגה א לבדיקה · מסלול סינתטי" });
  await page
    .getByLabel("דרגת יעד", { exact: true })
    .selectOption({ label: "דרגה ב לבדיקה · מסלול סינתטי" });
  await page.getByLabel("מספר חודשים").fill("1");
  await page.getByLabel("מקור הכלל המאומת").fill("כלל סינתטי בלבד");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText("ממתין לבדיקה: 28.02.2026")).toBeVisible();
  await page.getByRole("button", { name: "בדיקה ואישור", exact: true }).click();
  await page.getByLabel("תאריך תחולה מאושר").fill("2026-03-01");
  await page
    .getByLabel("מקור האישור", { exact: true })
    .fill("אישור אחראי סינתטי");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await (await memberPage.request.get("/api/v1/state")).json()
        ).soldiers.find(
          (person: { name: string }) => person.name === "חייל סינתטי"
        ).rankName
    )
    .toBe("דרגה ב לבדיקה");
  await page.screenshot({
    path: "test-results/manager-ranks.png",
    fullPage: true,
  });
  await page.goto("/manage/catalog");
  await page
    .getByRole("button", { name: "סוג תורנות חדש", exact: true })
    .click();
  await page.getByLabel("שם סוג התורנות").fill("תורנות עם דרגה מוגדרת");
  await page.getByLabel("ניקוד בסיס").fill("4");
  await page
    .getByRole("button", { name: "הוספת תנאי דרגה", exact: true })
    .first()
    .click();
  await page
    .getByLabel("תנאי דרגה לסוג התורנות דרגות 1")
    .selectOption({ label: "דרגה א לבדיקה" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.goto("/manage/planning");
  await page
    .getByLabel("סוג תורנות", { exact: true })
    .selectOption({ label: "תורנות עם דרגה מוגדרת" });
  await page.getByLabel("שם המופע").fill("בדיקת חריג ידני");
  const later = new Date(Date.now() + 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await page
    .getByLabel("תחילת התורנות", { exact: true })
    .fill(`${later}T08:00`);
  await page.getByLabel("סיום התורנות", { exact: true }).fill(`${later}T16:00`);
  await page.getByLabel("מיקום", { exact: true }).fill("אתר בדיקה נוסף");
  await page.getByRole("button", { name: "יצירת טיוטה" }).click();
  await page.getByRole("link").filter({ hasText: "בדיקת חריג ידני" }).click();
  await page.getByRole("button", { name: "שיבוץ ידני", exact: true }).click();
  await page.getByLabel("בחירת חייל").selectOption({ label: "חייל סינתטי" });
  await page.getByLabel("תוספת הזנקה אישית").fill("3");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("ניקוד צפוי: 7");
  await page.getByLabel("נדרש אישור חריג דרגה", { exact: true }).check();
  await page
    .getByLabel("סיבה לאישור החריגים הנקודתיים")
    .fill("חריג סינתטי לתורנות אחת");
  await page.getByLabel("בדקתי את ההתאמה ואת הניקוד").check();
  await page.getByRole("button", { name: "אישור השיבוץ", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "פרסום לחיילים" }).click();
  await page.getByLabel("בדקתי את הפרטים והשיבוצים").check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  // Resume a period run through a near-release approval using synthetic API setup.
  const currentState = await (await page.request.get("/api/v1/state")).json();
  const member = currentState.soldiers.find(
    (person: { name: string }) => person.name === "חייל סינתטי"
  );
  const lateDate = new Date(Date.now() + 21 * 86400_000)
    .toISOString()
    .slice(0, 10);
  const releaseDate = new Date(Date.now() + 28 * 86400_000)
    .toISOString()
    .slice(0, 10);
  const api = async (
    type: string,
    payload: Record<string, unknown>,
    expectedVersion?: number
  ) => {
    const response = await page.request.post("/api/v1/actions", {
      headers: { origin: "http://127.0.0.1:3000" },
      data: { type, payload, expectedVersion, idempotencyKey: randomUUID() },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).result;
  };
  await api("soldier.update", { ...member, releaseDate }, member.version);
  const specialty = await api("eligibility.catalog.save", {
    kind: "qualification",
    name: "כשירות להגרלת בדיקה",
  });
  const freshState = await (await page.request.get("/api/v1/state")).json();
  const freshMember = freshState.soldiers.find(
    (person: { id: string }) => person.id === member.id
  );
  const specialtyPeriod = {
    soldierId: member.id,
    kind: "qualification",
    startDate: lateDate,
    endDate: lateDate,
    value: specialty.id,
  };
  const specialtyPreview = await api(
    "soldier.timeline.preview",
    specialtyPeriod,
    freshMember.version
  );
  await api(
    "soldier.timeline",
    {
      ...specialtyPeriod,
      confirmed: true,
      previewToken: specialtyPreview.previewToken,
    },
    freshMember.version
  );
  const lotteryType = await api("dutyType.save", {
    name: "הגרלה עם אישור",
    qualificationIds: [specialty.id],
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 1 }],
  });
  await api("duty.create", {
    typeId: lotteryType.id,
    name: "מופע לתכנון ואישור",
    start: `${lateDate}T08:00`,
    end: `${lateDate}T16:00`,
    location: "אתר סינתטי",
  });
  await page.goto("/manage/planning");
  await page.getByLabel("מתאריך", { exact: true }).fill(lateDate);
  await page.getByLabel("עד תאריך", { exact: true }).fill(lateDate);
  await page.getByRole("button", { name: "יצירת ריצת תכנון" }).click();
  await expect(page.getByText(/ממתין להחלטת אחראי/)).toBeVisible();
  await page
    .getByRole("link")
    .filter({ hasText: "מופע לתכנון ואישור" })
    .first()
    .click();
  await expect(
    page.getByLabel("נדרש אישור בחירה בחודש שלפני השחרור", { exact: true })
  ).toBeVisible();
  await page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "הגרלות והחלטות", exact: true }),
    })
    .screenshot({ path: "test-results/lottery-approval.png" });
  await page
    .getByLabel("נדרש אישור בחירה בחודש שלפני השחרור", { exact: true })
    .check();
  await page.getByLabel("סיבת אישור המועמד").fill("אישור סינתטי לפני שחרור");
  await page.getByRole("button", { name: "אישור המועמד ושיבוץ" }).click();
  await expect(
    page.getByRole("button", { name: "אישור המועמד ושיבוץ" })
  ).toHaveCount(0);
  await page.goto("/manage/planning");
  await page.getByRole("button", { name: "המשך תכנון", exact: true }).click();
  await expect(page.getByText(/הסתיים · 0 מקומות לא מאוישים/)).toBeVisible();
  await page
    .locator("section")
    .filter({
      has: page.getByRole("heading", {
        name: "ריצות תכנון שמורות",
        exact: true,
      }),
    })
    .screenshot({ path: "test-results/period-planning.png" });
  await page
    .getByRole("link")
    .filter({ hasText: "מופע לתכנון ואישור" })
    .first()
    .click();
  await page.getByRole("button", { name: "פרסום לחיילים" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("בדקתי את הפרטים והשיבוצים")
    .check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "יצירת הצעת שינוי" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("סיבת השינוי")
    .fill("שינוי מיקום סינתטי");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "עריכת ההצעה והשיבוצים" }).click();
  await page.getByLabel("המיקום המוצע").fill("מיקום חדש לבדיקה");
  await page.getByRole("button", { name: "שמירת הצעה בלבד" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const soldierBefore = await (
    await memberPage.request.get("/api/v1/state")
  ).json();
  expect(
    soldierBefore.duties.find(
      (duty: { name: string }) => duty.name === "מופע לתכנון ואישור"
    ).location
  ).toBe("אתר סינתטי");
  expect(soldierBefore.dutyChanges).toEqual([]);
  await page.getByRole("button", { name: "בדיקת השפעת השינוי" }).click();
  await expect(
    page.getByRole("dialog", { name: "השוואה לפני עדכן ופרסם" })
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByLabel(/נדרש אישור בחירה בחודש שלפני השחרור/)
    .check();
  await page
    .getByLabel("בדקתי את השינויים, הסרת השיבוצים והניקוד ומאשר לפרסם")
    .check();
  await page
    .getByRole("dialog")
    .screenshot({ path: "test-results/published-change.png" });
  await page.getByRole("button", { name: "עדכן ופרסם", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const soldierAfter = await (
    await memberPage.request.get("/api/v1/state")
  ).json();
  expect(
    soldierAfter.duties.find(
      (duty: { name: string }) => duty.name === "מופע לתכנון ואישור"
    ).location
  ).toBe("מיקום חדש לבדיקה");
  await page.getByRole("button", { name: "ביטול תורנות", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("סיבת הביטול")
    .fill("ביטול סינתטי מאושר");
  await page.getByLabel("מאשר לבטל ולפנות את השיבוצים").check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const cancelledState = await (
    await memberPage.request.get("/api/v1/state")
  ).json();
  const cancelled = cancelledState.duties.find(
    (duty: { name: string }) => duty.name === "מופע לתכנון ואישור"
  );
  expect(cancelled.status).toBe("cancelled");
  expect(
    cancelledState.assignments.filter(
      (item: { dutyId: string; status: string }) =>
        item.dutyId === cancelled.id && item.status === "reserved"
    )
  ).toHaveLength(0);
  await memberPage.goto(`/duties/${cancelled.id}`);
  await expect(memberPage.getByText("בוטלה", { exact: true })).toBeVisible();
  await page.goto("/manage/imports");
  const download = await page.request.get("/api/v1/imports/template");
  expect(download.status()).toBe(200);
  expect(download.headers()["content-type"]).toContain("spreadsheetml");
  expect(
    (await memberPage.request.get("/api/v1/imports/template")).status()
  ).toBe(403);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(await createImportTemplate()).buffer);
  const sheet = workbook.getWorksheet("חיילים")!;
  sheet.addRow(["000007", "חייל לאחר ייבוא", null, "0500000007", null, 17]);
  sheet.addRow([
    "000019",
    "חייל קליטה מייבוא",
    "xlsx@example.invalid",
    "0500000019",
    null,
    5,
  ]);
  await page.getByLabel("קובץ XLSX").setInputFiles({
    name: "synthetic.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(new Uint8Array(await workbook.xlsx.writeBuffer())),
  });
  await page
    .getByRole("button", { name: "הצגת תצוגה מקדימה", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "תצוגה מקדימה — טרם נשמרו חיילים" })
  ).toBeVisible();
  const beforeImport = await (await page.request.get("/api/v1/state")).json();
  expect(
    beforeImport.soldiers.some(
      (person: { personalNumber: string }) => person.personalNumber === "000019"
    )
  ).toBe(false);
  await page.getByLabel("סיבת הייבוא").fill("קליטה סינתטית בדפדפן");
  await page
    .getByLabel("אני מאשר/ת דריסת השדות והיתרות הקיימים המוצגים")
    .check();
  await page
    .getByLabel("בדקתי את כל השורות ואת ברירות המחדל לקליטה חדשה")
    .check();
  await page.screenshot({
    path: "test-results/import-preview.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "אישור ושמירת הייבוא", exact: true })
    .click();
  await expect(page.getByText(/הייבוא נשמר בשלמותו/)).toBeVisible();
  const afterImport = await (await page.request.get("/api/v1/state")).json();
  expect(
    afterImport.soldiers.find(
      (person: { personalNumber: string }) => person.personalNumber === "000007"
    )
  ).toMatchObject({
    name: "חייל לאחר ייבוא",
    currentScore: 17,
    phone: "0500000007",
  });
  expect(
    afterImport.soldiers.find(
      (person: { personalNumber: string }) => person.personalNumber === "000019"
    )
  ).toMatchObject({ currentScore: 5, graceEligible: false });
  const importedPerson = afterImport.soldiers.find(
    (person: { personalNumber: string }) => person.personalNumber === "000007"
  );
  await db
    .update(soldierContacts)
    .set({ phone: "0500000008", address: "כתובת שנערכה לאחר הייבוא" })
    .where(eq(soldierContacts.soldierId, importedPerson.id));
  await db
    .update(soldierContacts)
    .set({ phone: "0500000007" })
    .where(eq(soldierContacts.soldierId, importedPerson.id));
  await page
    .getByRole("button", { name: "בדיקת שחזור עדכונים", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "בדיקת שחזור — לפי השינויים מאז הייבוא" })
  ).toBeVisible();
  await expect(page.getByText("השתנה מאז", { exact: true })).toBeVisible();
  await page
    .getByLabel("החלטה עבור חייל לאחר ייבוא — טלפון", { exact: true })
    .selectOption("keep");
  await page
    .getByLabel("סיבת השחזור וההכרעות")
    .fill("ביטול שינויי הייבוא ושמירת העריכה המאוחרת");
  await page.getByLabel("בדקתי את השדות ואת ההחלטות ומאשר/ת את השחזור").check();
  await page
    .locator(".import-restore")
    .screenshot({ path: "test-results/import-restore.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "פתיחת תפריט", exact: true }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await page
    .getByRole("button", { name: "סגירת תפריט", exact: true })
    .last()
    .click();
  await expect(page.locator(".sidebar")).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.screenshot({
    path: "test-results/import-restore-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole("button", { name: "אישור שחזור העדכונים", exact: true })
    .click();
  await expect(
    page.getByText(/עדכוני החיילים הקיימים שוחזרו או הוכרעו/)
  ).toBeVisible();
  const restoredState = await (await page.request.get("/api/v1/state")).json();
  expect(
    restoredState.soldiers.find(
      (person: { personalNumber: string }) => person.personalNumber === "000007"
    )
  ).toMatchObject({
    name: "חייל סינתטי",
    currentScore: 0,
    phone: "0500000007",
    address: "כתובת שנערכה לאחר הייבוא",
  });
  expect(
    restoredState.soldiers.find(
      (person: { personalNumber: string }) => person.personalNumber === "000019"
    )
  ).toMatchObject({ currentScore: 5 });
  await soldierContext.close();
});

test("responsibility filters default per manager, hide KAMA and filter rank without granting or limiting access", async ({
  page,
  browser,
}) => {
  const sergeant = randomUUID();
  const foreignSergeant = randomUUID();
  await db.insert(records).values([
    {
      id: sergeant,
      kind: "rank_catalog",
      data: {
        name: "רס״ל מסנן",
        track: "נגדים מסנן",
        order: 1,
        source: "בדיקה",
      },
    },
    {
      id: foreignSergeant,
      kind: "rank_catalog",
      data: {
        name: "רס״ל מסנן",
        track: "מסלול אחר מסנן",
        order: 1,
        source: "בדיקה",
      },
    },
  ]);
  async function person(
    name: string,
    personalNumber: string,
    population: "mandatory" | "career" | "academic",
    rank?: { rankId: string; trackId: string }
  ) {
    const id = randomUUID();
    const data = soldier({
      id,
      name,
      personalNumber,
      service: {
        type: population === "career" ? "career" : "mandatory",
        basePopulation: population,
        graceEligible: false,
      },
      rankHistory: rank
        ? [{ ...rank, effectiveFrom: "2026-01-01", order: 1 }]
        : [],
    });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(balances).values({ soldierId: id });
    return id;
  }
  await person("מסנן חובה נגד", "100001", "mandatory", {
    rankId: sergeant,
    trackId: "נגדים מסנן",
  });
  await person("מסנן חובה מסלול אחר", "100002", "mandatory", {
    rankId: foreignSergeant,
    trackId: "מסלול אחר מסנן",
  });
  await person("מסנן קבע", "100003", "career");
  await person("מסנן קמא", "100004", "academic");
  const careerSoldier = await person("מסנן אחראי קבע", "100005", "career");
  const mandatoryManager = await person(
    "מסנן אחראי חובה",
    "100007",
    "mandatory"
  );
  await createInvitedAccount({
    name: "מסנן אחראי חובה",
    email: "mandatory-manager@example.invalid",
    role: "manager",
    soldierId: mandatoryManager,
  });
  const memberSoldier = await person("מסנן חייל", "100006", "mandatory");
  await createInvitedAccount({
    name: "מסנן אחראי קבע",
    email: "career-manager@example.invalid",
    role: "manager",
    soldierId: careerSoldier,
  });
  await createInvitedAccount({
    name: "מסנן חייל",
    email: "filter-soldier@example.invalid",
    role: "soldier",
    soldierId: memberSoldier,
  });
  await createInvitedAccount({
    name: "טכני לבדיקה",
    email: "technical@example.invalid",
    role: "technical",
  });

  const technicalContext = await browser.newContext();
  const technicalPage = await technicalContext.newPage();
  await login(technicalPage, "technical@example.invalid");
  await technicalPage.goto("/technical/permissions");
  const careerSelect = technicalPage.getByLabel(
    "תחום אחריות · מסנן אחראי קבע",
    { exact: true }
  );
  await expect(careerSelect).toHaveValue("");
  await careerSelect.selectOption("career");
  await expect(careerSelect).toHaveValue("career");
  await technicalContext.close();

  const rowsNamed = (target: Page) =>
    target.locator("tbody tr").filter({ hasText: "מסנן" });
  const visibleNames = async (target: Page) =>
    (await rowsNamed(target).locator("strong").allTextContents()).sort();

  await login(page, "mandatory-manager@example.invalid");
  await page.goto("/manage/soldiers");
  for (const label of ["חובה", "קבע / קצינים", "קמ״א"])
    await expect(page.getByLabel(label, { exact: true })).toBeChecked();
  await page.goto("/settings");
  const ownScope = page.getByLabel("תחום האחריות שלי", { exact: true });
  await expect(ownScope).toHaveValue("");
  await ownScope.selectOption("mandatory");
  await expect(ownScope).toHaveValue("mandatory");
  await page.goto("/manage/soldiers");
  await page.getByLabel("חיפוש חייל לפי שם או מספר אישי").fill("מסנן");
  await expect(page.getByLabel("חובה", { exact: true })).toBeChecked();
  await expect(page.getByLabel("קמ״א", { exact: true })).toBeChecked();
  await expect(
    page.getByLabel("קבע / קצינים", { exact: true })
  ).not.toBeChecked();
  await expect
    .poll(() => visibleNames(page))
    .toEqual(
      [
        "מסנן חובה נגד",
        "מסנן חובה מסלול אחר",
        "מסנן חייל",
        "מסנן קמא",
        "מסנן אחראי חובה",
      ].sort()
    );
  await page.getByLabel("קמ״א", { exact: true }).uncheck();
  await expect(rowsNamed(page).filter({ hasText: "מסנן קמא" })).toHaveCount(0);
  await page.getByLabel("קבע / קצינים", { exact: true }).check();
  await expect(rowsNamed(page).filter({ hasText: "מסנן קבע" })).toHaveCount(1);
  await page
    .getByLabel("סינון לפי דרגה נוכחית")
    .selectOption(`rank:${sergeant}`);
  await expect.poll(() => visibleNames(page)).toEqual(["מסנן חובה נגד"]);
  await expect(page.getByText("· מסלול נגדים מסנן")).toBeVisible();
  await page
    .getByLabel("סינון לפי דרגה נוכחית")
    .selectOption("track:מסלול אחר מסנן");
  await expect.poll(() => visibleNames(page)).toEqual(["מסנן חובה מסלול אחר"]);
  await page.getByLabel("סינון לפי דרגה נוכחית").selectOption("missing");
  await expect
    .poll(() => visibleNames(page))
    .toEqual(
      ["מסנן חייל", "מסנן קבע", "מסנן אחראי קבע", "מסנן אחראי חובה"].sort()
    );
  await expect(
    rowsNamed(page).first().getByText("דרגה חסרה", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "חזרה לברירת המחדל" }).click();
  await expect(page.getByLabel("קמ״א", { exact: true })).toBeChecked();
  await expect(
    page.getByLabel("קבע / קצינים", { exact: true })
  ).not.toBeChecked();
  await page.screenshot({
    path: "test-results/soldier-filters.png",
    fullPage: true,
  });

  const careerContext = await browser.newContext();
  const careerPage = await careerContext.newPage();
  await login(careerPage, "career-manager@example.invalid");
  await careerPage.setViewportSize({ width: 390, height: 844 });
  await careerPage.goto("/manage/soldiers");
  await careerPage.getByLabel("חיפוש חייל לפי שם או מספר אישי").fill("מסנן");
  await expect
    .poll(() => visibleNames(careerPage))
    .toEqual(["מסנן קבע", "מסנן אחראי קבע", "מסנן קמא"].sort());
  const academic = careerPage.getByLabel("קמ״א", { exact: true });
  await academic.focus();
  await careerPage.keyboard.press("Space");
  await expect(academic).not.toBeChecked();
  await expect(
    rowsNamed(careerPage).filter({ hasText: "מסנן קמא" })
  ).toHaveCount(0);
  await careerPage.getByLabel("חובה", { exact: true }).check();
  const mandatoryRow = rowsNamed(careerPage).filter({
    hasText: "מסנן חובה נגד",
  });
  await expect(mandatoryRow).toHaveCount(1);
  expect(
    await careerPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await careerPage.screenshot({
    path: "test-results/soldier-filters-mobile.png",
    fullPage: true,
  });
  await mandatoryRow.getByRole("button", { name: "פרופיל ועריכה" }).click();
  await expect(careerPage.getByRole("dialog")).toContainText("מסנן חובה נגד");
  const careerState = await (
    await careerPage.request.get("/api/v1/state")
  ).json();
  const managerState = await (await page.request.get("/api/v1/state")).json();
  const ids = (state: { soldiers: { id: string }[] }) =>
    state.soldiers.map((row) => row.id).sort();
  expect(careerState.actor.responsibility).toBe("career");
  expect(managerState.actor.responsibility).toBe("mandatory");
  expect(ids(careerState)).toEqual(ids(managerState));
  await careerContext.close();

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await login(memberPage, "filter-soldier@example.invalid");
  const memberState = await (
    await memberPage.request.get("/api/v1/state")
  ).json();
  const listed = memberState.soldiers.find(
    (row: { name: string }) => row.name === "מסנן חובה נגד"
  );
  expect(listed.rankName).toBe("רס״ל מסנן");
  for (const key of ["rankId", "rankTrack", "email", "phone", "rankHistory"])
    expect(listed).not.toHaveProperty(key);
  const forged = await memberPage.request.post("/api/v1/actions", {
    headers: { origin: "http://127.0.0.1:3000" },
    data: {
      type: "account.responsibility",
      payload: { id: memberState.actor.id, responsibility: "career" },
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    },
  });
  expect(forged.ok()).toBe(false);
  const [unchanged] = await db
    .select()
    .from(user)
    .where(eq(user.email, "filter-soldier@example.invalid"));
  expect(unchanged.responsibility).toBeNull();
  await memberContext.close();
});

test("multi-day duties appear on every Israeli day and month, independent of the browser zone", async ({
  page,
  browser,
}) => {
  async function account(
    name: string,
    email: string,
    personalNumber: string,
    role: "manager" | "soldier"
  ) {
    const id = randomUUID();
    const data = soldier({ id, name, personalNumber });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(balances).values({ soldierId: id });
    await createInvitedAccount({ name, email, role, soldierId: id });
    return id;
  }
  await account(
    "לוח אחראי",
    "calendar-manager@example.invalid",
    "200001",
    "manager"
  );
  const memberId = await account(
    "לוח חייל",
    "calendar-soldier@example.invalid",
    "200002",
    "soldier"
  );
  await login(page, "calendar-manager@example.invalid");
  const api = async (
    type: string,
    payload: Record<string, unknown>,
    expectedVersion?: number
  ) => {
    const response = await page.request.post("/api/v1/actions", {
      headers: { origin: "http://127.0.0.1:3000" },
      data: { type, payload, expectedVersion, idempotencyKey: randomUUID() },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).result as { id: string; version: number };
  };
  const zone = "Asia/Jerusalem";
  const target = DateTime.now()
    .setZone(zone)
    .plus({ months: 2 })
    .startOf("month");
  const lastDay = target.endOf("month").startOf("day");
  const type = await api("dutyType.save", {
    name: "לוח רב יומי",
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 1 }],
  });
  async function publishedDuty(name: string, start: DateTime, end: DateTime) {
    const created = await api("duty.create", {
      typeId: type.id,
      name,
      start: start.toISO(),
      end: end.toISO(),
      location: "אתר לוח",
    });
    const state = await (await page.request.get("/api/v1/state")).json();
    const row = state.duties.find((d: { id: string }) => d.id === created.id);
    await api(
      "duty.assign",
      { dutyId: row.id, slotId: row.slots[0].id, soldierId: memberId },
      1
    );
    await api("duty.publish", { id: row.id, confirmed: true }, 2);
    return row.id as string;
  }
  const crossingId = await publishedDuty(
    "לילה חוצה חודש",
    lastDay.set({ hour: 22 }),
    lastDay.plus({ days: 2 }).set({ hour: 6 })
  );
  const cancelledId = await publishedDuty(
    "תורנות שבוטלה",
    target.set({ day: 10, hour: 8 }),
    target.set({ day: 10, hour: 16 })
  );
  await api(
    "duty.cancel",
    { id: cancelledId, reason: "ביטול לבדיקת הלוח", confirmed: true },
    3
  );
  await api("duty.create", {
    typeId: type.id,
    name: "טיוטה שאינה בלוח",
    start: target.set({ day: 12, hour: 8 }).toISO(),
    end: target.set({ day: 12, hour: 16 }).toISO(),
  });

  const context = await browser.newContext({
    timezoneId: "America/Los_Angeles",
  });
  const member = await context.newPage();
  await login(member, "calendar-soldier@example.invalid");
  await member.goto("/calendar");
  const next = member.getByRole("button", { name: "החודש הבא" });
  await next.click();
  await next.click();
  const monthTitle = target.setLocale("he").toFormat("LLLL yyyy");
  await expect(member.getByRole("heading", { name: monthTitle })).toBeVisible();
  const cellOf = (link: ReturnType<Page["getByRole"]>) =>
    link.locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' calendar-day ')][1]"
    );
  const startLink = member.getByRole("link", {
    name: "לילה חוצה חודש, התחלה 22:00",
  });
  await expect(startLink).toHaveCount(1);
  await expect(cellOf(startLink).locator(".day-number")).toHaveText(
    String(lastDay.day)
  );
  const cancelled = member.getByRole("link", {
    name: "תורנות שבוטלה, 08:00–16:00, בוטלה",
  });
  await expect(cancelled).toHaveCount(1);
  await expect(cellOf(cancelled).locator(".day-number")).toHaveText("10");
  await expect(member.getByText("טיוטה שאינה בלוח")).toHaveCount(0);
  await expect(
    member
      .locator(".stat")
      .filter({ hasText: "תורנויות החודש" })
      .locator("strong")
  ).toHaveText("1");

  await next.click();
  const nextMonth = target.plus({ months: 1 });
  await expect(
    member.getByRole("heading", {
      name: nextMonth.setLocale("he").toFormat("LLLL yyyy"),
    })
  ).toBeVisible();
  const middle = member.getByRole("link", { name: "לילה חוצה חודש, ממשיכה" });
  const end = member.getByRole("link", { name: "לילה חוצה חודש, סיום 06:00" });
  await expect(cellOf(middle).locator(".day-number")).toHaveText("1");
  await expect(cellOf(end).locator(".day-number")).toHaveText("2");
  await expect(
    member.getByRole("link", { name: /^לילה חוצה חודש/ })
  ).toHaveCount(2);

  await member.getByRole("button", { name: "תצוגת רשימה" }).click();
  await expect(
    member.locator(".duty-row").filter({ hasText: "לילה חוצה חודש" })
  ).toHaveCount(1);
  await member.getByRole("button", { name: "תצוגת חודש" }).click();
  await member.getByRole("button", { name: "התורנויות שלי" }).click();
  await expect(end).toBeVisible();
  await member.getByRole("button", { name: "כל היחידה" }).click();

  await end.focus();
  await member.keyboard.press("Enter");
  await expect(member).toHaveURL(new RegExp(`/duties/${crossingId}$`));
  await expect(member.getByText("לילה חוצה חודש").first()).toBeVisible();
  await expect(member.getByText("לוח חייל").first()).toBeVisible();

  await member.setViewportSize({ width: 390, height: 844 });
  await member.goto("/calendar");
  await next.click();
  await next.click();
  await expect(startLink).toBeVisible();
  expect(
    await member.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await member.screenshot({
    path: "test-results/calendar-multiday-mobile.png",
    fullPage: true,
  });
  await member.getByRole("button", { name: "תצוגת רשימה" }).click();
  await expect(
    member
      .locator(".duty-row")
      .filter({ hasText: "לילה חוצה חודש" })
      .locator(".mobile-only")
  ).toBeVisible();
  await member.setViewportSize({ width: 1280, height: 900 });
  await member.getByRole("button", { name: "תצוגת חודש" }).click();
  await member.screenshot({
    path: "test-results/calendar-multiday.png",
    fullPage: true,
  });
  await context.close();
});
test("a soldier offers a published duty to several replacements and the first consent transfers it", async ({
  page,
  browser,
}) => {
  async function account(
    name: string,
    email: string,
    personalNumber: string,
    role: "manager" | "soldier"
  ) {
    const id = randomUUID();
    const data = soldier({ id, name, personalNumber });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(balances).values({ soldierId: id });
    await createInvitedAccount({ name, email, role, soldierId: id });
    return id;
  }
  await account(
    "העברה אחראי",
    "transfer-manager@example.invalid",
    "300001",
    "manager"
  );
  const ownerId = await account(
    "העברה מציע",
    "transfer-owner@example.invalid",
    "300002",
    "soldier"
  );
  await account(
    "העברה מחליף",
    "transfer-first@example.invalid",
    "300003",
    "soldier"
  );
  await account(
    "העברה נוסף",
    "transfer-second@example.invalid",
    "300004",
    "soldier"
  );
  await login(page, "transfer-manager@example.invalid");
  const api = async (
    type: string,
    payload: Record<string, unknown>,
    expectedVersion?: number
  ) => {
    const response = await page.request.post("/api/v1/actions", {
      headers: { origin: "http://127.0.0.1:3000" },
      data: { type, payload, expectedVersion, idempotencyKey: randomUUID() },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).result as { id: string; version: number };
  };
  const type = await api("dutyType.save", {
    name: "העברה לבדיקה",
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 1 }],
  });
  const start = DateTime.now()
    .setZone("Asia/Jerusalem")
    .plus({ days: 5 })
    .set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
  const created = await api("duty.create", {
    typeId: type.id,
    name: "שמירה להעברה",
    start: start.toISO(),
    end: start.plus({ hours: 8 }).toISO(),
    location: "שער סינתטי",
  });
  const state = await (await page.request.get("/api/v1/state")).json();
  const row = state.duties.find((d: { id: string }) => d.id === created.id);
  await api(
    "duty.assign",
    {
      dutyId: row.id,
      slotId: row.slots[0].id,
      soldierId: ownerId,
      callUpBonus: 3,
    },
    1
  );
  await api("duty.publish", { id: row.id, confirmed: true }, 2);

  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await login(owner, "transfer-owner@example.invalid");
  await owner.goto(`/duties/${row.id}`);
  await owner.getByRole("button", { name: "הצעה להעברה" }).click();
  const offer = owner.getByRole("dialog");
  await expect(offer.getByText("7 נקודות")).toBeVisible();
  await offer
    .getByLabel("למי להציע")
    .selectOption([{ label: "העברה מחליף" }, { label: "העברה נוסף" }]);
  await offer.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(offer).not.toBeVisible();
  await expect(owner.getByText("הצעת ההעברה שלך ממתינה להסכמה")).toBeVisible();

  const firstContext = await browser.newContext();
  const first = await firstContext.newPage();
  await login(first, "transfer-first@example.invalid");
  await first.goto("/requests");
  const incoming = first
    .locator(".task-item")
    .filter({ hasText: "שמירה להעברה — מאת העברה מציע" });
  await expect(incoming).toContainText("7 נקודות");
  await expect(first.getByText("העברה נוסף")).toHaveCount(0);
  await incoming.getByRole("button", { name: "הסכמה" }).click();
  const consent = first.getByRole("dialog");
  await consent.getByLabel("אני מסכים לקבל את התורנות").check();
  await consent.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(consent).not.toBeVisible();
  await expect(incoming.getByText("הושלמה")).toBeVisible();
  await first.goto(`/duties/${row.id}`);
  await expect(
    first.locator(".slot-row").filter({ hasText: "העברה מחליף" })
  ).toContainText("7 נקודות");

  await owner.goto("/requests");
  const outgoing = owner
    .locator(".task-item")
    .filter({ hasText: "שמירה להעברה" });
  await expect(outgoing.getByText("הושלמה")).toBeVisible();
  await expect(outgoing).toContainText("העברה מחליף: הסכים");
  await expect(outgoing).toContainText("העברה נוסף: נסגר");
  await owner.goto("/notifications");
  await expect(owner.getByText("ההעברה הושלמה")).toBeVisible();
  await owner.goto(`/duties/${row.id}`);
  await expect(owner.getByRole("button", { name: "הצעה להעברה" })).toHaveCount(
    0
  );

  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  await login(second, "transfer-second@example.invalid");
  await second.setViewportSize({ width: 390, height: 844 });
  await second.goto("/requests");
  await expect(
    second.locator(".task-item").filter({ hasText: "שמירה להעברה" })
  ).toContainText("נסגר");
  await expect(second.getByRole("button", { name: "הסכמה" })).toHaveCount(0);
  expect(
    await second.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await second.screenshot({
    path: "test-results/transfer-requests-mobile.png",
    fullPage: true,
  });

  await page.goto("/requests");
  await expect(
    page
      .locator(".task-item")
      .filter({ hasText: "שמירה להעברה: העברה מציע ← העברה מחליף" })
  ).toContainText("הושלמה");
  await page.screenshot({
    path: "test-results/transfer-requests-manager.png",
    fullPage: true,
  });
  await Promise.all([
    ownerContext.close(),
    firstContext.close(),
    secondContext.close(),
  ]);
});
