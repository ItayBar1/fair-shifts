import { test, expect } from "@playwright/test";
import { CALENDAR_SCOPE } from "../../src/domain/calendar-sync";

// The first step of the Google button through the real Next.js server, on the
// production Node version. Integration tests call the auth handler directly, so
// only this path shows a failure of the request Next.js hands the route (#118).
// Google itself is never reached: the server only builds the link.
test("the Google button gets a Google link from the server, with the server's own permissions", async ({
  request,
  baseURL,
}) => {
  const response = await request.post("/api/auth/sign-in/social", {
    headers: { origin: new URL(baseURL!).origin },
    data: {
      provider: "google",
      callbackURL: "/",
      errorCallbackURL: "/login",
      // A direct caller cannot broaden what is asked of Google (decision 195).
      scopes: ["https://www.googleapis.com/auth/calendar"],
      additionalParams: { prompt: "consent", access_type: "online" },
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  const link = new URL(((await response.json()) as { url: string }).url);
  expect(link.hostname).toBe("accounts.google.com");
  const scopes = (link.searchParams.get("scope") ?? "").split(" ").sort();
  expect(scopes).toEqual(["email", "openid", "profile", CALENDAR_SCOPE].sort());
  expect(link.searchParams.get("access_type")).toBe("offline");
  expect(link.searchParams.get("prompt")).toBe("consent");
});
