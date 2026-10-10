-- Group access, the owner's decision E (9 October 2026): "names visible, levels hidden, optional Ask to join".
-- groups.ask_to_join switches a group from one tap in to asking; group_requests holds the asks an admin decides.
-- Additive only (rule 7). The new table is locked like every other (rule 10): Row Level Security, one policy, the grant.
CREATE TABLE "group_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"note" text,
	"status" "join_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_player_id" uuid
);
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "ask_to_join" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "group_requests" ADD CONSTRAINT "group_requests_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_requests" ADD CONSTRAINT "group_requests_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_requests" ADD CONSTRAINT "group_requests_decided_by_player_id_players_id_fk" FOREIGN KEY ("decided_by_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_requests_group_player_idx" ON "group_requests" USING btree ("group_id","player_id");--> statement-breakpoint
CREATE INDEX "group_requests_group_status_idx" ON "group_requests" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "group_requests_player_idx" ON "group_requests" USING btree ("player_id");--> statement-breakpoint
ALTER TABLE "group_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app" ON "group_requests" AS PERMISSIVE FOR ALL TO "kicksmash" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT ALL ON TABLE "group_requests" TO "kicksmash";