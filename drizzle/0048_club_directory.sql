ALTER TABLE "clubs" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "province" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "courts_indoor" integer;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "courts_outdoor" integer;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "source" text DEFAULT 'claim' NOT NULL;--> statement-breakpoint
CREATE INDEX "clubs_place_idx" ON "clubs" USING btree ("country","province","name");