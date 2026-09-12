CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"actor_player_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"code" text,
	"city" text,
	"venue_slug" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "facts_at_idx" ON "facts" USING btree ("at");--> statement-breakpoint
CREATE INDEX "facts_kind_at_idx" ON "facts" USING btree ("kind","at");--> statement-breakpoint
CREATE INDEX "facts_subject_idx" ON "facts" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "facts_actor_idx" ON "facts" USING btree ("actor_player_id","at");--> statement-breakpoint
ALTER TABLE "facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "facts" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);