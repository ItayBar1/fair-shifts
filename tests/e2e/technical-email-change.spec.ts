import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox, loginCode } from "../../src/server/auth-schema";
import { soldiers, soldierContacts, balances } from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

const emails = {
  technical: "tech-change-e2e-technical@example.invalid",
  next: "tech-change-e2e-next@example.invalid",
  manager: "tech-change-e2e-manager@example.invalid",
};

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
  await createInvitedAccount({
    name: "טכני להחלפת כתובת",
    email: emails.technical,
    role: "technical",
  });
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name: "אחראי להחלפת כתובת",
    personalNumber: "7000001",
    data: soldier({
      id,
      name: "אחראי להחלפת כתובת",
      personalNumber: "7000001",
    }),
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: emails.manager });
  await db.insert(balances).values({ soldierId: id });
  await createInvitedAccount({
    name: "אחראי להחלפת כתובת",
    email: emails.manager,
    role: "manager",
    soldierId: id,
  });
});

const accountOf = async (email: string) =>
  (await db.select().from(user).where(eq(user.email, email)))[0];
/** The server enforces a minute between sends; tests move the last send back instead of waiting. */
async function allowResend(email: string) {
  await db
    .update(loginCode)
    .set({ sentAt: new Date(Date.now() - 120_000) })
    .where(eq(loginCode.userId, (await accountOf(email)).id));
}
async function login(page: Page, email: string, home: string) {
  await allowResend(email);
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const messages = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.recipientAccountId, (await accountOf(email)).id));
  const latest = messages
    .filter((row) => row.kind === "login-code")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  await page
    .getByLabel("קוד כניסה", { exact: true })
    .fill(openSecret(latest.encryptedSecret!));
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: home, exact: true })
  ).toBeVisible();
}
/** The two codes the queue holds for the technical account, by address. */
async function codes() {
  const rows = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.kind, "email-change"));
  return Object.fromEntries(
    rows
      .filter((row) => row.status === "pending")
      .map((row) => [row.destination, openSecret(row.encryptedSecret!)])
  ) as Record<string, string>;
}
const noOverflow = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  );
const panel = (page: Page, title: string) =>
  page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });

test("the technical account moves itself to a new address with a code from each mailbox", async ({
  page,
}) => {
  await login(page, emails.technical, "תמונת מצב");
  await page.getByRole("link", { name: "החשבון שלי", exact: true }).click();
  await expect(page).toHaveURL(/\/technical\/account$/);
  const own = panel(page, "החשבון שלי");
  await expect(own.getByText(emails.technical)).toBeVisible();
  const change = panel(page, "החלפת כתובת מייל");
  // Until a request is open there is nothing to confirm.
  await expect(
    change.getByRole("button", { name: "אימות והחלפת הכתובת" })
  ).toHaveCount(0);

  await change.getByRole("button", { name: "בקשת החלפת כתובת" }).click();
  const request = page.getByRole("dialog");
  await request.getByLabel("הכתובת החדשה").fill(emails.next);
  await request.getByLabel("סיבת ההחלפה").fill("מעבר לחשבון הייעודי");
  await request.getByRole("button", { name: "שליחת הקודים" }).click();
  await expect(change.getByText(emails.next)).toBeVisible();
  await expect(change.getByText("חמש טעויות מבטלות את הבקשה")).toBeVisible();
  const sent = await codes();
  expect(Object.keys(sent).sort()).toEqual(
    [emails.technical, emails.next].sort()
  );

  // Mobile: the screen and the dialog fit the width.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noOverflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "test-results/technical-email-change-mobile.png",
    fullPage: true,
  });
  await change.getByRole("button", { name: "אימות והחלפת הכתובת" }).click();
  const confirm = page.getByRole("dialog");
  expect(await noOverflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "test-results/technical-email-change-dialog-mobile.png",
  });
  await page.setViewportSize({ width: 1280, height: 800 });

  // One right code is not enough, and the answer does not say which one was wrong.
  await confirm
    .getByLabel("הקוד שנשלח לכתובת הנוכחית")
    .fill(sent[emails.technical]);
  await confirm.getByLabel("הקוד שנשלח לכתובת החדשה").fill("000000");
  await confirm.getByRole("button", { name: "אימות והחלפה" }).click();
  await expect(confirm.getByText("קוד האימות אינו תקין")).toBeVisible();
  expect((await accountOf(emails.technical)).email).toBe(emails.technical);
  await page.screenshot({
    path: "test-results/technical-email-change-desktop.png",
    fullPage: true,
  });

  await confirm.getByLabel("הקוד שנשלח לכתובת החדשה").fill(sent[emails.next]);
  await confirm.getByRole("button", { name: "אימות והחלפה" }).click();
  // Every connection ended, including this one.
  await expect(page).toHaveURL(/\/login$/);
  expect((await accountOf(emails.next)).emailVerified).toBe(true);
  expect(await accountOf(emails.technical)).toBeUndefined();

  // The next sign-in is with the new address.
  await login(page, emails.next, "תמונת מצב");
  await page.getByRole("link", { name: "החשבון שלי", exact: true }).click();
  await expect(panel(page, "החשבון שלי").getByText(emails.next)).toBeVisible();
  await expect(
    panel(page, "החלפת כתובת מייל").getByRole("button", {
      name: "אימות והחלפת הכתובת",
    })
  ).toHaveCount(0);
});

test("a manager has no such screen and the server refuses the route", async ({
  page,
}) => {
  await login(page, emails.manager, "לוח התורנויות");
  await expect(
    page.getByRole("link", { name: "החשבון שלי", exact: true })
  ).toHaveCount(0);
  await page.goto("/technical/account");
  await expect(page.getByText("המסך הזה אינו זמין לחשבון שלך")).toBeVisible();
  for (const [type, payload] of [
    [
      "technical.email.request",
      { email: "x@example.invalid", reason: "ניסיון" },
    ],
    ["technical.email.confirm", { currentCode: "1", newCode: "2" }],
  ] as const) {
    const response = await page.request.post("/api/v1/actions", {
      data: { type, payload, idempotencyKey: randomUUID() },
    });
    expect(response.status()).toBe(403);
  }
});
