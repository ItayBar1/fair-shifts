import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { lt, sql } from "drizzle-orm";
import { db } from "../db";
import { authRateLimit } from "../auth-schema";
import { AppError } from "../errors";
import { secret } from "./policy";

const limits: Record<string, number> = {
  "request-code": 60,
  "verify-code": 300,
  recovery: 10,
};

/** IPv6 privacy addresses in one /64 share a bucket; mapped IPv4 remains IPv4. */
export function normalizeClientIp(value: string): string | undefined {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return undefined;
  try {
    const host = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const [left, right] = host.split("::");
    const a = left ? left.split(":") : [];
    const b = right ? right.split(":") : [];
    const parts =
      right !== undefined
        ? [...a, ...Array(8 - a.length - b.length).fill("0"), ...b]
        : a;
    const numbers = parts.map((part) => parseInt(part, 16));
    if (numbers.length !== 8 || numbers.some((part) => !Number.isFinite(part)))
      return undefined;
    if (
      numbers.slice(0, 5).every((part) => part === 0) &&
      numbers[5] === 0xffff
    )
      return [
        numbers[6] >> 8,
        numbers[6] & 255,
        numbers[7] >> 8,
        numbers[7] & 255,
      ].join(".");
    return (
      numbers
        .slice(0, 4)
        .map((part) => part.toString(16).padStart(4, "0"))
        .join(":") + "::/64"
    );
  } catch {
    return undefined;
  }
}

/** An untrusted header never creates a fresh bucket. Direct access shares one. */
export function clientBucket(request: Request) {
  const tunnel =
    process.env.TRUST_CLOUDFLARE_IP === "true" &&
    ["production", "staging"].includes(
      process.env.DEPLOYMENT_ENVIRONMENT ?? ""
    );
  return (
    (tunnel &&
      normalizeClientIp(request.headers.get("cf-connecting-ip") ?? "")) ||
    "direct-origin"
  );
}

export async function enforceAuthRateLimit(
  request: Request,
  path: string,
  now = new Date()
) {
  const limit = limits[path];
  if (!limit || request.method !== "POST") return;
  const minute = Math.floor(now.getTime() / 60_000);
  const digest = createHmac("sha256", secret("OTP_SECRET"))
    .update(`auth-ip:${clientBucket(request)}`)
    .digest("hex");
  const key = `${path}:${minute}:${digest}`;
  const accepted = await db
    .insert(authRateLimit)
    .values({ key, used: 1, expiresAt: new Date((minute + 1) * 60_000) })
    .onConflictDoUpdate({
      target: authRateLimit.key,
      set: { used: sql`${authRateLimit.used} + 1` },
      where: lt(authRateLimit.used, limit),
    })
    .returning({ key: authRateLimit.key });
  if (!accepted.length)
    throw new AppError(
      "rate_limit",
      "יותר מדי ניסיונות. יש להמתין דקה ולנסות שוב",
      429
    );
}
