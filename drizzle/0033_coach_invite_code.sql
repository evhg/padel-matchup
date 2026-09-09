ALTER TABLE "coaches" ADD COLUMN "invite_code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "coaches_invite_code_idx" ON "coaches" USING btree ("invite_code");