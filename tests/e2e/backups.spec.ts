import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  user,
  emailOutbox,
  backupRun,
  loginCode,
  operationsState,
} from "../../src/server/auth-schema";
import { records } from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";

// The E2E environment enables directory backups (compose.yaml); no worker runs,
// so the runs below are seeded as the worker would have left them.
const TECHNICAL = "backup-e2e-technical@example.invalid";
let technicalId: string;

test.beforeAll(async () => {
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error("E2E requires a dedicated test database");
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results, backup_run cascade`
  );
  const account = await createInvitedAccount({
    name: "טכני גיבוי",
    email: TECHNICAL,
    role: "technical",
  });
  technicalId = account.id;
  const now = Date.now();
  await db.insert(backupRun).values([
    {
      id: randomUUID(),
      key: "daily:2026-09-27",
      trigger: "daily",
      status: "verified",
      attempts: 1,
      storageKind: "directory",
      storageId: "synthetic-1",
      fileName: "fair-shifts-synthetic-1.dump.age",
      sizeBytes: 3 * 1024 * 1024,
      finishedAt: new Date(now - 2 * 3600_000),
      createdAt: new Date(now - 2 * 3600_000),
    },
    {
      id: randomUUID(),
      key: "daily:2026-09-28",
      trigger: "daily",
      status: "failed",
      attempts: 3,
      errorCode: "upload_failed",
      finishedAt: new Date(now - 3600_000),
      createdAt: new Date(now - 3600_000),
      alertedAt: new Date(now - 3600_000),
    },
  ]);
  await db.insert(records).values({
    id: randomUUID(),
    kind: "notification",
    data: {
      accountId: technicalId,
      title: "הגיבוי נכשל",
      body: "העלאת הקובץ או אימות שלמותו נכשלו. הגיבוי היומי לא הושלם אחרי 3 ניסיונות. יש לבדוק במסך הגיבוי.",
      href: "/technical/backups",
      code: "upload_failed",
    },
  });
});

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
  )
    .filter((row) => row.kind === "login-code")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  await page
    .getByLabel("קוד כניסה", { exact: true })
    .fill(openSecret(message.encryptedSecret!));
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "תמונת מצב", exact: true })
  ).toBeVisible();
}
const panel = (page: Page, title: string) =>
  page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });

test("technical account sees backup status, failures and alerts, and requests a backup once", async ({
  page,
}) => {
  await login(page, TECHNICAL);
  const health = panel(page, "מצב המערכת");
  await expect(health.getByText("גיבוי אחרון")).toBeVisible();
  await expect(health.getByText("עדכני")).toBeVisible();
  // No restore drill yet, and the first backup is young: nothing is overdue (decision 199).
  const drillRow = health.locator(".task-item", {
    hasText: "תרגיל שחזור אחרון",
  });
  await expect(drillRow.getByText("טרם בוצע")).toBeVisible();
  await expect(drillRow.getByText("אין תרגיל מוצלח")).toBeVisible();

  // The alert arrives in the technical account's own notification center.
  await expect(
    page.getByRole("link", { name: "הודעות", exact: false }).first()
  ).toBeVisible();
  await page.goto("/notifications");
  const inbox = panel(page, "מרכז הודעות");
  await expect(inbox.getByText("הגיבוי נכשל")).toBeVisible();
  await expect(inbox.getByText("אחרי 3 ניסיונות")).toBeVisible();
  await inbox.getByRole("button", { name: "סימון כנקראה" }).click();
  await expect(inbox.getByRole("button", { name: "סימון כנקראה" })).toHaveCount(
    0
  );
  await inbox.getByRole("link", { name: "פתיחת הפרטים" }).click();
  await expect(page).toHaveURL(/\/technical\/backups$/);

  const status = panel(page, "גיבוי יומי מוצפן");
  await expect(status.getByText("תיקייה מקומית (בדיקות)")).toBeVisible();
  await expect(status.getByText("מוגדר", { exact: true })).toHaveCount(2);
  await expect(status.getByText("כל יום ב־03:30 שעון ישראל")).toBeVisible();
  await expect(status.getByText("1 מתוך עד 30")).toBeVisible();
  const history = panel(page, "ריצות אחרונות");
  await expect(history.getByRole("row")).toHaveCount(3);
  await expect(history.getByText("אומת", { exact: true })).toBeVisible();
  await expect(history.getByText("3.0 MB")).toBeVisible();
  await expect(
    history.getByText("העלאת הקובץ או אימות שלמותו נכשלו")
  ).toBeVisible();

  await status.getByRole("button", { name: "גיבוי עכשיו" }).click();
  await expect(status.getByText("גיבוי ממתין או רץ כעת.")).toBeVisible();
  await expect(status.getByRole("button", { name: "גיבוי עכשיו" })).toHaveCount(
    0
  );
  await expect(history.getByText("ממתין", { exact: true })).toBeVisible();
  await expect(history.getByText("ידני", { exact: true })).toBeVisible();
  const manual = await db
    .select()
    .from(backupRun)
    .where(eq(backupRun.trigger, "manual"));
  expect(manual).toHaveLength(1);
  expect(manual[0]).toMatchObject({
    status: "pending",
    requestedBy: technicalId,
  });

  // The operations email switch is offered to the technical account.
  await page.goto("/settings");
  await expect(
    page.getByLabel("מייל: תקלות תפעול, כמו גיבוי שנכשל")
  ).toBeChecked();
  // So is the notice that the system was restored from a backup (decision 199).
  await expect(
    page.getByLabel("מייל: שחזור המערכת מגיבוי (לאחראים ולטכני)")
  ).toBeChecked();
});

test("the restore drill row shows how long ago a backup was restored and checked end to end", async ({
  page,
}) => {
  const ago = (days: number) =>
    new Date(Date.now() - days * 86_400_000).toISOString();
  const save = (data: Record<string, unknown>) =>
    db
      .insert(operationsState)
      .values({ key: "restore-drill", data })
      .onConflictDoUpdate({ target: operationsState.key, set: { data } });
  await save({
    lastPassedAt: ago(120),
    restorePoint: ago(120),
    lastAttemptAt: ago(1),
    lastOutcome: "failed",
  });
  // The previous test asked for a code a moment ago; a new request would wait a minute.
  await db.delete(loginCode).where(eq(loginCode.userId, technicalId));
  await login(page, TECHNICAL);
  const row = panel(page, "מצב המערכת").locator(".task-item", {
    hasText: "תרגיל שחזור אחרון",
  });
  await expect(row.getByText("באיחור: 120 ימים")).toBeVisible();
  await expect(row.getByText("הניסיון האחרון נכשל")).toBeVisible();
  await page.screenshot({
    path: "test-results/restore-drill-overdue.png",
    fullPage: true,
  });

  // A drill that ended on the deletion log is not a failure of the data, but it is shown.
  await save({
    lastPassedAt: ago(10),
    lastAttemptAt: ago(1),
    lastOutcome: "needs_deletion_log",
  });
  await page.reload();
  await expect(
    row.getByText("יומן המחיקות לא אומת בניסיון האחרון")
  ).toBeVisible();
  await expect(row.getByText("הניסיון האחרון נכשל")).toHaveCount(0);

  await save({ lastPassedAt: ago(10), restorePoint: ago(11) });
  await page.reload();
  await expect(row.getByText("תקין", { exact: true })).toBeVisible();
  await expect(row.getByText("הצליח")).toBeVisible();
  await expect(row.getByText("הניסיון האחרון נכשל")).toHaveCount(0);
});
