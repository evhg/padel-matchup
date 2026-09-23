-- A note whose author a merge blanked on 23 September 2026. That merge moved only some of the tables
-- that point at a player and deleted the rest's link (`set null`) along with the duplicate row;
-- src/lib/domain/merge.ts now moves them all. The note is Erik's: his name, his match (/X9nQ), the
-- same session as his other notes, which all point at the row below. Without its author the answer
-- to it had no way back to him. Idempotent, and a no-op on any database without these two rows.
update feedback
set player_id = 'db68eb55-19c0-410f-a1d9-e1ac4298fbac'
where id = 'dab8c808-9f8f-499a-8cec-5a980a5a81c9'
  and player_id is null
  and exists (select 1 from players where id = 'db68eb55-19c0-410f-a1d9-e1ac4298fbac');
