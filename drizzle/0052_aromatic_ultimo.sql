CREATE TABLE "coach_package_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coach_id" uuid NOT NULL,
	"size" integer NOT NULL,
	"minutes" integer NOT NULL,
	"heads" integer DEFAULT 1 NOT NULL,
	"price" integer NOT NULL,
	"valid_days" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "second_minutes" integer;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "price_second_single" integer;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "price_second_two" integer;--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "outside_hours_fee" integer;--> statement-breakpoint
ALTER TABLE "lesson_packages" ADD COLUMN "heads" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_packages" ADD COLUMN "minutes" integer;--> statement-breakpoint
ALTER TABLE "lesson_packages" ADD COLUMN "offer_id" uuid;--> statement-breakpoint
ALTER TABLE "coach_package_offers" ADD CONSTRAINT "coach_package_offers_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coach_package_offers_coach_idx" ON "coach_package_offers" USING btree ("coach_id","position");--> statement-breakpoint
ALTER TABLE "lesson_packages" ADD CONSTRAINT "lesson_packages_offer_id_coach_package_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."coach_package_offers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_package_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "coach_package_offers" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "coach_package_offers" TO "kicksmash";
