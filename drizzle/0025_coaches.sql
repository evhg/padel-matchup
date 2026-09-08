CREATE TABLE "coach_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coach_id" uuid NOT NULL,
	"kind" text DEFAULT 'qr' NOT NULL,
	"mime" text NOT NULL,
	"data_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coach_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_managers" (
	"coach_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coach_managers_coach_id_player_id_pk" PRIMARY KEY("coach_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "coach_students" (
	"coach_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "coach_students_coach_id_player_id_pk" PRIMARY KEY("coach_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "coaches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"handle" varchar(32) NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"club_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"languages" jsonb DEFAULT '["en"]'::jsonb NOT NULL,
	"lesson_minutes" integer DEFAULT 60 NOT NULL,
	"hours" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tz" text NOT NULL,
	"cutoff_hours" integer DEFAULT 12 NOT NULL,
	"late_passes" integer DEFAULT 1 NOT NULL,
	"min_notice_hours" integer DEFAULT 2 NOT NULL,
	"promptpay_id" text,
	"pay_link" text,
	"qr_asset_id" uuid,
	"whatsapp" text,
	"is_public" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lesson_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coach_id" uuid NOT NULL,
	"student_player_id" uuid NOT NULL,
	"size" integer NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"amount" integer,
	"currency" text DEFAULT 'THB' NOT NULL,
	"paid_at" timestamp with time zone,
	"late_passes_used" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lesson_waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coach_id" uuid NOT NULL,
	"student_player_id" uuid NOT NULL,
	"slot_starts_at" timestamp with time zone,
	"week_start" date,
	"status" text DEFAULT 'waiting' NOT NULL,
	"offered_at" timestamp with time zone,
	"offer_expires_at" timestamp with time zone,
	"offered_lesson_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coach_id" uuid NOT NULL,
	"student_player_id" uuid,
	"package_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"minutes" integer NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"kind" text DEFAULT 'private' NOT NULL,
	"source" text DEFAULT 'web' NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	"free_pass" boolean DEFAULT false NOT NULL,
	"note" text,
	"external_id" text,
	"created_by_player_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "coach_assets" ADD CONSTRAINT "coach_assets_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_blocks" ADD CONSTRAINT "coach_blocks_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_managers" ADD CONSTRAINT "coach_managers_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_managers" ADD CONSTRAINT "coach_managers_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_students" ADD CONSTRAINT "coach_students_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_students" ADD CONSTRAINT "coach_students_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaches" ADD CONSTRAINT "coaches_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_packages" ADD CONSTRAINT "lesson_packages_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_packages" ADD CONSTRAINT "lesson_packages_student_player_id_players_id_fk" FOREIGN KEY ("student_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_waitlist" ADD CONSTRAINT "lesson_waitlist_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_waitlist" ADD CONSTRAINT "lesson_waitlist_student_player_id_players_id_fk" FOREIGN KEY ("student_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_student_player_id_players_id_fk" FOREIGN KEY ("student_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_package_id_lesson_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."lesson_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_created_by_player_id_players_id_fk" FOREIGN KEY ("created_by_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coach_assets_coach_idx" ON "coach_assets" USING btree ("coach_id");--> statement-breakpoint
CREATE INDEX "coach_blocks_coach_time_idx" ON "coach_blocks" USING btree ("coach_id","starts_at");--> statement-breakpoint
CREATE INDEX "coach_students_player_idx" ON "coach_students" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coaches_handle_idx" ON "coaches" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "coaches_player_idx" ON "coaches" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "lesson_packages_student_idx" ON "lesson_packages" USING btree ("coach_id","student_player_id","created_at");--> statement-breakpoint
CREATE INDEX "lesson_waitlist_coach_idx" ON "lesson_waitlist" USING btree ("coach_id","status","created_at");--> statement-breakpoint
CREATE INDEX "lessons_coach_time_idx" ON "lessons" USING btree ("coach_id","starts_at");--> statement-breakpoint
CREATE INDEX "lessons_student_idx" ON "lessons" USING btree ("student_player_id","starts_at");--> statement-breakpoint
CREATE INDEX "lessons_external_idx" ON "lessons" USING btree ("coach_id","external_id");