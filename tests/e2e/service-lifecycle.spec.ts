import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, unitTransaction } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import { soldiers, balances, soldierContacts } from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { announceDepartures } from "../../src/server/departures";
import { soldier } from "../fixtures";
import { submitAuth } from "./auth-submit";

const israelDate = (days = 0) =>
  DateTime.now().setZone("Asia/Jerusalem").plus({ days }).toISODate()!;
const leaving = "leaving@example.invalid";
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
    ["אחראי שירות", "service-manager@example.invalid", "manager", "000201", {}],
    [
      "חייל משתחרר",
      leaving,
      "soldier",
      "000202",
      { releaseDate: israelDate() },
    ],
    [
      "חייל בחסד",
      "grace@example.invalid",
      "soldier",
      "000203",
      { arrivalDate: israelDate(-3), graceEligible: true },
    ],
  ] as const;
  for (const [name, email, role, personalNumber, service] of people) {
    const id = randomUUID();
    const data = soldier({ id, name, personalNumber });
    data.service = { ...data.service, ...service };
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(soldierContacts).values({ soldierId: id, email });
    await db.insert(balances).values({ soldierId: id });
    await createInvitedAccount({ name, email, role, soldierId: id });
    ids[name] = id;
  }
});

async function loginCodes(email: string) {
  const [account] = await db.select().from(user).where(eq(user.email, email));
  return (
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, account.id))
  ).filter((row) => row.kind === "login-code");
}
async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await submitAuth(
    page,
    "/api/auth/request-code",
    page.getByRole("button", { name: "שליחת קוד למייל" })
  );
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [message] = await loginCodes(email);
  await page.getByLabel("קוד כניסה", { exact: true }).fill(
    openSecret(message.encryptedSecret!, {
      purpose: "mail-code",
      recordId: message.id,
    })
  );
  await submitAuth(
    page,
    "/api/auth/verify-code",
    page.getByRole("button", { name: "כניסה לחשבון", exact: true })
  );
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}

test("release blocks the open session at the boundary, the managers get one departure notice and the service dates are shown", async ({
  page,
  browser,
}) => {
  const soldierContext = await browser.newContext();
  const member = await soldierContext.newPage();
  // The last day of service still allows signing in.
  await login(member, leaving);

  // The day passes: the stored date is now yesterday, before any worker run.
  const [row] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, ids["חייל משתחרר"]));
  await db
    .update(soldiers)
    .set({
      data: {
        ...row.data,
        service: { ...row.data.service, releaseDate: israelDate(-1) },
      },
    })
    .where(eq(soldiers.id, row.id));
  await member.goto("/calendar");
  await expect(member.getByLabel("כתובת המייל המאושרת")).toBeVisible();
  const before = (await loginCodes(leaving)).length;
  await member.getByLabel("כתובת המייל המאושרת").fill(leaving);
  await member.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect
    .poll(async () => (await loginCodes(leaving)).length)
    .toBe(before);
  await soldierContext.close();

  await login(page, "service-manager@example.invalid");
  // The agenda derives the departure from the date, before the worker's notice.
  await page.goto("/manage");
  const item = page.locator(".task-item", {
    hasText: "חייל משתחרר — השירות הסתיים",
  });
  await expect(item).toBeVisible();
  await expect(item).not.toContainText("הודעה נשלחה");

  // Two worker runs produce a single notice.
  await unitTransaction((tx) => announceDepartures(tx));
  await unitTransaction((tx) => announceDepartures(tx));
  await page.reload();
  await expect(item).toContainText("הודעה נשלחה");
  await page.goto("/notifications");
  await expect(page.getByText("סיום שירות", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/השירות של חייל משתחרר הסתיים/)).toBeVisible();

  await page.goto("/manage/soldiers");
  const released = page.locator("tr", { hasText: "חייל משתחרר" });
  await expect(released.getByText("השירות הסתיים")).toBeVisible();
  const grace = page.locator("tr", { hasText: "חייל בחסד" });
  await expect(grace.getByText("בחודש חסד")).toBeVisible();
  await grace.getByRole("button", { name: "פרופיל ועריכה" }).click();
  const returnDate = DateTime.fromISO(israelDate(-3), {
    zone: "Asia/Jerusalem",
  })
    .plus({ months: 1 })
    .toFormat("dd.MM.yyyy");
  await expect(
    page.getByText(`חודש חסד: הזמינות לשיבוץ חוזרת ב־${returnDate}`)
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/service-lifecycle-profile.png",
  });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/manage");
  await expect(item).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: "test-results/service-lifecycle-mobile.png",
    fullPage: true,
  });
});
