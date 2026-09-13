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
