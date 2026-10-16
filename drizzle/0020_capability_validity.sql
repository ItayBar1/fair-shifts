-- Decision 224: qualifications and capabilities are one concept, a capability with
-- optional start and end dates. A dated qualification keeps its dates; a capability
-- from before had no dates and stays permanent. Eligibility does not change.
UPDATE "soldiers" SET "data" = ("data" - 'qualifications') || jsonb_build_object(
  'capabilities',
  COALESCE((
    SELECT jsonb_agg(
      CASE WHEN jsonb_typeof(c.value) = 'string'
        THEN jsonb_build_object('capabilityId', c.value #>> '{}')
        ELSE c.value
      END ORDER BY c.position)
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof("data"->'capabilities') = 'array' THEN "data"->'capabilities' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS c(value, position)
  ), '[]'::jsonb)
  || COALESCE((
    SELECT jsonb_agg(
      (q.value - 'qualificationId') || jsonb_build_object('capabilityId', q.value->'qualificationId')
      ORDER BY q.position)
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof("data"->'qualifications') = 'array' THEN "data"->'qualifications' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS q(value, position)
  ), '[]'::jsonb)
)
WHERE "data" ? 'qualifications' OR "data"->'capabilities' @? '$[*] ? (@.type() == "string")';--> statement-breakpoint
UPDATE "records" SET "data" = jsonb_set("data", '{kind}', '"capability"')
WHERE "kind" = 'eligibility_catalog' AND "data"->>'kind' = 'qualification';--> statement-breakpoint
-- Required qualifications join the required capabilities wherever conditions are kept:
-- duty types, duty instances, seats and workflow records such as pending proposals.
CREATE FUNCTION "fs_merge_qualifications"(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  merged jsonb;
BEGIN
  IF jsonb_typeof(j) = 'object' THEN
    merged := COALESCE((
      SELECT jsonb_object_agg(e.key, fs_merge_qualifications(e.value))
      FROM jsonb_each(j) AS e
      WHERE e.key <> 'qualificationIds'
    ), '{}'::jsonb);
    IF jsonb_typeof(j->'qualificationIds') = 'array' AND jsonb_array_length(j->'qualificationIds') > 0 THEN
      merged := merged || jsonb_build_object('capabilityIds', (
        SELECT jsonb_agg(DISTINCT ids.value)
        FROM (
          SELECT value FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(j->'capabilityIds') = 'array' THEN j->'capabilityIds' ELSE '[]'::jsonb END
          )
          UNION
          SELECT value FROM jsonb_array_elements(j->'qualificationIds')
        ) AS ids
      ));
    END IF;
    RETURN merged;
  ELSIF jsonb_typeof(j) = 'array' THEN
    RETURN COALESCE((
      SELECT jsonb_agg(fs_merge_qualifications(x.value) ORDER BY x.position)
      FROM jsonb_array_elements(j) WITH ORDINALITY AS x(value, position)
    ), '[]'::jsonb);
  END IF;
  RETURN j;
END
$$;--> statement-breakpoint
UPDATE "duty_types" SET "data" = fs_merge_qualifications("data")
WHERE "data"::text LIKE '%"qualificationIds"%';--> statement-breakpoint
UPDATE "duties" SET "data" = fs_merge_qualifications("data")
WHERE "data"::text LIKE '%"qualificationIds"%';--> statement-breakpoint
UPDATE "duty_slots" SET "data" = fs_merge_qualifications("data")
WHERE "data"::text LIKE '%"qualificationIds"%';--> statement-breakpoint
-- The audit trail keeps what was recorded at the time.
UPDATE "records" SET "data" = fs_merge_qualifications("data")
WHERE "kind" <> 'audit' AND "data"::text LIKE '%"qualificationIds"%';--> statement-breakpoint
DROP FUNCTION "fs_merge_qualifications"(jsonb);
