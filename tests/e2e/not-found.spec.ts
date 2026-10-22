import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// #197: an address the site does not answer is a 404 with a page of its own,
// while every address the system links to still opens.
test("an unknown address is a 404 page in Hebrew that leads back to the login screen", async ({
  page,
}) => {
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle("הדף לא נמצא · תורנות הוגנת");
  await expect(
    page.getByRole("heading", { name: "הדף לא נמצא", level: 1 })
  ).toBeVisible();
  await expect(page.getByText("קוד שגיאה 404")).toBeVisible();
  expect(
    await page.locator('meta[name="robots"]').first().getAttribute("content")
  ).toContain("noindex");

  const failures: string[] = [];
  for (const colorScheme of ["light", "dark"] as const)
    for (const width of [1280, 375]) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 812 });
      await page.reload();
      const where = `${colorScheme} ${width}px`;
      if (
        !(await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        ))
      )
        failures.push(`${where}: scrolls sideways`);
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      for (const violation of result.violations)
        failures.push(`${where}: axe ${violation.id}`);
    }
  expect(failures).toEqual([]);

  // A signed-out visitor goes on to the login screen.
  await page.getByRole("link", { name: "חזרה למערכת" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("every address the system links to still opens, and anything else is a 404", async ({
  request,
}) => {
  for (const path of [
    "/",
    "/calendar?mine=1",
    "/manage/scores",
    "/manage/planning",
    "/technical/backups",
    "/duties/any-duty",
    "/manage/audit/any-entry",
    "/manage/publish/run/any-run",
    "/login",
    "/privacy",
    "/robots.txt",
  ])
    expect(`${path} ${(await request.get(path)).status()}`).toBe(`${path} 200`);
  for (const path of [
    "/no-such-page",
    "/manage/nowhere",
    "/duties",
    "/duties/one/two",
    "/technical/backups/extra",
  ])
    expect(`${path} ${(await request.get(path)).status()}`).toBe(`${path} 404`);
});
