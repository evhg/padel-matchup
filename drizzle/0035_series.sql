CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"organizer_player_id" uuid NOT NULL,
	"tz" text NOT NULL,
	"venue_name" text,
	"venue_map_url" text,
	"venue_slug" text,
	"format" text DEFAULT 'americano' NOT NULL,
	"capacity" integer NOT NULL,
	"courts" integer,
	"points_per_match" integer,
	"court_names" jsonb,
	"level_min" real,
	"level_max" real,
	"level_verified_only" boolean DEFAULT false NOT NULL,
	"when_full" text DEFAULT 'waitlist' NOT NULL,
	"cost" text,
	"booking_url" text,
	"dow" integer NOT NULL,
	"time" text NOT NULL,
	"every" text DEFAULT 'week' NOT NULL,
	"nth" integer,
	"anchor_at" timestamp with time zone NOT NULL,
	"lead_days" integer DEFAULT 6 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_created_for" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_organizer_player_id_players_id_fk" FOREIGN KEY ("organizer_player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "series_slug_idx" ON "series" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "series_organizer_idx" ON "series" USING btree ("organizer_player_id");--> statement-breakpoint
CREATE INDEX "series_venue_idx" ON "series" USING btree ("venue_slug");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_series_idx" ON "events" USING btree ("series_id","starts_at");--> statement-breakpoint
ALTER TABLE "series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "series" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
