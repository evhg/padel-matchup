import { APP_NAME } from "@/lib/config";

export const VALUE_PROP = "Kicksmash is the open, agent-native way to organise padel: create a match, share one link, and let people or their assistants join, all through an API that anyone may use.";

export const PROOFS = ["No accounts, no app: a first name and a link.", "Open API, open data (CC BY 4.0), open source (Apache-2.0).", "Every assistant welcome: MCP server, OpenAPI, llms.txt, crawlers allowed."];

/** Concise, for /llms.txt: what an assistant needs in one screen. */
export function llmsTxt(base: string): string {
  return `# ${APP_NAME}

> ${VALUE_PROP}

${APP_NAME} (${base}) organises padel matches and tournaments (americano, mexicano, King of the Court). A match is a short link (${base}/CODE, 4 characters). People open the link, type a first name and are in. No accounts, no app, no passwords. Organisers get a private manage link. Levels 0–7 (Playtomic-style) are self-declared and nudged by results. Groups create their next match in one tap or on a weekly slot. A Telegram bot (@kicksmash_bot) keeps one live card per match in group chats: one tap joins, /new makes a match in three taps or one line ("/new tomorrow 19:00 Rawai"), 🏁 on the card records who won, @kicksmash_bot typed in any chat drops a live card there, and the whole site opens inside Telegram as a Mini App. A Discord bot does the same for servers. Venue boards list open matches at a club; club and city rankings (opt-in, last 90 days) live at /v/{slug}/ranking and /phuket, /singapore. Short answers to common organising questions live at /answers. Clubs claim their page at /clubs/claim (booking button, website, free courts from their own calendar feed); the first ten per city are founding clubs and everything stays free for them. A player can switch on a public page at /u/{slug} with a signed, portable level (the passport), download all their data, and import a level from another app's scale (the mapping is shown on /levels). Coaches run their lessons book here too: a coach reads what changes at /coaches and sets up in four taps at /coach, students book free times from the coach's page (/c/{handle}) or through the Telegram assistant, packages count themselves, cancellations follow the coach's own cutoff and free-pass rule, waitlists offer freed slots for thirty minutes, and payment stays between coach and student (a PromptPay QR or the coach's own picture). Coaches who chose to be listed appear at /coaches/phuket and /coaches/singapore. Everything public here is readable by anyone, including AI assistants and crawlers; the data is CC BY 4.0 and the code is Apache-2.0.

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
- GET ${base}/u/{slug}/passport.json: a player's signed level (Ed25519 over canonical JSON, key at ${base}/.well-known/kicksmash-passport.json; verifyPassport in @erikv69/levels checks it). Public profiles at /u/{slug} are opt-in and off by default; never guess a slug. Signed-in players export everything at /api/me/export.
- GET ${base}/api/v1/groups/{code}: a group with members and upcoming matches.
- GET ${base}/api/v1/series?city=phuket and ${base}/api/v1/series/{slug}: Opens that repeat (a tournament series: same weekday and time every week, fortnight or month), each with the next edition to sign up for and the past podiums. Pages at /s/{slug}.
- GET ${base}/api/v1/coaches?city=phuket, ${base}/api/v1/coaches/{handle} and /slots: listed coaches, their rules and free starts. POST /requests (become a student, by name or token), POST /lessons (book, accepted students) and DELETE /lessons/{id} (cancel; the outcome says refunded, free_pass or counted). MCP tools: find_coaches, coach_slots, request_coach, book_lesson, cancel_lesson.
- GET ${base}/api/v1/schedule?players=8&courts=2: an exact americano rotation.
- POST ${base}/api/v1/matches: create a match (rate-limited per address without a key).
- POST ${base}/api/v1/matches/{code}/join: join a match by name.
- POST ${base}/api/v1/keys: get a key instantly for roomier limits and webhooks.
- Webhooks: match.created, match.joined, match.full, match.cancelled, match.result, signed with HMAC.

## Feedback
Players and assistants can tell us what should change: /feedback in Telegram or Discord, ${base}/feedback, or email feedback@kicksma.sh. Every note is read; when it changes Kicksmash, the person who sent it hears what changed.

## Telegram, for people who live there

- Add @kicksmash_bot to a group chat. /new asks for a day, a time and a place with buttons; or write it in one line: /new tomorrow 19:00 Rawai (cost such as 400฿ and a level range such as 3-4 are optional words). The card lands in the chat; people tap ✅ I'm in.
- After the match, 🏁 Result on the card: pick who won, the organizer confirms; /score CODE 6-3 6-4 adds sets. Results move levels.
- Time changes and cancellations reach the players privately; organizers hear who joined.
- Private chat with the bot: /games phuket lists open matches; /new works there too; a code shows its card. Typing @kicksmash_bot in any chat shares a live card without adding the bot. https://t.me/kicksmash_bot

## Pages

- ${base}/: create a match (the landing page is the form)
- ${base}/ru and ${base}/es: the same pages in Russian and Spanish
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

### Telegram
The bot is quiet by design: one card per match, edited in place; new messages only for the card, a complete line-up, the reminder, the result, and (privately) a time change or cancellation. Commands: /new (three taps, or one line with a day, a time, a place, optional cost and level; "public" lists the match on the city board), /match CODE, /score CODE 6-3 6-4, /games [city], /tz, /lang. A chat becomes a group's chat once a group match is carded there; the weekly slot's card then arrives by itself. Inline mode (@kicksmash_bot CODE or a city) sends a live card into any chat. The Mini App (t.me/kicksmash_bot/KickSmash) opens the site signed in from Telegram's own data; the Login Widget signs people in on the web.

### Coaches
A coach's page (${base}/c/{handle}) is their lessons book: hours per weekday, lesson length, clubs, languages, the cancellation cutoff (default 12 hours), free late passes per package (default 1) and the shortest notice (default 2 hours). A student asks once ("ask to become a student"); once accepted they book free times themselves, in the coach's zone, and cancel: before the cutoff the lesson goes back on the package, after it a free pass covers it if one is left, otherwise it counts; the coach's own cancellation never counts and comes back to the student with the nearest free times. A taken time can be waited for: the first in line gets it for thirty minutes when it frees. A time outside the hours is a request the coach answers yes or no. Packages are a number of lessons with an expiry; "6 of 10 left · 23 days" is what everyone sees. Money never passes through Kicksmash: the coach's PromptPay QR (with the package amount) or their own QR picture is shown and "paid" is a note the coach makes. Coaches can attach their Google Calendar by sharing it with our service address (lessons appear there; what they write there blocks time here) or an iCal link (read-only), bring their package sheet in one paste, and hand a manager link to whoever runs their bookings. Listing is opt-in; a listed coach is at /coaches/{city}, in the sitemap and in the API. Assistants: find_coaches → coach_slots → request_coach (once, keep the token) → book_lesson / cancel_lesson.

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
