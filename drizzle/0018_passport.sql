ALTER TABLE "players" ADD COLUMN "public_profile" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "public_slug" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "public_since" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "players_public_slug_idx" ON "players" USING btree ("public_slug") WHERE "players"."public_slug" is not null;