CREATE TABLE "telegram_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"kind" text DEFAULT 'card' NOT NULL,
	"rendered" text,
	"complete_noted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_chats" (
	"chat_id" bigint PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"tz" text,
	"venue_name" text,
	"group_id" uuid,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "telegram_reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "telegram_id" bigint;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "telegram_username" text;--> statement-breakpoint
ALTER TABLE "telegram_cards" ADD CONSTRAINT "telegram_cards_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_cards" ADD CONSTRAINT "telegram_cards_chat_id_telegram_chats_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."telegram_chats"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_cards_event_chat_kind_idx" ON "telegram_cards" USING btree ("event_id","chat_id","kind");--> statement-breakpoint
CREATE INDEX "telegram_cards_event_idx" ON "telegram_cards" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_telegram_id_idx" ON "players" USING btree ("telegram_id") WHERE "players"."telegram_id" is not null;