import { describe, expect, it } from "vitest";
import {
  emailAllowed,
  preferencesSchema,
  resolvePreferences,
  systemDefaults,
  type Preferences,
} from "../../src/domain/notification-preferences";
import {
  parseReminderHours,
  preferencesPayload,
  unreadCount,
} from "../../src/client/notifications";

const custom = (overrides: Partial<Preferences> = {}) => ({
  accountId: "a",
  custom: true,
  ...systemDefaults,
  ...overrides,
});
const unit: Preferences = {
  reminderHours: [12],
  email: { ...systemDefaults.email, publication: false },
};

describe("notification preferences", () => {
  it("uses a saved personal form as a whole and ignores later unit defaults", () => {
    const personal = custom({ reminderHours: [48] });
    expect(resolvePreferences(personal, unit)).toEqual({
      source: "personal",
      preferences: { reminderHours: [48], email: systemDefaults.email },
    });
  });
  it("applies the unit defaults to an account without, or returned from, personal preferences", () => {
    expect(resolvePreferences(undefined, unit)).toEqual({
      source: "unit",
      preferences: unit,
    });
    expect(
      resolvePreferences({ accountId: "a", custom: false }, unit).source
    ).toBe("unit");
    expect(resolvePreferences(undefined, undefined)).toEqual({
      source: "system",
      preferences: systemDefaults,
    });
  });
  it("validates type, timing and frequency on the server", () => {
    const valid = { reminderHours: [2, 24], email: systemDefaults.email };
    expect(preferencesSchema.parse(valid).reminderHours).toEqual([24, 2]);
    expect(
      preferencesSchema.parse({ ...valid, reminderHours: [] }).reminderHours
    ).toEqual([]);
    for (const reminderHours of [[0], [169], [1.5], [2, 2], [1, 2, 3, 4]])
      expect(
        preferencesSchema.safeParse({ ...valid, reminderHours }).success
      ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...valid,
        email: { ...valid.email, loginCode: false },
      }).success
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({ ...valid, accountId: "other" }).success
    ).toBe(false);
  });
  it("never withholds security email and checks each business type and reminder time", () => {
    const off: Preferences = {
      reminderHours: [2],
      email: {
        dutyReminder: false,
        roundOpening: false,
        roundClosing: false,
        publication: false,
      },
    };
    for (const kind of ["login-code", "invitation", "email-change"] as const)
      expect(emailAllowed(off, kind)).toBe(true);
    for (const kind of [
      "publication",
      "publication-change",
      "round-opening",
      "round-closing",
    ] as const) {
      expect(emailAllowed(off, kind)).toBe(false);
      expect(emailAllowed(systemDefaults, kind)).toBe(true);
    }
    expect(emailAllowed(systemDefaults, "duty-reminder", 24)).toBe(true);
    expect(emailAllowed(systemDefaults, "duty-reminder", 12)).toBe(false);
    expect(emailAllowed(systemDefaults, "duty-reminder")).toBe(false);
    expect(emailAllowed(off, "duty-reminder", 2)).toBe(false);
  });
});

describe("notification inbox helpers", () => {
  it("counts only unread copies that were not hidden", () => {
    expect(
      unreadCount([
        { id: "1" },
        { id: "2", readAt: "2026-09-29T10:00:00Z" },
        { id: "3", hiddenAt: "2026-09-29T10:00:00Z" },
      ])
    ).toBe(1);
  });
  it("explains invalid reminder hours before sending the form", () => {
    expect(parseReminderHours(" 24 , 2 ")).toEqual({ hours: [24, 2] });
    expect(parseReminderHours("")).toEqual({ hours: [] });
    for (const text of ["0", "2.5", "abc", "200", "2, 2", "1,2,3,4"])
      expect(parseReminderHours(text)).toHaveProperty("error");
    expect(
      preferencesPayload({
        reminderHours: "6",
        "email.dutyReminder": true,
        "email.publication": false,
      })
    ).toEqual({
      reminderHours: [6],
      email: {
        dutyReminder: true,
        roundOpening: false,
        roundClosing: false,
        publication: false,
      },
    });
  });
});
