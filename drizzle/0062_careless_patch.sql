ALTER TABLE "coaches" ADD COLUMN "approve_new_bookings" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_requests" ADD COLUMN "heads" integer DEFAULT 1 NOT NULL;