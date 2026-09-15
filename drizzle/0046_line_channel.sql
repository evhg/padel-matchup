CREATE TABLE "line_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"room_id" text NOT NULL,
	"message_id" text NOT NULL,
	"kind" text DEFAULT 'card' NOT NULL,
	"rendered" text,
	"complete_noted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_rooms" (
	"room_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"tz" text,
	"venue_name" text,
	"group_id" uuid,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "line_id" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "line_display_name" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "line_reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "line_cards" ADD CONSTRAINT "line_cards_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_cards" ADD CONSTRAINT "line_cards_room_id_line_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."line_rooms"("room_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_rooms" ADD CONSTRAINT "line_rooms_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "line_cards_event_room_kind_idx" ON "line_cards" USING btree ("event_id","room_id","kind");--> statement-breakpoint
CREATE INDEX "line_cards_event_idx" ON "line_cards" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_line_id_idx" ON "players" USING btree ("line_id") WHERE "players"."line_id" is not null;--> statement-breakpoint
ALTER TABLE "line_rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "line_rooms" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "line_cards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "line_cards" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
