import { test, expect } from "@playwright/test";

test("each HTML response gets a fresh server nonce and rejects client-provided CSP headers", async ({
  request,
}) => {
  const read = async () => {
    const response = await request.get("/login", {
      headers: {
        "x-nonce": "client-nonce",
        "content-security-policy": "script-src 'unsafe-inline' 'unsafe-eval'",
      },
    });
    expect(response.status()).toBe(200);
    const csp = response.headers()["content-security-policy"];
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(
      csp.split(";").find((part) => part.trim().startsWith("script-src "))
    ).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(response.headers()["strict-transport-security"]).toBe(
      "max-age=31536000"
    );
    const scripts = (await response.text()).match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).toContain(`nonce="${nonce}"`);
    return nonce;
  };
  expect(await read()).not.toBe(await read());
});

test("the production browser boots normally and blocks injected inline script and eval", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Insert untrusted parser content into the response. CDP page.evaluate is
  // trusted browser automation and is not an accurate inline-XSS source.
  await page.route("**/login", async (route) => {
    const response = await route.fetch();
    const nonce = response
      .headers()
      ["content-security-policy"].match(/'nonce-([^']+)'/)![1];
    const body = (await response.text()).replace(
      "</body>",
      `<script nonce="${nonce}">window.__cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__cspViolations.push(e.violatedDirective));try{new Function('return 1')();window.__evalBlocked=false}catch{window.__evalBlocked=true}</script><script>window.__injectedSecurityProbe=true</script></body>`
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: "שליחת קוד למייל", exact: true })
  ).toBeVisible();
  const result = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const values = window as unknown as Record<string, unknown>;
    return {
      inlineBlocked: !values.__injectedSecurityProbe,
      evalBlocked: values.__evalBlocked,
      violations: values.__cspViolations as string[],
    };
  });
  expect(result.inlineBlocked).toBe(true);
  expect(result.evalBlocked).toBe(true);
  expect(
    result.violations.some((value) => value.startsWith("script-src"))
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("public health exposes readiness only and remains independent of missing worker heartbeat", async ({
  request,
}) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toEqual({ status: "ok" });
});
