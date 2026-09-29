import { describe, expect, it } from "vitest";
import {
  CODE_RESERVE,
  DAILY_QUOTA,
  DELIVERY_WINDOW_MS,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  classifyProviderStatus,
  closedOutcome,
  emailText,
  publicationVersion,
  quotaAllows,
  retryAt,
} from "../../src/domain/mail-delivery";

describe("mail delivery rules (decision 177)", () => {
  it("keeps the last ten messages of the 300 for sign-in and address codes", () => {
    expect(DAILY_QUOTA - CODE_RESERVE).toBe(290);
    expect(quotaAllows("duty-reminder", 289)).toBe(true);
    expect(quotaAllows("duty-reminder", 290)).toBe(false);
    expect(quotaAllows("invitation", 290)).toBe(false);
    expect(quotaAllows("login-code", 290)).toBe(true);
    expect(quotaAllows("email-change", 299)).toBe(true);
    expect(quotaAllows("login-code", 300)).toBe(false);
  });

  it("retries five times in total with growing delays inside 24 hours", () => {
    const now = new Date("2026-10-01T08:00:00Z");
    const waits = [1, 2, 3, 4].map(
      (attempts) => retryAt(attempts, now)!.getTime() - now.getTime()
    );
    expect(waits).toEqual(RETRY_DELAYS_MS);
    for (let index = 1; index < waits.length; index++)
      expect(waits[index]).toBeGreaterThan(waits[index - 1]);
    expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeLessThan(
      DELIVERY_WINDOW_MS
    );
    expect(retryAt(MAX_ATTEMPTS, now)).toBeNull();
  });

  it("classifies provider responses without keeping their text", () => {
    expect(classifyProviderStatus(400)).toBe("permanent");
    expect(classifyProviderStatus(404)).toBe("permanent");
    expect(classifyProviderStatus(401)).toBe("configuration");
    expect(classifyProviderStatus(403)).toBe("configuration");
    expect(classifyProviderStatus(402)).toBe("provider_quota");
    expect(classifyProviderStatus(429)).toBe("transient");
    expect(classifyProviderStatus(503)).toBe("transient");
  });

  it("fails a message that ran out of time for quota or delivery, and skips anything else", () => {
    expect(closedOutcome({ attempts: 0, error: "quota_waiting" })).toEqual({
      status: "failed",
      error: "quota_exhausted",
    });
    expect(closedOutcome({ attempts: 2, error: "delivery_failed" })).toEqual({
      status: "failed",
      error: "delivery_failed",
    });
    // After an outage an unsent reminder is skipped, not reported as a failure.
    expect(closedOutcome({ attempts: 0, error: null })).toEqual({
      status: "cancelled",
      error: "expired",
    });
  });

  it("adds a sign-in link to the short summary", () => {
    expect(
      emailText("שובצת לתורנות", "/duties/abc", "https://shifts.example.org")
    ).toBe(
      "שובצת לתורנות\n\nלפרטים באתר (נדרשת כניסה): https://shifts.example.org/duties/abc"
    );
    expect(emailText("קוד הכניסה שלך", null, "https://x.example.org")).toBe(
      "קוד הכניסה שלך"
    );
  });

  it("reads the duty and version from publication mail keys", () => {
    expect(publicationVersion("update:d1:4:acct")).toEqual({
      dutyId: "d1",
      version: 4,
    });
    expect(publicationVersion("cancel:d1:5:acct")).toEqual({
      dutyId: "d1",
      version: 5,
    });
    expect(publicationVersion("transfer:r1:offer:acct")).toBeNull();
  });
});
