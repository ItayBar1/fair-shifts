import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Two branches that each generate a migration from the same schema produce
// snapshots with the same parent. After both merge, the chain must be
// regenerated on top of main so the migrations apply in one order.
const folder = "drizzle";
const journal = JSON.parse(
  readFileSync(`${folder}/meta/_journal.json`, "utf8")
) as { entries: { idx: number; tag: string; when: number }[] };
const snapshot = (prefix: string) =>
  JSON.parse(
    readFileSync(`${folder}/meta/${prefix}_snapshot.json`, "utf8")
  ) as { id: string; prevId: string };

describe("migration order", () => {
  it("numbers the journal entries in sequence with increasing times", () => {
    journal.entries.forEach((entry, position) => {
      expect(entry.idx).toBe(position);
      expect(entry.tag.slice(0, 5)).toBe(
        `${String(position).padStart(4, "0")}_`
      );
      if (position > 0)
        expect(entry.when).toBeGreaterThan(journal.entries[position - 1]!.when);
    });
  });
  it("has exactly one SQL file and one snapshot for every journal entry", () => {
    const tags = journal.entries.map((entry) => entry.tag);
    const files = readdirSync(folder)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.slice(0, -4))
      .sort();
    expect(files).toEqual([...tags].sort());
    const snapshots = readdirSync(`${folder}/meta`)
      .filter((name) => name.endsWith("_snapshot.json"))
      .sort();
    expect(snapshots).toEqual(
      tags.map((tag) => `${tag.slice(0, 4)}_snapshot.json`).sort()
    );
  });
  it("builds every snapshot on the one before it", () => {
    let previous = "00000000-0000-0000-0000-000000000000";
    for (const entry of journal.entries) {
      const current = snapshot(entry.tag.slice(0, 4));
      expect(current.prevId, entry.tag).toBe(previous);
      previous = current.id;
    }
  });
});
