import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  soldiers,
  balances,
  soldierContacts,
  assignments,
} from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

const people = [
  ["אחראי בקשות", "requests-manager@example.invalid", "manager", "000301"],
  ["חייל מבקש", "requests-soldier@example.invalid", "soldier", "000302"],
] as const;
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
  for (const [name, email, role, personalNumber] of people) {
    const id = randomUUID();
    const data = soldier({ id, name, personalNumber });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(soldierContacts).values({ soldierId: id, email });
    await db.insert(balances).values({ soldierId: id });
    await createInvitedAccount({ name, email, role, soldierId: id });
    ids[email] = id;
  }
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
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
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}
const panel = (page: Page, title: string) =>
  page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });

test("a soldier's request changes nothing until the manager removes the seat in update and publish, or rejects it", async ({
  page,
  browser,
}) => {
  await login(page, "requests-manager@example.invalid");
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
    name: "שמירת בקשות",
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 1 }],
  });
  async function publishedDuty(name: string, days: number) {
    const created = await api("duty.create", {
      typeId: type.id,
      name,
      start: new Date(Date.now() + days * 86_400_000).toISOString(),
      end: new Date(Date.now() + (days + 1) * 86_400_000).toISOString(),
      location: "אתר בקשות",
    });
    const state = await (await page.request.get("/api/v1/state")).json();
    const row = state.duties.find((d: { id: string }) => d.id === created.id);
    await api(
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.slots[0].id,
        soldierId: ids["requests-soldier@example.invalid"],
      },
      1
    );
    await api("duty.publish", { id: row.id, confirmed: true }, 2);
    return row.id as string;
  }
  const removedId = await publishedDuty("תורנות לביטול", 3);
  const rejectedId = await publishedDuty("תורנות לדחייה", 5);

  // The soldier asks from the duty page; nothing changes on submission.
  const context = await browser.newContext();
  const member = await context.newPage();
  await login(member, "requests-soldier@example.invalid");
  for (const [dutyId, kind] of [
    [removedId, "cancel"],
    [rejectedId, "postpone"],
  ] as const) {
    await member.goto(`/duties/${dutyId}`);
    await member.getByRole("button", { name: "בקשת ביטול או דחייה" }).click();
    const dialog = member.getByRole("dialog");
    await dialog.getByLabel("מה מבקשים").selectOption(kind);
    await dialog
      .getByLabel("סיבת הבקשה, למשל פטור שלדעתך חל עליך")
      .fill("פטור רפואי שטרם הוזן");
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(member.getByText("ממתינה להחלטת אחראי")).toBeVisible();
  }
  await expect(
    member.getByRole("button", { name: "בקשת ביטול או דחייה" })
  ).toHaveCount(0);
  expect(
    (await db.select().from(assignments)).filter(
      (row) => row.status === "reserved"
    )
  ).toHaveLength(2);

  // The manager prepares a removal, reviews the affected soldier and publishes.
  await page.goto("/requests");
  const requests = panel(page, "בקשות ביטול ודחייה");
  const removal = requests
    .locator("article")
    .filter({ hasText: "תורנות לביטול" });
  await expect(
    removal.getByText("סיבת הבקשה: פטור רפואי שטרם הוזן")
  ).toBeVisible();
  await removal.getByRole("button", { name: "הכנת הסרה מהמקום" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("סיבת השינוי")
    .fill("הפטור אומת מול המסמכים");
  await page.getByRole("dialog").getByRole("button", { name: "שמירה" }).click();
  await removal.getByRole("link", { name: "להצעת השינוי" }).click();
  await expect(
    page.getByText("ההצעה מטפלת בבקשת הביטול של חייל מבקש")
  ).toBeVisible();
  await page.getByRole("button", { name: "בדיקת השפעת השינוי" }).click();
  const compare = page.getByRole("dialog");
  await expect(
    compare.getByRole("row", { name: /חייל מבקש/ }).getByText("השיבוץ יוסר")
  ).toBeVisible();
  await compare
    .getByLabel("בדקתי את השינויים, הסרת השיבוצים והניקוד ומאשר לפרסם")
    .check();
  await compare.getByRole("button", { name: "עדכן ופרסם" }).click();
  await expect(compare).toHaveCount(0);

  // Rejecting keeps the seat and gives the soldier the reason.
  await page.goto("/requests");
  const rejection = requests
    .locator("article")
    .filter({ hasText: "תורנות לדחייה" });
  await rejection.getByRole("button", { name: "דחיית הבקשה" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("סיבת הדחייה")
    .fill("אין מחליף בתאריכים האלה");
  await page.getByRole("dialog").getByRole("button", { name: "שמירה" }).click();
  await expect(rejection.getByText("נדחה", { exact: true })).toBeVisible();
  await expect(
    requests
      .locator("article")
      .filter({ hasText: "תורנות לביטול" })
      .getByText("הושלמה", { exact: true })
  ).toBeVisible();
  await expect(requests.getByText("החליט/ה: אחראי בקשות")).toHaveCount(2);
  await page.screenshot({
    path: "test-results/cancellation-requests-manager.png",
    fullPage: true,
  });

  const reserved = (await db.select().from(assignments)).filter(
    (row) => row.status === "reserved"
  );
  expect(reserved.map((row) => row.dutyId)).toEqual([rejectedId]);

  // The soldier sees both outcomes and reasons, without the manager's name, also on a phone.
  await member.setViewportSize({ width: 390, height: 844 });
  await member.goto("/requests");
  const mine = panel(member, "בקשות הביטול והדחייה שלי");
  await expect(
    mine.getByText("הבקשה נדחתה: אין מחליף בתאריכים האלה", { exact: false })
  ).toBeVisible();
  await expect(
    mine.getByText("החייל הוסר מהשיבוץ בעדכון שפורסם", { exact: false })
  ).toBeVisible();
  await expect(mine.getByText("אחראי בקשות")).toHaveCount(0);
  expect(
    await member.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await member.screenshot({
    path: "test-results/cancellation-requests-soldier.png",
    fullPage: true,
  });
  await context.close();
});
