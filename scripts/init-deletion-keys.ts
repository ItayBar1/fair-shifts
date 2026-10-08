import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Explicit operations tool for an existing deployment. Never print private keys.
const directory = process.argv[2];
if (!directory) throw new Error("Usage: pnpm security:keys <config directory>");
const names = ["worker-secrets.env", "deletion-public-keys.env"];
if (names.some((name) => existsSync(join(directory, name))))
  throw new Error("Deletion key files already exist; nothing was overwritten");
const pair = generateKeyPairSync("ed25519");
const id = `key-${randomBytes(8).toString("hex")}`;
const publicKeys = Buffer.from(
  JSON.stringify({
    [id]: pair.publicKey.export({ type: "spki", format: "pem" }),
  })
).toString("base64url");
const privateKey = Buffer.from(
  pair.privateKey.export({ type: "pkcs8", format: "pem" })
).toString("base64url");
const contents = [
  `DELETION_LOG_KEY_ID=${id}\nDELETION_LOG_PRIVATE_KEY=${privateKey}\nDELETION_LOG_KEY_RECOVERY_CONFIRMED=false\n`,
  `DELETION_LOG_PUBLIC_KEYS=${publicKeys}\n`,
];
for (const [index, name] of names.entries())
  writeFileSync(join(directory, name), contents[index], {
    mode: 0o600,
    flag: "wx",
  });
console.log(
  "Created worker-secrets.env and deletion-public-keys.env. Add the public verification setting to app.env, keep the private file worker-only, and verify an offline recovery copy before enabling deployment."
);
