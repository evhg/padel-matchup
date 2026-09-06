CREATE TABLE "listen_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"author" text,
	"thread_id" text,
	"posted_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"kind" text,
	"language" text,
	"draft" text,
	"draft_reason" text,
	"draft_model" text,
	"drafted_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"notify_message_id" bigint,
	"decided_at" timestamp with time zone,
	"posted_reply_at" timestamp with time zone,
	"reply_url" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "listen_items_source_external_idx" ON "listen_items" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "listen_items_status_idx" ON "listen_items" USING btree ("status","posted_at");