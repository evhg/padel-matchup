ALTER TABLE "players" ALTER COLUMN "ranking_opt_in" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "share_heart_rate" SET DEFAULT true;--> statement-breakpoint
-- The owner, 23 November 2026: rankings and the heart rate are on for everybody. A row that is off today
-- is off because off was the default, so every row of a living record turns on once; from here a player turns it off.
-- A deleted account stays out of every ranking: its row is kept as "Deleted player".
UPDATE "players" SET "ranking_opt_in" = true, "share_heart_rate" = true WHERE "display_name" <> 'Deleted player';
