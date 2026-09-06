CREATE TABLE "discord_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"kind" text DEFAULT 'card' NOT NULL,
	"rendered" text,
	"complete_noted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discord_channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"name" text,
	"guild_name" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"tz" text,
	"venue_name" text,
	"last_message_id" text,
	"listen" boolean DEFAULT true NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "discord_reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "discord_id" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "discord_username" text;--> statement-breakpoint
ALTER TABLE "discord_cards" ADD CONSTRAINT "discord_cards_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_cards" ADD CONSTRAINT "discord_cards_channel_id_discord_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."discord_channels"("channel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discord_cards_event_channel_kind_idx" ON "discord_cards" USING btree ("event_id","channel_id","kind");--> statement-breakpoint
CREATE INDEX "discord_cards_event_idx" ON "discord_cards" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_discord_id_idx" ON "players" USING btree ("discord_id") WHERE "players"."discord_id" is not null;