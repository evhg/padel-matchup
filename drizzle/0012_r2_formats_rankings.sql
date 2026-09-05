ALTER TABLE "events" ADD COLUMN "format" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "level_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "level_verified_by" uuid;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "level_verified_level" real;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "ranking_opt_in" boolean DEFAULT false NOT NULL;