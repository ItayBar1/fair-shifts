CREATE TABLE "assignment_feed" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"soldier_id" uuid NOT NULL,
	"duty_id" uuid NOT NULL,
	"assignment_id" uuid,
	"kind" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"happened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_feed_kind" CHECK ("assignment_feed"."kind" in ('new','updated','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "duty_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "email_outbox" SET "duty_ids" = jsonb_build_array(substring("href" from '^/duties/([0-9a-f-]{36})$'))
WHERE "href" ~ '^/duties/[0-9a-f-]{36}$' AND "kind" IN ('publication','publication-change');--> statement-breakpoint
-- Already rendered digests contain one duty link per included duty. Use the
-- sent content, not all events in the window: some events were omitted.
UPDATE "email_outbox" AS mail SET "duty_ids" = COALESCE((
  SELECT jsonb_agg(DISTINCT captures[1])
  FROM regexp_matches(mail.body || E'\n' || COALESCE(mail.href, ''), '/duties/([0-9a-f-]{36})', 'g') AS captures
), '[]'::jsonb) WHERE "kind" = 'publication-digest';--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "assignment_feed_cursor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "assignment_feed" ADD CONSTRAINT "assignment_feed_soldier_id_soldiers_id_fk" FOREIGN KEY ("soldier_id") REFERENCES "public"."soldiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_feed" ADD CONSTRAINT "assignment_feed_duty_id_duties_id_fk" FOREIGN KEY ("duty_id") REFERENCES "public"."duties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_feed_soldier_id" ON "assignment_feed" USING btree ("soldier_id","id");--> statement-breakpoint
-- Capture the visible assignment at the time of a change. The feed contains no
-- score, participant list or private reason.
CREATE FUNCTION fs_assignment_snapshot(d jsonb, a jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'name', COALESCE(d->>'name', ''),
    'role', COALESCE((SELECT slot->>'role' FROM jsonb_array_elements(COALESCE(d->'slots','[]'::jsonb)) slot WHERE slot->>'id' = a->>'slotId' LIMIT 1), ''),
    'start', COALESCE(a->>'performedStart', d->>'start', ''),
    'end', COALESCE(a->>'performedEnd', d->>'end', ''),
    'location', COALESCE(d->>'location', '')
  )
$$;--> statement-breakpoint
CREATE FUNCTION fs_assignment_feed_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d jsonb;
BEGIN
  SELECT data INTO d FROM duties WHERE id = NEW.duty_id;
  IF d->>'status' <> 'published' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('reserved','held','credited') THEN
      INSERT INTO assignment_feed(soldier_id,duty_id,assignment_id,kind,snapshot)
      VALUES(NEW.soldier_id,NEW.duty_id,NEW.id,'new',fs_assignment_snapshot(d,NEW.data));
    END IF;
  ELSE
    IF OLD.soldier_id <> NEW.soldier_id AND OLD.status IN ('reserved','held','credited') THEN
      INSERT INTO assignment_feed(soldier_id,duty_id,assignment_id,kind,snapshot)
      VALUES(OLD.soldier_id,OLD.duty_id,OLD.id,'cancelled',fs_assignment_snapshot(d,OLD.data));
    END IF;
    IF NEW.status IN ('reserved','held','credited') AND
       (OLD.soldier_id <> NEW.soldier_id OR OLD.status = 'cancelled') THEN
      INSERT INTO assignment_feed(soldier_id,duty_id,assignment_id,kind,snapshot)
      VALUES(NEW.soldier_id,NEW.duty_id,NEW.id,'new',fs_assignment_snapshot(d,NEW.data));
    ELSIF OLD.status IN ('reserved','held','credited') AND NEW.status = 'cancelled'
       AND OLD.soldier_id = NEW.soldier_id THEN
      INSERT INTO assignment_feed(soldier_id,duty_id,assignment_id,kind,snapshot)
      VALUES(OLD.soldier_id,OLD.duty_id,OLD.id,'cancelled',fs_assignment_snapshot(d,OLD.data));
    ELSIF OLD.status IN ('reserved','held','credited') AND NEW.status IN ('reserved','held','credited')
       AND (OLD.slot_id, OLD.data->>'performedStart', OLD.data->>'performedEnd')
           IS DISTINCT FROM (NEW.slot_id, NEW.data->>'performedStart', NEW.data->>'performedEnd') THEN
      INSERT INTO assignment_feed(soldier_id,duty_id,assignment_id,kind,snapshot)
      VALUES(NEW.soldier_id,NEW.duty_id,NEW.id,'updated',fs_assignment_snapshot(d,NEW.data));
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER assignment_feed_change AFTER INSERT OR UPDATE ON assignments
FOR EACH ROW EXECUTE FUNCTION fs_assignment_feed_change();--> statement-breakpoint
CREATE FUNCTION fs_duty_feed_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;
BEGIN
  IF OLD.data->>'status' = 'draft' AND NEW.data->>'status' = 'published' THEN
    kind := 'new';
  ELSIF OLD.data->>'status' = 'published' AND NEW.data->>'status' = 'cancelled' THEN
    kind := 'cancelled';
  ELSIF OLD.data->>'status' = 'published' AND NEW.data->>'status' = 'published'
    AND (OLD.name, OLD.data->>'start', OLD.data->>'end', OLD.data->>'location', OLD.data->'slots')
        IS DISTINCT FROM (NEW.name, NEW.data->>'start', NEW.data->>'end', NEW.data->>'location', NEW.data->'slots') THEN
    kind := 'updated';
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO assignment_feed(soldier_id,duty_id,assignment_id,kind,snapshot)
  SELECT a.soldier_id, NEW.id, a.id, kind,
         fs_assignment_snapshot(CASE WHEN kind = 'cancelled' THEN OLD.data ELSE NEW.data END, a.data)
  FROM assignments a
  WHERE a.duty_id = NEW.id AND a.status IN ('reserved','held','credited');
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER duty_feed_change AFTER UPDATE ON duties
FOR EACH ROW EXECUTE FUNCTION fs_duty_feed_change();
