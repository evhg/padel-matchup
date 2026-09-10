ALTER TABLE "coaches" ADD COLUMN "founding_tz" text;--> statement-breakpoint
-- A place already earned remembers its city.
UPDATE "coaches" SET "founding_tz" = "tz" WHERE "founding_at" IS NOT NULL AND "founding_tz" IS NULL;
