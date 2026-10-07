import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

// A soldier deleted while a duty runs (ticket #34, decision 196). Synthetic people only.
const people = {
  manager: ["אחראי מחיקה בביצוע", "520001", "inexec-manager@example.invalid"],
  leaver: ["חייל שנמחק בביצוע", "520002", "inexec-leaver@example.invalid"],
  cover: ["מחליף במחיקה", "520003", "inexec-cover@example.invalid"],
  technical: ["טכני מחיקה", "520004", "inexec-technical@example.invalid"],
} as const;
const actors: Record<keyof typeof people, Actor> = {} as never;
const HOUR = 3_600_000;
let dutyId = "";
let deletedAt = 0;

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
  for (const [key, [name, personalNumber, email]] of Object.entries(people)) {
    const technical = key === "technical";
    const id = technical ? undefined : randomUUID();
    if (id) {
      await db.insert(soldiers).values({
        id,
        name,
        personalNumber,
        data: soldier({ id, name, personalNumber }),
      });
      await db.insert(balances).values({ soldierId: id });
    }
    const role =
      key === "manager" ? "manager" : technical ? "technical" : "soldier";
    const account = await createInvitedAccount({
      name,
      email,
      role,
      soldierId: id,
    });
    actors[key as keyof typeof people] = {
      id: account.id,
      name,
      role,
      soldierId: id,
      securityEpoch: 1,
    };
  }
  const { manager, leaver } = actors;
  const type = await run(manager, "dutyType.save", {
    name: "סוג מחיקה בביצוע",
    pricing: { mode: "daily", base: 4 },
    roles: [{ name: "שומר", count: 1 }],
  });
  const later = Math.floor(Date.now() / HOUR) * HOUR + 72 * HOUR;
  const created = await run(manager, "duty.create", {
    typeId: type.id,
    name: "שמירה שנקטעה",
    start: new Date(later).toISOString(),
    end: new Date(later + 48 * HOUR).toISOString(),
  });
  const [row] = await db.select().from(duties).where(eq(duties.id, created.id));
  await run(
    manager,
    "duty.assign",
    {
      dutyId: row.id,
      slotId: row.data.slots[0].id,
      soldierId: leaver.soldierId,
    },
    1
  );
  await run(manager, "duty.publish", { id: row.id, confirmed: true }, 2);
  const [live] = await db.select().from(duties).where(eq(duties.id, row.id));
  const start = Math.floor(Date.now() / HOUR) * HOUR - 30 * HOUR;
  await db
    .update(duties)
    .set({
      data: {
        ...live.data,
        start: new Date(start).toISOString(),
        end: new Date(start + 48 * HOUR).toISOString(),
      },
    })
    .where(eq(duties.id, row.id));
  dutyId = row.id;
  // The deletion happens while the duty runs.
  const [person] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, leaver.soldierId!));
  const impact = (await run(
    manager,
    "soldier.delete.preview",
    { id: leaver.soldierId },
    person.version
  )) as unknown as { previewToken: string };
  await run(
    manager,
    "soldier.delete",
    {
      id: leaver.soldierId,
      previewToken: impact.previewToken,
      reason: "שוחרר מהשירות",
      confirmed: true,
    },
    person.version
  );
  const [gone] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, leaver.soldierId!));
  deletedAt = gone.deletedAt!.getTime();
});

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
async function run(
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
  })) as Record<string, unknown> & { id: string; version: number };
}
const israel = (millis: number) =>
  DateTime.fromMillis(millis)
    .setZone("Asia/Jerusalem")
    .toFormat("yyyy-MM-dd'T'HH:mm");
const noSideScroll = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth
  );

test("the manager finds the urgent item, is offered the part up to the deletion, records a replacement, and the item goes", async ({
  page,
}) => {
  await login(page, people.manager[2]);
  await page.goto("/manage");
  const urgent = page.getByRole("link", {
    name: /דחוף: חייל שנמחק בביצוע נמחק באמצע שמירה שנקטעה/,
  });
  await expect(urgent).toBeVisible();
  await expect(urgent).toContainText("הזקיפה האוטומטית של השיבוץ עצורה");
  // On a phone, too.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(urgent).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({
    path: "test-results/deletion-in-execution-dashboard-mobile.png",
  });
  await page.setViewportSize({ width: 1280, height: 720 });

  await urgent.click();
  await expect(
    page.getByText("טיפול דחוף: חייל נמחק בזמן שהתורנות מתבצעת.")
  ).toBeVisible();
  await expect(
    page.getByText("דחוף: החייל נמחק", { exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "עריכת תקופות ביצוע" }).click();
  const editor = page.getByRole("dialog");
  // Offered: the soldier up to the deletion, the rest waiting for a replacement.
  await expect(editor.getByLabel("סיום תקופה 1")).toHaveValue(
    israel(deletedAt)
  );
  await expect(editor.getByLabel("תחילת תקופה 2")).toHaveValue(
    israel(deletedAt)
  );
  // The deleted soldier is still listed, marked, so the part they performed can be recorded.
  await editor.getByRole("button", { name: /^מבצע בתקופה 1/ }).click();
  const first = editor.getByRole("radiogroup", { name: "מבצע בתקופה 1" });
  await expect(first.getByText("נמחק", { exact: true })).toBeVisible();
  await expect(
    first.getByRole("radio", { name: new RegExp(people.leaver[0]) })
  ).toBeChecked();
  await editor.getByRole("button", { name: /^מבצע בתקופה 1/ }).click();
  await editor.getByRole("button", { name: /^מבצע בתקופה 2/ }).click();
  await editor
    .getByRole("radiogroup", { name: "מבצע בתקופה 2" })
    .getByRole("radio", { name: people.cover[0] })
    .click();
  await editor.getByLabel("סיבה").fill("החייל נמחק באמצע התורנות");
  await editor.getByRole("button", { name: "תצוגת השפעה" }).click();
  const impact = editor.getByRole("table");
  await expect(
    impact.getByRole("row").filter({ hasText: people.leaver[0] })
  ).toContainText("זקיפת ביצוע שהסתיים");
  await expect(
    impact.getByRole("row").filter({ hasText: people.cover[0] })
  ).toContainText("מבצע חדש");
  await editor.getByLabel("בדקתי את התקופות ואת השפעתן").check();
  await page.screenshot({
    path: "test-results/deletion-in-execution-editor.png",
    fullPage: true,
  });
  await editor.getByRole("button", { name: "שמירת תקופות הביצוע" }).click();
  await expect(editor).not.toBeVisible();

  const seats = await db
    .select()
    .from(assignments)
    .where(eq(assignments.dutyId, dutyId));
  expect(
    seats
      .filter((row) => row.status !== "cancelled")
      .map((row) => row.status)
      .sort()
  ).toEqual(["credited", "reserved"]);
  await expect(
    page.getByText("טיפול דחוף: חייל נמחק בזמן שהתורנות מתבצעת.")
  ).toHaveCount(0);
  await page.goto("/manage");
  await expect(
    page.getByRole("link", { name: /דחוף: חייל שנמחק בביצוע/ })
  ).toHaveCount(0);
});

test("the technical account sees the state of the independent deletion log", async ({
  page,
}) => {
  await login(page, people.technical[2], "תמונת מצב");
  await page.goto("/technical");
  await expect(page.getByText("יומן מחיקות עצמאי")).toBeVisible();
  // The soldier's deletion is waiting for the worker, which does not run in this environment.
  const row = page.locator(".task-item", { hasText: "יומן מחיקות עצמאי" });
  await expect(row.getByText("1 ממתינות לכתיבה")).toBeVisible();
  await expect(row).toContainText("0 רישומים");
});
