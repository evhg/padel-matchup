ALTER TABLE "lessons" ADD COLUMN "venue_slug" text;--> statement-breakpoint
CREATE INDEX "lessons_venue_idx" ON "lessons" USING btree ("venue_slug","starts_at");--> statement-breakpoint
-- A coach's clubs were free text and nothing else, so "warehaus" and "Warehaus" were two different
-- places and no club could be matched to either. club_slugs already existed for the picked ones and
-- was empty everywhere, because a picker with no clubs in it offers nothing. This fills it from the
-- names already typed, by the same rule a match's venue_slug follows: lowercase, non-alphanumerics
-- to hyphens, trimmed. Names, not slugs, stay what the coach sees.
UPDATE "coaches"
SET "club_slugs" = (
  SELECT coalesce(jsonb_agg(DISTINCT s), '[]'::jsonb)
  FROM (
    SELECT trim(both '-' from regexp_replace(lower(n #>> '{}'), '[^a-z0-9]+', '-', 'g')) AS s
    FROM jsonb_array_elements("coaches"."club_names") AS n
  ) AS slugs
  WHERE s <> ''
)
WHERE jsonb_array_length("club_slugs") = 0 AND jsonb_array_length("club_names") > 0;--> statement-breakpoint
-- "Which coaches teach at this club?" reads a jsonb array with containment. Two coaches today, but
-- the question runs on every club page view, so it gets its index now rather than later (rule 12).
CREATE INDEX "coaches_club_slugs_idx" ON "coaches" USING gin ("club_slugs" jsonb_path_ops);
