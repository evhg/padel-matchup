CREATE TABLE "metrics_daily" (
	"day" date NOT NULL,
	"key" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "metrics_daily_day_key_pk" PRIMARY KEY("day","key")
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "court_names" jsonb;