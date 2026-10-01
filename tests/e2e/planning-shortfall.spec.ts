import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  soldiers,
  balances,
  assignments,
  duties,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

const managerEmail = "planning-manager@example.invalid";
const planned = DateTime.now()
  .setZone("Asia/Jerusalem")
  .plus({ days: 12 })
  .toISODate()!;
let manager: Actor;
// A manager takes no part in duties (decision 192), so a second soldier is the other available one.
let second: string;
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
  const ids: Record<string, string> = {};
  for (const [name, personalNumber, inactive] of [
    ["אחראי תכנון", "500001", false],
    ["תורן זמין", "500002", false],
    ["תורן באי־פעילות", "500003", true],
    ["תורן זמין נוסף", "500005", false],
  ] as const) {
    const id = randomUUID();
    const data = soldier({
      id,
      name,
      personalNumber,
      inactivePeriods: inactive ? [{ start: planned, end: planned }] : [],
    });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(balances).values({ soldierId: id });
    ids[name] = id;
  }
  second = ids["תורן זמין נוסף"];
  const account = await createInvitedAccount({
    name: "אחראי תכנון",
    email: managerEmail,
    role: "manager",
    soldierId: ids["אחראי תכנון"],
  });
  manager = {
    id: account.id,
    name: account.name,
    role: "manager",
    soldierId: account.soldierId!,
    securityEpoch: 1,
  };
});
async function command(
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) {
  return (await executeAction(manager, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as { id: string; version: number };
}
async function login(page: Page, email: string) {
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
  )
    .filter((row) => row.kind === "login-code")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  await page
    .getByLabel("קוד כניסה", { exact: true })
    .fill(openSecret(message.encryptedSecret!));
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}

test("a period plan explains each shortfall, and a changed draw drops its approval form", async ({
  page,
}) => {
  const type = await command("dutyType.save", {
    name: "שמירה לתכנון חסר",
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "שומר", count: 3 }],
  });
  const start = DateTime.fromISO(`${planned}T08:00`, {
    zone: "Asia/Jerusalem",
  });
  await command("duty.create", {
    typeId: type.id,
    name: "שמירה עם חוסר",
    start: start.toISO(),
    end: start.plus({ hours: 8 }).toISO(),
  });

  await login(page, managerEmail);
  await page.goto("/manage/planning");
  await page.getByLabel("מתאריך", { exact: true }).fill(planned);
  await page.getByLabel("עד תאריך", { exact: true }).fill(planned);
  await page.getByRole("button", { name: "יצירת ריצת תכנון" }).click();
  await expect(page.getByText(/הסתיים · 1 מקומות לא מאוישים/)).toBeVisible();
  // Two eligible soldiers take two seats; nobody, the manager included, is forced into the third.
  expect(await db.select().from(assignments)).toHaveLength(2);

  const runs = page.locator("section").filter({
    has: page.getByRole("heading", { name: "ריצות תכנון שמורות", exact: true }),
  });
  await runs.getByText("מקומות לא מאוישים וסיבות הפסילה").click();
  const reason = runs.getByText(/^אין מועמדים מתאימים:/);
  await expect(reason).toContainText("החייל כבר משובץ במופע זה (2)");
  await expect(reason).toContainText("התורנות חופפת לתקופת אי־פעילות (1)");
  await expect(
    runs.getByRole("link").filter({ hasText: /שמירה עם חוסר · .* · שומר/ })
  ).toHaveCount(1);
  await runs.screenshot({ path: "test-results/planning-shortfall.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(reason).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await runs.screenshot({ path: "test-results/planning-shortfall-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 720 });

  // A waiting proposal whose draw changed drops its approval form without a
  // manual refresh (same session: one login code per minute).
  const day = DateTime.now().setZone("Asia/Jerusalem").plus({ days: 14 });
  await db.update(balances).set({ current: 100 });
  const id = randomUUID();
  const data = soldier({
    id,
    name: "לפני שחרור",
    personalNumber: "500004",
    service: {
      type: "mandatory",
      basePopulation: "mandatory",
      graceEligible: false,
      releaseDate: day.plus({ days: 10 }).toISODate()!,
    },
  });
  await db
    .insert(soldiers)
    .values({ id, name: data.name, personalNumber: data.personalNumber, data });
  await db.insert(balances).values({ soldierId: id, current: 0 });
  const releaseType = await command("dutyType.save", {
    name: "שמירה לפני שחרור",
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "שומר", count: 1 }],
  });
  const releaseStart = day.set({
    hour: 8,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const duty = await command("duty.create", {
    typeId: releaseType.id,
    name: "הצעה שמתיישנת",
    start: releaseStart.toISO(),
    end: releaseStart.plus({ hours: 8 }).toISO(),
  });
  const [row] = await db.select().from(duties).where(eq(duties.id, duty.id));
  await command(
    "duty.lottery",
    { dutyId: duty.id, slotId: row.data.slots[0]!.id },
    row.version
  );

  await page.goto(`/duties/${duty.id}`);
  const approveButton = page.getByRole("button", {
    name: "אישור המועמד ושיבוץ",
  });
  await expect(approveButton).toBeVisible();
  // Another soldier's score drops into the band: the draw is no longer the same.
  await db
    .update(balances)
    .set({ current: 2 })
    .where(eq(balances.soldierId, second));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(approveButton).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /התיישן — נדרשת הגרלה חדשה/ })
  ).toBeVisible();
});
