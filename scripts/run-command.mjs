import { readFileSync } from "node:fs";

// Production has no package manager. Dispatch only an explicit compiled TS
// command from the checked-in manifest; never interpret a shell command.
const name = process.argv[2];
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const script = Object.hasOwn(manifest.scripts, name) && manifest.scripts[name];
const match =
  typeof script === "string" &&
  /^tsx (scripts\/[a-z][a-z0-9-]*\.ts|src\/worker\.ts)$/.exec(script);
if (!match) throw new Error("A supported production command is required");
process.argv.splice(2, 1, match[1]);
await import("./run-runtime.mjs");
