-- A crew's own Telegram group, run by the Kicksmash bot as an admin (DECIDING rule 31). The owner decided
-- on 9 October 2026: "players join a group managed by the Kicksmash bot so that it can assist setting up
-- matches and do the admin, so there are no privacy concerns. The group with the bot that listens is
-- solely for the purpose of coordinating padel matches." Four nullable columns on telegram_chats (no new
-- table, no message text), and two indexes for the reads a reply and a crew's chat make.
ALTER TABLE "telegram_chats" ADD COLUMN "listening_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD COLUMN "notice_version" integer;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD COLUMN "notice_message_id" bigint;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD COLUMN "invite_link" text;--> statement-breakpoint
CREATE INDEX "telegram_cards_chat_message_idx" ON "telegram_cards" USING btree ("chat_id","message_id");--> statement-breakpoint
CREATE INDEX "telegram_chats_group_idx" ON "telegram_chats" USING btree ("group_id");