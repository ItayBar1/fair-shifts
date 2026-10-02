import { describe, expect, it } from "vitest";
import { drawCandidate } from "../../src/domain/scheduling";
import { duty, soldier } from "../fixtures";
import type { EligibilityContext } from "../../src/domain/types";

// The draw with a controlled random source (stories 27 and 28, scenarios 12 and
// 40). The tests choose the number the source returns; none is statistical.
const context: EligibilityContext = {
  duties: [],
  assignments: [],
  mode: "automatic",
};
const target = duty();
// Value 4: the minimum is 10, so the band is below 14 — a, c and d.
const unit = () => [
  soldier({ id: "e", currentScore: 15 }),
  soldier({ id: "d", currentScore: 10 }),
  soldier({ id: "b", currentScore: 14 }),
  soldier({ id: "c", currentScore: 11 }),
  soldier({ id: "a", currentScore: 10 }),
];
const draw = (random: (size: number) => number, people = unit(), weight = 4) =>
  drawCandidate(people, target, target.slots[0], weight, context, random);
const picked = (result: ReturnType<typeof draw>) =>
  "selected" in result ? result.selected?.soldier.id : undefined;

describe("the draw inside the band", () => {
  it("gives every member of the band an equal share of the random range", () => {
    const results = [0, 0.32, 0.34, 0.65, 0.67, 0.99].map((value) =>
      picked(draw(() => value))
    );
    expect(results).toEqual(["a", "a", "c", "c", "d", "d"]);
  });
  it("asks the source once, with the size of the band", () => {
    const asked: number[] = [];
    draw((size) => {
      asked.push(size);
      return 0.5;
    });
    expect(asked).toEqual([3]);
  });
  it("keeps the band in id order whatever the order or the scores of the input", () => {
    const shuffled = unit().reverse();
    const first = draw(() => 0.5, shuffled);
    expect("band" in first && first.band).toEqual(["a", "c", "d"]);
    expect(picked(first)).toBe(picked(draw(() => 0.5)));
  });
  it("never reaches a member above the band, even with the highest value", () => {
    const high = draw(() => 0.999999);
    expect(picked(high)).toBe("d");
    expect("band" in high && high.band).not.toContain("b");
  });
  it("rejects a source that leaves the range from 0 up to, not including, 1", () => {
    for (const value of [1, -0.01, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => draw(() => value)).toThrow("[0,1)");
  });
  it("does not use the source when there is nobody to draw", () => {
    const forbidden = () => {
      throw new Error("the random source must not be used");
    };
    expect(draw(forbidden, unit(), 0).status).toBe("manual_only");
    expect(
      draw(forbidden, [soldier({ id: "gone", deletedAt: target.start })]).status
    ).toBe("unfilled");
  });
});
