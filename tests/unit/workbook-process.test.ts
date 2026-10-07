import { fork } from "node:child_process";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createImportTemplate,
  parseImportWorkbook,
} from "../../src/server/import-workbook";
import {
  WORKBOOK_HEAP_MIB,
  WORKBOOK_TIMEOUT_MS,
} from "../../src/server/workbook-process";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});
const actual =
  await vi.importActual<typeof import("node:child_process")>(
    "node:child_process"
  );
afterEach(() => vi.mocked(fork).mockImplementation(actual.fork));
async function valid() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(await createImportTemplate()).buffer);
  workbook
    .getWorksheet("חיילים")!
    .addRow(["900001", "Synthetic", "synthetic@example.invalid"]);
  return Buffer.from(new Uint8Array(await workbook.xlsx.writeBuffer()));
}
function fixture(name: string) {
  vi.mocked(fork).mockImplementation((_path, args, options) =>
    actual.fork(
      join(process.cwd(), `tests/fixtures/workbook-${name}.mjs`),
      args,
      options
    )
  );
}
describe("bounded isolated parser", () => {
  it("contains a parser process crash and can parse another workbook afterwards without inheriting secrets", async () => {
    const buffer = await valid();
    fixture("crash");
    await expect(parseImportWorkbook(buffer)).rejects.toMatchObject({
      code: "invalid_workbook",
    });
    const options = vi.mocked(fork).mock.calls.at(-1)?.[2];
    expect(options?.execArgv).toContain(
      `--max-old-space-size=${WORKBOOK_HEAP_MIB}`
    );
    expect(options?.env).toEqual({ NODE_ENV: "production" });
    vi.mocked(fork).mockImplementation(actual.fork);
    expect((await parseImportWorkbook(buffer))[0].values.personalNumber).toBe(
      "900001"
    );
  });
  it("kills a parser that exceeds the actual resident-memory limit and leaves the parent usable", async () => {
    const buffer = await valid();
    fixture("memory");
    await expect(parseImportWorkbook(buffer)).rejects.toMatchObject({
      code: "invalid_workbook",
    });
    vi.mocked(fork).mockImplementation(actual.fork);
    expect(await parseImportWorkbook(buffer)).toHaveLength(1);
  });
  it("kills a stalled parser at the deadline and rejects parallel parsing without starting another process", async () => {
    const buffer = await valid();
    fixture("timeout");
    const started = Date.now(),
      first = parseImportWorkbook(buffer);
    await expect(parseImportWorkbook(buffer)).rejects.toMatchObject({
      code: "import_busy",
      status: 429,
    });
    await expect(first).rejects.toMatchObject({ code: "invalid_workbook" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(
      WORKBOOK_TIMEOUT_MS - 100
    );
    vi.mocked(fork).mockImplementation(actual.fork);
    expect(await parseImportWorkbook(buffer)).toHaveLength(1);
  });
});
