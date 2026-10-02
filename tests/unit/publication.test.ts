import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { publishBlock } from "../../src/domain/publication";
import { assignment, duty, soldier } from "../fixtures";

const now = DateTime.fromISO("2026-09-20T09:00:00+03:00").toMillis();
const ready = duty({
  id: "d1",
  start: "2026-09-27T08:00:00+03:00",
  end: "2026-09-27T16:00:00+03:00",
});
const holder = soldier({ id: "a", name: "אביב" });
const state = (
  over: Partial<{
    soldiers: ReturnType<typeof soldier>[];
    assignments: ReturnType<typeof assignment>[];
  }> = {}
) => ({
  soldiers: [holder],
  duties: [ready],
  assignments: [assignment({ id: "x", dutyId: "d1", slotId: "s" })],
  ...over,
});

describe("publishBlock", () => {
  it("lets a future draft with eligible seats through, with or without seats", () => {
    expect(publishBlock(state(), ready, now)).toBeNull();
    expect(publishBlock(state({ assignments: [] }), ready, now)).toBeNull();
  });
  it("blocks a duty that is not a draft, naming what it is", () => {
    for (const [status, reason] of [
      ["published", "התורנות כבר פורסמה"],
      ["cancelled", "התורנות בוטלה"],
    ] as const) {
      const block = publishBlock(state(), { ...ready, status }, now);
      expect(block).toMatchObject({
        code: "cannot_publish",
        message: "ניתן לפרסם טיוטה שטרם התחילה",
        status: 422,
        reason,
      });
    }
  });
  it("blocks a draft that has started, at the very start instant too", () => {
    const start = DateTime.fromISO(ready.start).toMillis();
    expect(publishBlock(state(), ready, start)?.reason).toBe(
      "התורנות כבר התחילה"
    );
    expect(publishBlock(state(), ready, start - 1)).toBeNull();
  });
  it("blocks a seat that is no longer eligible and says whose and why", () => {
    const away = soldier({
      id: "a",
      name: "אביב",
      inactivePeriods: [{ start: "2026-09-27", end: "2026-09-27" }],
    });
    const block = publishBlock(state({ soldiers: [away] }), ready, now);
    expect(block?.code).toBe("assignment_changed");
    expect(block?.status).toBe(422);
    expect(block?.message).toBe(
      "נתוני השיבוץ השתנו. יש לטפל בהתאמה לפני פרסום"
    );
    expect(block?.reason).toContain("השיבוץ של אביב אינו תקין עוד");
    expect(block?.reason).toContain("אי־פעילות");
    expect(block?.eligibility?.status).toBe("blocked");
  });
  it("lists every seat that needs handling, and keeps the first as the error", () => {
    const two = duty({
      ...ready,
      slots: [
        { id: "s", role: "תורן" },
        { id: "s2", role: "תורן" },
      ],
    });
    const away = (id: string, name: string) =>
      soldier({
        id,
        name,
        inactivePeriods: [{ start: "2026-09-27", end: "2026-09-27" }],
      });
    const block = publishBlock(
      {
        soldiers: [away("a", "אביב"), away("b", "בר")],
        duties: [two],
        assignments: [
          assignment({ id: "x", slotId: "s", soldierId: "a", dutyId: "d1" }),
          assignment({ id: "y", slotId: "s2", soldierId: "b", dutyId: "d1" }),
        ],
      },
      two,
      now
    );
    expect(block?.reason.split(" · ")).toHaveLength(2);
    expect(block?.reason).toContain("אביב");
    expect(block?.reason).toContain("בר");
  });
  it("blocks a seat whose soldier or slot is gone", () => {
    expect(publishBlock(state({ soldiers: [] }), ready, now)).toMatchObject({
      code: "invalid_assignment",
      message: "שיבוץ דורש בדיקה לפני פרסום",
    });
  });
  it("ignores cancelled seats and other duties' seats", () => {
    const away = soldier({
      id: "a",
      inactivePeriods: [{ start: "2026-09-27", end: "2026-09-27" }],
    });
    expect(
      publishBlock(
        state({
          soldiers: [away],
          assignments: [
            assignment({ id: "x", dutyId: "d1", status: "cancelled" }),
            assignment({ id: "y", dutyId: "other" }),
          ],
        }),
        ready,
        now
      )
    ).toBeNull();
  });
});
