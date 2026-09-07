CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"player_id" uuid,
	"locale" text DEFAULT 'en' NOT NULL,
	"name" text,
	"telegram_chat_id" bigint,
	"telegram_user_id" bigint,
	"telegram_thread_id" integer,
	"telegram_message_id" integer,
	"discord_channel_id" text,
	"discord_user_id" text,
	"discord_guild_id" text,
	"email" text,
	"email_message_id" text,
	"text" text NOT NULL,
	"context" text,
	"status" text DEFAULT 'new' NOT NULL,
	"verdict" text,
	"assessment" text,
	"reply_text" text,
	"replied_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"pr_url" text,
	"messages_sent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_status_idx" ON "feedback" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_tg_user_idx" ON "feedback" USING btree ("telegram_user_id","created_at");