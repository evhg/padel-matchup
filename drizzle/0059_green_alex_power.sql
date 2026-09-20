CREATE TABLE "coach_wants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"city_slug" text NOT NULL,
	"level" real,
	"when_note" text,
	"notified_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coach_wants" ADD CONSTRAINT "coach_wants_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coach_wants_player_city_idx" ON "coach_wants" USING btree ("player_id","city_slug");--> statement-breakpoint
CREATE INDEX "coach_wants_city_idx" ON "coach_wants" USING btree ("city_slug","expires_at");--> statement-breakpoint
ALTER TABLE "coach_wants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "coach_wants" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "coach_wants" TO "kicksmash";