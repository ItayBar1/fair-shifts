import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
  dutySlots,
  dutyTypes,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { assignment, duty, soldier } from "../fixtures";

// Every screen of every role, as the browser shows it (scenarios 2 and 35,
// stories 35 and 36): Hebrew right to left, labelled controls, no sideways
// scroll on a phone, the keyboard, and the screens a role may not open.
type Key = "soldier" | "manager" | "otherManager" | "technical";
const people: Record<
  Key,
  { name: string; email: string; role: "soldier" | "manager" | "technical" }
> = {
  soldier: {
    name: "חייל הסריקה",
    email: "sweep-soldier@example.invalid",
    role: "soldier",
  },
  manager: {
    name: "אחראי ראשון",
    email: "sweep-manager@example.invalid",
    role: "manager",
  },
  otherManager: {
    name: "אחראי שני",
    email: "sweep-other@example.invalid",
    role: "manager",
  },
  technical: {
    name: "טכני הסריקה",
    email: "sweep-technical@example.invalid",
    role: "technical",
  },
};
const screens: Record<Key, { path: string; title: string }[]> = {
  soldier: [
    { path: "/calendar", title: "לוח התורנויות" },
    { path: "/fairness", title: "טבלת הצדק" },
    { path: "/constraints", title: "האילוצים שלי" },
    { path: "/requests", title: "החלפות ובקשות" },
    { path: "/notifications", title: "הודעות" },
    { path: "/settings", title: "העדפות אישיות" },
  ],
  manager: [
    { path: "/calendar", title: "לוח התורנויות" },
    { path: "/fairness", title: "טבלת הצדק" },
    { path: "/requests", title: "החלפות ובקשות" },
    { path: "/notifications", title: "הודעות" },
    { path: "/settings", title: "העדפות אישיות" },
    { path: "/manage", title: "מרכז טיפול" },
    { path: "/manage/soldiers", title: "חיילי היחידה" },
    { path: "/manage/eligibility", title: "פטורים וכשירויות" },
    { path: "/manage/ranks", title: "דרגות ופז״ם" },
    { path: "/manage/constraints", title: "סבבי אילוצים" },
    { path: "/manage/catalog", title: "קטלוג תורנויות" },
    { path: "/manage/planning", title: "תכנון ושיבוץ" },
    { path: "/manage/publish", title: "פרסום טיוטות" },
    { path: "/manage/scores", title: "ניקוד והיסטוריה" },
    { path: "/manage/imports", title: "ייבוא חיילים" },
    { path: "/manage/audit", title: "יומן פעולות" },
  ],
  otherManager: [],
  technical: [
    { path: "/technical", title: "תמונת מצב" },
    { path: "/technical/permissions", title: "חשבונות והרשאות" },
    { path: "/technical/account", title: "החשבון שלי" },
    { path: "/technical/locked", title: "חשבונות נעולים" },
    { path: "/technical/recovery", title: "שחזור גישה" },
    { path: "/technical/mail", title: "משלוחי מייל" },
    { path: "/technical/backups", title: "גיבוי ושחזור" },
    { path: "/technical/audit", title: "יומן תפעול" },
    { path: "/notifications", title: "הודעות" },
    { path: "/settings", title: "העדפות אישיות" },
  ],
};
screens.otherManager = screens.manager;
const ids = {
  soldier: randomUUID(),
  manager: randomUUID(),
  otherManager: randomUUID(),
  technical: randomUUID(),
};
let dutyId = "";

async function seed(withDuties: boolean) {
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error("E2E requires a dedicated test database");
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  for (const [index, key] of (Object.keys(people) as Key[]).entries()) {
    const person = people[key];
    if (person.role === "technical") {
      await createInvitedAccount({ ...person, id: ids[key] });
      continue;
    }
    const data = soldier({
      id: ids[key],
      name: person.name,
      personalNumber: `86000${index}`,
    });
    await db.insert(soldiers).values({
      id: data.id,
      name: data.name,
      personalNumber: data.personalNumber,
      data,
    });
    await db
      .insert(soldierContacts)
      .values({ soldierId: data.id, email: person.email });
    await db
      .insert(balances)
      .values({ soldierId: data.id, current: key === "soldier" ? 12 : 4 });
    await createInvitedAccount({ ...person, soldierId: data.id });
  }
  if (!withDuties) return;
  const typeId = randomUUID();
  await db
    .insert(dutyTypes)
    .values({ id: typeId, name: "סוג סינתטי", data: {} });
  const tomorrow = DateTime.now().setZone("Asia/Jerusalem").plus({ days: 2 });
  for (const item of [
    { name: "שמירה שפורסמה", published: true },
    { name: "טיוטה של האחראים", published: false },
  ]) {
    const slotId = randomUUID();
    const start = tomorrow.set({ hour: 8, minute: 0, second: 0 });
    const data = {
      ...duty({
        id: randomUUID(),
        typeId,
        name: item.name,
        start: start.toISO()!,
        end: start.plus({ hours: 8 }).toISO()!,
        status: item.published ? "published" : "draft",
        slots: [{ id: slotId, role: "תורן" }],
      }),
      location: "מיקום סינתטי",
      instructions: "לבדיקה בלבד",
    };
    await db
      .insert(duties)
      .values({ id: data.id, typeId, name: data.name, data });
    await db
      .insert(dutySlots)
      .values({ id: slotId, dutyId: data.id, data: { ...data.slots[0] } });
    if (item.published) {
      dutyId = data.id;
      const row = assignment({
        id: randomUUID(),
        dutyId: data.id,
        slotId,
        soldierId: ids.soldier,
        status: "reserved",
      });
      await db.insert(assignments).values({ ...row, data: row });
    }
  }
}
async function login(page: Page, key: Key) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(people[key].email);
  await page.getByRole("button", { name: "שליחת קוד למייל" }).click();
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [account] = await db
    .select()
    .from(user)
    .where(eq(user.email, people[key].email));
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
  await expect(page.locator("main h1")).toBeVisible();
}

/**
 * One sign-in per role for a whole group of tests. Better Auth limits how many
 * sign-ins an address may make in a few seconds, so a test opens a page in the
 * role's session instead of signing in again. Nothing here writes shared data.
 */
function sharedSessions(withDuties: boolean) {
  const contexts = {} as Record<Key, BrowserContext>;
  const opened: Page[] = [];
  test.beforeAll(async ({ browser }) => {
    await seed(withDuties);
    const baseURL = test.info().project.use.baseURL;
    for (const key of Object.keys(people) as Key[]) {
      contexts[key] = await browser.newContext({ baseURL });
      const page = await contexts[key].newPage();
      await login(page, key);
      await page.close();
    }
  });
  test.afterEach(async () => {
    for (const page of opened.splice(0)) await page.close().catch(() => {});
  });
  test.afterAll(async () => {
    for (const context of Object.values(contexts)) await context.close();
  });
  return async (key: Key) => {
    const page = await contexts[key].newPage();
    opened.push(page);
    return page;
  };
}

/** What a person using a phone, a keyboard or a screen reader would trip over. */
async function problemsOf(page: Page) {
  return page.evaluate(() => {
    const found: string[] = [];
    const doc = document.documentElement;
    if (doc.lang !== "he") found.push(`lang=${doc.lang}`);
    if (doc.dir !== "rtl") found.push(`dir=${doc.dir}`);
    if (getComputedStyle(document.body).direction !== "rtl")
      found.push("body is not right to left");
    if (doc.scrollWidth > window.innerWidth)
      found.push(`sideways scroll: ${doc.scrollWidth} > ${window.innerWidth}`);
    const headings = document.querySelectorAll("main h1");
    if (headings.length !== 1) found.push(`${headings.length} headings`);
    if (!/[֐-׿]/.test(headings[0]?.textContent ?? ""))
      found.push("the heading is not Hebrew");
    const text = document.body.innerText;
    for (const marker of [
      "undefined",
      "[object Object]",
      "NaN",
      "Invalid Date",
      "null",
    ])
      if (text.includes(marker)) found.push(`shows "${marker}"`);
    const named = (element: Element) => {
      const labelled = element.getAttribute("aria-labelledby");
      const labels =
        "labels" in element
          ? [...((element as HTMLInputElement).labels ?? [])]
          : [];
      return (
        element.getAttribute("aria-label")?.trim() ||
        (labelled && document.getElementById(labelled)?.textContent?.trim()) ||
        labels
          .map((label) => label.textContent)
          .join("")
          .trim() ||
        element.textContent?.trim() ||
        element.getAttribute("title")?.trim() ||
        (element instanceof HTMLInputElement &&
          ["submit", "button"].includes(element.type) &&
          element.value)
      );
    };
    for (const element of document.querySelectorAll(
      "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab]"
    )) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (!named(element))
        found.push(
          `no name: <${element.tagName.toLowerCase()} class="${element.getAttribute("class") ?? ""}">`
        );
    }
    return found;
  });
}
async function sweep(page: Page, key: Key, withDuties: boolean) {
  const paths = [...screens[key]];
  if (withDuties && key !== "technical")
    paths.push({ path: `/duties/${dutyId}`, title: "פרטי תורנות" });
  const failures: string[] = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const screen of paths) {
      await page.goto(screen.path);
      await expect(
        page.getByRole("heading", { name: screen.title, exact: true, level: 1 })
      ).toBeVisible();
      for (const problem of await problemsOf(page))
        failures.push(`${width}px ${screen.path}: ${problem}`);
    }
  }
  expect(failures).toEqual([]);
}

for (const withDuties of [false, true])
  test.describe(withDuties ? "a unit with duties" : "an empty unit", () => {
    const open = sharedSessions(withDuties);
    for (const key of Object.keys(people) as Key[])
      test(`every screen of the ${key} is Hebrew, named and fits a phone`, async () => {
        test.setTimeout(180_000);
        await sweep(await open(key), key, withDuties);
      });
  });

test.describe("what a role may not open", () => {
  const open = sharedSessions(true);
  const closed: [Key, string][] = [
    ["soldier", "/manage"],
    ["soldier", "/manage/soldiers"],
    ["soldier", "/manage/audit"],
    ["soldier", "/technical"],
    ["manager", "/technical"],
    ["manager", "/technical/backups"],
    ["manager", "/technical/account"],
    ["manager", "/constraints"],
    ["otherManager", "/technical/permissions"],
    ["technical", "/calendar"],
    ["technical", "/fairness"],
    ["technical", "/manage"],
    ["technical", "/constraints"],
  ];
  for (const [key, path] of closed)
    test(`${key} cannot open ${path}, and sees nothing of it`, async () => {
      const page = await open(key);
      await page.goto(path);
      await expect(
        page.getByText("המסך הזה אינו זמין לחשבון שלך")
      ).toBeVisible();
      await expect(page.getByText("שמירה שפורסמה")).toHaveCount(0);
      await expect(page.getByText(people.otherManager.email)).toHaveCount(0);
    });
  test("an address that is no screen says so and leads back", async () => {
    const page = await open("soldier");
    await page.goto("/nowhere");
    await expect(page.getByText("המסך לא נמצא")).toBeVisible();
    await page.getByRole("link", { name: "חזרה ללוח" }).click();
    await expect(page.locator("main h1")).toHaveText("לוח התורנויות");
  });
});

test.describe("the keyboard", () => {
  const open = sharedSessions(true);
  for (const key of Object.keys(people) as Key[])
    test(`reaches the content and the menu of the ${key} without a mouse`, async () => {
      const page = await open(key);
      await page.goto(screens[key][0].path);
      await expect(page.locator("main h1")).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.locator(".skip-link")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/#main$/);
      // The next stop is inside the content, not back in the menu.
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => !!document.activeElement?.closest("main"))
      ).toBe(true);
      // Walk the menu to the last screen of the role and open it with Enter.
      const last = screens[key].find((screen) => screen.path === "/settings")!;
      let reached = false;
      for (let step = 0; step < 80 && !reached; step++) {
        await page.keyboard.press("Shift+Tab");
        reached = await page.evaluate(
          (href) => document.activeElement?.getAttribute("href") === href,
          last.path
        );
      }
      expect(reached, "the settings link is reachable by Shift+Tab").toBe(true);
      await page.keyboard.press("Enter");
      await expect(page.locator("main h1")).toHaveText(last.title);
    });
});

test.describe("loading, failing and signed-out screens", () => {
  const open = sharedSessions(true);
  for (const key of Object.keys(people) as Key[]) {
    const home = screens[key][0];
    test(`shows the ${key} a loading screen, then the content`, async () => {
      const page = await open(key);
      await page.route("**/api/v1/state", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
      });
      await page.goto(home.path);
      await expect(page.locator("main[aria-busy=true]")).toContainText(
        "טוענים את תמונת היחידה"
      );
      await expect(page.locator("main h1")).toHaveText(home.title);
      await expect(page.locator("main[aria-busy=true]")).toHaveCount(0);
    });
    test(`tells the ${key} when the state cannot load, and recovers on retry`, async () => {
      const page = await open(key);
      let failing = true;
      await page.route("**/api/v1/state", async (route) => {
        if (!failing) return route.continue();
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "internal_error",
              message: "הפעולה לא הושלמה. נסו שוב או פנו לאחראי",
            },
          }),
        });
      });
      await page.goto(home.path);
      await expect(
        page.getByText("הפעולה לא הושלמה. נסו שוב או פנו לאחראי")
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "חזרה לכניסה" })
      ).toBeVisible();
      expect(await problemsOf(page)).not.toContain("sideways scroll");
      failing = false;
      await page.getByRole("button", { name: "לנסות שוב" }).click();
      await expect(page.locator("main h1")).toHaveText(home.title);
    });
    test(`sends the ${key} to the sign-in page when the session ended`, async () => {
      const page = await open(key);
      await page.route("**/api/v1/state", (route) =>
        route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "unauthorized", message: "יש להתחבר מחדש" },
          }),
        })
      );
      await page.goto(home.path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByLabel("כתובת המייל המאושרת")).toBeVisible();
    });
    test(`tells the ${key} in a second tab that the form changed, and shows what was saved`, async () => {
      const page = await open(key);
      const other = await page.context().newPage();
      for (const tab of [page, other]) {
        await tab.goto("/settings");
        await expect(tab.locator("main h1")).toHaveText("העדפות אישיות");
      }
      // A manager's screen holds the unit defaults as well; the first form is the personal one.
      const hours = (tab: Page) =>
        tab.getByLabel("שעות לפני תורנות, מופרדות בפסיק").first();
      const save = (tab: Page) =>
        tab.getByRole("button", { name: "שמירת העדפות אישיות" });
      await hours(page).fill("5");
      await save(page).click();
      await expect(page.getByText("השינוי נשמר")).toBeVisible();
      // The second tab still holds the version it loaded.
      await hours(other).fill("7");
      await save(other).click();
      await expect(other.getByText("המידע השתנה")).toBeVisible();
      await expect(hours(other)).toHaveValue("5");
      await hours(other).fill("7");
      await save(other).click();
      await expect(other.getByText("השינוי נשמר")).toBeVisible();
      await expect(hours(other)).toHaveValue("7");
    });
  }
});
