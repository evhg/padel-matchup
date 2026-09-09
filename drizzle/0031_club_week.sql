CREATE TABLE "club_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_slug" text NOT NULL,
	"dow" integer NOT NULL,
	"time" text NOT NULL,
	"type" text DEFAULT 'match' NOT NULL,
	"format" text,
	"capacity" integer DEFAULT 4 NOT NULL,
	"courts" integer,
	"level_min" real,
	"level_max" real,
	"title" text,
	"lead_days" integer DEFAULT 6 NOT NULL,
	"when_full" text DEFAULT 'waitlist' NOT NULL,
	"cost" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_created_for" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "club_slot_id" uuid;--> statement-breakpoint
ALTER TABLE "club_slots" ADD CONSTRAINT "club_slots_club_slug_clubs_slug_fk" FOREIGN KEY ("club_slug") REFERENCES "public"."clubs"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_slots_club_idx" ON "club_slots" USING btree ("club_slug");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_club_slot_id_club_slots_id_fk" FOREIGN KEY ("club_slot_id") REFERENCES "public"."club_slots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_slots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "club_slots" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
