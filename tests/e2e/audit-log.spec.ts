import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import { soldiers, balances, soldierContacts } from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

const people = [
  ["אחראי יומן", "audit-manager@example.invalid", "manager", "000201"],
  ["אחראי שני ליומן", "audit-second@example.invalid", "manager", "000202"],
  ["חייל יומן", "audit-soldier@example.invalid", "soldier", "000203"],
] as const;
const actors: Record<string, Actor> = {};

async function command(
  actor: Actor,
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) {
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as { id: string; token: string };
}

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
  for (const [name, email, role, personalNumber] of people) {
    const id = randomUUID();
    const data = soldier({ id, name, personalNumber });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(soldierContacts).values({ soldierId: id, email });
    await db.insert(balances).values({ soldierId: id });
    const account = await createInvitedAccount({
      name,
      email,
      role,
      soldierId: id,
    });
    actors[email] = {
      id: account.id,
      name,
      role,
      soldierId: id,
      securityEpoch: 1,
    };
  }
  const manager = actors["audit-manager@example.invalid"];
  const second = actors["audit-second@example.invalid"];
  const member = actors["audit-soldier@example.invalid"];
  // The second manager changes a balance; the first sets a backdated rank.
  const input = {
    soldierIds: [member.soldierId],
    operation: "add",
    value: 7,
    reason: "תיקון יתרה סינתטי ליומן",
  };
  const preview = await command(second, "score.preview", input);
  await command(second, "score.apply", { ...input, token: preview.token });
  const rank = await command(manager, "rank.catalog.save", {
    name: "דרגה סינתטית ליומן",
    track: "מסלול סינתטי",
    order: 1,
    source: "נתוני בדיקה",
  });
  await command(
    manager,
    "rank.set",
    {
      soldierId: member.soldierId,
      rankId: rank.id,
      effectiveDate: "2026-01-31",
      reason: "אישור דרגה רטרואקטיבי",
    },
    1
  );
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
const entry = (page: Page, label: string) =>
  page.getByRole("article", { name: label });

test("a manager reads who did what and why, and reaches it from the soldier and the score ledger", async ({
  page,
}) => {
  await login(page, "audit-manager@example.invalid");
  await page.goto("/manage/audit");
  const adjustment = entry(page, "שינוי יתרה");
  await expect(adjustment).toContainText("אחראי אחר");
  await expect(adjustment).toContainText("אחראי שני ליומן");
  await expect(adjustment).toContainText("תיקון יתרה סינתטי ליומן");
  await expect(adjustment.getByRole("row", { name: /יתרה 0 7/ })).toBeVisible();

  const rank = entry(page, "עדכון דרגה");
  await expect(rank).toContainText("אני");
  await expect(rank).toContainText("מועד תחולה");
  await expect(rank).toContainText("31.01.2026");
  await expect(rank).toContainText("אישור דרגה רטרואקטיבי");
  await expect(adjustment).not.toContainText("מועד תחולה");

  await page.getByLabel("חיפוש לפי פעולה, מבצע, חייל או תורנות").fill("דרגה");
  await expect(entry(page, "שינוי יתרה")).toHaveCount(0);
  await expect(rank).toBeVisible();
  await page.getByLabel("חיפוש לפי פעולה, מבצע, חייל או תורנות").fill("");

  // From the soldier named on an entry to everything recorded about them.
  await rank.getByRole("link", { name: "חייל יומן" }).click();
  await expect(
    page.getByRole("heading", { name: "תיעוד עבור החייל חייל יומן" })
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(2);

  // From a score ledger row to the event that produced it.
  await page.goto("/manage/scores");
  await page
    .getByRole("row", { name: /תיקון יתרה סינתטי ליומן/ })
    .getByRole("link", { name: "תיעוד" })
    .click();
  await expect(page).toHaveURL(/\/manage\/audit\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(entry(page, "שינוי יתרה")).toBeVisible();
  await page.getByRole("link", { name: "הצגת כל היומן" }).click();
  await expect(page).toHaveURL(/\/manage\/audit$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/manage/audit");
  await expect(entry(page, "עדכון דרגה")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.screenshot({
    path: "test-results/audit-log-mobile.png",
    fullPage: true,
  });
});

test("a soldier has no audit log", async ({ page }) => {
  await login(page, "audit-soldier@example.invalid");
  await page.goto("/manage/audit");
  await expect(
    page.getByRole("heading", { name: "המסך הזה אינו זמין לחשבון שלך" })
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
});
