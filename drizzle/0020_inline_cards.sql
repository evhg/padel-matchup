CREATE TABLE "telegram_inline_cards" (
	"inline_message_id" text PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"rendered" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_inline_cards" ADD CONSTRAINT "telegram_inline_cards_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_inline_cards_event_idx" ON "telegram_inline_cards" USING btree ("event_id");