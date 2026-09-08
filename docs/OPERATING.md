# Operating Kicksmash without staff

What the daily session does each morning besides feedback and errors, and the few things
an outside job must post because the app cannot know them. Everything here uses the
operator endpoints with the deployment credential; no secret travels.

## Every morning

1. `GET /api/admin/services`: the service board. Any row with `state: "alert"` is work now,
   in this order: `pg_cron` (jobs not running), `uptime` (site down), `backup` (nightly export
   missing), `anthropic` (near the cap), `resend_*`, `vercel_analytics`, `supabase_db`. A row
   at `warn` is a line in the summary, not a task.
2. The owner is told once per service per month by the hourly job when a row crosses 85% or
   turns red; the session does not repeat the message. It fixes what it can and says so in
   the pull request.
3. `GET /api/admin/errors` and `GET /api/admin/feedback` as before (see `docs/DECIDING.md`).

## Once a week (Monday)

- Read the domain's expiry from Porkbun with the keys in the environment
  (`POST https://api.porkbun.com/api/json/v3/domain/listAll` with `apikey` and `secretapikey`),
  take `expireDate` for `kicksma.sh`, and post it as epoch seconds:
  `POST /api/admin/metrics { "key": "domain_expires_at", "value": <seconds> }`.
  The board turns yellow at 60 days and red at 30; auto-renew is on at Porkbun, the card is the owner's.
- After a change to the bot's commands, `GET /api/telegram/setup` with the operator credential
  re-registers the menu and the webhook.

## When a service needs a key the app does not have

- `ANTHROPIC_ADMIN_KEY` (an Admin API key from the console) turns the Anthropic row from
  "estimated" into "billed". `ANTHROPIC_MONTHLY_CAP_USD` mirrors the cap set in the console
  (default 20). Both live in Vercel's environment, never in the repository.
- Anything else the owner pastes in chat goes to Vercel's environment through the API, then
  the session redeploys by merging or, when nothing changed in code, leaves it for the next deploy.

## Ceilings we live under (free plans)

Vercel Hobby: 100 GB bandwidth, 1M invocations, one cron a day (pg_cron runs the rest).
Vercel Web Analytics: 2,500 events a month (we count page renders ourselves).
Supabase: 500 MB database, 5 GB egress a month. Resend: 3,000 emails a month, 100 a day.
Anthropic: the owner's cap. Tavily: 1,000 credits a month. Telegram: 30 messages a second,
20 a minute per group. Discord: 50 requests a second. GitHub Actions: free on a public repository.
