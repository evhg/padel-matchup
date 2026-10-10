-- Notices, the owner's decision D (9 October 2026): "A switch for each notice kind, quiet hours, and an inbox".
-- players.notice_kinds holds only the kinds a player set away from the default ('{}' for everybody today: every kind
-- on but the club's new matches, decision B); quiet_from/quiet_to are minutes after midnight in
-- quiet_tz. notices is the inbox: a message key and its params per row, kept ninety days.
-- Additive only (rule 7). The new table is locked like every other (rule 10): Row Level Security, one policy, the grant.
CREATE TABLE "notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"event_id" uuid,
	"key" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "notice_kinds" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "quiet_from" smallint;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "quiet_to" smallint;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "quiet_tz" text;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notices_player_created_idx" ON "notices" USING btree ("player_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notices_due_idx" ON "notices" USING btree ("due_at") WHERE "notices"."delivered_at" is null and "notices"."due_at" is not null;--> statement-breakpoint
CREATE INDEX "notices_created_idx" ON "notices" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "notices" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "notices" TO "kicksmash";
