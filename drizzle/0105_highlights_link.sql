ALTER TABLE "events" ADD COLUMN "highlights_url" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "highlights_by" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_highlights_by_players_id_fk" FOREIGN KEY ("highlights_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;