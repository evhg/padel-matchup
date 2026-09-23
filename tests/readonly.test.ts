import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bare, checkReadQuery, READ_QUERY_LIMITS } from "@/lib/api/readQuery";
import { HIDDEN_COLUMNS, isHidden, readerGrantsSql, REVIEWED_SAFE, schemaTables, SUSPICIOUS } from "@/lib/db/readonly";

/**
 * The operator's read-only query door, and the role it reads through.
 *
 * The first version of the door was `postgres` running a select inside a read-only transaction, and
 * it was refused. Correctly: "read everything" is also "become anyone", because
 * `players.personal_token` signs a person in on any device. These tests hold the fourth lock, the
 * one that actually stops that — the grants — and the second, which keeps a write out of the door.
 */

const MIGRATION = "drizzle/0067_reader_role.sql";

describe("the reader role sees no credential", () => {
  it("grants nothing that is hidden", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    for (const column of HIDDEN_COLUMNS) {
      expect(sql.includes(`"${column}"`), `${column} is granted in ${MIGRATION}`).toBe(false);
    }
  });

  it("the migration on disk is what the live schema generates", () => {
    // The guard that survives this session: add a column and this fails until a new migration grants
    // it, which is the moment somebody decides whether a reader may see it.
    expect(readFileSync(MIGRATION, "utf8")).toBe(readerGrantsSql());
  });

  it("every column that looks like a credential was decided, one way or the other", () => {
    const undecided: string[] = [];
    for (const { table, columns } of schemaTables()) {
      for (const column of columns) {
        if (!SUSPICIOUS.test(column)) continue;
        if (isHidden(column) || REVIEWED_SAFE.includes(column)) continue;
        undecided.push(`${table}.${column}`);
      }
    }
    // A new token, secret or code must land on HIDDEN_COLUMNS or REVIEWED_SAFE. Neither is a default.
    expect(undecided, "add these to HIDDEN_COLUMNS or REVIEWED_SAFE in src/lib/db/readonly.ts").toEqual([]);
  });

  it("still grants the ordinary columns, so the door is worth having", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain(`on public."players"`);
    expect(sql).toContain(`"display_name"`);
    expect(sql).toContain(`"email"`); // the operator's own endpoints already return addresses
    expect(sql).toContain(`"code"`); // the public share code, which lives in every match URL
    expect(schemaTables().length).toBeGreaterThan(30);
  });
});

describe("the query rule keeps a write out of the door", () => {
  it("lets a select and a with through", () => {
    expect(checkReadQuery("select count(*) from players")).toEqual({ ok: true, sql: "select count(*) from players" });
    expect(checkReadQuery("  with x as (select 1 as n) select * from x ;  ").ok).toBe(true);
  });

  it("refuses everything that writes", () => {
    for (const q of [
      "delete from players",
      "update players set email = null",
      "insert into players (display_name) values ('x')",
      "drop table players",
      "truncate players",
      "alter table players add column x text",
      "grant all on players to public",
      "select 1; delete from players",
      "set role postgres",
      "copy players to '/tmp/x'",
      "select pg_read_file('/etc/passwd')",
      "select pg_sleep(60)",
    ]) {
      expect(checkReadQuery(q).ok, q).toBe(false);
    }
  });

  it("is not fooled by a comment or a string, and does not trip over a name", () => {
    expect(checkReadQuery("select 1 -- ; delete from players").ok).toBe(true);
    expect(checkReadQuery("select 1 /* delete */ from players").ok).toBe(true);
    expect(checkReadQuery("select 1; -- nothing\n delete from players").ok).toBe(false);
    // A player really can be called "Update Jones", and a question about them must still run.
    expect(checkReadQuery("select * from players where display_name = 'Update Jones'").ok).toBe(true);
    expect(checkReadQuery(`select * from players where display_name = 'O''Brien; drop table players'`).ok).toBe(true);
    expect(bare("select $$ delete from players $$")).not.toContain("delete");
    expect(checkReadQuery("select $$ delete from players $$").ok).toBe(true);
  });

  it("refuses an empty question and an oversized one", () => {
    expect(checkReadQuery("").ok).toBe(false);
    expect(checkReadQuery("   ").ok).toBe(false);
    expect(checkReadQuery(`select '${"x".repeat(READ_QUERY_LIMITS.maxChars)}'`).ok).toBe(false);
    expect(checkReadQuery("explain select 1").ok).toBe(false);
  });

  it("does not pretend to be the lock that matters", () => {
    // This one is allowed by the rule on purpose: it is a select, and it reads a credential. The
    // grants refuse it in the database, which is the only place that cannot be talked around.
    expect(checkReadQuery("select to_jsonb(p) from players p").ok).toBe(true);
    expect(checkReadQuery("select personal_token from players").ok).toBe(true);
  });
});
