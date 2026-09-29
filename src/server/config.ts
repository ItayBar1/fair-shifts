import { DateTime } from "luxon";

// Deployment configuration check. Messages name the variable only and never
// echo its value, so the output is safe for container logs.
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
    if (!value(name)) errors.push(`${name}: חסר ערך`);
    return value(name);
  };

  const environment = required("DEPLOYMENT_ENVIRONMENT");
  if (
    environment &&
    !deploymentEnvironments.includes(environment as DeploymentEnvironment)
  )
    errors.push("DEPLOYMENT_ENVIRONMENT: ערך מותר הוא production או staging");

  const version = required("APP_VERSION");
  if (version === "development")
    errors.push("APP_VERSION: יש לבנות את התמונה עם מזהה גרסה");

  const databaseUrl = required("DATABASE_URL");
  if (databaseUrl) {
    const url = parseUrl(databaseUrl);
    if (!url || !["postgres:", "postgresql:"].includes(url.protocol))
      errors.push("DATABASE_URL: נדרשת כתובת PostgreSQL תקינה");
    else if (
      decodeURIComponent(url.password).length < 16 ||
      isDevelopmentValue(databaseUrl)
    )
      errors.push("DATABASE_URL: סיסמת המסד קצרה או לקוחה מסביבת הפיתוח");
  }

  const authUrl = required("BETTER_AUTH_URL");
  if (authUrl) {
    const url = parseUrl(authUrl);
    if (!url || url.protocol !== "https:" || url.pathname !== "/")
      errors.push("BETTER_AUTH_URL: נדרשת כתובת https של שורש האתר");
  }

  for (const name of ["BETTER_AUTH_SECRET", "OTP_SECRET"]) {
    const secret = required(name);
    if (secret && (secret.length < 32 || isDevelopmentValue(secret)))
      errors.push(`${name}: נדרש סוד אקראי באורך 32 תווים לפחות`);
  }
  if (
    value("BETTER_AUTH_SECRET") &&
    value("BETTER_AUTH_SECRET") === value("OTP_SECRET")
  )
    errors.push("OTP_SECRET: חייב להיות שונה מ־BETTER_AUTH_SECRET");

  const mailKey = required("MAIL_ENCRYPTION_KEY");
  if (mailKey && !/^[a-f0-9]{64}$/i.test(mailKey))
    errors.push("MAIL_ENCRYPTION_KEY: נדרשים 32 בייט בהקסדצימלי (64 תווים)");
  else if (mailKey && isDevelopmentValue(mailKey))
    errors.push("MAIL_ENCRYPTION_KEY: המפתח לקוח מסביבת הפיתוח");

  const transport = required("MAIL_TRANSPORT");
  if (transport && !["disabled", "brevo"].includes(transport))
    errors.push("MAIL_TRANSPORT: ערך מותר הוא disabled או brevo");
  if (transport === "brevo") {
    required("BREVO_API_KEY");
    const sender = required("BREVO_SENDER_EMAIL");
    if (sender && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender))
      errors.push("BREVO_SENDER_EMAIL: נדרשת כתובת מייל תקינה");
  }

  const zone = value("MAIL_QUOTA_TIME_ZONE") || "UTC";
  if (!DateTime.now().setZone(zone).isValid)
    errors.push("MAIL_QUOTA_TIME_ZONE: אזור זמן לא מוכר");

  if (
    Boolean(value("GOOGLE_CLIENT_ID")) !==
    Boolean(value("GOOGLE_CLIENT_SECRET"))
  )
    errors.push(
      "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET: יש למלא את שניהם או להשאיר את שניהם ריקים"
    );

  if (!["", "true", "false"].includes(value("RESTORE_MODE")))
    errors.push("RESTORE_MODE: ערך מותר הוא true או false");

  return errors;
}
