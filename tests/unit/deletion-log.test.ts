import { nextEntry, parseLog } from "../log-keys";
import { describe, expect, it } from "vitest";
import {
  GENESIS_HASH,
  compareLogs,
  entryHash,
  serializeEntry,
  type LogEntry,
} from "../../src/domain/deletion-log";

const uuid = (n: number) =>
  `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

function build(count: number) {
  const entries: LogEntry[] = [];
  for (let n = 1; n <= count; n++)
    entries.push(
      nextEntry(entries.at(-1), {
        id: uuid(n),
        soldierId: uuid(1000 + n),
        at: `2026-10-0${n}T10:00:00.000Z`,
      })
    );
  return entries;
}
const text = (entries: LogEntry[]) => entries.map(serializeEntry).join("");

describe("deletion log chain", () => {
  it("starts from the genesis hash and chains every line to the one before", () => {
    const [first, second, third] = build(3);
    expect(first!.seq).toBe(1);
    expect(first!.prev).toBe(GENESIS_HASH);
    expect(second!.prev).toBe(first!.hash);
    expect(third!.prev).toBe(second!.hash);
    const { hash, ...body } = first!;
    expect(hash).toBe(entryHash(body));
  });

  it("reads back exactly what it wrote", () => {
    const entries = build(4);
    const read = parseLog(text(entries));
    expect(read.problems).toEqual([]);
    expect(read.entries).toEqual(entries);
  });

  it("treats an empty log as intact and empty", () => {
    expect(parseLog("")).toEqual({ entries: [], problems: [] });
  });

  it("keeps only what is personal-data free: ids, a time and hashes", () => {
    const line = serializeEntry(build(1)[0]!);
    expect(Object.keys(JSON.parse(line)).sort()).toEqual([
      "at",
      "hash",
      "id",
      "keyId",
      "prev",
      "seq",
      "signature",
      "soldierId",
      "v",
    ]);
  });

  it("reports a changed field as a hash failure on that line and trusts nothing after it", () => {
    const lines = text(build(4)).split("\n");
    lines[1] = lines[1]!.replace(uuid(1002), uuid(9999));
    const read = parseLog(lines.join("\n"));
    expect(read.problems).toEqual([{ code: "hash", line: 2 }]);
    expect(read.entries).toHaveLength(1);
  });

  it("detects a removed line in the middle through the sequence", () => {
    const lines = text(build(4)).split("\n");
    lines.splice(1, 1);
    const read = parseLog(lines.join("\n"));
    expect(read.problems).toEqual([{ code: "sequence", line: 2 }]);
    expect(read.entries).toHaveLength(1);
  });

  it("detects lines that were swapped through the sequence", () => {
    const lines = text(build(3)).split("\n");
    [lines[0], lines[1]] = [lines[1]!, lines[0]!];
    expect(parseLog(lines.join("\n")).problems[0]?.code).toBe("sequence");
  });

  it("detects a log re-chained from a different history through the link", () => {
    const real = build(2);
    const other = nextEntry(undefined, {
      id: uuid(77),
      soldierId: uuid(78),
      at: "2026-10-09T10:00:00.000Z",
    });
    const forged = nextEntry(other, {
      id: real[1]!.id,
      soldierId: real[1]!.soldierId,
      at: real[1]!.at,
    });
    // The second line carries the first line of another log's hash.
    const read = parseLog(text([real[0]!, { ...forged, seq: 2 }]));
    expect(read.problems[0]?.code).toBe("link");
  });

  it("detects a torn last line and a line that is not an entry", () => {
    const whole = text(build(3));
    expect(parseLog(whole.slice(0, -10)).problems).toEqual([
      { code: "malformed", line: 3 },
    ]);
    // A line is complete only with its newline.
    expect(parseLog(whole.slice(0, -1)).problems).toEqual([
      { code: "malformed", line: 3 },
    ]);
    expect(parseLog(`${whole}not json\n`).problems).toEqual([
      { code: "malformed", line: 4 },
    ]);
    expect(
      parseLog(`${JSON.stringify({ seq: 1, extra: true })}\n`).problems[0]?.code
    ).toBe("malformed");
  });

  it("rejects an entry that carries a field outside the fixed set", () => {
    const entry = build(1)[0]!;
    const withName = JSON.stringify({ ...entry, name: "Danny Cohen" });
    expect(parseLog(`${withName}\n`).problems[0]?.code).toBe("malformed");
  });

  it("rejects the same deletion event appearing twice", () => {
    const first = build(1)[0]!;
    const second = nextEntry(first, {
      id: first.id,
      soldierId: first.soldierId,
      at: first.at,
    });
    expect(parseLog(text([first, second])).problems).toEqual([
      { code: "duplicate", line: 2 },
    ]);
  });
});

describe("comparing two copies of the log", () => {
  const entries = build(5);

  it("sees identical copies, and a copy that is only behind, as one history", () => {
    expect(compareLogs(entries, entries)).toBe("same");
    expect(compareLogs(entries, entries.slice(0, 3))).toBe("first_ahead");
    expect(compareLogs(entries.slice(0, 3), entries)).toBe("second_ahead");
    expect(compareLogs([], entries)).toBe("second_ahead");
    expect(compareLogs([], [])).toBe("same");
  });

  it("calls two different histories diverged, even when one is longer", () => {
    const other = [
      ...entries.slice(0, 2),
      nextEntry(entries[1], {
        id: uuid(500),
        soldierId: uuid(501),
        at: "2026-10-30T10:00:00.000Z",
      }),
    ];
    expect(compareLogs(entries, other)).toBe("diverged");
    expect(compareLogs(other, entries.slice(0, 4))).toBe("diverged");
  });
});
