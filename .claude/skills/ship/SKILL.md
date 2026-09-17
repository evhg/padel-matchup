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
2. **Read the rule you are about to change.** `AGENTS.md` has the code map, the eleven rules reviews
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
`pnpm db:generate`, commit `drizzle/`, and apply the SQL to production **by hand** as `postgres`
through the Supabase MCP before the merge, with `SET LOCAL lock_timeout = '5s'`, the `GRANT` and the
two Row Level Security statements, and a row in `drizzle.__drizzle_migrations`. `pnpm db:push` is
disabled because it would drop the policies. This is AGENTS.md rule 7 and it has no exceptions.

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
- **Ask the database before describing blast radius.** A broken notification string was reported to the
  owner as having reached people's phones. There were zero clubs, so it had reached nobody. One query
  before the sentence.
- **Write the regression test with the fix, in the same pull request.** The test that catches a
  notification rendering as its own message key took twenty minutes, and was written after the bug
  rather than with the feature that introduced it.
- **Prove a new guard by breaking the code.** A check you have never watched fail is not a check. Put
  the bug back, watch it catch it, then restore.
- **A Date in a raw `sql` template is rule 1, and the local gate cannot see it.** PGlite accepts one
  and postgres-js throws `Received an instance of Date`, so the gate goes green and CI's real-Postgres
  run goes red twenty minutes later — which is exactly what happened to `coachBookContents`. Use
  `gt(lessons.startsAt, now)`; `tests/rules.test.ts` now fails on a bare `${now}`-shaped interpolation
  inside a `sql` template, so the gate catches it on the machine that wrote it.

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
- **Do the cheap true thing before the expensive one.** Counting rows in production took one query and
  changed what was worth building next more than an hour of reasoning would have.

### Editing that keeps going wrong

- **Never round-trip `messages/*.json`.** Loading and re-serialising reformats the compact single-line
  blocks and turns a three-key change into fifty-seven changed lines; a hand-rolled comma fix corrupted
  `en.json` once. Use `node scripts/i18n.mjs add <dotted.key> "<en>" "<ru>" "<es>"` — one line per file,
  refuses to overwrite, and proves the three locales still carry the same keys.
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

- **A new status value has two sides, and only one of them checks the status.** `left` closed the web
  door for a player who removes a coach, but the coach's Telegram assistant still recognised the name,
  and `bookLesson` with `byCoach: true` skips the student-status check on purpose — so the coach could
  book a lesson straight back onto the calendar of somebody who had just walked away. When a status says
  "this relationship is over", grep for every place the other side acts, and check each one for the
  branch that trusts the actor instead of the status.
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

- **Take the screenshot, then take it again.** The overflow above was fixed twice: the first fix
  looked right in the code and still ran off the screen, and only the second picture proved it. For
  anything visual, the picture is the check — `SHOTS=<dir> E2E_ONLY=<suite> pnpm e2e`, and remember
  `pnpm e2e` uses the build already on disk, so rebuild first.

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

### Documents rot within hours

Ship the document change in the same pull request as the code. Twice in one day `ROADMAP.md` and
`AGENTS.md` described screens that had changed that morning, and the roadmap listed shipped work as
upcoming. If a change makes a sentence in `ROADMAP.md`, `docs/VISION.md`, `README.md`, `AGENTS.md` or
`docs/OPERATING.md` untrue, fixing that sentence is part of the change, not follow-up.
