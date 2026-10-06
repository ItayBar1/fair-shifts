import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import { account, user } from "../../src/server/auth-schema";
import { calendarEvent, calendarLink, soldiers } from "../../src/server/schema";
import {
  applyVerifiedEmailChange,
  createInvitedAccount,
  deleteAccountAuth,
} from "../../src/server/auth/accounts";
import {
  recordGoogleGrant,
  scheduleCalendarCleanup,
  settleCalendarCleanups,
  type CalendarCleanup,
} from "../../src/server/calendar/link";
import { recoverCalendarCreation } from "../../src/server/calendar/recovery";
import {
  createCalendar,
  refreshAccessToken,
} from "../../src/server/calendar/google";
import {
  CALENDAR_NAME,
  CALENDAR_SCOPE,
  CALENDAR_ZONE,
} from "../../src/domain/calendar-sync";
import { soldier } from "../fixtures";
import { FakeGoogle } from "../google-fake";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

const google = new FakeGoogle();
let accountId: string;
let token: string;
const link = async () =>
  (
    await db
      .select()
      .from(calendarLink)
      .where(eq(calendarLink.accountId, accountId))
  )[0];
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  process.env.GOOGLE_CALENDAR_SYNC = "true";
  delete process.env.RESTORE_MODE;
  google.reset();
  google.install();
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name: "חייל סינתטי",
    personalNumber: "00921",
    data: soldier({ id }),
  });
  const invited = await createInvitedAccount({
    name: "חייל סינתטי",
    email: "calendar-lifecycle@example.invalid",
    soldierId: id,
  });
  accountId = invited.id;
  await db.insert(account).values({
    id: randomUUID(),
    providerId: "google",
    accountId: "synthetic-calendar-subject",
    userId: accountId,
  });
  token = `synthetic-refresh-${randomUUID()}`;
  google.grant(token);
  await recordGoogleGrant(accountId, {
    refreshToken: token,
    scopes: [CALENDAR_SCOPE],
  });
});
afterEach(async () => {
  await settleCalendarCleanups();
  vi.unstubAllGlobals();
});
afterAll(async () => pool.end());

async function paused() {
  await db
    .update(calendarLink)
    .set({ errorCode: "calendar_creation_uncertain", calendarId: null })
    .where(eq(calendarLink.accountId, accountId));
}
const reason = "Verified the synthetic calendar after an uncertain response";
const remoteCalendar = async (name = CALENDAR_NAME, zone = CALENDAR_ZONE) =>
  createCalendar(await refreshAccessToken(token), name, zone);

describe("Calendar grant lifecycle and server recovery", () => {
  it("email replacement erases the old grant and pending events before post-commit cleanup", async () => {
    const calendarId = await remoteCalendar();
    await db
      .update(calendarLink)
      .set({ calendarId })
      .where(eq(calendarLink.accountId, accountId));
    await db.insert(calendarEvent).values({
      id: randomUUID(),
      accountId,
      dutyId: randomUUID(),
      googleEventId: "pending-event",
      status: "pending",
      fingerprint: "old",
      startsAt: new Date(Date.now() + 3600000),
      endsAt: new Date(Date.now() + 7200000),
    });
    const cleanups: CalendarCleanup[] = [];
    await unitTransaction((tx) =>
      applyVerifiedEmailChange(
        tx,
        accountId,
        "replacement@example.invalid",
        cleanups
      )
    );
    expect(await link()).toBeUndefined();
    expect(await db.select().from(calendarEvent)).toEqual([]);
    expect(await db.select().from(account)).toEqual([]);
    expect(cleanups).toMatchObject([{ eventIds: ["pending-event"] }]);
    expect(google.revoked).toEqual([]);
    await scheduleCalendarCleanup(cleanups[0]);
    expect(google.revoked).toEqual([token]);
  });

  it("direct account erasure also purges Calendar rows without making a provider call", async () => {
    google.calls.length = 0;
    await deleteAccountAuth(accountId);
    expect(await link()).toBeUndefined();
    expect(google.calls).toEqual([]);
  });

  it("adopts the verified app-created calendar after a lost create response without creating a second calendar", async () => {
    const calendarId = await remoteCalendar();
    await paused();
    const version = (await link()).version;
    google.calls.length = 0;
    await recoverCalendarCreation({
      mode: "adopt",
      accountId,
      calendarId,
      reason,
    });
    expect(await link()).toMatchObject({
      calendarId,
      errorCode: null,
      version: version + 1,
    });
    expect(google.calls.map((call) => call.kind)).toEqual([
      "refresh",
      "getCalendar",
    ]);
    expect(google.calendars.size).toBe(1);
  });

  it("refuses a missing or unrelated calendar and keeps the uncertainty marker", async () => {
    await paused();
    await expect(
      recoverCalendarCreation({
        mode: "adopt",
        accountId,
        calendarId: "missing",
        reason,
      })
    ).rejects.toMatchObject({ code: "calendar_not_verified" });
    const unrelated = await remoteCalendar("Private calendar", "UTC");
    await expect(
      recoverCalendarCreation({
        mode: "adopt",
        accountId,
        calendarId: unrelated,
        reason,
      })
    ).rejects.toMatchObject({ code: "calendar_not_verified" });
    expect(await link()).toMatchObject({
      calendarId: null,
      errorCode: "calendar_creation_uncertain",
    });
  });

  it("requires the explicit operator acknowledgement before retrying an uncertain creation", async () => {
    await paused();
    google.calls.length = 0;
    await expect(
      recoverCalendarCreation({
        mode: "retry",
        accountId,
        reason,
        acknowledgement: "retry",
      })
    ).rejects.toThrow();
    expect((await link()).errorCode).toBe("calendar_creation_uncertain");
    await recoverCalendarCreation({
      mode: "retry",
      accountId,
      reason,
      acknowledgement: "no calendar was created",
    });
    expect((await link()).errorCode).toBeNull();
    expect(google.calls).toEqual([]);
  });

  it("does not apply an old recovery after a new grant arrives during provider verification", async () => {
    const calendarId = await remoteCalendar();
    await paused();
    google.onCall = async (call) => {
      if (call.kind === "getCalendar") {
        google.onCall = undefined;
        const replacement = `replacement-${randomUUID()}`;
        google.grant(replacement);
        await recordGoogleGrant(accountId, {
          refreshToken: replacement,
          scopes: [CALENDAR_SCOPE],
        });
      }
    };
    await expect(
      recoverCalendarCreation({ mode: "adopt", accountId, calendarId, reason })
    ).rejects.toMatchObject({ code: "stale_calendar_recovery" });
    expect((await link()).calendarId).toBeNull();
  });

  it("refuses recovery while the account is locked or a worker owns a live lease", async () => {
    await paused();
    await db
      .update(user)
      .set({ lockedAt: new Date() })
      .where(eq(user.id, accountId));
    await expect(
      recoverCalendarCreation({
        mode: "retry",
        accountId,
        reason,
        acknowledgement: "no calendar was created",
      })
    ).rejects.toMatchObject({ code: "calendar_account_unavailable" });
    await db.update(user).set({ lockedAt: null }).where(eq(user.id, accountId));
    await db
      .update(calendarLink)
      .set({
        leaseUntil: new Date(Date.now() + 60000),
        leaseToken: randomUUID(),
      })
      .where(eq(calendarLink.accountId, accountId));
    await expect(
      recoverCalendarCreation({
        mode: "retry",
        accountId,
        reason,
        acknowledgement: "no calendar was created",
      })
    ).rejects.toMatchObject({ code: "calendar_busy" });
  });
});
