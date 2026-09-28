import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import { soldiers, balances } from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

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
test.afterAll(async () => pool.end());
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
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}
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
  await page.screenshot({
    path: "test-results/manager-duty.png",
    fullPage: true,
  });
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
  expect(managerState.assignments[0].needsAttention).toContain(
    "approved_constraint"
  );
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
  await api(
    "soldier.timeline",
    {
      soldierId: member.id,
      kind: "qualification",
      startDate: lateDate,
      endDate: lateDate,
      value: specialty.id,
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
  await soldierContext.close();
});
