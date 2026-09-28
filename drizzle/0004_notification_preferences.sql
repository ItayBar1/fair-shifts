ALTER TABLE "email_outbox" ADD COLUMN "reminder_hours" integer;--> statement-breakpoint
-- Preferences saved before decision 162 were explicit personal choices. Map them to the
-- per-type email switches; keep only whole reminder hours 1-168, at most three.
UPDATE "records" SET "data" = jsonb_build_object(
  'accountId', "data"->'accountId',
  'custom', true,
  'reminderHours', coalesce((
    SELECT jsonb_agg(kept.hour ORDER BY kept.hour DESC)
    FROM (
      SELECT DISTINCT value::int AS hour
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof("data"->'reminderHours') = 'array'
          THEN "data"->'reminderHours' ELSE '[24, 2]'::jsonb END
      )
      WHERE value ~ '^[0-9]{1,3}$' AND value::int BETWEEN 1 AND 168
      ORDER BY hour DESC
      LIMIT 3
    ) AS kept
  ), '[]'::jsonb),
  'email', jsonb_build_object(
    'dutyReminder', coalesce(("data"->>'emailEnabled')::boolean, true),
    'roundOpening', coalesce(("data"->>'emailEnabled')::boolean, true) AND coalesce(("data"->>'roundOpening')::boolean, true),
    'roundClosing', coalesce(("data"->>'emailEnabled')::boolean, true) AND coalesce(("data"->>'roundClosing')::boolean, true),
    'publication', coalesce(("data"->>'emailEnabled')::boolean, true) AND coalesce(("data"->>'publishedChanges')::boolean, true)
  )
)
WHERE "kind" = 'settings' AND NOT ("data" ? 'email');
