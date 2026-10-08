import { describe, expect, it } from "vitest";
import {
  parseConfiguration,
  splitServiceConfiguration,
} from "../../src/server/operations/service-configuration";

describe("service configuration separation", () => {
  it("gives each login independent credentials and keeps delivery, Drive and signing secrets out of the site", () => {
    const source = {
      DATABASE_URL: "postgresql://old:old@db:5432/fair_shifts?sslmode=disable",
      DELETION_LOG_PUBLIC_KEYS: "public",
      BETTER_AUTH_SECRET: "sign-in-secret",
      OTP_SECRET: "otp-secret",
      BREVO_API_KEY: "mail-secret",
      BREVO_SENDER_EMAIL: "sender@example.invalid",
      GOOGLE_DRIVE_CLIENT_ID: "drive-client",
      GOOGLE_DRIVE_CLIENT_SECRET: "drive-secret",
      GOOGLE_DRIVE_REFRESH_TOKEN: "drive-token",
      GOOGLE_CLIENT_ID: "login-client",
      GOOGLE_CLIENT_SECRET: "login-secret",
      DELETION_LOG_PRIVATE_KEY: "private-signing",
      DELETION_LOG_KEY_ID: "private-id",
      BACKUP_STORAGE: "drive",
      MAIL_TRANSPORT: "brevo",
    };
    const output = splitServiceConfiguration(source, {
      POSTGRES_PASSWORD: "cluster-secret",
    });
    const site = parseConfiguration(output["app.env"].join("\n")),
      worker = parseConfiguration(output["worker.env"].join("\n")),
      ops = parseConfiguration(output["operations.env"].join("\n"));
    expect(site.GOOGLE_CLIENT_SECRET).toBe("login-secret");
    for (const config of [site, ops])
      expect(config.BREVO_API_KEY).toBeUndefined();
    for (const key of [
      "GOOGLE_DRIVE_CLIENT_ID",
      "GOOGLE_DRIVE_CLIENT_SECRET",
      "GOOGLE_DRIVE_REFRESH_TOKEN",
      "DELETION_LOG_PRIVATE_KEY",
      "DELETION_LOG_KEY_ID",
      "POSTGRES_PASSWORD",
    ])
      expect(site[key]).toBeUndefined();
    expect(worker.BREVO_API_KEY).toBe("mail-secret");
    expect(ops.GOOGLE_DRIVE_REFRESH_TOKEN).toBe("drive-token");
    expect(ops.DELETION_LOG_PRIVATE_KEY).toBeUndefined();
    expect(ops.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(ops.BETTER_AUTH_SECRET).toBeUndefined();
    expect(ops.OTP_SECRET).toBeUndefined();
    const urls = [site, worker, ops].map(
      (config) => new URL(config.DATABASE_URL)
    );
    expect(urls.map((url) => url.username)).toEqual([
      "fair_shifts_app",
      "fair_shifts_worker",
      "fair_shifts_ops",
    ]);
    expect(new Set(urls.map((url) => url.password)).size).toBe(3);
    expect(
      urls.every(
        (url) => url.password.length === 48 && url.search === "?sslmode=disable"
      )
    ).toBe(true);
    expect(output["app.env"].join("\n")).not.toContain("cluster-secret");
  });
  it("rejects ambiguous, duplicate and interpolated input instead of evaluating configuration", () => {
    expect(parseConfiguration("# comment\nA='hello world'\nB=one=two")).toEqual(
      { A: "hello world", B: "one=two" }
    );
    for (const content of [
      "A=1\nA=2",
      "A=${SECRET}",
      "export A=1",
      "A=$SECRET",
    ])
      expect(() => parseConfiguration(content)).toThrow();
  });
});
