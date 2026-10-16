-- Decision 223: rank tracks are managed on their own, and a rank may belong to
-- several tracks with a place in each. Every track name already used by a rank
-- becomes a track record; each rank keeps its one track and order as a list.
INSERT INTO "records" ("id", "kind", "data")
SELECT gen_random_uuid(), 'rank_track', jsonb_build_object(
  'name', t."name",
  'source', 'נוצר מקטלוג הדרגות במעבר לניהול מסלולים נפרד'
)
FROM (
  SELECT DISTINCT "data"->>'track' AS "name"
  FROM "records"
  WHERE "kind" = 'rank_catalog' AND coalesce("data"->>'track', '') <> ''
) AS t
WHERE NOT EXISTS (
  SELECT 1 FROM "records" AS r
  WHERE r."kind" = 'rank_track' AND r."data"->>'name' = t."name"
);--> statement-breakpoint
UPDATE "records"
SET "data" = ("data" - 'track' - 'order') || jsonb_build_object(
  'tracks', jsonb_build_array(jsonb_build_object(
    'track', "data"->'track',
    'order', ("data"->>'order')::int
  ))
)
WHERE "kind" = 'rank_catalog' AND "data" ? 'track' AND NOT "data" ? 'tracks';
