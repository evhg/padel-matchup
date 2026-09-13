# Operating Kicksmash without staff

What the daily session does each morning besides feedback and errors, and the few things
an outside job must post because the app cannot know them. Everything here uses the
operator endpoints with the deployment credential; no secret travels.

## When a note arrives

The note is the trigger. The person gets the instant thank-you; the owner gets one Telegram
message per real note with the verdict the rules give, what would change, the size, a timeline
estimate (made without reading the code, and saying so), what it needs and a recommendation
(`src/lib/feedback/propose.ts`, kept in the note's `assessment` under a `proposed <date>:` prefix).
The owner answers in a Claude session: "build <id8>" or "skip <id8>". The session then reads the
note (`GET /api/admin/feedback?status=acknowledged`), builds it through the pipeline below, and
records the outcome with `POST /api/admin/feedback` (`shipped` with a thank-you that names the
change, or `declined` with the rule, kindly). Nothing is built from a note without the owner's word.

## When an error appears

A production error the store has never seen is one line to the owner at once (`recordAndAlert` in
`src/lib/alerts.ts`); repeats, client errors and storms stay quiet. The owner says "fix errors" in a
session; the session reads `GET /api/admin/errors`, fixes through the pipeline, and records
`POST /api/admin/errors { fingerprint, note }`. Outages reach the owner from the uptime probe
directly. There is no daily loop and no three-hourly wake-up since 11 September.

## The service board

1. `GET /api/admin/services`: any row with `state: "alert"` is work now, in this order: `pg_cron`
   (jobs not running), `uptime` (site down), `backup` (nightly export missing), `anthropic` (near
   the cap), `resend_*`, `vercel_analytics`, `supabase_db`. A row at `warn` is a line in a report.
2. The owner is told once per service per month by the hourly job when a row crosses 85% or
   turns red; a session does not repeat the message. It fixes what it can and says so in the
   pull request.

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

## The research desk (Tavily)

The free plan gives a thousand search credits a month. The hourly job spends them evenly: each run may spend up to twelve credits, only as far as the even pace allows, never the last five. Thirty listening queries in English, Russian and Spanish look for fresh threads (one credit each, daily, later when they yield nothing); thirty-three find queries map clubs, coaches, tournaments and communities in ten cities (every ten days); new clubs and coaches get their public contacts read once (ten pages for two credits). Hand searches for answer pages go through `POST /api/admin/research {"q": ...}` and are cached a week; `GET /api/admin/research` shows the meter, the pace, every query's yield and the finds. The board row "Tavily" reads Tavily's own meter. If credits run out early, lower `everyHours` in `src/lib/research/queries.ts`; if they are left over, raise `PLAN.reserve` down.

## Cron jobs

- `kicksmash-sync` (Supabase pg_cron, every 10 min) → `/api/cron/sync`: the coaches' calendars, both ways. Waitlist offers, lapses and lesson reminders ride the 5-minute push job.

## The Sunday digest, one line to watch

`Funnel: visitors → matches → seats → scores → card views` is the week in five numbers: page renders (bots excluded), matches created, joins, matches with a result, result-card renders. A step that does not move for four weeks gets a design change, not a marketing push. The score nudge (every player, once, on their channel) and "same time next week?" exist to move the last three.

## Handover for a fresh session

Everything a session needs to continue the work is in the repository and in the plan; a fresh
session reads this file, `AGENTS.md`, `docs/DECIDING.md` and the plan, and knows what the owner
and the previous session knew.

**The plan** is the artifact "Kicksmash Open Court Plan" at
https://claude.ai/code/artifact/00649e1d-fa25-4831-9411-e31c98d1b7d2, and `docs/VISION.md` is the
same decisions in the repository. The artifact is the record of every decision. Publish a new revision
once per batch, never per pull request, and always call the Artifact tool's `read` action on that URL
before publishing, both to learn the current revision number and because a publish that was not built
on the live version is refused.

**Standing rules from the owner** (in force since 8 to 13 September): optimise for wall clock time first and for credits second, and let every change improve scalability or leave it where it was (13 September; the working version is in `.claude/skills/ship/SKILL.md` and AGENTS.md rule 12). The owner is non-technical
and only creates accounts, taps approvals and pays; times to the owner in Thailand time; never
post anywhere public, never email anyone, never spend money, never commit a secret; anything
outward-facing (press, founding-club emails, Reddit, Hacker News) waits for the owner's tap in
Telegram; free tiers until fifty emails a day; Porkbun keys stay out of Vercel; personal tokens
and manage links never in public data; never interpolate a `Date` into a raw `sql` template;
`pnpm db:push` is disabled (it would drop the RLS policies), migrations go through
`pnpm db:generate` and are applied to the Supabase project with `SET LOCAL lock_timeout = '5s'`
plus a row in `drizzle.__drizzle_migrations`; no model identifiers in commits, pull requests or
code; commits end with the `Co-Authored-By` and `Claude-Session` trailers; three languages with
identical message keys; a unit test with every change; a browser suite where pages or bots change.

**The pipeline** (owner's word, 10 September, with the gate added on 12 September): one pull request
per feature or area with its adversarial review run while CI runs and fixed on the same branch before
merging. Before any push, `bash scripts/gate.sh` (typecheck, lint, schema versus migrations, the unit
suite), which a Claude Code hook in `.claude/settings.json` runs by itself and which blocks the push
when it fails; `GATE_E2E=<suite> bash scripts/gate.sh` adds a production build and the one browser
suite that covers the change. CI runs everything, including the unit suite a second time on a real
Postgres. Squash-merge, then reset the working branch (the one the owner names for the session) onto
main; a health check after each deploy and the full production check once per batch; a side branch
`<working-branch>-<topic>` for disjoint parallel work; never stop with work in the queue, book a return
when waiting; end every batch with three lines: what shipped, what is next, what needs the owner.

**Operator endpoints** (bearer `CRON_SECRET`, also accepted: the Vercel token):
`/api/admin/errors`, `/api/admin/services`, `/api/admin/feedback`, `/api/admin/research`,
`/api/admin/answers` (answer pages, IndexNow on publish), `/api/admin/outreach` (the press desk:
drafts wait for the owner's tap; nothing here sends), `/api/admin/notify` (one line to the owner's
Telegram), `/api/admin/metrics`.

**Checks and scripts** in `scripts/ops/`: `prodcheck.sh` (health, errors, services, open notes,
research desk, main CI, deploy), `wait_ci.sh <branch> <sha>`, `deploy-poll.sh <sha> <log>`. They
read `CRON_SECRET` (or `OPERATOR_TOKEN`) and `VERCEL_TOKEN` from the environment.

**State of play on 12 September:** the product through round eleven is live and reviewed
(pull requests #1 to #99). The restructure the owner approved on 12 September is four phases in: tests
that cannot rot with the calendar and rules a machine checks (#95, #96), one append-only fact log (#97),
one card algorithm with Telegram and Discord as adapters plus the Telegram module split into a router
and its handlers (#98), and the schema split by domain behind a check that it still agrees with the
migrations (#99). What remains is the documents and the shipping pipeline. Besides that: the launch calendar runs (press emails on 15 September with the owner's
tap, Show HN in week three, builders' articles live as answer pages, founding-club drafts queued
for 6 October, directory texts in `docs/launch/directories.md`); the Russian answer series adds
three pages a week; the research desk spends Tavily's credits evenly. Open items that need the
owner: introduce the two pilot coaches, the ten-minute coach setup test, the Phuket field test,
the taps above.
