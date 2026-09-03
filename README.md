# Kicksmash — padel match-up in one link

Mobile-first web app for organizing padel matches with **zero app installs, zero accounts, zero passwords**. Create a match, share `kicksma.sh/{code}` on WhatsApp or Telegram, friends tap → enter a name once → they're in.

- **Stack:** Next.js 15 (App Router, TypeScript) · Supabase Postgres + Drizzle · Resend · next-intl (EN/RU) · Tailwind v4 · Vercel (Cron + OG images).
- **Identity:** one-time name entry → player UUID in a signed httpOnly cookie (1 year) + localStorage mirror. Cross-device: every player has a private **personal link** (`/p/{token}`, shown on My matches, in every email and in the calendar invite) that signs any device in; an email that was used before can **restore** history with a 6-digit code, merging all identities that share it. The home-screen shortcut opens the personal link.
- **Links:** `/{code}` (4 chars, public) · `/{code}/i/{6}` (personal invite) · `/{code}/manage/{10}` (organizer secret).
- **Email is optional everywhere.** Without `RESEND_API_KEY` the app runs fully with email features hidden.

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
pnpm test        # vitest: slot-claim concurrency, invite transitions, score-lock rules, reminder eligibility
pnpm typecheck
pnpm lint
pnpm build
```

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
| `CRON_SECRET` | recommended | Protects `/api/cron/hourly`. Vercel sends it automatically when set. |
| `DIRECT_DATABASE_URL` | no | Direct (5432) URL for `pnpm db:migrate`. Not needed: the app migrates itself on first connection (`AUTO_MIGRATE=false` disables). |
| `RESEND_API_KEY` | no | Enables all email (calendar invites, notifications, reminders). |
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

Emails sent: calendar invite (.ics, `METHOD:REQUEST`, stable UID) on join/confirm/promotion · updated/cancelled .ics · organizer notices (joined / left / confirmed / declined / promoted) · 24h invitee reminders · one post-match score reminder. All EN + RU by recipient language.

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

The job does: `open/full → past` transitions · waitlist hygiene · 24h invite reminders (email only, stops on response or start) · the single organizer score reminder (2h after start).

Verify: **Project → Settings → Cron Jobs** shows the job, or trigger by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://kicksma.sh/api/cron/hourly
# → {"ok":true,"transitionedToPast":0,"promotions":0,"inviteReminders":0,"scoreReminders":0,...}
```

Hobby plan crons run once a day at best-effort times; Pro runs them on the minute.

---

## Product rules baked in

- **Match = exactly 4 players.** Tournament = creator-set capacity (4–64) running as an **americano**: the organizer generates rounds on the day (rotating partners, fair sit-outs, 1–N courts), any participant enters per-court points, standings update live, the organizer finalizes to lock.
- **Fast create:** quick-pick time chips, venue optional ("Court TBD") with an optional court field (court appears in the page, share text, email and calendar titles), the landing page *is* the form, "Play again next week" appears once a result is in and clones the match in one tap, and an Add-to-Home-Screen prompt gives organizers an app-like shortcut to their personal link.
- **When full:** per event, waitlist with auto-promotion on dropout (leave / removal / declined invite) or hard close.
- **Join** is first-come-first-serve and atomic: the event row is locked per mutation and one `UPDATE … WHERE id = (SELECT … LIMIT 1)` claims exactly one slot, so two taps on the last spot resolve cleanly (tested with 12 parallel joins).
- **Reserved slots** get a personal invite link. The organizer reserves by tapping an open spot in the roster (anyone else tapping it joins). The app never messages anyone; organizers get one-tap WhatsApp / Telegram forward buttons with pre-filled localized text. Declined slots become open spots.
- **Rolodex:** everyone who ever joined or was invited to your events, with their email/phone reused automatically.
- **Venue memory:** last-used venue pre-filled, all previous venues in the combobox, free text adds a new one.
- **Timezone:** default from Vercel's `x-vercel-ip-timezone` (browser zone as fallback), editable, stored UTC.
- **Score:** any participant after start; players can correct each other; once the organizer enters/edits it locks ("Confirmed by organizer"). 1–3 sets, optional team assignment → win/loss in **My matches**.
- **Organizer access** = creator cookie **or** the 10-char manage link (sets a per-event httpOnly cookie).

## Project map

```
src/app/                 routes: / · /new · /[code] · /[code]/share · /[code]/i/[invite] · /[code]/manage/[manage] · /me · /api/cron/hourly
src/app/[code]/opengraph-image.tsx   link preview (Inter w/ Cyrillic, organizer's language)
src/actions/             server actions (identity incl. restore codes, events, slots, scores)
src/lib/domain/          pure business logic, driver-agnostic (events, slots, scores, reminders, queries)
src/lib/notify.ts        every outbound email; safe no-op without RESEND_API_KEY
src/lib/calendar.ts      Google Calendar URL + RFC 5545 .ics builder (also served at /{code}/calendar.ics)
src/lib/domain/identity.ts personal tokens, email one-time codes, identity merge
src/db/                  Drizzle schema, driver factory (postgres-js | PGlite), seed
drizzle/                 generated SQL migrations
messages/{en,ru}.json    all UI, share and email copy
tests/                   vitest against PGlite (or TEST_DATABASE_URL)
```

Schema changes: edit `src/db/schema.ts` → `pnpm db:generate` → commit `drizzle/` → `pnpm db:migrate`.
