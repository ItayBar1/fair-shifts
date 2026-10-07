import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  uuid,
  jsonb,
  index,
  uniqueIndex,
  check,
  bigint,
  primaryKey,
} from "drizzle-orm/pg-core";
const dates = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const user = pgTable(
  "auth_user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    role: text("role").notNull().default("soldier"),
    soldierId: uuid("soldier_id").unique(),
    // Default screen filter only; null = not set (all populations).
    responsibility: text("responsibility"),
    responsibilityVersion: integer("responsibility_version")
      .notNull()
      .default(1),
    securityEpoch: integer("security_epoch").notNull().default(1),
    // Changes only when Google is disconnected, independently of role revocations.
    googleLinkGeneration: integer("google_link_generation")
      .notNull()
      .default(1),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    nextCodeAllowedAt: timestamp("next_code_allowed_at", {
      withTimezone: true,
    }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    invitedAt: timestamp("invited_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set once, when the first session is created. An imported soldier who
    // ever signed in has activity, so import restore keeps the record.
    firstSignInAt: timestamp("first_sign_in_at", { withTimezone: true }),
    // The personal assignment feed advances only through events included in a read.
    assignmentFeedCursor: bigint("assignment_feed_cursor", { mode: "number" })
      .notNull()
      .default(0),
    ...dates(),
  },
  (t) => [
    check("auth_role", sql`${t.role} in ('soldier','manager','technical')`),
    check(
      "auth_responsibility",
      sql`${t.responsibility} is null or ${t.responsibility} in ('mandatory','career')`
    ),
    check(
      "auth_technical_separate",
      sql`(${t.role} = 'technical' and ${t.soldierId} is null) or (${t.role} != 'technical' and ${t.soldierId} is not null)`
    ),
  ]
);
export const session = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    securityEpoch: integer("security_epoch").notNull(),
    googleSubject: text("google_subject"),
    googleLinkGeneration: integer("google_link_generation"),
    ...dates(),
  },
  (t) => [index("auth_session_user").on(t.userId)]
);
export const account = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    googleLinkGeneration: integer("google_link_generation")
      .notNull()
      .default(1),
    proofEpoch: integer("proof_epoch"),
    needsEmailVerification: boolean("needs_email_verification")
      .notNull()
      .default(true),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    ...dates(),
  },
  (t) => [
    uniqueIndex("auth_provider_subject").on(t.providerId, t.accountId),
    uniqueIndex("auth_account_user_provider").on(t.userId, t.providerId),
    index("auth_account_user").on(t.userId),
  ]
);
export const verification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...dates(),
  },
  (t) => [index("auth_verification_identifier").on(t.identifier)]
);
export const loginCode = pgTable("login_code", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  digest: text("digest").notNull(),
  securityEpoch: integer("security_epoch").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

// Issuance and provider attempts are separate durable budgets, never refunded.
export const authBudget = pgTable(
  "auth_budget",
  {
    day: text("day").notNull(),
    category: text("category").notNull(),
    scope: text("scope").notNull(),
    used: integer("used").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.category, t.scope] }),
    check("auth_budget_nonnegative", sql`${t.used} >= 0`),
  ]
);

export const authRateLimit = pgTable(
  "auth_rate_limit",
  {
    key: text("key").primaryKey(),
    used: integer("used").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("auth_rate_limit_expiry").on(t.expiresAt),
    check("auth_rate_limit_positive", sql`${t.used} > 0`),
  ]
);
export const recoveryCode = pgTable(
  "recovery_code",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    digest: text("digest").notNull().unique(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("recovery_code_user").on(t.userId)]
);
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey(),
    recipientAccountId: text("recipient_account_id")
      .notNull()
      .references(() => user.id),
    eventKey: text("event_key").notNull().unique(),
    kind: text("kind").notNull(),
    // Explicit workflow identity; counterpart erasure must not depend on recipient alone.
    requestId: uuid("request_id"),
    requestScope: text("request_scope"),
    requestEvent: text("request_event"),
    // Hours before the duty for a duty reminder; checked against current preferences.
    reminderHours: integer("reminder_hours"),
    priority: integer("priority").notNull().default(2),
    title: text("title").notNull(),
    body: text("body").notNull(),
    href: text("href"),
    // Used by the personal page to highlight only this account's mail items.
    dutyIds: jsonb("duty_ids").$type<string[]>().notNull().default([]),
    encryptedSecret: text("encrypted_secret"),
    destination: text("destination"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    providerId: text("provider_id"),
    error: text("error"),
    ...dates(),
  },
  (t) => [
    index("email_ready").on(t.status, t.nextAttemptAt, t.priority),
    index("email_recipient").on(t.recipientAccountId),
    index("email_request").on(t.requestId),
  ]
);
export const emailQuota = pgTable(
  "email_quota",
  { day: text("day").primaryKey(), used: integer("used").notNull().default(0) },
  (t) => [check("email_quota_nonnegative", sql`${t.used} >= 0`)]
);
export const operationsState = pgTable("operations_state", {
  key: text("key").primaryKey(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
// One row per backup run: a daily key per Israel date, or a manual request.
export const backupRun = pgTable(
  "backup_run",
  {
    id: uuid("id").primaryKey(),
    key: text("key").notNull().unique(),
    trigger: text("trigger").notNull(),
    requestedBy: text("requested_by").references(() => user.id),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    fileName: text("file_name"),
    storageKind: text("storage_kind"),
    storageId: text("storage_id"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    freeBytes: bigint("free_bytes", { mode: "number" }),
    // A safe failure category only; provider responses are never stored.
    errorCode: text("error_code"),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deleteReason: text("delete_reason"),
    ...dates(),
  },
  (t) => [
    check("backup_trigger", sql`${t.trigger} in ('daily','manual')`),
    check(
      "backup_status",
      sql`${t.status} in ('pending','running','verified','failed','deleted')`
    ),
    check(
      "backup_delete_reason",
      sql`${t.deleteReason} is null or ${t.deleteReason} in ('retention','space')`
    ),
    // At most one run waits or runs at a time, whatever triggered it.
    uniqueIndex("backup_one_active")
      .on(sql`(true)`)
      .where(sql`${t.status} in ('pending','running')`),
    index("backup_status_finished").on(t.status, t.finishedAt),
  ]
);
