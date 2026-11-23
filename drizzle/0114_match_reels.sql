CREATE TABLE "match_reels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text NOT NULL,
	"host" text,
	"reel_token" text NOT NULL,
	"source" text,
	"source_url" text,
	"requested_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "match_reels" ADD CONSTRAINT "match_reels_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_reels" ADD CONSTRAINT "match_reels_requested_by_players_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "match_reels_event_idx" ON "match_reels" USING btree ("event_id");--> statement-breakpoint
ALTER TABLE "match_reels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "match_reels" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "match_reels" TO "kicksmash";
