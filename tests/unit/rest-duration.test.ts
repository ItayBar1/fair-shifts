import { describe, expect, it } from "vitest";
import {
  describeRest,
  readRestHours,
  restHoursInput,
} from "../../src/client/rest-duration";

// Rest windows are entered in hours and stored in minutes (decision 231).
describe("rest windows in hours", () => {
  it("reads whole hours, hours and minutes, and decimal hours", () => {
    for (const [text, minutes] of [
      ["12", 720],
      ["0:30", 30],
      ["1:05", 65],
      ["12:00", 720],
      ["1.5", 90],
      ["1,5", 90],
      ["0.25", 15],
      [" 8 ", 480],
      ["36", 2160],
      ["0", 0],
      ["0:00", 0],
      ["", 0],
    ] as const)
      expect(readRestHours(text, "מנוחה לפני")).toEqual({ minutes });
  });

  it("rejects text that is not hours, and hours that are not whole minutes", () => {
    for (const text of ["abc", "-1", "1:60", "1:5", ":30", "12:", "720 דקות"])
      expect(readRestHours(text, "מנוחה לפני").error).toMatch(
        /^מנוחה לפני: יש להזין שעות/
      );
    expect(readRestHours("0.33", "מנוחה אחרי").error).toMatch(
      /^מנוחה אחרי: השעות חייבות להתחלק לדקות שלמות/
    );
  });

  it("shows stored minutes in the field as hours that read back the same", () => {
    for (const [minutes, text] of [
      [0, "0:00"],
      [30, "0:30"],
      [90, "1:30"],
      [720, "12:00"],
      [2165, "36:05"],
    ] as const) {
      expect(restHoursInput(minutes)).toBe(text);
      expect(readRestHours(text, "מנוחה").minutes).toBe(minutes);
    }
  });

  it("describes a rest window in words", () => {
    expect(describeRest(0)).toBe("ללא");
    expect(describeRest(45)).toBe("45 דקות");
    expect(describeRest(60)).toBe("שעה");
    expect(describeRest(120)).toBe("שעתיים");
    expect(describeRest(720)).toBe("12 שעות");
    expect(describeRest(90)).toBe("1:30 שעות");
  });
});
