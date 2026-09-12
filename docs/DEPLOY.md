# Deploying Kicksmash

One Next.js project and one Postgres database. The whole configuration is the environment table in
[README.md](../README.md#environment-variables), written from the code by `node scripts/gen-docs.mjs`.

Two ways through it. **Option A** needs no terminal at all. **Option B** scripts everything that can be
scripted. Either way the app creates its own tables on the first request, so there is no migration step
before the first deploy.

## Option A — browser only (≈ 20 min + DNS)

1. **Supabase** (5 min): https://supabase.com/dashboard/new → create a project, save the database password. Click **Connect** → copy the **Transaction pooler** string (port 6543). Leave `[YOUR-PASSWORD]` in it.
2. **Vercel** (5 min): https://vercel.com/new → **Import** `evhg/padel-matchup` (the code must be on the repo's default branch). Under **Environment Variables** add:
   - `DATABASE_URL` = the string from step 1, unchanged
   - `DATABASE_PASSWORD` = your database password
   Click **Deploy**. The first request creates the tables automatically.
3. **Check**: open `https://<your-project>.vercel.app/api/health` → `"database":"connected"`.
4. **Domain** (5 min + waiting): Vercel → Project → **Settings → Domains → Add** `kicksma.sh` (and `www.kicksma.sh`). Vercel shows the records. At Porkbun → **Domain Management → kicksma.sh → DNS**: delete the parking `ALIAS`/`CNAME` records, then add the `A` record (Host empty) and the `www` `CNAME` with the values Vercel shows. Wait until Vercel says **Valid Configuration**.
5. Later, optionally: `SESSION_SECRET`, `CRON_SECRET`, `RESEND_API_KEY` + `EMAIL_FROM` in **Settings → Environment Variables**, then **Deployments → ⋯ → Redeploy**.

Cron runs daily at 07:00 UTC out of the box, which is what Vercel's Hobby plan allows. On Pro, change the schedule in `vercel.json` to `0 * * * *` for hourly reminders.

## Option B — CLI

### 1. Supabase (≈ 10 min)

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

No Supabase Auth and no storage is used, only Postgres, and the app connects as its own role `kicksmash`. Row Level Security **is** on, on every table, with one policy for that role, because Supabase serves the `public` schema through its Data API and nothing should be readable with the project's publishable key (AGENTS.md rule 10).

### 2. Resend (≈ 15 min incl. DNS)

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

### 3. Deploy to Vercel via CLI (≈ 10 min)

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

### 4. Custom domain `kicksma.sh` at Porkbun (≈ 10 min + DNS propagation)

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

### 5. Cron (already configured, ≈ 2 min to verify)

`vercel.json` schedules `GET /api/cron/hourly` daily at 07:00 UTC (Hobby-plan safe; on Pro set `0 * * * *` for hourly). Vercel automatically sends `Authorization: Bearer $CRON_SECRET` when that variable is set; without it the endpoint is open but every step is idempotent.

The job does: `open/full → past` transitions · waitlist hygiene · 24h invite reminders (email only, stops on response or start) · the single organizer score reminder (2h after start) · automatic group matches for weekly slots (with member notifications) · daily metric snapshots.

Verify: **Project → Settings → Cron Jobs** shows the job, or trigger by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://kicksma.sh/api/cron/hourly
# → {"ok":true,"transitionedToPast":0,"promotions":0,"inviteReminders":0,"scoreReminders":0,...}
```

Hobby plan crons run once a day at best-effort times; Pro runs them on the minute.

---

## Your own copy, elsewhere

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fevhg%2Fpadel-matchup&project-name=kicksmash&repository-name=kicksmash&env=DATABASE_URL,DIRECT_DATABASE_URL,SESSION_SECRET,APP_BASE_URL&envDescription=Postgres%20connection%20strings%2C%20a%20random%20session%20secret%20and%20your%20public%20URL&envLink=https%3A%2F%2Fgithub.com%2Fevhg%2Fpadel-matchup%23environment-variables)

Or with Docker (a standalone Next.js build, about 200 MB):

```bash
docker build -t kicksmash .
docker run -p 3000:3000 --env-file .env kicksmash   # then: pnpm db:migrate against the same DATABASE_URL
```

Everything optional stays optional: without a Resend key no email goes out, without a bot token there is
no Telegram or Discord, without an Anthropic key the listening desk only collects. Keep the `/agents`
charter and the CC BY 4.0 notice if you keep the public API.
