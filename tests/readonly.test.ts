import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bare, checkReadQuery, READ_QUERY_LIMITS } from "@/lib/api/readQuery";
import { HIDDEN_COLUMNS, isHidden, readAsReader, readerGrantsSql, refusalOf, REVIEWED_SAFE, schemaTables, SUSPICIOUS } from "@/lib/db/readonly";
import { createTestDb, makePlayer } from "./helpers/db";

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

describe("the reader sees the rows, and still not the tokens", () => {
  // The door shipped with every lock above in place and answered "0 players" while production held
  // 48: every table has Row Level Security, no policy names the reader, and Postgres says nothing
  // when a role may see no rows. Nothing above could catch it, because nothing above read a row.
  // This runs the door's own transaction against a database built from the real migrations.

  it("counts the players that are there", async () => {
    const { db } = await createTestDb();
    await makePlayer(db, "Micky");
    await makePlayer(db, "Erik");
    // Without this the test below proves nothing: row security must really be on for the table.
    const [rls] = await readAsReader(db, "select relrowsecurity as on from pg_class where relname = 'players' and relkind = 'r'");
    expect(rls).toEqual({ on: true });
    const [row] = (await readAsReader(db, "select count(*)::int as n from players")) as { n: number }[];
    expect(row.n).toBe(2);
    const names = (await readAsReader(db, "select display_name from players order by display_name")) as { display_name: string }[];
    expect(names.map((r) => r.display_name)).toEqual(["Erik", "Micky"]);
  });

  // What the route answers with: Postgres's own words, never Drizzle's "Failed query: <the query>".
  const refusal = async (db: Parameters<typeof readAsReader>[0], q: string): Promise<string> => {
    try {
      await readAsReader(db, q);
      return "allowed";
    } catch (e) {
      return refusalOf(e);
    }
  };

  it("is refused a token by the database, however it asks", async () => {
    const { db } = await createTestDb();
    await makePlayer(db, "Micky");
    expect(await refusal(db, "select personal_token from players")).toMatch(/permission denied/);
    expect(await refusal(db, "select to_jsonb(p) from players p")).toMatch(/permission denied/);
    expect(await refusal(db, "select * from players")).toMatch(/permission denied/);
  });

  it("cannot write, even past the query rule", async () => {
    const { db } = await createTestDb();
    expect(await refusal(db, "update players set display_name = 'x'")).toMatch(/read-only|permission denied/);
  });

  it("says why a query was refused, and never hands the query back", async () => {
    // The first answer the door gave to a refused query was "Failed query: select … params:", which
    // repeats the question and says nothing about the reason. Here: a schema the reader has no grant on.
    const { db } = await createTestDb();
    const reason = await refusal(db, "select count(*) from drizzle.__drizzle_migrations");
    expect(reason).toMatch(/permission denied/);
    expect(reason).not.toMatch(/Failed query|select count/);
    expect(refusalOf(new Error("Failed query: select 1\nparams: "))).toBe("query failed");
    expect(refusalOf("not an error")).toBe("query failed");
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
