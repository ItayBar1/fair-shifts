import { describe, expect, it } from "vitest";
import { validateDeploymentConfig } from "../../src/server/config";

// Synthetic values only; generated at random in real deployments.
const valid = {
  DEPLOYMENT_ENVIRONMENT: "staging",
  APP_VERSION: "abc123def456",
  DATABASE_URL:
    "postgresql://fair_shifts:5f1c0d9e8b7a6c5d4e3f2a1b@db:5432/fair_shifts",
  BETTER_AUTH_URL: "https://staging.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(20) + "b".repeat(20),
  OTP_SECRET: "c".repeat(20) + "d".repeat(20),
  MAIL_ENCRYPTION_KEY: "9f".repeat(32),
  MAIL_TRANSPORT: "disabled",
  MAIL_QUOTA_TIME_ZONE: "UTC",
  RESTORE_MODE: "false",
};
const errorsFor = (overrides: Record<string, string | undefined>) =>
  validateDeploymentConfig({ ...valid, ...overrides });

describe("deployment configuration check", () => {
  it("accepts a complete configuration with real sending disabled", () => {
    expect(validateDeploymentConfig(valid)).toEqual([]);
    expect(errorsFor({ DEPLOYMENT_ENVIRONMENT: "production" })).toEqual([]);
  });
  it("reports every missing required variable by name", () => {
    const errors = validateDeploymentConfig({});
    for (const name of [
      "DEPLOYMENT_ENVIRONMENT",
      "APP_VERSION",
      "DATABASE_URL",
      "BETTER_AUTH_URL",
      "BETTER_AUTH_SECRET",
      "OTP_SECRET",
      "MAIL_ENCRYPTION_KEY",
      "MAIL_TRANSPORT",
    ])
      expect(errors.some((error) => error.startsWith(`${name}:`))).toBe(true);
  });
  it("rejects the development Compose secrets without echoing them", () => {
    const development = {
      DATABASE_URL:
        "postgresql://fair_shifts:development-only@db:5432/fair_shifts",
      BETTER_AUTH_SECRET:
        "local-synthetic-only-secret-change-before-production-0001",
      OTP_SECRET: "local-synthetic-only-otp-change-before-production-00000001",
      MAIL_ENCRYPTION_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    const errors = errorsFor(development);
    expect(errors).toHaveLength(4);
    const output = errors.join("\n");
    for (const secret of Object.values(development))
      expect(output).not.toContain(secret);
    expect(
      errorsFor({
        DATABASE_URL: "postgresql://fair_shifts:replace-me@db:5432/fair_shifts",
      })
    ).toHaveLength(1);
  });
  it("requires distinct, long secrets and a valid mail key", () => {
    expect(errorsFor({ OTP_SECRET: "short" })).toHaveLength(1);
    expect(errorsFor({ OTP_SECRET: valid.BETTER_AUTH_SECRET })).toEqual([
      "OTP_SECRET: must differ from BETTER_AUTH_SECRET",
    ]);
    expect(errorsFor({ MAIL_ENCRYPTION_KEY: "9f".repeat(31) })).toHaveLength(1);
    expect(
      errorsFor({
        DATABASE_URL: "postgresql://fair_shifts:short@db:5432/fair_shifts",
      })
    ).toHaveLength(1);
  });
  it("requires an https site root reachable through the tunnel", () => {
    expect(
      errorsFor({ BETTER_AUTH_URL: "http://localhost:3000" })
    ).toHaveLength(1);
    expect(
      errorsFor({ BETTER_AUTH_URL: "https://staging.example.invalid/app" })
    ).toHaveLength(1);
  });
  it("enables Brevo only with its key and sender", () => {
    expect(errorsFor({ MAIL_TRANSPORT: "smtp" })).toHaveLength(1);
    const brevo = errorsFor({ MAIL_TRANSPORT: "brevo" });
    expect(brevo.map((error) => error.split(":")[0])).toEqual([
      "BREVO_API_KEY",
      "BREVO_SENDER_EMAIL",
    ]);
    expect(
      errorsFor({
        MAIL_TRANSPORT: "brevo",
        BREVO_API_KEY: "synthetic-key",
        BREVO_SENDER_EMAIL: "duty@example.invalid",
      })
    ).toEqual([]);
  });
  it("checks environment, version, time zone, Google pair and restore flag", () => {
    expect(errorsFor({ DEPLOYMENT_ENVIRONMENT: "development" })).toHaveLength(
      1
    );
    expect(errorsFor({ APP_VERSION: "development" })).toHaveLength(1);
    expect(errorsFor({ MAIL_QUOTA_TIME_ZONE: "Mars/Olympus" })).toHaveLength(1);
    expect(errorsFor({ GOOGLE_CLIENT_ID: "synthetic-id" })).toHaveLength(1);
    expect(
      errorsFor({
        GOOGLE_CLIENT_ID: "synthetic-id",
        GOOGLE_CLIENT_SECRET: "synthetic-secret",
      })
    ).toEqual([]);
    expect(errorsFor({ RESTORE_MODE: "yes" })).toHaveLength(1);
  });
});
