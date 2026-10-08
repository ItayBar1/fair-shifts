import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  soldiers,
  balances,
  duties,
  assignments,
  records,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";
import { signedInHome } from "./auth-submit";

// Card #16: mutual swap by consent, synthetic people only.
const people = {
  manager: ["אחראית החלפות", "510001", "swap-manager@example.invalid"],
  offerer: ["מציע החלפה", "510002", "swap-offerer@example.invalid"],
  partner: ["שותפה להחלפה", "510003", "swap-partner@example.invalid"],
  other: ["חייל נוסף בהחלפה", "510004", "swap-other@example.invalid"],
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

test("two soldiers swap seats by consent, and a manager approves a swap that needs an exception", async ({
  page,
  browser,
}) => {
  const { manager, offerer, partner, other } = actors;
  const type = await run(manager, "dutyType.save", {
    name: "שמירה להחלפה",
    pricing: { mode: "fixed", base: 4 },
    roles: [{ name: "תורן", count: 1 }],
  });
  /** A published duty in `days` days with one seat for `person`. */
  async function seat(
    name: string,
    days: number,
    person: Actor,
    callUpBonus = 0
  ) {
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
    const assigned = await run(
      manager,
      "duty.assign",
      {
        dutyId: row.id,
        slotId: row.data.slots[0].id,
        soldierId: person.soldierId,
        callUpBonus,
      },
      1
    );
    await run(manager, "duty.publish", { id: row.id, confirmed: true }, 2);
    return { dutyId: row.id, assignmentId: assigned.id };
  }
  const mine = await seat("שמירת בוקר להחלפה", 5, offerer, 3);
  const hers = await seat("שמירת ערב להחלפה", 6, partner);
  const theirs = await seat("שמירת לילה להחלפה", 7, other);

  // The offerer proposes the swap from the duty page to two seats at once.
  await login(page, people.offerer[2]);
  await page.goto(`/duties/${mine.dutyId}`);
  await page.getByRole("button", { name: "הצעת החלפה" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("שני השיבוצים מתחלפים יחד");
  await dialog
    .getByLabel("עם אילו שיבוצים להחליף")
    .selectOption([hers.assignmentId, theirs.assignmentId]);
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("הצעת ההחלפה שלך ממתינה להסכמה")).toBeVisible();

  // The partner accepts on a phone; the swap completes at once.
  const partnerContext = await browser.newContext();
  const partnerPage = await partnerContext.newPage();
  await partnerPage.setViewportSize({ width: 390, height: 844 });
  await login(partnerPage, people.partner[2]);
  await partnerPage.goto("/requests");
  const incoming = partnerPage
    .locator(".task-item")
    .filter({ hasText: "שמירת בוקר להחלפה — מאת מציע החלפה" });
  await expect(incoming).toContainText("במקום: שמירת ערב להחלפה");
  await expect(incoming).not.toContainText("שמירת לילה להחלפה");
  await incoming.getByRole("button", { name: "הסכמה" }).click();
  const consent = partnerPage.getByRole("dialog");
  await consent.getByLabel("אני מסכים להחלפה").check();
  await consent.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(consent).not.toBeVisible();
  await expect(incoming).toContainText("הושלמה");
  expect(
    await partnerPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await partnerPage.screenshot({
    path: "test-results/swap-partner-mobile.png",
    fullPage: true,
  });
  const held = await db.select().from(assignments);
  const holder = (dutyId: string) =>
    held.find((row) => row.dutyId === dutyId && row.status === "reserved");
  expect(holder(mine.dutyId)).toMatchObject({
    soldierId: partner.soldierId,
    points: 7,
  });
  expect(holder(hers.dutyId)).toMatchObject({
    soldierId: offerer.soldierId,
    points: 4,
  });
  expect(holder(theirs.dutyId)?.soldierId).toBe(other.soldierId);

  await page.goto("/requests");
  const outgoing = page
    .locator(".task-item")
    .filter({ hasText: "שותפה להחלפה (שמירת ערב להחלפה): הסכים" });
  await expect(outgoing).toContainText("הושלמה");
  await expect(outgoing).toContainText(
    "חייל נוסף בהחלפה (שמירת לילה להחלפה): נסגר"
  );
  await page.goto("/notifications");
  await expect(page.getByText("ההחלפה הושלמה")).toBeVisible();

  // A second swap needs the partner's exemption approved by a manager.
  const exemption = await run(manager, "eligibility.catalog.save", {
    kind: "exemption",
    name: "פטור סינתטי מהחלפה",
  });
  const period = {
    soldierId: partner.soldierId,
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
  const guarded = await seat("שמירה עם פטור", 9, offerer);
  const [row] = await db
    .select()
    .from(duties)
    .where(eq(duties.id, guarded.dutyId));
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
  const partnerSeat = held.find(
    (item) => item.dutyId === mine.dutyId && item.status === "reserved"
  )!;
  const swap = await run(
    offerer,
    "swap.offer",
    {
      assignmentId: guarded.assignmentId,
      targetAssignmentIds: [partnerSeat.id],
    },
    1
  );
  const [offered] = await db
    .select()
    .from(records)
    .where(eq(records.id, swap.id));
  expect(
    await run(
      partner,
      "swap.respond",
      {
        id: swap.id,
        assignmentId: partnerSeat.id,
        decision: "accept",
        confirmed: true,
      },
      offered.version
    )
  ).toMatchObject({ status: "awaiting_manager" });

  const managerContext = await browser.newContext();
  const managerPage = await managerContext.newPage();
  await login(managerPage, people.manager[2]);
  await managerPage.goto("/manage");
  const waiting = managerPage
    .locator(".task-item")
    .filter({ hasText: "החלפה ממתינה להחלטה: שמירה עם פטור" });
  await expect(waiting).toContainText("מציע החלפה ⇄ שותפה להחלפה");
  await waiting.click();
  await expect(managerPage).toHaveURL(/\/requests$/);
  const decision = managerPage
    .locator(".task-item")
    .filter({ hasText: "מציע החלפה (שמירה עם פטור) ⇄ שותפה להחלפה" });
  await expect(decision).toContainText("ממתינה לאחראי");
  await decision.getByRole("button", { name: "בדיקה והחלטה" }).click();
  const review = managerPage.getByRole("dialog");
  await expect(review).toContainText("שני השיבוצים מתחלפים יחד");
  await review
    .getByLabel("שותפה להחלפה: נדרש אישור חריג לפטור עם סיבה")
    .check();
  await review
    .getByLabel("סיבה לאישור החריגים הנקודתיים")
    .fill("אישור סינתטי להחלפה");
  await review
    .getByLabel("בדקתי את ההתאמה של שני הצדדים ומאשר את ההחלפה")
    .check();
  await managerPage.screenshot({
    path: "test-results/swap-manager-review.png",
    fullPage: true,
  });
  await review.getByRole("button", { name: "אישור ההחלפה" }).click();
  await expect(review).not.toBeVisible();
  await expect(decision).toContainText("הושלמה");
  await expect(decision).toContainText("ההחלפה אושרה בידי אחראית החלפות");

  // The offerer sees who approved, never the manager's reason about the partner's exemption.
  await page.goto("/requests");
  const approved = page
    .locator(".task-item")
    .filter({ hasText: "שמירה עם פטור" });
  await expect(approved).toContainText("ההחלפה אושרה בידי אחראית החלפות");
  await expect(approved).not.toContainText("אישור סינתטי");
  await Promise.all([partnerContext.close(), managerContext.close()]);
});
