import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { magicLink } from "better-auth/plugins";
import { expect, it } from "vitest";

// The application does not enable Magic Link. This isolated fixture reproduces
// CVE-2026-114607 against the installed library without changing app sign-in.
it("refuses an OAuth state as a magic link while accepting the actual emailed token", async () => {
  const base = "http://localhost:3000";
  const email = "state-isolation@example.invalid";
  const person = {
    id: "synthetic-state-isolation-user",
    email,
    name: "Synthetic invited user",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let emailedToken = "";
  const auth = betterAuth({
    baseURL: base,
    secret: "synthetic-state-isolation-secret-only-for-unit-tests-0001",
    database: memoryAdapter({
      user: [person],
      session: [],
      account: [],
      verification: [],
    }),
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    socialProviders: {
      google: {
        clientId: "synthetic-state-isolation.apps.googleusercontent.com",
        clientSecret: "synthetic-google-client-secret",
      },
    },
    plugins: [
      magicLink({
        disableSignUp: true,
        sendMagicLink: ({ token }) => {
          emailedToken = token;
        },
      }),
    ],
  });
  const post = (path: string, body: object) =>
    auth.handler(
      new Request(`${base}/api/auth${path}`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  const start = await post("/sign-in/social", {
    provider: "google",
    callbackURL: "/",
    additionalData: { email, name: person.name },
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  expect(state).toBeTruthy();
  const verify = (token: string) =>
    auth.handler(
      new Request(
        `${base}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=/`
      )
    );
  const cookiesOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

  const forged = await verify(state!);
  expect(cookiesOf(forged)).not.toContain("session_token");
  expect(
    await auth.api.getSession({
      headers: new Headers({ cookie: cookiesOf(forged) }),
    })
  ).toBeNull();
  expect(emailedToken).toBe("");

  expect(
    (await post("/sign-in/magic-link", { email, callbackURL: "/" })).status
  ).toBe(200);
  expect(emailedToken).not.toBe("");
  const legitimate = await verify(emailedToken);
  expect(cookiesOf(legitimate)).toContain("session_token");
  expect(
    (
      await auth.api.getSession({
        headers: new Headers({ cookie: cookiesOf(legitimate) }),
      })
    )?.user.id
  ).toBe(person.id);
});
