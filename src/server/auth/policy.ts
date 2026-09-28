import {
  createHmac,
  timingSafeEqual,
  randomInt,
  randomBytes,
} from "node:crypto";
export type Role = "soldier" | "manager" | "technical";
export const OTP_TTL_MS = 600_000;
export const OTP_RESEND_MS = 60_000;
export const MAX_FAILURES = 5;
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const sessionLifetime = (role: Role) =>
  (role === "soldier" ? 7 : 1) * 86_400_000;
export function secret(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 32)
    throw new Error(`${name} must contain at least 32 characters`);
  return value;
}
export function digestCode(userId: string, code: string) {
  return createHmac("sha256", secret("OTP_SECRET"))
    .update(`${userId}:${code}`)
    .digest("hex");
}
export function matchesDigest(actual: string, expected: string) {
  const a = Buffer.from(actual, "hex"),
    b = Buffer.from(expected, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
export const newCode = () =>
  randomInt(0, 1_000_000).toString().padStart(6, "0");
export const newRecoveryCode = () => randomBytes(24).toString("base64url");
export function failureResult(previous: number) {
  const count = Math.min(MAX_FAILURES, previous + 1);
  return {
    count,
    locked: count >= MAX_FAILURES,
    remaining: count >= 3 ? MAX_FAILURES - count : undefined,
  };
}
