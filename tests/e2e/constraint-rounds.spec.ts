import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import { soldiers, balances } from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

const people = [
  ["אחראי ראשון", "first-manager@example.invalid", "manager", "100001"],
  ["אחראי שני", "second-manager@example.invalid", "manager", "100002"],
  ["חייל סבב", "round-member@example.invalid", "soldier", "100003"],
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
    await db.insert(balances).values({ soldierId: id });
    await createInvitedAccount({ name, email, role, soldierId: id });
  }
});
// The pool is shared by every spec in the worker; the worker exit closes it.

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [person] = await db.select().from(user).where(eq(user.email, email));
  const [message] = (
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, person.id))
  ).filter((row) => row.kind === "login-code");
  await page
    .getByLabel("קוד כניסה", { exact: true })
    .fill(openSecret(message.encryptedSecret!));
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
  return page;
}

test("constraint round: direct declaration, shared decision, stale approval, close and reopen", async ({
  browser,
}) => {
  const zone = "Asia/Jerusalem";
  const today = DateTime.now().setZone(zone);
  const target = today.plus({ days: 5 }).toISODate()!;
  const first = await signedIn(browser, people[0][1]);
  const member = await signedIn(browser, people[2][1]);

  await first.goto("/manage/constraints");
  await first.getByRole("button", { name: "פתיחת סבב" }).click();
  await first.getByLabel("שם הסבב").fill("סבב גבולות");
  await first
    .getByLabel("פתיחת הגשות")
    .fill(`${today.minus({ days: 1 }).toISODate()}T08:00`);
  await first
    .getByLabel("סגירת הגשות")
    .fill(`${today.plus({ days: 2 }).toISODate()}T20:00`);
  await first.getByLabel("תחילת תקופת יעד").fill(target);
  await first.getByLabel("סיום תקופת יעד").fill(target);
  await first
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(first.getByRole("dialog")).not.toBeVisible();
  await expect(first.getByText("פתוח להגשה")).toBeVisible();

  // "No constraints" completes the submission without manager review.
  await member.goto("/constraints");
  await member.getByLabel("בחירת סבב").selectOption({ label: "סבב גבולות" });
  await member.getByLabel("אין לי אילוצים").check();
  await expect(member.getByText("נרשמת מיד כהשלמת ההגשה")).toBeVisible();
  await member.getByRole("button", { name: "שליחת הגשה" }).click();
  await expect(
    member.getByText("הוגש: אין לי אילוצים. נרשם ללא צורך באישור אחראי.")
  ).toBeVisible();
  await expect(member.getByText("ההגשה שלך לסבב זה נרשמה")).toBeVisible();
  await first.reload();
  await expect(
    first.getByText("הגישו: 1 · מתוכם ״אין לי אילוצים״: 1")
  ).toBeVisible();
  await expect(
    first.getByRole("button", { name: "אישור", exact: true })
  ).toHaveCount(0);

  // A later range replaces the declaration and waits for review.
  await member.getByLabel("אין לי אילוצים").uncheck();
  await member.getByLabel("מיום", { exact: true }).fill(target);
  await member.getByLabel("עד יום (כולל)").fill(target);
  await member.getByLabel("סיבת האילוץ").fill("אילוץ לסבב הגבולות");
  await member.getByRole("button", { name: "שליחת הגשה" }).click();
  await expect(member.getByText(/^ממתין:.*אילוץ לסבב הגבולות/)).toBeVisible();

  // The first manager opens an approval; the second manager decides first.
  await first.reload();
  await expect(first.getByText("הגישו: 1", { exact: true })).toBeVisible();
  await first.getByRole("button", { name: "אישור", exact: true }).click();
  await expect(first.getByRole("dialog")).toContainText(
    "לא נמצאו שיבוצים המתנגשים"
  );
  const second = await signedIn(browser, people[1][1]);
  await second.goto("/manage/constraints");
  await second.getByRole("button", { name: "דחיית השינוי" }).click();
  await second.getByLabel("סיבת ההחלטה").fill("אין הצדקה מספקת");
  await second
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(second.getByRole("dialog")).not.toBeVisible();
  await expect(second.getByText(/^הוחלט בידי אחראי שני/)).toBeVisible();

  await first.getByLabel("בדקתי את השפעת האישור").check();
  await first
    .getByRole("button", { name: "אישור האילוץ", exact: true })
    .click();
  await expect(first.getByText("המידע השתנה").first()).toBeVisible();
  await first.reload();
  await expect(first.getByText(/^הוחלט בידי אחראי שני/)).toBeVisible();
  await expect(first.getByText("סיבת הדחייה: אין הצדקה מספקת")).toBeVisible();

  await member.reload();
  await expect(member.getByText("סיבת הדחייה: אין הצדקה מספקת")).toBeVisible();
  await expect(member.getByText(/^נדחה:.*אילוץ לסבב הגבולות/)).toBeVisible();
  await expect(member.getByText(/הוחלט בידי/)).toHaveCount(0);

  // Closing stops self-service; reopening is shown to everyone.
  await first.getByRole("button", { name: "סגירת הגשות" }).click();
  await expect(
    first.getByText(/^ההגשה נסגרה ב־.*בידי אחראי ראשון$/)
  ).toBeVisible();
  await member.reload();
  await expect(member.getByText("נסגר", { exact: true })).toBeVisible();
  await expect(member.getByRole("option", { name: "סבב גבולות" })).toHaveCount(
    0
  );
  await expect(
    member.getByRole("button", { name: "עריכת האילוץ" })
  ).toHaveCount(0);
  await first.getByRole("button", { name: "פתיחה מחדש" }).click();
  await first
    .getByLabel("מועד סגירה חדש")
    .fill(`${today.plus({ days: 3 }).toISODate()}T20:00`);
  await first
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(
    first.getByText(/^נפתח מחדש ב־.*בידי אחראי ראשון$/)
  ).toBeVisible();
  await member.reload();
  await expect(member.getByText(/^נפתח מחדש ב־/)).toBeVisible();
  await expect(member.getByText(/בידי אחראי/)).toHaveCount(0);
  await member.getByLabel("בחירת סבב").selectOption({ label: "סבב גבולות" });
  await expect(
    member.getByRole("button", { name: "עריכת האילוץ" }).first()
  ).toBeVisible();
  await member.setViewportSize({ width: 390, height: 844 });
  await member.screenshot({
    path: "test-results/constraint-round-mobile.png",
    fullPage: true,
  });
  await first.screenshot({
    path: "test-results/constraint-round-manager.png",
    fullPage: true,
  });
});
