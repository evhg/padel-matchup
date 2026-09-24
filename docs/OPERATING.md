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
change, or `declined` with the rule, kindly; a question that needed only an answer is `declined` with
the verdict `answered`, which the Sunday digest does not count as a refusal). A shipped note also takes
`publicSummary`: one line for `/built`, the public page of ideas that became the app, in our words and
never the note's own, because a note can be crude, a joke or malicious. Beside it `/built` shows the
first name of the player who asked (the owner's decision, 23 September 2026), taken from their name
on Kicksmash when the note ships; `publicName: ""` hides it for a test user or a name unfit for a
public page, and `publicName: "Erik"` sets it. The same call with only `{ id, publicSummary }` or
`{ id, publicName }` changes the line of a note shipped before. Nothing is built from a
note without the owner's word.

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

Vercel Hobby: 100 GB bandwidth, 1M invocations, one cron a day (pg_cron runs the rest), and
**10 GB of function storage** — the one that is not per month. Every deployment keeps its own copy
of every function it built, so the meter is (what one deployment weighs) x (how many are kept), and
it only ever goes up until deployments are deleted. It reached 75% on 14 September 2026 with a few
dozen deployments, because each one carried 18 MB of PGlite it could never run. Two levers, in this
order: what a function weighs (`outputFileTracingExcludes`/`Includes` in `next.config.ts` -- check
the numbers, not the config: `.next/server/**/*.nft.json` lists what each route really traces), and
how many deployments exist. 356 were built in the first eleven days, 234 of them previews of an
agent's branch that nobody opened, so `vercel.json` now sets `git.deploymentEnabled` to false for
`claude/**`. `main` still deploys to production on merge, and the three required checks are GitHub
Actions and never depended on Vercel. Deployments already built stay until they are deleted:
`DELETE /v13/deployments/{id}` with `VERCEL_TOKEN`, keeping the live production one and a couple of
rollback targets.
Vercel Web Analytics: 2,500 events a month (we count page renders ourselves). Past it, Vercel's
dashboard stops recording until the month turns and nothing else changes: the app keeps its own
count. It stood at 2,022 on 24 September; at a hundred players it will run out each month, and
then the choice is between leaving it, turning it off, or a paid plan.
Supabase: 500 MB database, 5 GB egress a month. Resend: 3,000 emails a month, 100 a day.
Anthropic: the owner's cap. Tavily: 1,000 credits a month. Telegram: 30 messages a second,
20 a minute per group. Discord: 50 requests a second. WhatsApp: 250 unique numbers a day at the
unverified tier — and the definition is the whole of it, because Meta counts only numbers messaged
*outside* an open 24-hour window. A player who writes to us first costs nothing, and neither does
anything we reply for the next day; only templates to people who have gone quiet are rationed.
GitHub Actions: free on a public repository.

## The research desk (Tavily)

The free plan gives a thousand search credits a month. The hourly job spends them evenly: each run may spend up to twelve credits, only as far as the even pace allows, never the last five. Thirty listening queries in English, Russian and Spanish look for fresh threads (one credit each, daily, later when they yield nothing); thirty-three find queries map clubs, coaches, tournaments and communities in ten cities (every ten days); new clubs and coaches get their public contacts read once (ten pages for two credits). Hand searches for answer pages go through `POST /api/admin/research {"q": ...}` and are cached a week; `GET /api/admin/research` shows the meter, the pace, every query's yield and the finds. The board row "Tavily" reads Tavily's own meter. If credits run out early, lower `everyHours` in `src/lib/research/queries.ts`; if they are left over, raise `PLAN.reserve` down.

## Cron jobs

Three jobs run from Supabase `pg_cron` through `pg_net`, and the service board's `pg_cron` row says when each last ran:

- the hourly job → `/api/cron/hourly`. Vercel's own cron also calls it once a day at 07:00 UTC (`vercel.json`), which is all the Hobby plan allows. It has 60 seconds for everything. The score nudges take a 20-second share of that: in Telegram each nudge is the result card as a picture, rendered once per match (3 to 6 seconds cold, measured on 24 September 2026), so about four matches ending in the same hour fit in one run. A match past the share is not marked and goes the next hour; the run's `scoreRemindersDeferred` counts them. When that number is often above zero, the nudges need their own route.
- the push job, every 5 minutes → `/api/cron/push`: match reminders, waitlist offers, lapses and lesson reminders.
- `kicksmash-sync`, every 10 minutes → `/api/cron/sync`: the coaches' calendars, both ways.

**The three definitions live in the repository** since migration 0069 (`src/lib/ops/cronJobs.ts`,
held to the migration by `tests/cron-jobs.test.ts`). Before that they existed only in the database's
`cron.job`, typed by hand with the secret in each job's text. No job's text holds it now: each reads
`kicksmash_cron_secret` from Supabase Vault when it runs.

- `GET /api/admin/cron` lists the jobs and how each one's last run went. The read-only door can see
  them too (`cron.job` without its `command`, and `cron.job_run_details`).
- `POST /api/admin/cron` stores the app's own `CRON_SECRET` in Vault and schedules the three jobs,
  replacing any job typed by hand that calls the same routes. Call it once on a new database, and
  again the day `CRON_SECRET` changes on Vercel, or every job gets `unauthorized` from then on.

## The Sunday digest, one line to watch

`Funnel: visitors → matches → seats → scores → card views` is the week in five numbers: page renders (bots excluded), matches created, joins, matches with a result, result-card renders. A step that does not move for four weeks gets a design change, not a marketing push. The score nudge (every player, once, on their channel) and "same time next week?" exist to move the last three.

## Handover for a fresh session

Everything a session needs to continue the work is in the repository and in the plan; a fresh
session reads this file, `AGENTS.md`, `docs/DECIDING.md` and the plan, and knows what the owner
and the previous session knew.

**The plan** is `ROADMAP.md`: what is built, what is next, and the small open items, with
`docs/VISION.md` for who it is for. The artifact "Kicksmash Open Court Plan"
(https://claude.ai/code/artifact/00649e1d-fa25-4831-9411-e31c98d1b7d2) holds the decisions up to
13 September 2026 and has not been revised since; read it for history, not for the state.

**Standing rules from the owner** (in force since 8 to 13 September): optimise for wall clock time first and for credits second, and let every change improve scalability or leave it where it was (13 September; the working version is in `.claude/skills/ship/SKILL.md` and AGENTS.md rule 12). The owner is non-technical
and only creates accounts, taps approvals and pays; times to the owner in Thailand time; never
post anywhere public, never email anyone except the thank-you a shipped note earns (CLAUDE.md
order 5) or a message the owner asked for, never spend money, never commit a secret; anything
outward-facing (press, founding-club emails, Reddit, Hacker News) waits for the owner's tap in
Telegram; free tiers until fifty emails a day; Porkbun keys stay out of Vercel; personal tokens
and manage links never in public data; never interpolate a `Date` into a raw `sql` template;
`pnpm db:push` is disabled (it would drop the RLS policies), migrations go through
`pnpm db:generate` and reach production through the Migrate workflow when they merge; no model identifiers in commits, pull requests or
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
Telegram), `/api/admin/metrics`, `/api/admin/sql` (the read-only query door, below),
`/api/admin/merge-players` (below), `/api/admin/cron` (the scheduled jobs, above).

## What the session's environment must hold

A Claude session in the cloud runs in a fresh container with no socket to the database and no
credentials of its own. On 23 September 2026 the environment was emptied on my advice — the advice
was about moving the *migration* secret to GitHub, and it was read as "clear the lot". It cost that
day's work: the Resend log could not be read, `claude@kicksma.sh` could not send, and every
production question fell back to a tool that asks the owner to approve it one query at a time.

So this list is the contract. Each name is read straight from the environment by the scripts above;
none of them is ever written to a file or typed into a command, and the harness refuses a shell
command that carries a credential in its text, which is why the variable has to exist rather than be
fetched and pasted.

| Variable | What stops without it |
| --- | --- |
| `CRON_SECRET` | every `/api/admin/*` endpoint: the feedback desk, errors, services, metrics, and the read-only query door |
| `RESEND_API_KEY` | reading whether a message was delivered or bounced; sending as `claude@kicksma.sh` |
| `VERCEL_TOKEN` | the deploy state at the end of `prodcheck.sh` |
| `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY` | the Monday domain-expiry check above |
| `KICKSMASH_BASE` | optional; defaults to `https://kicksma.sh` |

GitHub cannot stand in for this. A repository secret can be *used* by a workflow and never *read*
back through the API — that is the whole point of it — so `DIRECT_DATABASE_URL` reaching the Migrate
workflow does nothing for a session that needs to ask a question now.

**The read-only query door.** `GET /api/admin/sql?q=<one select>` with the operator bearer answers
rows as JSON, capped at 500.

It was refused once, in the shape "`postgres` runs your select inside a read-only transaction", and
the refusal was right: `players.personal_token` signs a person in on any device, so "read
everything" is also "become anyone". It reads through `kicksmash_reader` now — a `nologin` role with
`select` granted **per column** and never on a token, a manage code, an invite code, a hashed
one-time code or a push subscription's keys (migration 0067, generated from the schema by
`src/lib/db/readonly.ts`). A query that names a hidden column is refused by Postgres itself, and so
is `select *` on a table that has one; the error names the column. Tables with nothing hidden keep
`select *`. The role also bypasses Row Level Security (migration 0068): every table has it on and no
policy names the reader, so without that every answer was zero rows, with no error. Rows are not the
secret; the columns are.

Four locks, and only the last one matters: the operator token; `checkReadQuery` (one statement, must
start with `select` or `with`); a `read only` transaction with an eight-second timeout; and
`set local role`. Filtering the *answer* was considered and is unsound —
`select to_jsonb(p) from players p` carries the same value under another key, so the stop has to be
in the database.

`tests/readonly.test.ts` regenerates the grants from the live schema and fails when they differ from
the migration, and fails again when a new column looks like a credential and is on neither the
hidden list nor the reviewed-safe list. A new token cannot reach production ungranted or unnoticed.

**A backup on a laptop.** Download one night's file (`backups/<day>.json.gz`) from the private
backup repository, then `pnpm exec tsx scripts/restore-backup.ts <day>.json.gz` and
`PGLITE_DATA_DIR=.pglite-backup pnpm dev`. Every credential in it is replaced and the push
subscriptions are dropped, always; addresses, phone numbers and messenger ids are masked unless
`--keep-contacts`. The file and the folder are personal data, kept out of git by `.gitignore`. A
table that reached the backup's row cap is named in the file and turns the board's backup row yellow.

**Bounces and complaints.** Resend's webhook (`/api/inbound/resend`, the same one that carries
mail to `claude@`) also sends `email.bounced` and `email.complained`. A hard bounce or a complaint
marks the address at once, three soft bounces mark it, and a marked address gets no more mail
(`sendEmail`), counts as unreachable (a match tells its player on Telegram or by push), shows on the
player's My matches and beside the name on the organiser's roster. A code the player asks for still
goes, and typing it back clears the mark; typing the address in again lifts a complaint or soft
bounces, not a hard one. The board's `email_marks` row turns yellow at 2% bounces or 0.1% complaints
of the month's mail, red at 4% or 0.3%. The webhook's event list is set in Resend (`GET/PATCH
https://api.resend.com/webhooks`); if it ever loses the two events, nothing is marked.

**Merging duplicate people.** `POST /api/admin/merge-players { into, from[], dryRun }` folds rows
through the same `mergePlayers` the app uses, behind `safeToMerge` (`src/lib/domain/dupes.ts`), which
refuses any pair two different people could be. Always `dryRun` first. A merge cannot be undone.
It moves every row that points at either person, read from the schema's foreign keys
(`playerReferences` in `src/lib/domain/merge.ts`), and refuses when both rows own a coach page. Before
23 September 2026 it moved only six tables and the delete took or blanked the rest; the four merges
of that morning ran on the old code.

**Checks and scripts** in `scripts/ops/`: `prodcheck.sh` (health, errors, services, open notes,
research desk, main CI, deploy), `wait_ci.sh <branch> <sha>`, `deploy-poll.sh <sha> <log>`. They
read `CRON_SECRET` (or `OPERATOR_TOKEN`) and `VERCEL_TOKEN` from the environment.

**State of play** is `ROADMAP.md`, not this file. A state of play written here on 12 September was
out of date within a day. Its open items for the owner on that day (the two pilot coaches, the
ten-minute coach setup test, the Phuket field test) have no later record. The texts for the assistant
directories are in `docs/launch/directories.md`.

## Security at a hundred real players

Decided 23 September 2026: no rotation and no hardening before a hundred real players. What is held
until then, by tests, so that day starts from a known place (`tests/security.test.ts`): every
handler under `/api/admin` asks for the operator's token on its first line, and the role the app
was built to run as, `kicksmash`, holds the grant and the policy on every table. Until migration
0075, 50 of those grants existed only in production, typed in by hand: a database rebuilt from
GitHub gave the role a policy on each table and no right to use it.

**What production holds that the repository does not** (checked 24 September 2026 through the
read-only door):

- **Default privileges.** A table that `postgres` creates in `public` is granted to `postgres`,
  `service_role` and `kicksmash` (everything) and to `kicksmash_agent` (select, insert, update),
  never to `anon` or `authenticated`. That was set by hand; no migration says so. `anon` and
  `authenticated` hold no privilege on any of the 59 tables, and every table has Row Level Security
  with the one policy for `kicksmash`.
- **`kicksmash_agent`.** A role that can log in, bypasses Row Level Security, and can read and write
  every table, sign-in tokens included. It was made on 16 September on Claude's advice, for a
  direct connection from a session that the container can never open; nothing has connected as it
  since. The owner keeps it (24 September 2026).
- **The Supabase MCP.** `.claude/settings.json` allows `execute_sql` and `apply_migration`, and the
  owner keeps those lines (24 September). They do not decide anything here: in this cloud the
  connector's tool permissions on claude.ai do, and they are set to ask. Keep them asking. Reads go
  through `/api/admin/sql`, and changes through a migration and the Migrate workflow.

**Supabase's Data API change of 30 October 2026** (new tables in `public` no longer granted to the
Data API by default) changes nothing for Kicksmash: the app never uses the Data API (no
supabase-js, no REST or GraphQL calls), every migration that adds a table grants it to `kicksmash`
(AGENTS.md rule 10), and `anon` and `authenticated` already reach no table. Do not add the
`anon`/`authenticated` grants that the announcement suggests: they would open tables that are
closed today.

The steps for that day, in this order. Each one that names a dashboard needs the owner's hands.

1. **The app's own database user.** Production's `DATABASE_URL` connects as `postgres`, which
   bypasses Row Level Security, so today the policies keep Supabase's Data API out and do not limit
   the app. To run as `kicksmash` instead:
   - give it a password (`alter role kicksmash login password '…'` in Supabase's SQL editor, the
     value from a password manager, never in a file or a chat),
   - `grant kicksmash_reader to kicksmash`, or the read-only door cannot `set role`,
   - set `AUTO_MIGRATE=false` on Vercel, because `kicksmash` cannot create tables and the Migrate
     workflow applies migrations anyway,
   - point `DATABASE_URL` on Vercel at the pooler with the user `kicksmash.<project ref>`, redeploy,
     and check `/api/health` and one query through `/api/admin/sql`.
   `/api/admin/cron` stores a secret in Vault and schedules jobs, which `kicksmash` may not do. Run
   it once as it is before the switch; after the switch it answers with the database's refusal.
2. **`CRON_SECRET`.** Make a new one (`openssl rand -base64 32`), set it on Vercel and in this
   environment's variables, redeploy, then `POST /api/admin/cron` so the scheduled jobs send the new
   one. Until that call, every job gets `unauthorized`, and the board's `pg_cron` row turns red.
3. **`RESEND_API_KEY`.** A new key in Resend (sending and reading), set on Vercel and here, then
   delete the old one in Resend.
4. **`VERCEL_TOKEN`.** A new token in Vercel's account settings, set here, then delete the old one.
5. **Who may call `/api/admin/*`.** The operator token, or a Vercel token that can read the project
   (`src/lib/api/secret.ts`). After step 4, decide whether the second door is still wanted.
