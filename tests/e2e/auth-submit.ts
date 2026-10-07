import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The production Better Auth limiter uses a shared IP/path bucket in memory;
 * resetting the test database does not reset that bucket. It differs from the
 * application's per-account OTP cooldown and failed-code counter. Only retry a
 * native limiter refusal, which happens before either OTP operation is run.
 */
export async function submitAuth(
  page: Page,
  path: "/api/auth/request-code" | "/api/auth/verify-code",
  button: Locator
) {
  const submit = async () => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === path
      ),
      button.click(),
    ]);
    return response;
  };

  let response = await submit();
  if (response.status() === 429) {
    const body: unknown = await response.json().catch(() => null);
    const delayHeader = await response.headerValue("x-retry-after");
    const delay = delayHeader?.trim() ? Number(delayHeader) : NaN;
    if (
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      "message" in body &&
      body.message === "Too many requests. Please try again later." &&
      Number.isFinite(delay) &&
      delay > 0 &&
      delay <= 10
    ) {
      // Honor the server's bounded backoff, with a small expiry margin. There
      // is one retry only; application OTP failures and 401s are never retried.
      await page.waitForTimeout(delay * 1_000 + 150);
      response = await submit();
    }
  }
  expect(
    response.ok(),
    `Authentication POST ${path}: ${response.status()}`
  ).toBe(true);
}
