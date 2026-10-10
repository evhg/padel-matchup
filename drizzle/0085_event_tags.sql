-- Who a match is for: a category (men, women, mixed) and the youngest age (35, 45 or 55), src/lib/domain/eventTags.ts.
-- The owner decided on 9 October 2026 (decision G1): the tag is on the event, never on the player, and nothing is checked at join.
-- The same pair on series and club_slots, so every edition and every programme match carries it. Nullable, no default, no backfill.
ALTER TABLE "events" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "age_min" integer;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "age_min" integer;--> statement-breakpoint
ALTER TABLE "club_slots" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "club_slots" ADD COLUMN "age_min" integer;