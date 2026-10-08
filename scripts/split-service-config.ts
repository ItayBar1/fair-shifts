import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../src/server/db";
import {
  parseConfiguration,
  splitServiceConfiguration,
} from "../src/server/operations/service-configuration";
import { requireConversionBackup } from "../src/server/operations/security-backup";
try {
  const root = process.argv[2];
  if (!root) throw new Error("Configuration directory is required");
  await requireConversionBackup();
  const output = splitServiceConfiguration(
    parseConfiguration(readFileSync(join(root, "app.env"), "utf8")),
    parseConfiguration(readFileSync(join(root, "db.env"), "utf8"))
  );
  const targets = Object.keys(output).map((name) =>
    name === "app.env"
      ? "app.next.env"
      : name === "db.env"
        ? "db.next.env"
        : name
  );
  if (targets.some((name) => existsSync(join(root, name))))
    throw new Error("Split configuration files already exist");
  for (const [index, content] of Object.values(output).entries())
    writeFileSync(join(root, targets[index]), `${content.join("\n")}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  console.log(
    "Created separate site, worker, operations and database configuration. Verify the files, stop services, preserve recovery copies and apply the documented database-role transition before enabling this configuration."
  );
} catch {
  console.error(
    "Service configuration conversion failed; existing files were not overwritten"
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
