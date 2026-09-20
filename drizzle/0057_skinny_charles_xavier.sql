CREATE TABLE "club_courts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_slug" text NOT NULL,
	"name" text NOT NULL,
	"number" integer,
	"kind" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "club_courts" ADD CONSTRAINT "club_courts_club_slug_clubs_slug_fk" FOREIGN KEY ("club_slug") REFERENCES "public"."clubs"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_courts_club_idx" ON "club_courts" USING btree ("club_slug","position");--> statement-breakpoint
CREATE UNIQUE INDEX "club_courts_name_idx" ON "club_courts" USING btree ("club_slug","name");--> statement-breakpoint
ALTER TABLE "club_courts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "club_courts" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "club_courts" TO "kicksmash";
