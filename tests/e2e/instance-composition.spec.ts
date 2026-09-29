import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  soldiers,
  balances,
  duties,
  dutyTypes,
  assignments,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

const managerEmail = "composition-manager@example.invalid";
let manager: Actor;
const people: Record<string, string> = {};
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
  for (const [name, personalNumber] of [
    ["אחראי הרכב", "400001"],
    ["תורן ראשון", "400002"],
    ["תורן שני", "400003"],
  ] as const) {
    const id = randomUUID();
    const data = soldier({ id, name, personalNumber });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(balances).values({ soldierId: id });
    people[name] = id;
  }
  const account = await createInvitedAccount({
    name: "אחראי הרכב",
    email: managerEmail,
    role: "manager",
    soldierId: people["אחראי הרכב"],
  });
  manager = {
    id: account.id,
    name: account.name,
    role: "manager",
    soldierId: account.soldierId!,
    securityEpoch: 1,
  };
});
async function command(
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) {
  return (await executeAction(manager, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as { id: string; version: number };
}
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
  await page
    .getByLabel("קוד כניסה", { exact: true })
    .fill(openSecret(message.encryptedSecret!));
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}

test("manager reduces an instance's quota, releases a seat explicitly and changes its pricing before update and publish", async ({
  page,
}) => {
  const type = await command("dutyType.save", {
    name: "אבט״ש סינתטי",
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "שומר", count: 2 }],
  });
  let start = DateTime.now()
    .setZone("Asia/Jerusalem")
    .plus({ days: 10 })
    .set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
  while (start.offset !== start.plus({ hours: 36 }).offset)
    start = start.plus({ days: 1 });
  const duty = await command("duty.create", {
    typeId: type.id,
    name: "אבט״ש לבדיקת הרכב",
    start: start.toISO(),
    end: start.plus({ hours: 36 }).toISO(),
  });
  const [row] = await db.select().from(duties).where(eq(duties.id, duty.id));
  await command(
    "duty.assign",
    {
      dutyId: duty.id,
      slotId: row.data.slots[0]!.id,
      soldierId: people["תורן ראשון"],
    },
    1
  );
  await command(
    "duty.assign",
    {
      dutyId: duty.id,
      slotId: row.data.slots[1]!.id,
      soldierId: people["תורן שני"],
    },
    2
  );
  await command("duty.publish", { id: duty.id, confirmed: true }, 3);

  await login(page, managerEmail);
  await page.goto(`/duties/${duty.id}`);
  await page.getByRole("button", { name: "יצירת הצעת שינוי" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("סיבת השינוי")
    .fill("צמצום ותמחור יומי");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  await page.getByRole("button", { name: "עריכת הרכב ותמחור למופע" }).click();
  const editor = page.getByRole("dialog", { name: "הרכב ותמחור למופע זה" });
  await editor.getByLabel("אופן התמחור במופע").selectOption("daily");
  await editor.getByLabel("ניקוד בסיס במופע").fill("4");
  await editor.getByLabel("מכסה").fill("1");
  await expect(editor).toContainText("יש לבחור 1 לשחרור");
  await editor.getByRole("button", { name: "הוספת תוספת זמן" }).click();
  await editor.getByLabel("שם התוספת").fill("לילה");
  await editor.getByLabel("נקודות").fill("0.25");
  await editor.getByLabel("תורן שני (שומר)").check();
  await expect(editor).not.toContainText("לשחרור.");
  await editor.screenshot({ path: "test-results/instance-composition.png" });
  await editor
    .getByRole("button", { name: "שמירת ההרכב והתמחור בהצעה" })
    .click();
  await expect(editor).not.toBeVisible();

  await page.getByRole("button", { name: "בדיקת השפעת השינוי" }).click();
  const comparison = page.getByRole("dialog", {
    name: "השוואה לפני עדכן ופרסם",
  });
  await expect(comparison).toContainText("שומר ×2");
  await expect(comparison).toContainText("שומר ×1");
  await expect(comparison).toContainText("4 ל־24 שעות");
  await expect(comparison).toContainText("השיבוץ יוסר");
  // 36 hours at 4 per day = 6, plus two nights at 0.25, rounded once to 7.
  const seat = comparison.getByRole("row").filter({ hasText: "תורן ראשון" });
  await expect(seat.last()).toContainText("6.5");
  await expect(seat.last().getByRole("cell").last()).toHaveText("7");
  await comparison.screenshot({
    path: "test-results/instance-composition-preview.png",
  });
  await comparison
    .getByLabel("בדקתי את השינויים, הסרת השיבוצים והניקוד ומאשר לפרסם")
    .check();
  await comparison.getByRole("button", { name: "עדכן ופרסם" }).click();
  await expect(comparison).not.toBeVisible();

  const reserved = (await db.select().from(assignments)).filter(
    (item) => item.status === "reserved"
  );
  expect(reserved.map((item) => [item.soldierId, item.points])).toEqual([
    [people["תורן ראשון"], 7],
  ]);
  const [catalog] = await db
    .select()
    .from(dutyTypes)
    .where(eq(dutyTypes.id, type.id));
  expect(catalog.data.roles).toEqual([{ name: "שומר", count: 2 }]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "יצירת הצעת שינוי" }).click();
  await page.getByRole("dialog").getByLabel("סיבת השינוי").fill("בדיקת נייד");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "שמירה", exact: true })
    .click();
  await page.getByRole("button", { name: "עריכת הרכב ותמחור למופע" }).click();
  await expect(editor).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await editor.screenshot({
    path: "test-results/instance-composition-mobile.png",
  });
});
