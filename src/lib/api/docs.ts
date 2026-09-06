import { APP_NAME } from "@/lib/config";

export const VALUE_PROP = "Kicksmash is the open, agent-native way to organise padel: create a match, share one link, and let people or their assistants join, all through an API that anyone may use.";

export const PROOFS = ["No accounts, no app: a first name and a link.", "Open API, open data (CC BY 4.0), open source (Apache-2.0).", "Every assistant welcome: MCP server, OpenAPI, llms.txt, crawlers allowed."];

/** Concise, for /llms.txt: what an assistant needs in one screen. */
export function llmsTxt(base: string): string {
  return `# ${APP_NAME}

> ${VALUE_PROP}

${APP_NAME} (${base}) organises padel matches and tournaments (americano, mexicano, King of the Court). A match is a short link (${base}/CODE, 4 characters). People open the link, type a first name and are in. No accounts, no app, no passwords. Organisers get a private manage link. Levels 0–7 (Playtomic-style) are self-declared and nudged by results. Groups create their next match in one tap or on a weekly slot. A Telegram bot (@kicksmash_bot) keeps one live card per match in group chats: one tap joins. Venue boards list open matches at a club; club and city rankings (opt-in, last 90 days) live at /v/{slug}/ranking and /phuket, /singapore. Short answers to common organising questions live at /answers. Clubs claim their page at /clubs/claim (booking button, website, free courts from their own calendar feed); the first ten per city are founding clubs and everything stays free for them. Everything public here is readable by anyone, including AI assistants and crawlers; the data is CC BY 4.0 and the code is Apache-2.0.

## For assistants and agents

- MCP server (streamable HTTP, no auth needed for reads and modest writes): ${base}/mcp
- OpenAPI 3.1: ${base}/api/openapi.json
- Human and agent quickstart: ${base}/developers
- Collaboration charter (what you may do, what we ask): ${base}/agents
- Full reference for models: ${base}/llms-full.txt

## Public API (no key required)

- GET ${base}/api/v1/matches/{code}: a match with players, levels, spots left, result.
- GET ${base}/api/v1/boards/{venue-slug}: open matches at a venue.
- GET ${base}/api/v1/clubs?city=phuket and ${base}/api/v1/clubs/{slug}: club pages clubs manage themselves (booking link and platform, courts, today's free courts when the club shares its calendar, founding status).
- GET ${base}/api/v1/groups/{code}: a group with members and upcoming matches.
- GET ${base}/api/v1/schedule?players=8&courts=2: an exact americano rotation.
- POST ${base}/api/v1/matches: create a match (rate-limited per address without a key).
- POST ${base}/api/v1/matches/{code}/join: join a match by name.
- POST ${base}/api/v1/keys: get a key instantly for roomier limits and webhooks.
- Webhooks: match.created, match.joined, match.full, match.cancelled, match.result, signed with HMAC.

## Pages

- ${base}/: create a match (the landing page is the form)
- ${base}/americano: free schedule generator
- ${base}/about: privacy and terms, short
- ${base}/developers and ${base}/agents

## Source

- https://github.com/evhg/padel-matchup (Apache-2.0)
`;
}

/** Long form, for /llms-full.txt and the MCP "about" resource. */
export function llmsFullTxt(base: string): string {
  return `${llmsTxt(base)}
## How Kicksmash works, in detail

### Matches
A match has exactly four spots; a tournament has 4 to 64 in fours and one of three formats: americano (partners rotate, everyone plays everyone, exact rotation when the field is in fours), mexicano (round 1 random, then courts by standings with 1st+4th against 2nd+3rd, scores required before each round) or king (King of the Court: winners move up a court, losers down, partners split, standings follow the court you finish on). Spots are joined first come, first served. When full, either a waitlist opens (default, auto-promotion when someone leaves) or the match closes. Organisers can reserve spots for named people, who get a personal invite link. Any participant can enter the score after the start; once the organiser enters or edits it, it is confirmed and locked. Calendar invites (.ics) are emailed when people add an email; they update themselves on changes and cancellation and carry a "- COMPLETE" title suffix once the line-up is full.

### Identity
No accounts. A player is a name in a signed cookie plus a personal link (${base}/p/TOKEN) that signs any device in. The API returns that personal token for players it creates; reuse it so the same person is recognised. Never publish a personal token or a manage link; they are credentials.

### Levels
0 to 7 in quarter steps, self-declared, the scale most padel apps use. Results move it a little: when an organiser confirms a 2v2 score or finalises a tournament, an Elo-style delta (one level ≈ 10:1 odds, at most ±0.10 per match) is applied to rated players. Matches can carry a range (Bronze 1.0–2.5, Silver 2.5–3.5, Gold 3.0–4.5, Platinum 4.5+, or custom). Inside the range people join; outside they ask, and the organiser approves. Unrated players are asked for a level once. After a finalised result the organiser can confirm the levels of the people they played with; a confirmed level shows a tick and stays confirmed while it moves less than half a step. Rankings (per club at /v/{slug}/ranking and per city at /phuket, /singapore) count finalised results from the last 90 days, 3 points per win and 1 per draw, 3/2/1 for tournament podiums, and list only players who opted in.

### Groups
"Turn this crew into a group" makes a group from a match: same players, same defaults. Any member creates the next match from the group page, prefilled; everyone else is notified by email and push. A weekly slot creates the match automatically a few days ahead.

### Venue boards
Organisers can opt a match into the public board of its venue (${base}/v/venue-slug). Boards have a printable QR poster. Off by default.

### Americano engine
Exact rotation when the field is in fours: every pair partners once in players−1 rounds; the next round repeats round one. Otherwise a fair heuristic with sit-outs spread evenly. Standings are points scored, then point difference, then wins.

## Using the API well

- Reads need no key and are cached briefly. Writes work without a key from any address, with a daily allowance; a free key (POST /api/v1/keys, instant) raises it and enables webhooks. Send it as Authorization: Bearer <key>.
- All times are ISO 8601. Pass tz (IANA) so the match displays in the players' local time. A startsAt without an offset is read in tz.
- Errors are JSON: { "error": { "code", "message", "hint", "status" } }. The hint says what to do next.
- Rate limit responses (429) say how to get more room.
- Public shapes contain first names and levels only. No emails, phones, tokens or manage links ever appear in public data.
- Webhook payloads are signed: X-Kicksmash-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<unix>.<body>"> with the secret returned when the webhook was created.

## What we ask of assistants and integrators

1. Link back to the match page (${base}/CODE) when you show a match; that is how people join.
2. Treat personal tokens and manage links as secrets belonging to the person you act for.
3. Do not create matches nobody asked for. One request, one match.
4. Tell people plainly when a match was created or joined on their behalf, and give them the links.
5. If something is wrong or missing, say so in GitHub Discussions: https://github.com/evhg/padel-matchup/discussions (bugs: https://github.com/evhg/padel-matchup/issues)

## Licence

Code: Apache-2.0. Public match, board, group and schedule data: CC BY 4.0 (attribute "Kicksmash, kicksma.sh"). Personal data is never part of the public data.
`;
}

/** The collaboration charter, rendered on /agents and included in llms-full. */
export const CHARTER = [
  { h: "You may read everything public", p: "Match pages, boards, groups, schedules, the API and the MCP server are open to people and programs alike. Cache politely; the API tells you how long." },
  { h: "You may act for a person", p: "Create matches, join, generate schedules on someone's behalf. Give them the links the response returns and keep their personal token and manage link private." },
  { h: "You may build on it", p: "The code is Apache-2.0, the public data CC BY 4.0. Fork it, embed it, extend it. Adapters for booking platforms and messaging channels are one file each." },
  { h: "We ask for a link back", p: "When you show a match, link to its page. That is how the next player joins, and it is the only attribution we want." },
  { h: "We ask for restraint", p: "One request, one match. No matches nobody asked for, no bulk creation, no scraping of personal data (there is none in the public data anyway)." },
  { h: "We answer", p: "Issues and ideas go to GitHub. Security reports go to the address on /about. Both are read." },
] as const;
