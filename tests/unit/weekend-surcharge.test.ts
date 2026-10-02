import { describe, expect, it } from "vitest";
import { calculatePrice } from "../../src/domain/pricing";
import type { Pricing, TimeSurcharge } from "../../src/domain/types";

// Weekend surcharges: Friday and Saturday are judged one at a time, with no
// rounding of the parts (scenario 53). 2026-10-02 is a Friday.
const weekend = (
  points: string,
  threshold: TimeSurcharge["threshold"] = { kind: "any_overlap" },
  frequency: TimeSurcharge["frequency"] = "per_window"
): Pricing => ({
  mode: "daily",
  basePoints: "4",
  surcharges: [
    {
      id: "weekend",
      name: "סוף שבוע",
      points,
      // Equal endpoints are one whole local day; the weekdays are ISO (5 Friday, 6 Saturday).
      window: { startTime: "00:00", endTime: "00:00", weekdays: [5, 6] },
      threshold,
      frequency,
    },
  ],
});
const price = (pricing: Pricing, start: string, end: string) =>
  calculatePrice(pricing, start, end);
const surcharge = (result: ReturnType<typeof price>) => result.surcharges[0];

describe("weekend days", () => {
  it("counts Friday and Saturday as two windows, and adds their parts before one rounding", () => {
    const result = price(
      weekend("0.3"),
      "2026-10-02T08:00:00+03:00",
      "2026-10-04T08:00:00+03:00"
    );
    expect(surcharge(result)).toMatchObject({
      windows: ["2026-10-02", "2026-10-03"],
      count: 2,
      subtotal: "0.6",
    });
    // 48 hours at 4 a day is 8; 8 + 0.6 rounds once to 9, where 0.3 rounded twice would add nothing.
    expect(result.totalExact).toBe("8.6");
    expect(result.points).toBe(9);
  });
  it("counts a single weekend day once, and a weekday not at all", () => {
    expect(
      surcharge(
        price(
          weekend("2"),
          "2026-10-03T10:00:00+03:00",
          "2026-10-03T18:00:00+03:00"
        )
      )
    ).toMatchObject({ windows: ["2026-10-03"], count: 1 });
    expect(
      surcharge(
        price(
          weekend("2"),
          "2026-10-04T08:00:00+03:00",
          "2026-10-05T08:00:00+03:00"
        )
      )
    ).toMatchObject({ windows: [], count: 0, subtotal: "0" });
  });
  it("judges each day by its own hours against the minimum", () => {
    // Friday 08:00 to Saturday 08:00: 16 hours of Friday, 8 of Saturday.
    const duty = [
      "2026-10-02T08:00:00+03:00",
      "2026-10-03T08:00:00+03:00",
    ] as const;
    expect(
      surcharge(
        price(weekend("1", { kind: "minimum_hours", hours: "10" }), ...duty)
      )
    ).toMatchObject({
      windows: ["2026-10-02"],
      count: 1,
    });
    expect(
      surcharge(
        price(weekend("1", { kind: "minimum_hours", hours: "8" }), ...duty)
      )
    ).toMatchObject({
      windows: ["2026-10-02", "2026-10-03"],
      count: 2,
    });
    expect(
      surcharge(price(weekend("1", { kind: "any_overlap" }), ...duty)).count
    ).toBe(2);
  });
  it("gives a once-only surcharge a single count across both days", () => {
    const result = price(
      weekend("2", { kind: "any_overlap" }, "once"),
      "2026-10-02T08:00:00+03:00",
      "2026-10-04T08:00:00+03:00"
    );
    expect(surcharge(result)).toMatchObject({ count: 1, subtotal: "2" });
  });
  it("reaches into the weekend from a duty that starts the evening before", () => {
    // Thursday 20:00 to Friday 04:00 touches Friday for four hours.
    const duty = [
      "2026-10-01T20:00:00+03:00",
      "2026-10-02T04:00:00+03:00",
    ] as const;
    expect(surcharge(price(weekend("1"), ...duty)).windows).toEqual([
      "2026-10-02",
    ]);
    expect(
      surcharge(
        price(weekend("1", { kind: "minimum_hours", hours: "5" }), ...duty)
      ).windows
    ).toEqual([]);
  });
});
