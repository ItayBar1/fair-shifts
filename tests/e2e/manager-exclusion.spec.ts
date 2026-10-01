import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, unitTransaction } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { settleDue } from "../../src/server/scoring";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

// A duty manager is never assigned to a duty (card #82, decision 192). Synthetic people only.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const people = {
  technical: ["מנהל טכני לבדיקה", "", "technical-82@example.invalid"],
  fresh: ["אחראי בלי היסטוריה", "560001", "manager-fresh@example.invalid"],
  history: ["אחראי עם היסטוריה", "560002", "manager-history@example.invalid"],
  alon: ["אלון", "560003", "alon-82@example.invalid"],
  bar: ["בר", "560004", "bar-82@example.invalid"],
  appointed: ["חייל שמתמנה", "560005", "appointed-82@example.invalid"],
} as const;
type Key = keyof typeof people;
const actors = {} as Record<Key, Actor>;

async function invite(key: Key, role: Actor["role"], balance = 0) {
  const [name, personalNumber, email] = people[key];
  let soldierId: string | undefined;
  if (role !== "technical") {
    soldierId = randomUUID();
    const data = soldier({ id: soldierId, name, personalNumber });
    await db
      .insert(soldiers)
      .values({ id: soldierId, name, personalNumber, data });
    await db.insert(soldierContacts).values({ soldierId, email });
    await db.insert(balances).values({ soldierId, current: balance });
  }
  const account = await createInvitedAccount({ name, email, role, soldierId });
  actors[key] = { id: account.id, name, role, soldierId, securityEpoch: 1 };
  return actors[key];
}
const run = async (
  actor: Actor,
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) =>
  (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as Record<string, unknown> & { id: string; version: number };
async function account(key: Key) {
  const [row] = await db.select().from(user).where(eq(user.id, actors[key].id));
  return row;
}
async function setRole(key: Key, role: "soldier" | "manager") {
  await run(
    actors.technical,
    "account.role",
    { id: actors[key].id, role },
    (await account(key)).securityEpoch
  );
}
/** A duty `days` ahead with `seats` seats, assigned in order to `holders`, and optionally published. */
async function duty(
  name: string,
  days: number,
  seats: number,
  holders: Key[],
  publish: boolean
) {
  const type = await run(actors.fresh, "dutyType.save", {
    name: `סוג ${randomUUID().slice(0, 6)}`,
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: seats }],
  });
  const start = Math.floor(Date.now() / HOUR) * HOUR + days * DAY;
  const created = await run(actors.fresh, "duty.create", {
    typeId: type.id,
    name,
    start: new Date(start).toISOString(),
    end: new Date(start + 8 * HOUR).toISOString(),
  });
  const [row] = await db.select().from(duties).where(eq(duties.id, created.id));
  let version = 1;
  for (const [index, key] of holders.entries()) {
    await run(
      actors.fresh,
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[index].id,
        soldierId: actors[key].soldierId,
      },
      version++
    );
  }
  if (publish)
    await run(
      actors.fresh,
      "duty.publish",
      { id: row.id, confirmed: true },
      version
    );
  return row.id;
}
async function login(page: Page, email: string, heading = "לוח התורנויות") {
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
    page.getByRole("heading", { name: heading, exact: true })
  ).toBeVisible();
}
// One sign-in code a minute per account: a session is reused by the tests that follow.
const sessions: Partial<Record<Key, Page>> = {};
async function signedIn(browser: Browser, key: Key, heading?: string) {
  const known = sessions[key];
  if (known && !known.isClosed()) {
    await known.goto("/");
    return known;
  }
  const page = await (await browser.newContext()).newPage();
  await login(page, people[key][2], heading);
  sessions[key] = page;
  return page;
}
const fits = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth
  );
const tile = (page: Page, label: string) =>
  page.locator(".stat", { hasText: label });

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
  await invite("technical", "technical");
  await invite("fresh", "manager");
  await invite("history", "soldier");
  await invite("alon", "soldier", 10);
  await invite("bar", "soldier", 20);
  await invite("appointed", "soldier");

  // The first manager held a duty as a soldier: it ended and was credited before the appointment.
  const past = await duty("תורנות מהעבר", 3, 1, ["history"], true);
  const [row] = await db.select().from(duties).where(eq(duties.id, past));
  const start = Date.now() - 2 * DAY;
  await db
    .update(duties)
    .set({
      data: {
        ...row.data,
        start: new Date(start).toISOString(),
        end: new Date(start + 8 * HOUR).toISOString(),
      },
    })
    .where(eq(duties.id, past));
  await unitTransaction((tx) => settleDue(tx));
  await setRole("history", "manager");
});

test("managers are outside the ranking, the pickers and a soldier's lists, and the calendar shows what fits each", async ({
  browser,
}) => {
  const ahead = await duty("תורנות קדימה", 4, 1, ["alon"], true);
  // Half staffed, in the month on display, for the vacant-seats measure.
  await duty("תורנות חצי מאוישת", 1 / 24, 2, ["bar"], true);
  const open = await duty("טיוטה לשיבוץ", 6, 1, [], false);

  // A manager with earlier duties keeps "my duties" and "my score", and shows them.
  const history = await signedIn(browser, "history");
  await expect(tile(history, "התורנויות שלי")).toBeVisible();
  await expect(tile(history, "הניקוד שלי")).toContainText("4");
  await expect(tile(history, "ממתינים לטיפול")).toHaveCount(0);
  await expect(
    history.getByRole("button", { name: "התורנויות שלי", exact: true })
  ).toBeVisible();
  // A manager is not assigned, so has no constraints to submit.
  await expect(
    history.getByRole("link", { name: "האילוצים שלי", exact: true })
  ).toHaveCount(0);
  await history.goto("/constraints");
  await expect(
    history.getByText("המסך הזה אינו זמין לחשבון שלך")
  ).toBeVisible();

  await history.goto("/fairness");
  const table = history.locator("tbody tr");
  await expect(table).toHaveCount(5);
  // Soldiers are ranked by balance; the managers follow, marked, without a place.
  await expect(table.nth(0)).toContainText("חייל שמתמנה");
  await expect(table.nth(0).locator(".rank-number")).toHaveText("1");
  await expect(table.nth(1)).toContainText("אלון");
  await expect(table.nth(1).locator(".rank-number")).toHaveText("2");
  await expect(table.nth(2)).toContainText("בר");
  await expect(table.nth(2).locator(".rank-number")).toHaveText("3");
  for (const [index, name] of [
    [3, "אחראי בלי היסטוריה"],
    [4, "אחראי עם היסטוריה"],
  ] as const) {
    await expect(table.nth(index)).toContainText(name);
    await expect(table.nth(index)).toContainText("אחראי, לא משתתף");
    await expect(table.nth(index)).toContainText("מוקפאת");
    await expect(table.nth(index).locator(".rank-number")).toHaveText("—");
  }
  await expect(table.nth(4)).toContainText("אני");
  await expect(table.nth(4)).toContainText("4");
  await expect(history.getByText("אחראים מחוץ לדירוג")).toBeVisible();
  await history.screenshot({
    path: "test-results/manager-fairness.png",
    fullPage: true,
  });
  await history.setViewportSize({ width: 390, height: 844 });
  await expect(table.nth(4)).toContainText("אחראי, לא משתתף");
  expect(await fits(history)).toBe(true);
  await history.screenshot({
    path: "test-results/manager-fairness-mobile.png",
    fullPage: true,
  });

  // A manager with no earlier duties sees management measures in their place.
  const fresh = await signedIn(browser, "fresh");
  await expect(tile(fresh, "התורנויות שלי")).toHaveCount(0);
  await expect(tile(fresh, "הניקוד שלי")).toHaveCount(0);
  await expect(tile(fresh, "ממתינים לטיפול")).toContainText("0");
  await expect(
    fresh.getByRole("button", { name: "התורנויות שלי", exact: true })
  ).toHaveCount(0);
  // The vacant seats of the duties published in the month on display.
  const month = DateTime.now().setZone("Asia/Jerusalem");
  const from = month.startOf("month").toMillis();
  const to = month.endOf("month").toMillis();
  let vacant = 0;
  for (const row of await db.select().from(duties)) {
    const live = await db
      .select()
      .from(assignments)
      .where(eq(assignments.dutyId, row.id));
    if (
      row.data.status !== "published" ||
      new Date(row.data.start).getTime() > to ||
      new Date(row.data.end).getTime() < from
    )
      continue;
    vacant += row.data.slots.filter(
      (slot) =>
        !live.some(
          (item) => item.slotId === slot.id && item.status !== "cancelled"
        )
    ).length;
  }
  await expect(tile(fresh, "מקומות פנויים בחודש")).toContainText(
    String(vacant)
  );
  expect(vacant).toBeGreaterThan(0);
  await fresh.screenshot({ path: "test-results/manager-calendar.png" });

  // The manual assignment list holds soldiers only.
  await fresh.goto(`/duties/${open}`);
  await fresh.getByRole("button", { name: "שיבוץ ידני", exact: true }).click();
  const options = await fresh
    .getByLabel("בחירת חייל")
    .locator("option")
    .allTextContents();
  expect(options.filter((text) => text !== "בחירה…").sort()).toEqual(
    ["אלון", "בר", "חייל שמתמנה"].sort()
  );
  await fresh.keyboard.press("Escape");

  // A soldier sees no manager in the table or among the possible replacements,
  // and the past duty still names the manager who held it.
  const alon = await signedIn(browser, "alon");
  await alon.goto("/fairness");
  const rows = alon.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  const body = alon.locator("tbody");
  for (const text of [
    "אחראי בלי היסטוריה",
    "אחראי עם היסטוריה",
    "אחראי, לא משתתף",
    "מוקפאת",
  ])
    await expect(body).not.toContainText(text);
  await alon.goto(`/duties/${ahead}`);
  await alon.getByRole("button", { name: "הצעה להעברה", exact: true }).click();
  const replacements = await alon
    .getByLabel("למי להציע")
    .locator("option")
    .allTextContents();
  expect(replacements.sort()).toEqual(["בר", "חייל שמתמנה"].sort());
  await alon.keyboard.press("Escape");
  const [pastRow] = await db
    .select()
    .from(duties)
    .where(eq(duties.name, "תורנות מהעבר"));
  await alon.goto(`/duties/${pastRow.id}`);
  await expect(alon.getByText("אחראי עם היסטוריה").first()).toBeVisible();
});

test("appointing a soldier marks their seats for the managers, and removing the role asks for a decision on the balance", async ({
  browser,
}) => {
  const kept = await duty("תורנות שהוא מחזיק", 5, 1, ["appointed"], true);
  const draft = await duty("טיוטה שהוא מחזיק", 7, 1, ["appointed"], false);
  const spare = await duty("טיוטה פנויה", 9, 1, [], false);

  const technical = await signedIn(browser, "technical", "תמונת מצב");
  await technical.goto("/technical/permissions");
  const accountRow = technical.locator(".task-item", {
    hasText: "חייל שמתמנה",
  });
  await accountRow.getByRole("button", { name: "הענקת הרשאת אחראי" }).click();
  await expect(technical.getByText("השינוי נשמר")).toBeVisible();
  await expect(accountRow.getByText("אחראי תורנויות")).toBeVisible();

  const fresh = await signedIn(browser, "fresh");
  await fresh.goto("/notifications");
  await expect(
    fresh.getByRole("heading", { name: "חייל מונה לאחראי תורנויות" })
  ).toBeVisible();
  await expect(
    fresh.getByText(/חייל שמתמנה מונה לאחראי תורנויות.*2 שיבוצים שלו מסומנים/)
  ).toBeVisible();

  // Both reservations stay and wait in the handling center, and the calendar counts them.
  await fresh.goto("/manage");
  const concerns = fresh.locator(".task-item", {
    hasText: "חייל שמתמנה — שיבוץ דורש טיפול",
  });
  await expect(concerns).toHaveCount(2);
  await expect(concerns.first()).toContainText("מונה לאחראי תורנויות");
  await fresh.goto("/calendar");
  await expect(tile(fresh, "ממתינים לטיפול")).toContainText("2");
  await fresh.goto(`/duties/${kept}`);
  await expect(
    fresh.locator(".slot-row", { hasText: "חייל שמתמנה" })
  ).toContainText("דורש טיפול");
  await fresh.goto(`/duties/${draft}`);
  await expect(
    fresh.locator(".slot-row", { hasText: "חייל שמתמנה" })
  ).toContainText("דורש טיפול");
  expect(
    (await db.select().from(assignments)).filter((row) =>
      row.data.needsAttention?.includes("manager")
    )
  ).toHaveLength(2);

  // Removing the role clears the marks and opens one item about the balance.
  await technical.reload();
  await technical
    .locator(".task-item", { hasText: "חייל שמתמנה" })
    .getByRole("button", { name: "הסרת הרשאת אחראי" })
    .click();
  await expect(technical.getByText("השינוי נשמר")).toBeVisible();
  await fresh.goto("/manage");
  await expect(concerns).toHaveCount(0);
  const panel = fresh.locator("section.panel", {
    has: fresh.getByRole("heading", { name: "אחראים שחזרו להיות חיילים" }),
  });
  const item = panel.getByTestId("manager-return");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("חייל שמתמנה");
  await expect(item).toContainText("יתרה מוקפאת 0");
  await panel.screenshot({ path: "test-results/manager-return.png" });
  await fresh.setViewportSize({ width: 390, height: 844 });
  expect(await fits(fresh)).toBe(true);
  await panel.screenshot({ path: "test-results/manager-return-mobile.png" });
  await fresh.setViewportSize({ width: 1280, height: 720 });

  await item.getByRole("button", { name: "קביעת יתרה", exact: true }).click();
  const dialog = fresh.getByRole("dialog");
  await dialog.getByLabel("היתרה החדשה").fill("50");
  await dialog.getByLabel("סיבה").fill("חזרה מתפקיד אחראי");
  await dialog.getByRole("button", { name: "תצוגה מקדימה" }).click();
  await expect(dialog).toContainText("חייל שמתמנה: 0 ← 50");
  // A preview decides nothing.
  await expect(
    (await db.select().from(records)).filter(
      (row) => row.kind === "manager_return"
    )[0].data.status
  ).toBe("pending");
  await dialog.getByRole("button", { name: "אישור שינוי היתרה" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(panel).toHaveCount(0);
  const [balance] = await db
    .select()
    .from(balances)
    .where(eq(balances.soldierId, actors.appointed.soldierId!));
  expect(balance.current).toBe(50);
  const [closed] = (await db.select().from(records)).filter(
    (row) => row.kind === "manager_return"
  );
  expect(closed.data).toMatchObject({ status: "closed", outcome: "adjusted" });
  // From now on the soldier is assignable again.
  const [free] = await db.select().from(duties).where(eq(duties.id, spare));
  const preview = await run(
    actors.fresh,
    "duty.assignment.preview",
    {
      dutyId: spare,
      slotId: free.data.slots[0].id,
      soldierId: actors.appointed.soldierId,
    },
    free.version
  );
  expect(preview.status).toBe("eligible");
});
