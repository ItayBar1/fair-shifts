import { randomBytes } from "node:crypto";

type Configuration = Record<string, string>;
export function parseConfiguration(text: string): Configuration {
  const result: Configuration = Object.create(null);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    if (
      index < 1 ||
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      Object.hasOwn(result, key)
    )
      throw new Error(
        "Configuration contains duplicate or unsupported entries"
      );
    let value = line.slice(index + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (
      /[\r\n]/.test(value) ||
      value.includes("${") ||
      /\$[A-Za-z_]/.test(value)
    )
      throw new Error(
        "Configuration interpolation is unsupported; resolve it before conversion"
      );
    result[key] = value;
  }
  return result;
}

const shared = [
  "DEPLOYMENT_ENVIRONMENT",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "OTP_SECRET",
  "MAIL_ENCRYPTION_KEY",
  "MAIL_QUOTA_TIME_ZONE",
  "RESTORE_MODE",
  "DELETION_LOG_PUBLIC_KEYS",
];
const backup = ["BACKUP_STORAGE", "BACKUP_TIME", "AGE_RECIPIENT"];
const backupSecrets = [
  "GOOGLE_DRIVE_CLIENT_ID",
  "GOOGLE_DRIVE_CLIENT_SECRET",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
  "GOOGLE_DRIVE_FOLDER_ID",
  "BACKUP_DIRECTORY",
  "BACKUP_DIRECTORY_QUOTA_BYTES",
  "BACKUP_WORK_DIRECTORY",
];
const google = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALENDAR_SYNC",
];
const pick = (source: Configuration, names: string[]) =>
  Object.fromEntries(
    names
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]])
  );
const lines = (values: Configuration) =>
  Object.entries(values).map(([key, value]) => {
    if (/[\r\n'$]/.test(value))
      throw new Error(
        "Resolve unsupported configuration characters before conversion"
      );
    return `${key}=${/[#\s"]/.test(value) ? `'${value}'` : value}`;
  });

/** Fresh credentials per service; provider secrets never appear in site output. */
export function splitServiceConfiguration(
  source: Configuration,
  database: Configuration
) {
  const baseUrl = new URL(source.DATABASE_URL);
  if (
    !["postgres:", "postgresql:"].includes(baseUrl.protocol) ||
    !source.DELETION_LOG_PUBLIC_KEYS
  )
    throw new Error(
      "Database URL and public deletion verification keys are required"
    );
  const passwords = {
    app: randomBytes(24).toString("hex"),
    worker: randomBytes(24).toString("hex"),
    operations: randomBytes(24).toString("hex"),
  };
  const url = (role: keyof typeof passwords) => {
    const next = new URL(baseUrl);
    next.username =
      role === "operations" ? "fair_shifts_ops" : `fair_shifts_${role}`;
    next.password = passwords[role];
    return next.toString();
  };
  const common = pick(source, shared);
  return {
    "app.env": lines({
      ...common,
      ...pick(source, google),
      ...pick(source, backup),
      MAIL_TRANSPORT: source.MAIL_TRANSPORT || "disabled",
      TRUST_CLOUDFLARE_IP: source.TRUST_CLOUDFLARE_IP || "false",
      SERVICE_ROLE: "app",
      DATABASE_URL: url("app"),
    }),
    "worker.env": lines({
      ...common,
      ...pick(source, google),
      ...pick(source, backup),
      ...pick(source, backupSecrets),
      ...pick(source, [
        "BREVO_API_KEY",
        "BREVO_SENDER_EMAIL",
        "WORKER_HEARTBEAT_FILE",
      ]),
      MAIL_TRANSPORT: source.MAIL_TRANSPORT || "disabled",
      SERVICE_ROLE: "worker",
      DATABASE_URL: url("worker"),
    }),
    "operations.env": lines({
      ...pick(
        common,
        shared.filter(
          (name) => name !== "BETTER_AUTH_SECRET" && name !== "OTP_SECRET"
        )
      ),
      ...pick(source, backup),
      ...pick(source, backupSecrets),
      MAIL_TRANSPORT: "disabled",
      GOOGLE_CALENDAR_SYNC: "false",
      SERVICE_ROLE: "operations",
      DATABASE_URL: url("operations"),
    }),
    "db.env": lines({
      ...database,
      FS_APP_DB_PASSWORD: passwords.app,
      FS_WORKER_DB_PASSWORD: passwords.worker,
      FS_OPS_DB_PASSWORD: passwords.operations,
    }),
  };
}
