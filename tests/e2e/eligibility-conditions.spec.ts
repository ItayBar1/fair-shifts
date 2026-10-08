import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  soldiers,
  balances,
  dutyTypes,
  dutySlots,
  assignments,
  records,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

const managerEmail = "conditions-manager@example.invalid";
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
  for (const [name, personalNumber, email] of [
    ["אחראית תנאים", "300001", managerEmail],
    ["חיילת תנאים", "300002", undefined],
  ] as const) {
    const id = randomUUID();
    const data = soldier({ id, name, personalNumber });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(balances).values({ soldierId: id });
    if (email)
      await createInvitedAccount({
        name,
        email,
        role: "manager",
        soldierId: id,
      });
  }
});
// The pool is shared by every spec in the worker; the worker exit closes it.
async function login(page: Page, email: string) {
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
  )
    .filter((row) => row.kind === "login-code")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  await page.getByLabel("קוד כניסה", { exact: true }).fill(
    openSecret(message.encryptedSecret!, {
      purpose: "mail-code",
      recordId: message.id,
    })
  );
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}

test("manager defines gender and capability conditions and reviews personal hours impact before saving", async ({
  page,
}) => {
  const day = (offset: number) =>
    DateTime.now()
      .setZone("Asia/Jerusalem")
      .plus({ days: offset })
      .toISODate()!;
  await login(page, managerEmail);

  await page.goto("/manage/eligibility");
  await page.getByRole("button", { name: "הגדרה חדשה", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("סוג ההגדרה").selectOption("capability");
  await dialog.getByLabel("שם", { exact: true }).fill("נשיאת משקל");
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.locator(".task-item").filter({ hasText: "נשיאת משקל" })
  ).toContainText("יכולת");
  // Capabilities belong to the profile, not to dated period assignment.
  await expect(
    page.getByLabel("סוג מהקטלוג", { exact: true }).locator("option", {
      hasText: "נשיאת משקל",
    })
  ).toHaveCount(0);

  await page.goto("/manage/catalog");
  await page
    .getByRole("button", { name: "סוג תורנות חדש", exact: true })
    .click();
  await page.getByLabel("שם סוג התורנות").fill("סיור מותנה");
  await page.getByLabel("ניקוד בסיס").fill("4");
  await page.getByLabel("מגדר מותר", { exact: true }).selectOption(["female"]);
  await dialog
    .getByRole("group", { name: "יכולות נדרשות לתפקיד 1" })
    .getByLabel("נשיאת משקל")
    .check();
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const [type] = await db.select().from(dutyTypes);
  const [capability] = await db
    .select()
    .from(records)
    .where(eq(records.kind, "eligibility_catalog"));
  expect(type.data.requirements).toMatchObject({ genders: ["female"] });
  expect(type.data.roles).toMatchObject([
    { requirements: { capabilityIds: [capability.id] } },
  ]);

  await page.goto("/manage/soldiers");
  const openProfile = async () => {
    await page
      .getByRole("row")
      .filter({ hasText: "חיילת תנאים" })
      .getByRole("button", { name: "פרופיל ועריכה" })
      .click();
    await dialog.getByText("תנאי התאמה אישיים: מגדר, יכולות ושעות").click();
  };
  await openProfile();
  await expect(dialog).toContainText("לא הוזן");
  await dialog.getByLabel("מגדר", { exact: true }).selectOption("female");
  await dialog.getByLabel("נשיאת משקל").check();
  await dialog.getByRole("button", { name: "הוספת הגבלת שעות" }).click();
  const limit = dialog.getByRole("group", { name: "הגבלת שעות 1" });
  await limit.getByLabel("בתוקף מתאריך").fill(day(1));
  await limit.getByLabel("עד תאריך (כולל)").fill(day(10));
  await limit.getByLabel("תחילת חלון 1").fill("17:00");
  await limit.getByLabel("סיום חלון 1").fill("23:30");
  await dialog.getByRole("button", { name: "בדיקת השפעת השינוי" }).click();
  const first = dialog.getByRole("region", {
    name: "השפעת שינוי תנאי ההתאמה",
  });
  await expect(first).toContainText(
    "השינוי אינו משנה את ההתאמה של שיבוצים קיימים."
  );
  const [member] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.name, "חיילת תנאים"));
  expect(member.data.gender).toBeUndefined();
  await first.getByLabel("בדקתי את ההשפעה ומאשר את שינוי תנאי ההתאמה").check();
  await first.getByRole("button", { name: "אישור שינוי התנאים" }).click();
  await expect(first).toHaveCount(0);
  await expect(dialog).toContainText("נקבה");
  await expect(dialog).toContainText("17:00–23:30 · כל הימים");

  // A reserved duty inside the window, then a narrower window that excludes it.
  const [account] = await db
    .select()
    .from(user)
    .where(eq(user.email, managerEmail));
  const actor: Actor = {
    id: account.id,
    name: account.name,
    role: "manager",
    soldierId: account.soldierId!,
    securityEpoch: account.securityEpoch,
  };
  const run = (
    type: string,
    payload: Record<string, unknown>,
    expectedVersion?: number
  ) =>
    executeAction(actor, {
      type,
      payload,
      expectedVersion,
      idempotencyKey: randomUUID(),
    }) as Promise<{ id: string }>;
  const created = await run("duty.create", {
    typeId: type.id,
    name: "סיור ערב",
    start: `${day(3)}T18:00`,
    end: `${day(3)}T23:00`,
  });
  const [slot] = await db
    .select()
    .from(dutySlots)
    .where(eq(dutySlots.dutyId, created.id));
  await run(
    "duty.assign",
    {
      dutyId: created.id,
      slotId: slot.id,
      soldierId: member.id,
    },
    1
  );
  await page.reload();
  await openProfile();
  await dialog
    .getByRole("group", { name: "הגבלת שעות 1" })
    .getByLabel("סיום חלון 1")
    .fill("22:00");
  await dialog.getByLabel("הערת אחראי לשינוי").fill("עדכון שעות סינתטי");
  await dialog.getByRole("button", { name: "בדיקת השפעת השינוי" }).click();
  const second = dialog.getByRole("region", {
    name: "השפעת שינוי תנאי ההתאמה",
  });
  await expect(second).toContainText("סיור ערב");
  await expect(second).toContainText("דורש טיפול");
  await expect(second).toContainText("התורנות חורגת מטווח השעות המותר");
  await second.screenshot({ path: "test-results/conditions-impact.png" });
  const [beforeSave] = await db.select().from(assignments);
  expect(beforeSave.data.needsAttention ?? []).toEqual([]);
  await second.getByLabel("בדקתי את ההשפעה ומאשר את שינוי תנאי ההתאמה").check();
  await second.getByRole("button", { name: "אישור שינוי התנאים" }).click();
  await expect(second).toHaveCount(0);
  await expect(dialog).toContainText("17:00–22:00 · כל הימים");
  const [flagged] = await db.select().from(assignments);
  expect(flagged.status).toBe("reserved");
  expect(flagged.data.needsAttention).toEqual(["allowed_hours"]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toContainText("הגבלת שעות");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.screenshot({
    path: "test-results/conditions-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});
