-- Supabase serves every table in `public` through its Data API. Kicksmash never uses that API: the app talks to
-- Postgres as the role `kicksmash`. Row Level Security on every table, one policy for the app role and nothing for the
-- API roles keeps the data where it belongs. A new table adds the same two statements to its own migration.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kicksmash') THEN CREATE ROLE kicksmash; END IF; END $$;
--> statement-breakpoint
ALTER TABLE "activity" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "activity" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "answers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "answers" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "api_keys" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "clubs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "clubs" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "coach_assets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "coach_assets" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "coach_blocks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "coach_blocks" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "coach_managers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "coach_managers" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "coach_students" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "coach_students" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "coaches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "coaches" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "discord_cards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "discord_cards" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "discord_channels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "discord_channels" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "email_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "email_codes" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "email_opt_outs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "email_opt_outs" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "error_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "error_events" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "event_photos" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "event_photos" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "events" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "feedback" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "feedback" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "group_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "group_members" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "groups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "groups" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "join_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "join_requests" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "lesson_packages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "lesson_packages" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "lesson_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "lesson_requests" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "lesson_waitlist" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "lesson_waitlist" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "lessons" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "lessons" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "listen_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "listen_items" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "metrics_daily" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "metrics_daily" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "milestones" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "milestones" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "outreach" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "outreach" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "players" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "players" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "push_subscriptions" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "scores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "scores" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "slots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "slots" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "telegram_cards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "telegram_cards" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "telegram_chats" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "telegram_chats" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "telegram_inline_cards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "telegram_inline_cards" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "tournament_matches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "tournament_matches" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "tournament_rounds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "tournament_rounds" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "venues" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "venues" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "webhook_deliveries" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "webhooks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app" ON "webhooks" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);
