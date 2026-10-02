CREATE TABLE "assignment_mail_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" serial NOT NULL,
	"window_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"duty_id" uuid NOT NULL,
	"duty_version" integer NOT NULL,
	"change" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "assignment_mail_event_event_key_unique" UNIQUE("event_key"),
	CONSTRAINT "assignment_event_change" CHECK ("assignment_mail_event"."change" in ('new', 'updated', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "assignment_mail_window" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipient_account_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"notification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_window_status" CHECK ("assignment_mail_window"."status" in ('open', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "assignment_mail_event" ADD CONSTRAINT "assignment_mail_event_window_id_assignment_mail_window_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."assignment_mail_window"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_mail_event" ADD CONSTRAINT "assignment_mail_event_duty_id_duties_id_fk" FOREIGN KEY ("duty_id") REFERENCES "public"."duties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_mail_window" ADD CONSTRAINT "assignment_mail_window_recipient_account_id_auth_user_id_fk" FOREIGN KEY ("recipient_account_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_event_window" ON "assignment_mail_event" USING btree ("window_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_window_one_open" ON "assignment_mail_window" USING btree ("recipient_account_id") WHERE "assignment_mail_window"."status" = 'open';