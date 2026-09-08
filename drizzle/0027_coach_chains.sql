CREATE TABLE "lesson_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coach_id" uuid NOT NULL,
	"student_player_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"minutes" integer NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"lesson_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "manager_code" text;--> statement-breakpoint
ALTER TABLE "lesson_packages" ADD COLUMN "low_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lesson_requests" ADD CONSTRAINT "lesson_requests_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_requests" ADD CONSTRAINT "lesson_requests_student_player_id_players_id_fk" FOREIGN KEY ("student_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lesson_requests_coach_idx" ON "lesson_requests" USING btree ("coach_id","status","starts_at");