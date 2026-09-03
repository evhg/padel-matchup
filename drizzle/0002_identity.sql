CREATE TABLE "email_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "court" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "personal_token" text;--> statement-breakpoint
CREATE INDEX "email_codes_email_idx" ON "email_codes" USING btree ("email","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "players_personal_token_idx" ON "players" USING btree ("personal_token") WHERE "players"."personal_token" is not null;--> statement-breakpoint
CREATE INDEX "players_email_idx" ON "players" USING btree ("email");