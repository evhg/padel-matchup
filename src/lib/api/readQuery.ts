/**
 * The guard on the operator's read-only query door (`GET /api/admin/sql`).
 *
 * Why the door exists: an agent session in the cloud has no socket to the database and holds no
 * credentials, so every production question went through a tool that asks the owner for permission,
 * one question at a time. A dozen small questions became a dozen interruptions. This is the same
 * read, through the app that already owns the connection, with the operator's bearer token.
 *
 * Why the guard is here and not in the route: it is a pure rule over a string, so it is unit-tested
 * beside the other rules (AGENTS.md rule 1). The route adds the second and third locks — the bearer
 * token, and a Postgres transaction that is read only whatever this function lets through.
 *
 * Three locks, in this order, because any one of them can be wrong:
 *   1. the bearer token (`operatorAuthorized`),
 *   2. this rule: one statement, and it must read,
 *   3. `set transaction read only` plus a statement timeout, which Postgres enforces even if 2 is
 *      fooled. A write inside a read-only transaction is an error, not a change.
 */

export const READ_QUERY_LIMITS = {
  /** Longer than any question worth asking down a URL. */
  maxChars: 4000,
  /** The row cap the route appends when the query names none. */
  maxRows: 500,
  /** Postgres gives up after this, so one bad query cannot hold a connection. */
  timeoutMs: 8000,
} as const;

export type ReadQueryVerdict = { ok: true; sql: string } | { ok: false; reason: string };

/** Words that only ever appear in a statement that changes something, or reaches outside the query. */
const FORBIDDEN = [
  "insert",
  "update",
  "delete",
  "truncate",
  "drop",
  "alter",
  "create",
  "grant",
  "revoke",
  "comment",
  "vacuum",
  "analyze",
  "reindex",
  "refresh",
  "call",
  "do",
  "copy",
  "lock",
  "set",
  "reset",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "listen",
  "notify",
  "prepare",
  "execute",
  "deallocate",
  "discard",
  "cluster",
  "security",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "lo_import",
  "lo_export",
  "dblink",
  "pg_sleep",
] as const;

/**
 * Strips what a keyword could hide behind: line comments, block comments and the contents of string
 * and identifier literals. A word inside a player's name ("Update Jones") must not fail the check,
 * and `--` must not be able to comment the rest of the rule away.
 */
export function bare(q: string): string {
  let out = "";
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    const next = q[i + 1];
    if (c === "-" && next === "-") {
      while (i < q.length && q[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < q.length && !(q[i] === "*" && q[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < q.length) {
        if (q[i] === quote && q[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (q[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += " "; // the literal becomes a space: it cannot carry a keyword
      continue;
    }
    if (c === "$" && /\$[A-Za-z_]*\$/.test(q.slice(i, i + 40))) {
      // Dollar quoting: $$ … $$ or $tag$ … $tag$. Skip the whole body.
      const tag = /^\$[A-Za-z_]*\$/.exec(q.slice(i))![0];
      const end = q.indexOf(tag, i + tag.length);
      i = end === -1 ? q.length : end + tag.length;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Yes only for a single statement that starts with `select` or a `with` whose body is a select, and
 * carries none of the words above. Everything else is refused with the reason, because a refusal a
 * person cannot read gets worked around rather than understood.
 */
export function checkReadQuery(raw: string): ReadQueryVerdict {
  const q = (raw ?? "").trim().replace(/;\s*$/, "");
  if (!q) return { ok: false, reason: "empty query" };
  if (q.length > READ_QUERY_LIMITS.maxChars) return { ok: false, reason: `over ${READ_QUERY_LIMITS.maxChars} characters` };
  const stripped = bare(q);
  if (stripped.includes(";")) return { ok: false, reason: "one statement only" };
  const lower = stripped.toLowerCase();
  if (!/^\s*(select|with)\b/.test(lower)) return { ok: false, reason: "must start with select or with" };
  for (const word of FORBIDDEN) {
    if (new RegExp(`(^|[^a-z_])${word}([^a-z_]|$)`).test(lower)) return { ok: false, reason: `"${word}" is not allowed here` };
  }
  // `with x as (…) select` is fine; `with x as (… ) insert` was already caught by the word list.
  return { ok: true, sql: q };
}
