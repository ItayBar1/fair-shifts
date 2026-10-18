import { describe, expect, it } from "vitest";
import {
  checkRecordData,
  isRecordKind,
  recordKinds,
} from "../../src/domain/record-kinds";
import { recordData } from "../../src/server/record-data";

describe("the registry of record kinds (decision 237)", () => {
  it("gives every kind a schema and a deletion policy with its reason", () => {
    for (const [name, entry] of Object.entries(recordKinds)) {
      expect(entry.schema, name).toBeDefined();
      expect(["keep", "delete", "scrub"], name).toContain(entry.erasure.action);
      expect(entry.erasure.why.length, name).toBeGreaterThan(5);
    }
    expect(isRecordKind("request")).toBe(true);
    expect(isRecordKind("unknown_kind")).toBe(false);
  });
  it("accepts what the code writes and keeps fields the schema does not name", () => {
    const data = {
      type: "transfer",
      status: "open",
      dutyId: "duty-1",
      candidates: [{ soldierId: "s-1", status: "offered", extra: 1 }],
      somethingNew: { nested: true },
    };
    expect(checkRecordData("request", data)).toEqual({ ok: true, data });
  });
  it("refuses a missing or mistyped field, naming fields and never values", () => {
    const result = checkRecordData("request", {
      status: 7,
      candidates: [{ soldierId: "secret-person" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(
      expect.arrayContaining([
        "type: invalid_type",
        "status: invalid_type",
        "candidates.0.status: invalid_type",
      ])
    );
    expect(result.problems.join(" ")).not.toContain("secret-person");
  });
  it("stops the action with a server error when a write does not fit", () => {
    expect(() =>
      recordData("round", { name: "סבב", status: "open" })
    ).toThrowError(
      expect.objectContaining({ code: "invalid_record", status: 500 })
    );
    const valid = {
      name: "סבב",
      status: "open",
      opensAt: "2026-10-01T08:00:00+03:00",
      closesAt: "2026-10-05T08:00:00+03:00",
      targetStart: "2026-11-01",
      targetEnd: "2026-11-30",
    };
    expect(recordData("round", valid)).toBe(valid);
  });
});
