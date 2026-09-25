-- WAREHAUS.club back on the club lists (25 September 2026).
--
-- Erik plays at Warehaus and used it to test the claim. His claim of 20 September 2026 at 09:25 UTC
-- wrote source 'claim' over the directory's row, and the refusal at 09:45 left the row refused, so the
-- venue with the most matches in the app fell off /clubs, the Phuket page, the venue picker and the
-- claim form. A refusal now hands a directory listing back (`relist` in src/lib/domain/clubs.ts);
-- this does the same for the one row that was refused before it could.
--
-- The values are data/clubs.json's row for `warehaus`, as scripts/import-clubs.mjs writes it. What
-- the claim typed goes with the claim: five courts, all indoor, which no public source says, and the
-- description it cleared comes back. The manage link is new, because the old one belongs to the
-- refused claim. Every statement touches only this row and the rows the claim owns, and only while
-- the row is still that refused claim, so on any other database it changes nothing.
--
-- tests/club-directory.test.ts runs this file on the state production was in and compares the row
-- with what the directory import writes.
delete from club_courts where club_slug = 'warehaus' and exists (select 1 from clubs where slug = 'warehaus' and source = 'claim' and rejected_at is not null and created_at < claimed_at and coalesce(claim_decision, '') not in ('not_a_club', 'duplicate'));
--> statement-breakpoint
delete from club_slots where club_slug = 'warehaus' and exists (select 1 from clubs where slug = 'warehaus' and source = 'claim' and rejected_at is not null and created_at < claimed_at and coalesce(claim_decision, '') not in ('not_a_club', 'duplicate'));
--> statement-breakpoint
update clubs set
  name = 'WAREHAUS.club',
  country = 'TH',
  province = 'Phuket',
  city = 'phuket',
  tz = 'Asia/Bangkok',
  courts = null,
  courts_indoor = null,
  courts_outdoor = null,
  website = null,
  about = 'WAREHAUS.club, Cherngtalay, Thalang.',
  map_url = null,
  booking_url = null,
  booking_platform = null,
  opens_at = null,
  closes_at = null,
  availability_url = null,
  availability_kind = null,
  availability = null,
  availability_at = null,
  source = 'directory',
  claimed_by = null,
  claimed_at = created_at,
  claim_role = null,
  claim_contact = null,
  claim_verified_at = null,
  approved_at = null,
  rejected_at = null,
  claim_decision = null,
  founding = false,
  notify_message_id = null,
  wrap_sent_for = null,
  manage_token = replace(gen_random_uuid()::text, '-', ''),
  updated_at = now()
where slug = 'warehaus' and source = 'claim' and rejected_at is not null and created_at < claimed_at and coalesce(claim_decision, '') not in ('not_a_club', 'duplicate');
