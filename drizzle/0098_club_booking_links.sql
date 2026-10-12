-- Warehaus's own booking page (DECIDING rule 36), from data/clubs.json. The owner chose on 12 October
-- 2026: "Yes, Warehaus only". warehaus.club's own script links "BOOK A COURT" to Setpoint, so that page
-- is the club's public booking page. Only a row the directory owns and nobody claimed, as in 0097.
UPDATE "clubs" SET
  "booking_url" = coalesce(v.booking_url, "clubs"."booking_url"),
  "booking_platform" = coalesce(v.booking_platform, "clubs"."booking_platform"),
  "website" = coalesce(v.website, "clubs"."website"),
  "updated_at" = now()
FROM (VALUES
  ('warehaus', 'https://book.getsetpoint.io/checkout/warehaus-club', 'setpoint', 'https://warehaus.club/')
) AS v (slug, booking_url, booking_platform, website)
WHERE "clubs"."slug" = v.slug AND "clubs"."source" = 'directory' AND "clubs"."claimed_by" IS NULL;
