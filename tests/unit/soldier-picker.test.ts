import { describe, expect, it } from "vitest";
import {
  NO_RANK,
  activeGroups,
  asInstant,
  clearedFilters,
  defaultFilters,
  emptyFilters,
  matchesFilters,
  matchesSearch,
  pickerOptions,
  pickerResults,
  pickerSoldier,
  rankIdAtStart,
  sameFilters,
  type PickerFilters,
} from "../../src/client/soldier-picker";
import { assignableSoldiers, type Row } from "../../src/client/types";
import type { Requirements, Soldier } from "../../src/domain/types";
import { soldier } from "../fixtures";

// The picker only helps find a soldier; these rules mirror evaluateEligibility
// over the range being filled, in Israel time (decision 193).
const toRow = (value: Soldier): Row => ({ ...value });
const filters = (changes: Partial<PickerFilters>): PickerFilters => ({
  ...emptyFilters,
  ...changes,
});
const shown = (
  person: Soldier,
  changes: Partial<PickerFilters>,
  range: { start: string; end: string }
) => matchesFilters(pickerSoldier(toRow(person)), filters(changes), range);

const day = {
  start: "2026-10-05T08:00:00+03:00",
  end: "2026-10-05T16:00:00+03:00",
};

describe("search", () => {
  const dana = soldier({ name: "דנה כהן", personalNumber: "7654321" });
  it("matches a name part and a personal number part as typed", () => {
    expect(matchesSearch(dana, "דנ")).toBe(true);
    expect(matchesSearch(dana, "כהן")).toBe(true);
    expect(matchesSearch(dana, "6543")).toBe(true);
    expect(matchesSearch(dana, "לוי")).toBe(false);
    expect(matchesSearch(dana, "99")).toBe(false);
  });
  it("needs every word, in any order, and ignores spacing and case", () => {
    expect(matchesSearch(dana, "כהן דנה")).toBe(true);
    expect(matchesSearch(dana, "  דנה    כהן ")).toBe(true);
    expect(matchesSearch(dana, "דנה לוי")).toBe(false);
    expect(matchesSearch(dana, "כהן 7654")).toBe(true);
    expect(matchesSearch(soldier({ name: "Dana Cohen" }), "cohen DANA")).toBe(
      true
    );
  });
  it("shows everyone for an empty search and ignores Hebrew points", () => {
    expect(matchesSearch(dana, "")).toBe(true);
    expect(matchesSearch(dana, "   ")).toBe(true);
    expect(matchesSearch(soldier({ name: "דָּנָה" }), "דנה")).toBe(true);
  });
});

describe("population over the whole range", () => {
  // Career from 6 October (Israel date): the unit's midnight is the change.
  const turning = soldier({
    service: {
      type: "mandatory",
      basePopulation: "mandatory",
      graceEligible: false,
      permanentFrom: "2026-10-06",
    },
  });
  it("needs the population at the start and at every change inside the range", () => {
    const across = {
      start: "2026-10-05T20:00:00+03:00",
      end: "2026-10-06T08:00:00+03:00",
    };
    expect(shown(turning, { populations: ["mandatory"] }, across)).toBe(false);
    expect(shown(turning, { populations: ["career"] }, across)).toBe(false);
    expect(
      shown(turning, { populations: ["mandatory", "career"] }, across)
    ).toBe(true);
  });
  it("treats the change at midnight as outside a range that ends then, and inside one that starts then", () => {
    expect(
      shown(
        turning,
        { populations: ["mandatory"] },
        {
          start: "2026-10-05T16:00:00+03:00",
          end: "2026-10-06T00:00:00+03:00",
        }
      )
    ).toBe(true);
    expect(
      shown(
        turning,
        { populations: ["career"] },
        {
          start: "2026-10-06T00:00:00+03:00",
          end: "2026-10-06T08:00:00+03:00",
        }
      )
    ).toBe(true);
    expect(
      shown(
        turning,
        { populations: ["mandatory"] },
        {
          start: "2026-10-06T00:00:00+03:00",
          end: "2026-10-06T08:00:00+03:00",
        }
      )
    ).toBe(false);
  });
  it("follows an officer date and an academic base population", () => {
    const officer = soldier({
      service: {
        type: "mandatory",
        basePopulation: "mandatory",
        graceEligible: false,
        officerFrom: "2026-10-05",
      },
    });
    expect(shown(officer, { populations: ["career"] }, day)).toBe(true);
    expect(shown(officer, { populations: ["mandatory"] }, day)).toBe(false);
    const academic = soldier({
      service: {
        type: "career",
        basePopulation: "academic",
        graceEligible: false,
      },
    });
    expect(shown(academic, { populations: ["academic"] }, day)).toBe(true);
    expect(shown(academic, { populations: ["career"] }, day)).toBe(false);
  });
  it("does not filter without a selection", () => {
    expect(shown(turning, {}, day)).toBe(true);
  });
});

describe("gender", () => {
  it("keeps the selected genders and hides a soldier with none recorded", () => {
    expect(
      shown(soldier({ gender: "female" }), { genders: ["female"] }, day)
    ).toBe(true);
    expect(
      shown(soldier({ gender: "male" }), { genders: ["female"] }, day)
    ).toBe(false);
    expect(shown(soldier(), { genders: ["female", "male"] }, day)).toBe(false);
    expect(shown(soldier(), {}, day)).toBe(true);
    expect(
      shown(soldier({ gender: "other" }), { genders: ["male", "other"] }, day)
    ).toBe(true);
  });
});

describe("exemptions apply at the duty date", () => {
  const exempt = soldier({
    exemptions: [
      { exemptionId: "guard", start: "2026-10-01", end: "2026-10-05" },
    ],
  });
  const hide = { exemptions: ["guard"] };
  it("hides the soldier through the last day of the exemption, inclusive", () => {
    expect(
      shown(exempt, hide, {
        start: "2026-10-05T23:00:00+03:00",
        end: "2026-10-06T07:00:00+03:00",
      })
    ).toBe(false);
    expect(shown(exempt, hide, day)).toBe(false);
  });
  it("shows the soldier from the first moment after the exemption", () => {
    expect(
      shown(exempt, hide, {
        start: "2026-10-06T00:00:00+03:00",
        end: "2026-10-06T08:00:00+03:00",
      })
    ).toBe(true);
    expect(
      shown(exempt, hide, {
        start: "2026-09-30T16:00:00+03:00",
        end: "2026-10-01T00:00:00+03:00",
      })
    ).toBe(true);
  });
  it("hides a soldier whose exemption covers only part of the range", () => {
    const later = soldier({
      exemptions: [
        { exemptionId: "guard", start: "2026-10-05", end: "2026-10-09" },
      ],
    });
    expect(
      shown(later, hide, {
        start: "2026-10-04T20:00:00+03:00",
        end: "2026-10-05T04:00:00+03:00",
      })
    ).toBe(false);
  });
  it("only considers the exemptions selected", () => {
    expect(shown(exempt, { exemptions: ["kitchen"] }, day)).toBe(true);
    expect(shown(exempt, { exemptions: ["kitchen", "guard"] }, day)).toBe(
      false
    );
    expect(shown(exempt, {}, day)).toBe(true);
  });
  it("uses Israel days on the night the clocks go back", () => {
    const ending = soldier({
      exemptions: [
        { exemptionId: "guard", start: "2026-10-20", end: "2026-10-24" },
      ],
    });
    // 25 October: 02:00 summer time becomes 01:00. The exemption ends at 00:00 +03:00.
    expect(
      shown(ending, hide, {
        start: "2026-10-25T00:00:00+03:00",
        end: "2026-10-25T08:00:00+02:00",
      })
    ).toBe(true);
    expect(
      shown(ending, hide, {
        start: "2026-10-24T22:00:00+03:00",
        end: "2026-10-25T02:30:00+02:00",
      })
    ).toBe(false);
  });
});

describe("qualifications valid for the whole range", () => {
  const trained = soldier({
    qualifications: [
      { qualificationId: "q1", start: "2026-10-01", end: "2026-10-10" },
    ],
  });
  const need = { qualifications: ["q1"] };
  it("keeps a soldier whose qualification covers the range, to the last day", () => {
    expect(
      shown(trained, need, {
        start: "2026-10-10T08:00:00+03:00",
        end: "2026-10-10T23:59:00+03:00",
      })
    ).toBe(true);
    expect(
      shown(trained, need, {
        start: "2026-10-01T00:00:00+03:00",
        end: "2026-10-02T00:00:00+03:00",
      })
    ).toBe(true);
  });
  it("hides a soldier whose qualification expires, or starts, inside the range", () => {
    expect(
      shown(trained, need, {
        start: "2026-10-10T20:00:00+03:00",
        end: "2026-10-11T04:00:00+03:00",
      })
    ).toBe(false);
    expect(
      shown(trained, need, {
        start: "2026-09-30T20:00:00+03:00",
        end: "2026-10-01T04:00:00+03:00",
      })
    ).toBe(false);
    expect(
      shown(trained, need, {
        start: "2026-10-12T08:00:00+03:00",
        end: "2026-10-12T16:00:00+03:00",
      })
    ).toBe(false);
  });
  it("joins periods that follow each other and rejects a gap", () => {
    const renewed = soldier({
      qualifications: [
        { qualificationId: "q1", start: "2026-10-01", end: "2026-10-05" },
        { qualificationId: "q1", start: "2026-10-06", end: "2026-10-10" },
      ],
    });
    const gap = soldier({
      qualifications: [
        { qualificationId: "q1", start: "2026-10-01", end: "2026-10-04" },
        { qualificationId: "q1", start: "2026-10-06", end: "2026-10-10" },
      ],
    });
    const over = {
      start: "2026-10-04T20:00:00+03:00",
      end: "2026-10-06T04:00:00+03:00",
    };
    expect(shown(renewed, need, over)).toBe(true);
    expect(shown(gap, need, over)).toBe(false);
  });
  it("requires every qualification selected, and no other soldier's", () => {
    const two = soldier({
      qualifications: [
        { qualificationId: "q1", start: "2026-10-01", end: "2026-10-10" },
        { qualificationId: "q2", start: "2026-10-01", end: "2026-10-04" },
      ],
    });
    expect(shown(two, { qualifications: ["q1", "q2"] }, day)).toBe(false);
    expect(shown(two, { qualifications: ["q1"] }, day)).toBe(true);
    expect(shown(soldier(), need, day)).toBe(false);
  });
});

describe("capabilities", () => {
  it("needs each selected capability, with no dates", () => {
    const person = soldier({ capabilities: ["driver", "medic"] });
    expect(shown(person, { capabilities: ["driver"] }, day)).toBe(true);
    expect(shown(person, { capabilities: ["driver", "medic"] }, day)).toBe(
      true
    );
    expect(shown(person, { capabilities: ["driver", "pilot"] }, day)).toBe(
      false
    );
    expect(shown(soldier(), { capabilities: ["driver"] }, day)).toBe(false);
    expect(shown(soldier(), {}, day)).toBe(true);
  });
});

describe("rank at the start of the range", () => {
  const promoted = soldier({
    rankHistory: [
      { effectiveFrom: "2026-09-01", rankId: "r1", trackId: "t", order: 1 },
      { effectiveFrom: "2026-10-06", rankId: "r2", trackId: "t", order: 2 },
    ],
  });
  it("uses the rank in force on the Israel date the range starts", () => {
    const before = {
      start: "2026-10-05T23:30:00+03:00",
      end: "2026-10-06T07:00:00+03:00",
    };
    const after = {
      start: "2026-10-06T00:00:00+03:00",
      end: "2026-10-06T08:00:00+03:00",
    };
    expect(shown(promoted, { ranks: ["r1"] }, before)).toBe(true);
    expect(shown(promoted, { ranks: ["r2"] }, before)).toBe(false);
    expect(shown(promoted, { ranks: ["r2"] }, after)).toBe(true);
    expect(shown(promoted, { ranks: ["r1"] }, after)).toBe(false);
    expect(rankIdAtStart(toRow(promoted), before)).toBe("r1");
    expect(rankIdAtStart(toRow(promoted), after)).toBe("r2");
  });
  it("ignores a later promotion inside the range", () => {
    expect(
      shown(
        promoted,
        { ranks: ["r1"] },
        {
          start: "2026-10-05T20:00:00+03:00",
          end: "2026-10-06T08:00:00+03:00",
        }
      )
    ).toBe(true);
  });
  it("treats a soldier with no rank yet as having none", () => {
    const none = soldier();
    const future = soldier({
      rankHistory: [
        { effectiveFrom: "2026-10-20", rankId: "r1", trackId: "t", order: 1 },
      ],
    });
    expect(shown(none, { ranks: [NO_RANK] }, day)).toBe(true);
    expect(shown(none, { ranks: ["r1"] }, day)).toBe(false);
    expect(shown(none, { ranks: ["r1", NO_RANK] }, day)).toBe(true);
    expect(shown(future, { ranks: [NO_RANK] }, day)).toBe(true);
    expect(shown(future, { ranks: ["r1"] }, day)).toBe(false);
    expect(shown(promoted, { ranks: [NO_RANK] }, day)).toBe(false);
  });
});

describe("combining filters", () => {
  it("needs every active filter", () => {
    const person = soldier({
      name: "דנה כהן",
      gender: "female",
      capabilities: ["driver"],
    });
    const all = {
      search: "דנה",
      genders: ["female"],
      capabilities: ["driver"],
      populations: ["mandatory"],
    };
    expect(shown(person, all, day)).toBe(true);
    expect(shown(person, { ...all, search: "לוי" }, day)).toBe(false);
    expect(shown(person, { ...all, genders: ["male"] }, day)).toBe(false);
    expect(shown(person, { ...all, capabilities: ["medic"] }, day)).toBe(false);
    expect(shown(person, { ...all, populations: ["career"] }, day)).toBe(false);
  });
  it("skips the date rules, not the others, while the range is invalid", () => {
    const person = soldier({
      name: "דנה כהן",
      exemptions: [
        { exemptionId: "guard", start: "2026-10-01", end: "2026-10-31" },
      ],
      qualifications: [
        { qualificationId: "q1", start: "2026-10-01", end: "2026-10-31" },
      ],
    });
    const reversed = {
      start: "2026-10-05T16:00:00+03:00",
      end: "2026-10-05T08:00:00+03:00",
    };
    const noZone = { start: "2026-10-05T08:00", end: "2026-10-05T16:00" };
    for (const range of [reversed, noZone]) {
      expect(shown(person, { exemptions: ["guard"] }, range)).toBe(true);
      expect(shown(person, { qualifications: ["q1"] }, range)).toBe(true);
      expect(shown(person, { populations: ["career"] }, range)).toBe(true);
      expect(shown(person, { ranks: ["r1"] }, range)).toBe(true);
      expect(shown(person, { search: "דנה" }, range)).toBe(true);
      expect(shown(person, { search: "לוי" }, range)).toBe(false);
    }
  });
});

describe("the people listed", () => {
  const people = [
    soldier({ id: "b", name: "בנימין", personalNumber: "2" }),
    soldier({ id: "a", name: "אברהם", personalNumber: "1" }),
    soldier({ id: "c", name: "גלית", personalNumber: "3", gender: "female" }),
  ].map(toRow);
  it("lists by name, in Hebrew order", () => {
    expect(
      pickerResults(people, emptyFilters, day).map((row) => row.id)
    ).toEqual(["a", "b", "c"]);
  });
  it("narrows by the filters but keeps the current choice", () => {
    const only = filters({ genders: ["female"] });
    expect(pickerResults(people, only, day).map((row) => row.id)).toEqual([
      "c",
    ]);
    expect(pickerResults(people, only, day, "a").map((row) => row.id)).toEqual([
      "a",
      "c",
    ]);
  });
  it("leaves out deleted soldiers and managers, except one who holds the place", () => {
    const state = {
      soldiers: [
        { id: "a", name: "א" },
        { id: "d", name: "ד", deletedAt: "2026-09-01T00:00:00Z" },
        { id: "m", name: "מ", isManager: true },
      ],
    };
    expect(assignableSoldiers(state).map((row) => row.id)).toEqual(["a"]);
    expect(assignableSoldiers(state, ["m", "d"]).map((row) => row.id)).toEqual([
      "a",
      "m",
    ]);
  });
});

describe("options come from the catalogs", () => {
  const catalog = [
    { id: "x2", kind: "exemption", name: "פטור ב" },
    { id: "x1", kind: "exemption", name: "פטור א" },
    { id: "q1", kind: "qualification", name: "כשירות" },
    { id: "c1", kind: "capability", name: "נהג" },
  ];
  const ranks = [
    { id: "r2", name: "סמל", track: "חובה", order: 2 },
    { id: "r1", name: "טוראי", track: "חובה", order: 1 },
    { id: "o1", name: "סגן", track: "קצינים", order: 1 },
  ];
  it("lists each kind by name and the ranks by track and order", () => {
    const options = pickerOptions({
      eligibilityCatalog: catalog,
      rankCatalog: ranks,
    });
    expect(options.exemptions.map((item) => item.label)).toEqual([
      "פטור א",
      "פטור ב",
    ]);
    expect(options.qualifications).toEqual([{ value: "q1", label: "כשירות" }]);
    expect(options.capabilities).toEqual([{ value: "c1", label: "נהג" }]);
    expect(options.ranks.map((track) => track.track)).toEqual([
      "חובה",
      "קצינים",
    ]);
    expect(options.ranks[0].ranks.map((rank) => rank.label)).toEqual([
      "טוראי",
      "סמל",
    ]);
  });
  it("shows a value added to a catalog with no change in code", () => {
    const before = pickerOptions({
      eligibilityCatalog: catalog,
      rankCatalog: ranks,
    });
    const after = pickerOptions({
      eligibilityCatalog: [
        ...catalog,
        { id: "c2", kind: "capability", name: "חובש" },
      ],
      rankCatalog: [
        ...ranks,
        { id: "r3", name: "רב סמל", track: "חובה", order: 3 },
      ],
    });
    expect(before.capabilities).toHaveLength(1);
    expect(after.capabilities.map((item) => item.label)).toEqual([
      "חובש",
      "נהג",
    ]);
    expect(after.ranks[0].ranks).toHaveLength(3);
  });
  it("copes with catalogs that did not arrive", () => {
    expect(pickerOptions({})).toEqual({
      exemptions: [],
      qualifications: [],
      capabilities: [],
      ranks: [],
    });
  });
});

describe("defaults from the duty and the role", () => {
  const ranks: Row[] = [
    { id: "t1", name: "טוראי", track: "חובה", order: 1 },
    { id: "t2", name: "סמל", track: "חובה", order: 2 },
    { id: "t3", name: "סמל ראשון", track: "חובה", order: 3 },
    { id: "t4", name: "רס״ל", track: "חובה", order: 4 },
    { id: "o1", name: "סגן", track: "קצינים", order: 1 },
  ];
  it("starts with no filter when nothing is required", () => {
    expect(defaultFilters([{}, {}], ranks)).toEqual(emptyFilters);
    expect(defaultFilters([], ranks)).toEqual(emptyFilters);
  });
  it("fills populations, genders, qualifications, capabilities and the blocking exemptions", () => {
    const duty: Requirements = {
      populations: ["mandatory", "academic"],
      genders: ["male", "female"],
      qualificationIds: ["q1"],
      capabilityIds: ["c1"],
      blockingExemptionIds: ["x1"],
    };
    const role: Requirements = {
      populations: ["mandatory"],
      genders: ["female"],
      qualificationIds: ["q1", "q2"],
      capabilityIds: ["c2"],
      blockingExemptionIds: ["x2"],
    };
    expect(defaultFilters([duty], ranks)).toMatchObject({
      populations: ["mandatory", "academic"],
      genders: ["male", "female"],
      qualifications: ["q1"],
      capabilities: ["c1"],
      exemptions: ["x1"],
    });
    // The duty's and the role's conditions both apply.
    expect(defaultFilters([duty, role], ranks)).toMatchObject({
      populations: ["mandatory"],
      genders: ["female"],
      qualifications: ["q1", "q2"],
      capabilities: ["c1", "c2"],
      exemptions: ["x1", "x2"],
    });
  });
  it("expands rank clauses to the catalog ranks they accept", () => {
    expect(
      defaultFilters([{ ranks: [{ trackId: "חובה", minOrder: 3 }] }], ranks)
        .ranks
    ).toEqual(["t3", "t4"]);
    expect(
      defaultFilters([{ ranks: [{ trackId: "חובה", maxOrder: 2 }] }], ranks)
        .ranks
    ).toEqual(["t1", "t2"]);
    expect(
      defaultFilters(
        [{ ranks: [{ trackId: "חובה", rankIds: ["t4", "t1"] }] }],
        ranks
      ).ranks
    ).toEqual(["t1", "t4"]);
  });
  it("takes clauses as alternatives and the duty and the role as both required", () => {
    const alternatives: Requirements = {
      ranks: [{ trackId: "חובה", minOrder: 4 }, { trackId: "קצינים" }],
    };
    expect(defaultFilters([alternatives], ranks).ranks).toEqual(["t4", "o1"]);
    expect(
      defaultFilters(
        [alternatives, { ranks: [{ trackId: "חובה", minOrder: 3 }] }],
        ranks
      ).ranks
    ).toEqual(["t4"]);
  });
  it("leaves the rank filter off when the clauses match nothing in the catalog", () => {
    expect(
      defaultFilters([{ ranks: [{ trackId: "מסלול חסר" }] }], ranks).ranks
    ).toEqual([]);
    expect(
      defaultFilters([{ ranks: [{ trackId: "חובה" }] }], []).ranks
    ).toEqual([]);
  });
});

describe("a form's date-time", () => {
  it("is Israel time when typed, and keeps its moment when it has an offset", () => {
    expect(asInstant("2026-10-05T08:00")).toBe("2026-10-05T08:00:00.000+03:00");
    expect(asInstant("2026-12-05T08:00")).toBe("2026-12-05T08:00:00.000+02:00");
    expect(asInstant("2026-10-05T05:00:00Z")).toBe(
      "2026-10-05T08:00:00.000+03:00"
    );
    expect(asInstant("2026-10-05T08:00:00+03:00")).toBe(
      "2026-10-05T08:00:00.000+03:00"
    );
  });
  it("is empty when it is not a date-time, so the date rules wait", () => {
    expect(asInstant("")).toBe("");
    expect(asInstant("not a date")).toBe("");
    expect(
      shown(soldier(), { genders: ["male"] }, { start: "", end: "" })
    ).toBe(false);
  });
});

describe("filter state helpers", () => {
  it("counts the groups in use and clears them without the search", () => {
    const set = filters({ search: "דנה", genders: ["male"], ranks: [NO_RANK] });
    expect(activeGroups(set)).toEqual(["genders", "ranks"]);
    expect(activeGroups(emptyFilters)).toEqual([]);
    expect(clearedFilters(set)).toEqual({ ...emptyFilters, search: "דנה" });
  });
  it("compares the groups as sets", () => {
    expect(
      sameFilters(
        filters({ populations: ["a", "b"] }),
        filters({ populations: ["b", "a"] })
      )
    ).toBe(true);
    expect(
      sameFilters(
        filters({ populations: ["a"] }),
        filters({ populations: ["a", "b"] })
      )
    ).toBe(false);
    expect(sameFilters(filters({ search: "x" }), filters({}))).toBe(true);
    expect(sameFilters(filters({ genders: ["male"] }), filters({}))).toBe(
      false
    );
  });
});

describe("a soldier row as the rules read it", () => {
  it("fills in what a row leaves out", () => {
    const person = pickerSoldier({
      id: "p",
      name: "חייל",
      population: "career",
    });
    expect(person).toMatchObject({
      id: "p",
      name: "חייל",
      personalNumber: "",
      populationHistory: [],
      qualifications: [],
      exemptions: [],
      capabilities: [],
    });
    expect(person.service.basePopulation).toBe("career");
    expect(person.gender).toBeUndefined();
  });
});
