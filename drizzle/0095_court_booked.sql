-- "I booked it": who booked the court and when (DECIDING rule 34). The owner, 10 October 2026: "Book"
-- opens the club's own app, "where a player books and pays; Kicksmash then marks the match as booked".
-- Two nullable columns, no backfill, no payment field.
ALTER TABLE "events" ADD COLUMN "court_booked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "court_booked_by" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_court_booked_by_players_id_fk" FOREIGN KEY ("court_booked_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;