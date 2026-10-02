import { existsSync, readFileSync } from "node:fs";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import * as map from "../acceptance/acceptance-map";
import type { Evidence } from "../acceptance/acceptance-map";
import { parsePrd, renderMatrix, testTitles } from "../acceptance/matrix";

// The acceptance map of card #38: every story and scenario of the PRD has
// tests that exist, or says what is missing. A claim cannot outlive its test.
const prd = readFileSync("docs/duty-management-prd.md", "utf8");
const { stories, scenarios } = parsePrd(prd);
const entries = [
  ...Object.entries(map.stories).map(([id, entry]) => ({
    name: `story ${id}`,
    entry,
  })),
  ...Object.entries(map.scenarios).map(([id, entry]) => ({
    name: `scenario ${id}`,
    entry,
  })),
];
const cells: { name: string; evidence: Evidence[] }[] = [
  ...entries.map(({ name, entry }) => ({ name, evidence: entry.evidence })),
  ...map.roleStates.flatMap((state) =>
    map.roleKeys.map((role) => ({
      name: `${role} ${state}`,
      evidence: map.roleMatrix[state][role],
    }))
  ),
  ...Object.entries(map.aspects).map(([name, evidence]) => ({
    name,
    evidence,
  })),
  ...Object.entries(map.recovery).map(([name, evidence]) => ({
    name,
    evidence,
  })),
];

describe("the numbers", () => {
  it("lists the stories and the scenarios of the PRD, and no others", () => {
    const ids = (record: object) =>
      Object.keys(record)
        .map(Number)
        .sort((a, b) => a - b);
    expect(ids(map.stories)).toEqual([...stories.keys()]);
    expect(ids(map.scenarios)).toEqual([...scenarios.keys()]);
    expect(stories.size).toBeGreaterThanOrEqual(64);
    expect(scenarios.size).toBeGreaterThanOrEqual(63);
  });
});

describe("the evidence", () => {
  it("names only tests that exist", () => {
    const titles = new Map<string, string[]>();
    const missing: string[] = [];
    for (const { name, evidence } of cells)
      for (const { file, title } of evidence) {
        if (!file.startsWith("tests/") || !existsSync(file)) {
          missing.push(`${name}: no file ${file}`);
          continue;
        }
        if (!titles.has(file)) titles.set(file, testTitles(file));
        if (!titles.get(file)!.some((candidate) => candidate.includes(title)))
          missing.push(`${name}: ${file} has no test "${title}"`);
      }
    expect(missing).toEqual([]);
  });
  it("names a test once for each story, scenario or cell", () => {
    const repeated = cells.flatMap(({ name, evidence }) => {
      const seen = new Set<string>();
      return evidence.flatMap((item) => {
        const key = `${item.file}\u0000${item.title}`;
        if (!seen.has(key)) return (seen.add(key), []);
        return [`${name}: ${item.title}`];
      });
    });
    expect(repeated).toEqual([]);
  });
  it("gives every covered story and scenario at least one test", () => {
    expect(
      entries
        .filter(({ entry }) => entry.status === "covered")
        .filter(({ entry }) => entry.evidence.length === 0)
        .map(({ name }) => name)
    ).toEqual([]);
  });
});

describe("what is not covered", () => {
  it("says what is missing, and which card closes it, for every open entry", () => {
    const problems = entries.flatMap(({ name, entry }) => {
      const found: string[] = [];
      if (entry.status === "covered") {
        if (entry.gap || entry.ticket)
          found.push(`${name}: a covered entry has a gap`);
        return found.map((problem) => problem);
      }
      if (!entry.gap?.trim()) found.push(`${name}: no gap is stated`);
      if (entry.status === "open" && !Number.isInteger(entry.ticket))
        found.push(`${name}: an open entry names no card`);
      if (entry.status === "partial" && entry.evidence.length === 0)
        found.push(`${name}: a partial entry has no test`);
      return found;
    });
    expect(problems).toEqual([]);
  });
  it("shows an open scenario no test at all, so nothing is claimed twice", () => {
    expect(
      entries
        .filter(({ entry }) => entry.status === "open")
        .filter(({ entry }) => entry.evidence.length)
        .map(({ name }) => name)
    ).toEqual([]);
  });
  it("names the card of a result from a provider or the server that is only pending or verified", () => {
    const external = [
      ...map.external,
      ...entries.flatMap(({ entry }) => entry.external ?? []),
    ];
    expect(
      external.filter((item) => item.state === "verified" && !item.ref)
    ).toEqual([]);
  });
});

describe("roles, aspects and recovery", () => {
  it("has tests for each role in each state", () => {
    for (const state of map.roleStates)
      for (const role of map.roleKeys)
        expect(
          map.roleMatrix[state][role].length,
          `${role} ${state}`
        ).toBeGreaterThan(0);
  });
  it("has tests for each cross-cutting aspect and each recovery topic", () => {
    for (const [name, evidence] of [
      ...Object.entries(map.aspects),
      ...Object.entries(map.recovery),
    ])
      expect(evidence.length, name).toBeGreaterThan(0);
    expect(Object.keys(map.aspects)).toEqual([
      "privacy",
      "concurrency",
      "hebrew",
      "mobile",
      "keyboard",
      "monthEnd",
      "clockChange",
    ]);
    expect(Object.keys(map.recovery)).toEqual([
      "workerDown",
      "retries",
      "importRestore",
      "backupRestore",
      "randomness",
      "clock",
    ]);
  });
});

describe("the rendered document", () => {
  it("equals docs/acceptance-matrix.md; run pnpm docs:matrix after changing the map", async () => {
    const file = "docs/acceptance-matrix.md";
    const config = (await resolveConfig(file)) ?? {};
    const expected = await format(renderMatrix(prd), {
      ...config,
      parser: "markdown",
    });
    expect(readFileSync(file, "utf8")).toBe(expected);
  });
});
