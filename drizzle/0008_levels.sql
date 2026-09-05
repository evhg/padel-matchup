CREATE TYPE "public"."join_request_status" AS ENUM('pending', 'approved', 'declined', 'withdrawn');--> statement-breakpoint
ALTER TYPE "public"."activity_verb" ADD VALUE 'requested';--> statement-breakpoint
ALTER TYPE "public"."activity_verb" ADD VALUE 'approved';--> statement-breakpoint
ALTER TYPE "public"."activity_verb" ADD VALUE 'rejected';--> statement-breakpoint
CREATE TABLE "join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"level" real,
	"status" "join_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_player_id" uuid
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "level_min" real;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "level_max" real;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "levels_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "level" real;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "level_source" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "level_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "level_log" jsonb;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_decided_by_player_id_players_id_fk" FOREIGN KEY ("decided_by_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_event_player_idx" ON "join_requests" USING btree ("event_id","player_id");--> statement-breakpoint
CREATE INDEX "join_requests_event_idx" ON "join_requests" USING btree ("event_id");