import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  soldiers,
  balances,
  soldierContacts,
  records,
} from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";
import { signedInHome, submitAuth } from "./auth-submit";

const managerEmail = "rank-editor@example.invalid";
const israelDate = (days: number) =>
  DateTime.now().setZone("Asia/Jerusalem").plus({ days }).toISODate()!;
let initialRankId: string;
let nextRankId: string;

test.beforeEach(async () => {
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error("E2E requires a dedicated test database");
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  const id = randomUUID();
  const name = "אחראי דרגות";
  await db.insert(soldiers).values({ id, name, data: soldier({ id, name }) });
  await db.insert(balances).values({ soldierId: id });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: managerEmail });
  await createInvitedAccount({
    name,
    email: managerEmail,
    role: "manager",
    soldierId: id,
  });
  initialRankId = randomUUID();
  nextRankId = randomUUID();
  await db.insert(records).values([
    {
      id: initialRankId,
      kind: "rank_catalog",
      data: { name: "סמל", tracks: [{ track: "חוגרים", order: 2 }] },
    },
    {
      // One rank in two tracks (decision 223): the soldier holds it in one.
      id: nextRankId,
      kind: "rank_catalog",
      data: {
        name: "סמ״ר",
        tracks: [
          { track: "חוגרים", order: 3 },
          { track: "נגדים", order: 1 },
        ],
      },
    },
    ...["חוגרים", "נגדים"].map((name) => ({
      id: randomUUID(),
      kind: "rank_track",
      data: { name, source: "נתוני בדיקה" },
    })),
  ]);
});

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("כתובת המייל המאושרת").fill(managerEmail);
  await submitAuth(
    page,
    "/api/auth/request-code",
    page.getByRole("button", { name: "שליחת קוד למייל" })
  );
  await expect(page.getByLabel("קוד כניסה", { exact: true })).toBeVisible();
  const [account] = await db
    .select()
    .from(user)
    .where(eq(user.email, managerEmail));
  const [code] = (
    await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, account.id))
  ).filter((row) => row.kind === "login-code");
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

for (const width of [1280, 390]) {
  test(`manager adds a soldier with a rank and updates it in the profile on ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page);
    await page.goto("/manage/soldiers");
    await page.getByRole("button", { name: "הוספת חייל", exact: true }).click();
    const intake = page.getByRole("dialog", {
      name: "הוספת חייל",
      exact: true,
    });
    await intake.getByLabel("שם פרטי", { exact: true }).fill("חייל");
    await intake.getByLabel("שם משפחה", { exact: true }).fill("דרגה");
    await intake.getByLabel("מגדר", { exact: true }).selectOption("male");
    await intake
      .getByLabel("מייל מאושר להזמנה")
      .fill("new-ranked@example.invalid");
    await intake.getByLabel("טלפון נייד").fill("0500000175");
    // A new soldier starts as grace-eligible; an arrival long past hides it (decision 225).
    // Grace needs an arrival date, so the checkbox waits for one.
    const grace = intake.getByLabel("זכאי לחודש חסד מתאריך ההגעה");
    await expect(grace).toHaveCount(0);
    await intake.getByLabel("תאריך הגעה ליחידה").fill("2026-01-01");
    await expect(grace).toHaveCount(0);
    await intake.getByLabel("תאריך הגעה ליחידה").fill(israelDate(-3));
    await expect(grace).toBeChecked();
    await grace.uncheck();
    await intake.getByLabel("אוכלוסיית שיבוץ").selectOption("mandatory");
    await intake
      .getByLabel("דרגה מאושרת (רשות)")
      .selectOption(`${initialRankId}|חוגרים`);
    // A chosen rank cannot silently lose its missing effective date.
    await intake.getByRole("button", { name: "שמירה", exact: true }).click();
    await expect(intake.getByRole("alert")).toBeVisible();
    await intake.getByLabel("תאריך תחולת הדרגה").fill("2026-01-15");
    await intake.getByRole("button", { name: "שמירה", exact: true }).click();
    await expect(intake).toHaveCount(0);
    const row = page.locator("tr", { hasText: "חייל דרגה" });
    await expect(row.getByRole("cell").nth(3)).toContainText("סמל");
    await row.getByRole("button", { name: "פרופיל ועריכה" }).click();
    const profile = page.getByRole("dialog");
    // The head shows each fact as "label: value"; the email moved to the account section.
    const facts = profile.locator(".profile-facts");
    await expect(facts).toContainText("מספר זיהוי:");
    await expect(facts).toContainText("טלפון:");
    await expect(facts).toContainText("0500000175");
    await expect(facts).not.toContainText("new-ranked@example.invalid");
    const rankForm = profile.getByRole("region", { name: "עדכון דרגת החייל" });
    await expect(
      rankForm.getByLabel("דרגה מאושרת", { exact: true })
    ).toHaveValue(`${initialRankId}|חוגרים`);
    await rankForm
      .getByLabel("דרגה מאושרת", { exact: true })
      .selectOption({ label: "סמ״ר · נגדים" });
    await rankForm.getByLabel("תאריך תחולת הדרגה").fill("2026-02-01");
    await rankForm.getByLabel("סיבת עדכון הדרגה").fill("דרגה מאושרת לבדיקה");
    await rankForm.getByRole("button", { name: "שמירת הדרגה המאושרת" }).click();
    await expect(profile).toHaveCount(0);
    await expect(row.getByRole("cell").nth(3)).toContainText("סמ״ר");
    await page.reload();
    await row.getByRole("button", { name: "פרופיל ועריכה" }).click();
    await expect(
      rankForm.getByLabel("דרגה מאושרת", { exact: true })
    ).toHaveValue(`${nextRankId}|נגדים`);
    await profile
      .getByText("מועדי שירות, אי־פעילות והיסטוריה", { exact: true })
      .click();
    const history = profile.locator(".history-row");
    await expect(history.filter({ hasText: "סמל" })).toContainText(
      "15.01.2026"
    );
    await expect(history.filter({ hasText: "סמ״ר" })).toContainText(
      "01.02.2026"
    );
    const [person] = (await db.select().from(soldiers)).filter(
      (person) => person.name === "חייל דרגה"
    );
    expect(
      person.data.rankHistory.map((rank) => [rank.rankId, rank.trackId])
    ).toEqual([
      [initialRankId, "חוגרים"],
      [nextRankId, "נגדים"],
    ]);
    const revisions = (await db.select().from(records)).filter(
      (record) =>
        record.kind === "rank_history_revision" &&
        record.subjectId === person.id
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0].data.reason).toBe("דרגה מאושרת לבדיקה");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    await page.screenshot({
      path: `test-results/soldier-rank-profile-${width}.png`,
      fullPage: true,
    });
  });
}
