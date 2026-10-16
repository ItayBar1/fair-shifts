import { test, expect } from "@playwright/test";

// Decision 228: Google brand verification needs a public privacy policy on the
// app's domain, linked from the home page (the login screen).
test("the login screen links to a public privacy policy that explains the Google data", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "מדיניות פרטיות" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(
    page.getByRole("heading", { name: "מדיניות פרטיות", level: 1 })
  ).toBeVisible();
  await expect(page.getByText("אחראי תורנויות יחידת מע״מ")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "נתונים מ־Google" })
  ).toBeVisible();
  await expect(page.getByText("calendar.app.created")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Google API Services User Data Policy" })
  ).toHaveAttribute(
    "href",
    "https://developers.google.com/terms/api-services-user-data-policy"
  );

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.getByRole("link", { name: "חזרה לכניסה" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("anyone can send a contact request from the privacy page, and it waits for the daily digest", async ({
  page,
}) => {
  await page.goto("/privacy");
  await page.getByRole("button", { name: "שליחת הפנייה" }).click();
  // The browser's own required check stops an empty form.
  await expect(page.getByLabel("שם", { exact: true })).toBeFocused();
  await page.getByLabel("שם", { exact: true }).fill("פונה מבחוץ");
  await page.getByLabel("מייל או טלפון לחזרה").fill("0501234567");
  await page.getByLabel("הפנייה").fill("רציתי לבקש לעיין במידע שנשמר עליי");
  await page.getByRole("button", { name: "שליחת הפנייה" }).click();
  await expect(page.getByText("הפנייה התקבלה")).toBeVisible();
});
