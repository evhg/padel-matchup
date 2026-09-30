-- How long each event lasts, in minutes (src/lib/domain/matchLength.ts). The organiser picks 60, 90 or 120.
-- The owner decided on 30 September 2026: 90 is the default, and every existing match becomes 90.
-- A tournament keeps the two hours every event had until now, so nothing about a tournament changes today.
ALTER TABLE "events" ADD COLUMN "duration_minutes" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
UPDATE "events" SET "duration_minutes" = 120 WHERE "type" = 'tournament';
