ALTER TABLE "email_outbox" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "request_scope" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "request_event" text;--> statement-breakpoint
CREATE INDEX "email_request" ON "email_outbox" USING btree ("request_id");
--> statement-breakpoint
-- Recover explicit identities of historical workflow messages without copying their body.
UPDATE email_outbox AS mail SET
  request_scope = parsed.parts[1],
  request_id = parsed.parts[2]::uuid,
  request_event = parsed.parts[3]
FROM (
  SELECT id, regexp_match(event_key,
    '^(transfer|swap|execution):([0-9a-f-]{36}):(.+):([0-9a-f-]{36})$') AS parts
  FROM email_outbox WHERE kind = 'transfer'
) AS parsed
WHERE mail.id = parsed.id AND parsed.parts IS NOT NULL;
