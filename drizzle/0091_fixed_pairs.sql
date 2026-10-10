-- Fixed pairs in social tournaments: the owner's decision F of 9 October 2026, "as Phuket nights often do".
-- events.fixed_pairs says the night keeps its partners; slots.pair_id is the partner key, shared by the two
-- named seats of one pair (src/lib/domain/fixedPairs.ts). A shared key, not a pointer to the other seat:
-- the queries that empty a seat or move a player between seats need no second update, because an emptied
-- seat clears its own key and the other half then reads as a single. Every read of it goes through the
-- event's own seats (slots_event_position_idx), so it needs no index of its own.
-- Additive (rule 7): a default of false and a nullable column, no backfill.
ALTER TABLE "events" ADD COLUMN "fixed_pairs" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "slots" ADD COLUMN "pair_id" uuid;
