ALTER TABLE "coaches" ADD COLUMN "open_booking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "teaches_level_min" real;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "teaches_level_max" real;