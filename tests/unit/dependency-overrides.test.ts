import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// #168: pnpm overrides keep vulnerable packages out of the tree. Exercise the
// real transitive packages so an upgrade that breaks an override fails here.
const root = createRequire(import.meta.url);
const plugin = createRequire(root.resolve("eslint-config-next"));
const nextPlugin = createRequire(plugin.resolve("@next/eslint-plugin-next"));
const excel = createRequire(root.resolve("exceljs"));

describe("dependency overrides for npm findings", () => {
  it("keeps braces, its glob chain and the old esbuild loader out of the lockfile", () => {
    const packages = readFileSync("pnpm-lock.yaml", "utf8")
      .split("\n")
      .filter((line) => /^  \S.*:$/.test(line))
      .map((line) => line.trim().replace(/^'|'?:$/g, ""));
    for (const name of [
      "braces@",
      "micromatch@",
      "fast-glob@",
      "@esbuild-kit/",
      "esbuild@0.18.",
      "uuid@8.",
    ])
      expect(packages.filter((item) => item.startsWith(name))).toEqual([]);
  });
  it("resolves Next's lint root directories through tinyglobby", () => {
    expect(nextPlugin("fast-glob/package.json").name).toBe("tinyglobby");
    const { getRootDirs } = nextPlugin(
      join(
        dirname(nextPlugin.resolve("@next/eslint-plugin-next")),
        "utils/get-root-dirs.js"
      )
    ) as {
      getRootDirs: (context: {
        cwd: string;
        settings: { next?: { rootDir: string | string[] } };
      }) => string[];
    };
    expect(getRootDirs({ cwd: "/app", settings: {} })).toEqual(["/app"]);
    const found = getRootDirs({
      cwd: process.cwd(),
      settings: { next: { rootDir: ["src/*", "tests/u*"] } },
    }).map((item) => item.replace(/\/$/, ""));
    expect(found).toEqual(expect.arrayContaining(["src/app", "tests/unit"]));
    expect(found).not.toContain("src/worker.ts");
  });
  it("gives exceljs a fixed CommonJS uuid that still writes conditional formatting ids", async () => {
    const uuid = excel("uuid") as { v4: () => string };
    const version = excel("uuid/package.json").version as string;
    expect(version).toBe("11.1.1");
    expect(uuid.v4()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    // A data bar is the only exceljs path that calls uuid.v4 (x14 extension id).
    const ExcelJS = root("exceljs") as typeof import("exceljs");
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("data");
    sheet.addRow([1]);
    sheet.addConditionalFormatting({
      ref: "A1:A1",
      rules: [{ type: "dataBar", priority: 1, cfvo: [] } as never],
    });
    const written = await book.xlsx.writeBuffer();
    const zip = excel("jszip") as {
      loadAsync: (data: unknown) => Promise<{
        file: (name: string) => { async: (type: "string") => Promise<string> };
      }>;
    };
    const sheetXml = await (
      await zip.loadAsync(written)
    )
      .file("xl/worksheets/sheet1.xml")
      .async("string");
    expect(sheetXml).toMatch(
      /<x14:id>\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}<\/x14:id>/
    );
  });
});
