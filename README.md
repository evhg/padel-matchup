# Kicksmash — padel match-up in one link

[![CI](https://github.com/evhg/padel-matchup/actions/workflows/ci.yml/badge.svg)](https://github.com/evhg/padel-matchup/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Mobile-first web app for organizing padel matches with **zero app installs, zero accounts, zero passwords**. Create a match, share `kicksma.sh/{code}` on WhatsApp or Telegram, friends tap → enter a name once → they're in.

- **Stack:** Next.js 15 (App Router, TypeScript) · Supabase Postgres + Drizzle · Resend · next-intl (EN/RU/ES) · Tailwind v4 · Vercel (Cron + OG images).
- **Open source** under the [Apache License 2.0](LICENSE). Run your own copy, build on it, send a PR: see [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
- **Identity:** one-time name entry → player UUID in a signed httpOnly cookie (1 year) + localStorage mirror. Cross-device: every player has a private **personal link** (`/p/{token}`, shown on My matches, in every email and in the calendar invite) that signs any device in; an email that was used before can **restore** history with a 6-digit code, merging all identities that share it. The home-screen shortcut opens the personal link, and calendar entries and emails carry the **private event link** (`/p/{token}/{code}`: signs the device in, opens the match). A newly added email receives the personal link (inside the calendar invite when in a match, otherwise on its own). Tokens are 12 characters; older 32-char tokens keep working as `previous_token` after the lazy shortening. An email can be changed but never blanked once set; the previous address is kept as `recovery_email`, so a restore code sent to either address gets the player back in. "Email me this link" on My matches mails the personal link (native share, copy and QR are the other options).
- **Push reminders:** Web Push (VAPID) one hour before each match, for every device the player enabled it on (iPhone: from the home-screen app). `/api/cron/push` is called every 5 minutes by Supabase `pg_cron` + `pg_net` (Vercel Hobby cron is daily). Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
- **Links:** `/{code}` (4 chars, public) · `/{code}/i/{6}` (personal invite) · `/{code}/manage/{10}` (organizer secret).
- **Agent-native and open.** A public REST API (OpenAPI 3.1 at `/api/openapi.json`), an MCP server at `/mcp` that any assistant adds by URL, instant self-serve keys, signed webhooks, `llms.txt`, `/.well-known/mcp.json`, a robots.txt that welcomes AI crawlers, `AGENTS.md`, an installable skill (`npx skills add evhg/padel-matchup`), calendar feeds per group and venue. Public data is CC BY 4.0. See `/developers` and `/agents`.
- **Email is optional everywhere.** Without `RESEND_API_KEY` the app runs fully with email features hidden.
- **Privacy, short and cheeky:** `/about` (one faint footer link) says what is stored, what is never done, and how to leave. Every organizer-initiated email (invites, invite reminders) carries a signed one-tap `/unsubscribe` link; a player adding their own address again lifts the opt-out. "Delete my account" at the bottom of My matches wipes personal data, releases upcoming spots and cancels the player's own upcoming matches; old scores stay as "Deleted player".
- **Levels:** every player can declare a padel level (0–7 in quarter steps, the scale the padel apps use) once, from My matches or the first time a ranged match asks for it. It shows as a small chip next to the name everywhere (roster, standings, team picker). Results nudge it: when the organizer confirms a 2v2 score or finalizes a tournament, a small Elo-style delta (at most ±0.10 per match, ±0.12 per tournament) is applied once per event and logged ("3.25 → 3.30 after a match"). Players without a level neither move nor count. Organizers can set a **level range** per match or tournament: presets Bronze 1.0–2.5, Silver 2.5–3.5, Gold 3.0–4.5, Platinum 4.5+, or a custom min–max. Players inside join as usual; players outside **ask to join** and the organizer approves (seats them, or waitlists them when full) or declines, with the answer shown in the join bar and the activity feed. Reserved/invited players and the organizer bypass the range. The score panel suggests **balanced teams** (smallest level gap) when all four have levels. My matches gets a stats strip: played, won, win rate, podiums.
- **Abuse limits** (per UTC day unless noted, generous for humans, tight for scripts): 40 new identities per IP, 20 matches per player, 40 invitations per organizer, 30 joins per player per hour, 10 email changes, 5 personal-link mails, 20 restore codes per IP, 60 browser crash reports per IP. Counters live in `metrics_daily`, no extra infrastructure. Hitting one returns "too many" and nothing else happens.

---

## Quick start (zero config, ~2 min)

```bash
pnpm install
pnpm dev
```

That's it. With no `DATABASE_URL` the app boots an **embedded PGlite database** in `./.pglite`, applies migrations and seeds two example events:

| URL | What you get |
| --- | --- |
| http://localhost:3000/PLAY | Upcoming match: 2 joined, 1 reserved invite, 1 open spot |
| http://localhost:3000/PAST | Finished match with an organizer-confirmed 3-set score |
| http://localhost:3000/new | Create your own |

Copy `.env.example` to `.env` to change anything. All flows (join, waitlist, invites, scores, "My matches", OG previews) work end-to-end without any keys.

```bash
pnpm test        # vitest: slot-claim concurrency, invite transitions, score-lock rules, reminders, identity, americano rotation, rate limits, opt-outs, account deletion
pnpm typecheck
pnpm lint
pnpm build
pnpm e2e         # Playwright journeys (core, americano, levels, viral, groups, venues, agents, formats) against a fresh production build; first time: pnpm exec playwright install chromium
```

`pnpm e2e` boots `next start` on port 3001 with a throwaway PGlite database, a dummy Resend key (email UIs on, sends fail harmlessly) and generated VAPID keys, then runs every `e2e/*.mjs` suite. `SHOTS=./shots` keeps full-page screenshots; `PW_CHROMIUM=/path/to/chromium` uses a preinstalled browser. GitHub Actions runs typecheck, lint, vitest on PGlite **and** on a real Postgres service, the build, and the e2e suites on every push and pull request (`.github/workflows/ci.yml`).

Tests run on in-memory PGlite by default. To run them against a real Postgres (true concurrency), point `TEST_DATABASE_URL` at a **disposable** database — its `public` schema is dropped before each test file:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/padel_test pnpm test
```

---

## Environment variables

Only **one** variable is required in production: the database URL. Everything else has a safe default.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Supabase **Transaction pooler** string (port 6543), exactly as Supabase's Connect dialog shows it. `POSTGRES_URL` (Vercel ⇄ Supabase integration) works too. Empty → embedded PGlite (local dev only). |
| `DATABASE_PASSWORD` | if the URL still says `[YOUR-PASSWORD]` | The app substitutes and percent-encodes it for you. |
| `APP_BASE_URL` | no | Defaults to the Vercel production domain. Set it locally or on other hosts. |
| `SESSION_SECRET` | recommended | Signs the identity cookie. Without it a stable secret is derived from the database URL. |
| `CRON_SECRET` | recommended | Protects `/api/cron/hourly` and `/api/cron/push`. Vercel sends it automatically when set. |
| `DIRECT_DATABASE_URL` | no | Direct (5432) URL for `pnpm db:migrate`. Not needed: the app migrates itself on first connection (`AUTO_MIGRATE=false` disables). |
| `RESEND_API_KEY` | no | Enables all email (calendar invites, notifications, reminders). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | no | Enables push reminders (`npx web-push generate-vapid-keys`). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` / `TELEGRAM_BOT_USERNAME` | no | Enables the Telegram bot and Telegram sign-in. Register the webhook once with `GET /api/telegram/setup` (Bearer `CRON_SECRET`). |
| `ANTHROPIC_API_KEY` | no | Drafts replies for the listening desk (use a key with a monthly spend cap). `LISTEN_MODEL` overrides the model. |
| `TELEGRAM_OWNER_ID` | no | The owner's Telegram id: drafts are sent there for one-tap approval and `/admin/listen` opens for that account only. |
| `PASSPORT_PRIVATE_KEY` / `PASSPORT_PUBLIC_KEY` | no | Ed25519 key pair (raw 32-byte hex each) that signs player passports. Without them passports carry `alg: "none"`. Generate with `node -e "const {generateKeyPairSync}=require('crypto');const k=generateKeyPairSync('ed25519');console.log(k.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex'), k.privateKey.export({type:'pkcs8',format:'der'}).subarray(-32).toString('hex'))"`. |
| `DISCORD_BOT_TOKEN` / `DISCORD_PUBLIC_KEY` | no | Enables the Discord bot (slash commands, cards, the in-server helper). Register commands and the interactions URL once with `GET /api/discord/setup` (Bearer `CRON_SECRET`); it returns the install link. `DISCORD_INVITE_URL` shows the server on the community pages. |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USERNAME` / `REDDIT_PASSWORD` | no | Lets an approved reply be posted on Reddit as the project's account. Without them, Approve means copy and paste. |
| `EMAIL_FROM` | no | Defaults to `Kicksmash <matches@<your domain>>`; the domain must be verified in Resend. |

Generate secrets: `openssl rand -base64 32`. Check a deployment any time at `/api/health` (no secrets returned).

---

## Production setup

Two ways. **Option A** needs no terminal at all. **Option B** scripts everything that can be scripted.

### Option A — browser only (≈ 20 min + DNS)

1. **Supabase** (5 min): https://supabase.com/dashboard/new → create a project, save the database password. Click **Connect** → copy the **Transaction pooler** string (port 6543). Leave `[YOUR-PASSWORD]` in it.
2. **Vercel** (5 min): https://vercel.com/new → **Import** `evhg/padel-matchup` (the code must be on the repo's default branch). Under **Environment Variables** add:
   - `DATABASE_URL` = the string from step 1, unchanged
   - `DATABASE_PASSWORD` = your database password
   Click **Deploy**. The first request creates the tables automatically.
3. **Check**: open `https://<your-project>.vercel.app/api/health` → `"database":"connected"`.
4. **Domain** (5 min + waiting): Vercel → Project → **Settings → Domains → Add** `kicksma.sh` (and `www.kicksma.sh`). Vercel shows the records. At Porkbun → **Domain Management → kicksma.sh → DNS**: delete the parking `ALIAS`/`CNAME` records, then add the `A` record (Host empty) and the `www` `CNAME` with the values Vercel shows. Wait until Vercel says **Valid Configuration**.
5. Later, optionally: `SESSION_SECRET`, `CRON_SECRET`, `RESEND_API_KEY` + `EMAIL_FROM` in **Settings → Environment Variables**, then **Deployments → ⋯ → Redeploy**.

Cron runs daily at 07:00 UTC out of the box, which is what Vercel's Hobby plan allows. On Pro, change the schedule in `vercel.json` to `0 * * * *` for hourly reminders.

### Option B — CLI

#### 1. Supabase (≈ 10 min)

1. Create a project at https://supabase.com/dashboard/new (or `npx supabase projects create kicksmash --org-id <id> --db-password <pw> --region eu-central-1`). Pick the region closest to your players. Save the DB password.
2. Project → **Connect** (top bar) → copy two URLs:
   - **Transaction pooler** (`...pooler.supabase.com:6543/postgres`) → `DATABASE_URL`
   - **Direct connection** (`db.<ref>.supabase.co:5432/postgres`) → `DIRECT_DATABASE_URL`
   Append `?sslmode=require` to both if it isn't there.
3. Put them in `.env`. The schema is applied automatically on first connection; to do it explicitly:
   ```bash
   pnpm db:migrate     # runs ./drizzle/*.sql against DIRECT_DATABASE_URL
   pnpm db:seed        # optional: example matches PLAY + PAST
   ```
4. Sanity check: `pnpm dev` now says nothing about PGlite and `/api/health` reports `"database":"connected"`.

No Supabase Auth, RLS or storage is used — only Postgres.

#### 2. Resend (≈ 15 min incl. DNS)

Skip this entirely if you don't want email yet; deploy never blocks on it.

1. https://resend.com → **API Keys** → create key (Sending access) → `RESEND_API_KEY`.
2. **Domains → Add domain** → `kicksma.sh` (region: same continent as Vercel). Resend shows 3–4 DNS records.
3. Add them at Porkbun (see §4 for the editor quirks). Names below are what Porkbun expects in the **Host** field (it appends `.kicksma.sh` itself) — **copy the exact values from Resend's screen**:

   | Type | Host | Value |
   | --- | --- | --- |
   | TXT | `resend._domainkey` | `p=MIGf…` (DKIM, from Resend) |
   | MX | `send` | `feedback-smtp.<region>.amazonses.com`, priority 10 |
   | TXT | `send` | `v=spf1 include:amazonses.com ~all` |
   | TXT | `_dmarc` | `v=DMARC1; p=none;` |

4. Back in Resend click **Verify**. Usually green within minutes (up to an hour).
5. Set `EMAIL_FROM="Kicksmash <matches@kicksma.sh>"`.

Emails sent: calendar invite (.ics, `METHOD:REQUEST`, stable UID) on join/confirm/promotion · updated/cancelled .ics · organizer notices (joined / left / confirmed / declined / promoted) · 24h invitee reminders · one post-match score reminder · welcome mail with the personal link · restore codes. All EN + RU + ES by recipient language. Invites and invite reminders skip addresses on the opt-out list and carry the unsubscribe link; the activity notices respect the player's "email me" switch.

#### 3. Deploy to Vercel via CLI (≈ 10 min)

```bash
pnpm dlx vercel@latest login          # opens the browser; or: vercel login --github
pnpm dlx vercel link                  # create a new project "kicksmash" (framework auto-detected: Next.js)

# Production env vars (paste values when prompted; repeat for each)
for v in DATABASE_URL DIRECT_DATABASE_URL SESSION_SECRET CRON_SECRET APP_BASE_URL RESEND_API_KEY EMAIL_FROM; do
  pnpm dlx vercel env add $v production
done
# APP_BASE_URL = https://kicksma.sh

pnpm dlx vercel --prod                # first production deploy
```

Token flow for CI / headless machines: create a token at https://vercel.com/account/tokens and use `vercel --token $VERCEL_TOKEN --prod --yes`.

Build settings need no changes (`pnpm build`, Node 20+). The migration is **not** run at build time — run `pnpm db:migrate` locally whenever `drizzle/` changes.

#### 4. Custom domain `kicksma.sh` at Porkbun (≈ 10 min + DNS propagation)

Production goes straight to the custom domain; no `*.vercel.app` staging step.

1. Add the domain to the project:
   ```bash
   pnpm dlx vercel domains add kicksma.sh
   pnpm dlx vercel domains add www.kicksma.sh   # optional; Vercel redirects www → apex
   ```
   The CLI (and **Project → Settings → Domains**) prints the exact records to create.
2. Porkbun → **Domain Management → kicksma.sh → DNS**.
   - **Delete Porkbun's default records first** (the parking `ALIAS`/`CNAME` on `@` and `www`). Vercel's A record can't coexist with an ALIAS on the apex.
   - The **Host** field is relative: leave it **blank** for the apex, type `www` for www.
3. Create — **copy the exact values from Vercel's domain screen** (typical values shown):

   | Type | Host | Answer |
   | --- | --- | --- |
   | A | *(blank)* | `76.76.21.21` |
   | CNAME | `www` | `cname.vercel-dns.com` |

4. Wait for Vercel to show **Valid Configuration** (`vercel domains inspect kicksma.sh`). SSL is issued automatically. Porkbun's TTL is 600s; worst case a couple of hours.
5. Redeploy once so `APP_BASE_URL` links are baked correctly: `pnpm dlx vercel --prod`.
6. Test the link preview: paste `https://kicksma.sh/PLAY` into a WhatsApp/Telegram chat — title, date/time, venue and "2/4 players — tap to join" should render. Debug with https://www.opengraph.xyz/ or `curl -I https://kicksma.sh/PLAY/opengraph-image`.

Also add the Resend records from §2 in the same DNS editor if you skipped them.

#### 5. Cron (already configured, ≈ 2 min to verify)

`vercel.json` schedules `GET /api/cron/hourly` daily at 07:00 UTC (Hobby-plan safe; on Pro set `0 * * * *` for hourly). Vercel automatically sends `Authorization: Bearer $CRON_SECRET` when that variable is set; without it the endpoint is open but every step is idempotent.

The job does: `open/full → past` transitions · waitlist hygiene · 24h invite reminders (email only, stops on response or start) · the single organizer score reminder (2h after start) · automatic group matches for weekly slots (with member notifications) · daily metric snapshots.

Verify: **Project → Settings → Cron Jobs** shows the job, or trigger by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://kicksma.sh/api/cron/hourly
# → {"ok":true,"transitionedToPast":0,"promotions":0,"inviteReminders":0,"scoreReminders":0,...}
```

Hobby plan crons run once a day at best-effort times; Pro runs them on the minute.

---

## npm packages

The pure engines ship as packages, generated from `src/lib/domain` so there is one source of truth:

- [`@erikv69/americano`](https://www.npmjs.com/package/@erikv69/americano): `buildSchedule({ names | players, courts, rounds, seed })` for a whole americano, plus the round-by-round planners (`planRound`, `planMexicanoRound`, `planKingRound`), histories and standings.
- [`@erikv69/levels`](https://www.npmjs.com/package/@erikv69/levels): bands, presets, ranges and `levelFit`, `balancedTeams`, `matchDeltas` and `tournamentDeltas`.

`pnpm packages:build` regenerates `packages/*/src` and `packages/*/dist` (both gitignored); `tests/packages.test.ts` builds them on every CI run. To release: bump the version in `packages/<name>/package.json`, build, `npm publish` from that directory.

## Community

Questions, ideas and "I built a thing on the API" go to [GitHub Discussions](https://github.com/evhg/padel-matchup/discussions). Bugs go to issues. There is a Discord server too (the link is on `/developers`), where the bot answers questions about once an hour. The Telegram bot and the Reddit account answer people where they are; the code and the roadmap live here.

## Deploy your own

Kicksmash is one Next.js project and one Postgres database, Apache-2.0. Run it for your club, your city or your country; the environment table above is the whole configuration.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fevhg%2Fpadel-matchup&project-name=kicksmash&repository-name=kicksmash&env=DATABASE_URL,DIRECT_DATABASE_URL,SESSION_SECRET,APP_BASE_URL&envDescription=Postgres%20connection%20strings%2C%20a%20random%20session%20secret%20and%20your%20public%20URL&envLink=https%3A%2F%2Fgithub.com%2Fevhg%2Fpadel-matchup%23environment-variables)

Or with Docker (standalone Next.js build, about 200 MB):

```bash
docker build -t kicksmash .
docker run -p 3000:3000 --env-file .env kicksmash   # then: pnpm db:migrate against the same DATABASE_URL
```

Everything optional stays optional: without a Resend key no emails go out, without a bot token there is no Telegram or Discord, without an Anthropic key the listening desk only collects. Keep the `/agents` charter and the CC BY 4.0 notice if you keep the public API.

## Product rules baked in

- **Match = exactly 4 players.** Tournament = creator-set capacity (4–64, in fours) running as an **americano**: round 1 needs names in fours (reserved-but-unaccepted names count; they get a placeholder player that merges into the real one on accept) and closes any spots still open, so the tournament becomes exactly the players present; the organizer generates rounds on the day (rotating partners, fair sit-outs, 1–N courts), courts follow the players (one per four) and can be given real names, the schedule is exact when the field is in fours (every pair partners once in players−1 rounds; the next round replays round 1), the latest round can be deleted even if scored (confirmed), any participant enters per-court points as soon as a round exists (no need to wait for the start time), standings update live, the organizer finalizes to lock.
- **Fast create:** quick-pick chips only from the organizer's own history (their usual weekday/time slots, projected to the next occurrence; the default date is their most usual slot), venue optional ("Court TBD") with an optional court field (court appears in the page, share text, email and calendar titles), the landing page *is* the form, "Play again next week" appears once a result is in and clones the match in one tap, and an Add-to-Home-Screen prompt gives organizers an app-like shortcut to their personal link.
- **When full:** per event, waitlist with auto-promotion on dropout (leave / removal / declined invite) or hard close.
- **Join** is first-come-first-serve and atomic: the event row is locked per mutation and one `UPDATE … WHERE id = (SELECT … LIMIT 1)` claims exactly one slot, so two taps on the last spot resolve cleanly (tested with 12 parallel joins).
- **Reserved slots** get a personal invite link. The organizer reserves by tapping an open spot in the roster, which expands in place (name, optional phone/email, Done); with an email the invite is sent immediately ("Invite emailed"); without one the row says "Invite not yet accepted" and offers "Invite now" / "Remove player". Anyone else tapping an open spot joins in place. When a reserved player's email is already known from another identity, the invite page offers "Played before with …? Restore with a code" before confirming; typing a known email or phone in the reserve form suggests that player's name. A known email is shown with an Edit button instead of being asked for again, plus an on/off switch for activity emails (join/leave/respond notices, line-up changes, the score reminder); calendar invites, time changes and cancellations always go out.
- **Activity feed** is phrased from the viewer's side: "You added Zed" vs "Zed was added by Erik". No popups anywhere: overlays drift off screen on iOS once the keyboard opens.
- **Calendar = email.** "Add to your calendar" asks members without an email for one and sends a real invitation (updates itself on changes and cancellation). No Google/Apple buttons: those create unlinked copies we could never update. Calendar entries carry exactly one link, the short private event link (`kicksma.sh/p/{12 chars}/{code}`), plus the player list once complete.
- **Line-up complete:** when every spot is joined/confirmed the calendar entry is re-sent with `- COMPLETE` in the title and the player names in the description (and reverted if someone drops out). The app never messages anyone; organizers get one-tap WhatsApp / Telegram forward buttons with pre-filled localized text. Declined slots become open spots.
- **Rolodex:** everyone who ever joined or was invited to your events, with their email/phone reused automatically.
- **Venue memory:** last-used venue pre-filled, all previous venues in the combobox, free text adds a new one.
- **Timezone:** default from Vercel's `x-vercel-ip-timezone` (browser zone as fallback), editable, stored UTC.
- **Score:** any participant after start; players can correct each other; once the organizer enters/edits it locks ("Confirmed by organizer"). 1–3 sets, optional team assignment → win/loss in **My matches**.
- **Organizer access** = creator cookie **or** the 10-char manage link (sets a per-event httpOnly cookie).
- **Telegram bot (@kicksmash_bot), quiet by design:** add it to a padel group chat and it keeps **one card per match** there: title, time, venue, level range, the roster with levels, spots left, and two buttons, "I'm in" and "Can't make it". Taps join or leave through the same code path as the web button (organizer note, calendar invite, waitlist promotion, webhooks); the card is **edited in place**, never re-posted. The bot posts a new message only four times: the card itself (`/new` hands out a create link bound to the chat; a pasted kicksma.sh link becomes a card when the bot is admin or privacy mode is off; `/match CODE` works always), one short "line-up complete" note, one reminder about an hour before (via the 5-minute push cron), and the result picture once the organizer confirms. English or Russian per chat (`/lang`). People who tap become players with just their first name; **Telegram sign-in** on My matches (Login Widget) links or merges that account with the browser identity. Module: `src/lib/telegram/`.
- **Discord bot, the same manners:** HTTP interactions only (no gateway process), so it runs on the same serverless functions. `/new` hands out a create link bound to the channel, `/match CODE` posts the card, the two buttons join and leave through the shared operations and the card **updates in place** for everyone; one "line-up complete" note, one reminder, the result once. `/ask` answers a padel or Kicksmash question on the spot, and the hourly tick reads new messages in the servers the bot is in, keeps the ones that read like questions and answers them in a reply (this is our own community, so no tap is needed; the shared daily budget still applies, and every reply grows an answer page). `/lang en|ru` per channel. Module: `src/lib/discord/`.
- **Listening desk (helpful replies, never on their own):** every hour the app reads public feeds where people ask about organising padel (Hacker News via Algolia, r/padel and Reddit searches via RSS), keeps the last week of items, gates them cheaply (padel + an organising intent), and asks the model for a reply in the thread's language under strict tone rules: answer first, no hype, mention kicksma.sh at most once and only when it solves the question, disclose that we build it. Drafts go to the owner on Telegram with **Approve / Skip / Edit** buttons, at most six a day; Approve posts on Reddit as the project's account (or, without Reddit keys, marks it for a manual copy). `/admin/listen` is the desk (owner only, via Telegram sign-in). Daily ceilings on drafts and tokens keep a capped API key safe. Approved replies grow into evergreen **answer pages** at `/answers/{slug}` (question rewritten generically, QAPage JSON-LD, in the sitemap), published at once; a Sunday digest on Telegram lists the week and offers one-tap Unpublish for each new page. Module: `src/lib/listen/`.
- **Embeds and oEmbed:** `/embed/board/{slug}` and `/embed/match/{code}` are iframe-safe views (no header, opens on kicksma.sh in a new tab, "Live from kicksma.sh" footer); the venue board shows the snippet under "Embed this board". `/api/oembed?url=…&format=json` is an oEmbed provider and match and board pages advertise it with `<link rel="alternate" type="application/json+oembed">`, so WordPress, Discourse, Ghost and Notion unfurl a pasted link into the live card. Helper: `src/lib/embed.ts`.
- **Deploy your own:** the app is one Next.js project with a Postgres database. `Dockerfile` builds a standalone image; the README's environment table is the whole configuration. Everything is Apache-2.0; run it for your club, your city or your country.
- **Tournament formats:** besides the americano rotation a tournament can run as a **mexicano** (round 1 random, then the courts follow the standings, 1st+4th against 2nd+3rd on each court; the next round waits for all scores) or as **King of the Court** (winners move up a court, losers move down, the top court's winners and the bottom court's losers stay, partners split every round, standings follow the court you finish on). Chosen with one chip when creating a tournament, changeable until round 1. Engine: `src/lib/domain/formats.ts`.
- **Organizer-verified levels:** after a finalized result the organizer sees a folded "Confirm levels" row and confirms, one tap each or all at once, the levels of the people they played with. A confirmed level shows a ✓ next to the chip and stays confirmed while it moves less than half a step.
- **Rankings (opt-in, off by default):** `/v/{slug}/ranking` ranks a club's finalized results from the last 90 days (3 points per win, 1 per draw, 3/2/1 for tournament podiums); `/phuket` and `/singapore` do the same across a city's clubs and list the open matches there. Only players who switched on "Show me in rankings" (My matches, or one tap on a ranking page) appear. Cities: `src/lib/domain/cities.ts`.
- **Levels (0–7):** players declare their level once in quarter steps (a plain select grouped by band, with a short guide); it shows next to their name in rosters, standings and the score panel. Results nudge it: when the organizer confirms a 2v2 match score or finalizes a tournament, an Elo-style delta (one level of difference ≈ 10:1 odds, at most ±0.10 per match, ±0.12 per tournament) is applied once per event to every rated player, the source becomes "adjusted by results" and the last change is shown on My matches with a capped log. Unrated players never move and never count.
- **Level ranges:** a match or tournament can be Bronze (1.0–2.5), Silver (2.5–3.5), Gold (3.0–4.5), Platinum (4.5+) or a custom min–max; the range shows as a chip in the hero. Inside the range people join as usual (the join form asks for a level once); outside it the button turns into **Ask to join**, the organizer sees the requests with the level and approves (seats or waitlists) or declines, the requester sees the answer in the join bar and gets a calendar invite or a short note by email. Organizer-reserved invites and promotions bypass the range. **Balanced teams:** when all four have levels, the score panel suggests the 2v2 split with the smallest gap.
- **Stats strip** on My matches: played, won, win rate, podiums (from confirmed team results and finalized standings).
- **Club pages and founding clubs:** any venue board can be claimed by the club that runs it at `/clubs/claim` (name, booking page, website, courts, a few lines about the club; a city when it is one of ours). The claim is self-serve and the owner approves each one with a single Telegram tap (the only review, there to keep a wrong booking link off a club's page). Once live, `/v/{slug}` shows "Book on Playtomic / MATCHi / Playbypoint …" (the platform is recognised from the link, also on every match at that club), the website, the about text, the badges, and **free courts today** when the club shares a feed it already has: a calendar of bookings (`.ics`, free = courts − overlapping bookings inside opening hours) or a JSON list of free slots, refreshed hourly, nothing scraped, nothing we were not handed. The first ten clubs per city are **founding clubs**: everything stays free for them for good. `/clubs` lists live clubs by city; `GET /api/v1/clubs?city=phuket` and `/api/v1/clubs/{slug}` expose the same publicly; the MCP tool is `find_clubs`. Clubs manage their page through a private link that also shows on My matches. Modules: `src/lib/domain/clubs.ts`, `src/lib/booking/` (platform detection, availability adapters).
- **Player passport (opt-in, off by default):** under My matches a player can switch on a public page at `/u/{slug}` (first name, level with band and the organizer-confirmed tick, played / won / win rate / podiums, the clubs they play at) and gets a **signed level document** at `/u/{slug}/passport.json`: Ed25519 over canonical JSON, public key at `/.well-known/kicksmash-passport.json`, `verifyPassport` in `@erikv69/levels`, 90-day expiry. No list of profiles exists. **Download my data** (`/api/me/export`) is one JSON file with everything we hold, tokens and manage links excluded. **Level import:** the level picker folds a "Have a level in another app?" row that maps Playtomic (same 0–7), 1–10 club scales and five-category systems onto 0–7 in the open; the table is on `/levels`. Modules: `src/lib/domain/passport.ts` (pure, WebCrypto), `src/lib/domain/profile.ts`.
- **Result cards:** once a match has a score or a tournament has a scored round, "Share result" opens `/{code}/card`: a page whose link unfurls with a generated picture (score boxes with the winning side highlighted, or the top five of the table) in WhatsApp and Telegram, the picture itself to long-press and save, share buttons, and "Organize your own match" as the way in.
- **Groups:** "Turn this crew into a group" on any match with two or more players makes a group (`/g/{6 chars}`) with the match's settings as defaults (venue, format, capacity, level range, time zone) and its players as members; the person who taps is the admin. Anyone with the link joins (name only); joining a group's match or accepting its invite makes you a member too. **Any member creates the next match** from the group page: the create form comes prefilled (including the next weekly slot), the match is linked back, and every other member gets an email and a push with their private link. Admins can set a **weekly slot**: the hourly cron creates the next match a few days ahead (lead time 1–14 days, default 5), seats the group's creator, notifies everyone, and never creates the same occurrence twice. My matches lists your groups with the next match of each.
- **Venue boards (opt-in, off by default):** an organizer can tick "Show on the venue board" when creating or editing a match with a venue. Listed, upcoming, not-cancelled matches appear on `/v/{venue-slug}` (a public page named after the venue, with spots left and level range), and the match shows an "On the … board" chip. `/v/{slug}/poster` is a one-page printable poster with a QR code to the board ("Scan for open padel matches at …"). The board's empty state and footer lead to the create form with the venue prefilled and the listing switched on. Slugs are ASCII-only and kept in sync when a venue is renamed; removing the venue unlists the match.
- **Americano generator:** `/americano` is a public, indexable page running the same rotation engine in the browser: players (or pasted names), courts, rounds; exact rotation when the field is in fours, fair sit-outs otherwise; print stylesheet; "Run it live on Kicksmash" prefills the create form (`/?type=tournament&capacity=N`). `robots.txt` and `sitemap.xml` cover `/`, `/americano` and `/about`; personal, manage, invite, share and card pages stay out of the index.

## API, MCP server and webhooks

Everything public on the site is available to programs and assistants, and everything the create form does is one call away.

| Surface | Where |
| --- | --- |
| REST reads (no key) | `GET /api/v1/matches/{code}`, `/api/v1/boards/{slug}`, `/api/v1/groups/{code}`, `/api/v1/schedule?players=8&courts=2` |
| REST writes (key optional, rate-limited per address without one) | `POST /api/v1/matches`, `POST /api/v1/matches/{code}/join` |
| Keys | `POST /api/v1/keys` → instant, shown once; `Authorization: Bearer ks_live_…` |
| Webhooks (key required) | `POST /api/v1/webhooks` with `url`, `events`, optional `filter`; signed `X-Kicksmash-Signature: t=…,v1=…`; retried with backoff by the hourly cron |
| MCP | `POST /mcp` (streamable HTTP, stateless JSON): `about_kicksmash`, `get_match`, `find_matches`, `get_group`, `generate_schedule`, `create_match`, `join_match`, `create_api_key`; resources with the model reference and the OpenAPI document |
| Discovery | `/llms.txt`, `/llms-full.txt`, `/.well-known/mcp.json`, `/api/openapi.json`, `/developers`, `/agents`, `robots.txt` explicitly allows AI crawlers |
| Feeds | `/g/{code}/calendar.ics`, `/v/{slug}/calendar.ics` |

Public shapes (`src/lib/api/serialize.ts`) carry first names and levels only; emails, phones, personal tokens and manage links never appear. Errors are `{ error: { code, message, hint, status } }`; every hint says what to do next. Limits live in `src/lib/domain/ratelimit.ts`.

### Registries and marketplaces

`server.json` at the repository root is the manifest for the official MCP registry (namespace `io.github.evhg`); publishing is one command for the repository owner: `mcp-publisher login github && mcp-publisher publish`. The skill in `skills/kicksmash/SKILL.md` is picked up by the skills index from the public repository. Smithery, Glama and mcp.so accept the remote URL `https://kicksma.sh/mcp` through their web forms.

## Admin dashboard

`/admin` is a public, read-only usage page: hero figure with a health row (database, email, push, both crons, **errors today**), stat tiles with sparklines, meters against the free-tier ceilings (Supabase 500 MB, Resend 3,000/month and 100/day), and 7/30/90-day trend charts (growth, joins, outbound messages, errors, database size, totals). Counters live in `metrics_daily` (bumped by the app, snapshotted by the hourly cron); no personal data is shown. Errors are counted, never described: server actions that throw, cron steps that fail and browser crash screens (`/api/client-error`, rate-limited) each bump a counter, so the health row is the only alerting there is. Vercel bandwidth has no public API on Hobby, so it links to the dashboard.

## Project map

```
src/app/                 routes: / · /[code] · /[code]/share · /[code]/card (+ opengraph-image) · /[code]/i/[invite] · /[code]/manage/[manage] · /g/[code] (+ calendar.ics) · /v/[slug] (+ /poster, /ranking, calendar.ics) · /phuket · /singapore · /clubs (+ /claim) · /v/[slug]/manage/[token] · /api/v1/clubs (+ /[slug]) · /u/[slug] (+ passport.json) · /api/me/export · /.well-known/kicksmash-passport.json · /api/telegram/{webhook,setup,login} · /api/discord/{interactions,setup} · /admin/listen · /answers (+ /[slug]) · /embed/{board,match}/… · /api/oembed · /me · /p/[token] · /about · /americano · /developers · /agents · /mcp · /api/v1/* · /api/openapi.json · /llms.txt · /.well-known/mcp.json · /unsubscribe · /admin · /api/cron/{hourly,push} · /api/client-error · robots.txt · sitemap.xml
src/app/[code]/opengraph-image.tsx   link preview (Inter w/ Cyrillic, organizer's language)
src/actions/             server actions (identity incl. restore codes, events, slots, scores)
src/lib/domain/          pure business logic, driver-agnostic (events, slots, scores, reminders, queries)
src/lib/notify.ts        every outbound email; safe no-op without RESEND_API_KEY
src/lib/calendar.ts      Google Calendar URL + RFC 5545 .ics builder (also served at /{code}/calendar.ics)
src/lib/domain/identity.ts personal tokens, email one-time codes, identity merge
src/lib/domain/{ratelimit,optouts,anonymize}.ts   abuse ceilings, unsubscribe list, account deletion
src/lib/domain/{levels,requests,rating}.ts   level maths (ranges, presets, balanced teams, deltas), join requests, result-based adjustment
src/lib/domain/groups.ts   groups, membership, weekly slots (recurrenceDue / autoCreateGroupMatches)
src/lib/domain/venueBoard.ts   venue slugs, the public board query, listing toggle
src/lib/api/               public REST (operations, serialize, keys, webhooks, openapi), MCP server (mcp.ts), model-facing docs (docs.ts)
skills/kicksmash/SKILL.md  installable skill for coding agents; AGENTS.md at the root for agents working on this repo
src/lib/domain/{levels,rating,requests}.ts       level scale, presets, fit, balanced teams, Elo-style deltas; join requests
src/lib/alerts.ts        error counters for the admin health row
src/db/                  Drizzle schema, driver factory (postgres-js | PGlite), seed
drizzle/                 generated SQL migrations
messages/{en,ru,es}.json all UI, share and email copy (identical key sets, typed in global.d.ts)
tests/                   vitest against PGlite (or TEST_DATABASE_URL)
e2e/                     Playwright journeys + runner (pnpm e2e)
.github/workflows/ci.yml typecheck · lint · vitest (PGlite + Postgres) · build · e2e
```

Schema changes: edit `src/db/schema.ts` → `pnpm db:generate` → commit `drizzle/` → `pnpm db:migrate`.
