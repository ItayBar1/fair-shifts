import {
  test,
  expect,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../src/server/db";
import { eraseRelatedCopies } from "../../src/server/soldier-deletion";
import { user, emailOutbox } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
  dutyTypes,
  soldiers,
  commandResultSubjects,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { openSecret } from "../../src/server/operations/email";
import { soldier } from "../fixtures";
import { submitAuth } from "./auth-submit";

// Search and filters in the soldier picker (card #83, decision 193). Synthetic people only.
// Dates are Israel dates around D, ten days ahead; the duty runs 08:00-16:00 on D.
const ZONE = "Asia/Jerusalem";
const D = DateTime.now().setZone(ZONE).plus({ days: 10 }).startOf("day");
const day = (offset: number) => D.plus({ days: offset }).toISODate()!;
const at = (hour: number, offset = 0) =>
  D.plus({ days: offset, hours: hour }).toISO()!;

const manager = {
  name: "אחראי בוחר",
  personalNumber: "880100",
  email: "picker-manager@example.invalid",
};
const second = {
  name: "אחראית נוספת",
  personalNumber: "880101",
  email: "picker-second@example.invalid",
};
let actor: Actor;
const ids = {} as Record<string, string>;

const run = async (
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

async function addSoldier(
  key: string,
  name: string,
  personalNumber: string,
  data: Parameters<typeof soldier>[0] = {},
  deleted = false
) {
  const id = randomUUID();
  ids[key] = id;
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber,
    data: soldier({ id, name, personalNumber, ...data }),
    ...(deleted && { deletedAt: new Date() }),
  });
  await db.insert(balances).values({ soldierId: id });
  return id;
}
async function addManager(person: typeof manager) {
  const id = await addSoldier(
    person.personalNumber,
    person.name,
    person.personalNumber
  );
  return createInvitedAccount({
    name: person.name,
    email: person.email,
    role: "manager",
    soldierId: id,
  }).then((account) => ({ id: account.id, soldierId: id }));
}
async function createDuty(name: string, typeId = ids.type) {
  const created = await run("duty.create", {
    typeId,
    name,
    start: at(8),
    end: at(16),
  });
  const [row] = await db.select().from(duties).where(eq(duties.id, created.id));
  return row;
}

async function login(page: Page, email: string) {
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
  await page
    .getByLabel("קוד כניסה", { exact: true })
    .fill(openSecret(message.encryptedSecret!));
  await submitAuth(
    page,
    "/api/auth/verify-code",
    page.getByRole("button", { name: "כניסה לחשבון", exact: true })
  );
  await expect(
    page.getByRole("heading", { name: "לוח התורנויות", exact: true })
  ).toBeVisible();
}
// One sign-in code a minute per account: the session is reused by every test here.
let session: Page | undefined;
async function signedIn(browser: Browser) {
  if (session && !session.isClosed()) return session;
  session = await (await browser.newContext()).newPage();
  await login(session, manager.email);
  return session;
}
const fits = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth
  );
const names = (scope: Locator) =>
  scope
    .getByRole("radiogroup", { name: "בחירת חייל" })
    .locator("strong")
    .allTextContents();
const count = (dialog: Locator) => dialog.getByRole("status");
async function openManual(page: Page, duty: string) {
  await page.goto(`/duties/${duty}`);
  await page.getByRole("button", { name: "שיבוץ ידני", exact: true }).click();
  return page.getByRole("dialog");
}
const openFilters = (dialog: Locator) =>
  dialog.getByRole("button", { name: /^סינון/ }).click();

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
  // Only this spec's catalogs, so the filters list exactly what it defines.
  await db.execute(
    sql`delete from records where kind in ('eligibility_catalog', 'rank_catalog')`
  );
  const lead = await addManager(manager);
  await addManager(second);
  actor = {
    id: lead.id,
    name: manager.name,
    role: "manager",
    soldierId: lead.soldierId,
    securityEpoch: 1,
  };

  // The catalogs the filters read.
  ids.exemption = (
    await run("eligibility.catalog.save", {
      kind: "exemption",
      name: "פטור מאבטחה",
    })
  ).id;
  ids.qualification = (
    await run("eligibility.catalog.save", {
      kind: "qualification",
      name: "נשק אישי",
    })
  ).id;
  ids.capability = (
    await run("eligibility.catalog.save", { kind: "capability", name: "נהיגה" })
  ).id;
  for (const [key, name, order] of [
    ["private", "טוראי", 1],
    ["sergeant", "סמל", 2],
  ] as const)
    ids[key] = (
      await run("rank.catalog.save", {
        name,
        track: "חובה",
        order,
        source: "נתוני בדיקה בלבד",
      })
    ).id;
  const rank = (key: string, order: number, from: string) => ({
    effectiveFrom: from,
    rankId: ids[key],
    trackId: "חובה",
    order,
  });
  const trained = [
    {
      qualificationId: ids.qualification,
      start: day(-40),
      end: day(40),
    },
  ];

  await addSoldier("dana", "דנה ירוק", "880001", {
    gender: "female",
    capabilities: [ids.capability],
    qualifications: trained,
    rankHistory: [rank("sergeant", 2, day(-60))],
  });
  await addSoldier("danny", "דני כחול", "880002", {
    gender: "male",
    qualifications: trained,
    rankHistory: [rank("private", 1, day(-60))],
  });
  // The qualification ended the day before the duty.
  await addSoldier("noa", "נועה אדומה", "880003", {
    gender: "female",
    qualifications: [
      { qualificationId: ids.qualification, start: day(-40), end: day(-1) },
    ],
    rankHistory: [rank("sergeant", 2, day(-60))],
  });
  // The exemption covers the duty day; the next soldier's ended the day before.
  await addSoldier("eitan", "איתן פטור", "880004", {
    gender: "male",
    qualifications: trained,
    exemptions: [{ exemptionId: ids.exemption, start: day(-2), end: day(0) }],
  });
  await addSoldier("gil", "גיל פטור שהסתיים", "880005", {
    gender: "male",
    qualifications: trained,
    exemptions: [{ exemptionId: ids.exemption, start: day(-10), end: day(-1) }],
  });
  // Promoted the day after the duty, so a private when it starts.
  await addSoldier("rotem", "רותם מתקדמת", "880006", {
    gender: "female",
    qualifications: trained,
    rankHistory: [rank("private", 1, day(-60)), rank("sergeant", 2, day(1))],
  });
  await addSoldier("yuval", "יובל קבע", "880007", {
    gender: "male",
    qualifications: trained,
    service: { type: "career", basePopulation: "career", graceEligible: false },
  });
  await addSoldier(
    "gone",
    "מחוק לשעבר",
    "880008",
    { qualifications: trained },
    true
  );

  ids.type = (
    await run("dutyType.save", {
      name: "שמירה בוחרת",
      pricing: { mode: "fixed", base: 4 },
      populations: ["mandatory"],
      qualificationIds: [ids.qualification],
      exemptionIds: [ids.exemption],
      roles: [{ name: "תורן", count: 1 }],
    })
  ).id;
  // The type asks for nothing; only the role asks for a capability.
  ids.roleType = (
    await run("dutyType.save", {
      name: "שמירה עם נהג",
      pricing: { mode: "fixed", base: 4 },
      roles: [
        {
          name: "נהג",
          count: 1,
          requirements: { capabilityIds: [ids.capability] },
        },
      ],
    })
  ).id;
});

test("the picker opens filtered by the duty and the role, and finds by name and personal number", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  const open = await createDuty("תורנות לחיפוש");
  const dialog = await openManual(page, open.id);

  // Mandatory soldiers with a valid qualification and no exemption on the day: no manager,
  // no deleted soldier, nobody of the career population.
  await expect(count(dialog)).toHaveText("4 מתוך 7 חיילים");
  expect(await names(dialog)).toEqual([
    "גיל פטור שהסתיים",
    "דנה ירוק",
    "דני כחול",
    "רותם מתקדמת",
  ]);
  await expect(dialog.getByText("מסונן לפי:")).toContainText("נשק אישי");
  await expect(dialog.getByText("מסונן לפי:")).toContainText("פטור מאבטחה");
  await expect(dialog.getByText("מסונן לפי:")).toContainText("חובה");
  await expect(dialog.getByRole("radio", { name: /אחראית נוספת/ })).toHaveCount(
    0
  );
  await expect(dialog.getByRole("radio", { name: /מחוק לשעבר/ })).toHaveCount(
    0
  );

  const search = dialog.getByLabel("חיפוש חייל לפי שם או מספר אישי");
  await search.fill("דנ");
  expect(await names(dialog)).toEqual(["דנה ירוק", "דני כחול"]);
  await expect(count(dialog)).toHaveText("2 מתוך 7 חיילים");
  await search.fill("ירוק דנה");
  expect(await names(dialog)).toEqual(["דנה ירוק"]);
  await search.fill("880005");
  expect(await names(dialog)).toEqual(["גיל פטור שהסתיים"]);
  await search.fill("אין כזה");
  expect(await names(dialog)).toEqual([]);
  await expect(count(dialog)).toHaveText("אין חיילים שמתאימים לחיפוש ולסינון");

  // Enter picks the one person left and does not submit the form.
  await search.fill("880002");
  await search.press("Enter");
  await expect(dialog.getByRole("radio", { name: /דני כחול/ })).toBeChecked();
  await expect(dialog.getByText("ניקוד צפוי")).toHaveCount(0);
  // The choice stays listed while the search moves on.
  await search.fill("דנה");
  await expect(dialog.getByRole("radio", { name: /דני כחול/ })).toBeChecked();
  expect(await names(dialog)).toEqual(["דנה ירוק", "דני כחול"]);
});

test("the role's own conditions fill the filters, next to the duty's", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  const open = await createDuty("תורנות עם נהג", ids.roleType);
  const dialog = await openManual(page, open.id);
  expect(await names(dialog)).toEqual(["דנה ירוק"]);
  await expect(count(dialog)).toHaveText("1 מתוך 7 חיילים");
  await expect(dialog.getByText("מסונן לפי:")).toContainText("נהיגה");
  await openFilters(dialog);
  await expect(
    dialog.getByRole("group", { name: "יכולת" }).getByLabel("נהיגה")
  ).toBeChecked();
  await expect(
    dialog
      .getByRole("group", { name: "כשירות בתוקף לכל משך התורנות" })
      .getByLabel("נשק אישי")
  ).not.toBeChecked();
});

test("each filter keeps to the rules of the duty date, and the manager can clear them", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  const open = await createDuty("תורנות לסינון");
  const dialog = await openManual(page, open.id);
  await openFilters(dialog);

  // The duty's conditions are already ticked, and a filter is there for every catalog.
  for (const legend of [
    "אוכלוסיית שיבוץ לכל משך התורנות",
    "מגדר",
    "הסתרת מי שיש לו פטור במועד התורנות",
    "כשירות בתוקף לכל משך התורנות",
    "יכולת",
    "דרגה בתחילת התורנות",
  ])
    await expect(dialog.getByRole("group", { name: legend })).toBeVisible();
  const group = (legend: string) => dialog.getByRole("group", { name: legend });
  await expect(
    group("אוכלוסיית שיבוץ לכל משך התורנות").getByLabel("חובה")
  ).toBeChecked();
  await expect(
    group("כשירות בתוקף לכל משך התורנות").getByLabel("נשק אישי")
  ).toBeChecked();
  await expect(
    group("הסתרת מי שיש לו פטור במועד התורנות").getByLabel("פטור מאבטחה")
  ).toBeChecked();
  await expect(group("יכולת").getByLabel("נהיגה")).not.toBeChecked();

  // Capability: only someone who holds it.
  await group("יכולת").getByLabel("נהיגה").check();
  expect(await names(dialog)).toEqual(["דנה ירוק"]);
  await group("יכולת").getByLabel("נהיגה").uncheck();

  // Gender.
  await group("מגדר").getByLabel("נקבה").check();
  expect(await names(dialog)).toEqual(["דנה ירוק", "רותם מתקדמת"]);
  await group("מגדר").getByLabel("זכר").check();
  expect(await names(dialog)).toHaveLength(4);
  await group("מגדר").getByLabel("נקבה").uncheck();
  await group("מגדר").getByLabel("זכר").uncheck();

  // Rank counts at the start of the duty: the promotion the day after does not.
  await group("דרגה בתחילת התורנות").getByLabel("סמל").check();
  expect(await names(dialog)).toEqual(["דנה ירוק"]);
  await group("דרגה בתחילת התורנות").getByLabel("סמל").uncheck();
  await group("דרגה בתחילת התורנות").getByLabel("טוראי").check();
  expect(await names(dialog)).toEqual(["דני כחול", "רותם מתקדמת"]);
  await group("דרגה בתחילת התורנות").getByLabel("טוראי").uncheck();
  await group("דרגה בתחילת התורנות").getByLabel("ללא דרגה").check();
  expect(await names(dialog)).toEqual(["גיל פטור שהסתיים"]);
  await group("דרגה בתחילת התורנות").getByLabel("ללא דרגה").uncheck();
  expect(await names(dialog)).toHaveLength(4);

  // Exemption: the one that ended the day before no longer hides anyone; one on the day does.
  await group("הסתרת מי שיש לו פטור במועד התורנות")
    .getByLabel("פטור מאבטחה")
    .uncheck();
  expect(await names(dialog)).toEqual([
    "איתן פטור",
    "גיל פטור שהסתיים",
    "דנה ירוק",
    "דני כחול",
    "רותם מתקדמת",
  ]);
  // Qualification: valid for the whole duty only.
  await group("כשירות בתוקף לכל משך התורנות").getByLabel("נשק אישי").uncheck();
  await group("אוכלוסיית שיבוץ לכל משך התורנות").getByLabel("חובה").uncheck();
  await expect(count(dialog)).toHaveText("7 חיילים");
  expect(await names(dialog)).toContain("נועה אדומה");
  expect(await names(dialog)).toContain("יובל קבע");
  await group("כשירות בתוקף לכל משך התורנות").getByLabel("נשק אישי").check();
  expect(await names(dialog)).not.toContain("נועה אדומה");

  // Back to the duty's own filters, then everything cleared.
  await dialog
    .getByRole("button", { name: "חזרה לברירת המחדל של התורנות" })
    .click();
  expect(await names(dialog)).toHaveLength(4);
  await expect(
    dialog.getByRole("button", { name: "חזרה לברירת המחדל של התורנות" })
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "ניקוי הסינונים" }).click();
  await expect(count(dialog)).toHaveText("7 חיילים");
  expect(await names(dialog)).toHaveLength(7);
  await expect(dialog.getByText("מסונן לפי:")).toHaveCount(0);

  // A value added to a catalog shows up in the filter without a change in code.
  await run("eligibility.catalog.save", {
    kind: "capability",
    name: "עזרה ראשונה",
  });
  const fresh = await openManual(page, open.id);
  await openFilters(fresh);
  await expect(
    fresh.getByRole("group", { name: "יכולת" }).getByLabel("עזרה ראשונה")
  ).toBeVisible();
});

test("the server still checks a soldier the filters had hidden", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  const open = await createDuty("תורנות לבדיקת שרת");
  const dialog = await openManual(page, open.id);

  // Exempt on the duty day: not listed, but found by clearing the exemption filter.
  await expect(dialog.getByRole("radio", { name: /איתן פטור/ })).toHaveCount(0);
  await openFilters(dialog);
  await dialog
    .getByRole("group", { name: "הסתרת מי שיש לו פטור במועד התורנות" })
    .getByLabel("פטור מאבטחה")
    .uncheck();
  await dialog.getByRole("radio", { name: /איתן פטור/ }).check();
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(
    dialog.getByLabel("נדרש אישור חריג לפטור עם סיבה", { exact: true })
  ).toBeVisible();
  // Going back keeps the choice.
  await dialog.getByRole("button", { name: "חזרה לבחירת חייל" }).click();
  await expect(dialog.getByRole("radio", { name: /איתן פטור/ })).toBeChecked();

  // Someone the filters kept is assigned as before.
  await dialog.getByRole("radio", { name: /דנה ירוק/ }).check();
  await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(dialog).toContainText("ניקוד צפוי: 4");
  await dialog.getByLabel("בדקתי את ההתאמה ואת הניקוד").check();
  await dialog
    .getByRole("button", { name: "אישור השיבוץ", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const state = await (await page.request.get("/api/v1/state")).json();
  expect(
    state.assignments.filter(
      (row: { dutyId: string; soldierId: string }) =>
        row.dutyId === open.id && row.soldierId === ids.dana
    )
  ).toHaveLength(1);
});

test("the picker works with the keyboard and on a phone without sideways scrolling", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  const open = await createDuty("תורנות לנייד");
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    const dialog = await openManual(page, open.id);
    await expect(count(dialog)).toHaveText("4 מתוך 7 חיילים");
    expect(await fits(page)).toBe(true);
    await openFilters(dialog);
    await expect(
      dialog.getByRole("group", { name: "דרגה בתחילת התורנות" })
    ).toBeVisible();
    expect(await fits(page)).toBe(true);
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)
    ).toBe(true);
    await page.screenshot({ path: "test-results/soldier-picker-mobile.png" });

    // Keyboard: type, move into the list, choose with the arrow keys.
    const search = dialog.getByLabel("חיפוש חייל לפי שם או מספר אישי");
    await search.fill("דנ");
    expect(await names(dialog)).toEqual(["דנה ירוק", "דני כחול"]);
    await dialog.getByRole("radio", { name: /דנה ירוק/ }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(dialog.getByRole("radio", { name: /דני כחול/ })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /דני כחול/ })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(dialog.getByRole("radio", { name: /דנה ירוק/ })).toBeChecked();
    // The count is announced politely, and every control has a name.
    await expect(count(dialog)).toHaveAttribute("role", "status");
    for (const control of await dialog
      .locator("input:not([type=hidden]), button, select")
      .all())
      expect(
        (await control.getAttribute("aria-label")) ||
          (await control.innerText()) ||
          (await control.evaluate(
            (node) => (node as HTMLInputElement).labels?.length
          ))
      ).toBeTruthy();
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

test("the compact finder in a change proposal also fits a phone", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  const draft = await createDuty("טיוטה לנייד");
  await run(
    "duty.change.create",
    { dutyId: draft.id, reason: "בדיקת נייד" },
    draft.version
  );
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await page.goto(`/duties/${draft.id}`);
    await page.getByRole("button", { name: "עריכת ההצעה והשיבוצים" }).click();
    const editor = page.getByRole("dialog");
    await editor.getByRole("button", { name: /^מקום 1: תורן/ }).click();
    await openFilters(editor);
    await expect(
      editor.getByRole("group", { name: "דרגה בתחילת התורנות" })
    ).toBeVisible();
    expect(await fits(page)).toBe(true);
    expect(
      await editor.evaluate((node) => node.scrollWidth <= node.clientWidth)
    ).toBe(true);
    await page.screenshot({
      path: "test-results/soldier-picker-proposal-mobile.png",
    });
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

test("a seat in a change proposal uses the same finder, and follows the times being typed", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  const draft = await createDuty("טיוטה להצעת שינוי");
  await run(
    "duty.change.create",
    { dutyId: draft.id, reason: "בדיקת בורר" },
    draft.version
  );
  await page.goto(`/duties/${draft.id}`);
  await page.getByRole("button", { name: "עריכת ההצעה והשיבוצים" }).click();
  const editor = page.getByRole("dialog");

  // Collapsed to the current choice until the manager asks to change it.
  const seat = editor.getByRole("button", { name: /^מקום 1: תורן/ });
  await expect(seat).toContainText("להשאיר פנוי");
  await expect(editor.getByRole("radiogroup")).toHaveCount(0);
  await seat.click();
  const list = editor.getByRole("radiogroup", { name: /מקום 1: תורן/ });
  await expect(list.getByRole("radio", { name: /איתן פטור/ })).toHaveCount(0);

  // The exemption covers the day of the duty. Moved two days later, it no longer applies.
  await editor.getByLabel("תחילת התורנות המוצעת").fill(`${day(2)}T08:00`);
  await editor.getByLabel("סיום התורנות המוצעת").fill(`${day(2)}T16:00`);
  await expect(list.getByRole("radio", { name: /איתן פטור/ })).toBeVisible();

  // Escape closes the finder and leaves the dialog open.
  await editor.getByLabel(/^חיפוש חייל לפי שם או מספר אישי/).focus();
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(seat).toBeFocused();

  await seat.click();
  // The finder closes on a choice, so the radio is clicked, not checked.
  await list.getByRole("radio", { name: /דנה ירוק/ }).click();
  await expect(list).toHaveCount(0);
  await expect(seat).toContainText("דנה ירוק");
  await editor.getByRole("button", { name: "שמירת הצעה בלבד" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const state = await (await page.request.get("/api/v1/state")).json();
  const change = state.dutyChanges.find(
    (row: { dutyId: string }) => row.dutyId === draft.id
  );
  expect(change.seats[0].soldierId).toBe(ids.dana);
});

test("a duty type with every gender is no gender condition: the form says so and a soldier without a gender stays in the picker", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  // Added here and removed at the end, so the counts of the other tests stay.
  const unknownId = await addSoldier("unknown", "ללא מגדר", "880009", {
    qualifications: [],
  });
  try {
    await page.goto("/manage/catalog");
    await page
      .getByRole("button", { name: "סוג תורנות חדש", exact: true })
      .click();
    const form = page.getByRole("dialog");
    await form.getByLabel("שם סוג התורנות").fill("כל המגדרים");
    await form.getByLabel("ניקוד בסיס").fill("4");
    await expect(form.getByText("כל המגדרים = ללא תנאי מגדר")).not.toHaveCount(
      0
    );
    await form
      .getByLabel("מגדר מותר", { exact: true })
      .selectOption(["male", "female", "other"]);
    await form.getByRole("button", { name: "שמירה", exact: true }).click();
    await expect(form).not.toBeVisible();
    const [saved] = await db
      .select()
      .from(dutyTypes)
      .where(eq(dutyTypes.name, "כל המגדרים"));
    expect(saved.data.genders).toEqual([]);
    expect(saved.data.requirements).toMatchObject({ genders: [] });

    const open = await createDuty("תורנות לכל המגדרים", saved.id);
    const dialog = await openManual(page, open.id);
    await expect(dialog.getByRole("radio", { name: /ללא מגדר/ })).toBeVisible();
    // Every gender allowed is not a gender filter (the population filter is another rule).
    await expect(dialog.getByText("מסונן לפי:")).not.toContainText("מגדר");
    await openFilters(dialog);
    await expect(
      dialog.getByRole("group", { name: "מגדר" }).getByRole("checkbox", {
        checked: true,
      })
    ).toHaveCount(0);
    await dialog.getByRole("radio", { name: /ללא מגדר/ }).check();
    await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
    // The server agrees: no "missing gender" block, and the seat is assigned.
    await expect(dialog).toContainText("ניקוד צפוי: 4");
    await expect(dialog.getByText("מידע חסר: מגדר")).toHaveCount(0);
    await dialog.getByLabel("בדקתי את ההתאמה ואת הניקוד").check();
    await dialog
      .getByRole("button", { name: "אישור השיבוץ", exact: true })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    const state = await (await page.request.get("/api/v1/state")).json();
    expect(
      state.assignments.filter(
        (row: { dutyId: string; soldierId: string }) =>
          row.dutyId === open.id && row.soldierId === unknownId
      )
    ).toHaveLength(1);
  } finally {
    await db.transaction((tx) =>
      eraseRelatedCopies(
        tx,
        unknownId,
        undefined,
        [unknownId],
        new Date().toISOString()
      )
    );
    await db
      .delete(commandResultSubjects)
      .where(eq(commandResultSubjects.soldierId, unknownId));
    await db.delete(assignments).where(eq(assignments.soldierId, unknownId));
    await db.delete(balances).where(eq(balances.soldierId, unknownId));
    await db.delete(soldiers).where(eq(soldiers.id, unknownId));
  }
});
