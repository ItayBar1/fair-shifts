import { readFile, writeFile } from "node:fs/promises";
import { format, resolveConfig } from "prettier";
import { renderMatrix } from "../tests/acceptance/matrix";

// Writes docs/acceptance-matrix.md from tests/acceptance/acceptance-map.ts and the PRD.
// The unit test compares the committed file with the same formatted output.
const prd = await readFile("docs/duty-management-prd.md", "utf8");
const file = "docs/acceptance-matrix.md";
const config = (await resolveConfig(file)) ?? {};
await writeFile(
  file,
  await format(renderMatrix(prd), { ...config, parser: "markdown" })
);
console.log(
  "docs/acceptance-matrix.md written from tests/acceptance/acceptance-map.ts"
);
