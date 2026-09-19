CREATE TABLE "competition_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"name" text NOT NULL,
	"level_min" real,
	"level_max" real,
	"max_pairs" integer DEFAULT 16 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competition_pairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"p1_player_id" uuid NOT NULL,
	"p2_player_id" uuid NOT NULL,
	"claim_token" text,
	"status" text DEFAULT 'entered' NOT NULL,
	"position" integer NOT NULL,
	"seed" integer,
	"wildcard" boolean DEFAULT false NOT NULL,
	"paid" boolean DEFAULT false NOT NULL,
	"entered_by_player_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "competitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"organizer_player_id" uuid NOT NULL,
	"tz" text NOT NULL,
	"venue_name" text,
	"venue_slug" text,
	"city" text,
	"starts_on" text NOT NULL,
	"ends_on" text NOT NULL,
	"entry_note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"max_categories_per_player" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competition_categories" ADD CONSTRAINT "competition_categories_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_pairs" ADD CONSTRAINT "competition_pairs_category_id_competition_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."competition_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_pairs" ADD CONSTRAINT "competition_pairs_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_pairs" ADD CONSTRAINT "competition_pairs_p1_player_id_players_id_fk" FOREIGN KEY ("p1_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_pairs" ADD CONSTRAINT "competition_pairs_p2_player_id_players_id_fk" FOREIGN KEY ("p2_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_pairs" ADD CONSTRAINT "competition_pairs_entered_by_player_id_players_id_fk" FOREIGN KEY ("entered_by_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_organizer_player_id_players_id_fk" FOREIGN KEY ("organizer_player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competition_categories_comp_idx" ON "competition_categories" USING btree ("competition_id","position");--> statement-breakpoint
CREATE INDEX "competition_pairs_category_idx" ON "competition_pairs" USING btree ("category_id","status","position");--> statement-breakpoint
CREATE INDEX "competition_pairs_p1_idx" ON "competition_pairs" USING btree ("competition_id","p1_player_id");--> statement-breakpoint
CREATE INDEX "competition_pairs_p2_idx" ON "competition_pairs" USING btree ("competition_id","p2_player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competition_pairs_claim_idx" ON "competition_pairs" USING btree ("claim_token");--> statement-breakpoint
CREATE UNIQUE INDEX "competitions_slug_idx" ON "competitions" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "competitions_organizer_idx" ON "competitions" USING btree ("organizer_player_id");--> statement-breakpoint
CREATE INDEX "competitions_dates_idx" ON "competitions" USING btree ("status","ends_on");--> statement-breakpoint
ALTER TABLE "competitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "competitions" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "competitions" TO "kicksmash";--> statement-breakpoint
ALTER TABLE "competition_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "competition_categories" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "competition_categories" TO "kicksmash";--> statement-breakpoint
ALTER TABLE "competition_pairs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "competition_pairs" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "competition_pairs" TO "kicksmash";
