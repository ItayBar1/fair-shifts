import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
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
  it("allows the site to report providers without possessing their secrets and refuses leaked worker credentials", () => {
    expect(
      errorsFor({
        SERVICE_ROLE: "app",
        MAIL_TRANSPORT: "brevo",
        BACKUP_STORAGE: "drive",
        AGE_RECIPIENT: `age1${"q".repeat(58)}`,
      })
    ).toEqual([]);
    for (const name of [
      "BREVO_API_KEY",
      "GOOGLE_DRIVE_CLIENT_SECRET",
      "GOOGLE_DRIVE_REFRESH_TOKEN",
      "DELETION_LOG_PRIVATE_KEY",
      "DELETION_LOG_KEY_ID",
    ])
      expect(errorsFor({ SERVICE_ROLE: "app", [name]: "synthetic" })).toContain(
        `${name}: must not be available to the site`
      );
    expect(errorsFor({ SERVICE_ROLE: "other" })).toContain(
      "SERVICE_ROLE: allowed values are app, worker or operations"
    );
  });
  it("requires public verification keys and a matching worker-only signing key with acknowledged offline recovery", () => {
    const first = generateKeyPairSync("ed25519"),
      other = generateKeyPairSync("ed25519");
    const signing = {
      SERVICE_ROLE: "worker",
      DELETION_LOG_DIRECTORY: "/tmp/synthetic-log",
      DELETION_LOG_KEY_ID: "synthetic",
      DELETION_LOG_PUBLIC_KEYS: Buffer.from(
        JSON.stringify({
          synthetic: first.publicKey.export({ type: "spki", format: "pem" }),
        })
      ).toString("base64url"),
      DELETION_LOG_PRIVATE_KEY: Buffer.from(
        first.privateKey.export({ type: "pkcs8", format: "pem" })
      ).toString("base64url"),
      DELETION_LOG_KEY_RECOVERY_CONFIRMED: "true",
    };
    expect(errorsFor(signing)).toEqual([]);
    expect(
      errorsFor({ ...signing, DELETION_LOG_PRIVATE_KEY: undefined })
    ).toContain(
      "DELETION_LOG_PRIVATE_KEY: matching Ed25519 signing key is required for the worker"
    );
    expect(
      errorsFor({
        ...signing,
        DELETION_LOG_PRIVATE_KEY: Buffer.from(
          other.privateKey.export({ type: "pkcs8", format: "pem" })
        ).toString("base64url"),
      })
    ).toContain(
      "DELETION_LOG_PRIVATE_KEY: matching Ed25519 signing key is required for the worker"
    );
    expect(
      errorsFor({ ...signing, DELETION_LOG_KEY_RECOVERY_CONFIRMED: "false" })
    ).toContain(
      "DELETION_LOG_KEY_RECOVERY_CONFIRMED: confirm an offline recovery copy before deployment"
    );
    expect(
      errorsFor({
        ...signing,
        SERVICE_ROLE: "app",
        DELETION_LOG_PRIVATE_KEY: undefined,
        DELETION_LOG_KEY_ID: undefined,
        DELETION_LOG_KEY_RECOVERY_CONFIRMED: undefined,
      })
    ).toEqual([]);
  });
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
  it("requires an explicit Calendar flag and a configured Google client before enabling sync", () => {
    expect(errorsFor({ GOOGLE_CALENDAR_SYNC: "false" })).toEqual([]);
    expect(errorsFor({ GOOGLE_CALENDAR_SYNC: "yes" })).toHaveLength(1);
    expect(errorsFor({ GOOGLE_CALENDAR_SYNC: "true" })).toHaveLength(1);
    expect(
      errorsFor({
        GOOGLE_CALENDAR_SYNC: "true",
        GOOGLE_CLIENT_ID: "synthetic-id",
        GOOGLE_CLIENT_SECRET: "synthetic-secret",
      })
    ).toEqual([]);
  });
});
