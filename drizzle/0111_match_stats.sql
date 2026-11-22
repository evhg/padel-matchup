CREATE TABLE "match_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"partner_id" uuid,
	"kind" text NOT NULL,
	"value" real NOT NULL,
	"margin" real,
	"venue_slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "share_heart_rate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "match_stats" ADD CONSTRAINT "match_stats_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_stats" ADD CONSTRAINT "match_stats_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_stats" ADD CONSTRAINT "match_stats_partner_id_players_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "match_stats_event_player_kind_idx" ON "match_stats" USING btree ("event_id","player_id","kind");--> statement-breakpoint
CREATE INDEX "match_stats_player_idx" ON "match_stats" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "match_stats_venue_kind_value_idx" ON "match_stats" USING btree ("venue_slug","kind","value");--> statement-breakpoint
ALTER TABLE "match_stats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "match_stats" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "match_stats" TO "kicksmash";
