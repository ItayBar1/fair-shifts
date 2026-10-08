import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { account, user } from "../../src/server/auth-schema";
import {
  balances,
  calendarLink,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { getAuth, googleProvider } from "../../src/server/auth";
import { readState } from "../../src/server/state";
import { openSecret } from "../../src/server/operations/email";
import {
  CALENDAR_SCOPE,
  permissionLostNotice,
} from "../../src/domain/calendar-sync";
import { FakeGoogle, type Profile } from "../google-fake";
import { soldier } from "../fixtures";
import {
  recordGoogleGrant,
  purgeCalendarLink,
  scheduleCalendarCleanup,
  settleCalendarCleanups,
} from "../../src/server/calendar/link";
import * as calendarGoogle from "../../src/server/calendar/google";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

process.env.GOOGLE_CALENDAR_SYNC = "true";
const google = new FakeGoogle();
google.install();
const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const standardScopes = ["openid", "email", "profile"];
const withCalendar = [...standardScopes, CALENDAR_SCOPE];

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

/** The login page's Google button, then Google's redirect back with a code. */
async function googleSignIn(
  profile: Profile,
  options: {
    scopes?: string[];
    refreshToken?: string;
    additionalParams?: Record<string, string>;
    requestedScopes?: string[];
    error?: string;
    expiredCode?: boolean;
  } = {}
) {
  const start = await getAuth().handler(
    new Request(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "/",
        errorCallbackURL: "/login",
        ...(options.requestedScopes && { scopes: options.requestedScopes }),
        ...(options.additionalParams && {
          additionalParams: options.additionalParams,
        }),
      }),
    })
  );
  expect(start.status, await start.clone().text()).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorization = new URL(url);
  const code = google.issueCode(profile, options);
  if (options.expiredCode) google.codes.delete(code);
  const parameters = new URLSearchParams({
    state: authorization.searchParams.get("state")!,
  });
  if (options.error) parameters.set("error", options.error);
  else parameters.set("code", code);
  const callback = await getAuth().handler(
    new Request(`${base}/api/auth/callback/google?${parameters}`, {
      headers: { cookie: cookiesOf(start) },
    })
  );
  const location = new URL(callback.headers.get("location") ?? "", base);
  return {
    authorization,
    signedIn: callback.status === 302 && location.pathname === "/",
  };
}

let memberId: string;
let managerId: string;
const email = (name: string) => `${name}@example.invalid`;
async function invite(
  name: string,
  role: "soldier" | "manager",
  number: string
) {
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber: number,
    data: soldier({ id, name, personalNumber: number }),
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: email(name) });
  await db.insert(balances).values({ soldierId: id });
  return (
    await createInvitedAccount({
      name,
      email: email(name),
      role,
      soldierId: id,
    })
  ).id;
}
const profile = (sub: string, name: string): Profile => ({
  sub,
  email: email(name),
  email_verified: true,
});
const linkOf = async (id: string) =>
  (
    await db.select().from(calendarLink).where(eq(calendarLink.accountId, id))
  )[0];
const googleRow = async (id: string) =>
  (
    await db
      .select()
      .from(account)
      .where(and(eq(account.userId, id), eq(account.providerId, "google")))
  )[0];

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, auth_verification, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  google.reset();
  process.env.GOOGLE_CALENDAR_SYNC = "true";
  memberId = await invite("member", "soldier", "5100001");
  managerId = await invite("manager", "manager", "5100002");
});
afterAll(async () => pool.end());

describe("the Google sign-in and the calendar permission (decision 195)", () => {
  it("asks only for the one calendar permission and for offline access, with every sign-in", async () => {
    const first = await googleSignIn(profile("sub-member", "member"));
    const scope = (first.authorization.searchParams.get("scope") ?? "").split(
      " "
    );
    expect(scope).toEqual(expect.arrayContaining(standardScopes));
    expect(scope).toContain(CALENDAR_SCOPE);
    // Nothing broader than the calendars the application creates itself.
    expect(scope.filter((item) => item.includes("calendar"))).toEqual([
      CALENDAR_SCOPE,
    ]);
    expect(first.authorization.searchParams.get("access_type")).toBe("offline");
    // The same for a person who already signed in before.
    const again = await googleSignIn(profile("sub-member", "member"));
    expect(again.authorization.searchParams.get("scope")).toContain(
      CALENDAR_SCOPE
    );
  });

  it("lets the button of the settings screen ask Google to show the consent again", async () => {
    const result = await googleSignIn(profile("sub-member", "member"), {
      additionalParams: { prompt: "consent" },
    });
    expect(result.authorization.searchParams.get("prompt")).toBe("consent");
    // The request itself still carries the one permission and offline access.
    expect(result.authorization.searchParams.get("scope")).toContain(
      CALENDAR_SCOPE
    );
    expect(result.authorization.searchParams.get("access_type")).toBe(
      "offline"
    );
  });

  it("keeps scope and offline access under server control even for a direct sign-in request", async () => {
    const result = await googleSignIn(profile("sub-member", "member"), {
      requestedScopes: ["https://www.googleapis.com/auth/calendar"],
      additionalParams: {
        scope: "https://www.googleapis.com/auth/calendar.events",
        access_type: "online",
        include_granted_scopes: "true",
        prompt: "consent",
      },
    });
    const scopes = (result.authorization.searchParams.get("scope") ?? "").split(
      " "
    );
    expect(scopes.sort()).toEqual(withCalendar.toSorted());
    expect(result.authorization.searchParams.get("access_type")).toBe(
      "offline"
    );
    expect(
      result.authorization.searchParams.get("include_granted_scopes")
    ).not.toBe("true");
    expect(result.authorization.searchParams.get("prompt")).toBe("consent");
    expect(result.signedIn).toBe(true);
  });

  it("asks for nothing new while the deployment has the calendar sync off", () => {
    const provider = () =>
      (googleProvider() as { google: Record<string, unknown> }).google;
    process.env.GOOGLE_CALENDAR_SYNC = "false";
    expect(provider()).not.toHaveProperty("scope");
    expect(provider()).not.toHaveProperty("accessType");
    // Identity/epoch validation remains active even when no calendar scope is asked.
    expect(provider()).toHaveProperty("getUserInfo");
    process.env.GOOGLE_CALENDAR_SYNC = "true";
    expect(provider()).toMatchObject({
      scope: [CALENDAR_SCOPE],
      accessType: "offline",
    });
  });

  it("records the permission of a first sign-in with a sealed token, and keeps no token of Google in the account", async () => {
    const result = await googleSignIn(profile("sub-member", "member"), {
      scopes: withCalendar,
      refreshToken: "refresh-granted-1",
    });
    expect(result.signedIn).toBe(true);
    const link = await linkOf(memberId);
    expect(link).toMatchObject({ state: "active", enabled: true });
    expect(link.refreshToken).not.toContain("refresh-granted-1");
    expect(
      openSecret(link.refreshToken!, {
        purpose: "calendar-refresh",
        recordId: link.accountId,
      })
    ).toBe("refresh-granted-1");
    // Better Auth's own row holds the link to Google and nothing that could open the calendar.
    expect(await googleRow(memberId)).toMatchObject({
      accountId: "sub-member",
      refreshToken: null,
      accessToken: null,
      idToken: null,
    });
    const [person] = await db.select().from(user).where(eq(user.id, memberId));
    expect(
      (
        await readState({
          id: memberId,
          name: "member",
          role: "soldier",
          soldierId: person.soldierId!,
          securityEpoch: person.securityEpoch,
        })
      ).calendar
    ).toMatchObject({ state: "on" });
  });

  it("lets a person who declines the permission sign in, with the switch asking for it", async () => {
    const result = await googleSignIn(profile("sub-member", "member"), {
      scopes: standardScopes,
    });
    expect(result.signedIn).toBe(true);
    expect(await linkOf(memberId)).toBeUndefined();
    expect(await googleRow(memberId)).toBeTruthy();
  });

  it("keeps the held token when a later sign-in grants the permission again without sending a new one", async () => {
    await googleSignIn(profile("sub-member", "member"), {
      scopes: withCalendar,
      refreshToken: "refresh-first",
    });
    // Google sends the refresh token only at consent; a later sign-in carries the scope alone.
    await googleSignIn(profile("sub-member", "member"), {
      scopes: withCalendar,
    });
    expect(
      openSecret((await linkOf(memberId)).refreshToken!, {
        purpose: "calendar-refresh",
        recordId: memberId,
      })
    ).toBe("refresh-first");
    expect(await linkOf(memberId)).toMatchObject({ state: "active" });
  });

  it('turns the link to "permission needed" when a later sign-in comes back without the permission, and recovers when it is granted', async () => {
    await googleSignIn(profile("sub-member", "member"), {
      scopes: withCalendar,
      refreshToken: "refresh-first",
    });
    await db
      .update(calendarLink)
      .set({
        enabled: false,
        calendarId: "calendar-1",
        permissionNoticeAt: new Date(),
      })
      .where(eq(calendarLink.accountId, memberId));
    await googleSignIn(profile("sub-member", "member"), {
      scopes: standardScopes,
    });
    expect(await linkOf(memberId)).toMatchObject({
      state: "needs_permission",
      refreshToken: null,
      // The soldier's own choices survive.
      enabled: false,
      calendarId: "calendar-1",
    });
    await googleSignIn(profile("sub-member", "member"), {
      scopes: withCalendar,
      refreshToken: "refresh-second",
    });
    const link = await linkOf(memberId);
    expect(link).toMatchObject({
      state: "active",
      enabled: false,
      calendarId: "calendar-1",
      permissionNoticeAt: null,
    });
    expect(
      openSecret(link.refreshToken!, {
        purpose: "calendar-refresh",
        recordId: link.accountId,
      })
    ).toBe("refresh-second");
    // The sign-in itself never writes the lost-permission notice: the soldier is present.
    expect(
      (await db.select().from(records)).filter(
        (row) => row.data.title === permissionLostNotice.title
      )
    ).toEqual([]);
  });

  it("makes no link for a duty manager who signs in with Google", async () => {
    const result = await googleSignIn(profile("sub-manager", "manager"), {
      scopes: withCalendar,
      refreshToken: "refresh-manager",
    });
    expect(result.signedIn).toBe(true);
    expect(await linkOf(managerId)).toBeUndefined();
  });

  it("records nothing, and still signs in, when Google reports a grant for an uninvited person", async () => {
    const result = await googleSignIn(
      {
        sub: "sub-stranger",
        email: "stranger@example.invalid",
        email_verified: true,
      },
      { scopes: withCalendar, refreshToken: "refresh-stranger" }
    );
    expect(result.signedIn).toBe(false);
    expect(await db.select().from(calendarLink)).toEqual([]);
  });

  it("creates no calendar link or provider link for an unverified invited email", async () => {
    const result = await googleSignIn(
      { ...profile("sub-member", "member"), email_verified: false },
      {
        scopes: withCalendar,
        refreshToken: "refresh-unverified",
      }
    );
    expect(result.signedIn).toBe(false);
    expect(await linkOf(memberId)).toBeUndefined();
    expect(await googleRow(memberId)).toBeUndefined();
  });

  it("does not store a grant for a locked account, including an already linked Google identity", async () => {
    await googleSignIn(profile("sub-member", "member"));
    await db
      .update(user)
      .set({ lockedAt: new Date(), securityEpoch: 2 })
      .where(eq(user.id, memberId));
    const result = await googleSignIn(profile("sub-member", "member"), {
      scopes: withCalendar,
      refreshToken: "refresh-locked",
    });
    expect(result.signedIn).toBe(false);
    expect(await linkOf(memberId)).toBeUndefined();
    expect(await googleRow(memberId)).toMatchObject({
      accessToken: null,
      refreshToken: null,
      idToken: null,
    });
  });

  it.each(["lock", "epoch", "email", "deletion"] as const)(
    "refuses a callback whose proof loses authority before session creation: %s",
    async (change) => {
      await googleSignIn(profile("sub-member", "member"));
      const sessionHook = getAuth().options.databaseHooks!.session!.create!;
      const original = sessionHook.before!;
      const hook = vi
        .spyOn(sessionHook, "before")
        .mockImplementationOnce(async (...args) => {
          await db
            .update(user)
            .set({
              securityEpoch: 2,
              ...(change === "lock" && { lockedAt: new Date() }),
              ...(change === "email" && { email: "changed@example.invalid" }),
              ...(change === "deletion" && { deletedAt: new Date() }),
            })
            .where(eq(user.id, memberId));
          return original(...args);
        });
      try {
        const result = await googleSignIn(profile("sub-member", "member"), {
          scopes: withCalendar,
          refreshToken: "refresh-stale",
        });
        expect(result.signedIn).toBe(false);
        expect(await linkOf(memberId)).toBeUndefined();
      } finally {
        hook.mockRestore();
      }
    }
  );

  it("keeps simultaneous callbacks' tokens bound to their own identity", async () => {
    const otherId = await invite("other", "soldier", "5100003");
    const results = await Promise.all([
      googleSignIn(profile("sub-member", "member"), {
        scopes: withCalendar,
        refreshToken: "refresh-member",
      }),
      googleSignIn(profile("sub-other", "other"), {
        scopes: withCalendar,
        refreshToken: "refresh-other",
      }),
    ]);
    expect(results.map((value) => value.signedIn)).toEqual([true, true]);
    expect(
      openSecret((await linkOf(memberId)).refreshToken!, {
        purpose: "calendar-refresh",
        recordId: memberId,
      })
    ).toBe("refresh-member");
    expect(
      openSecret((await linkOf(otherId)).refreshToken!, {
        purpose: "calendar-refresh",
        recordId: otherId,
      })
    ).toBe("refresh-other");
  });

  it("does not reactivate an expired grant without a replacement refresh token", async () => {
    await googleSignIn(profile("sub-member", "member"), {
      scopes: withCalendar,
      refreshToken: "refresh-first",
    });
    await db
      .update(calendarLink)
      .set({ state: "needs_permission", refreshToken: null, enabled: false })
      .where(eq(calendarLink.accountId, memberId));
    const result = await googleSignIn(profile("sub-member", "member"), {
      scopes: withCalendar,
    });
    expect(result.signedIn).toBe(true);
    expect(await linkOf(memberId)).toMatchObject({
      state: "needs_permission",
      refreshToken: null,
      enabled: false,
    });
  });

  it.each(["cancelled", "expired"] as const)(
    "leaves an earlier grant and the off switch intact when consent is %s",
    async (failure) => {
      await googleSignIn(profile("sub-member", "member"), {
        scopes: withCalendar,
        refreshToken: "refresh-kept",
      });
      await db
        .update(calendarLink)
        .set({ enabled: false })
        .where(eq(calendarLink.accountId, memberId));
      const before = await linkOf(memberId);
      const result = await googleSignIn(profile("sub-member", "member"), {
        scopes: withCalendar,
        refreshToken: "refresh-never-stored",
        ...(failure === "cancelled"
          ? { error: "access_denied" }
          : { expiredCode: true }),
      });
      expect(result.signedIn).toBe(false);
      expect(await linkOf(memberId)).toMatchObject({
        refreshToken: before.refreshToken,
        enabled: false,
        version: before.version,
      });
    }
  );

  it("refuses an old epoch even if the account has been unlocked again", async () => {
    await db
      .update(user)
      .set({ securityEpoch: 3 })
      .where(eq(user.id, memberId));
    await recordGoogleGrant(memberId, {
      epoch: 1,
      scopes: withCalendar,
      refreshToken: "refresh-old-proof",
    });
    expect(await linkOf(memberId)).toBeUndefined();
  });

  it.each([
    "calendar_creation_pending",
    "calendar_creation_uncertain",
  ] as const)(
    "preserves an ambiguous calendar creation when consent renews: %s",
    async (errorCode) => {
      await googleSignIn(profile("sub-member", "member"), {
        scopes: withCalendar,
        refreshToken: "refresh-first",
      });
      await db
        .update(calendarLink)
        .set({
          errorCode,
          attempts: 3,
          leaseToken: "old-lease",
          leaseUntil: new Date(Date.now() + 60_000),
        })
        .where(eq(calendarLink.accountId, memberId));
      const before = await linkOf(memberId);
      const result = await googleSignIn(profile("sub-member", "member"), {
        scopes: withCalendar,
        refreshToken: "refresh-renewed",
      });
      expect(result.signedIn).toBe(true);
      expect(await linkOf(memberId)).toMatchObject({
        state: "active",
        errorCode,
        attempts: 3,
        leaseToken: null,
        leaseUntil: null,
        version: before.version + 1,
      });
      expect(
        openSecret((await linkOf(memberId)).refreshToken!, {
          purpose: "calendar-refresh",
          recordId: memberId,
        })
      ).toBe("refresh-renewed");
    }
  );

  it("handles a rejected cleanup promise without an unhandled rejection", async () => {
    const revocation = vi
      .spyOn(calendarGoogle, "revokeToken")
      .mockRejectedValueOnce(new Error("synthetic"));
    const warning = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await expect(
        scheduleCalendarCleanup({
          refreshToken: "synthetic",
          calendarId: null,
          eventIds: [],
        })
      ).resolves.toBeUndefined();
      await settleCalendarCleanups();
      expect(warning).toHaveBeenCalledWith(
        "Calendar token revocation incomplete"
      );
    } finally {
      revocation.mockRestore();
      warning.mockRestore();
    }
  });

  it("never logs provider exceptions that quote token material", async () => {
    const failure = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(
        new Error("provider quoted refresh-secret-and-client-secret")
      );
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      expect(
        (
          await googleSignIn(profile("sub-member", "member"), {
            scopes: withCalendar,
            refreshToken: "refresh-never-written",
          })
        ).signedIn
      ).toBe(false);
      expect(errors).toHaveBeenCalledWith("Authentication operation failed");
      expect(JSON.stringify(errors.mock.calls)).not.toContain(
        "refresh-secret-and-client-secret"
      );
      expect(await linkOf(memberId)).toBeUndefined();
    } finally {
      failure.mockRestore();
      errors.mockRestore();
    }
  });

  it("erases an unreadable token instead of rolling back account deletion", async () => {
    await db
      .insert(calendarLink)
      .values({ accountId: memberId, refreshToken: "damaged-ciphertext" });
    const warning = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const cleanup = await db.transaction((tx) =>
        purgeCalendarLink(tx, memberId, { collect: true })
      );
      expect(cleanup).toBeUndefined();
      expect(await linkOf(memberId)).toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        "Calendar cleanup token unavailable"
      );
    } finally {
      warning.mockRestore();
    }
  });
});
