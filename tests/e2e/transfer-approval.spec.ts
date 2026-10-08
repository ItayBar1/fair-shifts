import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox, authBudget } from "../../src/server/auth-schema";
import { quotaDay } from "../../src/server/operations/mail-quota-day";
import { soldiers, balances, duties, records } from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";
import { signedInHome } from "./auth-submit";

const people = {
  manager: ["אחראית העברות", "500001", "approval-manager@example.invalid"],
  owner: ["מציע העברות", "500002", "approval-owner@example.invalid"],
  replacement: [
    "מחליפה פטורה",
    "500003",
    "approval-replacement@example.invalid",
  ],
} as const;
const actors: Record<keyof typeof people, Actor> = {} as never;
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
// The pool is shared by every spec in the worker; the worker exit closes it.
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
  await page.getByLabel("קוד כניסה", { exact: true }).fill(
    openSecret(message.encryptedSecret!, {
      purpose: "mail-code",
      recordId: message.id,
    })
  );
  await page.getByRole("button", { name: "כניסה לחשבון", exact: true }).click();
  await expect(page.getByRole("heading", { name: signedInHome })).toBeVisible();
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

test("a manager approves an exemption transfer per exception, rejects another with a visible reason, and a side backs out", async ({
  page,
  browser,
}) => {
  const { manager, owner, replacement } = actors;
  const exemption = await run(manager, "eligibility.catalog.save", {
    kind: "exemption",
    name: "פטור סינתטי מהעברה",
  });
  const period = {
    soldierId: replacement.soldierId,
    kind: "exemption",
    value: exemption.id,
    startDate: "2026-01-01",
    endDate: "2030-12-31",
  };
  const preview = await run(manager, "soldier.timeline.preview", period, 1);
  await run(
    manager,
    "soldier.timeline",
    { ...period, confirmed: true, previewToken: preview.previewToken },
    1
  );
  const type = await run(manager, "dutyType.save", {
    name: "שמירה מאושרת",
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 1 }],
  });
  /** A published seat for the owner that the replacement accepted and that now awaits a manager. */
  async function awaiting(name: string, days: number) {
    const start = DateTime.now()
      .setZone("Asia/Jerusalem")
      .plus({ days })
      .set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
    const created = await run(manager, "duty.create", {
      typeId: type.id,
      name,
      start: start.toISO(),
      end: start.plus({ hours: 8 }).toISO(),
    });
    const [row] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, created.id));
    await db
      .update(duties)
      .set({
        data: {
          ...row.data,
          requirements: {
            ...row.data.requirements,
            blockingExemptionIds: [exemption.id],
          },
        },
      })
      .where(eq(duties.id, row.id));
    const seat = await run(
      manager,
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: owner.soldierId,
      },
      1
    );
    await run(manager, "duty.publish", { id: row.id, confirmed: true }, 2);
    const offer = await run(
      owner,
      "transfer.offer",
      { assignmentId: seat.id, candidateIds: [replacement.soldierId] },
      1
    );
    expect(
      await run(
        replacement,
        "transfer.respond",
        { id: offer.id, decision: "accept", confirmed: true },
        1
      )
    ).toMatchObject({ status: "awaiting_manager" });
    return offer.id;
  }
  await db.insert(authBudget).values({
    day: quotaDay(new Date()),
    category: "seat-offer:issue",
    scope: `account:${owner.id}`,
    used: 30,
  });
  await awaiting("העברה לאישור", 5);
  await awaiting("העברה לדחייה", 7);
  const retracted = await awaiting("העברה לביטול", 9);

  await login(page, people.manager[2]);
  await page.goto("/manage");
  const waiting = page
    .locator(".task-item")
    .filter({ hasText: "העברה ממתינה להחלטה: העברה לאישור" });
  await expect(waiting).toContainText("מציע העברות ← מחליפה פטורה");
  await waiting.click();
  await expect(page).toHaveURL(/\/requests$/);
  const approveRow = page
    .locator(".task-item")
    .filter({ hasText: "העברה לאישור: מציע העברות ← מחליפה פטורה" });
  await expect(approveRow).toContainText("ממתינה לאחראי");
  await expect(approveRow).toContainText("נדרש אישור חריג לפטור עם סיבה");
  await approveRow.getByRole("button", { name: "בדיקה והחלטה" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("מחליפה פטורה יקבל את התורנות");
  await dialog.getByLabel("נדרש אישור חריג לפטור עם סיבה").check();
  await dialog
    .getByLabel("סיבה לאישור החריגים הנקודתיים")
    .fill("אישור סינתטי לבדיקה");
  await dialog.getByLabel("בדקתי את ההתאמה ומאשר את ההעברה").check();
  await page.screenshot({
    path: "test-results/transfer-approval-review.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "אישור ההעברה" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(approveRow).toContainText("הושלמה");
  await expect(approveRow).toContainText("ההעברה אושרה בידי אחראית העברות");

  const rejectRow = page
    .locator(".task-item")
    .filter({ hasText: "העברה לדחייה: מציע העברות ← מחליפה פטורה" });
  await rejectRow.getByRole("button", { name: "דחייה" }).click();
  const reject = page.getByRole("dialog");
  await expect(reject).toContainText("הסיבה תוצג למציע, למחליף ולאחראים");
  await reject.getByLabel("סיבת הדחייה").fill("נדרש מחליף ללא פטור");
  await reject.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(reject).not.toBeVisible();
  await expect(rejectRow).toContainText("נדחתה בידי אחראי");
  await expect(rejectRow).toContainText("נדרש מחליף ללא פטור");
  const rejectionMail = (await db.select().from(emailOutbox)).filter(
    (mail) => mail.requestEvent === "rejected"
  );
  expect(rejectionMail).toHaveLength(2);
  for (const mail of rejectionMail) {
    expect(mail.body).not.toContain("נדרש מחליף ללא פטור");
    expect(mail.body).toContain("פרטי ההחלטה באתר");
  }
  await page.screenshot({
    path: "test-results/transfer-approval-manager.png",
    fullPage: true,
  });

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await login(ownerPage, people.owner[2]);
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await ownerPage.goto("/requests");
  const rejected = ownerPage
    .locator(".task-item")
    .filter({ hasText: "העברה לדחייה" });
  await expect(rejected).toContainText(
    "האחראי דחה את ההעברה: נדרש מחליף ללא פטור"
  );
  const approved = ownerPage
    .locator(".task-item")
    .filter({ hasText: "העברה לאישור" });
  await expect(approved).toContainText("הושלמה");
  await expect(approved).toContainText(
    "ההצעה נשמרה באתר; חלק מהמיילים לא נשלחו בגלל המכסה היומית."
  );
  await expect(approved).not.toContainText("אישור סינתטי");
  const pending = ownerPage
    .locator(".task-item")
    .filter({ hasText: "העברה לביטול" });
  await pending.getByRole("button", { name: "ביטול ההעברה" }).click();
  const retract = ownerPage.getByRole("dialog");
  await retract.getByLabel("אני מאשר את הביטול").check();
  await retract.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(retract).not.toBeVisible();
  await expect(pending).toContainText("המציע ביטל את ההעברה לפני החלטת האחראי");
  expect(
    await ownerPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await ownerPage.screenshot({
    path: "test-results/transfer-approval-owner-mobile.png",
    fullPage: true,
  });
  const [stored] = await db
    .select()
    .from(records)
    .where(eq(records.id, retracted));
  expect(stored.data.status).toBe("cancelled");

  const replacementContext = await browser.newContext();
  const replacementPage = await replacementContext.newPage();
  await login(replacementPage, people.replacement[2]);
  await replacementPage.goto("/requests");
  await expect(
    replacementPage.locator(".task-item").filter({ hasText: "העברה לדחייה" })
  ).toContainText("נדרש מחליף ללא פטור");
  await replacementPage.goto("/notifications");
  await expect(replacementPage.getByText("קיבלת תורנות")).toBeVisible();
  await Promise.all([ownerContext.close(), replacementContext.close()]);
});
