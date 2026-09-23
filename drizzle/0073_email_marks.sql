CREATE TABLE "email_marks" (
	"address" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"soft_count" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"marked_at" timestamp with time zone,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_marks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "email_marks" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "email_marks" TO "kicksmash";