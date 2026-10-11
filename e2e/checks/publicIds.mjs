// No page, feed or API answer that a stranger can open carries a player id.
//
// Until 11 October 2026 a player id signed a browser in: `restoreIdentity` set the session cookie for
// any id it was given. And the match page sent the id of every seated player to every viewer of a
// started match, the crew page sent every member's, and the tables of standings keyed their rows by
// it (a React key travels in the page's payload as well). A player id is no proof of anything now, and
// it still stays off every public screen, so the next door that trusts one has nothing to find.
//
// e2e/run.mjs runs this after the suites, on whatever they left in the database. It reads the ids
// through the operator's read-only door and fetches each page with no cookie, as a stranger's first
// visit. By hand, against any server whose CRON_SECRET you hold:
//
//   node e2e/checks/publicIds.mjs http://localhost:3001 e2e-cron-secret
//
// It lives under e2e/checks/ because every .mjs file directly in e2e/ is a suite.

/** The public pages whose body carries a player id, as "path (how many ids)". Empty when there is none. */
export async function publicIdLeaks(base, secret, log = console.log) {
  try {
    const ask = async (q) => {
      const r = await fetch(`${base}/api/admin/sql?q=${encodeURIComponent(q)}`, { headers: { authorization: `Bearer ${secret}` } }).then((x) => x.json());
      if (!r.ok) throw new Error(`${r.error} in: ${q}`);
      return r.rows;
    };
    const [{ ids }] = await ask("select coalesce(string_agg(id::text, ','), '') as ids from players");
    const players = new Set(String(ids).split(",").filter(Boolean));
    const list = async (q, f) => {
      try {
        return (await ask(q)).map(f);
      } catch (e) {
        log(`  (the id check skipped a list: ${e.message})`);
        return [];
      }
    };
    // The pages with the most people on them first: a scored match, a tournament night, a crew's match.
    const events = await list("select code from events order by (exists (select 1 from scores s where s.event_id = events.id)) desc, (type = 'tournament') desc, (group_id is not null) desc, created_at desc limit 80", (r) => r.code);
    const groups = await list("select code from groups order by created_at desc limit 30", (r) => r.code);
    const venues = await list("select venue_slug from events where venue_slug is not null group by venue_slug order by count(*) desc limit 20", (r) => r.venue_slug);
    const profiles = await list("select public_slug from players where public_profile and public_slug is not null limit 20", (r) => r.public_slug);
    const series = await list("select slug from series limit 10", (r) => r.slug);
    const comps = await list("select slug, series_tag from competitions limit 10", (r) => r);
    const coaches = await list("select handle from coaches where archived_at is null limit 10", (r) => r.handle);
    const urls = [
      ...["/", "/play", "/clubs", "/coaches", "/t", "/built", "/phuket", "/singapore", "/sitemap.xml", "/llms.txt", "/api/v1/matches", "/api/v1/series", "/api/v1/coaches", "/api/v1/clubs"],
      ...events.flatMap((c) => [`/${c}`, `/${c}/card`, `/embed/match/${c}`, `/${c}/calendar.ics`, `/api/v1/matches/${c}`]),
      ...groups.flatMap((c) => [`/g/${c}`, `/g/${c}/calendar.ics`, `/api/v1/groups/${c}`]),
      ...venues.flatMap((v) => [`/v/${v}`, `/v/${v}/ranking`, `/embed/board/${v}`, `/v/${v}/calendar.ics`, `/api/v1/boards/${v}`]),
      ...profiles.flatMap((u) => [`/u/${u}`, `/u/${u}/passport.json`]),
      ...series.flatMap((x) => [`/s/${x}`, `/api/v1/series/${x}`]),
      ...comps.flatMap((x) => [`/t/${x.slug}`, `/t/${x.slug}/tv`, `/t/${x.slug}/results.csv`, ...(x.series_tag ? [`/t/series/${x.series_tag}`] : [])]),
      ...coaches.flatMap((h) => [`/c/${h}`, `/api/v1/coaches/${h}`]),
    ];
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    // The same id as 32 hex digits: how a ticket or a calendar feed's key names a player (src/lib/ticket.ts).
    const hex = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
    const asUuid = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toLowerCase();
    const found = [];
    const queue = [...urls];
    const worker = async () => {
      for (let u = queue.shift(); u; u = queue.shift()) {
        const body = await fetch(`${base}${u}`, { headers: { "x-forwarded-for": "10.99.0.1", "user-agent": "Mozilla/5.0 (player id check)" } })
          .then((r) => r.text())
          .catch(() => "");
        const hits = new Set([...(body.match(uuid) ?? []).map((x) => x.toLowerCase()), ...(body.match(hex) ?? []).map(asUuid)].filter((x) => players.has(x)));
        if (hits.size) found.push(`${u} (${hits.size})`);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    log(`\n=== no player id on a public page ===\n${found.length ? found.map((f) => `✗ ${f} carries a player id`).join("\n") : `✓ ${urls.length} pages, feeds and API answers, ${players.size} players: no player id`}`);
    return found;
  } catch (e) {
    log(`\n✗ the player id check could not run: ${e.message}`);
    return ["(the check itself)"];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base = "http://localhost:3001", secret = "e2e-cron-secret"] = process.argv.slice(2);
  const leaks = await publicIdLeaks(base, secret);
  process.exit(leaks.length ? 1 : 0);
}
