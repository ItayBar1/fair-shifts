import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";
import { submitAuth } from "./auth-submit";

const managerEmail = "deletion-manager@example.invalid";
const phoneManagerEmail = "deletion-phone@example.invalid";
const leaverEmail = "deletion-soldier@example.invalid";
const staysEmail = "deletion-stays@example.invalid";
const ids: Record<string, string> = {};

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
  const people = [
    ["אחראי מחיקה", managerEmail, "manager", "000401"],
    ["אחראי בנייד", phoneManagerEmail, "manager", "000404"],
    ["חייל למחיקה", leaverEmail, "soldier", "000402"],
    ["חייל שנשאר", staysEmail, "soldier", "000403"],
  ] as const;
  for (const [name, email, role, personalNumber] of people) {
    const id = randomUUID();
    const data = soldier({ id, name, personalNumber });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(soldierContacts).values({
      soldierId: id,
      email,
      phone: `0504${personalNumber}`,
      address: "רחוב הדגמה 1",
    });
    await db.insert(balances).values({ soldierId: id });
    await createInvitedAccount({ name, email, role, soldierId: id });
    ids[email] = id;
  }
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await submitAuth(
    page,
    "/api/auth/request-code",
    page.getByRole("button", { name: "שליחת קוד למייל" })
  );
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [account] = await db.select().from(user).where(eq(user.email, email));
  const [message] = (
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, account.id))
  ).filter((row) => row.kind === "login-code");
  await page
    .getByLabel("קוד כניסה", { exact: true })
    .fill(openSecret(message.encryptedSecret!));
  await submitAuth(
    page,
    "/api/auth/verify-code",
    page.getByRole("button", { name: "כניסה לחשבון", exact: true })
  );
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}

test("the manager sees what a deletion does, deletes the user, and the seat becomes vacant with a warning", async ({
  page,
  browser,
}) => {
  await login(page, managerEmail);
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
    name: "שמירת מחיקה",
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 2 }],
  });
  const created = await api("duty.create", {
    typeId: type.id,
    name: "תורנות עתידית למחיקה",
    start: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    end: new Date(Date.now() + 4 * 86_400_000).toISOString(),
    location: "אתר מחיקה",
  });
  const state = await (await page.request.get("/api/v1/state")).json();
  const row = state.duties.find((d: { id: string }) => d.id === created.id);
  await api(
    "duty.assign",
    { dutyId: row.id, slotId: row.slots[0].id, soldierId: ids[leaverEmail] },
    1
  );
  await api(
    "duty.assign",
    { dutyId: row.id, slotId: row.slots[1].id, soldierId: ids[staysEmail] },
    2
  );
  await api("duty.publish", { id: row.id, confirmed: true }, 3);

  // The soldier is signed in on another device.
  const soldierContext = await browser.newContext();
  const member = await soldierContext.newPage();
  await login(member, leaverEmail);

  await page.goto("/manage/soldiers");
  await page
    .locator("tr", { hasText: "חייל למחיקה" })
    .getByRole("button", { name: "פרופיל ועריכה" })
    .click();
  const profile = page.getByRole("dialog", { name: /פרופיל חייל/ });
  await profile.getByText("ניהול כתובת מייל וחשבון").click();
  await profile
    .getByRole("button", { name: "מחיקת המשתמש והמידע הרגיש" })
    .click();

  // The impact view comes first: what stays, what goes and which seat is vacated.
  const dialog = page.getByRole("dialog", { name: /מחיקת משתמש/ });
  await expect(dialog.getByText("מקומות עתידיים שיתפנו")).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "תורנות עתידית למחיקה" })
  ).toBeVisible();
  await expect(
    dialog.getByRole("region", { name: "מה נשמר" }).getByText("שם ומספר אישי")
  ).toBeVisible();
  await expect(
    dialog.getByRole("region", { name: "מה יוסר" }).getByText(/פרטי קשר/)
  ).toBeVisible();
  // Nothing is saved before the confirmation.
  expect(
    (
      await db.select().from(soldiers).where(eq(soldiers.id, ids[leaverEmail]))
    )[0].deletedAt
  ).toBeNull();
  await dialog.getByLabel("סיבת המחיקה").fill("שוחרר מהשירות");
  await page.screenshot({
    path: "test-results/soldier-deletion-impact.png",
    fullPage: false,
  });
  // The confirmation is required.
  await dialog
    .getByRole("button", { name: "מחיקת המשתמש", exact: true })
    .click();
  expect(
    (
      await db.select().from(soldiers).where(eq(soldiers.id, ids[leaverEmail]))
    )[0].deletedAt
  ).toBeNull();
  await dialog.getByLabel(/בדקתי את ההשפעה/).check();
  await dialog
    .getByRole("button", { name: "מחיקת המשתמש", exact: true })
    .click();
  await expect(dialog).toBeHidden();

  // The soldier leaves the list, the seat is vacant, and the managers are warned.
  await expect(page.locator("tr", { hasText: "חייל למחיקה" })).toHaveCount(0);
  const [deleted] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, ids[leaverEmail]));
  expect(deleted.deletedAt).not.toBeNull();
  expect(deleted.name).toBe("חייל למחיקה");
  const seats = await db
    .select()
    .from(assignments)
    .where(eq(assignments.soldierId, ids[leaverEmail]));
  expect(seats.map((seat) => seat.status)).toEqual(["cancelled"]);
  await page.goto("/notifications");
  await expect(
    page.getByText("נמחק חייל: נדרש טיפול במקומות פנויים")
  ).toBeVisible();
  await page.goto(`/duties/${row.id}`);
  await expect(page.getByText("חייל שנשאר").first()).toBeVisible();

  // The audit log keeps the event and the reason it was given.
  await page.goto("/manage/audit");
  await expect(page.getByText("מחיקת משתמש").first()).toBeVisible();
  await expect(page.getByText("שוחרר מהשירות").first()).toBeVisible();

  // The session that was open is refused at once, and no new code is sent.
  await member.goto("/calendar");
  await expect(member.getByLabel("כתובת המייל המאושרת")).toBeVisible();
  const before = (
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, "login-code"))
  ).length;
  await member.getByLabel("כתובת המייל המאושרת").fill(leaverEmail);
  await member.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect
    .poll(
      async () =>
        (
          await db
            .select()
            .from(emailOutbox)
            .where(eq(emailOutbox.kind, "login-code"))
        ).length
    )
    .toBe(before);
  await soldierContext.close();
});

test("the deletion screen fits a phone and a manager cannot delete their own record", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Another manager: a sign-in code can be requested once a minute per account.
  await login(page, phoneManagerEmail);
  await page.goto("/manage/soldiers");
  await page
    .locator("tr", { hasText: "חייל שנשאר" })
    .getByRole("button", { name: "פרופיל ועריכה" })
    .click();
  const profile = page.getByRole("dialog", { name: /פרופיל חייל/ });
  await profile.getByText("ניהול כתובת מייל וחשבון").click();
  await profile
    .getByRole("button", { name: "מחיקת המשתמש והמידע הרגיש" })
    .click();
  const dialog = page.getByRole("dialog", { name: /מחיקת משתמש/ });
  // He still holds the seat of the duty from the first test, so it is listed.
  await expect(dialog.getByText("מקומות עתידיים שיתפנו")).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "תורנות עתידית למחיקה" })
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const dialogOverflow = await dialog.evaluate(
    (node) => node.scrollWidth - node.clientWidth
  );
  expect(dialogOverflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "test-results/soldier-deletion-mobile.png",
    fullPage: false,
  });
  await dialog.getByRole("button", { name: "ביטול" }).click();
  await expect(dialog).toBeHidden();
  // Nothing was deleted by looking.
  expect(
    (
      await db.select().from(soldiers).where(eq(soldiers.id, ids[staysEmail]))
    )[0].deletedAt
  ).toBeNull();
  // The API refuses a deletion of the manager's own record, whatever the screen shows.
  const response = await page.request.post("/api/v1/actions", {
    headers: { origin: "http://127.0.0.1:3000" },
    data: {
      type: "soldier.delete.preview",
      payload: { id: ids[phoneManagerEmail] },
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.status()).toBe(403);
});
