CREATE TYPE "public"."group_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"role" "group_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_player_id_pk" PRIMARY KEY("group_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(6) NOT NULL,
	"name" text NOT NULL,
	"creator_player_id" uuid NOT NULL,
	"venue_name" text,
	"venue_map_url" text,
	"court" text,
	"tz" text NOT NULL,
	"type" "event_type" DEFAULT 'match' NOT NULL,
	"capacity" integer DEFAULT 4 NOT NULL,
	"when_full" "when_full" DEFAULT 'waitlist' NOT NULL,
	"level_min" real,
	"level_max" real,
	"recur_dow" integer,
	"recur_time" text,
	"recur_lead_days" integer DEFAULT 5 NOT NULL,
	"recur_last_created_for" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_creator_player_id_players_id_fk" FOREIGN KEY ("creator_player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_members_player_idx" ON "group_members" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_code_idx" ON "groups" USING btree ("code");--> statement-breakpoint
CREATE INDEX "groups_creator_idx" ON "groups" USING btree ("creator_player_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_group_idx" ON "events" USING btree ("group_id");