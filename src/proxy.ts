import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { contentSecurityPolicy } from "./browser-security";

export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const csp = contentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
    process.env.BETTER_AUTH_URL?.startsWith("https://") === true
  );
  const headers = new Headers(request.headers);
  // Ignore client-provided nonce/CSP values. Next extracts the nonce from this.
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  // API streams stay outside Proxy so it cannot buffer input before our limits.
  matcher: "/((?!api(?:/|$)|_next/static|_next/image|favicon.ico).*)",
};
