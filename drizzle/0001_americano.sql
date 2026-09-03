CREATE TABLE "tournament_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"court" integer NOT NULL,
	"a1" uuid NOT NULL,
	"a2" uuid NOT NULL,
	"b1" uuid NOT NULL,
	"b2" uuid NOT NULL,
	"side_a" integer,
	"side_b" integer,
	"entered_by_player_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournament_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"round_number" integer NOT NULL,
	"resting" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "venue_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "courts" integer;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "points_per_match" integer;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_round_id_tournament_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."tournament_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_a1_players_id_fk" FOREIGN KEY ("a1") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_a2_players_id_fk" FOREIGN KEY ("a2") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_b1_players_id_fk" FOREIGN KEY ("b1") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_b2_players_id_fk" FOREIGN KEY ("b2") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_entered_by_player_id_players_id_fk" FOREIGN KEY ("entered_by_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_rounds" ADD CONSTRAINT "tournament_rounds_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_matches_round_court_idx" ON "tournament_matches" USING btree ("round_id","court");--> statement-breakpoint
CREATE INDEX "tournament_matches_round_idx" ON "tournament_matches" USING btree ("round_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_rounds_event_round_idx" ON "tournament_rounds" USING btree ("event_id","round_number");