CREATE TABLE "lab_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page" text NOT NULL,
	"stage" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "lab_runs_created_idx" ON "lab_runs" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "lab_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "lab_runs" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "lab_runs" TO "kicksmash";
