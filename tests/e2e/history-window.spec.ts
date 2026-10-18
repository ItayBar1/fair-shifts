import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
  dutySlots,
  dutyTypes,
  records,
  soldiers,
} from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { assignment, duty, soldier } from "../fixtures";
import { signedInHome, submitAuth } from "./auth-submit";

// A soldier's lists start 90 days back, and "load more" reads earlier ones
// (decision 235). Synthetic people only.
const email = "history-window@example.invalid";
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
let oldDutyEnd: Date;

test.beforeAll(async () => {
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error("E2E requires a dedicated *_test database");
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  const soldierId = randomUUID();
  await db.insert(soldiers).values({
    id: soldierId,
    name: "חייל החלון",
    data: soldier({ id: soldierId, name: "חייל החלון" }),
  });
  await db.insert(balances).values({ soldierId });
  const account = await createInvitedAccount({
    name: "חייל החלון",
    email,
    role: "soldier",
    soldierId,
  });
  for (const [title, days] of [
    ["הודעה מהשבוע", 2],
    ["הודעה מלפני חצי שנה", 120],
  ] as const)
    await db.insert(records).values({
      id: randomUUID(),
      kind: "notification",
      data: { accountId: account.id, title, body: "גוף ההודעה" },
      createdAt: ago(days),
      updatedAt: ago(days),
    });
  const typeId = randomUUID();
  const slotId = randomUUID();
  const dutyId = randomUUID();
  oldDutyEnd = ago(120);
  await db
    .insert(dutyTypes)
    .values({ id: typeId, name: "סוג סינתטי", data: {} });
  const data = {
    ...duty({
      id: dutyId,
      typeId,
      name: "שמירה ישנה",
      start: new Date(oldDutyEnd.getTime() - 8 * 3_600_000).toISOString(),
      end: oldDutyEnd.toISOString(),
      status: "published",
      slots: [{ id: slotId, role: "תורן" }],
    }),
    location: "",
    instructions: "",
  };
  await db.insert(duties).values({ id: dutyId, typeId, name: data.name, data });
  await db.insert(dutySlots).values({ id: slotId, dutyId, data: {} });
  const seat = assignment({
    id: randomUUID(),
    dutyId,
    slotId,
    soldierId,
    status: "credited",
  });
  await db.insert(assignments).values({ ...seat, data: seat });
});

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(email);
  await submitAuth(
    page,
    "/api/auth/request-code",
    page.getByRole("button", { name: "שליחת קוד למייל" })
  );
  const [account] = await db.select().from(user).where(eq(user.email, email));
  const [code] = (
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, account.id))
  )
    .filter((row) => row.kind === "login-code")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  await page.getByLabel("קוד כניסה", { exact: true }).fill(
    openSecret(code.encryptedSecret!, {
      purpose: "mail-code",
      recordId: code.id,
    })
  );
  await submitAuth(
    page,
    "/api/auth/verify-code",
    page.getByRole("button", { name: "כניסה לחשבון", exact: true })
  );
  await expect(page.getByRole("heading", { name: signedInHome })).toBeVisible();
}

test("a soldier sees 90 days, loads earlier notices on request, and an earlier month by going to it", async ({
  page,
}) => {
  await login(page);
  await page.goto("/notifications");
  await expect(page.getByText("הודעה מהשבוע")).toBeVisible();
  await expect(page.getByText("הודעה מלפני חצי שנה")).toHaveCount(0);
  await page.getByRole("button", { name: "טען עוד" }).click();
  await expect(page.getByText("הודעה מלפני חצי שנה")).toBeVisible();
  // The fresh state that reloads every 30 seconds keeps what was loaded.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("הודעה מלפני חצי שנה")).toBeVisible();

  // The board reads the month it is moved to, before the window.
  await page.goto("/calendar");
  for (let step = 0; step < 4; step++)
    await page.getByRole("button", { name: "החודש הקודם" }).click();
  await expect(page.getByText("שמירה ישנה").first()).toBeVisible();
});
