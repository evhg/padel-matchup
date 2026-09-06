CREATE TABLE "clubs" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"city" text,
	"tz" text,
	"map_url" text,
	"website" text,
	"booking_url" text,
	"booking_platform" text,
	"courts" integer,
	"about" text,
	"opens_at" text,
	"closes_at" text,
	"availability_url" text,
	"availability_kind" text,
	"availability" jsonb,
	"availability_at" timestamp with time zone,
	"manage_token" text NOT NULL,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"founding" boolean DEFAULT false NOT NULL,
	"notify_message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_claimed_by_players_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clubs_manage_token_idx" ON "clubs" USING btree ("manage_token");--> statement-breakpoint
CREATE INDEX "clubs_city_idx" ON "clubs" USING btree ("city");--> statement-breakpoint
CREATE INDEX "clubs_claimed_by_idx" ON "clubs" USING btree ("claimed_by");