CREATE TABLE "research_cache" (
	"hash" text PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_finds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"city" text,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"title" text NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"query_key" text NOT NULL,
	"score" real,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"instagram" text,
	"phone" text,
	"extracted_at" timestamp with time zone,
	"seen" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"key" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	"results" integer DEFAULT 0 NOT NULL,
	"new_items" integer DEFAULT 0 NOT NULL,
	"empty_streak" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "research_finds_url_idx" ON "research_finds" USING btree ("url");--> statement-breakpoint
CREATE INDEX "research_finds_kind_city_idx" ON "research_finds" USING btree ("kind","city");--> statement-breakpoint
ALTER TABLE "research_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "research_cache" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "research_finds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "research_finds" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "research_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "research_runs" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
