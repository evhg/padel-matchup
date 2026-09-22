/**
 * Why a database connection failed, in words somebody can act on.
 *
 * Two Migrate runs in a row died here, each printing forty lines of stack whose one useful line was
 * `connect ENETUNREACH 2406:…:5432`. A GitHub Actions runner has no IPv6 route, and Supabase's
 * direct address (db.<ref>.supabase.co) carries only an IPv6 record unless the project buys the
 * IPv4 add-on. The remedy is the Session pooler address, which is IPv4 on every tier.
 *
 * It lives in its own file so a test can call it. The thing that broke twice was a code path
 * nothing ever ran.
 */
export function unreachableHint(err: unknown): string | null {
  for (let node: unknown = err, depth = 0; node && depth < 5; depth += 1) {
    const e = node as { code?: string; address?: string; cause?: unknown };
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
    node = e.cause;
  }
  return null;
}
