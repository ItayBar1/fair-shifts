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
import { soldier, testIdNumber } from "../fixtures";
import { signedInHome } from "./auth-submit";

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
    const data = soldier({ id, name });
    await db
      .insert(soldiers)
      .values({ id, name, idNumber: testIdNumber(personalNumber), data });
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
  await expect(page.getByRole("heading", { name: signedInHome })).toBeVisible();
}

test("manager gives dated or permanent capabilities and exemptions, an hours exemption among them, filters by them, and reviews the impact", async ({
  page,
}) => {
  const day = (offset: number) =>
    DateTime.now()
      .setZone("Asia/Jerusalem")
      .plus({ days: offset })
      .toISODate()!;
  await login(page, managerEmail);
  const dialog = page.getByRole("dialog");
  const conditions = "תנאי התאמה אישיים: מגדר";
  const entries = "כשירויות ופטורים";
  const openProfile = async (section: string) => {
    await page
      .getByRole("row")
      .filter({ hasText: "חיילת תנאים" })
      .getByRole("button", { name: "פרופיל ועריכה" })
      .click();
    await dialog.getByText(section, { exact: true }).click();
  };

  // The profile lists the soldier's entries and links to the screen that
  // assigns them, with the soldier already chosen (decision 226).
  await page.goto("/manage/soldiers");
  await openProfile(entries);
  await expect(dialog).toContainText("אין כשירויות או פטורים.");
  await expect(dialog.getByLabel("סוג מהקטלוג")).toHaveCount(0);
  await dialog.getByRole("link", { name: /שיוך כשירות או פטור/ }).click();
  await expect(page).toHaveURL(/\/manage\/eligibility\?soldier=/);

  await page.getByRole("button", { name: "הגדרה חדשה", exact: true }).click();
  await dialog.getByLabel("סוג ההגדרה").selectOption("capability");
  await dialog.getByLabel("שם", { exact: true }).fill("נשיאת משקל");
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.locator(".task-item").filter({ hasText: "נשיאת משקל" })
  ).toContainText("כשירות");
  await page.getByRole("button", { name: "הגדרה חדשה", exact: true }).click();
  await dialog.getByLabel("סוג ההגדרה").selectOption("exemption");
  await dialog.getByLabel("שם", { exact: true }).fill("פטור שמירות");
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  // An hours exemption carries its own window in the catalog.
  await page
    .getByRole("button", { name: "פטור שעות חדש", exact: true })
    .click();
  await dialog.getByLabel("שם הפטור").fill("פטור שעות ערב");
  await dialog.getByLabel("תחילת חלון 1").fill("17:00");
  await dialog.getByLabel("סיום חלון 1").fill("23:30");
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const hoursItem = page
    .locator(".task-item")
    .filter({ hasText: "פטור שעות ערב" });
  await expect(hoursItem).toContainText("פטור שעות");
  await expect(hoursItem).toContainText("17:00–23:30 · כל הימים");

  await page.goto("/manage/catalog");
  await page
    .getByRole("button", { name: "סוג תורנות חדש", exact: true })
    .click();
  await page.getByLabel("שם סוג התורנות").fill("סיור מותנה");
  await page.getByLabel("ניקוד בסיס").fill("4");
  await page.getByLabel("מגדר מותר", { exact: true }).selectOption(["female"]);
  await dialog
    .getByRole("group", { name: "כשירויות נדרשות לתפקיד 1" })
    .getByLabel("נשיאת משקל")
    .check();
  // An hours exemption applies to every duty; a type does not pick it.
  await expect(
    dialog.getByLabel("פטורים פוסלים").locator("option", {
      hasText: "פטור שעות ערב",
    })
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const [type] = await db.select().from(dutyTypes);
  const catalog = await db
    .select()
    .from(records)
    .where(eq(records.kind, "eligibility_catalog"));
  const capability = catalog.find((row) => row.data.kind === "capability")!;
  const hours = catalog.find((row) => row.data.name === "פטור שעות ערב")!;
  expect(hours.data.windows).toEqual([
    { startTime: "17:00", endTime: "23:30", weekdays: [1, 2, 3, 4, 5, 6, 7] },
  ]);
  expect(type.data.requirements).toMatchObject({ genders: ["female"] });
  expect(type.data.roles).toMatchObject([
    { requirements: { capabilityIds: [capability.id] } },
  ]);

  const [member] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.name, "חיילת תנאים"));
  await page.goto(`/manage/eligibility?soldier=${member.id}`);
  const assign = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "שיוך לחייל" }),
  });
  await expect(assign.getByLabel("חייל", { exact: true })).toHaveValue(
    member.id
  );
  // A capability from today with no end date is permanent (decision 224).
  const addEntry = async (label: string, start = "", end = "") => {
    await assign
      .getByLabel("סוג מהקטלוג", { exact: true })
      .selectOption({ label });
    await expect(assign.getByLabel("תחילת תוקף", { exact: true })).toHaveValue(
      day(0)
    );
    if (start) await assign.getByLabel("תחילת תוקף").fill(start);
    if (end) await assign.getByLabel("סיום תוקף (כולל)").fill(end);
    await assign.getByRole("button", { name: "בדיקת השפעת השיוך" }).click();
    const added = page.getByRole("region", { name: "השפעת התקופה החדשה" });
    await expect(added).toContainText(
      end ? "התקופה אינה משנה" : "קבוע, בלי תאריך סיום"
    );
    await added.getByLabel("בדקתי את ההשפעה ומאשר את הוספת התקופה").check();
    await added.getByRole("button", { name: "אישור הוספת התקופה" }).click();
    await expect(added).toHaveCount(0);
  };
  await addEntry("נשיאת משקל · כשירות");
  await addEntry("פטור שמירות · פטור", "", day(7));
  await addEntry("פטור שעות ערב · פטור שעות", day(1), day(10));
  const [withEntries] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, member.id));
  expect(withEntries.data.capabilities).toEqual([
    { capabilityId: capability.id, start: day(0) },
  ]);
  expect(withEntries.data.exemptions).toMatchObject([
    { start: day(0), end: day(7) },
    {
      exemptionId: hours.id,
      start: day(1),
      end: day(10),
      windows: hours.data.windows,
    },
  ]);

  await page.goto("/manage/soldiers");
  await openProfile(entries);
  await expect(
    dialog.locator(".history-row").filter({ hasText: "נשיאת משקל" })
  ).toContainText("קבוע, בלי תאריך סיום");
  await expect(
    dialog.locator(".history-row").filter({ hasText: "פטור שעות ערב" })
  ).toHaveCount(1);
  await dialog.getByText(conditions, { exact: true }).click();
  // Gender appears once, as the editable control; hours are no longer here.
  const genderControl = dialog.getByLabel("מגדר", { exact: true });
  await expect(genderControl).toHaveCount(1);
  await expect(genderControl).toHaveValue("");
  await expect(dialog.getByText("הוספת הגבלת שעות")).toHaveCount(0);
  await genderControl.selectOption("female");
  await dialog.getByRole("button", { name: "בדיקת השפעת השינוי" }).click();
  const first = dialog.getByRole("region", {
    name: "השפעת שינוי תנאי ההתאמה",
  });
  await expect(first).toContainText(
    "השינוי אינו משנה את ההתאמה של שיבוצים קיימים."
  );
  await first.getByLabel("בדקתי את ההשפעה ומאשר את שינוי תנאי ההתאמה").check();
  await first.getByRole("button", { name: "אישור שינוי התנאים" }).click();
  await expect(first).toHaveCount(0);
  await expect(genderControl).toHaveValue("female");

  // A reserved duty inside the window, then a narrower window in the catalog
  // reaches the soldier and flags the assignment for handling.
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
  const [beforeSave] = await db.select().from(assignments);
  expect(beforeSave.data.needsAttention ?? []).toEqual([]);
  await page.goto("/manage/eligibility");
  await hoursItem.getByRole("button", { name: "עריכת פטור שעות ערב" }).click();
  await expect(dialog.getByLabel("תחילת חלון 1")).toHaveValue("17:00");
  await dialog.getByLabel("סיום חלון 1").fill("22:00");
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(hoursItem).toContainText("17:00–22:00");
  const [flagged] = await db.select().from(assignments);
  expect(flagged.status).toBe("reserved");
  expect(flagged.data.needsAttention).toEqual(["allowed_hours"]);
  const [narrowed] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, member.id));
  expect(narrowed.data.exemptions[1].windows).toMatchObject([
    { startTime: "17:00", endTime: "22:00" },
  ]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "פטור שעות חדש", exact: true })
    .click();
  await expect(dialog.getByLabel("תחילת חלון 1")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.screenshot({
    path: "test-results/hours-exemption-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "ביטול", exact: true }).click();

  // The soldiers table, the fairness table and the catalog screen filter by
  // a capability or an exemption valid on a chosen day.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/manage/soldiers");
  const member_ = page.getByRole("row").filter({ hasText: "חיילת תנאים" });
  const validOn = page.getByLabel("בתוקף בתאריך");
  await page
    .getByLabel("סינון לפי כשירות")
    .selectOption({ label: "כשירות: נשיאת משקל" });
  await expect(validOn).toHaveValue(day(0));
  await expect(member_).toHaveCount(1);
  await expect(page.getByText("1 חיילים מוצגים")).toBeVisible();
  await validOn.fill(day(-1));
  await expect(member_).toHaveCount(0);
  await validOn.fill("");
  await expect(member_).toHaveCount(1);
  await page.getByLabel("סינון לפי כשירות").selectOption("");
  await page
    .getByLabel("סינון לפי פטור")
    .selectOption({ label: "פטור: פטור שמירות" });
  await validOn.fill(day(8));
  await expect(member_).toHaveCount(0);
  await validOn.fill(day(7));
  await expect(member_).toHaveCount(1);

  await page.goto("/fairness");
  await page
    .getByLabel("סינון לפי כשירות")
    .selectOption({ label: "כשירות: נשיאת משקל" });
  await expect(member_).toHaveCount(1);
  await page.getByLabel("בתוקף בתאריך").fill(day(-1));
  await expect(member_).toHaveCount(0);

  await page.goto("/manage/eligibility");
  const listed = page.locator(".subsection").filter({
    has: page.getByRole("heading", { name: "חיילת תנאים", exact: true }),
  });
  await expect(listed.locator(".history-row")).toHaveCount(3);
  await page
    .getByLabel("סינון לפי סוג מהקטלוג")
    .selectOption({ label: "פטור שמירות · פטור" });
  await expect(listed.locator(".history-row")).toHaveCount(1);
  await expect(listed).toContainText("פטור שמירות");
  await page
    .getByLabel("סינון לפי סוג מהקטלוג")
    .selectOption({ label: "פטור שעות ערב · פטור שעות" });
  await expect(listed.locator(".history-row")).toHaveCount(1);
});
