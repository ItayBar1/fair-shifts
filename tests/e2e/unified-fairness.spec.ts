import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  balances,
  duties,
  ledger,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";
import { signedInHome, submitAuth } from "./auth-submit";

// The fairness table with the score ledger folded in (card #165, decision 220).
// Synthetic people only.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const people = {
  manager: ["אחראי הטבלה", "570001", "manager-165@example.invalid", 0],
  gal: ["גל", "570002", "gal-165@example.invalid", 8],
  alon: ["אלון", "570003", "alon-165@example.invalid", 10],
  bar: ["בר", "570004", "bar-165@example.invalid", 11],
} as const;
type Key = keyof typeof people;
const actors = {} as Record<Key, Actor>;

async function invite(key: Key, role: Actor["role"]) {
  const [name, personalNumber, email, balance] = people[key];
  const soldierId = randomUUID();
  const data = soldier({ id: soldierId, name, personalNumber });
  await db
    .insert(soldiers)
    .values({ id: soldierId, name, personalNumber, data });
  await db.insert(soldierContacts).values({ soldierId, email });
  await db.insert(balances).values({ soldierId, current: balance });
  const account = await createInvitedAccount({ name, email, role, soldierId });
  actors[key] = { id: account.id, name, role, soldierId, securityEpoch: 1 };
}
const run = async (
  type: string,
  payload: Record<string, unknown>,
  v?: number
) =>
  (await executeAction(actors.manager, {
    type,
    payload,
    expectedVersion: v,
    idempotencyKey: randomUUID(),
  })) as Record<string, unknown> & { id: string };
/** A duty `days` ahead worth 4 points, held by `holder`, published or left a draft. */
async function seat(holder: Key, days: number, publish: boolean) {
  const type = await run("dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 1 }],
  });
  const start = Math.floor(Date.now() / HOUR) * HOUR + days * DAY;
  const created = await run("duty.create", {
    typeId: type.id,
    name: publish ? "תורנות שפורסמה" : "טיוטה",
    start: new Date(start).toISOString(),
    end: new Date(start + 8 * HOUR).toISOString(),
  });
  const [row] = await db.select().from(duties).where(eq(duties.id, created.id));
  await run(
    "duty.assign",
    {
      dutyId: row.id,
      slotId: row.data.slots[0].id,
      soldierId: actors[holder].soldierId,
    },
    1
  );
  if (publish) await run("duty.publish", { id: row.id, confirmed: true }, 2);
}
async function login(page: Page, key: Key) {
  const email = people[key][2];
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await submitAuth(
    page,
    "/api/auth/request-code",
    page.getByRole("button", { name: "שליחת קוד למייל" })
  );
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
    page.getByRole("heading", { name: signedInHome, exact: true })
  ).toBeVisible();
}
async function signedIn(browser: Browser, key: Key) {
  const page = await (await browser.newContext()).newPage();
  await login(page, key);
  return page;
}
const fits = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth
  );
/** The names in the table, top to bottom. */
const order = (page: Page) =>
  page
    .locator(".fairness-table tbody tr:not(.edit-row) .cell-name strong")
    .allTextContents();
const balanceOf = async (key: Key) =>
  (
    await db
      .select()
      .from(balances)
      .where(eq(balances.soldierId, actors[key].soldierId!))
  )[0].current;

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
  await invite("manager", "manager");
  for (const key of ["gal", "alon", "bar"] as const)
    await invite(key, "soldier");
  // Alon holds a published seat; Gal only a draft one.
  await seat("alon", 4, true);
  await seat("gal", 6, false);
});

test("a manager sorts the table, adds the points ahead and changes balances from it", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, "manager");
  // The score screen's old address leads to the one table; its menu item is gone.
  await page.goto("/manage/scores");
  await expect(
    page.getByRole("heading", { name: "טבלת הצדק", exact: true })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "ניקוד והיסטוריה" })).toHaveCount(
    0
  );
  expect(await order(page)).toEqual(["גל", "אלון", "בר", "אחראי הטבלה"]);

  // Sorted like a spreadsheet, by any column, and back.
  const nameHead = page.getByRole("columnheader", { name: "שם החייל" });
  await nameHead.getByRole("button").click();
  await expect(nameHead).toHaveAttribute("aria-sort", "ascending");
  expect(await order(page)).toEqual(["אלון", "בר", "גל", "אחראי הטבלה"]);
  await nameHead.getByRole("button").click();
  await expect(nameHead).toHaveAttribute("aria-sort", "descending");
  expect(await order(page)).toEqual(["גל", "בר", "אלון", "אחראי הטבלה"]);
  await page
    .getByRole("columnheader", { name: "דירוג" })
    .getByRole("button")
    .click();

  // With the points ahead, drafts included, the ranking follows the sum.
  const future = page.getByRole("switch", { name: "כולל ניקוד עתידי" });
  await expect(future).not.toBeChecked();
  await future.check();
  expect(await order(page)).toEqual(["בר", "גל", "אלון", "אחראי הטבלה"]);
  const galRow = page.locator("tbody tr", { hasText: "גל" });
  await expect(galRow.locator(".score-number")).toHaveText("12");
  await expect(galRow).toContainText("נוכחי 8 · עתידי 4");
  // The cell shows the sum now, so it cannot be edited.
  await expect(
    page.getByRole("button", { name: /^עריכת היתרה של/ })
  ).toHaveCount(0);
  await future.uncheck();

  // A balance typed into its cell is saved only with a reason and a confirmation.
  await page.getByRole("button", { name: "עריכת היתרה של בר" }).click();
  const cell = page.getByLabel("יתרה חדשה לבר");
  await cell.fill("15");
  await cell.press("Enter");
  const line = page.getByRole("form", { name: "אישור יתרה חדשה לבר" });
  await expect(line).toContainText("בר: 11 ← 15");
  await expect(line.getByRole("button", { name: "אישור" })).toBeDisabled();
  expect(await balanceOf("bar")).toBe(11);
  await line.getByLabel("סיבת השינוי").fill("תיקון מהטבלה");
  await line.getByRole("button", { name: "אישור" }).click();
  await expect(line).toHaveCount(0);
  await expect(
    page.locator("tbody tr", { hasText: "בר" }).locator(".score-number")
  ).toHaveText("15");
  expect(await balanceOf("bar")).toBe(15);

  // Several soldiers chosen by their boxes change together, after a preview.
  await page.getByLabel("בחירת גל").check();
  await page.getByLabel("בחירת אלון").check();
  const bar = page.getByRole("region", { name: "פעולה על הנבחרים" });
  await expect(bar).toContainText("2 נבחרו");
  await page.screenshot({
    path: "test-results/unified-fairness-selection.png",
    fullPage: true,
    animations: "disabled",
  });
  await bar.getByRole("button", { name: "שינוי יתרה…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("פעולה").selectOption("add");
  await dialog.getByLabel("ערך").fill("2");
  await dialog.getByLabel("סיבה").fill("נרמול מהטבלה");
  await dialog.getByRole("button", { name: "תצוגה מקדימה" }).click();
  await expect(dialog).toContainText("גל: 8 ← 10");
  await expect(dialog).toContainText("אלון: 10 ← 12");
  expect(await balanceOf("gal")).toBe(8);
  await dialog.getByRole("button", { name: "אישור שינוי היתרה" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(bar).toHaveCount(0);
  expect(await balanceOf("gal")).toBe(10);
  expect(await balanceOf("alon")).toBe(12);
  // Every change is a new ledger entry; none is edited.
  expect(
    (await db.select().from(ledger)).map((row) => row.kind).sort()
  ).toEqual(["adjustment", "normalization", "normalization"]);

  // A soldier's drawer: the balance, the points ahead and their own history.
  await page.getByRole("button", { name: "הניקוד של אלון" }).click();
  const drawer = page.getByRole("dialog", { name: "ניקוד · אלון" });
  await expect(drawer).toContainText("שמור לשיבוצים, כולל טיוטות");
  await expect(drawer.getByRole("row", { name: /נרמול מהטבלה/ })).toHaveCount(
    1
  );
  await expect(drawer.getByRole("row", { name: /תיקון מהטבלה/ })).toHaveCount(
    0
  );
  await page.screenshot({
    path: "test-results/unified-fairness-drawer.png",
    fullPage: false,
    animations: "disabled",
  });
  await drawer.getByRole("button", { name: "סגירה" }).click();
  await expect(drawer).toHaveCount(0);

  // The whole unit's ledger, filtered and sorted.
  await page.getByRole("button", { name: "יומן היחידה" }).click();
  const unit = page.getByRole("dialog", { name: "יומן הניקוד של היחידה" });
  await expect(unit.locator("tbody tr")).toHaveCount(3);
  await unit.getByLabel("חיפוש לפי חייל או סיבה").fill("בר");
  await expect(unit.locator("tbody tr")).toHaveCount(1);
  await expect(unit.locator("tbody tr")).toContainText("שינוי יתרה");
  await unit.getByRole("button", { name: "ניקוי הסינון" }).click();
  await unit.getByLabel("סינון לפי סוג").selectOption("נרמול קבוצתי");
  await expect(unit.locator("tbody tr")).toHaveCount(2);
  await expect(
    unit.getByRole("link", { name: "פירוט הפעולה" }).first()
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/unified-fairness-ledger.png",
    fullPage: false,
    animations: "disabled",
  });
  await unit.getByRole("button", { name: "סגירה" }).click();
  await expect(unit).toHaveCount(0);

  // On a phone: no sideways scroll, the selection box beside each row.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await fits(page)).toBe(true);
  await page.screenshot({
    path: "test-results/unified-fairness-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({
    path: "test-results/unified-fairness-manager.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("a soldier sorts and adds published points ahead, and opens only their own row", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const page = await signedIn(browser, "bar");
  await page.goto("/fairness");
  await expect(page.locator(".fairness-table tbody tr")).toHaveCount(3);
  // Nothing to choose, edit or read beyond their own history.
  await expect(page.getByRole("checkbox", { name: /^בחירת/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^עריכת היתרה של/ })
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "יומן היחידה" })).toHaveCount(
    0
  );
  await expect(
    page.getByRole("button", { name: "הניקוד של אלון" })
  ).toHaveCount(0);

  // A draft is never counted for a soldier: Gal's draft seat adds nothing.
  await page.getByRole("switch", { name: "כולל ניקוד עתידי" }).check();
  const galRow = page.locator("tbody tr", { hasText: "גל" });
  await expect(galRow.locator(".score-number")).toHaveText("10");
  const alonRow = page.locator("tbody tr", { hasText: "אלון" });
  await expect(alonRow.locator(".score-number")).toHaveText("16");
  expect(await order(page)).toEqual(["גל", "בר", "אלון"]);
  await page.screenshot({
    path: "test-results/unified-fairness-soldier.png",
    fullPage: true,
    animations: "disabled",
  });

  // Their own row opens their history, without reasons or audit links (decision 168).
  await page.getByRole("button", { name: "הניקוד של בר" }).click();
  const drawer = page.getByRole("dialog", { name: "ניקוד · בר" });
  await expect(drawer).toContainText("בתורנויות שפורסמו");
  await expect(drawer.locator("tbody tr")).toHaveCount(1);
  await expect(drawer.locator("tbody tr")).toContainText("שינוי יתרה");
  await expect(drawer).not.toContainText("תיקון מהטבלה");
  await expect(drawer.getByRole("link", { name: "פירוט הפעולה" })).toHaveCount(
    0
  );
  await expect(
    drawer.getByRole("button", { name: "תצוגה מקדימה" })
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await fits(page)).toBe(true);
  await page.screenshot({
    path: "test-results/unified-fairness-soldier-drawer-mobile.png",
    fullPage: false,
    animations: "disabled",
  });
});
