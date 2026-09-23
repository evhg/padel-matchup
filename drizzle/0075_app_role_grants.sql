-- The app's own role, on every table, from the repository. Production's kicksmash holds the grant on
-- all 58 tables, but for 50 of them the grant was typed into Supabase by hand when each migration was
-- applied that way, and never written into a migration: a database rebuilt from GitHub gave the role
-- a policy on each table and no right to use it (found by tests/security.test.ts, 23 September 2026).
-- A no-op where the grants are already there. Every migration that adds a table carries its own
-- GRANT (AGENTS.md rule 10), and the test now fails on any table without one.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kicksmash') THEN GRANT ALL ON ALL TABLES IN SCHEMA public TO kicksmash; END IF; END $$;
