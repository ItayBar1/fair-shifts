CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"duty_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"soldier_id" uuid NOT NULL,
	"status" text NOT NULL,
	"points" integer NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_nonnegative" CHECK ("assignments"."points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "balances" (
	"soldier_id" uuid PRIMARY KEY NOT NULL,
	"current" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "balance_nonnegative" CHECK ("balances"."current" >= 0)
);
--> statement-breakpoint
CREATE TABLE "command_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"request_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duty_slots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"duty_id" uuid NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duty_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "score_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"soldier_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"kind" text NOT NULL,
	"before" integer NOT NULL,
	"after" integer NOT NULL,
	"amount" integer NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "score_ledger_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "soldier_contacts" (
	"soldier_id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"phone" text,
	"address" text,
	"field_versions" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "soldiers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"personal_number" text NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "soldiers_personal_number_unique" UNIQUE("personal_number")
);
--> statement-breakpoint
CREATE TABLE "unit_lock" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipient_account_id" text NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"priority" integer DEFAULT 2 NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"href" text,
	"encrypted_secret" text,
	"destination" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"lease_until" timestamp with time zone,
	"provider_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_outbox_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "email_quota" (
	"day" text PRIMARY KEY NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "email_quota_nonnegative" CHECK ("email_quota"."used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "login_code" (
	"user_id" text PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"security_epoch" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "operations_state" (
	"key" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_code" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"digest" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_code_digest_unique" UNIQUE("digest")
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"security_epoch" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'soldier' NOT NULL,
	"soldier_id" uuid,
	"population" text,
	"security_epoch" integer DEFAULT 1 NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email"),
	CONSTRAINT "auth_user_soldier_id_unique" UNIQUE("soldier_id"),
	CONSTRAINT "auth_role" CHECK ("auth_user"."role" in ('soldier','manager','technical')),
	CONSTRAINT "auth_technical_separate" CHECK (("auth_user"."role" = 'technical' and "auth_user"."soldier_id" is null) or ("auth_user"."role" != 'technical' and "auth_user"."soldier_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_duty_id_duties_id_fk" FOREIGN KEY ("duty_id") REFERENCES "public"."duties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_slot_id_duty_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."duty_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_soldier_id_soldiers_id_fk" FOREIGN KEY ("soldier_id") REFERENCES "public"."soldiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_soldier_id_soldiers_id_fk" FOREIGN KEY ("soldier_id") REFERENCES "public"."soldiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duties" ADD CONSTRAINT "duties_type_id_duty_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."duty_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_slots" ADD CONSTRAINT "duty_slots_duty_id_duties_id_fk" FOREIGN KEY ("duty_id") REFERENCES "public"."duties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_ledger" ADD CONSTRAINT "score_ledger_soldier_id_soldiers_id_fk" FOREIGN KEY ("soldier_id") REFERENCES "public"."soldiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_subject_id_soldiers_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."soldiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soldier_contacts" ADD CONSTRAINT "soldier_contacts_soldier_id_soldiers_id_fk" FOREIGN KEY ("soldier_id") REFERENCES "public"."soldiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_recipient_account_id_auth_user_id_fk" FOREIGN KEY ("recipient_account_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_code" ADD CONSTRAINT "login_code_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_code" ADD CONSTRAINT "recovery_code_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_one_occupant" ON "assignments" USING btree ("slot_id") WHERE "assignments"."status" in ('reserved', 'held');--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_soldier_once" ON "assignments" USING btree ("duty_id","soldier_id") WHERE "assignments"."status" in ('reserved', 'held');--> statement-breakpoint
CREATE INDEX "assignment_soldier" ON "assignments" USING btree ("soldier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "command_once" ON "command_results" USING btree ("actor_id","request_key");--> statement-breakpoint
CREATE INDEX "duty_slots_duty" ON "duty_slots" USING btree ("duty_id");--> statement-breakpoint
CREATE INDEX "ledger_soldier_time" ON "score_ledger" USING btree ("soldier_id","effective_at");--> statement-breakpoint
CREATE INDEX "records_kind" ON "records" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "records_subject" ON "records" USING btree ("subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_provider_subject" ON "auth_account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_account_user" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_ready" ON "email_outbox" USING btree ("status","next_attempt_at","priority");--> statement-breakpoint
CREATE INDEX "email_recipient" ON "email_outbox" USING btree ("recipient_account_id");--> statement-breakpoint
CREATE INDEX "recovery_code_user" ON "recovery_code" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier" ON "auth_verification" USING btree ("identifier");