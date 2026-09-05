ALTER TABLE "players" ADD COLUMN "recovery_email" text;--> statement-breakpoint
CREATE INDEX "players_recovery_email_idx" ON "players" USING btree ("recovery_email");