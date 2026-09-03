CREATE TYPE "public"."activity_verb" AS ENUM('created', 'joined', 'left', 'confirmed', 'declined', 'promoted', 'removed', 'score_entered', 'cancelled', 'updated', 'invited');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('open', 'full', 'cancelled', 'past');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('match', 'tournament');--> statement-breakpoint
CREATE TYPE "public"."slot_kind" AS ENUM('open', 'reserved');--> statement-breakpoint
CREATE TYPE "public"."slot_status" AS ENUM('empty', 'invited', 'confirmed', 'declined', 'joined');--> statement-breakpoint
CREATE TYPE "public"."team" AS ENUM('a', 'b');--> statement-breakpoint
CREATE TYPE "public"."when_full" AS ENUM('waitlist', 'closed');--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"actor_player_id" uuid,
	"verb" "activity_verb" NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(4) NOT NULL,
	"type" "event_type" DEFAULT 'match' NOT NULL,
	"title" text,
	"starts_at" timestamp with time zone NOT NULL,
	"tz" text NOT NULL,
	"venue_name" text NOT NULL,
	"venue_map_url" text,
	"capacity" integer NOT NULL,
	"when_full" "when_full" DEFAULT 'waitlist' NOT NULL,
	"note" text,
	"creator_player_id" uuid NOT NULL,
	"manage_code" varchar(10) NOT NULL,
	"status" "event_status" DEFAULT 'open' NOT NULL,
	"score_locked_by_creator" boolean DEFAULT false NOT NULL,
	"score_reminder_sent" boolean DEFAULT false NOT NULL,
	"ics_sequence" integer DEFAULT 0 NOT NULL,
	"standings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"phone" text,
	"email" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"set_number" integer NOT NULL,
	"side_a" integer NOT NULL,
	"side_b" integer NOT NULL,
	"entered_by_player_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"player_id" uuid,
	"kind" "slot_kind" DEFAULT 'open' NOT NULL,
	"invite_code" varchar(6),
	"status" "slot_status" DEFAULT 'empty' NOT NULL,
	"invited_name" text,
	"invited_email" text,
	"invited_phone" text,
	"position" integer NOT NULL,
	"team" "team",
	"joined_at" timestamp with time zone,
	"invited_at" timestamp with time zone,
	"last_reminded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_player_id" uuid NOT NULL,
	"name" text NOT NULL,
	"map_url" text,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_player_id_players_id_fk" FOREIGN KEY ("actor_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_creator_player_id_players_id_fk" FOREIGN KEY ("creator_player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_entered_by_player_id_players_id_fk" FOREIGN KEY ("entered_by_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_creator_player_id_players_id_fk" FOREIGN KEY ("creator_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_event_idx" ON "activity" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_code_idx" ON "events" USING btree ("code");--> statement-breakpoint
CREATE INDEX "events_creator_idx" ON "events" USING btree ("creator_player_id");--> statement-breakpoint
CREATE INDEX "events_starts_at_idx" ON "events" USING btree ("starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scores_event_set_idx" ON "scores" USING btree ("event_id","set_number");--> statement-breakpoint
CREATE UNIQUE INDEX "slots_event_position_idx" ON "slots" USING btree ("event_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "slots_event_player_idx" ON "slots" USING btree ("event_id","player_id") WHERE "slots"."player_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "slots_invite_code_idx" ON "slots" USING btree ("invite_code") WHERE "slots"."invite_code" is not null;--> statement-breakpoint
CREATE INDEX "slots_player_idx" ON "slots" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "venues_creator_name_idx" ON "venues" USING btree ("creator_player_id","name");