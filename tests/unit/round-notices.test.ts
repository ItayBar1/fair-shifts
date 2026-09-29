import { describe, expect, it } from "vitest";
import {
  acceptsSubmissions,
  closingReminderAt,
  parseRoundEventKey,
  roundEventKey,
  roundNoticeText,
  servesDuringRound,
  windowStart,
} from "../../src/domain/round-notices";
import { roundNoticeSummary } from "../../src/client/constraints";

const roundId = "3f1c2b8e-2a4d-4c6e-9f00-0123456789ab";
const at = (value: string) => Date.parse(value);

describe("constraint round notices", () => {
  it("reminds one Israeli calendar day before closing, across DST changes", () => {
    expect(
      closingReminderAt({
        opensAt: "2026-11-01T08:00:00+02:00",
        closesAt: "2026-11-10T20:00:00+02:00",
      })
    ).toBe(at("2026-11-09T20:00:00+02:00"));
    // Winter time starts on 25.10.2026: the day before closing is 25 hours long.
    expect(
      closingReminderAt({
        opensAt: "2026-10-20T08:00:00+03:00",
        closesAt: "2026-10-25T10:00:00+02:00",
      })
    ).toBe(at("2026-10-24T10:00:00+03:00"));
    // Summer time starts on 26.03.2027: the day before closing is 23 hours long.
    expect(
      closingReminderAt({
        opensAt: "2027-03-20T08:00:00+02:00",
        closesAt: "2027-03-26T10:00:00+03:00",
      })
    ).toBe(at("2027-03-25T10:00:00+02:00"));
  });

  it("sends no closing reminder when the window is shorter than a day", () => {
    const closesAt = "2026-11-10T20:00:00+02:00";
    expect(
      closingReminderAt({ opensAt: "2026-11-09T21:00:00+02:00", closesAt })
    ).toBeNull();
    expect(
      closingReminderAt({ opensAt: "2026-11-09T20:00:00+02:00", closesAt })
    ).toBe(at("2026-11-09T20:00:00+02:00"));
    // A reopening starts a new window, measured from the reopening itself.
    const reopened = {
      opensAt: "2026-11-01T08:00:00+02:00",
      reopenedAt: "2026-11-10T01:00:00+02:00",
      closesAt,
    };
    expect(windowStart(reopened)).toBe(at(reopened.reopenedAt));
    expect(closingReminderAt(reopened)).toBeNull();
  });

  it("accepts notices only while the window is open", () => {
    const round = {
      status: "open",
      opensAt: "2026-11-01T08:00:00+02:00",
      closesAt: "2026-11-10T20:00:00+02:00",
    };
    expect(acceptsSubmissions(round, at("2026-11-01T07:59:00+02:00"))).toBe(
      false
    );
    expect(acceptsSubmissions(round, at("2026-11-01T08:00:00+02:00"))).toBe(
      true
    );
    expect(acceptsSubmissions(round, at("2026-11-10T20:00:00+02:00"))).toBe(
      false
    );
    expect(
      acceptsSubmissions(
        { ...round, status: "closed" },
        at("2026-11-05T08:00:00+02:00")
      )
    ).toBe(false);
  });

  it("includes soldiers whose service overlaps the target period", () => {
    const target = { targetStart: "2026-11-15", targetEnd: "2026-11-30" };
    expect(servesDuringRound({}, target)).toBe(true);
    expect(servesDuringRound({ releaseDate: "2026-11-15" }, target)).toBe(true);
    expect(servesDuringRound({ releaseDate: "2026-11-14" }, target)).toBe(
      false
    );
    expect(servesDuringRound({ arrivalDate: "2026-11-30" }, target)).toBe(true);
    expect(servesDuringRound({ arrivalDate: "2026-12-01" }, target)).toBe(
      false
    );
  });

  it("round-trips event keys and rejects foreign ones", () => {
    const key = roundEventKey(roundId, 2, "closing", "account-1");
    expect(parseRoundEventKey(key)).toEqual({
      roundId,
      generation: 2,
      notice: "closing",
      accountId: "account-1",
    });
    expect(parseRoundEventKey(`publish:${roundId}:1:account-1`)).toBeNull();
    expect(parseRoundEventKey(`round:${roundId}:1:other:account-1`)).toBeNull();
  });

  it("writes the deadline in Israel time without personal details", () => {
    const text = roundNoticeText("closing", {
      name: "סבב נובמבר",
      closesAt: "2026-10-25T08:00:00Z",
    });
    expect(text.body).toContain("25.10.2026 10:00");
    expect(text.body).toContain("״סבב נובמבר״");
    expect(
      roundNoticeText("opening", { closesAt: "2026-10-25T08:00:00Z" }).body
    ).not.toContain("undefined");
  });

  it("summarizes the current generation for managers", () => {
    const round = {
      id: roundId,
      status: "open",
      opensAt: "2026-11-01T08:00:00+02:00",
      closesAt: "2026-11-10T20:00:00+02:00",
      reopenCount: 1,
      reopenedAt: "2026-11-02T08:00:00+02:00",
      reopenKind: "extension",
    };
    const notices = [
      {
        id: "n0",
        roundId,
        generation: 0,
        phase: "start",
        notice: "opening",
        status: "sent",
        recipients: 5,
      },
      {
        id: "n1",
        roundId,
        generation: 1,
        phase: "start",
        notice: "extension",
        status: "sent",
        recipients: 3,
      },
    ];
    const now = at("2026-11-03T08:00:00+02:00");
    const lines = roundNoticeSummary(round, notices, now);
    expect(lines[0]).toBe("הודעת עדכון מועד נשלחה ל־3");
    expect(lines[1]).toContain("תזכורת סגירה למי שטרם הגיש ב־");
    expect(lines[1]).toContain("09.11.2026");
    expect(
      roundNoticeSummary(
        { ...round, reopenedAt: "2026-11-10T01:00:00+02:00" },
        [],
        at("2026-11-10T02:00:00+02:00")
      )
    ).toContain("ללא תזכורת סגירה: חלון ההגשה קצר מיום");
    expect(
      roundNoticeSummary(
        round,
        [
          {
            ...notices[1],
            id: "n2",
            status: "merged",
            recipients: 0,
          },
          {
            id: "n3",
            roundId,
            generation: 1,
            phase: "closing",
            notice: "closing",
            status: "sent",
            recipients: 2,
          },
        ],
        now
      )
    ).toEqual([
      "הודעת עדכון מועד צורפה לתזכורת הסגירה",
      "תזכורת סגירה נשלחה ל־2 שטרם הגישו",
    ]);
  });
});
