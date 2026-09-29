import { describe, expect, it } from "vitest";
import { recompose, type Seat } from "../../src/domain/composition";
import type { DutySlot } from "../../src/domain/types";

const slots: DutySlot[] = [
  { id: "g1", role: "שומר" },
  { id: "g2", role: "שומר" },
  { id: "g3", role: "שומר" },
  { id: "c1", role: "מפקד" },
];
const seats: Seat[] = [
  { slotId: "g1", soldierId: null, extraPoints: "0" },
  { slotId: "g2", soldierId: "a", extraPoints: "0" },
  { slotId: "g3", soldierId: "b", extraPoints: "1.5" },
  { slotId: "c1", soldierId: "c", extraPoints: "0" },
];
let counter = 0;
const newId = () => `new${++counter}`;

describe("instance composition", () => {
  it("keeps slot ids and occupants, drops vacant slots first and applies role conditions", () => {
    const result = recompose(
      slots,
      seats,
      [
        { name: "שומר", count: 2, requirements: { genders: ["female"] } },
        { name: "מפקד", count: 2 },
      ],
      { overflow: "reject", newId }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots.map((slot) => slot.id)).toEqual([
      "g2",
      "g3",
      "c1",
      expect.stringMatching(/^new/),
    ]);
    expect(result.slots[0]!.requirements).toEqual({ genders: ["female"] });
    expect(result.seats[1]).toEqual({
      slotId: "g3",
      soldierId: "b",
      extraPoints: "1.5",
    });
    expect(result.seats[3]!.soldierId).toBeNull();
  });
  it("refuses to remove an occupied slot unless it is released explicitly", () => {
    const refused = recompose(
      slots,
      seats,
      [
        { name: "שומר", count: 1 },
        { name: "מפקד", count: 1 },
      ],
      { overflow: "reject", newId }
    );
    expect(refused).toMatchObject({
      ok: false,
      reason: "occupied_reduction",
      occupied: [
        { slotId: "g2", soldierId: "a", role: "שומר" },
        { slotId: "g3", soldierId: "b", role: "שומר" },
      ],
    });
    const released = recompose(
      slots,
      seats,
      [
        { name: "שומר", count: 1 },
        { name: "מפקד", count: 1 },
      ],
      { overflow: "reject", release: ["g2"], newId }
    );
    expect(released.ok && released.seats.map((seat) => seat.soldierId)).toEqual(
      ["b", "c"]
    );
  });
  it("treats a removed role like a reduced quota", () => {
    expect(
      recompose(slots, seats, [{ name: "שומר", count: 3 }], {
        overflow: "reject",
        newId,
      })
    ).toMatchObject({
      ok: false,
      occupied: [{ slotId: "c1", soldierId: "c", role: "מפקד" }],
    });
    const result = recompose(slots, seats, [{ name: "שומר", count: 3 }], {
      overflow: "reject",
      release: ["c1"],
      newId,
    });
    expect(result.ok && result.slots.map((slot) => slot.id)).toEqual([
      "g1",
      "g2",
      "g3",
    ]);
  });
  it("releases only occupied slots of the proposal", () => {
    expect(
      recompose(slots, seats, [{ name: "שומר", count: 3 }], {
        overflow: "reject",
        release: ["g1", "missing"],
        newId,
      })
    ).toEqual({
      ok: false,
      reason: "invalid_release",
      slotIds: ["g1", "missing"],
    });
  });
  it("keeps occupied slots before vacant ones when a catalog quota drops", () => {
    const result = recompose(
      slots,
      seats,
      [
        { name: "שומר", count: 1 },
        { name: "מפקד", count: 1 },
      ],
      { overflow: "drop", newId }
    );
    expect(result.ok && result.seats.map((seat) => seat.soldierId)).toEqual([
      "a",
      "c",
    ]);
  });
});
