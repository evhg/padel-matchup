-- Passkeys, the owner's decision of 12 October 2026 (DECIDING rule 39): "One Face ID makes any browser on the
-- phone know the player. It also replaces the email code. It needs a migration (a new passkeys table)."
-- One row per passkey a player saved: the credential id the phone made, the public key that checks its
-- signature, the counter, a label in words and two dates. No user handle, no face, no fingerprint, no
-- password. A player's rows go with the player (cascade) and with an account deletion (anonymizePlayer).
-- Additive only (rule 7). The new table is locked like every other (rule 10): Row Level Security, one policy, the grant.
CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passkeys_player_idx" ON "passkeys" USING btree ("player_id");--> statement-breakpoint
ALTER TABLE "passkeys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "passkeys" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "passkeys" TO "kicksmash";
