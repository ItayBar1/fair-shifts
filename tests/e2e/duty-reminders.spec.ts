import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { db, unitTransaction } from "../../src/server/db";
import { refreshDutyReminders } from "../../src/server/duty-reminders";
import { user, emailOutbox } from "../../src/server/auth-schema";
import { soldiers, balances, duties } from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";
import { signedInHome } from "./auth-submit";

const HOUR = 3_600_000;
const people = [
  ["אחראי תזכורות", "reminder-manager@example.invalid", "manager", "200001"],
  ["חייל תזכורות", "reminder-member@example.invalid", "soldier", "200002"],
] as const;
const actors: Actor[] = [];

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
  for (const [name, email, role, personalNumber] of people) {
    const id = randomUUID();
    const data = soldier({ id, name, personalNumber });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(balances).values({ soldierId: id });
    const row = await createInvitedAccount({
      name,
      email,
      role,
      soldierId: id,
    });
    actors.push({ id: row.id, name, role, soldierId: id, securityEpoch: 1 });
  }
});
// The pool is shared by every spec in the worker; the worker exit closes it.

async function signedIn(browser: Browser, email: string, mobile = false) {
  const context = await browser.newContext(
    mobile ? { viewport: { width: 390, height: 844 } } : {}
  );
  const page: Page = await context.newPage();
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
  ).filter((row) => row.kind === "login-code");
  await page.getByLabel("קוד כניסה", { exact: true }).fill(
    openSecret(message.encryptedSecret!, {
      purpose: "mail-code",
      recordId: message.id,
    })
  );
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(page.getByRole("heading", { name: signedInHome })).toBeVisible();
  return page;
}
async function command(
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) {
  return (await executeAction(actors[0], {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as { id: string };
}

test("duty reminder: one site notice per time, linked to the duty, on mobile too", async ({
  browser,
}) => {
  const type = await command("dutyType.save", {
    name: "שמירה סינתטית",
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 1 }],
  });
  const start = Date.now() + 25 * HOUR;
  const created = await command("duty.create", {
    typeId: type.id,
    name: "שמירת תזכורת",
    start: new Date(start).toISOString(),
    end: new Date(start + 8 * HOUR).toISOString(),
  });
  const [duty] = await db
    .select()
    .from(duties)
    .where(eq(duties.id, created.id));
  await command(
    "duty.assign",
    {
      dutyId: duty.id,
      slotId: duty.data.slots[0].id,
      soldierId: actors[1].soldierId,
    },
    1
  );
  await command("duty.publish", { id: duty.id, confirmed: true }, 2);

  // The worker's runs: the first sets the baseline, then the 24 hour time comes.
  const run = (at: number) =>
    unitTransaction((tx) => refreshDutyReminders(tx, new Date(at)));
  await run(Date.now());
  await run(Date.parse(duty.data.start) - 24 * HOUR + 60_000);
  await run(Date.parse(duty.data.start) - 24 * HOUR + 90_000);

  const member = await signedIn(browser, people[1][1], true);
  await member.goto("/notifications");
  const reminder = member
    .locator("article")
    .filter({ hasText: "תזכורת: תורנות מתקרבת" });
  await expect(reminder).toHaveCount(1);
  await expect(reminder).toContainText("התורנות שמירת תזכורת מתחילה ב־");
  await expect(reminder).toContainText("(שעון ישראל)");
  const width = await member.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
  await reminder.getByRole("link", { name: "פתיחת הפרטים" }).click();
  await expect(member).toHaveURL(new RegExp(`/duties/${duty.id}$`));
  await expect(member.getByText("שמירת תזכורת").first()).toBeVisible();

  // One email per time, queued for the worker's delivery.
  const emails = await db
    .select()
    .from(emailOutbox)
    .where(like(emailOutbox.eventKey, `reminder:${duty.id}:%`));
  expect(emails.map((row) => row.reminderHours)).toEqual([24]);
});
