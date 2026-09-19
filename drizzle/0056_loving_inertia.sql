ALTER TABLE "competitions" ADD COLUMN "series_tag" text;--> statement-breakpoint
CREATE INDEX "competitions_series_idx" ON "competitions" USING btree ("series_tag");