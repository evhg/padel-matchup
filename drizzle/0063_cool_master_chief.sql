ALTER TABLE "clubs" ADD COLUMN "claim_decision" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "added_by" uuid;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_added_by_players_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;