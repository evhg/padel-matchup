ALTER TABLE "events" ADD COLUMN "public_listing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "venue_slug" text;--> statement-breakpoint
CREATE INDEX "events_venue_slug_idx" ON "events" USING btree ("venue_slug","starts_at");--> statement-breakpoint
UPDATE "events" SET "venue_slug" = NULLIF(trim(both '-' from regexp_replace(lower("venue_name"), '[^a-z0-9]+', '-', 'g')), '') WHERE "venue_name" IS NOT NULL;
