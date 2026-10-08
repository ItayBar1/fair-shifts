import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../../src/browser-security";
const nonce = Buffer.alloc(16, 17).toString("base64");
describe("browser content policy", () => {
  it("allows only nonce-authorized scripts in production while permitting styles needed by the UI", () => {
    const value = contentSecurityPolicy(nonce, false, true);
    const script = value
      .split(";")
      .find((item) => item.trim().startsWith("script-src "))!;
    expect(script).toContain(`'nonce-${nonce}'`);
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(value).toContain("script-src-attr 'none'");
    expect(value).toContain("style-src 'self' 'unsafe-inline'");
    expect(value).toContain("upgrade-insecure-requests");
    expect(value).toContain("frame-ancestors 'none'");
    expect(value).toContain("base-uri 'none'");
  });
  it("restricts debugging eval and websocket allowances to development, without upgrading local HTTP", () => {
    const value = contentSecurityPolicy(nonce, true, false);
    expect(value).toContain("'unsafe-eval'");
    expect(value).toContain(" ws: wss:");
    expect(value).not.toContain("upgrade-insecure-requests");
    expect(() =>
      contentSecurityPolicy("client supplied 'unsafe-inline'", false, true)
    ).toThrow();
  });
});
