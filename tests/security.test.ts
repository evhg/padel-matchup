import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { schemaTables } from "@/lib/db/readonly";
import { createTestDb } from "./helpers/db";

/**
 * What can be held now for the security work the owner set for a hundred real players (ROADMAP.md).
 *
 * Two things a machine can keep true until then, so the day of the switch starts from a known place:
 * every operator route asks for the operator's token, and the role the app was built to run as
 * (`kicksmash`) could run every table today. Production connects as `postgres` (checked 23 September
 * 2026); docs/OPERATING.md has the steps of the switch, and the three things `kicksmash` still lacks.
 */

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

describe("the operator's doors", () => {
  it("every handler under /api/admin asks for the operator's token before anything else", () => {
    const routes = files("src/app/api/admin").filter((f) => f.endsWith("route.ts"));
    expect(routes.length).toBeGreaterThan(8);
    for (const route of routes) {
      const src = readFileSync(route, "utf8");
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\([^)]*\)\s*{\s*([^\n]*)/g)];
      expect(handlers.length, `${route} exports no handler`).toBeGreaterThan(0);
      for (const [, method, firstLine] of handlers) {
        // The first line of the handler, so no work happens before the answer is "unauthorized".
        expect(firstLine, `${route} ${method}`).toMatch(/await operatorAuthorized\(req\)/);
      }
    }
  });
});

describe("the role the app was built to run as", () => {
  it("could read and write every table today: the grant and the policy are there", async () => {
    const { db } = await createTestDb();
    const rows = (r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as { t: string; can: boolean; policy: boolean }[];
    const lacking: string[] = [];
    for (const { table } of schemaTables()) {
      const [row] = rows(
        await db.execute(sql`select ${table} as t,
          has_table_privilege('kicksmash', ${`public.${table}`}, 'SELECT,INSERT,UPDATE,DELETE') as can,
          exists (select 1 from pg_policies where schemaname = 'public' and tablename = ${table} and 'kicksmash' = any(roles)) as policy`),
      );
      if (!row.can || !row.policy) lacking.push(`${table}${row.can ? "" : " (no grant)"}${row.policy ? "" : " (no policy)"}`);
    }
    expect(lacking, "a table the app could not use as kicksmash").toEqual([]);
  });
});
