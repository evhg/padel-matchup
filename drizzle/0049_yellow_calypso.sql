ALTER TABLE "coaches" ADD COLUMN "price_two" integer;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "price_three" integer;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "price_four" integer;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "heads" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "comped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "comp_reason" text;