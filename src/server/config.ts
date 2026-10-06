import { DateTime } from "luxon";
import { validBackupTime } from "../domain/backup";

// Deployment configuration check. Messages name the variable only and never
// echo its value, so the output is safe for container logs. They are English:
// they are read on the server (decision 187).
export const deploymentEnvironments = ["production", "staging"] as const;
export type DeploymentEnvironment = (typeof deploymentEnvironments)[number];
type Env = Record<string, string | undefined>;

// Values shipped in the development Compose file, .env.example and tests.
const developmentMarkers = [
  "local-synthetic-only",
  "development-only",
  "change-before-production",
  "replace-me",
  "test-only",
];
const developmentMailKey =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const isDevelopmentValue = (value: string) =>
  developmentMarkers.some((marker) => value.includes(marker)) ||
  value.toLowerCase() === developmentMailKey;

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function validateDeploymentConfig(env: Env): string[] {
  const errors: string[] = [];
  const value = (name: string) => env[name]?.trim() ?? "";
  const required = (name: string) => {
    if (!value(name)) errors.push(`${name}: missing value`);
    return value(name);
  };

  const environment = required("DEPLOYMENT_ENVIRONMENT");
  if (
    environment &&
    !deploymentEnvironments.includes(environment as DeploymentEnvironment)
  )
    errors.push(
      "DEPLOYMENT_ENVIRONMENT: allowed values are production or staging"
    );

  const version = required("APP_VERSION");
  if (version === "development")
    errors.push("APP_VERSION: build the image with a version identifier");

  const databaseUrl = required("DATABASE_URL");
  if (databaseUrl) {
    const url = parseUrl(databaseUrl);
    if (!url || !["postgres:", "postgresql:"].includes(url.protocol))
      errors.push("DATABASE_URL: a valid PostgreSQL URL is required");
    else if (
      decodeURIComponent(url.password).length < 16 ||
      isDevelopmentValue(databaseUrl)
    )
      errors.push(
        "DATABASE_URL: the database password is short or taken from development"
      );
  }

  const authUrl = required("BETTER_AUTH_URL");
  if (authUrl) {
    const url = parseUrl(authUrl);
    if (!url || url.protocol !== "https:" || url.pathname !== "/")
      errors.push("BETTER_AUTH_URL: an https URL of the site root is required");
  }

  for (const name of ["BETTER_AUTH_SECRET", "OTP_SECRET"]) {
    const secret = required(name);
    if (secret && (secret.length < 32 || isDevelopmentValue(secret)))
      errors.push(
        `${name}: a random secret of at least 32 characters is required`
      );
  }
  if (
    value("BETTER_AUTH_SECRET") &&
    value("BETTER_AUTH_SECRET") === value("OTP_SECRET")
  )
    errors.push("OTP_SECRET: must differ from BETTER_AUTH_SECRET");

  const mailKey = required("MAIL_ENCRYPTION_KEY");
  if (mailKey && !/^[a-f0-9]{64}$/i.test(mailKey))
    errors.push(
      "MAIL_ENCRYPTION_KEY: 32 bytes in hexadecimal (64 characters) are required"
    );
  else if (mailKey && isDevelopmentValue(mailKey))
    errors.push("MAIL_ENCRYPTION_KEY: the key is taken from development");

  const transport = required("MAIL_TRANSPORT");
  if (transport && !["disabled", "brevo"].includes(transport))
    errors.push("MAIL_TRANSPORT: allowed values are disabled or brevo");
  if (transport === "brevo") {
    required("BREVO_API_KEY");
    const sender = required("BREVO_SENDER_EMAIL");
    if (sender && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender))
      errors.push("BREVO_SENDER_EMAIL: a valid email address is required");
  }

  const zone = value("MAIL_QUOTA_TIME_ZONE") || "UTC";
  if (!DateTime.now().setZone(zone).isValid)
    errors.push("MAIL_QUOTA_TIME_ZONE: unknown time zone");

  if (
    Boolean(value("GOOGLE_CLIENT_ID")) !==
    Boolean(value("GOOGLE_CLIENT_SECRET"))
  )
    errors.push(
      "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET: set both or leave both empty"
    );

  // Duties in the soldier's Google calendar (decisions 195 and 205). It needs the sign-in
  // client, which must carry the calendar permission before this is switched on.
  const calendarSync = value("GOOGLE_CALENDAR_SYNC");
  if (!["", "true", "false"].includes(calendarSync))
    errors.push("GOOGLE_CALENDAR_SYNC: allowed values are true or false");
  if (
    calendarSync === "true" &&
    !(value("GOOGLE_CLIENT_ID") && value("GOOGLE_CLIENT_SECRET"))
  )
    errors.push(
      "GOOGLE_CALENDAR_SYNC: requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET"
    );

  // Backups (decision 173). An empty BACKUP_STORAGE switches them off; the
  // technical screen then shows that no backup is being taken.
  const backup = value("BACKUP_STORAGE");
  if (!["", "drive", "directory"].includes(backup))
    errors.push(
      "BACKUP_STORAGE: allowed values are drive or directory, or empty to switch backups off"
    );
  if (backup === "drive")
    for (const name of [
      "GOOGLE_DRIVE_CLIENT_ID",
      "GOOGLE_DRIVE_CLIENT_SECRET",
      "GOOGLE_DRIVE_REFRESH_TOKEN",
    ])
      required(name);
  if (backup === "directory") required("BACKUP_DIRECTORY");
  if (backup === "drive" || backup === "directory") {
    const recipient = required("AGE_RECIPIENT");
    if (recipient && !/^age1[0-9a-z]{58}$/.test(recipient))
      errors.push(
        "AGE_RECIPIENT: an age public key (age1…) is required, not a private key"
      );
  }
  if (value("BACKUP_TIME") && !validBackupTime(value("BACKUP_TIME")))
    errors.push("BACKUP_TIME: a time in HH:MM format is required");

  if (!["", "true", "false"].includes(value("RESTORE_MODE")))
    errors.push("RESTORE_MODE: allowed values are true or false");

  return errors;
}
