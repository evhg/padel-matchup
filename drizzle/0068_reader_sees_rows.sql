-- The reader role must see rows. Every public table has Row Level Security and no policy names
-- kicksmash_reader, so without bypassrls Postgres answered every query through /api/admin/sql with
-- zero rows and no error: "0 players" while production held 48. Row security is about which rows;
-- the column grants in 0067 still decide which columns, so a token stays unreadable.
alter role "kicksmash_reader" bypassrls;
