-- Device hints, the owner's decision of 28 October 2026 (design B): "I like A, obviously the fingerprint needs
-- to include more than just iphone model… is it really just the iphone model? Then it should be B." B is the
-- scoped device hint "Welcome back, Tim?": a question, never a sign-in on its own.
-- One row per browser key a player's phone gave: a key made on the server with a secret (HMAC-SHA256 under the
-- purpose device-hint:v1) from what the browser tells every site, a label in words and two dates. Never the
-- values themselves. At most three a player (the app keeps the cap), a year after the last use the hourly job
-- deletes the row, and the read-only role never sees "key" (0103_reader_grants.sql). A player's rows go with the
-- player (cascade) and with an account deletion (anonymizePlayer).
-- players.hints_off is the player's lasting objection to the key ("Don't recognise my phones" on My matches,
-- PDPA s.32): the moment it was set, or null. While it is set, no door keeps a key for that player.
-- Additive only (rule 7). The new table is locked like every other (rule 10): Row Level Security, one policy, the grant.
CREATE TABLE "device_hints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "hints_off" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_hints" ADD CONSTRAINT "device_hints_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_hints_player_key_idx" ON "device_hints" USING btree ("player_id","key");--> statement-breakpoint
CREATE INDEX "device_hints_key_idx" ON "device_hints" USING btree ("key");--> statement-breakpoint
CREATE INDEX "device_hints_player_idx" ON "device_hints" USING btree ("player_id");--> statement-breakpoint
ALTER TABLE "device_hints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "device_hints" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "device_hints" TO "kicksmash";
