import { describe, expect, it } from "vitest";
import { effectiveDiffers } from "../../src/domain/time";

describe("effective time against recording time", () => {
  it("compares a date with the Israel calendar day of the recording", () => {
    // 22:30 UTC on 30.09 is already 01.10 in Israel (UTC+3).
    expect(effectiveDiffers("2026-10-01", "2026-09-30T22:30:00.000Z")).toBe(
      false
    );
    expect(effectiveDiffers("2026-09-30", "2026-09-30T22:30:00.000Z")).toBe(
      true
    );
    // After the return to winter time (UTC+2) the day boundary moves.
    expect(effectiveDiffers("2026-11-01", "2026-10-31T22:30:00.000Z")).toBe(
      false
    );
    expect(effectiveDiffers("2026-11-01", "2026-10-31T21:30:00.000Z")).toBe(
      true
    );
  });
  it("treats moments less than a minute apart as the same time", () => {
    expect(
      effectiveDiffers("2026-09-29T10:00:30+03:00", "2026-09-29T07:00:00.000Z")
    ).toBe(false);
    expect(
      effectiveDiffers("2026-09-29T09:00:00+03:00", "2026-09-29T07:00:00.000Z")
    ).toBe(true);
    expect(effectiveDiffers("", "2026-09-29T07:00:00.000Z")).toBe(false);
  });
});
