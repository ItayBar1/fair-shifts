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
  records,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";

// Execution periods and a handover after the start (card #18, decision 183). Synthetic people only.
const people = {
  manager: ["אחראית ביצוע", "510001", "execution-manager@example.invalid"],
  owner: ["מבצע מקורי", "510002", "execution-owner@example.invalid"],
  replacement: [
    "מחליפה בביצוע",
    "510003",
    "execution-replacement@example.invalid",
  ],
  leaving: ["מבקש חילוף", "510004", "execution-leaving@example.invalid"],
} as const;
const actors: Record<keyof typeof people, Actor> = {} as never;
const HOUR = 3_600_000;
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
  for (const [key, [name, personalNumber, email]] of Object.entries(people)) {
    const id = randomUUID();
    const data = soldier({ id, name, personalNumber });
    await db.insert(soldiers).values({ id, name, personalNumber, data });
    await db.insert(balances).values({ soldierId: id });
    const role = key === "manager" ? "manager" : "soldier";
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
});
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
const israel = (millis: number) =>
  DateTime.fromMillis(millis)
    .setZone("Asia/Jerusalem")
    .toFormat("yyyy-MM-dd'T'HH:mm");

/** A 48-hour daily-rate duty for one soldier that started 30 hours ago. */
async function running(name: string, holder: Actor) {
  const { manager } = actors;
  const type = await run(manager, "dutyType.save", {
    name: `סוג ${name}`,
    pricing: { mode: "daily", base: 4 },
    roles: [{ name: "שומר", count: 1 }],
  });
  const later = Math.floor(Date.now() / HOUR) * HOUR + 72 * HOUR;
  const created = await run(manager, "duty.create", {
    typeId: type.id,
    name,
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
      soldierId: holder.soldierId,
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
  return { id: row.id, start };
}

test("a manager records who covered a started seat, approves a handover, and soldiers see each period", async ({
  page,
  browser,
}) => {
  const { owner, leaving } = actors;
  const guard = await running("שמירת שער ממושכת", owner);
  const patrol = await running("סיור ממושך", leaving);

  // The owner fell ill after 18 hours; the replacement covered the remaining 30.
  await login(page, people.manager[2]);
  await page.goto(`/duties/${guard.id}`);
  await expect(page.getByText("תקופות ביצוע", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "עריכת תקופות ביצוע" }).click();
  const editor = page.getByRole("dialog");
  await editor.getByRole("button", { name: "הוספת תקופה" }).click();
  await editor
    .getByLabel("מבצע בתקופה 2")
    .selectOption({ label: people.replacement[0] });
  await editor.getByLabel("סיום תקופה 1").fill(israel(guard.start + 18 * HOUR));
  // The next period starts at the same Israel wall-clock time, even in a browser outside Israel.
  await expect(editor.getByLabel("תחילת תקופה 2")).toHaveValue(
    israel(guard.start + 18 * HOUR)
  );
  await editor.getByLabel("סיבה").fill("המבצע חלה באמצע התורנות");
  await editor.getByRole("button", { name: "תצוגת השפעה" }).click();
  const impact = editor.getByRole("table");
  await expect(
    impact.getByRole("row").filter({ hasText: people.owner[0] })
  ).toContainText("זקיפת ביצוע שהסתיים");
  await expect(
    impact.getByRole("row").filter({ hasText: people.owner[0] })
  ).toContainText("בסיס 3");
  await expect(
    impact.getByRole("row").filter({ hasText: people.replacement[0] })
  ).toContainText("מבצע חדש");
  await expect(
    impact.getByRole("row").filter({ hasText: people.replacement[0] })
  ).toContainText("בסיס 5");
  await editor.getByLabel("בדקתי את התקופות ואת השפעתן").check();
  await page.screenshot({
    path: "test-results/execution-periods-editor.png",
    fullPage: true,
  });
  await editor.getByRole("button", { name: "שמירת תקופות הביצוע" }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.getByText("כמה מבצעים")).toBeVisible();
  await expect(
    page.getByRole("table", { name: "היסטוריית תקופות ביצוע" })
  ).toContainText("המבצע חלה באמצע התורנות");
  const seat = await db
    .select()
    .from(assignments)
    .where(eq(assignments.dutyId, guard.id));
  expect(
    seat
      .filter((row) => row.status !== "cancelled")
      .map((row) => [row.status, row.points])
      .sort()
  ).toEqual([
    ["credited", 3],
    ["reserved", 5],
  ]);

  // A soldier asked for a replacement after the start; the manager sets the handover.
  const [patrolSeat] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.dutyId, patrol.id));
  const offer = await run(
    leaving,
    "transfer.offer",
    { assignmentId: patrolSeat.id, candidateIds: [owner.soldierId] },
    patrolSeat.version
  );
  await run(
    owner,
    "transfer.respond",
    { id: offer.id, decision: "accept", confirmed: true },
    1
  );
  await page.goto("/requests");
  const request = page
    .locator(".task-item")
    .filter({ hasText: `${people.leaving[0]} ← ${people.owner[0]}` });
  await request.getByRole("button", { name: "בדיקה והחלטה" }).click();
  const decision = page.getByRole("dialog");
  await decision
    .getByLabel("מועד החילוף")
    .fill(israel(patrol.start + 24 * HOUR));
  await decision.getByRole("button", { name: "חישוב התקופות" }).click();
  await expect(decision).toContainText("הניקוד יחושב לכל אחד לפי הזמן שביצע");
  await decision.getByLabel("בדקתי את ההתאמה ומאשר את ההעברה").check();
  await decision.getByRole("button", { name: "אישור החילוף" }).click();
  await expect(decision).not.toBeVisible();
  const [completed] = await db
    .select()
    .from(records)
    .where(eq(records.id, offer.id));
  expect(completed.data.status).toBe("completed");

  // Soldiers see who covers which part, on a phone, without horizontal scrolling.
  const soldierContext = await browser.newContext();
  const soldierPage = await soldierContext.newPage();
  await login(soldierPage, people.replacement[2]);
  await soldierPage.setViewportSize({ width: 390, height: 844 });
  await soldierPage.goto(`/duties/${guard.id}`);
  await expect(soldierPage.getByText("כמה מבצעים")).toBeVisible();
  await expect(
    soldierPage.getByText(new RegExp(`${people.replacement[0]} ·`))
  ).toBeVisible();
  await expect(soldierPage.getByText("המבצע חלה")).toHaveCount(0);
  await expect(
    soldierPage.getByRole("button", { name: "עריכת תקופות ביצוע" })
  ).toHaveCount(0);
  expect(
    await soldierPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await soldierPage.screenshot({
    path: "test-results/execution-periods-soldier-mobile.png",
    fullPage: true,
  });
  await soldierContext.close();
});
