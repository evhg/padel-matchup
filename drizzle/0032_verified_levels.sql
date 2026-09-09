CREATE TABLE "level_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"coach_id" uuid,
	"club_slug" text,
	"level" real,
	"event_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_player_id" uuid,
	"decided_level" real
);
--> statement-breakpoint
ALTER TABLE "club_slots" ADD COLUMN "verified_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "level_verified_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "level_verified_source" text;--> statement-breakpoint
ALTER TABLE "level_checks" ADD CONSTRAINT "level_checks_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_checks" ADD CONSTRAINT "level_checks_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_checks" ADD CONSTRAINT "level_checks_club_slug_clubs_slug_fk" FOREIGN KEY ("club_slug") REFERENCES "public"."clubs"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_checks" ADD CONSTRAINT "level_checks_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_checks" ADD CONSTRAINT "level_checks_decided_by_player_id_players_id_fk" FOREIGN KEY ("decided_by_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "level_checks_player_idx" ON "level_checks" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "level_checks_coach_idx" ON "level_checks" USING btree ("coach_id");--> statement-breakpoint
CREATE INDEX "level_checks_club_idx" ON "level_checks" USING btree ("club_slug");--> statement-breakpoint
ALTER TABLE "level_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "level_checks" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
