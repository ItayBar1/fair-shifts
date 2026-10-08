import { pool } from "../src/server/db";
import {
  convertStoredSecrets,
  verifyStoredSecrets,
} from "../src/server/operations/secret-conversion";
import { requireConversionBackup } from "../src/server/operations/security-backup";
try {
  const command = process.argv[2];
  if (command === "convert") {
    await requireConversionBackup();
    console.log(`Converted ${await convertStoredSecrets()} stored secrets`);
  } else if (command === "verify") {
    await verifyStoredSecrets();
    console.log("Stored secret formats and contexts are valid");
  } else throw new Error("Usage: pnpm security:secrets <verify|convert>");
} catch {
  console.error(
    "Secret verification or conversion failed; contents were not logged"
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
