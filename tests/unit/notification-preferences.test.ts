import { describe, expect, it } from "vitest";
import {
  emailAllowed,
  preferencesSchema,
  reminderHours,
  resolvePreferences,
  systemDefaults,
  type Preferences,
} from "../../src/domain/notification-preferences";
import {
  parseReminders,
  preferencesPayload,
  reminderRows,
  unreadCount,
} from "../../src/client/notifications";

const custom = (overrides: Partial<Preferences> = {}) => ({
  accountId: "a",
  custom: true,
  ...systemDefaults,
  ...overrides,
});
const both = (hours: number) => ({ hours, email: true, calendar: true });
const unit: Preferences = {
  reminders: [both(12)],
  email: { ...systemDefaults.email, publication: false },
};

describe("notification preferences", () => {
  it("uses a saved personal form as a whole and ignores later unit defaults", () => {
    const personal = custom({ reminders: [both(48)] });
    expect(resolvePreferences(personal, unit)).toEqual({
      source: "personal",
      preferences: { reminders: [both(48)], email: systemDefaults.email },
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
  it("validates type, timing, channels and frequency on the server", () => {
    const valid = {
      reminders: [
        { hours: 2, email: true, calendar: false },
        { hours: 24, email: false, calendar: true },
      ],
      email: systemDefaults.email,
    };
    // Closest last, and each reminder keeps its own channels.
    expect(preferencesSchema.parse(valid).reminders).toEqual([
      { hours: 24, email: false, calendar: true },
      { hours: 2, email: true, calendar: false },
    ]);
    expect(
      preferencesSchema.parse({ ...valid, reminders: [] }).reminders
    ).toEqual([]);
    for (const hours of [[0], [169], [1.5], [2, 2], [1, 2, 3, 4]])
      expect(
        preferencesSchema.safeParse({
          ...valid,
          reminders: hours.map(both),
        }).success
      ).toBe(false);
    for (const reminder of [
      { hours: 3, email: true },
      { hours: 3, calendar: true },
      { hours: 3, email: "yes", calendar: true },
      { hours: 3, email: true, calendar: true, site: false },
    ])
      expect(
        preferencesSchema.safeParse({ ...valid, reminders: [reminder] }).success
      ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...valid,
        email: { ...valid.email, loginCode: false },
      }).success
    ).toBe(false);
    // The switch of the duty reminder email moved into the slots of each reminder.
    expect(
      preferencesSchema.safeParse({
        ...valid,
        email: { ...valid.email, dutyReminder: true },
      }).success
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({ ...valid, accountId: "other" }).success
    ).toBe(false);
  });
  it("keeps a form saved before the transfer, departure, operations, deletion and restore types existed and starts them enabled", () => {
    const legacy = {
      custom: true,
      reminders: [{ hours: 12, email: false, calendar: true }],
      email: {
        roundOpening: true,
        roundClosing: true,
        publication: false,
      },
    };
    expect(resolvePreferences(legacy, undefined)).toEqual({
      preferences: {
        reminders: legacy.reminders,
        email: {
          ...legacy.email,
          transfer: true,
          departure: true,
          operations: true,
          deletion: true,
          restore: true,
        },
      },
      source: "personal",
    });
    const { custom: _custom, ...unitLegacy } = legacy;
    void _custom;
    expect(
      resolvePreferences(undefined, unitLegacy).preferences.email
    ).toMatchObject({ publication: false, transfer: true });
    expect(
      resolvePreferences(
        { ...legacy, email: { ...legacy.email, transfer: false } },
        undefined
      ).preferences.email.transfer
    ).toBe(false);
  });
  it("converts a form saved with plain hours and one reminder email switch (decision 195)", () => {
    const email = {
      roundOpening: true,
      roundClosing: true,
      publication: true,
      transfer: true,
      departure: true,
    };
    // A switch that was off becomes an unmarked email slot in every reminder; the calendar is marked in all.
    expect(
      resolvePreferences(
        {
          custom: true,
          reminderHours: [2, 24],
          email: { ...email, dutyReminder: false },
        },
        undefined
      ).preferences.reminders
    ).toEqual([
      { hours: 24, email: false, calendar: true },
      { hours: 2, email: false, calendar: true },
    ]);
    // A switch that was on marks the email slot of every reminder.
    expect(
      resolvePreferences(
        {
          custom: true,
          reminderHours: [6],
          email: { ...email, dutyReminder: true },
        },
        undefined
      ).preferences.reminders
    ).toEqual([{ hours: 6, email: true, calendar: true }]);
    // The unit defaults convert the same way, and the stored switch is not kept as an email type.
    const converted = resolvePreferences(undefined, {
      reminderHours: [12],
      email: { ...email, dutyReminder: false },
    });
    expect(converted.source).toBe("unit");
    expect(converted.preferences.reminders).toEqual([
      { hours: 12, email: false, calendar: true },
    ]);
    expect(converted.preferences.email).not.toHaveProperty("dutyReminder");
    // No reminders stays no reminders.
    expect(
      resolvePreferences(
        {
          custom: true,
          reminderHours: [],
          email: { ...email, dutyReminder: true },
        },
        undefined
      ).preferences.reminders
    ).toEqual([]);
    expect(reminderHours(systemDefaults)).toEqual([24, 2]);
  });
  it("never withholds security email and checks each business type and reminder time", () => {
    const off: Preferences = {
      reminders: [{ hours: 2, email: false, calendar: false }],
      email: {
        roundOpening: false,
        roundClosing: false,
        publication: false,
        transfer: false,
        departure: false,
        operations: false,
        deletion: false,
        restore: false,
      },
    };
    for (const kind of ["login-code", "invitation", "email-change"] as const)
      expect(emailAllowed(off, kind)).toBe(true);
    for (const kind of [
      "publication",
      "publication-change",
      "round-opening",
      "round-closing",
      "transfer",
      "departure",
      "deletion",
      "restore",
      "backup-alert",
    ] as const) {
      expect(emailAllowed(off, kind)).toBe(false);
      expect(emailAllowed(systemDefaults, kind)).toBe(true);
    }
    expect(emailAllowed(systemDefaults, "duty-reminder", 24)).toBe(true);
    expect(emailAllowed(systemDefaults, "duty-reminder", 12)).toBe(false);
    expect(emailAllowed(systemDefaults, "duty-reminder")).toBe(false);
    expect(emailAllowed(off, "duty-reminder", 2)).toBe(false);
    // The email slot is per reminder: the calendar slot never sends mail.
    const mixed: Preferences = {
      ...systemDefaults,
      reminders: [
        { hours: 24, email: false, calendar: true },
        { hours: 2, email: true, calendar: false },
      ],
    };
    expect(emailAllowed(mixed, "duty-reminder", 24)).toBe(false);
    expect(emailAllowed(mixed, "duty-reminder", 2)).toBe(true);
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
  it("shows the stored reminders as rows and pads the unused ones", () => {
    expect(reminderRows(systemDefaults.reminders)).toEqual([
      { hours: 24, email: true, calendar: true },
      { hours: 2, email: true, calendar: true },
      { hours: "", email: true, calendar: true },
    ]);
    expect(reminderRows(undefined)).toHaveLength(3);
  });
  it("explains invalid reminder hours before sending the form", () => {
    const row = (hours: unknown, email = true, calendar = true) => ({
      "reminder.0.hours": hours,
      "reminder.0.email": email,
      "reminder.0.calendar": calendar,
    });
    expect(parseReminders(row(24, true, false))).toEqual({
      reminders: [{ hours: 24, email: true, calendar: false }],
    });
    // A row without hours is not a reminder.
    expect(parseReminders({ ...row(""), "reminder.1.hours": " " })).toEqual({
      reminders: [],
    });
    for (const hours of [0, 2.5, "abc", 200])
      expect(parseReminders(row(hours))).toEqual({
        error: "שעות התזכורת הן מספרים שלמים בין 1 ל־168.",
      });
    expect(parseReminders({ ...row(2), "reminder.1.hours": 2 })).toEqual({
      error: "אין לחזור על אותה שעת תזכורת.",
    });
    // Without the calendar column a reminder keeps the slot stored for the same hours.
    expect(
      parseReminders(
        row(24, true, false),
        [{ hours: 24, email: true, calendar: false }],
        false
      )
    ).toEqual({ reminders: [{ hours: 24, email: true, calendar: false }] });
    expect(parseReminders(row(6, true, false), [], false)).toEqual({
      reminders: [{ hours: 6, email: true, calendar: true }],
    });
    expect(
      preferencesPayload({
        ...row(6, false, true),
        "email.publication": false,
      })
    ).toEqual({
      reminders: [{ hours: 6, email: false, calendar: true }],
      email: {
        roundOpening: false,
        roundClosing: false,
        publication: false,
        transfer: false,
        departure: false,
        operations: false,
        deletion: false,
        restore: false,
      },
    });
    // A type the form does not show keeps its stored value.
    expect(
      preferencesPayload({ "email.departure": false }, ["departure"], {
        email: { departure: true },
      }).email.departure
    ).toBe(true);
    expect(
      preferencesPayload({}, ["departure"], { email: { departure: false } })
        .email.departure
    ).toBe(false);
  });
});
