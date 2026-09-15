CREATE TABLE "demand_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"weekday" smallint,
	"on_date" date,
	"from_time" text,
	"to_time" text,
	"venue_slug" text,
	"city_slug" text,
	"notified_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "wants_notice_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "demand_venue_idx" ON "demand_signals" USING btree ("venue_slug","expires_at");--> statement-breakpoint
CREATE INDEX "demand_city_idx" ON "demand_signals" USING btree ("city_slug","expires_at");--> statement-breakpoint
CREATE INDEX "demand_player_idx" ON "demand_signals" USING btree ("player_id","expires_at");--> statement-breakpoint
ALTER TABLE "demand_signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "demand_signals" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
