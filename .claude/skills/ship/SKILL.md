---
name: ship
description: The sequence for shipping a change to Kicksmash, from branch to merged. Use when starting any change, before pushing, when a pull request goes red, and after a merge. Encodes the gate, the suite map, the migration rule and what only the owner can do.
---

# Shipping a change

The order below is why a pull request is green the first time. Each step exists because skipping it
once cost a red run, a review round, or a production fix.

## What to optimise for

**Wall clock first, credits second** (the owner's standing order). They are usually the same thing:
what wastes time is rework, and rework costs both. So the gate is not a tax on speed, it is how speed
is bought: two minutes locally beats a four-minute CI round plus a review round plus a re-merge.

What this means in practice:

- Run independent things at once: batch tool calls that do not depend on each other, and put a build
  or a browser run in the background while reading or writing something else.
- Never re-verify what the gate already proved. Trust a green check instead of repeating it.
- Run the suites the change can break (`GATE_E2E=auto`), not all sixteen out of habit.
- Decide the routine things and say what you assumed. Only stop for what is genuinely the owner's
  call: a migration, identity or personal data, behaviour people rely on, anything outward-facing.
- One pull request per area, auto-merge on, then move to the next thing rather than watching CI.
- Credits second means: do not spend them on speculative work, and never spend them twice. It never
  means skipping a check, because a red run costs more wall clock than every check put together.

**And every change improves scalability or leaves it alone** (AGENTS.md rule 12). Plan it in from the
start: the cheap version of a query, a fan-out or a table is chosen while designing, not retrofitted
after it is slow.

## Before writing code

1. **Start from main.** `git fetch origin main && git checkout -B <working-branch> origin/main`.
   A branch started from a stale main is the one reliable way to make CI pass and main go red.
2. **Read the rule you are about to change.** `AGENTS.md` has the code map, the twelve rules reviews
   enforce, and the two recipes: "Adding a feature" and "Adding a channel". `docs/DECIDING.md` says
   whether a request should be built at all; `docs/VISION.md` says who it is for.
3. **Know what needs the owner.** A migration, anything touching sessions, identity or personal data,
   anything changing behaviour people rely on, and anything outward-facing (an email, a post, money)
   is the owner's decision, not a build. Ask before, not after.

## While writing it

The recipe is in AGENTS.md under "Adding a feature": the rule in `src/lib/domain/` with a unit test
first, the rows in the file for their domain under `src/db/schema/`, the write through an action or
`src/lib/api/operations.ts` with its `OpContext` channel, then the screens, then the proof. Copy goes
into en, ru and es in the same change.

## Before pushing

```bash
GATE_E2E=auto bash scripts/gate.sh
```

Typecheck, lint, schema versus migrations, the unit suite, then a production build and only the
browser suites this change can break (`node scripts/suites.mjs --why` explains the choice; a path no
rule claims runs all sixteen, which is the safe default, never something to "fix" by adding a rule).

A Claude Code hook runs the gate without the browser suites before any `git push` and blocks the push
when it fails, so a push always carries a green typecheck, lint, drift check and unit suite. The
browser suites are yours to run: the hook cannot afford them on every push.

**When the schema changed**, the gate's drift check fails until the migration exists. Then:
`pnpm db:generate`, and commit `drizzle/`. That is all. **The Migrate workflow applies it to
production when the pull request merges** — do not apply it by hand, because a migration applied by
hand is one the workflow then skips, and the two end up disagreeing about what production holds.
The migration file carries the `GRANT` and the two Row Level Security statements itself, because the
workflow applies the file and nothing else. `pnpm db:push` stays disabled: drizzle-kit would drop
the policies. This is AGENTS.md rule 7.

**`docs/MIGRATIONS.md` is the owner's page on all of it**, including step 4, which records the seven
runs it took to prove the workflow and what each failure taught. Read it before proposing anything
about migrations, the Supabase connection's rights, or which credentials a session needs. The
by-hand path through the Supabase MCP survives for repair only, never as the normal way a migration
lands and never for reading: reading goes through `/api/admin/sql` (below).

## The pull request

One per feature or area. The body says what changed, why, whether anything is product-visible, and
which checks ran. Then, while CI runs:

- Turn on auto-merge (squash) so it lands the moment CI is green.
- Read your own diff adversarially and fix what you find on the same branch.
- CI adds one thing the gate cannot: the unit suite a second time against a real Postgres, where a
  `Date` in a raw `sql` template fails and PGlite would have let it pass.

**Red CI is work now**, whatever else is in flight: fix it and push, or say once exactly what is
blocking. Never skip, disable or quarantine a test to get green. "Flake" is not a root cause.

## After the merge

Squash-merge, then `git fetch origin main && git checkout -B <working-branch> origin/main` before the
next change. Check `/api/health` after the deploy. End a batch of work with three lines to the owner:
what shipped, what is next, what needs the owner.

## What only the owner can do

Merging (nobody else may approve or merge), repository settings, creating accounts, paying for
anything, and any outward-facing message. The branch protection ruleset on `main` requiring the CI
checks is theirs to set, and it is what makes auto-merge work at all.

## What this project has already paid to learn

Every line below is here because breaking it cost a red run, a wrong claim to the owner, or money.
**Add to this list the moment something finally comes out right** — while you still remember what the
wrong version looked like. A rule written a day later is a rule written vaguely.

Prefer the enforceable form. A check that fails is worth more than a paragraph nobody opens: if a
learning can be a test, a gate step or a script, make it one and put the story in its comment.

### Check the thing, not the description of the thing

- **Read the build output, never the build config.** 18 MB of `@electric-sql/pglite` — the test
  database, which `createPgliteDb()` throws before importing when `onVercel()` — shipped inside every
  route while `next.config.ts` looked correct. It went unnoticed until Vercel's function storage hit
  75% of 10 GB. `.next/server/**/*.nft.json` is what a route really carries. `scripts/check-bundle.mjs`
  reads it, the gate runs it after every build, and it fails on dev-only packages and fat routes.
- **`"/**/*"` does not match `"/"`.** The first fix for the above left the landing page — the busiest
  route there is — carrying all 18 MB while every other route shed them. The numbers caught it; the
  config still looked right. Give the root its own key.
- **Open the picture before theorising.** A click timing out on `/coach/students` got two rounds of
  guesswork about selectors; the screenshot showed a header overflowing 390px, three screens away from
  the failing click. `SHOTS=./shots pnpm e2e`. For anything visual, look first.
- **Quote the gate's own `EXIT=` line.** A backgrounded gate can exit 0 while the run inside it printed
  `EXIT=1`. Never call a check green from the wrapper's exit code.
- **A script nothing runs is a script nobody has checked.** `scripts/migrate.ts` passed the typecheck,
  the lint and the whole gate, and then failed on its first real use: tsx compiles it to CommonJS,
  where a top-level `await` is a build error, so esbuild refused the file before one line ran. The
  typecheck reads a file, the build leaves this one out, and no test imports it — so "green" said
  nothing about it. Every entry point the gate does not execute needs one cheap run that proves it
  loads: `scripts/check-migrate-runner.mjs` runs the real `pnpm db:migrate` with the database
  variables blanked and demands the script's own refusal and exit 1. Two seconds.
- **An address is only right on the machine that will use it.** `docs/MIGRATIONS.md` told the owner to
  copy Supabase's direct connection, "not Session pooler", with a confident reason: a pooler shares
  one connection, so it cannot run a migration. That is the *transaction* pooler on port 6543. The
  *session* pooler on 5432 gives each caller its own connection and is fine. Worse, the direct
  address carries an IPv6 record only, and a GitHub Actions runner has no IPv6 route, so it could
  never connect at all. The address was correct from a laptop and unreachable from the one machine
  that needed it. Before writing an address into a runbook, ask what will dial it and from where.
- **A value nobody can read back needs the code to describe it.** Six Migrate runs failed for six
  reasons, and the last one was a secret that was not a URL at all. Nobody can read a GitHub secret,
  so every round was a guess about a string. `scripts/connection-hint.ts` now reports the value's
  shape — its length, what comes before `://`, whether it holds a space or a quote, how many `@` it
  has — and never one character after `://`, which is where the password lives. Tests prove both
  halves. When a check depends on a value you cannot see, make the failure describe it.
- **Count the queries before you fire them.** Twelve small production questions in one session is
  twelve interruptions for the owner, because each one is a permission prompt on her screen. One query
  with `json_build_object` answers five questions at once. Batch first, ask once.
- **Ask the database before describing blast radius.** A broken notification string was reported to the
  owner as having reached people's phones. There were zero clubs, so it had reached nobody. One query
  before the sentence.
- **A role under Row Level Security sees no rows, and Postgres does not say so.** The read-only query
  door shipped with four locks, a test on every column grant, and a production check that the role
  could not read a token. Nobody ran a count through it. It answered "0 players" while production held
  48, and a standing order already sent the next session to it. A check that a role *may* read a
  column is not a check that a query *returns* rows: `tests/readonly.test.ts` now counts players
  through the door's own transaction on a database built from the real migrations. And call a tool
  yourself once before writing the rule that sends somebody else to it.
- **What was typed into production by hand is not in the repository.** The three scheduled jobs lived
  only in `cron.job`, with the secret in their text, until migration 0069; and 50 of the app role's
  table grants existed only in production until migration 0075, while every migration file looked
  complete. A database rebuilt from GitHub would have run no jobs, and `kicksmash` could have used
  none of those tables. Compare production with a database built from the migrations
  (`createTestDb()` is one) before calling anything "in the repository", and make the comparison a
  test: `tests/cron-jobs.test.ts` and `tests/security.test.ts`. The same holds for the default
  privileges (what a new table grants, and to whom) and for the login role `kicksmash_agent`: both
  exist only in production (docs/OPERATING.md, "Security at a hundred real players").
- **A line in `.claude/settings.json` is not the permission a connector tool runs under here.** The
  file has allowed `mcp__Supabase__execute_sql` since 7 September, and every call still waited for
  the owner: in this cloud a connector tool's approval is set on claude.ai, under the connector's
  tool permissions. Read the file as a wish, and ask what happens. An allow line also covers the
  whole tool, never one kind of call: `execute_sql` allowed is a `DROP TABLE` allowed, which is why
  no read-only list can hold it. The owner keeps the two Supabase lines (24 September); they change
  nothing while the connector asks.
- **A test of every control is not a rehearsal of the day.** `e2e/tournament.mjs` clicks each part
  of a tournament once and passed. A weekend played through as its people on a phone (26 pairs, two
  categories, four courts, a withdrawal, the knockout, the podium; 24 September) found nine things
  that suite never could: a score typed as "my games first" gave the match to the other pair, a
  player's own matches sat seven screens down, "to be decided" filled the afternoon, the end of the
  weekend led with four free courts. Before telling the owner a flow is ready for real people,
  play it end to end as each of them, look at every screen, and write down what a person trips on.
- **A draft that looks like a fact misleads.** The first page's card fills in from the form, and the
  form fills the date from the player's usual slot, so a returning player opened the page and saw
  a card for a match on 28 September that did not exist. Anything that shows a guess in the shape
  of a real thing must say it is a draft.
- **A player's request is measured against the rules like any other.** The card went onto the first
  page because Erik asked for it there; `docs/DECIDING.md` rule 1 (one job per screen, nothing extra
  above the fold) already said no, and nobody checked. The owner took it off a day later: the first
  page is the ten-second match, and the card's job is sharing after the match. Build what a note
  needs, in the place the rules allow, and say so in the thank-you when it differs from the ask.
- **A delete follows every foreign key, so a merge must move every one first.** `mergePlayers` moved
  the six tables somebody listed by hand, then deleted the duplicate rows, and the database did the
  rest: `on delete cascade` took a student's place on a coach's list and their packages, `set null`
  blanked a note's author. Four merges ran on it the morning it was found, and one answer could not
  reach Erik. A list of tables written by hand is out of date the day a table is added; read the
  foreign keys from the schema (`playerReferences`), and before any code deletes a row, ask what else
  points at it.
- **Write the regression test with the fix, in the same pull request.** The test that catches a
  notification rendering as its own message key took twenty minutes, and was written after the bug
  rather than with the feature that introduced it.
- **When you break the guard, check the test fails for the reason you think.** A test for "a rejected
  club is never shown" set `rejectedAt` *and* flipped `source` to `claim`. Deleting the whole
  rejection check left all ten tests green: the row was failing the other half of the condition, so
  the test proved nothing about the line it was written for. A fixture that satisfies two reasons to
  fail tests neither. Set up the row so the guard under test is the only thing standing between it
  and the wrong answer, then break the guard and watch that named test go red.
- **Prove a new guard by breaking the code.** A check you have never watched fail is not a check. Put
  the bug back, watch it catch it, then restore.
- **Nothing but the browser step parses `e2e/*.mjs`.** A page named `d` in a file that already
  declared `d` further down made the whole core suite fail to load — typecheck does not read `.mjs`,
  lint did not catch the redeclaration, and the gate spent a build and 179 seconds of browser time
  before saying so. `node --check e2e/<suite>.mjs` costs a second and answers the same question.
- **A check that a control renders is not a check that it works.** The landing page's "Played before?
  Get your matches back." door was dead for seven days on the busiest page in the app, and two browser
  checks named that exact line the whole time: one counted the element, one clicked it open and read
  that the input was visible. Neither ever typed an address and pressed the button. Every door gets one
  check that goes all the way through and waits for the answer the far side sends — an unknown address
  answering "We don't know that email yet" proves the handler ran; a visible input proves nothing.
- **A Date in a raw `sql` template is rule 1, and the local gate cannot see it.** PGlite accepts one
  and postgres-js throws `Received an instance of Date`, so the gate goes green and CI's real-Postgres
  run goes red twenty minutes later — which is exactly what happened to `coachBookContents`. Use
  `gt(lessons.startsAt, now)`; `tests/rules.test.ts` now fails on a bare `${now}`-shaped interpolation
  inside a `sql` template, so the gate catches it on the machine that wrote it.
- **"Everybody was told" means everybody with an address.** Erik asked twice in one hour why the
  players got no email for his match. The match's notices all ran through `participantsWithEmail`,
  and six of the fifty-six people in the database have an address at all — so "the line-up is
  complete", "the time moved" and "it is off" reached almost nobody, silently, for months. The
  coach's book had already paid for this exact lesson: sixteen notices behind `if (p.telegramId)`,
  and `tell()` was the answer, because it takes the person and not a channel. When you add or read a
  notice, ask who on the roster it cannot reach and route them. Never route around somebody who
  switched a channel off: that is a choice, not a gap.
- **A commit while a background job holds a file takes the job's version.** A break-and-restore probe
  had the fix reverted for ninety seconds, and `git commit -a` in that window put the bug back into
  the branch with an unrelated change. Commit named paths while anything is running, and read
  `git status` before `-a`.

### Wall clock

Wall clock first, credits second. What actually moved it, measured:

- **One test database per worker, not per file.** Standing up PGlite is the whole cost; emptying it is
  nearly free. 175s → 33s. It needs `isolate: false`, which needs tests to leak no global state — hence
  the env restore in `tests/helpers/setup.ts` (rule 11). One file leaving `GOOGLE_SERVICE_ACCOUNT_JSON`
  behind turned another file red in CI only.
- **Run the suites a change can break**, not all sixteen: `node scripts/suites.mjs --why`. Add a rule
  only when a path proves narrow, never to shorten a run — a wrong "nothing to run" costs a red `main`,
  which costs far more than two minutes.
- **Auto-merge is minutes, not days.** Measured repeatedly: 2.5 to 8 minutes from opening to merged.
  Never plan around "merge rounds", and never ask the owner to merge.
- **Put the long thing in the background and keep working.** A build is ~70s, a full browser run ~110s.
  Write the next file while they run; batch independent tool calls into one message.
- **Do not hand-roll a wait on your own background job.** Backgrounding a command already buys a
  notification when it exits; a loop watching its log is a second, worse copy of that. This rule used
  to say "a condition loop on the thing that actually changes", and that sentence is how
  `until grep -q "^EXIT=" gate.log; do :; done` got written. It went wrong three ways at once, and any
  one of them would have been enough:
  - **`do :; done` is a spin, not a wait.** No `sleep`, so it burned a whole core.
  - **The thing it waited for died.** The container restarted and took the gate with it, so `EXIT=`
    was never written and the loop had no way to end. A wait needs a bound and a line that says it
    gave up — `for i in $(seq 1 60); do …; sleep 20; done; echo "gave up"`.
  - **The harness moved it to the background and that read as "handled".** It is the opposite: a
    foreground command that times out becomes a process nobody is watching, and it is yours from that
    moment. Kill it or finish it before doing anything else.
  It ran for hours while everything else got done, and the only reason it was found is that the owner
  asked why a task was still running. Poll a remote (a branch moving, a check landing) with a bounded
  `sleep` loop; never poll a local job the harness already reports on.
- **Run the fast half while you write; spend the browser suites once.** The gate is ~5m14s on a wide
  change: 64s unit, 79s build, 142s browser. Four full runs in one pull request is four times the cost
  of the one that matters — and the owner noticed before I did. `pnpm exec tsc --noEmit` and the one
  suite you just touched answer in seconds and catch almost everything; run
  `GATE_E2E=auto bash scripts/gate.sh` once, at the end, before the push. The gate is still never
  skipped: a red CI round costs more than every check put together.

- **One validated push beats three speculative ones.** Each push costs a CI cycle, and until the
  `claude/**` rule in `vercel.json`, a stored deployment as well.
- **Kill what you start**, and check at the end of a batch that nothing is left. A forgotten probe
  script held 599 MB for six hours; a spinning wait loop held a core for longer. `pgrep -af` for the
  things this repo starts (`gate.sh`, `vitest`, `next build`, `next start`, `e2e/run.mjs`, and any
  loop you wrote) before calling work finished. Kill by **PID**, never by pattern: `pkill -f
  "next start"` once matched the backgrounding shell's own command line and killed the caller.
  Finding the PIDs has the same trap: `for p in $(pgrep -f "bash scripts/gate.sh")` listed its own
  shell, whose text holds the pattern, and killed it (exit 144, 24 September 2026). List with a
  pattern the command cannot match, `ps -eo pid,cmd | grep "[g]ate\.sh"`, and never start a long
  job with `&` inside a command: the harness backgrounds it and reports its end; `&` hides it.
- **A worktree inside the repository breaks the build.** A workflow run with worktree isolation left
  three checkouts under `.claude/worktrees/`, each with `node_modules` linked in, and `next build`
  died with `Cannot read properties of undefined (reading 'length')` while typecheck, lint and unit
  passed. `.git/info/exclude` hides them from git and from nothing else. Take the commits out
  (`git merge --squash wf/<branch>`), then `git worktree remove --force` every one, before the gate.
- **Inside a worktree, `check-bundle` reports the worktree, not the change.** A build in
  `.claude/worktrees/<agent>` with `node_modules` linked from the parent succeeded, and
  `scripts/check-bundle.mjs` then found the 18 MB test database in all 131 routes, `/me` included,
  which the change never touched (25 September 2026). Next picks the parent as the workspace root
  (two lockfiles), every traced path starts with `../../../node_modules`, and the project-relative
  `**/@electric-sql/pglite/**` in `outputFileTracingExcludes` matches none of them. Read one
  untouched route's `.nft.json` before blaming the change; the real checkout and CI are the judge.
  And never edit `src/` while a build runs: its type check reads the files as they are at that
  second, and a half-made edit fails a build the finished code passes.
- **Ask production through the read-only query door, in one query.** This container cannot open port
  5432 (or 6543) whatever the network policy says; an hour went on proving that on 18 September. The
  Supabase MCP answers, but every `execute_sql` waits for the owner to approve it, and on 23 September
  a dozen small questions became a dozen interruptions: the owner started denying them and called it
  the biggest defect of the day, because a session that waits for approval cannot one-shot anything.
  Ask `GET https://kicksma.sh/api/admin/sql?q=<one select>` with `Authorization: Bearer $CRON_SECRET`
  (docs/OPERATING.md), through `curl -G --data-urlencode`. Put every question in one query — a `with`
  of several counts, or one `json_build_object` — never one request per question. The MCP stays for a
  repair the Migrate workflow cannot make, with the owner's word. A secret works only as `$VAR`: the
  harness refuses a command that writes one to a file or carries one in its text.
- **Do the cheap true thing before the expensive one.** Counting rows in production took one query and
  changed what was worth building next more than an hour of reasoning would have.

### The push and the gate

- **Read `GATE_EXIT=` before the push, in a separate command.** A push chained after the gate in one
  shell line (`... ; git push`) went out on a red gate: the exit line was printed, nobody had read
  it. The gate's log is read first, the push is its own command, every time.
- **A new button on a page an old suite already clicks needs a name of its own.** A second "Save"
  on the club's manage page made `getByRole("button", { name: "Save" })` match two elements and the
  clubs suite failed on a line the change never touched. Before adding a button, grep the suites
  for the page's existing button names; give the new one its own words ("Save courts"), and make
  the old locator `exact: true` where the new name still contains the old word.

- **Every browser suite is one visitor to a rate limit.** All twenty-one reach the server from the
  same address, so they share one `newid` bucket and `newIdentitiesPerIpPerDay` is 40. The run had
  crept up on that ceiling for months; adding one player to the coach suite pushed it over, and the
  suite that failed was `viral`, which the change never touched, on a `waitForURL` whose whole error
  was the word "timeout". `e2e/lib.mjs` now gives each suite its own `x-forwarded-for`, which is what
  twenty-one real people look like. Two rules came out of it: a shared counter is shared state, so
  count it like one; and a wait for a navigation also waits for the error that replaced it — watch
  both, or the failure cannot say what it was.
- **A setting a walk switches on stays on for every check after it.** Olga ticked "anyone can book"
  at the first settings save, and forty lines later the assistant walk — which exists to prove that
  booking before the coach accepts is refused — got a 201 and then hung waiting for "Waiting for your
  yes". Nothing was wrong with either half. A browser suite is one long-lived world, so flip a setting
  at the point the walk needs it, never at the first convenient save, and read what the rest of the
  file assumes before you tick a box near the top of it.

### Editing that keeps going wrong

- **Never round-trip `messages/*.json`.** Loading and re-serialising reformats the compact single-line
  blocks and turns a three-key change into fifty-seven changed lines; a hand-rolled comma fix corrupted
  `en.json` once. Use `node scripts/i18n.mjs add <dotted.key> "<en>" "<ru>" "<es>"` — one line per file,
  refuses to overwrite, and proves the three locales still carry the same keys.
- **A section on one line takes its keys by hand, and the loop must not stop there.** `wrap` in
  `messages/*.json` is a single line, so the script refuses (`found no section 'wrap' … written over
  several lines`) and a shell loop chained with `&&` exited before the other keys were added. Add
  such keys with a string insert before that line's closing `},` (json.dumps each value, then
  `json.load` the file to prove it), and run the script's keys after, one command each.
- **Changing an existing string means finding it twice: by name and by section.** `cityOther` lives
  in both `club` and `tournament` in `messages/*.json`, so a line-based edit keyed on the name alone
  hit two keys and the assertion caught it only because it counted the matches. Anchor on the
  section's opening line (`"tournament": {`), then take the first matching key after it, and assert
  the section appears exactly once. `json.loads` the whole file before it touches disk, every time.
- **The script puts a key after the section's last key, even when that key is a nested object.**
  `email.telegramLine` landed inside `email.scoreNudge` because `scoreNudge` closed the `email`
  section, and the script printed `added … (after "cta")` as if all were well. After every add,
  prove where it landed: `node -e 'JSON.parse(...).email.telegramLine'` must not be undefined. Move a
  stray key by string edit (the line out of the nested block, then in under the section's opening
  line), never by round-tripping the file.
- **A backslash in a raw `sql` template is one edit away from gone.** `'\\s+'` in the source is `\s+`
  in the query; one script edit wrote `'\s+'`, which a JavaScript template reads as a plain `s`, so
  the same-name match collapsed every letter s instead of the spaces and a test caught it. Use the
  POSIX class (`'[[:space:]]+'`): nothing to escape, nothing to lose.
- **In a select from one table, drizzle writes the columns bare.** `${events.id}` inside a correlated
  subquery in `.select({...})` came out as `"id"`, which the subquery read as the seat's own id, so
  the digest's "filled" step counted no match at all (the unit test caught it). With a join the same
  column is qualified, which is why `reminders.ts` works. Alias the inner table and name the outer
  one by hand: `(select count(*) from ${slots} s where s.event_id = ${events}.id)`. `.toSQL()` shows
  what drizzle actually wrote.
- **A line that recurs in a file is not an anchor.** `const t = await getTranslations("coach")` appears
  in both `generateMetadata` and the page; a replace on the first put `locale` in the wrong function
  and the page did not compile. Anchor on a neighbouring line unique to the function (the one after
  `monthRange`), or on two lines together.
- **A backtick inside a template literal ends it.** `src/lib/api/docs.ts` is one long template
  literal, so writing a word in backticks inside it (`` `claimed` ``) closed the string and the
  typecheck failed twice, four hundred lines further down, on a missing semicolon. The file is
  documentation for assistants, not Markdown for a reader: use plain words in it.
- **A check nothing runs is not a check.** `scripts/gen-docs.mjs --check` proves every
  `process.env` the code reads is in `README.md` and `.env.example`, and neither the gate nor CI
  ever called it. It is a gate step now. Before adding a script that verifies something, add the
  line that runs it.
- **A default can make an absent thing look present.** Moving two public names out of the
  deployment and into `config.ts` broke both in the same way. `telegramBotUsername()` returning a
  name instead of null would have put "open the bot" buttons on a deployment with no Telegram, and
  `TELEGRAM_MINIAPP_SLUG` getting a default sent the bot's cards into a Mini App that nobody had
  created — `tests/telegram.test.ts` caught the second one. The rule both break: a public label may
  have a default, but whether the thing exists is a different question. A bot follows from its
  token, so gate the name on `telegramEnabled()`. A Mini App follows from nothing, so it keeps no
  default at all. Before giving a value a default, ask what a caller does when it is missing.
- **A default repeated in eight files is not a default.** `process.env.LISTEN_MODEL || "claude-sonnet-5"`
  is written out in eight files, three with `||` and three with `??`, and the variable is set
  nowhere — so the model the product uses is eight copies of a literal nobody would grep for.
  One reader in `src/lib/config.ts`, and every caller takes it from there.
- **A new `DomainErrorCode` has a second home.** `src/lib/api/http.ts` maps every code to a status and
  is typed `Record<DomainErrorCode, number>`, so adding `already_paid` to the union broke the API until
  the map learned it. Grep `Record<DomainErrorCode` when a code is added.

- **Anchor on the name, never the line number.** Keys have landed in `coach.home` when they were meant
  for `coach.page` because the insertion point was found by counting.
- **Fixtures never use "now".** `freezeClock` and a fixed date (rule 11). Two hours went on tests that
  correctly refused a student's reschedule, because the fixture's "now" sat inside the twelve-hour
  cutoff; and on lesson times that landed in the 12:00–15:00 gap between the morning and afternoon
  presets. Write the hour mapping as a comment in the test.
- **A default that was yours stops being yours when the list grows.** The create form filled the venue
  from `venues[0]`, which was the court you last used — until the picker started carrying all 67
  clubs, and `venues[0]` became a club in another province, quietly filled in as your match's venue.
  Whenever a list gains rows from somewhere new, grep for who reads its first element.
- **A shared component carries the promises of the screen it was built for.** `EmailField` said
  "Saved — calendar invite on its way" and offered "Email me when the line-up changes"; `PushToggle`
  said "Remind me 1 hour before each match". All three were true on a match page and false on the
  coach's channel step, where they were reused. When a component moves to a new screen, read every
  string it renders there as that screen's reader, and give it props for the ones that no longer hold.
- **Lead with the thing that is already true.** The calendar section opened with five Google menus,
  and a coach never learned that every lesson already reached their calendar by email. State the
  benefit the reader already has first; fold the extra machinery under the benefit it adds.

- **A screen with names in it is an interface.** Renaming the coach setup steps turned three browser
  suites red — two of them not the coach suite. Grep the step names before renaming one. Placeholders
  count: "or type a club" → "or pick a club" is four words and five red suites, because
  `getByPlaceholder` takes the whole string.

### A new kind of row in an old table

- **The key is whatever production already types, not what the name makes.** The club directory was
  written with `venueSlug(name)` slugs — "warehaus-club" for WAREHAUS.club. Production's eight matches
  and both coaches key on `warehaus`, so every one of those clubs would have got a second page with
  none of its history on it. One query against the live table (`select venue_slug, count(*) from events
  group by 1`) before generating the file would have shown it. Ask the database what the keys are.
- **A new `source` value does not update the queries that predate it.** Sixty-three listed clubs
  instantly became sixty-three claims waiting for the owner's approval, and sixty-three "clubs claimed"
  in the weekly digest, because both queries were written when every row in `clubs` was a claim. When a
  table gains a second kind of row, grep every `from(<table>)` and decide, one by one, which kind each
  query meant.
- **A second kind of row, or a second table? Count the queries that would have to learn.** An hour a
  coach *opens* on one date is the mirror of `coach_blocks`, and a `kind` column there would have been
  one migration smaller. But every query that reads that table means "busy", so each one would have to
  exclude the new kind, correctly, for ever — and a query written next year would not know. A separate
  `coach_openings` costs one more indexed read and cannot corrupt a query that predates it. Add the
  column when the existing queries already want both kinds; add the table when they mean the opposite.

- **A write over a shared row must know how to give it back.** `claimClub` wrote `source: "claim"`
  over the directory's Warehaus row, and the refusal only set `rejected_at`, so one test claim took
  the busiest club off `/clubs`, the city page, the picker and the claim form for five days. Worse,
  `listedClub` ignores refused rows, so a tournament typed "WAREHAUS.club" that afternoon landed on a
  second slug, `warehaus-club`. When a state change hides a row, grep what keys on that row (slug
  lookups, pickers, the import guard) and decide what the undo restores; `relist` in `decideClub`
  restores from `data/clubs.json`, and a test holds it to the import script's own statement.
- **A new status value has two sides, and only one of them checks the status.** `left` closed the web
  door for a player who removes a coach, but the coach's Telegram assistant still recognised the name,
  and `bookLesson` with `byCoach: true` skips the student-status check on purpose — so the coach could
  book a lesson straight back onto the calendar of somebody who had just walked away. When a status says
  "this relationship is over", grep for every place the other side acts, and check each one for the
  branch that trusts the actor instead of the status.
- **A rule that lets new people act is also a rule about what the page fetches.** `open_booking` let a
  stranger book, and `bookLesson` accepted them — but `/c/[handle]` read its free hours behind
  `accepted ? … : []`, four times over, so the new booking block rendered with no times in it and the
  browser suite hung on a day chip that opened nothing. A server component decides what exists before
  a component decides what to draw: when a rule widens who may act, grep the page that renders the
  action for every `status ===` and `accepted ?` and ask each one whether it guards data or a screen.
- **Dropping a name from a list is not the same as refusing it.** The first fix filtered departed
  students out of the assistant's list — and an unmatched name there makes `addStudentByName` create a
  *new player of that name*, so the coach would have booked a ghost while the real player heard nothing.
  Before filtering a name out of any matcher, read what the "no match" branch does. Keeping the row and
  tagging it is usually the smaller, truer change.
- **Derive the state nobody will ever set.** A coach never taps "I have stopped coaching", so a column
  for it would have stayed false forever. `max(lessons.starts_at)` against the coach's own index says
  the same thing, needs no migration, and reverses itself the moment the coach books again. Before
  adding a column for a state, ask which human tap would ever write it. When the honest answer is
  "none", read it from the rows that already move.
- **An escape hatch that names a thing has to collect that thing.** The channel step offered Telegram
  and escaped through a button reading "Email me instead" — which collected no address and simply moved
  on. A coach tapped it, finished setup with no channel of any kind, and two of his student's lessons
  were never mentioned to him. Read every button that promises something, and check that the promise
  is kept by code and not by the label.
- **A gate reads the actor; the rule is usually about somebody else.** The first channel gate asked
  whether the *signed-in person* could be reached, and blocked a manager who runs somebody else's
  bookings and cannot set that coach's channel. Before gating a screen, name whose state the rule is
  about, then check that one — `getCoachForActor` returns the role for exactly this reason.
- **A test that asserts on a wire format is testing the wire format.** An address past the 73-character
  iCalendar fold is split across two lines, so `toContain("mailto:…")` fails on a perfectly good
  invitation. Unfold (or parse) before asserting, the way every client does.
- **A `useState` seeded from a prop is a stale value after the first refresh.** `useState(days[0])`
  held a date that `router.refresh()` had since taken out of `days` — booking the last hour of a day
  removes that day — so both filters came back empty and the screen showed "Free times on" with no day
  after it and no chips at all. Derive on render (`days.includes(picked) ? picked : days[0]`) rather
  than store, wherever the list can change under the choice.
- **`.btn` carries `whitespace-nowrap`, so a long label runs off both edges.** Capping the box with
  `max-w-full` does nothing on its own: the text has to be allowed to wrap first
  (`whitespace-normal py-2 text-left leading-snug`). Read any button whose label is a sentence at
  390px before shipping it.
- **A test fixture goes through the same door the screens do.** `createCoach` takes no prices, so a
  fixture that passed `priceSingle` made a coach with none and the assertions failed against perfectly
  good code. When a factory silently drops a field, the test is lying about the state it set up: build
  the row the way the app builds it (`createCoach` then `updateCoach`), or widen the factory.

- **Help text inside a `<label>` is part of the label's name.** `getByLabel("Name", { exact: true })`
  timed out because the label read "NameAs it goes on the poster.": the hint `<span>` sat inside the
  `<label>` with the input. Put the hint beside the label, not in it (a `<div>` around both), and the
  label names exactly what the reader sees in bold. The fix by regex mangled two files; a form's
  return block is rewritten whole, never patched by pattern.
- **A shuffle must not cross a line the rules drew.** `orderEntrants` shuffled every unseeded pair
  together, so a pair on the waiting list could land in the field and a pair in the field could be
  "out"; the lucky-loser test caught it as a replacement in five matches instead of two. When a list
  has tiers with meaning (the field, then the waiting list), shuffle inside each tier, never across.
- **A read named for one screen is narrower than the next screen thinks.** `orderOfPlay` listed the
  matches with a time, which is what the page wanted; the results file reused it and lost every
  match played before the schedule was made. When a second caller reuses a read, check its `where`
  against what the second caller means, and add the option (`all`) rather than the assumption.
- **A draw shuffles, so a suite picks by state, never by position.** "The first Score button" was a
  pending match in three runs and Cal's finished match in the fourth, whose form has no walkover
  buttons, and the click timed out. Anything generated with a random seed changes order between
  runs: filter the locator on what the step needs (`hasNotText` the finished score, `has` the
  button), and never on `.first()` alone.
- **A controlled input wipes what was typed before React hydrated it.** On the long manage page,
  Playwright filled the courts textarea before hydration; React's first client render set
  `value=""` from state, the button stayed disabled, and the click timed out. A probe on a short
  page passed, which is the tell: the fault is timing, not the selector. A form a person can reach
  before the page is interactive is uncontrolled (`defaultValue` + a ref, read on submit), and a
  suite reloads before it fills a long page.
- **`ls` the folder before naming a new module.** A heredoc to `src/lib/domain/schedule.ts` overwrote
  the existing schedule module (the API's `buildSchedule`) without a word; only `tsc` on another file
  said so. The court scheduler is `courtSchedule.ts`. Before `cat > path`, `ls` the folder or `git
  status` the path; a name that reads right is not a name that is free.
- **A success message the next render replaces is a race, and the test will lose it one run in
  four.** The claim card said "Confirmed" from client state and called `router.refresh()`; the server
  then rendered the same URL with a spent token, which is the "link used" card, and the message was
  gone before Playwright read it. Three green runs, then a timeout. A confirmation the reader should
  keep is the server's to render: navigate to a state the page can rebuild (`?claimed=<id>`), never
  refresh under a message.
- **A view that echoes its input is not a read.** `competitionDraws` returns the category object it
  was handed, so a test that kept the object from `makeDraw` read `drawn` after the final had set
  `done` in the database. When a function takes a row and returns it inside its result, the caller
  reads the row fresh first (`categoriesOf`), the way a page does; the test that passed a stale row
  was wrong, not the function.
- **A typed translator does not travel.** Passing `Awaited<ReturnType<typeof getTranslations>>`
  into a helper made every key "not assignable" and one "excessively deep". Type the helper's `t` as
  `(key: string, values?) => string` and cast once at the top of the server component; the message
  files, not the type, prove the keys.
- **`innerText` carries `text-transform`.** A chip set in capitals by CSS reads "8 PAIRS OF 8" to
  Playwright, so four checks written from the source strings ("8 pairs of 8", "Entries closed") went
  red while the screen was right. Compare lower-cased text, or read `textContent`, whenever the check
  touches a `.chip-*` or anything else the stylesheet capitalises.
- **The suite map reads the `e2e/` directory, so the suite file comes before the rule.** A rule for
  the tournament paths printed "no suite" until `e2e/tournament.mjs` existed, because `ALL` is the
  directory listing and a rule's suites are filtered against it. Write the suite, then ask
  `node scripts/suites.mjs --files … --why`, and read its answer, never assume it.
- **A migration lands in production the moment the schema is final, not after the gate.** The gate
  proves the code; the tables are additive and the same either way. Applying 0053 while the browser
  suite ran cost nothing, and the merge never waited on it. Then read the row back
  (`select … from drizzle.__drizzle_migrations order by id desc limit 3`) before writing "applied".

- **A "hidden" element in a Playwright timeout is often a crushed one.** `locator resolved to hidden
  <div …>500 THB · not paid</div>` — the element was there and on screen, but a row built for one
  button now carried three, the text column collapsed to zero width, and Playwright counts zero-size
  as hidden. Read the call log's "resolved to hidden" line as "look at the layout", not "the data is
  missing": the crash screenshot showed the fault at once.

- **Take the screenshot, then take it again.** The overflow above was fixed twice: the first fix
  looked right in the code and still ran off the screen, and only the second picture proved it. For
  anything visual, the picture is the check — `SHOTS=<dir> E2E_ONLY=<suite> pnpm e2e`, and remember
  `pnpm e2e` uses the build already on disk, so rebuild first.

### What the walks keep finding

- **"No match" is a query over every column that points at a player, never a look at one table.**
  I told the owner jakob2, jakob3, JAkob7, Jakob8 and Mike Movenpick had no match and could go. Each
  had a seat and up to ten rows in `tournament_matches`: names Jakob gave in his tournament of 4
  September. The generated query (`playerReferences`, the same list a merge moves) said so in one
  read. Ask it before saying a row is empty.
- **A walk runs on a local build, never on production.** The five walks of 21 September signed up as
  their characters on kicksma.sh and left 25 player rows behind, two of them owners of saved clubs.
  They then counted as players: "48 players, 42 without a channel" went to the owner when the truth
  was about 17 people. The harness in the scratchpad (`serve.mjs`, `h.mjs`) serves a local build with
  the browser suites' settings; a walk that must see production reads it and writes nothing.
- **A list that links to sixty-six pages is sixty-six checks, and I made one.** Tier 2 put the
  listed clubs on `/clubs` and in the sitemap, and I proved it live by opening
  `/v/destination-padel-club`. That club has a match. The page's guard wanted a venue board, and a
  board exists only once somebody plays there, so the other **sixty-three of sixty-six answered 404**
  — every one of them linked from `/clubs` and named in the sitemap. One query
  (`select count(*) from clubs c left join (select venue_slug, count(*) from events group by 1) e
  on e.venue_slug = c.slug where e.venue_slug is null`) would have found it in a second. When a
  change makes many pages, open the one with the least behind it, not the first one in the list.
- **The owner's standing order outranks the safe-looking design.** The migrate workflow was built
  with a required reviewer, so every migration would stop and wait for Cath's tap. She had already
  written the opposite: one shot means she is not involved until it is finished. The approval she
  actually gives is the conversation where the migration is designed and the merge that carries it;
  a third click after the merge is ceremony, not safety. Before adding a human gate, check whether
  the human already answered somewhere earlier in the pipeline.
- **A check inserted into a form is a navigation out of it.** Four suite checks went red because a
  new block landed between `check("Listed publicly")` and the `Save` that would have stored it: the
  `goto` threw away the tick, the time zone and everything typed after. The failures named the API,
  the city list and the MCP server — three places that had nothing to do with the change. Before
  putting a check in the middle of a walk, find the save it sits before. If the check needs the
  state saved, save it first and say in a comment why that save is there.
- **The notice a person needs is worth nothing behind a door they open once.** The "your card is
  missing what players choose on" card shipped with Tier 1 and lived only in `/coach/settings`.
  Weeks later both live coaches were listed with all four gaps and neither had ever seen it. When a
  screen exists to change somebody's behaviour, put it where that person already stands, and ask the
  database afterwards whether anybody acted.
- **A screen that makes something a person owns must hand it to them.** The americano generator
  builds a correct schedule — seven rounds, every pair partnering once — and then offers Print,
  Shuffle again, and a bridge to a live match. There is no link, the URL never changes, and closing
  the tab loses the work. Whenever a screen produces something the person made, ask what they hold
  when they close the tab; "they can print it" is an answer for one person in ten.
- **A refused role is still a role until a query says so.** `rolesFor` read `clubs.claimed_by` and
  nothing else, so a club manager whose claim was refused kept the club door in the header for ever,
  and it led to a page that said "Not approved". Navigation is a role and belongs in `rolesFor`;
  the record belongs on `/me`, where "Not approved" is information rather than a door. When a status
  ends a relationship, grep for every list that still names the person.
- **A dead end that names a developer's channel is a dead end.** "Write to us in GitHub Discussions"
  was the whole next step for a refused club manager. They have no account there and no reason to
  make one. The note that reaches the owner is already a page on this site: point at that.
- **To test what the edge decides, send the edge's headers.** The country and city branches read
  `x-vercel-ip-country` and `x-vercel-ip-city`, which no local run sets, so the branch had no test
  until the browser suite passed them in `extraHTTPHeaders` on a context of its own. Give the branch
  its own context; putting the header on the shared `iphone` makes every other suite a visitor from
  that country.
- **The empty state is the product, before there is a product.** Every club on Kicksmash is in
  Thailand or Singapore and every coach is in Phuket, so a reader in Kuala Lumpur, Berlin, Madrid or
  Moscow met two city headings, two founding chips and a search that found nothing. The model was
  already world-wide — sixty-one countries, clubs grouped by country in the reader's language, a
  bucket for coaches elsewhere. What was missing was one sentence naming their country. Check the
  screens of a person the data does not reach yet: they see the product's real scope, not its plan.

### Two ways a change hangs or bloats

- **A query on the pool inside a transaction waits forever.** `updateEvent` opens a transaction with
  `for update`; a lookup added inside it ran on `db`, asked for a second connection, and the whole call
  sat there until vitest timed it out at 30 s. On PGlite there is one connection, so it deadlocks every
  time. Resolve what the write needs *before* `db.transaction(...)` opens, and pass the value in.
- **`domain/clubs.ts` is not a leaf.** It imports the search-engine ping, which reaches the sitemap, the
  listening desk, the Discord bot and `notify`. Importing it from `domain/events.ts` pulled all of that
  into every client component that touches a score, and the production build failed with a webpack
  error whose only clue was the import trace. A helper that every write path needs belongs in a leaf
  module (`domain/venueBoard.ts` holds `venueSlugFor` for exactly this reason). Read the import trace
  from the bottom up: the last line is the innocent screen, the first is what dragged the world in.

### The feedback desk

- **A web-form note has no way back to the person.** `deliverToPerson` answers by email or Telegram,
  and a note from the in-app form carries neither — only a `player_id`. So "shipped" on such a note is
  bookkeeping (status, `shipped_at`, `pr_url`, the `feedback_shipped` metric) and the one-sentence
  "what changed" that DECIDING.md promises reaches nobody. Until the desk can reach a player by their
  own channels (`channelFor` already knows how), close the note honestly and say so to the owner rather
  than reporting the person was told.
- **A rule that closes one door should close every door with the same name.** The sixty-day rule took
  a quiet coach off a student's screen and left them in the public directory, the club page's coach
  list, the sitemap and the level verifiers. Three of those are "somebody chooses a coach here" and got
  the rule; the sitemap (the page still opens) and the verifiers (somebody who saw you play can still
  say so) deliberately did not. When a rule lands in one query, grep the others that list the same
  rows and decide each one on what the reader is choosing, not on whether it is convenient.
- **Read the desk when the owner asks "any feedback?"** The assessor can run out of budget and leave
  notes at "acknowledged" with no proposal; the owner's Telegram then carries only "no analysis". One
  query on `feedback` since yesterday is the whole answer, and it also shows what the tester actually
  did (`lessons` since yesterday), which is worth more than the notes.

### Screens the owner's tester tripped on

- **Dim the text, never the row.** A paused student's row was `opacity-60` end to end, and the one
  button on it that undoes the pause looked disabled — Erik asked whether it was. The same fault sat
  on a no-show lesson row the moment it gained an undo button. Whatever is dimmed to say "inactive"
  must not contain the control that makes it active again: put the opacity on the text block.
- **A destructive tap gets an undo on the row, not a confirm on every tap.** A confirm on "No-show"
  would tax every real no-show to protect the accidental one; "They came after all" beside the status
  costs only the coach who needs it. Grep for status-setting buttons with no way back before shipping
  one, and put the way back where the tap was.
- **A title the reader cannot act on is not a title.** "Who runs your lessons with you" was read twice
  by the owner and once by the tester, and neither knew what it was for. Open a section with the
  question it answers ("Does someone else take your bookings?"), fold it shut until it applies, and
  make the lead say who the person is and what they can do.
- **A "More" toggle over a list is where things go to be forgotten.** The three other screens and the
  student link sat under it, and the tester disliked the layout without being able to say why: a
  toggle that reveals a list is a menu, and a menu is not a screen. Three doors are three buttons; the
  link that used to hide there now lives where a student is added.
- **One prompt() handler per suite, with an answer you can set.** `page.on("dialog", d => d.accept())`
  answers every prompt with an empty string, so a test of "change the amount" would have set it to
  zero and passed the wrong way. A second `once("dialog")` listener races the first and throws. Give
  the helper one mutable answer (`promptText.value = "550"`) and pass it on `prompt` dialogs only.

- **A package that pays for a lesson leaves `amount` null, not zero.** `pkg ? 0 : priceFor()` plus
  a fee made every package lesson carry `amount: 0`, which is a debt of nothing on every screen that
  lists debts. Null means "nothing to owe"; zero means "was priced, now free" (a comp). Keep the two
  apart in the one place that writes them, and test the null.
- **A prop name is a namespace.** `offers` already meant waitlist offers on the student's screen, and
  `offers` for packages collided with it in both the component and the page. Grep the props of the
  component and the consts of its page before naming a new one; `packages` cost nothing.
- **The truncating span must not hold the figure.** "Mon, Sep 21 10:00 · 800 THB" truncated to the
  date at 390px because the amount sat inside the same `truncate` span as the label, behind two
  buttons. Put the label in the span that truncates and the figure in a `shrink-0` beside it.

- **"0/0 suites passed" is not a pass.** `E2E_ONLY=coach.mjs` matched no suite, the runner exited 0,
  and a grep for `✗` found nothing — so a real failure in the coach suite was read as "passes on its
  own, the gate's run was a race". The suite name is `coach`, no extension. Quote the `N/N checks
  passed` and `1/1 suites passed` lines, never the exit code; a zero on the left is a run of nothing.
- **A control that hides on phones needs its own opener in the suite.** The language toggle became
  one pill on a phone, and three suites that clicked `ru` by role on an iPhone viewport hung on a
  hidden button and said only "timeout". `switchLang` in `e2e/lib.mjs` taps the pill first; use it,
  and give the next collapsing control the same kind of helper in the same change.
- **`scripts/i18n.mjs add` needs the section to exist.** `email.claimCode.subject` failed with "has no
  section" and, under `set -e`, took the rest of the script with it: the edits after that line never
  ran. A new nested section (`email.claimCode`) is written by hand in all three files first; then the
  script adds keys under it. Check what the script printed before trusting the edits after it.
- **A check that pins a heading's whole text breaks when the heading gains a part.** The venue
  picker's heading became "Thailand · Phuket" once a claim carried a country, and a check on
  `"Phuket"` exact went red. Match the part the check is about (`/(^|· )Phuket$/`), not the line.

### The bot as buttons

- **Telegram swaps a photo for a photo, never text for a photo.** `editMessageMedia` refuses a text
  message, so the score nudge could not become the result card until it was sent as a picture. A
  message that may one day carry a picture must be born as one; keep a text fallback for a picture
  Telegram cannot fetch, and mark which is which (`telegram_cards.rendered` is null for text), so the
  close edits each the way it can. A tap under a picture edits the caption: `editMessageText` refuses
  that too.
- **A reply to a prompt is read before the score reader.** `plainScore` takes any reply to a bot
  message that looks like a score, and "22:30" typed as the time for a lesson looked like one, so the
  tap flow's typed step came back as `score_how`. Anything that reads a reply to one of our prompts
  runs first, gated on the prompt's own trailer, before the general readers see the message.
- **64 bytes is the whole budget of a button.** A uuid is 36; three of them do not fit. Pack ids to
  22 url-safe characters (`packId`), dates to six digits, times to epoch minutes, and read them back
  by shape. The state of a flow lives in the button, never in a table, so a coach who taps a week-old
  message still lands somewhere sensible.
- **A new button is a row in `e2e/controls.mjs` before it is anything else.** The controls suite
  posts every prefix the source emits and fails on one it does not know, which is how twenty-six new
  tap prefixes were caught in the first gate rather than by a coach whose button did nothing. Write
  the row (a packed id is 22 "A"s) the moment the prefix is typed.
- **Today may be over where the coach is.** A test that tapped the first day button got an empty
  time picker at 22:00 Bangkok, because "today" had no hours left. Pick the day after tomorrow in a
  test, and in the product show the day even when it is empty, with the way to type a time under it.

### Documents rot within hours

Ship the document change in the same pull request as the code. Twice in one day `ROADMAP.md` and
`AGENTS.md` described screens that had changed that morning, and the roadmap listed shipped work as
upcoming. If a change makes a sentence in `ROADMAP.md`, `docs/VISION.md`, `README.md`, `AGENTS.md` or
`docs/OPERATING.md` untrue, fixing that sentence is part of the change, not follow-up.

A rule in `docs/DECIDING.md` rots the same way. Rule 16 said the score nudge goes "exactly once per
match" and declined "a second nudge" for eleven days after the morning nudge shipped; the rule a
reviewer would quote said the opposite of what the cron did. When a change contradicts a rule, the
rule changes in the same pull request, with the owner's words that moved it.
