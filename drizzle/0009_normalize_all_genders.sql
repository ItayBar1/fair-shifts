-- Decision 198: a gender condition with every gender is no condition. New saves store
-- an empty list; this normalizes lists saved before, without raising any duty version.
CREATE FUNCTION "fs_normalize_genders"(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(j) = 'object' THEN
    RETURN COALESCE((
      SELECT jsonb_object_agg(
        e.key,
        CASE
          WHEN e.key = 'genders' AND jsonb_typeof(e.value) = 'array'
            AND e.value @> '["male","female","other"]'::jsonb THEN '[]'::jsonb
          ELSE fs_normalize_genders(e.value)
        END
      )
      FROM jsonb_each(j) AS e
    ), '{}'::jsonb);
  ELSIF jsonb_typeof(j) = 'array' THEN
    RETURN COALESCE((
      SELECT jsonb_agg(fs_normalize_genders(x.value) ORDER BY x.position)
      FROM jsonb_array_elements(j) WITH ORDINALITY AS x(value, position)
    ), '[]'::jsonb);
  END IF;
  RETURN j;
END
$$;--> statement-breakpoint
UPDATE "duty_types" SET "data" = fs_normalize_genders("data")
WHERE "data"::text LIKE '%"genders"%' AND fs_normalize_genders("data") IS DISTINCT FROM "data";--> statement-breakpoint
UPDATE "duties" SET "data" = fs_normalize_genders("data")
WHERE "data"::text LIKE '%"genders"%' AND fs_normalize_genders("data") IS DISTINCT FROM "data";--> statement-breakpoint
UPDATE "duty_slots" SET "data" = fs_normalize_genders("data")
WHERE "data"::text LIKE '%"genders"%' AND fs_normalize_genders("data") IS DISTINCT FROM "data";--> statement-breakpoint
UPDATE "records" SET "data" = fs_normalize_genders("data")
WHERE "data"::text LIKE '%"genders"%' AND fs_normalize_genders("data") IS DISTINCT FROM "data";--> statement-breakpoint
-- A seat flagged "gender" while no gender condition is left on its duty or role was
-- flagged only because of the bug. Other reasons stay; each cleared flag is logged.
WITH cleared AS (
  UPDATE "assignments" AS a
  SET "version" = a."version" + 1,
      "updated_at" = now(),
      "data" = jsonb_set(
        a."data" || jsonb_build_object('version', a."version" + 1),
        '{needsAttention}',
        COALESCE((
          SELECT jsonb_agg(reason)
          FROM jsonb_array_elements(a."data"->'needsAttention') AS reason
          WHERE reason <> '"gender"'::jsonb
        ), '[]'::jsonb)
      )
  FROM "duties" AS d
  WHERE d."id" = a."duty_id"
    AND a."status" = 'reserved'
    AND a."data"->'needsAttention' @> '["gender"]'::jsonb
    AND COALESCE(jsonb_array_length(d."data"->'requirements'->'genders'), 0) = 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(d."data"->'slots') AS slot
      WHERE slot->>'id' = a."slot_id"::text
        AND COALESCE(jsonb_array_length(slot->'requirements'->'genders'), 0) > 0
    )
  RETURNING a."id", a."duty_id", a."soldier_id"
)
INSERT INTO "records" ("id", "kind", "data")
SELECT gen_random_uuid(), 'audit', jsonb_build_object(
  'actorId', 'system',
  'actorName', 'המערכת',
  'action', 'assignment.gender_flag.clear',
  'targetId', cleared."id",
  'assignmentId', cleared."id",
  'dutyId', cleared."duty_id",
  'soldierId', cleared."soldier_id",
  'reason', 'סימון ״דורש טיפול״ של מגדר נוקה: אין עוד תנאי מגדר בתורנות או בתפקיד (הכרעה 198)'
)
FROM cleared;--> statement-breakpoint
DROP FUNCTION "fs_normalize_genders"(jsonb);
