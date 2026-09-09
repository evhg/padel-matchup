import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { createTestDb } from "./helpers/db";

/**
 * Supabase exposes `public` through its Data API; the app never uses it and connects as `kicksmash`.
 * Every table therefore has Row Level Security on and exactly one policy, for that role (rule 10).
 */
describe("row level security", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("every public table has RLS on and one `app` policy for the kicksmash role", async () => {
    const res = (await db.execute(sql`
      select c.relname as name, c.relrowsecurity as rls,
        (select count(*) from pg_policy p where p.polrelid = c.oid and p.polname = 'app'
           and 'kicksmash' in (select r.rolname from pg_roles r where r.oid = any(p.polroles))) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by 1`)) as unknown;
    const rows = (Array.isArray(res) ? res : ((res as { rows: unknown[] }).rows ?? [])) as { name: string; rls: boolean; policies: number | string }[];
    expect(rows.length).toBeGreaterThanOrEqual(40);
    const open = rows.filter((r) => !r.rls || Number(r.policies) !== 1).map((r) => r.name);
    expect(open, "tables without RLS or the app policy (add both to the table's migration)").toEqual([]);
  });
});
