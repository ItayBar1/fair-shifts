import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import { soldiers, balances, soldierContacts } from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import {
  MailDeliveryError,
  deliverNextEmail,
  enqueueEmail,
  openSecret,
} from "../../src/server/operations/email";
import { soldier } from "../fixtures";

const technicalEmail = "mail-technical@example.invalid";
const recipientEmail = "mail-recipient@example.invalid";
let recipientId: string;

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
  await createInvitedAccount({
    name: "טכני מייל",
    email: technicalEmail,
    role: "technical",
  });
  const id = randomUUID();
  const data = soldier({ id, name: "חייל נמען", personalNumber: "000301" });
  await db
    .insert(soldiers)
    .values({ id, name: data.name, personalNumber: data.personalNumber, data });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: recipientEmail });
  await db.insert(balances).values({ soldierId: id });
  recipientId = (
    await createInvitedAccount({
      name: data.name,
      email: recipientEmail,
      role: "soldier",
      soldierId: id,
    })
  ).id;
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [person] = await db.select().from(user).where(eq(user.email, email));
  const [message] = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.recipientAccountId, person.id));
  await page.getByLabel("קוד כניסה", { exact: true }).fill(
    openSecret(message.encryptedSecret!, {
      purpose: "mail-code",
      recordId: message.id,
    })
  );
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "תמונת מצב", exact: true })
  ).toBeVisible();
}
async function queue(eventKey: string) {
  await db.transaction((tx) =>
    enqueueEmail(tx, {
      recipientAccountId: recipientId,
      eventKey,
      kind: "publication",
      title: "פורסם שיבוץ לתורנות",
      body: "שובצת לתורנות סינתטית",
      href: "/duties/synthetic",
      priority: 1,
      expiresAt: new Date(Date.now() + 3600_000),
    })
  );
}
/** Runs deliveries with a failing provider until the given message has been tried. */
async function failUntilTried(
  eventKey: string,
  category: "permanent" | "configuration"
) {
  for (let index = 0; index < 5; index++) {
    await deliverNextEmail(async () => {
      throw new MailDeliveryError(category);
    });
    const [row] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.eventKey, eventKey));
    if (row.status === "failed" || row.updatedAt > row.createdAt) return;
  }
  throw new Error("the message was not tried");
}

test("technical admin sees mail failures, the pause and the quota without personal data", async ({
  page,
}) => {
  await login(page, technicalEmail);
  await queue("e2e:rejected");
  await queue("e2e:waiting");
  await failUntilTried("e2e:rejected", "permanent");
  await failUntilTried("e2e:waiting", "configuration");

  await page.goto("/technical");
  const health = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "מצב המערכת", exact: true }),
  });
  await expect(health.getByText("משלוח מייל", { exact: true })).toBeVisible();
  await expect(health.getByText("דורש טיפול", { exact: true })).toBeVisible();
  await expect(health.getByText("יש כשל או מחסור במכסת המייל")).toBeVisible();

  await page.getByRole("link", { name: "משלוחי מייל", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "מכסה ותור", exact: true })
  ).toBeVisible();
  await expect(page.getByText("הספק דחה את פרטי החשבון")).toBeVisible();
  const failures = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "כשלים אחרונים", exact: true }),
  });
  await expect(failures.locator("tbody tr")).toHaveCount(1);
  await expect(
    failures.getByRole("cell", { name: "פרסום שיבוץ" })
  ).toBeVisible();
  await expect(
    failures.getByRole("cell", { name: /הספק דחה את המייל/ })
  ).toBeVisible();
  await expect(page.getByText("הודעת האתר והפעולה עצמה נשמרו")).toBeVisible();
  const content = await page.locator("main").innerText();
  for (const hidden of [recipientEmail, "חייל נמען", "שובצת לתורנות סינתטית"])
    expect(content).not.toContain(hidden);
  await page.screenshot({
    path: "test-results/mail-operations-desktop.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("הספק דחה את פרטי החשבון")).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "test-results/mail-operations-mobile.png",
    fullPage: true,
  });
});

test("the login page shows a general delay notice while codes cannot go out", async ({
  browser,
}) => {
  // Pauses mail (a no-op if the previous test already paused it).
  await queue("e2e:login-delay");
  await deliverNextEmail(async () => {
    throw new MailDeliveryError("configuration");
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const delay = page.getByText("משלוח המיילים מתעכב כרגע");
  // The same notice for an unregistered and a registered address.
  for (const email of ["nobody@example.invalid", recipientEmail]) {
    await page.goto("/login");
    await page.getByLabel("כתובת המייל המאושרת").fill(email);
    await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
    await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
    await expect(delay).toBeVisible();
  }
  await page.screenshot({
    path: "test-results/login-mail-delay-mobile.png",
    fullPage: true,
  });
  await context.close();
});
