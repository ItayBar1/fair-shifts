import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type SecretContext = {
  purpose: "mail-code" | "calendar-refresh";
  recordId: string;
};
export function secretKey() {
  const key = process.env.MAIL_ENCRYPTION_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw new Error("Secret encryption key is invalid");
  return Buffer.from(key, "hex");
}
export function secretAAD(context: SecretContext) {
  if (
    !["mail-code", "calendar-refresh"].includes(context.purpose) ||
    !context.recordId ||
    context.recordId.length > 256
  )
    throw new Error("Secret context is invalid");
  return Buffer.from(
    JSON.stringify(["fair-shifts", 2, context.purpose, context.recordId])
  );
}
function part(value: string, length?: number) {
  if (!/^[A-Za-z0-9_-]*$/.test(value))
    throw new Error("Secret format is invalid");
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.toString("base64url") !== value ||
    (length !== undefined && bytes.length !== length)
  )
    throw new Error("Secret format is invalid");
  return bytes;
}
export function sealSecret(value: string, context: SecretContext) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(secretAAD(context));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v2",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}
export function openSecret(value: string, context: SecretContext) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v2")
    throw new Error("Secret format is invalid; run the controlled conversion");
  const nonce = part(parts[1], 12),
    tag = part(parts[2], 16),
    encrypted = part(parts[3]);
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), nonce, {
    authTagLength: 16,
  });
  decipher.setAAD(secretAAD(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8"
  );
}
