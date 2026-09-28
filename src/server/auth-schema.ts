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
    population: text("population"),
    securityEpoch: integer("security_epoch").notNull().default(1),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    invitedAt: timestamp("invited_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...dates(),
  },
  (t) => [
    check("auth_role", sql`${t.role} in ('soldier','manager','technical')`),
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
    priority: integer("priority").notNull().default(2),
    title: text("title").notNull(),
    body: text("body").notNull(),
    href: text("href"),
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
