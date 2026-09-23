import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { checkReadQuery, READ_QUERY_LIMITS } from "@/lib/api/readQuery";
import { readAsReader, refusalOf } from "@/lib/db/readonly";

export const dynamic = "force-dynamic";

/**
 * The operator's read-only window on production.
 *
 *   GET /api/admin/sql?q=select count(*) from players
 *   Authorization: Bearer $CRON_SECRET
 *
 * It exists because an agent session in the cloud has no socket to this database. Every question had
 * to go through a tool that asks the owner to approve it, one question at a time, and a dozen small
 * questions became a dozen interruptions on a day that needed none.
 *
 * Four locks, and the fourth is the only one that matters:
 *   1. the operator's bearer token, the same one the rest of /api/admin/* takes,
 *   2. `checkReadQuery`, a pure rule: one statement, and it must read,
 *   3. a Postgres transaction that is `read only` with a statement timeout, so a write is an error
 *      whatever gets past lock 2 and no query can hold a connection open,
 *   4. `set local role kicksmash_reader`, which has `select` on columns and never on a credential,
 *      and bypasses Row Level Security, or every answer would be zero rows (`readAsReader`).
 *
 * The first version of this file had only the first three, and it was refused. It deserved to be:
 * "read everything" is also "become anyone", because `players.personal_token` signs a person in.
 * Locks 2 and 3 stop a write. Only lock 4 stops a read of the thing that matters, and it stops it
 * in the database, where `select to_jsonb(p) from players p` cannot go around it.
 *
 * It still answers personal data — names, addresses, who played with whom — to whoever holds the
 * token. That is the trust the token already carries: /api/admin/feedback returns people's notes
 * and addresses today. Nothing here is logged with its results.
 */
export async function GET(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const verdict = checkReadQuery(q);
  if (!verdict.ok) return NextResponse.json({ error: verdict.reason, limits: READ_QUERY_LIMITS }, { status: 400 });
  const db = await getDb();
  try {
    const rows = await readAsReader(db, verdict.sql);
    const capped = rows.length > READ_QUERY_LIMITS.maxRows;
    return NextResponse.json({ ok: true, count: rows.length, capped, rows: capped ? rows.slice(0, READ_QUERY_LIMITS.maxRows) : rows });
  } catch (e) {
    // The database's own words, which is what makes a refused query fixable. Never the query back.
    return NextResponse.json({ error: refusalOf(e) }, { status: 400 });
  }
}
