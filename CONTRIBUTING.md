# Contributing to Kicksmash

Thanks for helping people play more padel. Small, focused pull requests are the fastest way in.

## Set up

```bash
pnpm install
pnpm dev          # http://localhost:3000, embedded PGlite database, seeded example matches
```

No accounts or keys are needed. Copy `.env.example` to `.env` only when you want real email, push or a hosted Postgres.

## Before you open a pull request

```bash
bash scripts/gate.sh              # typecheck, lint, schema vs migrations, the unit suite (well under a minute)
GATE_E2E=core bash scripts/gate.sh   # the same, then a production build and one browser suite
```

The gate is what CI's first job runs, in the same order. For the browser journeys:

```bash
pnpm build && pnpm e2e   # every suite against a fresh production build (first time: pnpm exec playwright install chromium)
```

CI adds one thing the gate does not: the unit suite a second time against a real Postgres, where a `Date`
in a raw `sql` template fails and PGlite would have let it pass. A green gate plus a green `pnpm e2e`
means a green pull request.

## How the code is laid out

| Path | What lives there |
| --- | --- |
| `src/lib/domain/` | Pure business rules (events, slots, invites, americano schedule, identity, rate limits). Everything here is unit-tested and framework-free. |
| `src/db/schema/` | The tables, one file per domain, re-exported from `index.ts`. A new table goes in the file for its domain. |
| `src/lib/channels/` | One card algorithm (post, edit, remind, result) with Telegram and Discord as adapters over it. A new channel is one adapter plus one line in the registry. |
| `src/actions/` | Server actions: validate input, call the domain, revalidate, send notifications with `after()`. |
| `src/app/` | Routes. `[code]` is the public match page, `p/[token]` the personal link, `admin` the owner-only desks (the service board, the listening desk, the press desk). |
| `src/components/` | UI. Client components stay small; data loading happens in server components. |
| `src/lib/notify.ts`, `src/lib/email/` | Every email the app sends, with calendar attachments. |
| `messages/*.json` | UI strings. All locale files must carry the same keys (`global.d.ts` types them). |
| `drizzle/` | SQL migrations. Generate with `pnpm db:generate`, never edit an applied migration. |
| `scripts/` | `gate.sh` (the pre-push gate), `check-migrations.sh` (schema versus migrations), `gen-docs.mjs` (the environment table). |
| `tests/`, `e2e/` | Vitest units and Playwright journeys. |

## Guidelines

- **Domain first.** New rules go into `src/lib/domain/` with a test, then get wired into an action and the UI.
- **Every string in every locale.** Add the key to `en.json`, `ru.json` and `es.json` in the same PR (machine translation is fine for a first pass, mark it in the PR).
- **Email is optional.** Any feature must work with `RESEND_API_KEY` unset, and push features with the VAPID keys unset.
- **No new accounts.** Identity stays cookie + personal link. Do not add passwords or OAuth.
- **Migrations are additive.** A migration that drops or rewrites data needs a discussion first. Production does **not** apply them automatically: each one is applied by hand before the merge (AGENTS.md rule 7), because the app's own auto-migrate connects as a role that cannot own the Row Level Security statements. `pnpm db:push` is disabled on purpose. `bash scripts/check-migrations.sh` fails when a table in `src/db/schema/` changed without the migration that carries it.
- **Keep the free tiers in mind.** Sequential database queries in server components, small payloads, no polling.
- **Simplicity budget.** One job per screen, one primary action, at most seven visible controls above the fold on a phone. Anything optional goes behind the single "More options" section with a one-line summary of what is set. Features appear when they can be useful (groups after matches, rankings after results), not before.
- **Keep the agent surfaces in sync.** A change to the API or the product means updating `src/lib/api/openapi.ts`, `src/lib/api/docs.ts`, the MCP tools in `src/lib/api/mcp.ts`, `/developers` and `skills/kicksmash/SKILL.md` in the same pull request.
- **Tests never depend on the calendar.** A unit test that pins a date calls `freezeClock()` from `tests/helpers/clock.ts`; a browser suite computes every date from the moment it runs. A suite that passes on a Tuesday and fails on a Saturday is the bug this prevents (AGENTS.md rule 11).
- **Every table is locked.** A new table adds Row Level Security and one `app` policy for the `kicksmash` role in the same migration (AGENTS.md rule 10).
- **Public API shapes carry first names and levels only.** `tests/rules.test.ts` proves it from rows that hold every secret a row can hold.
- **Never interpolate a `Date` into a raw `sql` template.** Use `gt(events.startsAt, now)` and friends. PGlite accepts a raw Date, postgres-js (production, and the CI Postgres job) rejects it. Run the suite against a real Postgres before pushing anything that touches queries: `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/kicksmash_test pnpm test`.

## Reporting bugs and ideas

Use the issue templates. For anything security-related, see [SECURITY.md](SECURITY.md) instead of a public issue.

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
