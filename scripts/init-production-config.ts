import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { deploymentEnvironments } from "../src/server/config";

// Creates the external configuration files for compose.production.yaml with
// fresh random secrets. Existing files are never overwritten. Provider keys and
// the tunnel token stay empty for the operator to fill in.
const [directory, ...rest] = process.argv.slice(2);
const options = z
  .object({
    environment: z.enum(deploymentEnvironments),
    url: z.string().url().startsWith("https://"),
  })
  .parse(
    Object.fromEntries(
      rest.map((arg) => {
        const [key, ...value] = arg.replace(/^--/, "").split("=");
        return [key, value.join("=")];
      })
    )
  );
if (!directory)
  throw new Error(
    "usage: init-production-config <dir> --environment=staging --url=https://..."
  );

const files = ["db.env", "app.env", "tunnel.env"].map((name) =>
  join(directory, name)
);
const existing = files.filter((file) => existsSync(file));
if (existing.length) {
  console.error(
    `Configuration files already exist and were not overwritten: ${existing.join(", ")}`
  );
  process.exit(1);
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const databasePassword = hex(24);
const origin = new URL(options.url).origin;
const content = {
  "db.env": [
    "# PostgreSQL on the internal network only. Do not change after the database is initialized.",
    "POSTGRES_USER=fair_shifts",
    "POSTGRES_DB=fair_shifts",
    `POSTGRES_PASSWORD=${databasePassword}`,
  ],
  "app.env": [
    "# Site and worker. The secrets were generated at random and are never stored in Git.",
    `DEPLOYMENT_ENVIRONMENT=${options.environment}`,
    `DATABASE_URL=postgresql://fair_shifts:${databasePassword}@db:5432/fair_shifts`,
    `BETTER_AUTH_URL=${origin}`,
    `BETTER_AUTH_SECRET=${hex(32)}`,
    `OTP_SECRET=${hex(32)}`,
    `MAIL_ENCRYPTION_KEY=${hex(32)}`,
    "# Real mail delivery stays off until Brevo is verified (card #28).",
    "MAIL_TRANSPORT=disabled",
    "BREVO_API_KEY=",
    "BREVO_SENDER_EMAIL=",
    "MAIL_QUOTA_TIME_ZONE=UTC",
    "GOOGLE_CLIENT_ID=",
    "GOOGLE_CLIENT_SECRET=",
    "# Duties in the soldier's Google calendar (decision 205). Switch on only after the sign-in client",
    "# above carries the calendar.app.created permission (see docs/operations.md).",
    "GOOGLE_CALENDAR_SYNC=false",
    "# Daily encrypted backup to Drive (decision 173). Empty = off, as the backup screen shows.",
    "# AGE_RECIPIENT is the public key only; the private key is kept off this server.",
    "BACKUP_STORAGE=",
    "BACKUP_TIME=03:30",
    "GOOGLE_DRIVE_CLIENT_ID=",
    "GOOGLE_DRIVE_CLIENT_SECRET=",
    "GOOGLE_DRIVE_REFRESH_TOKEN=",
    "GOOGLE_DRIVE_FOLDER_ID=",
    "AGE_RECIPIENT=",
    "RESTORE_MODE=false",
  ],
  "tunnel.env": [
    "# Tunnel token from the Cloudflare dashboard (Networks → Tunnels).",
    "TUNNEL_TOKEN=",
  ],
};
for (const [name, lines] of Object.entries(content))
  writeFileSync(join(directory, name), `${lines.join("\n")}\n`, {
    mode: 0o600,
    flag: "wx",
  });
console.log("Created the configuration files db.env, app.env and tunnel.env");
