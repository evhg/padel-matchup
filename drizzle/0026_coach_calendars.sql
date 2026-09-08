ALTER TABLE "coach_blocks" ADD COLUMN "source" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "gcal_id" text;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "gcal_status" text;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "gcal_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "ical_url" text;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "calendar_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "calendar_error" text;--> statement-breakpoint
CREATE INDEX "coach_blocks_external_idx" ON "coach_blocks" USING btree ("coach_id","external_id");