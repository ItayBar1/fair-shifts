CREATE TABLE "calendar_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"duty_id" uuid NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"google_event_id" text NOT NULL,
	"status" text DEFAULT 'synced' NOT NULL,
	"fingerprint" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_status" CHECK ("calendar_event"."status" in ('pending', 'synced', 'removed_by_user', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "calendar_link" (
	"account_id" text PRIMARY KEY NOT NULL,
	"refresh_token" text,
	"state" text DEFAULT 'active' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"calendar_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_token" text,
	"error_code" text,
	"remove_requested_at" timestamp with time zone,
	"permission_notice_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_link_state" CHECK ("calendar_link"."state" in ('active', 'needs_permission'))
);
--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_account_id_auth_user_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_link" ADD CONSTRAINT "calendar_link_account_id_auth_user_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_duty" ON "calendar_event" USING btree ("account_id","duty_id");--> statement-breakpoint
CREATE INDEX "calendar_link_due" ON "calendar_link" USING btree ("next_attempt_at");
--> statement-breakpoint
-- Existing identity links have no proof of Calendar consent. Only sealed tokens
-- obtained by the dedicated grant flow may be retained from this version onward.
UPDATE "auth_account" SET "access_token" = NULL, "refresh_token" = NULL,
  "id_token" = NULL, "access_token_expires_at" = NULL,
  "refresh_token_expires_at" = NULL WHERE "provider_id" = 'google';
