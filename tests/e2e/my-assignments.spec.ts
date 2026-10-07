import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
  dutySlots,
  dutyTypes,
  soldiers,
} from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { assignment, duty, soldier } from "../fixtures";

let dutyId: string;
let assignmentId: string;
let ownMail: string;
let foreignMail: string;
const memberEmail = "my-assignments-member@example.invalid";
const managerEmail = "my-assignments-manager@example.invalid";

async function invite(
  name: string,
  email: string,
  role: "soldier" | "manager"
) {
  const soldierId = randomUUID();
  await db.insert(soldiers).values({
    id: soldierId,
    name,
    personalNumber: randomUUID(),
    data: soldier({ id: soldierId, name }),
  });
  await db.insert(balances).values({ soldierId });
  return createInvitedAccount({ name, email, role, soldierId });
}
test.beforeAll(async () => {
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error("E2E requires a dedicated *_test database");
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  const member = await invite("חייל בדיקה", memberEmail, "soldier");
  const manager = await invite("אחראי בדיקה", managerEmail, "manager");
  const other = await invite(
    "חייל נוסף",
    "my-assignments-other@example.invalid",
    "soldier"
  );
  dutyId = randomUUID();
  assignmentId = randomUUID();
  ownMail = randomUUID();
  foreignMail = randomUUID();
  const typeId = randomUUID(),
    slotId = randomUUID();
  const start = new Date(Date.now() + 2 * 86400_000).toISOString();
  const end = new Date(Date.now() + 3 * 86400_000).toISOString();
  const data = {
    ...duty({
      id: dutyId,
      typeId,
      start,
      end,
      slots: [{ id: slotId, role: "תורן שער" }],
    }),
    name: "שמירת שער",
    location: "שער ראשי",
    instructions: "",
  };
  await db
    .insert(dutyTypes)
    .values({ id: typeId, name: "סוג בדיקה", data: {} });
  await db.insert(duties).values({ id: dutyId, typeId, name: data.name, data });
  await db
    .insert(dutySlots)
    .values({ id: slotId, dutyId, data: { role: "תורן שער" } });
  const seat = assignment({
    id: assignmentId,
    dutyId,
    slotId,
    soldierId: member.soldierId!,
  });
  await db.insert(assignments).values({ ...seat, data: seat });
  await db
    .update(duties)
    .set({
      data: {
        ...data,
        status: "published",
        publishedAt: new Date().toISOString(),
      },
      version: 2,
    })
    .where(eq(duties.id, dutyId));
  for (const [id, recipient] of [
    [ownMail, member.id],
    [foreignMail, other.id],
  ])
    await db.insert(emailOutbox).values({
      id,
      recipientAccountId: recipient,
      eventKey: randomUUID(),
      kind: "publication",
      title: "שיבוץ",
      body: "שיבוץ",
      dutyIds: [dutyId],
      expiresAt: new Date(Date.now() + 86400_000),
    });
  expect(manager.role).toBe("manager");
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [account] = await db.select().from(user).where(eq(user.email, email));
  const messages = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.recipientAccountId, account.id));
  const code = messages
    .filter((row) => row.kind === "login-code")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  await page
    .getByLabel("קוד כניסה", { exact: true })
    .fill(openSecret(code.encryptedSecret!));
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}

test("personal assignments on desktop and mobile, private mail highlight and visit markers", async ({
  page,
  browser,
}) => {
  await login(page, memberEmail);
  // The real HTTP paths reject oversized/deep input before command processing.
  const origin = new URL(page.url()).origin;
  const large = await page.request.post("/api/v1/actions", {
    headers: { origin, "content-type": "application/json" },
    data: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }),
  });
  expect(large.status()).toBe(413);
  const deep = await page.request.post("/api/v1/actions", {
    headers: { origin, "content-type": "application/json" },
    data: "[".repeat(33) + "0" + "]".repeat(33),
  });
  expect(deep.status()).toBe(413);
  const authLarge = await page.request.post("/api/auth/request-code", {
    headers: { origin, "content-type": "application/json" },
    data: JSON.stringify({ email: "x".repeat(16 * 1024) }),
  });
  expect(authLarge.status()).toBe(413);
  await page.getByRole("link", { name: "השיבוצים שלי" }).click();
  await expect(
    page.getByRole("heading", { name: "השיבוצים שלי", exact: true })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "שמירת שער" })).toBeVisible();
  await expect(page.getByText("חדש", { exact: true })).toBeVisible();
  await expect(page.getByText("שער ראשי")).toBeVisible();
  await page.goto(`/my-assignments?mail=${foreignMail}`);
  await expect(page.getByRole("heading", { name: "שמירת שער" })).toBeVisible();
  await expect(page.getByText("במייל הזה", { exact: true })).toHaveCount(0);
  await expect(page.getByText("חדש", { exact: true })).toHaveCount(0);
  await page.goto(`/my-assignments?mail=${ownMail}`);
  await expect(page.getByText("במייל הזה", { exact: true })).toBeVisible();
  await page
    .getByRole("link", { name: "להיסטוריה שלי בלוח התורנויות" })
    .click();
  await expect(
    page.getByRole("button", { name: "התורנויות שלי", exact: true })
  ).toHaveAttribute("aria-pressed", "true");

  await page.setViewportSize({ width: 390, height: 844 });
  const [currentDuty] = await db
    .select()
    .from(duties)
    .where(eq(duties.id, dutyId));
  await db
    .update(duties)
    .set({
      name: "שמירת שער מעודכנת",
      data: { ...currentDuty.data, name: "שמירת שער מעודכנת" },
    })
    .where(eq(duties.id, dutyId));
  await page.goto("/my-assignments");
  await expect(
    page.getByRole("heading", { name: "שמירת שער מעודכנת" })
  ).toBeVisible();
  await expect(page.getByText("עודכן", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  const [seat] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.id, assignmentId));
  await db
    .update(assignments)
    .set({ status: "cancelled", data: { ...seat.data, status: "cancelled" } })
    .where(eq(assignments.id, assignmentId));
  await page.goto("/my-assignments");
  await expect(
    page.getByRole("heading", { name: "בוטלו מאז הביקור הקודם" })
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "בוטלו מאז הביקור הקודם" })
  ).toHaveCount(0);
  await page.goto(`/my-assignments?mail=${ownMail}`);
  await expect(
    page.getByRole("heading", { name: "בוטלו מאז הביקור הקודם" })
  ).toBeVisible();
  await expect(page.getByText("במייל הזה", { exact: true })).toBeVisible();

  const managerPage = await (await browser.newContext()).newPage();
  await login(managerPage, managerEmail);
  await expect(
    managerPage.getByRole("link", { name: "השיבוצים שלי" })
  ).toHaveCount(0);
  await managerPage.goto("/my-assignments");
  await expect(
    managerPage.getByText("העמוד אינו זמין לחשבון שלך")
  ).toBeVisible();
});
