import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const entry = process.argv[2];
if (!entry || !/^(scripts\/[a-z][a-z0-9-]*|src\/worker)\.ts$/.test(entry)) {
  throw new Error("A supported runtime entry point is required");
}
const compiled = resolve("runtime", entry.replace(/\.ts$/, ".mjs"));
if (!existsSync(compiled))
  throw new Error("Compiled runtime is missing; rebuild the production image");
process.argv.splice(1, 2, compiled);
await import(pathToFileURL(compiled).href);
