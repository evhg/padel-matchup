CREATE TABLE "competition_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"group_label" text,
	"round" integer NOT NULL,
	"position" integer NOT NULL,
	"pair_a_id" uuid,
	"pair_b_id" uuid,
	"source_a" text,
	"source_b" text,
	"bye" boolean DEFAULT false NOT NULL,
	"score_a" jsonb,
	"score_b" jsonb,
	"winner" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"court_name" text,
	"scheduled_at" timestamp with time zone,
	"stream_url" text,
	"entered_by_player_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competition_categories" ADD COLUMN "format" text DEFAULT 'groups_knockout' NOT NULL;--> statement-breakpoint
ALTER TABLE "competition_categories" ADD COLUMN "group_size" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "competition_categories" ADD COLUMN "groups_through" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "competition_categories" ADD COLUMN "consolation" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "competition_categories" ADD COLUMN "qualifying_spots" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "competition_categories" ADD COLUMN "scoring_group" text DEFAULT 'set6tb' NOT NULL;--> statement-breakpoint
ALTER TABLE "competition_categories" ADD COLUMN "scoring_knockout" text DEFAULT 'set9' NOT NULL;--> statement-breakpoint
ALTER TABLE "competition_categories" ADD COLUMN "scoring_final" text DEFAULT 'sets2stb' NOT NULL;--> statement-breakpoint
ALTER TABLE "competition_categories" ADD COLUMN "golden_point" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "competition_categories" ADD COLUMN "draw_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "competition_categories" ADD COLUMN "drawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competition_pairs" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "court_names" jsonb;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "day_start" text;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "day_end" text;--> statement-breakpoint
ALTER TABLE "competition_matches" ADD CONSTRAINT "competition_matches_category_id_competition_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."competition_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_matches" ADD CONSTRAINT "competition_matches_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_matches" ADD CONSTRAINT "competition_matches_pair_a_id_competition_pairs_id_fk" FOREIGN KEY ("pair_a_id") REFERENCES "public"."competition_pairs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_matches" ADD CONSTRAINT "competition_matches_pair_b_id_competition_pairs_id_fk" FOREIGN KEY ("pair_b_id") REFERENCES "public"."competition_pairs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_matches" ADD CONSTRAINT "competition_matches_entered_by_player_id_players_id_fk" FOREIGN KEY ("entered_by_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competition_matches_category_idx" ON "competition_matches" USING btree ("category_id","phase","round","position");--> statement-breakpoint
CREATE INDEX "competition_matches_schedule_idx" ON "competition_matches" USING btree ("competition_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "competition_matches_pair_a_idx" ON "competition_matches" USING btree ("pair_a_id");--> statement-breakpoint
CREATE INDEX "competition_matches_pair_b_idx" ON "competition_matches" USING btree ("pair_b_id");
--> statement-breakpoint
ALTER TABLE "competition_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "competition_matches" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "competition_matches" TO "kicksmash";
