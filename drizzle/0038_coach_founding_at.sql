ALTER TABLE "coaches" ADD COLUMN "founding_at" timestamp with time zone;--> statement-breakpoint
-- The coaches already listed keep the places they earned: the first ten per city by the day they arrived.
UPDATE "coaches" c SET "founding_at" = c."created_at" FROM (SELECT id, row_number() OVER (PARTITION BY tz ORDER BY created_at) AS rn FROM "coaches" WHERE is_public AND archived_at IS NULL) r WHERE r.id = c.id AND r.rn <= 10;
