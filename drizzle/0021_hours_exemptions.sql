-- Decision 226: a personal hours limit becomes an hours exemption from the catalog.
-- Each distinct set of windows gets one catalog entry; every limit becomes a dated
-- exemption of the soldier that carries those windows, and an approval given for
-- the old limit now refers to the catalog entry. Running it again changes nothing.
DO $$
DECLARE
  catalog jsonb := '{}'::jsonb;
  limits jsonb := '{}'::jsonb;
  windows jsonb;
  n integer := 0;
  entry_id uuid;
BEGIN
  FOR windows IN
    SELECT DISTINCT l.value->'windows'
    FROM "soldiers" s,
      jsonb_array_elements(
        CASE WHEN jsonb_typeof(s."data"->'allowedHours') = 'array' THEN s."data"->'allowedHours' ELSE '[]'::jsonb END
      ) AS l(value)
    ORDER BY 1
  LOOP
    n := n + 1;
    entry_id := gen_random_uuid();
    INSERT INTO "records" ("id", "kind", "data") VALUES (entry_id, 'eligibility_catalog', jsonb_build_object(
      'kind', 'exemption',
      'name', 'הגבלת שעות ' || n,
      'description', 'הוסבה מהגבלת שעות אישית',
      'windows', windows
    ));
    catalog := catalog || jsonb_build_object(windows::text, entry_id);
  END LOOP;
  IF n = 0 THEN
    RETURN;
  END IF;
  SELECT COALESCE(jsonb_object_agg(l.value->>'id', catalog->>((l.value->'windows')::text)), '{}'::jsonb)
  INTO limits
  FROM "soldiers" s,
    jsonb_array_elements(
      CASE WHEN jsonb_typeof(s."data"->'allowedHours') = 'array' THEN s."data"->'allowedHours' ELSE '[]'::jsonb END
    ) AS l(value)
  WHERE l.value ? 'id';
  UPDATE "soldiers" s SET "data" = (s."data" - 'allowedHours') || jsonb_build_object(
    'exemptions',
    COALESCE(CASE WHEN jsonb_typeof(s."data"->'exemptions') = 'array' THEN s."data"->'exemptions' END, '[]'::jsonb)
    || COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'exemptionId', catalog->>((l.value->'windows')::text),
        'start', l.value->>'start',
        'end', l.value->>'end',
        'windows', l.value->'windows'
      ) ORDER BY l.position)
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(s."data"->'allowedHours') = 'array' THEN s."data"->'allowedHours' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS l(value, position)
    ), '[]'::jsonb)
  )
  WHERE s."data" ? 'allowedHours';
  UPDATE "assignments" a SET "data" = jsonb_set(a."data", '{approvals}', (
    SELECT jsonb_agg(
      CASE WHEN x.value->>'kind' = 'allowed_hours' AND limits ? (x.value->>'referenceId')
        THEN jsonb_set(x.value, '{referenceId}', to_jsonb(limits->>(x.value->>'referenceId')))
        ELSE x.value
      END ORDER BY x.position)
    FROM jsonb_array_elements(a."data"->'approvals') WITH ORDINALITY AS x(value, position)
  ))
  WHERE jsonb_typeof(a."data"->'approvals') = 'array'
    AND a."data"->'approvals' @? '$[*] ? (@.kind == "allowed_hours")';
END
$$;
