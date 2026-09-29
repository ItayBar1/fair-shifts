import Decimal from "decimal.js";
import { dailyWindows, interval } from "./time";
import type { InstantRange, PriceBreakdown, Pricing } from "./types";

const Exact = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

function nonnegative(value: string): Decimal {
  const parsed = new Exact(value);
  if (!parsed.isFinite() || parsed.isNegative())
    throw new Error("ניקוד חייב להיות מספר חיובי או אפס");
  return parsed;
}

export function roundPoints(value: Decimal.Value): number {
  const result = new Exact(value)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  if (!Number.isSafeInteger(result))
    throw new Error("ערך הניקוד חורג מהטווח הנתמך");
  return result;
}

export function calculatePrice(
  pricing: Pricing,
  start: string,
  end: string,
  extraPoints = "0"
): PriceBreakdown {
  return calculatePerformedPrice(pricing, [{ start, end }], extraPoints);
}

/** Periods for one performer are combined before thresholds and rounding are applied. */
export function calculatePerformedPrice(
  pricing: Pricing,
  periods: InstantRange[],
  extraPoints = "0",
  fixedBaseAllocation?: string
): PriceBreakdown {
  if (!periods.length) throw new Error("נדרשת תקופת ביצוע");
  const ranges = periods.map(interval).sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index]!.start < ranges[index - 1]!.end)
      throw new Error("תקופות ביצוע חופפות");
  }
  const milliseconds = ranges.reduce(
    (sum, range) => sum.plus(range.end - range.start),
    new Exact(0)
  );
  const rate = nonnegative(pricing.basePoints);
  const base =
    pricing.mode === "daily"
      ? rate.times(milliseconds).dividedBy(86_400_000)
      : nonnegative(fixedBaseAllocation ?? pricing.basePoints);
  const extras = nonnegative(extraPoints);
  const surcharges = pricing.surcharges.map((surcharge) => {
    const windows = new Map<string, { start: number; end: number }>();
    for (const period of periods) {
      for (const window of dailyWindows(period, surcharge.window, true))
        windows.set(window.date, window);
    }
    const matching: string[] = [];
    for (const [date, window] of windows) {
      const overlap = ranges.reduce(
        (sum, range) =>
          sum.plus(
            Math.max(
              0,
              Math.min(window.end, range.end) -
                Math.max(window.start, range.start)
            )
          ),
        new Exact(0)
      );
      const qualifies =
        surcharge.threshold.kind === "any_overlap"
          ? overlap.gt(0)
          : overlap.gt(0) &&
            overlap.gte(
              nonnegative(surcharge.threshold.hours).times(3_600_000)
            );
      if (qualifies) matching.push(date);
    }
    matching.sort();
    const count =
      surcharge.frequency === "once"
        ? Math.min(1, matching.length)
        : matching.length;
    return {
      id: surcharge.id,
      windows: matching,
      count,
      subtotal: nonnegative(surcharge.points).times(count).toString(),
    };
  });
  const total = surcharges.reduce(
    (sum, item) => sum.plus(item.subtotal),
    base.plus(extras)
  );
  return {
    base: base.toString(),
    extras: extras.toString(),
    surcharges,
    totalExact: total.toString(),
    points: roundPoints(total),
  };
}

export interface PerformedAllocation {
  soldierId: string;
  periods: InstantRange[];
  fixedBase?: string;
  fixedExtra: string;
}

/** Fixed extras are apportioned once by a manager; time extras follow each actual execution. */
export function priceSplitExecution(
  pricing: Pricing,
  dutyPeriod: InstantRange,
  allocations: PerformedAllocation[],
  fixedExtraTotal = "0"
): { soldierId: string; price: PriceBreakdown }[] {
  const duty = interval(dutyPeriod);
  const all = allocations
    .flatMap((allocation) => allocation.periods.map(interval))
    .sort((a, b) => a.start - b.start);
  for (let index = 0; index < all.length; index++) {
    const period = all[index]!;
    if (period.start < duty.start || period.end > duty.end)
      throw new Error("הביצוע חורג ממועדי התורנות");
    if (index > 0 && period.start < all[index - 1]!.end)
      throw new Error("תקופות המבצעים חופפות");
  }
  if (
    !allocations.length ||
    allocations.some((allocation) => !allocation.periods.length)
  )
    throw new Error("לכל מבצע נדרשת תקופה");
  if (
    new Set(allocations.map((allocation) => allocation.soldierId)).size !==
    allocations.length
  )
    throw new Error("יש לאחד תקופות של אותו מבצע");
  const extraSum = allocations.reduce(
    (sum, allocation) => sum.plus(nonnegative(allocation.fixedExtra)),
    new Exact(0)
  );
  if (!extraSum.eq(nonnegative(fixedExtraTotal)))
    throw new Error("חלוקת התוספת הקבועה חייבת להשתוות לתוספת המקורית");
  if (pricing.mode === "fixed") {
    if (allocations.some((allocation) => allocation.fixedBase === undefined))
      throw new Error("נדרשת חלוקה מפורשת של הבסיס הקבוע");
    const baseSum = allocations.reduce(
      (sum, allocation) => sum.plus(nonnegative(allocation.fixedBase!)),
      new Exact(0)
    );
    if (!baseSum.eq(nonnegative(pricing.basePoints)))
      throw new Error("חלוקת הבסיס חייבת להשתוות לבסיס המקורי");
  }
  return allocations.map((allocation) => ({
    soldierId: allocation.soldierId,
    price: calculatePerformedPrice(
      pricing,
      allocation.periods,
      allocation.fixedExtra,
      allocation.fixedBase
    ),
  }));
}
