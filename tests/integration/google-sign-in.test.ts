import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import {
  user,
  session,
  account,
  emailOutbox,
} from "../../src/server/auth-schema";
import { soldiers, soldierContacts, balances } from "../../src/server/schema";
import {
  applyVerifiedEmailChange,
  createInvitedAccount,
} from "../../src/server/auth/accounts";
import { requestCode, verifyCode } from "../../src/server/auth/otp";
import { getActor, getAuth } from "../../src/server/auth";
import { openSecret } from "../../src/server/operations/email";
import { executeAction } from "../../src/server/actions";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// Synthetic OAuth client. Better Auth runs its real sign-in, state and callback
// code; only Google's token endpoint is replaced, and it answers with the
// profile registered for the authorization code it receives.
const clientId = "synthetic-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_ID = clientId;
process.env.GOOGLE_CLIENT_SECRET = "synthetic-google-client-secret";
const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

type GoogleProfile = { sub: string; email: string; email_verified: boolean };
const profiles = new Map<string, GoogleProfile>();
const segment = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
function idToken(profile: GoogleProfile) {
  const now = Math.floor(Date.now() / 1000);
  return [
    segment({ alg: "RS256", typ: "JWT", kid: "synthetic" }),
    segment({
      iss: "https://accounts.google.com",
      aud: clientId,
      iat: now,
      exp: now + 3600,
      name: "חשבון Google לבדיקה",
      ...profile,
    }),
    "synthetic-signature",
  ].join(".");
}
const realFetch = globalThis.fetch;
vi.stubGlobal(
  "fetch",
  async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const profile = profiles.get(body.get("code") ?? "");
      if (!profile)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: "synthetic-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
        id_token: idToken(profile),
      });
    }
    if (url.startsWith("https://"))
      throw new Error(`Unexpected request outside the test: ${url}`);
    return realFetch(input, init);
  }
);

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

/** The login page's Google button, then Google's redirect back with a code. */
async function googleSignIn(profile: GoogleProfile) {
  const start = await getAuth().handler(
    new Request(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "/",
        errorCallbackURL: "/login",
      }),
    })
  );
  expect(start.status, await start.clone().text()).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const code = randomUUID();
  profiles.set(code, profile);
  const callback = await getAuth().handler(
    new Request(
      `${base}/api/auth/callback/google?code=${code}&state=${encodeURIComponent(state)}`,
      { headers: { cookie: cookiesOf(start) } }
    )
  );
  const location = new URL(callback.headers.get("location") ?? "", base);
  const cookie = cookiesOf(callback);
  return {
    signedIn: callback.status === 302 && location.pathname === "/",
    error: location.searchParams.get("error"),
    cookie: cookie.includes("session_token") ? cookie : "",
  };
}

const emails = {
  member: "google-member@example.invalid",
  other: "google-other@example.invalid",
};
let memberId: string;
async function invite(email: string, personalNumber: string) {
  const id = randomUUID();
  const name = `חייל ${personalNumber}`;
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber,
    data: soldier({ id, name, personalNumber }),
  });
  await db.insert(soldierContacts).values({ soldierId: id, email });
  await db.insert(balances).values({ soldierId: id });
  return (await createInvitedAccount({ name, email, soldierId: id })).id;
}
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, auth_verification, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  profiles.clear();
  memberId = await invite(emails.member, "4000001");
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
});

const googleLinks = (userId: string) =>
  db
    .select({ accountId: account.accountId })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "google")));
const person = async (id: string) =>
  (await db.select().from(user).where(eq(user.id, id)))[0];
async function codeSignIn(email: string, accountId: string) {
  await requestCode(email);
  const rows = await db
    .select()
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.recipientAccountId, accountId),
        eq(emailOutbox.kind, "login-code")
      )
    );
  const latest = rows.sort(
    (a, b) => b.expiresAt.getTime() - a.expiresAt.getTime()
  )[0];
  return verifyCode(email, openSecret(latest.encryptedSecret!));
}

describe("Google sign-in for invited accounts, bound to Google's sub", () => {
  it("lets an invited person start with Google and then use either Google or an email code", async () => {
    expect(await person(memberId)).toMatchObject({
      emailVerified: false,
      firstSignInAt: null,
    });
    const first = await googleSignIn({
      sub: "sub-member",
      email: emails.member,
      email_verified: true,
    });
    expect(first).toMatchObject({ signedIn: true, error: null });
    expect((await getActor(new Headers({ cookie: first.cookie })))?.id).toBe(
      memberId
    );
    expect(await googleLinks(memberId)).toEqual([{ accountId: "sub-member" }]);
    expect((await person(memberId)).firstSignInAt).not.toBeNull();

    // The email code keeps working next to the Google link, and vice versa.
    await expect(codeSignIn(emails.member, memberId)).resolves.toMatchObject({
      user: { id: memberId },
    });
    const again = await googleSignIn({
      sub: "sub-member",
      email: emails.member,
      email_verified: true,
    });
    expect((await getActor(new Headers({ cookie: again.cookie })))?.id).toBe(
      memberId
    );
    expect(await googleLinks(memberId)).toHaveLength(1);
    expect(
      await db.select().from(user).where(eq(user.email, emails.member))
    ).toHaveLength(1);
  });

  it("keeps the first sub: another Google account with the same address is refused, a changed Google address is not", async () => {
    await googleSignIn({
      sub: "sub-first",
      email: emails.member,
      email_verified: true,
    });
    const intruder = await googleSignIn({
      sub: "sub-second",
      email: emails.member,
      email_verified: true,
    });
    expect(intruder).toMatchObject({ signedIn: false, cookie: "" });
    expect(intruder.error).toBeTruthy();
    expect(await googleLinks(memberId)).toEqual([{ accountId: "sub-first" }]);

    // The address is not the identity: the linked sub still signs in after
    // its Google address changed.
    const renamed = await googleSignIn({
      sub: "sub-first",
      email: "renamed-at-google@example.invalid",
      email_verified: true,
    });
    expect((await getActor(new Headers({ cookie: renamed.cookie })))?.id).toBe(
      memberId
    );
    expect((await person(memberId)).email).toBe(emails.member);
  });

  it("links only one of two Google accounts that race for the same invitation", async () => {
    const results = await Promise.all(
      ["sub-race-a", "sub-race-b"].map((sub) =>
        googleSignIn({ sub, email: emails.member, email_verified: true })
      )
    );
    const links = await googleLinks(memberId);
    expect(links).toHaveLength(1);
    const winner = results.filter((result) => result.cookie);
    expect(winner).toHaveLength(1);
    expect(
      (await getActor(new Headers({ cookie: winner[0].cookie })))?.id
    ).toBe(memberId);
  });

  it("refuses an uninvited address and an address Google has not verified, creating nothing", async () => {
    const stranger = await googleSignIn({
      sub: "sub-stranger",
      email: "stranger@example.invalid",
      email_verified: true,
    });
    expect(stranger).toMatchObject({ signedIn: false, cookie: "" });
    expect(stranger.error).toBeTruthy();
    expect(
      await db
        .select()
        .from(user)
        .where(eq(user.email, "stranger@example.invalid"))
    ).toHaveLength(0);

    const unverified = await googleSignIn({
      sub: "sub-unverified",
      email: emails.member,
      email_verified: false,
    });
    expect(unverified).toMatchObject({ signedIn: false, cookie: "" });
    expect(await googleLinks(memberId)).toHaveLength(0);
    expect(
      await db.select().from(session).where(eq(session.userId, memberId))
    ).toHaveLength(0);
  });

  it("resets earlier code failures on a Google success, and a lock blocks Google and its sessions", async () => {
    await requestCode(emails.member);
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(verifyCode(emails.member, "000000")).rejects.toThrow();
    expect((await person(memberId)).failedAttempts).toBe(2);
    const before = await googleSignIn({
      sub: "sub-member",
      email: emails.member,
      email_verified: true,
    });
    expect(before.signedIn).toBe(true);
    expect((await person(memberId)).failedAttempts).toBe(0);

    // A pre-decision-207 lock still blocks Google; new OTP failures do not lock.
    await db
      .update(user)
      .set({
        lockedAt: new Date(),
        securityEpoch: sql`${user.securityEpoch} + 1`,
      })
      .where(eq(user.id, memberId));
    expect((await person(memberId)).lockedAt).not.toBeNull();
    expect(await getActor(new Headers({ cookie: before.cookie }))).toBeNull();

    const after = await googleSignIn({
      sub: "sub-member",
      email: emails.member,
      email_verified: true,
    });
    expect(after).toMatchObject({
      signedIn: false,
      cookie: "",
      error: "unable_to_create_session",
    });
    expect((await person(memberId)).lockedAt).not.toBeNull();
  });

  it("drops the old Google link on a verified email change and links the new address afresh", async () => {
    await googleSignIn({
      sub: "sub-old",
      email: emails.member,
      email_verified: true,
    });
    await db.transaction((tx) =>
      applyVerifiedEmailChange(tx, memberId, emails.other)
    );
    expect(await googleLinks(memberId)).toHaveLength(0);

    const old = await googleSignIn({
      sub: "sub-old",
      email: emails.member,
      email_verified: true,
    });
    expect(old).toMatchObject({ signedIn: false, cookie: "" });
    expect(await googleLinks(memberId)).toHaveLength(0);

    const renewed = await googleSignIn({
      sub: "sub-new",
      email: emails.other,
      email_verified: true,
    });
    expect((await getActor(new Headers({ cookie: renewed.cookie })))?.id).toBe(
      memberId
    );
    expect(await googleLinks(memberId)).toEqual([{ accountId: "sub-new" }]);
  });
});

describe("Google sign-in after the technical account changes its address (decision 204)", () => {
  it("drops the Google link, refuses the old Google account and links the new address afresh", async () => {
    const technical = await createInvitedAccount({
      name: "טכני Google",
      role: "technical",
      email: emails.member.replace("member", "technical"),
    });
    const next = "google-technical-next@example.invalid";
    const old = {
      sub: "sub-technical-old",
      email: technical.email,
      email_verified: true,
    };
    const first = await googleSignIn(old);
    expect((await getActor(new Headers({ cookie: first.cookie })))?.id).toBe(
      technical.id
    );

    const act = async (type: string, payload: Record<string, unknown>) => {
      const [row] = await db
        .select()
        .from(user)
        .where(eq(user.id, technical.id));
      return executeAction(
        {
          id: row.id,
          name: row.name,
          role: "technical",
          securityEpoch: row.securityEpoch,
        },
        { type, payload, idempotencyKey: randomUUID() }
      );
    };
    await act("technical.email.request", {
      email: next,
      reason: "מעבר לחשבון הייעודי",
    });
    const codes = Object.fromEntries(
      (
        await db
          .select()
          .from(emailOutbox)
          .where(eq(emailOutbox.kind, "email-change"))
      ).map((row) => [row.destination, openSecret(row.encryptedSecret!)])
    );
    await act("technical.email.confirm", {
      currentCode: codes[technical.email],
      newCode: codes[next],
    });

    // The connection opened with the old address ended, and so did the link.
    expect(await getActor(new Headers({ cookie: first.cookie }))).toBeNull();
    expect(await googleLinks(technical.id)).toHaveLength(0);
    expect(await googleSignIn(old)).toMatchObject({
      signedIn: false,
      cookie: "",
    });

    // The account is now the invitation of the new address (decision 185).
    const fresh = await googleSignIn({
      sub: "sub-technical-new",
      email: next,
      email_verified: true,
    });
    expect(fresh.signedIn).toBe(true);
    expect((await getActor(new Headers({ cookie: fresh.cookie })))?.id).toBe(
      technical.id
    );
    expect(await googleLinks(technical.id)).toEqual([
      { accountId: "sub-technical-new" },
    ]);
    // A second Google account for the same address is refused, as for any account.
    const intruder = await googleSignIn({
      sub: "sub-technical-third",
      email: next,
      email_verified: true,
    });
    expect(intruder).toMatchObject({ signedIn: false, cookie: "" });
  });
});
