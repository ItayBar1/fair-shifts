CREATE TABLE "command_result_subjects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"command_id" uuid NOT NULL,
	"soldier_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "command_results" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "command_results" ADD COLUMN "linkage_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "command_results" ADD COLUMN "content_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "command_result_subjects" ADD CONSTRAINT "command_result_subjects_command_id_command_results_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."command_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_result_subjects" ADD CONSTRAINT "command_result_subjects_soldier_id_soldiers_id_fk" FOREIGN KEY ("soldier_id") REFERENCES "public"."soldiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "command_subject_once" ON "command_result_subjects" USING btree ("command_id","soldier_id");--> statement-breakpoint
CREATE INDEX "command_subject_soldier" ON "command_result_subjects" USING btree ("soldier_id");
--> statement-breakpoint
-- Legacy content cannot be attributed safely. Keep every replay key and hash.
UPDATE command_results SET result = jsonb_build_object('expiredAt', now(), 'reason', 'legacy_unlinked'), content_expired_at = now() WHERE NOT linkage_complete;
--> statement-breakpoint
CREATE INDEX command_content_retention ON command_results(created_at) WHERE content_expired_at IS NULL;
--> statement-breakpoint
CREATE INDEX command_import_batch ON command_results(import_batch_id);
--> statement-breakpoint
UPDATE email_outbox m SET request_scope = 'cancellation', request_id = ((regexp_match(m.event_key, '^cancellation:([0-9a-f-]{36}):(.+):([0-9a-f-]{36})$'))[1])::uuid,
request_event = (regexp_match(m.event_key, '^cancellation:([0-9a-f-]{36}):(.+):([0-9a-f-]{36})$'))[2]
WHERE m.request_id IS NULL AND m.event_key ~ '^cancellation:([0-9a-f-]{36}):(.+):([0-9a-f-]{36})$';
