-- Decision 222: the military personal number is not kept. The stored profile
-- keeps first and last name apart; the full name column stays for display.
UPDATE "soldiers" SET "data" = ("data" - 'personalNumber') || jsonb_build_object(
  'firstName', split_part("name", ' ', 1),
  'lastName', CASE WHEN position(' ' in "name") > 0 THEN substr("name", position(' ' in "name") + 1) ELSE '' END
);--> statement-breakpoint
-- Field versions no longer read the dropped column; the issued number never changes.
CREATE FUNCTION fair_shifts_person_profile_fields(profile jsonb, person_name text, deleted_at timestamptz)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT (profile - 'service' - 'version' - 'currentScore' - 'constraints')
    || COALESCE((SELECT jsonb_object_agg('service.' || key, value) FROM jsonb_each(COALESCE(profile->'service', '{}'::jsonb))), '{}'::jsonb)
    || jsonb_build_object('name', person_name, 'deletedAt', extract(epoch FROM deleted_at));
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION fair_shifts_track_field_versions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_fields jsonb;
  next_fields jsonb;
  field_name text;
BEGIN
  IF TG_TABLE_NAME = 'soldiers' THEN
    previous_fields := fair_shifts_person_profile_fields(OLD.data, OLD.name, OLD.deleted_at);
    next_fields := fair_shifts_person_profile_fields(NEW.data, NEW.name, NEW.deleted_at);
  ELSE
    previous_fields := to_jsonb(OLD) - 'field_versions';
    next_fields := to_jsonb(NEW) - 'field_versions';
  END IF;
  NEW.field_versions := OLD.field_versions;
  FOR field_name IN SELECT key FROM jsonb_object_keys(previous_fields || next_fields) AS keys(key) LOOP
    IF previous_fields->field_name IS DISTINCT FROM next_fields->field_name THEN
      NEW.field_versions := jsonb_set(NEW.field_versions, ARRAY[field_name],
        to_jsonb(COALESCE((OLD.field_versions->>field_name)::bigint, 0) + 1));
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP FUNCTION fair_shifts_person_fields(jsonb, text, text, timestamptz);--> statement-breakpoint
ALTER TABLE "soldiers" DROP CONSTRAINT "soldiers_personal_number_unique";--> statement-breakpoint
ALTER TABLE "soldiers" DROP COLUMN "personal_number";
