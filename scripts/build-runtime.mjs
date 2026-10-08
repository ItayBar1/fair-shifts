import { readdir } from "node:fs/promises";
import { build } from "esbuild";

// Compile CLI, worker and isolated workbook entry points at build time. Runtime
// does not need a TypeScript compiler or its native executables.
const entries = (await readdir("scripts"))
  .filter((file) => file.endsWith(".ts"))
  .map((file) => `scripts/${file}`);
await build({
  entryPoints: [
    ...entries,
    "src/worker.ts",
    "src/server/import-workbook-child.ts",
  ],
  outdir: "runtime",
  outbase: ".",
  outExtension: { ".js": ".mjs" },
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  packages: "external",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
