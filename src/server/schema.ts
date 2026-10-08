import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  check,
  serial,
  boolean,
} from "drizzle-orm/pg-core";
import type { Soldier, Duty, Assignment } from "../domain/types";
import { user } from "./auth-schema";
export * from "./auth-schema";

const dates = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const unitLock = pgTable("unit_lock", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull().default(1),
});
export const soldiers = pgTable("soldiers", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  personalNumber: text("personal_number").notNull().unique(),
  data: jsonb("data").$type<Soldier>().notNull(),
  version: integer("version").notNull().default(1),
  fieldVersions: jsonb("field_versions")
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...dates(),
});
export const soldierContacts = pgTable("soldier_contacts", {
  soldierId: uuid("soldier_id")
    .primaryKey()
    .references(() => soldiers.id),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  fieldVersions: jsonb("field_versions")
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
});
export const dutyTypes = pgTable("duty_types", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  version: integer("version").notNull().default(1),
  ...dates(),
});
export const duties = pgTable("duties", {
  id: uuid("id").primaryKey(),
  typeId: uuid("type_id")
    .notNull()
    .references(() => dutyTypes.id),
  name: text("name").notNull(),
  data: jsonb("data")
    .$type<Duty & { name: string; location: string; instructions: string }>()
    .notNull(),
  version: integer("version").notNull().default(1),
  ...dates(),
});
export const dutySlots = pgTable(
  "duty_slots",
  {
    id: uuid("id").primaryKey(),
    dutyId: uuid("duty_id")
      .notNull()
      .references(() => duties.id),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [index("duty_slots_duty").on(table.dutyId)]
);
export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id").primaryKey(),
    dutyId: uuid("duty_id")
      .notNull()
      .references(() => duties.id),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => dutySlots.id),
    soldierId: uuid("soldier_id")
      .notNull()
      .references(() => soldiers.id),
    status: text("status").notNull(),
    points: integer("points").notNull(),
    data: jsonb("data")
      .$type<
        Assignment & {
          needsAttention?: string[];
          fixedBonus?: number;
        }
      >()
      .notNull(),
    version: integer("version").notNull().default(1),
    ...dates(),
  },
  (table) => [
    // One occupant per seat; a seat split into execution periods (decision 183)
    // holds one row per performer, kept apart by the execution rules.
    uniqueIndex("assignment_one_occupant")
      .on(table.slotId)
      .where(
        sql`${table.status} in ('reserved', 'held') and ${table.data}->>'performedStart' is null`
      ),
    uniqueIndex("assignment_soldier_once")
      .on(table.dutyId, table.soldierId)
      .where(sql`${table.status} in ('reserved', 'held')`),
    index("assignment_soldier").on(table.soldierId),
    check("assignment_nonnegative", sql`${table.points} >= 0`),
  ]
);
// An append-only, private projection of changes to published assignments.
// A DB trigger records every writer, including execution and transfer paths.
export const assignmentFeed = pgTable(
  "assignment_feed",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    soldierId: uuid("soldier_id")
      .notNull()
      .references(() => soldiers.id),
    dutyId: uuid("duty_id")
      .notNull()
      .references(() => duties.id),
    assignmentId: uuid("assignment_id"),
    kind: text("kind").notNull(),
    snapshot: jsonb("snapshot")
      .$type<{
        name: string;
        role: string;
        start: string;
        end: string;
        location: string;
      }>()
      .notNull(),
    happenedAt: timestamp("happened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("assignment_feed_soldier_id").on(t.soldierId, t.id),
    check(
      "assignment_feed_kind",
      sql`${t.kind} in ('new','updated','cancelled')`
    ),
  ]
);
export const balances = pgTable(
  "balances",
  {
    soldierId: uuid("soldier_id")
      .primaryKey()
      .references(() => soldiers.id),
    current: integer("current").notNull().default(0),
    version: integer("version").notNull().default(1),
  },
  (t) => [check("balance_nonnegative", sql`${t.current} >= 0`)]
);
export const ledger = pgTable(
  "score_ledger",
  {
    id: uuid("id").primaryKey(),
    soldierId: uuid("soldier_id")
      .notNull()
      .references(() => soldiers.id),
    sourceKey: text("source_key").notNull().unique(),
    kind: text("kind").notNull(),
    before: integer("before").notNull(),
    after: integer("after").notNull(),
    amount: integer("amount").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ledger_soldier_time").on(t.soldierId, t.effectiveAt)]
);
// Versioned workflow records. Sensitive text is associated with a subject for erasure.
export const records = pgTable(
  "records",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    subjectId: uuid("subject_id").references(() => soldiers.id),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    version: integer("version").notNull().default(1),
    ...dates(),
  },
  (t) => [
    index("records_kind").on(t.kind),
    index("records_subject").on(t.subjectId),
  ]
);
export const commandResults = pgTable(
  "command_results",
  {
    id: uuid("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    requestKey: text("request_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    result: jsonb("result").$type<unknown>().notNull(),
    importBatchId: uuid("import_batch_id"),
    linkageComplete: boolean("linkage_complete").notNull().default(false),
    contentExpiredAt: timestamp("content_expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("command_once").on(t.actorId, t.requestKey),
    index("command_content_retention")
      .on(t.createdAt)
      .where(sql`${t.contentExpiredAt} is null`),
    index("command_import_batch").on(t.importBatchId),
  ]
);

/** Keys and fingerprints persist; these links govern erasure of result content. */
export const commandResultSubjects = pgTable(
  "command_result_subjects",
  {
    id: uuid("id").primaryKey(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => commandResults.id, { onDelete: "cascade" }),
    soldierId: uuid("soldier_id")
      .notNull()
      .references(() => soldiers.id),
  },
  (t) => [
    uniqueIndex("command_subject_once").on(t.commandId, t.soldierId),
    index("command_subject_soldier").on(t.soldierId),
  ]
);

/**
 * The ten-minute window of one recipient in which announcements of published
 * assignments gather into a single mail and a single site notice (decision 197).
 * Its mail waits in the outbox under the same id. At most one window per
 * recipient is open; a closed window only waits for its mail to go out.
 */
export const assignmentMailWindow = pgTable(
  "assignment_mail_window",
  {
    id: uuid("id").primaryKey(),
    recipientAccountId: text("recipient_account_id")
      .notNull()
      .references(() => user.id),
    status: text("status").notNull().default("open"),
    opensAt: timestamp("opens_at", { withTimezone: true }).notNull(),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    // The one site notice of the window, a `records` row of kind notification.
    notificationId: uuid("notification_id"),
    ...dates(),
  },
  (t) => [
    uniqueIndex("assignment_window_one_open")
      .on(t.recipientAccountId)
      .where(sql`${t.status} = 'open'`),
    check("assignment_window_status", sql`${t.status} in ('open', 'closed')`),
  ]
);
/** One announcement in a window; the key makes a repeated action join it only once. */
export const assignmentMailEvent = pgTable(
  "assignment_mail_event",
  {
    id: uuid("id").primaryKey(),
    seq: serial("seq").notNull(),
    windowId: uuid("window_id")
      .notNull()
      .references(() => assignmentMailWindow.id),
    eventKey: text("event_key").notNull().unique(),
    dutyId: uuid("duty_id")
      .notNull()
      .references(() => duties.id),
    dutyVersion: integer("duty_version").notNull(),
    change: text("change").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("assignment_event_window").on(t.windowId, t.seq),
    check(
      "assignment_event_change",
      sql`${t.change} in ('new', 'updated', 'cancelled')`
    ),
  ]
);

/**
 * The Google calendar permission and switch of one soldier's account (decision 195).
 * The row exists once a Google sign-in granted the permission. Only the refresh token
 * is kept, sealed like a mail secret, and it is deleted with the account. `state`
 * says whether the permission can be used; `enabled` is the soldier's own switch.
 */
export const calendarLink = pgTable(
  "calendar_link",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => user.id),
    refreshToken: text("refresh_token"),
    state: text("state").notNull().default("active"),
    enabled: boolean("enabled").notNull().default(true),
    version: integer("version").notNull().default(1),
    // The secondary calendar "תורנויות", created once.
    calendarId: text("calendar_id"),
    // Backoff after a failed run; a run takes the lease so two workers never work one account.
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseToken: text("lease_token"),
    // A failure category only; Google's answers are never stored.
    errorCode: text("error_code"),
    // The button "remove the future duties from the calendar", until a run did it.
    removeRequestedAt: timestamp("remove_requested_at", {
      withTimezone: true,
    }),
    // The single site notice of a lost permission, so it is not repeated.
    permissionNoticeAt: timestamp("permission_notice_at", {
      withTimezone: true,
    }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    check(
      "calendar_link_state",
      sql`${t.state} in ('active', 'needs_permission')`
    ),
    index("calendar_link_due").on(t.nextAttemptAt),
  ]
);
/**
 * One event the sync put in a soldier's calendar, for one duty. `removed_by_user`
 * remembers an event the soldier deleted in Google, so an update does not bring it back,
 * and `removed` one the sync deleted itself. Both keep the id: Google never reuses it.
 */
export const calendarEvent = pgTable(
  "calendar_event",
  {
    id: uuid("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => user.id),
    dutyId: uuid("duty_id").notNull(),
    generation: integer("generation").notNull().default(0),
    googleEventId: text("google_event_id").notNull(),
    status: text("status").notNull().default("synced"),
    fingerprint: text("fingerprint").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("calendar_event_duty").on(t.accountId, t.dutyId),
    check(
      "calendar_event_status",
      sql`${t.status} in ('pending', 'synced', 'removed_by_user', 'removed')`
    ),
  ]
);
