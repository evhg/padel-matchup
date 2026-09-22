/**
 * What a failed database connection means, in words somebody can act on.
 *
 * Four Migrate runs failed before this file earned its place, and each log's one useful line sat
 * under forty lines of stack. The runs also failed for four different reasons, so "read the log"
 * was never enough on its own.
 *
 * Nothing here ever prints the password. `banner` parses the URL and reports only the parts that
 * are not secret, which is exactly what tells a reader whether they copied the right address.
 */

/** The non-secret half of a connection string: where it points and who it says it is. */
export function banner(url: string): string {
  try {
    const u = new URL(url);
    const database = u.pathname.replace(/^\//, "") || "(none)";
    return `Connecting to ${u.hostname}:${u.port || "5432"} as ${u.username || "(no user)"}, database ${database}.`;
  } catch {
    // A password with an unescaped character breaks the parse. Say so; do not echo the string.
    return "Connecting. DIRECT_DATABASE_URL is not a URL this code can read, so check it for a stray character.";
  }
}

export function connectionHint(err: unknown): string | null {
  for (let node: unknown = err, depth = 0; node && depth < 5; depth += 1) {
    const e = node as { code?: string; address?: string; cause?: unknown };

    // No route. The runner has no IPv6, and Supabase's direct address has only an IPv6 record.
    if (e.code === "ENETUNREACH" || e.code === "EHOSTUNREACH") {
      const address = e.address ?? "that address";
      return [
        `Cannot reach the database at ${address} (${e.code}). No SQL ran.`,
        address.includes(":") ? "That is an IPv6 address, and this machine has no IPv6 route." : null,
        "Supabase's direct address is IPv6 only. Use the Session pooler address, which is IPv4:",
        "Supabase, then Connect, then Session pooler, port 5432. Put it in DIRECT_DATABASE_URL.",
        "docs/MIGRATIONS.md, step 1, says where each address comes from.",
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
    }

    // The server answered and refused. The address is right; the credentials are not.
    if (e.code === "28P01") {
      return [
        "The database refused the password. No SQL ran, and nothing changed.",
        "The line above says which user this run offered. For the Session pooler it must read",
        "postgres.<project-ref>, not plain postgres. If the user is right, the password is wrong.",
        "Read the password from your password manager and build the address again.",
        "Do NOT reset the database password to fix this. The live site holds the same password in",
        "its own DATABASE_URL, so a reset stops the site until that is changed too.",
      ].join("\n");
    }

    node = e.cause;
  }
  return null;
}
