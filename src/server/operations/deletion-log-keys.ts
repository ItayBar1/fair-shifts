import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LogPublicKeys, LogSigner } from "../../domain/deletion-log";

export function logPublicKeys(path?: string, encoded?: string): LogPublicKeys {
  if (!path && !encoded) return {};
  const parsed: unknown = JSON.parse(
    path
      ? readFileSync(path, "utf8")
      : Buffer.from(encoded!, "base64url").toString("utf8")
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Deletion log public keys are invalid");
  const keys: Record<string, KeyObject> = Object.create(null);
  for (const [id, pem] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof pem !== "string")
      throw new Error("Deletion log public keys are invalid");
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519" || pem.includes("PRIVATE KEY"))
      throw new Error("Deletion log public keys must be Ed25519 public keys");
    keys[id] = key;
  }
  if (!Object.keys(keys).length)
    throw new Error("Deletion log public keys are missing");
  return keys;
}
// Called by the worker's drain, never by site status or restore verification.
export function logSigner(
  env: Record<string, string | undefined> = process.env
): LogSigner | undefined {
  if (
    !(env.DELETION_LOG_PRIVATE_KEY_FILE || env.DELETION_LOG_PRIVATE_KEY) ||
    !env.DELETION_LOG_KEY_ID
  )
    return undefined;
  const privateKey = createPrivateKey(
    env.DELETION_LOG_PRIVATE_KEY_FILE
      ? readFileSync(env.DELETION_LOG_PRIVATE_KEY_FILE)
      : Buffer.from(env.DELETION_LOG_PRIVATE_KEY!, "base64url")
  );
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(env.DELETION_LOG_KEY_ID)
  )
    throw new Error("Deletion log signing key is invalid");
  return { keyId: env.DELETION_LOG_KEY_ID, privateKey };
}

export function matchingLogKeys(signer: LogSigner, keys: LogPublicKeys) {
  const publicKey = keys[signer.keyId];
  return Boolean(
    publicKey &&
    createPublicKey(signer.privateKey)
      .export({ type: "spki", format: "der" })
      .equals(publicKey.export({ type: "spki", format: "der" }))
  );
}
