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
} from "drizzle-orm/pg-core";
import type { Soldier, Duty, Assignment } from "../domain/types";
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("command_once").on(t.actorId, t.requestKey)]
);
