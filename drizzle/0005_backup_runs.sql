CREATE TABLE "backup_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"trigger" text NOT NULL,
	"requested_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"file_name" text,
	"storage_kind" text,
	"storage_id" text,
	"size_bytes" bigint,
	"sha256" text,
	"free_bytes" bigint,
	"error_code" text,
	"alerted_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_run_key_unique" UNIQUE("key"),
	CONSTRAINT "backup_trigger" CHECK ("backup_run"."trigger" in ('daily','manual')),
	CONSTRAINT "backup_status" CHECK ("backup_run"."status" in ('pending','running','verified','failed','deleted')),
	CONSTRAINT "backup_delete_reason" CHECK ("backup_run"."delete_reason" is null or "backup_run"."delete_reason" in ('retention','space'))
);
--> statement-breakpoint
ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_requested_by_auth_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_one_active" ON "backup_run" USING btree ((true)) WHERE "backup_run"."status" in ('pending','running');--> statement-breakpoint
CREATE INDEX "backup_status_finished" ON "backup_run" USING btree ("status","finished_at");