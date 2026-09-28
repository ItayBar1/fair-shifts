ALTER TABLE "soldiers" ADD COLUMN "field_versions" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
CREATE FUNCTION fair_shifts_person_fields(profile jsonb, person_name text, personal_number text, deleted_at timestamptz)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT (profile - 'service' - 'version' - 'currentScore' - 'constraints')
    || COALESCE((SELECT jsonb_object_agg('service.' || key, value) FROM jsonb_each(COALESCE(profile->'service', '{}'::jsonb))), '{}'::jsonb)
    || jsonb_build_object('name', person_name, 'personalNumber', personal_number, 'deletedAt', extract(epoch FROM deleted_at));
$$;
--> statement-breakpoint
CREATE FUNCTION fair_shifts_track_field_versions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_fields jsonb;
  next_fields jsonb;
  field_name text;
BEGIN
  IF TG_TABLE_NAME = 'soldiers' THEN
    previous_fields := fair_shifts_person_fields(OLD.data, OLD.name, OLD.personal_number, OLD.deleted_at);
    next_fields := fair_shifts_person_fields(NEW.data, NEW.name, NEW.personal_number, NEW.deleted_at);
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
$$;
--> statement-breakpoint
CREATE TRIGGER soldier_field_versions BEFORE UPDATE ON soldiers
  FOR EACH ROW EXECUTE FUNCTION fair_shifts_track_field_versions();
--> statement-breakpoint
CREATE TRIGGER contact_field_versions BEFORE UPDATE ON soldier_contacts
  FOR EACH ROW EXECUTE FUNCTION fair_shifts_track_field_versions();
