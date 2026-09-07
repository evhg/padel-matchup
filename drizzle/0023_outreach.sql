CREATE TABLE "outreach" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"moment" text,
	"thread_key" text NOT NULL,
	"counterpart_email" text NOT NULL,
	"counterpart_name" text,
	"org" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"not_before" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"notify_message_id" bigint,
	"decided_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"resend_id" text,
	"message_id" text,
	"in_reply_to" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outreach_status_idx" ON "outreach" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "outreach_thread_idx" ON "outreach" USING btree ("thread_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_resend_idx" ON "outreach" USING btree ("resend_id");