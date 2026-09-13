ALTER TABLE "coaches" ADD COLUMN "club_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "price_single" integer;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "currency" text DEFAULT 'THB' NOT NULL;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "pay_at_club" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "score_reminder_2_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "amount" integer;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "paid_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "paid_at" timestamp with time zone;