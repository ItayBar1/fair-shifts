import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox, loginCode } from "../../src/server/auth-schema";
import {
  soldiers,
  balances,
  duties,
  assignmentMailWindow,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import {
  deliverNextEmail,
  openSecret,
} from "../../src/server/operations/email";
import { soldier } from "../fixtures";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const people = [
  ["אחראי איחוד", "digest-manager@example.invalid", "manager", "400001"],
  ["חייל איחוד", "digest-member@example.invalid", "soldier", "400002"],
] as const;
const actors: Actor[] = [];
let typeId: string;

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
  const [person] = await db.select().from(user).where(eq(user.email, email));
  // The server enforces a minute between sends; move the last one back instead of waiting.
  await db
    .update(loginCode)
    .set({ sentAt: new Date(Date.now() - 120_000) })
    .where(eq(loginCode.userId, person.id));
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const message = (
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, person.id))
  )
    .filter((row) => row.kind === "login-code")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
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
/** A one-seat duty of the member, published now, starting after `startsIn`. */
async function publish(name: string, startsIn: number) {
  const start = Date.now() + startsIn;
  const created = await command("duty.create", {
    typeId,
    name,
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
  return duty.id;
}

test("several publications reach the soldier as one notice that counts them and leads to all assignments", async ({
  browser,
}) => {
  typeId = (
    await command("dutyType.save", {
      name: "שמירה סינתטית",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 1 }],
    })
  ).id;
  const first = await publish("שמירה ראשונה", 3 * DAY);
  await publish("שמירה שנייה", 4 * DAY);
  await publish("שמירה שלישית", 5 * DAY);

  const member = await signedIn(browser, people[1][1], true);
  await member.goto("/notifications");
  const notice = member.locator("article");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("שובצת ל־3 תורנויות");
  await expect(notice).toContainText("הפרטים בעמוד ״השיבוצים שלי״");
  // One window, one notice: the unread count is one, not three.
  await expect(
    member.getByRole("link", { name: "הודעות, 1 לא נקראו" })
  ).toBeVisible();
  // The notice leads to the page of all assignments, not to one duty.
  await expect(
    notice.getByRole("link", { name: "פתיחת הפרטים" })
  ).toHaveAttribute("href", "/my-assignments");
  const width = await member.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);

  // Read and hidden by the soldier, then another publication joins the window:
  // the same notice comes back, unread, with the new count.
  await notice.getByRole("button", { name: "סימון כנקראה" }).click();
  await expect(
    notice.getByRole("button", { name: "סימון כנקראה" })
  ).toHaveCount(0);
  await notice.getByRole("button", { name: "הסתרה" }).click();
  await expect(member.locator("article")).toHaveCount(0);
  await publish("שמירה רביעית", 6 * DAY);
  await member.reload();
  await expect(member.locator("article")).toHaveCount(1);
  await expect(member.locator("article")).toContainText("שובצת ל־4 תורנויות");
  await expect(
    member.getByRole("link", { name: "הודעות, 1 לא נקראו" })
  ).toBeVisible();
  await expect(
    member.locator("article").getByRole("button", { name: "סימון כנקראה" })
  ).toBeVisible();

  // The one mail of the window is queued for when it closes, and lists all four duties.
  const [window] = await db.select().from(assignmentMailWindow);
  const sent: { subject: string; text: string }[] = [];
  const result = await deliverNextEmail(
    async (message) => {
      sent.push(message);
      return "synthetic";
    },
    new Date(window.closesAt.getTime() + 60_000)
  );
  expect(result.status).toBe("sent");
  expect(sent).toHaveLength(1);
  expect(sent[0].subject).toBe("שובצת ל־4 תורנויות");
  for (const name of [
    "שמירה ראשונה",
    "שמירה שנייה",
    "שמירה שלישית",
    "שמירה רביעית",
  ])
    expect(sent[0].text).toContain(`• ${name} — `);
  expect(sent[0].text).toContain(`/duties/${first}`);
  expect(sent[0].text).toContain(`/my-assignments?mail=${window.id}`);
  // Follow the real notice, consume visit markers, then follow the actual
  // delivered mail. Its highlights persist independently of the visit cursor.
  await member
    .locator("article")
    .getByRole("link", { name: "פתיחת הפרטים" })
    .click();
  await expect(
    member.getByRole("heading", { name: "השיבוצים הקרובים שלי" })
  ).toBeVisible();
  await expect(member.getByText("חדש", { exact: true })).toHaveCount(4);
  await member.reload();
  await expect(member.locator(".my-assignment")).toHaveCount(4);
  await expect(member.getByText("חדש", { exact: true })).toHaveCount(0);
  const mailPath = new URL(
    sent[0].text.match(/https?:\/\/\S+\/my-assignments\?mail=[\w-]+/)![0]
  );
  await member.goto(`${mailPath.pathname}${mailPath.search}`);
  await expect(member.getByText("במייל הזה", { exact: true })).toHaveCount(4);
  await expect(member.getByText("חדש", { exact: true })).toHaveCount(0);
});

test("a duty starting within two hours keeps its own notice, apart from the window's", async ({
  browser,
}) => {
  await publish("שמירה קרובה", HOUR);
  await publish("שמירה רחוקה", 8 * DAY);
  const member = await signedIn(browser, people[1][1]);
  await member.goto("/notifications");
  await expect(
    member.locator("article").filter({ hasText: "שובצת לתורנות שמירה קרובה" })
  ).toHaveCount(1);
  await expect(
    member.locator("article").filter({ hasText: "שובצת לתורנות שמירה רחוקה" })
  ).toHaveCount(1);
});
