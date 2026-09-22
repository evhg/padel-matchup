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

/**
 * What a value looks like, when it cannot be read as a URL at all.
 *
 * Nothing after "://" is ever included, because the password lives there. The part before it is the
 * scheme, or whatever came along with the paste — a variable name, a `psql` command — which is the
 * thing that is usually wrong and is never secret.
 */
export function shapeOf(url: string): string {
  const facts = [`${url.length} characters`];
  const sep = url.indexOf("://");
  if (sep === -1) {
    facts.push('it has no "://" at all, so it is not a connection address');
  } else {
    const prefix = url.slice(0, sep);
    // Print the prefix only when it is short and plainly harmless. Otherwise say how long it is.
    facts.push(
      prefix.length <= 40 && /^[A-Za-z0-9_.\-= ]*$/.test(prefix)
        ? `it starts with "${prefix}://", and it must start with "postgresql://"`
        : `${prefix.length} characters come before "://", and nothing may come before "postgresql://"`,
    );
  }
  if (/\s/.test(url)) facts.push("it holds a space or a line break");
  if (/["'`]/.test(url)) facts.push("it holds a quote mark");
  const ats = (url.match(/@/g) ?? []).length;
  if (ats !== 1) facts.push(`it has ${ats} "@" characters, and an address has exactly one`);
  return facts.join("; ");
}

/** The non-secret half of a connection string: where it points and who it says it is. */
export function banner(url: string): string {
  try {
    const u = new URL(url);
    const database = u.pathname.replace(/^\//, "") || "(none)";
    return `Connecting to ${u.hostname}:${u.port || "5432"} as ${u.username || "(no user)"}, database ${database}.`;
  } catch {
    // Run 6 died here and the log said only "check it for a stray character", which sent the owner
    // looking at a value nobody can read back. Say what is wrong with it, without saying what it is.
    return `DIRECT_DATABASE_URL cannot be read as an address: ${shapeOf(url)}.`;
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
