import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Exercise the actual transitive package used by Next's lint plugin.
const root = createRequire(import.meta.url);
const plugin = createRequire(root.resolve("eslint-config-next"));
const nextPlugin = createRequire(plugin.resolve("@next/eslint-plugin-next"));
const glob = createRequire(nextPlugin.resolve("fast-glob"));
const match = createRequire(glob.resolve("micromatch"));
const braces = match("braces") as {
  parse: (input: string) => unknown;
  compile: (input: unknown) => string;
  stringify: (input: unknown) => string;
  expand: (input: unknown) => string[];
};

describe("braces patched depth bound", () => {
  it("rejects the published stack-exhaustion input below the existing character limit", () => {
    const pattern = "{".repeat(4000) + "a" + "}".repeat(4000);
    for (const operation of [
      braces.parse,
      braces.compile,
      braces.stringify,
      braces.expand,
    ])
      expect(() => operation(pattern)).toThrow(
        "Braces maximum nesting depth exceeded"
      );
    expect(() => braces.parse("(".repeat(4000) + "a")).toThrow(
      "Braces maximum nesting depth exceeded"
    );
  });
  it("limits supplied AST walkers as well as strings and preserves normal glob semantics", () => {
    for (const operation of [braces.compile, braces.stringify, braces.expand]) {
      let node: Record<string, unknown> = { type: "text", value: "a" };
      for (let index = 0; index < 4000; index++)
        node = { type: "root", nodes: [node] };
      expect(() => operation(node)).toThrow(
        "Braces maximum nesting depth exceeded"
      );
    }
    expect(braces.expand("src/{a,b}/{1..3}.ts")).toEqual([
      "src/a/1.ts",
      "src/a/2.ts",
      "src/a/3.ts",
      "src/b/1.ts",
      "src/b/2.ts",
      "src/b/3.ts",
    ]);
    expect(braces.compile("src/{a,b}.ts")).toBe("src/(a|b).ts");
    expect(braces.stringify(braces.parse("src/{a,b}.ts"))).toBe("src/{a,b}.ts");
  });
});
