CREATE TABLE "error_events" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"path" text,
	"count" integer DEFAULT 1 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fixed_at" timestamp with time zone,
	"fix_note" text
);
--> statement-breakpoint
CREATE INDEX "error_events_last_idx" ON "error_events" USING btree ("last_at");