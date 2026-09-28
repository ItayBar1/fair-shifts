import { describe, expect, it } from "vitest";
import {
  defaultPopulations,
  filterSoldiers,
  rankTracks,
} from "../../src/client/soldier-filters";

const people = [
  {
    id: "m",
    name: "חובה א",
    personalNumber: "0001",
    population: "mandatory",
    rankId: "r-sgt",
    rankTrack: "נגדים",
  },
  {
    id: "c",
    name: "קבע ב",
    personalNumber: "0002",
    population: "career",
    rankId: "r-officer",
    rankTrack: "קצינים",
  },
  { id: "k", name: "קמא ג", personalNumber: "0003", population: "academic" },
  {
    id: "same-name",
    name: "חובה ד",
    personalNumber: "0004",
    population: "mandatory",
    rankId: "r-sgt-other",
    rankTrack: "מסלול אחר",
  },
  {
    id: "gone",
    name: "חובה ה",
    personalNumber: "0005",
    population: "mandatory",
    deletedAt: "2026-01-01T00:00:00Z",
  },
];
const all = ["mandatory", "career", "academic"];
const ids = (filters: Parameters<typeof filterSoldiers>[1]) =>
  filterSoldiers(people, filters).map((row) => row.id);

describe("soldier list filters", () => {
  it("defaults a manager to their responsibility and the shared KAMA group", () => {
    expect(defaultPopulations("mandatory")).toEqual(["mandatory", "academic"]);
    expect(defaultPopulations("career")).toEqual(["career", "academic"]);
    expect(defaultPopulations(undefined)).toEqual(all);
    expect(defaultPopulations("academic")).toEqual(all);
  });
  it("hides KAMA independently and can add the other population", () => {
    const base = { search: "", rank: "" };
    expect(ids({ ...base, populations: ["mandatory", "academic"] })).toEqual([
      "m",
      "k",
      "same-name",
    ]);
    expect(ids({ ...base, populations: ["mandatory"] })).toEqual([
      "m",
      "same-name",
    ]);
    expect(ids({ ...base, populations: all })).toEqual([
      "m",
      "c",
      "k",
      "same-name",
    ]);
    expect(ids({ ...base, populations: [] })).toEqual([]);
  });
  it("filters an exact rank without treating another track as equivalent", () => {
    const base = { search: "", populations: all };
    expect(ids({ ...base, rank: "rank:r-sgt" })).toEqual(["m"]);
    expect(ids({ ...base, rank: "track:נגדים" })).toEqual(["m"]);
    expect(ids({ ...base, rank: "track:מסלול אחר" })).toEqual(["same-name"]);
    expect(ids({ ...base, rank: "missing" })).toEqual(["k"]);
    expect(ids({ ...base, rank: "unknown" })).toEqual([]);
  });
  it("combines search with filters and never lists deleted records", () => {
    expect(
      ids({ search: " 0004 ", populations: ["mandatory"], rank: "" })
    ).toEqual(["same-name"]);
    expect(
      ids({ search: "חובה ה", populations: all, rank: "missing" })
    ).toEqual([]);
  });
  it("groups the catalog by track in rank order", () => {
    expect(
      rankTracks([
        { id: "b", name: "ב", track: "נגדים", order: 2 },
        { id: "a", name: "א", track: "נגדים", order: 1 },
        { id: "x", name: "ס", track: "קצינים", order: 1 },
        { id: "no-track", name: "ללא" },
      ])
    ).toEqual([
      {
        track: "נגדים",
        ranks: [
          { id: "a", name: "א" },
          { id: "b", name: "ב" },
        ],
      },
      { track: "קצינים", ranks: [{ id: "x", name: "ס" }] },
    ]);
  });
});
