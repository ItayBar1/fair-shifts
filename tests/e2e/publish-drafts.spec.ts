import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox, loginCode } from "../../src/server/auth-schema";
import {
  soldiers,
  balances,
  duties,
  assignments,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";
import { signedInHome } from "./auth-submit";

const managerEmail = "publish-manager@example.invalid";
const day = (offset: number) =>
  DateTime.now().setZone("Asia/Jerusalem").plus({ days: offset }).toISODate()!;
let manager: Actor;
let typeId: string;
const people: Record<string, string> = {};

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
  for (const [name, personalNumber] of [
    ["אחראי פרסום", "600001"],
    ["תורן א", "600002"],
    ["תורן ב", "600003"],
  ] as const) {
    const id = randomUUID();
    await db.insert(soldiers).values({
      id,
      name,
      personalNumber,
      data: soldier({ id, name, personalNumber }),
    });
    await db.insert(balances).values({ soldierId: id });
    people[name] = id;
  }
  const account = await createInvitedAccount({
    name: "אחראי פרסום",
    email: managerEmail,
    role: "manager",
    soldierId: people["אחראי פרסום"],
  });
  manager = {
    id: account.id,
    name: account.name,
    role: "manager",
    soldierId: account.soldierId!,
    securityEpoch: 1,
  };
  typeId = (
    await command("dutyType.save", {
      name: "שמירה לפרסום מרובה",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "שומר", count: 1 }],
    })
  ).id;
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
async function draft(name: string, date: string, hour: number, who?: string) {
  const start = DateTime.fromISO(
    `${date}T${String(hour).padStart(2, "0")}:00`,
    {
      zone: "Asia/Jerusalem",
    }
  );
  const created = await command("duty.create", {
    typeId,
    name,
    start: start.toISO(),
    end: start.plus({ hours: 4 }).toISO(),
  });
  if (who) {
    const [row] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, created.id));
    await command(
      "duty.assign",
      { dutyId: row.id, slotId: row.data.slots[0].id, soldierId: people[who] },
      row.version
    );
  }
  return created.id;
}
async function login(page: Page, email: string) {
  // The server enforces a minute between code sends; move the last send back instead of waiting.
  await db
    .update(loginCode)
    .set({ sentAt: new Date(Date.now() - 120_000) })
    .where(
      eq(
        loginCode.userId,
        (await db.select().from(user).where(eq(user.email, email)))[0].id
      )
    );
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
  await page.getByLabel("קוד כניסה", { exact: true }).fill(
    openSecret(message.encryptedSecret!, {
      purpose: "mail-code",
      recordId: message.id,
    })
  );
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(page.getByRole("heading", { name: signedInHome })).toBeVisible();
}
const statusOf = async (id: string) =>
  (await db.select().from(duties).where(eq(duties.id, id)))[0].data.status;
/** A soldier made unavailable on a day after being assigned: the draft's seat is no longer valid. */
async function makeInactive(name: string, date: string) {
  const [row] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, people[name]));
  await db
    .update(soldiers)
    .set({
      data: { ...row.data, inactivePeriods: [{ start: date, end: date }] },
      version: row.version + 1,
    })
    .where(eq(soldiers.id, people[name]));
}

test("a manager picks a range, previews it, and publishes the ready drafts while a blocked one stays a draft", async ({
  page,
}) => {
  const morning = await draft("שמירת בוקר", day(12), 8, "תורן א");
  const noon = await draft("שמירת צהריים", day(12), 14, "תורן ב");
  const next = await draft("שמירת מחר", day(13), 8, "תורן א");
  await makeInactive("תורן ב", day(12));

  await login(page, managerEmail);
  await page.getByRole("link", { name: "פרסום טיוטות" }).click();
  await expect(
    page.getByRole("heading", { name: "פרסום טיוטות", level: 1 })
  ).toBeVisible();
  await page.getByLabel("מתאריך", { exact: true }).fill(day(12));
  await page.getByLabel("עד תאריך", { exact: true }).fill(day(12));
  const list = page.getByRole("group", { name: "טיוטות שמתחילות בטווח" });
  await expect(list.getByRole("checkbox")).toHaveCount(3); // "select all" and two drafts
  await expect(list.getByText("שמירת מחר")).toHaveCount(0);
  const preview = page.getByRole("button", { name: /^תצוגה מקדימה/ });
  await expect(preview).toBeDisabled();

  await list.getByRole("checkbox", { name: "בחר הכול" }).check();
  await expect(preview).toHaveText("תצוגה מקדימה (2)");
  await preview.click();

  const result = page.getByRole("region", { name: "תצוגה מקדימה של הפרסום" });
  await expect(result.getByRole("status")).toHaveText(
    "1 מוכנות לפרסום · 1 חסומות ויישארו טיוטה"
  );
  const rows = result.getByRole("listitem");
  await expect(rows.nth(0)).toContainText("מוכנה");
  await expect(rows.nth(0)).toContainText("שמירת בוקר");
  await expect(rows.nth(1)).toContainText("חסומה");
  await expect(rows.nth(1)).toContainText("השיבוץ של תורן ב אינו תקין עוד");
  await expect(rows.nth(1)).toContainText("אי־פעילות");

  // Publishing needs the manager's explicit check first.
  const publish = result.getByRole("button", {
    name: "פרסום תורנות מוכנה אחת",
  });
  await expect(publish).toBeDisabled();
  await result
    .getByRole("checkbox", { name: "בדקתי את הטיוטות המוכנות והשיבוצים שבהן" })
    .check();
  await publish.click();

  await expect(
    page.getByText("פורסמה תורנות אחת. 1 נשארו טיוטה:")
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "שמירת צהריים" })).toBeVisible();
  await expect(result).toHaveCount(0);
  expect([
    await statusOf(morning),
    await statusOf(noon),
    await statusOf(next),
  ]).toEqual(["published", "draft", "draft"]);
  // The blocked draft is still marked, and the published one is gone from the list.
  await expect(list.getByText("שמירת בוקר")).toHaveCount(0);
  await expect(
    list.getByRole("checkbox", { name: /שמירת צהריים/ })
  ).toBeChecked();

  await page.getByRole("link", { name: "יומן פעולות" }).click();
  await expect(page.getByText("פרסום כמה תורנויות").first()).toBeVisible();
  await expect(
    page.getByText("פרסום תורנות", { exact: true }).first()
  ).toBeVisible();
});

test("a finished planning run opens the publish screen with its own drafts marked", async ({
  page,
}) => {
  const when = day(16);
  const first = await draft("שמירת ריצה ראשונה", when, 8);
  const second = await draft("שמירת ריצה שנייה", when, 14);
  const outside = await draft("שמירה מחוץ לריצה", day(17), 8);

  await login(page, managerEmail);
  await page.goto("/manage/planning");
  await page.getByLabel("מתאריך", { exact: true }).fill(when);
  await page.getByLabel("עד תאריך", { exact: true }).fill(when);
  await page.getByRole("button", { name: "יצירת ריצת תכנון" }).click();
  await expect(page.getByText(/הסתיים · 0 מקומות לא מאוישים/)).toBeVisible();

  // A run that has not finished offers no publishing; this one has.
  await expect(page.getByText("2 טיוטות מהריצה עדיין לא פורסמו")).toBeVisible();
  await page.getByRole("link", { name: "פרסום הטיוטות של הריצה" }).click();
  await expect(
    page.getByRole("heading", { name: "פרסום טיוטות", level: 1 })
  ).toBeVisible();
  await expect(page.getByText(/מסומנות הטיוטות של ריצת התכנון/)).toBeVisible();
  await expect(page.getByLabel("מתאריך", { exact: true })).toHaveValue(when);
  const list = page.getByRole("group", { name: "טיוטות שמתחילות בטווח" });
  await expect(list.getByRole("checkbox", { name: "בחר הכול" })).toBeChecked();
  await expect(list.getByRole("checkbox", { checked: true })).toHaveCount(3);
  await expect(list.getByText("שמירה מחוץ לריצה")).toHaveCount(0);

  await page.getByRole("button", { name: "תצוגה מקדימה (2)" }).click();
  const result = page.getByRole("region", { name: "תצוגה מקדימה של הפרסום" });
  await expect(result.getByRole("status")).toHaveText(
    "2 מוכנות לפרסום · 0 חסומות"
  );
  await result
    .getByRole("checkbox", { name: "בדקתי את הטיוטות המוכנות והשיבוצים שבהן" })
    .check();
  await result.getByRole("button", { name: "פרסום 2 תורנויות מוכנות" }).click();
  await expect(page.getByText("פורסמו 2 תורנויות.")).toBeVisible();
  expect([
    await statusOf(first),
    await statusOf(second),
    await statusOf(outside),
  ]).toEqual(["published", "published", "draft"]);
  expect(
    (await db.select().from(assignments)).filter(
      (row) => row.status === "reserved"
    ).length
  ).toBeGreaterThanOrEqual(2);

  // Back in the run's summary nothing is left to publish.
  await page.goto("/manage/planning");
  await expect(
    page.getByText("אין בריצה טיוטות שממתינות לפרסום.")
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "פרסום הטיוטות של הריצה" })
  ).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("the screen fits the width, and works from the keyboard", async ({
    page,
  }) => {
    const when = day(20);
    await draft(
      "שם ארוך מאוד של טיוטה שנועד לבדוק שהשורה נשברת ואינה מרחיבה את המסך",
      when,
      8,
      "תורן א"
    );
    await draft("שמירה קצרה", when, 14, "תורן ב");
    await login(page, managerEmail);
    await page.goto("/manage/publish");
    await page.getByLabel("מתאריך", { exact: true }).fill(when);
    await page.getByLabel("עד תאריך", { exact: true }).fill(when);
    const fits = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      );
    const list = page.getByRole("group", { name: "טיוטות שמתחילות בטווח" });
    await expect(list.getByRole("checkbox")).toHaveCount(3);
    expect(await fits()).toBe(true);

    // The keyboard alone selects everything and asks for the preview.
    const all = list.getByRole("checkbox", { name: "בחר הכול" });
    await all.focus();
    await page.keyboard.press("Space");
    await expect(all).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(list.getByRole("checkbox").nth(1)).toBeFocused();
    await page.keyboard.press("Space");
    await expect(all).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "תצוגה מקדימה (1)" })
    ).toBeVisible();
    await page.keyboard.press("Space");
    await expect(all).toBeChecked();
    await page.getByRole("button", { name: "תצוגה מקדימה (2)" }).focus();
    await page.keyboard.press("Enter");
    const result = page.getByRole("region", { name: "תצוגה מקדימה של הפרסום" });
    await expect(result.getByRole("status")).toHaveText(
      "2 מוכנות לפרסום · 0 חסומות"
    );
    expect(await fits()).toBe(true);
  });
});
