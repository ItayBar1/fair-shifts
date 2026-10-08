import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox, loginCode } from "../../src/server/auth-schema";
import { soldiers, balances, soldierContacts } from "../../src/server/schema";
import {
  createInvitedAccount,
  issueRecoveryCodes,
} from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";
import { signedInHome } from "./auth-submit";

const emails = {
  manager: "access-manager@example.invalid",
  secondManager: "access-second-manager@example.invalid",
  member: "access-member@example.invalid",
  promoted: "access-promoted@example.invalid",
  technical: "access-technical@example.invalid",
};
async function person(name: string, personalNumber: string) {
  const id = randomUUID();
  const data = soldier({ id, name, personalNumber });
  await db.insert(soldiers).values({ id, name, personalNumber, data });
  await db.insert(balances).values({ soldierId: id });
  return id;
}
async function invite(
  name: string,
  personalNumber: string,
  email: string,
  role: "soldier" | "manager"
) {
  const soldierId = await person(name, personalNumber);
  await db.insert(soldierContacts).values({ soldierId, email });
  await createInvitedAccount({ name, email, role, soldierId });
}
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
  await invite("גישה אחראית", "4000001", emails.manager, "manager");
  await invite("גישה אחראי שני", "4000002", emails.secondManager, "manager");
  await invite("גישה חייל", "4000003", emails.member, "soldier");
  await invite("גישה מקודם", "4000004", emails.promoted, "soldier");
  await createInvitedAccount({
    name: "גישה טכני",
    email: emails.technical,
    role: "technical",
  });
});

async function accountId(email: string) {
  const [row] = await db.select().from(user).where(eq(user.email, email));
  return row.id;
}
/** The server enforces a minute between sends; tests move the last send back instead of waiting. */
async function allowResend(email: string) {
  await db
    .update(loginCode)
    .set({ sentAt: new Date(Date.now() - 120_000) })
    .where(eq(loginCode.userId, await accountId(email)));
}
async function latestCode(email: string) {
  const rows = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.recipientAccountId, await accountId(email)));
  const message = rows
    .filter((row) => row.kind === "login-code")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return openSecret(message.encryptedSecret!, {
    purpose: "mail-code",
    recordId: message.id,
  });
}
async function requestCode(page: Page, email: string) {
  await allowResend(email);
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
}
async function submitCode(page: Page, code: string) {
  await page.getByLabel("קוד כניסה", { exact: true }).fill(code);
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
}
async function login(
  page: Page,
  email: string,
  home: string | RegExp = signedInHome
) {
  await requestCode(page, email);
  await submitCode(page, await latestCode(email));
  await expect(
    page.getByRole("heading", { name: home, exact: true })
  ).toBeVisible();
}
// Next.js keeps its own role="alert" route announcer, so match the form notice.
const loginError = (page: Page) => page.locator(".login-form .notice.danger");
/** A revoked connection sends the next screen load back to the login page. */
async function expectSignedOut(page: Page) {
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("כתובת המייל המאושרת")).toBeVisible();
}
async function failFiveTimes(page: Page, email: string) {
  await requestCode(page, email);
  const alert = loginError(page);
  await submitCode(page, "111111");
  await expect(alert).toHaveText("קוד לא תקין");
  await submitCode(page, "222222");
  await expect(alert).toHaveText("קוד לא תקין");
  await submitCode(page, "333333");
  await expect(alert).toHaveText(
    "קוד לא תקין. נותרו שני ניסיונות לפני ביטול הקוד"
  );
  // A fresh code does not clear the count.
  await allowResend(email);
  await page.getByRole("button", { name: "שינוי כתובת מייל" }).click();
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await submitCode(page, "444444");
  await expect(alert).toHaveText(
    "קוד לא תקין. נותר ניסיון אחד לפני ביטול הקוד"
  );
  await submitCode(page, "555555");
}

test("a soldier is warned, its code burns without revoking access, and a legacy lock is released by a manager", async ({
  page,
  browser,
}) => {
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await login(memberPage, emails.member);

  await failFiveTimes(page, emails.member);
  await expect(loginError(page)).toHaveText(
    "הקוד בוטל לאחר חמש טעויות. יש להמתין לפני בקשת קוד חדש"
  );
  await page.screenshot({
    path: "test-results/access-locked-soldier.png",
    fullPage: true,
  });
  await memberPage.reload();
  await expect(
    memberPage.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
  await db
    .update(user)
    .set({
      lockedAt: new Date(),
      securityEpoch: sql`${user.securityEpoch} + 1`,
    })
    .where(eq(user.email, emails.member));
  await expectSignedOut(memberPage);

  await login(page, emails.manager);
  await page.goto("/manage");
  const locked = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "חשבונות נעולים", exact: true }),
  });
  await expect(locked.getByText("גישה חייל", { exact: true })).toBeVisible();
  await locked.getByRole("button", { name: "שחרור חשבון" }).click();
  await expect(locked).toHaveCount(0);

  await login(memberPage, emails.member);
  await expect(
    memberPage.getByRole("link", { name: "מרכז טיפול", exact: true })
  ).toHaveCount(0);
  await memberContext.close();
});

test("the technical account grants and removes manager permission, ending the open connection each time", async ({
  page,
  browser,
}) => {
  const promotedContext = await browser.newContext();
  const promoted = await promotedContext.newPage();
  await login(promoted, emails.promoted);
  await expect(
    promoted.getByRole("link", { name: "מרכז טיפול", exact: true })
  ).toHaveCount(0);

  await login(page, emails.technical, "תמונת מצב");
  await page.goto("/technical/permissions");
  const row = page
    .locator(".task-item")
    .filter({ has: page.getByText("גישה מקודם", { exact: true }) });
  await expect(row.getByText("חייל", { exact: true })).toBeVisible();
  // The technical account is listed without a role action and is not a soldier.
  const self = page
    .locator(".task-item")
    .filter({ has: page.getByText("גישה טכני", { exact: true }) });
  await expect(self.getByRole("button")).toHaveCount(0);
  await row.getByRole("button", { name: "הענקת הרשאת אחראי" }).click();
  await expect(row.getByText("אחראי תורנויות", { exact: true })).toBeVisible();

  await expectSignedOut(promoted);
  await login(promoted, emails.promoted);
  await expect(
    promoted.getByRole("link", { name: "מרכז טיפול", exact: true })
  ).toBeVisible();

  await row.getByRole("button", { name: "הסרת הרשאת אחראי" }).click();
  await expect(row.getByText("חייל", { exact: true })).toBeVisible();
  await expectSignedOut(promoted);
  await login(promoted, emails.promoted);
  await expect(
    promoted.getByRole("link", { name: "מרכז טיפול", exact: true })
  ).toHaveCount(0);
  const response = await promoted.request.post("/api/v1/actions", {
    headers: { origin: "http://127.0.0.1:3000" },
    data: {
      type: "account.role",
      payload: { id: await accountId(emails.promoted), role: "manager" },
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.status()).toBe(403);
  await promotedContext.close();
});

test("a locked manager is sent to the technical account, which releases it; a recovery code works once", async ({
  page,
  browser,
}) => {
  await db
    .update(user)
    .set({
      lockedAt: new Date(),
      securityEpoch: sql`${user.securityEpoch} + 1`,
    })
    .where(eq(user.email, emails.secondManager));
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(emails.secondManager);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await submitCode(page, "000000");
  await expect(loginError(page)).toHaveText(
    "החשבון נעול. יש לפנות למנהל הטכני לשחרור"
  );

  const technicalContext = await browser.newContext();
  const technical = await technicalContext.newPage();
  await login(technical, emails.technical, "תמונת מצב");
  await technical.goto("/technical/locked");
  const row = technical
    .locator(".task-item")
    .filter({ has: technical.getByText("גישה אחראי שני", { exact: true }) });
  await expect(row.getByText("נעול", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "שחרור חשבון" }).click();
  await expect(row).toHaveCount(0);
  await technicalContext.close();
  await login(page, emails.secondManager);

  const [code] = await db.transaction(async (tx) =>
    issueRecoveryCodes(await accountId(emails.technical), tx)
  );
  const recover = async () => {
    await page.goto("/login");
    await page.getByRole("button", { name: "שחזור חשבון מנהל טכני" }).click();
    await page.getByLabel("כתובת המייל המאושרת").fill(emails.technical);
    await page.getByLabel("קוד שחזור", { exact: true }).fill(code);
    await page
      .getByRole("button", { name: "כניסה לחשבון", exact: true })
      .click();
  };
  await recover();
  await expect(page.locator(".login-form .notice.success")).toHaveText(
    "הגישה שוחזרה. יש להתחבר מחדש עם קוד למייל או Google."
  );
  await recover();
  await expect(loginError(page)).toHaveText("קוד שחזור לא תקין או נוצל");
});

test("a refused Google sign-in returns to the login page with guidance, also on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login?error=unable_to_create_session");
  await expect(loginError(page)).toHaveText(
    "לא ניתן להיכנס לחשבון הזה כרגע. אם החשבון ננעל, חייל פונה לאחראי התורנויות ואחראי למנהל הטכני."
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.screenshot({
    path: "test-results/access-provider-refused-mobile.png",
    fullPage: true,
  });
  await page.goto("/login?error=signup_disabled");
  await expect(loginError(page)).toHaveText(
    "הכניסה עם Google לא הושלמה. הכניסה אפשרית רק לחשבון Google של כתובת שהוזמנה ביחידה."
  );
});
