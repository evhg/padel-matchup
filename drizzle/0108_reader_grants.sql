-- The reader's grants as they were at this point. Each later grants migration states every grant again (the newest is
-- the truth; tests/readonly.test.ts holds it to the schema), so this file keeps only the role. The owner's decision of
-- 23 November 2026: 17 full copies were 0.27 MB in every function of every deployment. Production applied the
-- full file; a migration is applied by its date, never by its text, so this change touches no database.
--> statement-breakpoint
do $$ begin if not exists (select 1 from pg_roles where rolname = 'kicksmash_reader') then create role "kicksmash_reader" nologin; end if; end $$;
--> statement-breakpoint
grant "kicksmash_reader" to current_user;
--> statement-breakpoint
grant usage on schema public to "kicksmash_reader";
