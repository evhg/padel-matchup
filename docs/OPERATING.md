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
- A refused `ANTHROPIC_API_KEY` (a 401 or a 403) turns the Anthropic row red. Set a new key in
  Vercel's environment and redeploy. The first call the new key gets accepted puts back to `new`
  the listening items that the refused key failed and that are still inside the 7-day window
  (`restoreRefusedItems` in `src/lib/ops/anthropic.ts`). The hourly step then drafts them, three a
  run. No hand correction in the database is needed.
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
**100 deployments a day, for the whole Vercel team, not for one project.** On 25 September 2026 the
merge of the clubs change was refused ("Deployment rate limited — retry in 24 hours", the Vercel
status on the commit), and production kept the code from the merge before it. Another project on
the same team, `cathnivore`, had built 98 previews of its `build` and `ci-status` branches in the
day. Vercel does not retry a refused deployment: the next push to `main` after a slot comes free
deploys everything merged since. The Migrate workflow is GitHub Actions, so a migration still lands
on merge while the code waits: one more reason every migration stays additive. The first sign is
the commit status, not the site: read it (`GET /repos/…/commits/<sha>/status`) when a deploy poll
finds no deployment.
Vercel Web Analytics: 50,000 events a month on Hobby, and every project on the Vercel account
shares them. Past the allowance there is a three-day grace period, then Vercel stops recording until
the next billing cycle. Hobby is never billed for it, and nothing else changes. Source: Vercel's own
page, `vercel.com/docs/analytics/limits-and-pricing` (updated 25 August 2026, read on 24 September
2026). Until that day the board assumed 2,500. The board's number is our own estimate: page renders
counted on the server, crawlers left out, while Vercel counts page views in the browser. It stood at
2,022 on 24 September, which is 4% of the allowance.
Vercel Hobby functions also count time: 4 hours of active CPU and 360 GB-hours of provisioned memory a
month (Vercel's Hobby figures as read on 10 October 2026; the usage page has the live numbers). A
function that waits on the network counts against the memory, not the CPU, for every second it waits.
Supabase: 500 MB database, 5 GB egress a month. Resend: 3,000 emails a month, 100 a day (book@ may
spend thirty of them a day, so up to 900 a month: "book@kicksma.sh", below).
Anthropic: the owner's cap (booking screenshots may use twenty calls a day of it: "A booking
screenshot", below). Tavily: 1,000 credits a month. Telegram: 30 messages a second,
20 a minute per group. A crew's own Telegram group (DECIDING rule 31) sends every message to the
webhook, because an admin bot receives them all: one invocation each, dropped before any database
read unless it is a command, a reply, a link or a word the bot acts on. A busy group of 200 messages
a day is 6,000 invocations a month, so 160 such groups would spend the whole 1M. `tg_groups_managed`
is the hourly count of the groups the bot reads now; `tg_groups_started` counts starts a day. A group
where the bot is an admin without the opt-in, or after /quiet, sends every message too, and nothing
counts it: no column records the bot's admin rights. Discord: 50 requests a second. WhatsApp: 250 unique numbers a day at the
unverified tier — and the definition is the whole of it, because Meta counts only numbers messaged
*outside* an open 24-hour window, so only templates to people who have gone quiet spend that limit.
Counted is not the same as free. A message a player sends us costs nothing. Every message we send
back inside the window does cost money from 1 October 2026: "Effective October 1, 2026, Meta will
charge on a per-message basis for service messages", at the rate of a utility message in the
player's country, with no volume tiers (Meta's page for non-template messages,
`developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages`,
read on 10 October 2026). One reseller, 360dialog, reports the first 1,000 service messages a month
per number free and no delivery for an account with no payment method on file; Meta's own page says
neither, so neither is a figure to plan on. A WhatsApp join costs us one reply (the seat with the
line-up), or two when a ranged match asks the level first; each later tap costs one more. The
channel is off on this deployment (no `WHATSAPP_TOKEN`), so
today it costs nothing at all. GitHub Actions: free on a public repository.

## WhatsApp templates: what they cost

A player whose channel is WhatsApp (a number that wrote to us, no Telegram) hears about a match
through four message templates in `data/whatsapp-templates.json`: a change, a free spot, the score
ask and the result card. Outside the 24-hour window a person opens by writing to us, WhatsApp
delivers nothing else.

- **What Meta charges.** Since 1 July 2025 Meta charges per delivered template, by category and by
  the recipient's country (Thailand is in "Rest of Asia Pacific"). A marketing template is charged in
  every window. A utility template inside an open window was free until 30 September 2026; from 1
  October 2026 it is charged there too, as every reply in the window is (the WhatsApp line under
  "Ceilings we live under" above). All four of ours are utility, and the code does not track the window: every
  template costs one utility message. Read the price per message on Meta's rate card; this page does
  not copy it.
- **Meta may change the category.** Meta reads each template and can move a utility template to
  marketing when the text looks like promotion. A free spot is the likeliest one. After approval, and
  now and then, run `node scripts/whatsapp-templates.mjs --list`: the last column is the category
  Meta gave. A template that shows `MARKETING` costs money in every window; rewrite its text as a
  plain notice and create it again, or set the cap lower.
- **The daily cap is the cost guard.** `WHATSAPP_TEMPLATES_PER_DAY` (50 when unset) is the most
  templates the app sends in one UTC day; `0` switches them off. The count is `whatsapp_templates` in
  `metrics_daily` (only messages Meta took); a refusal at the cap bumps `whatsapp_templates_capped`.
  At the cap, or when Meta refuses a template, the notice goes by email, then push, as it did before
  WhatsApp. One free spot sends ten WhatsApp messages at most (`REFILL_WHATSAPP_MAX`).
- **How many per match.** For one WhatsApp player in a match: one per change that reaches them (the
  line-up complete or open again, a new time, a cancellation), two score asks at most (the evening
  and the next morning, only while no score exists), and one result card, once ever. A free spot
  adds at most ten, to people outside the match.
- **Creating the templates.** `node scripts/whatsapp-templates.mjs --create` shows what it would send;
  `--create --yes` sends each template and language Meta does not hold yet (`WHATSAPP_WABA_ID`,
  `WHATSAPP_TOKEN`; `--base` if the address is not `https://kicksma.sh`). The result card's picture
  header needs a sample picture: `--header-handle <h>`, or `--sample <png> --app-id <id>` to upload
  one, or create that template by hand in WhatsApp Manager. A template Meta already holds is left
  alone: a change to an approved text is a new review, done in WhatsApp Manager.

## Finding the jar: the counters for a player who signs in again

The owner, 10 October 2026: "you have to basically log in each and every time you click a link from
within the whatsapp group." A link in a WhatsApp group opens the phone's default browser, and each
browser keeps its own cookies (Safari, Chrome, an app's own browser, the iPhone's home-screen icon).
Which of these makes the second record is a question for the numbers, so these day counters in
`metrics_daily` answer it. None holds a name, an address or a token. Read them through
`/api/admin/sql` in one query, for example `select key, sum(value) from metrics_daily where day >=
current_date - 28 and (key like 'newid_%' or key like 'signin_%' or key like 'join_src_%' or key =
'thats_me_refused' or key like 'held_by_name%') group by 1 order by 1`.

- **Where a player came from.** `join_src_wa` and `newid_src_wa`: a join, and a record made from a
  name, that started from a WhatsApp share link. Every WhatsApp button that carries a match link
  tags it `?s=wa` (`tagForWhatsapp` in `src/lib/share.ts`, and "Tell the group"); the match page
  keeps the tag for a day in the `ks_src` cookie. The other tags the app writes count the same way
  (`ig`, `poster`, `card`, `moment`, `series`, `gen`, `tg`, `story`, `link`, `share`: `MATCH_SOURCES` in
  `src/lib/source.ts`); any other word somebody typed after `?s=` counts as `other`, so no counter
  ever carries a word a person chose (a name, say), for `join_src_` as for `newid_src_`. The
  WhatsApp bot counts `newid_name_here` too, for a new number whose profile name is already in the
  match.
- **Which browser made the record.** `newid_ua_<class>`, one per record made from a name alone
  (`requirePlayer`), with the class from the user agent (`browserClass` in
  `src/lib/domain/browserClass.ts`): `ios_safari`, `ios_chrome`, `ios_other`, `ios_webview` (the
  iPhone's home-screen icon, or an app's own view that names no app: the two look the same),
  `android_chrome`, `android_samsung`, `android_webview`, `android_other`, `app_whatsapp`,
  `app_telegram`, `app_instagram`, `app_facebook`, `app_line`, `desktop`, `other`. An iPad says
  "Macintosh" and counts as `desktop`.
- **A name that was already there.** `newid_name_here`: the new record took a name already in the
  match it joined, held spots included. Most of these are somebody who has played before, in a
  browser that does not know them.
- **How a browser signed in.** `signin_thats_me` ("That's me", DECIDING rule 34), with
  `signin_thats_me_fold` when it folded the browser's own new record into the old one;
  `signin_restore` (the saved id brought back without proof); `signin_personal_link`;
  `signin_email_code`; `signin_telegram` (the login widget) and `signin_telegram_miniapp`. Each
  counts only when the cookie changes to another record; a link to a browser already signed in
  counts nothing. `thats_me_refused` counts a "That's me" the rule turned down. "That's me" takes
  at most 20 taps a day from one address (`thatsMePerIpPerDay`, raised from 10 for a club's Wi-Fi)
  and 3 sign-ins a day into one record from anywhere (`thatsMePerRecordPerDay`). Every counter
  here is written after the answer (`later`), never in the path a person waits on.
- **A held place taken by name.** `held_by_name`: somebody took the place the organiser held for
  their name from the plain match link, in two taps (DECIDING rule 34, 11 October 2026).
  `held_by_name_refused`: a tap the rule turned down. Both taps share the address's 20 a day with
  "That's me". A browser that knew nobody also counts its new record under `newid_ua_*`; it is not a
  sign-in, so no `signin_*` counter moves.
- **Reading them.** Many `newid_name_here` with few `signin_thats_me`: players do not see the button.
  A high `newid_ua_ios_webview` against `ios_safari`: identities made in the home-screen icon or an
  app's view. `newid_src_wa` close to all new records: the jar is the WhatsApp tap itself.

## From a shared link to a seat

Each step is a day counter in `metrics_daily`, keyed by the tag the link carries, so one query reads
the whole path. No step needs a migration, and no counter holds a name, an address or a token.

1. **The share.** Each share button on a match tags the match link it sends: WhatsApp `?s=wa` (and
   "Tell the group"), the Telegram share `?s=tg`, the "Copy link" button `?s=link`, and the
   phone's own share sheet ("Share…") `?s=share` (`tagMatchLinks`, `tagMatchUrl` and
   `nativeShareData` in `src/lib/share.ts`). A tap on a share button is not counted, because it
   leaves the app; the tag travels with the link instead.
2. **The view.** `view_src_<tag>`: the match page opened by a person with no seat on it and who is not
   the organiser, under the link's tag (`view_src_none` with no tag, `view_src_other` for a word
   the app did not write). Link previews and crawlers do not count, and that includes the WhatsApp
   preview, which the sender's own phone fetches (`viewCounter` in `src/lib/source.ts`). Only a
   full page load counts (`isFullPageLoad`): the browser sends `Sec-Fetch-Dest: document` for it.
   The 20-second refresh on a live night, a move inside the app and a prefetch send
   `Sec-Fetch-Dest: empty`, and a server action sends `Next-Action`, so they do not count. Next.js
   removes the `RSC` header before a page can read it, so that header cannot tell them apart. A
   browser too old to send `Sec-Fetch-Dest` (Safari before 16.4) is read by its `Accept` header: a
   page load asks for `text/html`, and the refresh asks for `*/*`. A reload by hand counts again,
   so read it as views, not people.
3. **The seat.** `join_src_<tag>`: a join from a browser that came through that tag in the last day
   (the `ks_src` cookie).
4. **The new record.** `newid_src_<tag>`: of those, a record made from a name alone.

Read it for the last four weeks: `select key, sum(value) from metrics_daily where day >=
current_date - 28 and (key like 'view_src_%' or key like 'join_src_%' or key like 'newid_src_%')
group by 1 order by 1`. Then compare the steps for one tag. `join_src_wa` divided by
`view_src_wa` is how many WhatsApp visitors take a seat. A high `newid_src_wa` against
`join_src_wa` says those visitors are mostly new records (the jar above). `view_src_none` is
everybody who came without a tag: a link typed by hand, an old untagged link, or a search.
Counters start on the day this shipped (11 October 2026); `view_src_*`, `?s=tg`, `?s=link` and
`?s=share` have no history before it.

## The research desk (Tavily)

The free plan gives a thousand search credits a month. The hourly job spends them evenly: each run may spend up to twelve credits, only as far as the even pace allows, never the last five. Thirty listening queries in English, Russian and Spanish look for fresh threads (one credit each, daily, later when they yield nothing); thirty-three find queries map clubs, coaches, tournaments and communities in ten cities (every ten days); new clubs and coaches get their public contacts read once (ten pages for two credits). Hand searches for answer pages go through `POST /api/admin/research {"q": ...}` and are cached a week; `GET /api/admin/research` shows the meter, the pace, every query's yield and the finds. The board row "Tavily" reads Tavily's own meter. If credits run out early, lower `everyHours` in `src/lib/research/queries.ts`; if they are left over, raise `PLAN.reserve` down.

## Cron jobs

Three jobs run from Supabase `pg_cron` through `pg_net`, and the service board's `pg_cron` row says when each last ran:

- the hourly job → `/api/cron/hourly`. Vercel's own cron also calls it once a day at 07:00 UTC (`vercel.json`), which is all the Hobby plan allows. It has 60 seconds for everything. The score nudges take a 20-second share of that: in Telegram each nudge is the result card as a picture, rendered once per match (3 to 6 seconds cold, measured on 24 September 2026), so about four matches ending in the same hour fit in one run. A match past the share is not marked and goes the next hour; the run's `scoreRemindersDeferred` counts them. When that number is often above zero, the nudges need their own route.
  After it reads the clubs' feeds of free courts, the run offers each free court two to six hours ahead to the players whose want names that club, day and hour (`offerFreeCourts` in `src/lib/notify.ts`, the rules in `src/lib/domain/courtOffers.ts`): at most twenty notices a run, one per player, one court a day for each want, and a want that heard anything in the last six hours hears nothing. The run's `courtOffers` counts them, and each one is a `demand.court_offered` fact. The free courts come from a club's own feed or from a read of its booking platform from the last two hours (below), as the club page shows them (`freeCourtsState`). A club that runs its page here (approved) offers them, and so does a club that the directory lists, as the best times do. A club that only a player listed does not. Until 11 October 2026 only an approved club offered a court. Production had none, so no platform's read ever reached a want.
  Once a day, the first run after 03:00 UTC (after the day's backup) removes the player rows nothing ties to a person: no contact, no public profile, nothing in the database pointing at them (read from the schema; their saved clubs and a coach page with no lesson ever booked go with them; a note, a want or a seat keeps them), and at least 14 days old (`src/lib/domain/disposable.ts`, the owner's decision of 24 September 2026). `GET /api/admin/disposable` lists what today's run would remove and changes nothing; the run's `disposed` and the daily metric `players_disposed` count what went.
  Every run, near its end, sends what players' quiet hours held (the owner's decision D, 9 October 2026; `sendQuietSummaries` in `src/lib/notify.ts`): each person whose quiet hours ended with notices waiting hears once, one short message per channel they have (Telegram, email when activity emails are on, each push device; WhatsApp has no template for it, so a WhatsApp-only player reads the inbox), and those notices count as delivered. At most 200 people a run, read on the partial index `notices_due_idx`; the rest go the next hour. Then it prunes the inbox: rows older than 90 days (`INBOX_DAYS`), at most 5,000 a run, oldest by `notices_created_idx`. The run's `noticeSummaries` and `noticesPruned` count them, and so do the daily metrics `notice_summaries` and `notices_pruned`. The inbox grows by one row per notice per player, a few kilobytes a day at today's size; 90 days keeps it far below the database's 500 MB.
- the push job, every 5 minutes → `/api/cron/push`: match reminders, waitlist offers, lapses and lesson reminders. A match reminder is a notice like any other: a player who switched reminders off gets none, and quiet hours never hold one (the match is within the hour). Each tick also reads the free court times of about a third of the clubs on the booking platforms (below).
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

## Free court times from the platforms

DECIDING rule 35, the owner's decision of 10 October 2026: Kicksmash reads the free court times that
the booking platforms show on their public club pages, and accepts the risk of being blocked.

**The job.** `scrapeIfDue` in `src/lib/booking/scrape.ts`, called at the end of each push tick. A run
starts when the last one began 4 minutes ago or more, so it runs on every tick. Each platform picks
its own clubs, at most eight: listed, no feed of their own, and a link on that platform. The link is
the booking link, else the website (the directory lists most clubs with the platform's page as their
website and no booking link). Every such club is due when its last read is 14 minutes old, and the
oldest cache goes first. So a club that one tick reads comes due three ticks later. The clubs fall into
three groups, each tick reads one group, and each club is read every 15 minutes. At eight clubs a lane,
a platform keeps that pace for 24 clubs. Past 24, the oldest still go first, and each club waits longer.
Until 11 October 2026 only a club that people used was due after 14 minutes, and any other club waited
an hour. Production had no such club on a platform, so each club was read once an hour.

Each platform has its own lane: one request a second, at most eight requests a club. The run stops
before 45 seconds, or before 50 seconds less the push tick's own time. A full read covers three days,
about once an hour (`fullDueMs`, 58 minutes). Between full reads, a club has today alone read and keeps
the later days of its last full read. A lane makes at most three full reads a run (`fullPerLane`). A
club past them has today alone read, and its full read waits for its next visit, never past 88
minutes (`fullLateMs`). So the full reads spread over the ticks. Playtomic reads today in one request:
the cache keeps the club's tenant id (`ref`), and the reader then skips the club page. The cache also
keeps a key of the link that the read came from (`linkKey`, eight hex digits, never the link). The run
uses the kept id, the kept days and a kept good read only while the club's link gives the same key.
After a change of link, the club gets a full read at its next visit. A full read reads the club page
only when the function instance has no copy of that page from the last 24 hours. The run writes the
free courts into `clubs.availability` and `availability_at` as pieces that never overlap: for each piece, the courts
free for the whole of it. A link no reader can read is written as an error with no request, so it
moves to the back. A read that times out keeps the club's last good read: only `availability_at`
moves, so the club goes to the back and its times show as long as they would have. A feed the club
shared always wins.

**The readers.** Playtomic, MATCHi and Book & Go, one file each in `src/lib/booking/adapters/`.
Book & Go clubs book on their own domain, so `BOOKANDGO_APPS` in `bookandgo.ts` maps each booking
host to the club's app (Prime Padel 39, MBP Sports 51, Sterling 83). A new Book & Go club needs one
line there, and its club row needs `booking_platform = 'bookandgo'`, because no link names the platform.

**The cost.** No invocation of its own: it rides the push job's 288 invocations a day. It adds no
migration and no table. A run with nothing to read costs one write and one read of `metrics_daily`,
and one small query for each platform.

The requests a day, for production's clubs on 11 October 2026, and Mandala Racquet Club. Its Playtomic link (`the-mandala-club`) is not in production yet: a change to `data/clubs.json` reaches production only through a migration. "Before" is from `metrics_daily`: the
count by 14:05 UTC, and that rate over a whole day. "Now" is the most the code sends: a club's full
read every hour, and three reads of today between them.

| Platform | Clubs read | Before (by 14:05 UTC, a whole day) | Now, at most |
|---|---|---|---|
| Playtomic | 20, and 21 with Mandala | 1,016, about 1,730 | 21 × (4 + 3 × 1) × 24 = 3,528 |
| MATCHi | 2 | 104, about 180 | 2 × (4 + 3 × 2) × 24 = 480 |
| Book & Go | 4 | 156, about 270 | 4 × (4 + 3 × 2) × 24 = 960 |

A Playtomic full read is at most the club page and three days, and a read of today is one request
(the tenant id above). MATCHi and Book & Go read their club page or their list of locations again for
today, so a read of today is two requests. The two Prime Padel clubs share one Book & Go app, and the
lane's cache answers the second club, so Book & Go sends about 720. The pace does not change: one
request a second for each platform, at most eight a club, and a stop at the first block.

The function time. A typical tick reads about seven Playtomic clubs: about five of today and two full
reads, about 13 requests, and 15 to 20 seconds. The lanes run side by side, so the slowest lane sets
the time. That is about 72 minutes of function time a day, about 36 hours a month. Before 11 October
2026 it was 96 runs of about 25 seconds, about 40 minutes a day. On the Hobby plan that time counts
against the provisioned memory, not the active CPU, because the run mostly waits: at the 2 GB a Hobby
function has, about 72 of the 360 GB-hours a month (20%). The worst case is every tick at its full 45
seconds: about 216 GB-hours (60%). That happens only when a platform is slow on every tick, and
`scrape_cut_<platform>` then shows it. Each run sends at most 45 requests to each platform and writes
at most eight club rows for each. A tick in steady state sends at most 17 to Playtomic: three full
reads and five reads of today (`tests/scrape.test.ts`, "21 clubs"). The three ticks after midnight
in the clubs' zone are the exception. Then the kept days of each club miss the new third day, so each
club gets a full read past the cap of three. That is eight, eight and five clubs, so 32, 32 and 20
requests (`tests/scrape.test.ts`, "after the clubs' midnight"). The first three ticks of the code that
adds `linkKey` do the same once, because no older read has a key. A club whose link changed also
gets one full read past the cap.

**The egress** (Supabase, 5 GB a month). A read from a platform keeps three days on the club row.
Measured on the fixtures (10 October 2026): one day of The Cage Padel Tribe is 9 pieces and 0.7 KB,
the worst day (the count changing every half hour, 07:00 to 23:00) is 32 pieces and 2.5 KB, and the
cache without its slots is about 0.3 KB. Nothing reads the whole cache on a hot path. The pick selects
six columns and the cache without its slots: at most about 4 KB for each platform a run, so at most
about 100 MB a month for three platforms on every tick, and about 25 MB at today's 27 clubs. `/clubs`, the city pages, the API and MCP read only the next 26
hours of each club's slots: about 1 to 3 KB for a club with a fresh read, so up to about 60 KB a render
with 20 such clubs. The picker lists and the Telegram place keyboard read no cache at all. The hourly
court offers read the slots two to seven hours ahead for at most 30 clubs: at most about 25 MB a month.
A club's own page reads its whole row: about 2 to 8 KB. Before the review of 10 October 2026, the pick
alone would have read about 2 GB a month, and each `/clubs` render about 0.6 MB.
The best times (DECIDING rule 36) read the slots of the next seven days, cut in the database
(`clubFeedColumns`): about 2 KB for a club with a typical three-day read, 8 KB at the worst. The
create form reads at most 12 clubs, the person's own and the nearby ones, so a landing view in
Bangkok costs about 25 KB of egress and carries about the same to the browser (about 100 KB at the
worst). /play reads at most 30 clubs, and only while a city has fewer than three open games. A
"times?" reads at most 42, once a minute in a chat at most.

**The switches.** Two, and the first needs no deploy at all:
`POST /api/admin/metrics {"key":"scrape_off_playtomic","value":1}` (or `scrape_off_all`) stops that
platform at the next run, and `"value":0` starts it again. `SCRAPE_DISABLED` on Vercel takes platform
ids with commas (`playtomic,matchi`), or `all`. Vercel gives a running deployment the variables it
was built with, so a change there takes effect only after a redeploy of the same code.

**The back-off.** A 401, 403 or 429 stops that platform for the run, and so does a challenge: an
`x-amzn-waf-action` or `cf-mitigated` header, or a 202 or 405 on a GET (AWS WAF's challenge and
captcha; Playtomic runs behind CloudFront). The platform then rests for six hours, then a day, then a
week for each block after that. A clean read starts the ladder again. The rows are
`scrape_rest_until_<platform>` (epoch seconds) and `scrape_rest_level_<platform>` in `metrics_daily`.
A redirect to a sign-in page is a block too. A "changed" result (the reader no longer finds the page
it knows) at one club is that club's error: a stale or mistyped link. It stops the platform only when
a second club says it in the same run, or when the club read clean last time. The stop holds until a
deploy of new code (`scrape_stop_<platform>` holds the commit it belongs to), so a redeploy of the same
commit keeps it.

**The counters**, one a day in `metrics_daily`: `scrape_ok_<platform>`, `scrape_blocked_<platform>`,
`scrape_changed_<platform>`, `scrape_error_<platform>`, `scrape_requests_<platform>`,
`scrape_cut_<platform>`, `scrape_unreadable_<platform>` (a club whose link no reader can read: each such
club once a day, the first time that day it is written, never as a read that failed),
`scrape_clubs_fresh`, and `cron_scrape_at` for the last run. Until 11 October 2026 the unreadable
counter counted a club only when it was first written, so Kross Padel Indoor, first written the day
before the counter existed, was never counted. The service board has one line for each platform with
a reader: fresh (the clubs read clean in the last hour, by the time of the read itself), resting
until, stopped, or off, and the listed clubs on it that the job never reads (a platform named with no
link on it, or a link no reader takes). A platform that listed clubs name and no reader reads (The
Padel Society, PodPlay, Playbypoint) has a line of its own, "no reader", with the number of its
clubs (`scrapeBoard`, `coverageOf`). A stopped platform is red, and the owner hears once a month.

**When a club's read fails.** The club's cache keeps `error` as the reason and the status
("error", "timeout", "blocked 403"), which is what the pages and the counters read. Beside it,
`why` holds the cause in a few safe words, built only from known parts: the reader's step ("club
page", "availability <day>", "locations", "court-bookings <day>", "frame") and the error's class or
HTTP status ("availability 2026-10-10: RangeError", "club page: HTTP 500", "court-bookings
2026-10-10: TypeError ECONNRESET"). Anything else in the message is dropped, so it never holds a
link, an address, a body or a token. Every reader names its steps in that shape: Playtomic, MATCHi
("club page", "availability <day>") and Book & Go ("locations", "court-bookings <day>"). No page, no API shape and no list read of
free courts shows `why`. Ask
`select slug, availability->>'error', availability->>'why' from clubs where availability->>'error'
is not null`. The push job's answer also lists every club whose read failed (`scrape.failed`), a
timeout over a good read included,
and pg_net keeps that answer for about six hours in `net._http_response`, which outlives Vercel's
hour of logs. A request that the run's own deadline cuts short is not the club's failure: the club is
not written and stays due for the next run, and its last good read keeps showing. The one exception
is the lane's first club in a fair run (30 s or more; the push job passes 50 s less its own work): it
did not fit even then, so the next run would cut it again and read no club behind it. It goes to the
back of the queue. With a good read behind it, that read stays; with none, it is written as "timeout"
with `why` "frame: budget". A run on a very busy tick has
less than 30 s, and a first club it cuts is not written: the next fair run reads it.

**When clubs are cut.** `scrape_cut_<platform>` counts the clubs whose read the run's deadline cut
short, at most one a lane a run. A few cuts a day are normal: a lane of eight clubs can run out of
its 45 s, and the push job leaves the read less time on a busy tick. A "frame: budget" row means that
one club did not fit in a fair run, so read that club's requests (the platform was slow, or the club
needs more requests than its neighbours). Ask
`select day, key, value from metrics_daily where key like 'scrape_cut_%' order by day desc limit 14`,
and `select slug, availability_at from clubs where availability->>'why' = 'frame: budget'`.

**When a platform blocks us.** Do nothing that gets around it: no other address, no browser
disguise, no captcha service, no sign-in. (The one read of a pasted link, below, poses as a chat
app's preview robot by the owner's word. It is no way around a block: it stops at the first 401, 403
or 429, and it does not read a platform that rests or that a switch holds.) Let the rest run out. If it blocks again after a week,
put the platform in `SCRAPE_DISABLED` and tell the owner in one line. A club on that platform can
still share its own feed. **When a platform's page changes**, fix the reader in
`src/lib/booking/adapters/<platform>.ts` with a test from the new page, and merge: the deploy of the
new commit starts it again. A challenge is not a changed page: never fix a reader to get past one.

**Where the bot answers for itself.** Every request names `https://kicksma.sh/about` in its
User-Agent, and `/about` has a KicksmashBot section: what it reads, how often, that it stops, and the
address to write to. robots.txt does not bind a reader (DECIDING rule 35): the Playtomic reader reads
paths Playtomic's robots.txt disallows, under the owner's decision of 10 October 2026.

**A pasted booking link.** "Paste your booking" (the owner, 11 October 2026) reads a link that a person
pastes, once, as WhatsApp's link-preview robot reads it (DECIDING rule 35). The User-Agent is
`PREVIEW_USER_AGENT` in `src/lib/booking/unfurl.ts`. It starts with `WhatsApp/2` and still names
KicksmashBot and `/about#bot`. The read goes only to a host in `PLATFORMS`, over https. It follows
three redirects at most, stops after four seconds, and reads 256 KB of the page at most. It keeps the
title, the description, and the kind of link and the match id from a Branch link. It never logs the
link, because a pasted link can carry a token. It does not read a platform while `SCRAPE_DISABLED`,
`scrape_off_<platform>`, `scrape_off_all` or `scrape_rest_until_<platform>` holds it: the switches of
the reader of free court times hold this read too, and `paste_preview_off` counts each skip. Each
caller gets thirty pastes a day (`rl:paste:*` rows; in the bot the key is the Telegram account). The
bot's "Create match" tap reads the person's words again, never the link, and counts as a paste too.
A paste opens a link only when its words leave out the club, the day or the time.
In the bot, a private message that is no booking costs no read; one with a day and a time but no
platform's link costs one read of the listed clubs. `tg_match_by_paste` counts the matches the bot made
from a paste. Two day counters
show whether platforms still answer: `paste_preview_ok` and `paste_preview_fail`. When
`paste_preview_fail` climbs and `paste_preview_ok` stays at zero, a platform changed its preview or
stopped it. The form still fills from the person's words, so nothing breaks; tell the owner in one
line.

**book@kicksma.sh.** A mail to book@ is a paste by email (DECIDING rule 36, the owner, 11 October
2026). It arrives through the same Resend webhook as claude@ and feedback@ (`/api/inbound/resend`).
Each door is its whole address at kicksma.sh, and a mail that also goes to claude@ stays on the desk.
The answer goes from `Kicksmash <book@kicksma.sh>` through Resend, once, with the filled form's link.
Kicksmash opens no link of the mail and keeps nothing of it: no desk row, no body, no address in a log
line or a counter. Three limits hold it, all in `metrics_daily` with no address in the key:

| Limit | Number | Row |
| --- | --- | --- |
| Answers to one address a day | 3 (`LIMITS.bookMailAnswersPerAddressPerDay`) | `rl:bookmail_to:<hash of the address>` |
| Reads for one sender a day (the paste limit) | 30 | `rl:paste:mail:<hash of the address>` |
| Answers from book@ a day, all senders together | 30 (`LIMITS.bookMailAnswersPerDay`) | `rl:bookmail:day` |

The cap is thirty, not a hundred, because Resend's free plan sends 100 emails a day for the whole
app. Thirty answers leave seventy for the match notices and the codes. Thirty a day is up to 900 a
month, which is 30% of Resend's 3,000. Each answer counts in `emails_sent`, so the service board's two
Resend lines and the bounce rate include book@. A sender's address can be faked, so one address gets
three answers a day, and the cap counts every sender together. A refused mail, or a send that Resend
refuses, gives its places back. A mail delivered twice is answered once (`rl:bookmail_id:<Resend id>`).
A mail that quotes book@'s own answer (the form's address is in it) gets no answer, so a reply or a
robot that quotes cannot make a loop. An address that bounces or complains is marked in `email_marks`,
and book@ never writes to it again: that is the one address Kicksmash keeps.

Two day counters show the door: `book_mail_answered` and `book_mail_skipped`. The webhook writes each
outcome to Vercel's function log as `book_mail` and the outcome, with no address: `answered`, or
`skipped:` and the reason (`sender`, `machine`, `own`, `quote`, `nothing`, `again`, `limit`, `cap`,
`marked`, `send`). When `book_mail_skipped` climbs and `book_mail_answered` stays at zero, read those
lines in the runtime log of `/api/inbound/resend`. If book@ gets no mail at all, Resend's receiving
domain may not route that address: send one test mail and look for `email.received` in Resend.

**A booking screenshot.** "Add screenshot" in the landing page's paste box sends one picture to the
AI model for one read (DECIDING rule 9, the owner, 11 October 2026). The call uses `ANTHROPIC_API_KEY`
and the model that `LISTEN_MODEL` names, and `recordModelCall` counts its tokens with every other
call. A 1568-pixel screenshot is about 1,600 tokens in and a short answer out: about one US cent.
Kicksmash keeps no picture, no reply and no log line of either. Four limits come before the call:

| Limit | Number | Row |
| --- | --- | --- |
| Reads for one address a day | 5 (`LIMITS.bookingShotsPerIpPerDay`) | `rl:shot:<hash of the address>` |
| Reads a day, all addresses together | 20 (`LIMITS.bookingShotsPerDay`, the owner's number) | `rl:shot:day` |
| The month's spend | the owner's cap, `ANTHROPIC_MONTHLY_CAP_USD` | `anthropic_cost_cents`, else `anthropic_in` and `anthropic_out` |
| The key | no call while the last answer was a refusal | `anthropic_refused_at` against `anthropic_ok_at` |

Each screenshot also counts as one paste (`rl:paste:*`, thirty a day). A call that Anthropic does not
accept gives its place under the twenty back. At one cent a read, twenty reads a day cost about six
US dollars a month. Three day counters show the door: `paste_shot_ok` (a read with a booking in it),
`paste_shot_fail` (a read with none) and `paste_shot_off` (no call: a file that is not a JPEG or a
WebP, no key, the five, the twenty, the cap or a refused key). Two refusals do not count there: the
paste limit, which the box says as a paste's limit, and an upload that the action refuses by its size
or its shape before it reads the file. When `paste_shot_off` climbs while the key works, the twenty are spent early: tell the
owner the number, because the cap is the owner's. The landing page's function may run 30 seconds
(`maxDuration` in `src/app/page.tsx`), because the call may take 20.

## The Sunday digest, one line to watch

`Funnel: visitors · matches → filled → scores · card views` is the week in five numbers: page renders (bots excluded); the matches that started in the last seven days (tournaments and cancelled matches left out); those that filled, with three or more of the four seats taken; those with a score; result-card renders. The middle three count the same matches, so the line shows where a match is lost. Until 24 September 2026 the middle read matches created, joins and matches with a result, three different sets, and it could not show that 10 of 13 past matches never filled while all 3 that filled got a score. A step that does not move for four weeks gets a design change, not a marketing push. The score nudge (every player, once, on their channel) and "same time next week?" exist to move the last three.

The digest is the first thing the hourly listening step does on a Sunday from 07:00 UTC, and the next hour tries again until it goes. A digest that fails is an error on `/admin` with the path `listen/digest`. Before 24 September 2026 a failure left no trace, and the digest of 20 September never arrived.

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

**The nightly history rebuild** (the owner's decision of 10 October 2026). A night that prunes an old
file with the contents API only adds a commit, so the old copies stayed in the history for ever. Now,
after the night's file is written and the old days are pruned, `runBackup` reads the default branch's
head, makes one new commit with the same tree and no parent ("backups as of <day>"; its body names the
commit it replaces), and forces the branch onto it. Every older commit is then unreachable, and GitHub
removes it at a time it does not give, which is why /privacy says "about 60 days". The guards, each
proven in `tests/backup-history.test.ts`: no rebuild when tonight's write failed; the tree must be read
whole and hold nothing but night files under `backups/` (a README, LICENSE, `.gitignore` or
`.gitattributes` at the root is allowed, anything else means the token points at the wrong
repository), at most `BACKUP_MAX_FILES` (62) of them, and today's file, the very blob just written;
the branch must not move between the first read and a second read just before the update; and a
refused, failed or odd answer at any step stops before the update. A night that stops keeps the
history as it was, still reports the backup as done, and says why in `backup.history` and
`backup.historyReason` of the hourly job's answer and in its `[backup]` log line. The daily metrics
`backup_history_rebuilt` and `backup_history_kept` count the nights, and the board's backup row names
the last of each and turns yellow when a night kept the history and the last rebuild is more than two
days older, or there was none. A branch protection rule or ruleset that blocks force pushes on that
branch makes every night `github 422 at move the branch`. **To undo a rebuild**, take the commit the branch pointed at before
it: the log line (`history rebuilt, <repo> main moved from <old> to <new>; to undo, point main back at
<old>`), `backup.historyFrom` in the job's answer, or the body of the new commit. Then, while GitHub
still holds that commit, point the branch back with the backup token:
`curl -X PATCH -H "Authorization: Bearer $BACKUP_GITHUB_TOKEN" -d '{"sha":"<old>","force":true}' https://api.github.com/repos/$BACKUP_GITHUB_REPO/git/refs/heads/main`.
Fix the cause before the next night, because the next rebuild cuts the history again.

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
