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
pnpm typecheck
pnpm lint
pnpm test         # vitest on embedded PGlite (TEST_DATABASE_URL=… runs the same suite on real Postgres)
pnpm build && pnpm e2e   # Playwright journeys against a fresh production build (first time: pnpm exec playwright install chromium)
```

CI runs exactly these. A green local run means a green PR.

## How the code is laid out

| Path | What lives there |
| --- | --- |
| `src/lib/domain/` | Pure business rules (events, slots, invites, americano schedule, identity, rate limits). Everything here is unit-tested and framework-free. |
| `src/actions/` | Server actions: validate input, call the domain, revalidate, send notifications with `after()`. |
| `src/app/` | Routes. `[code]` is the public match page, `p/[token]` the personal link, `admin` the read-only dashboard. |
| `src/components/` | UI. Client components stay small; data loading happens in server components. |
| `src/lib/notify.ts`, `src/lib/email/` | Every email the app sends, with calendar attachments. |
| `messages/*.json` | UI strings. All locale files must carry the same keys (`global.d.ts` types them). |
| `drizzle/` | SQL migrations. Generate with `pnpm db:generate`, never edit an applied migration. |
| `tests/`, `e2e/` | Vitest units and Playwright journeys. |

## Guidelines

- **Domain first.** New rules go into `src/lib/domain/` with a test, then get wired into an action and the UI.
- **Every string in every locale.** Add the key to `en.json`, `ru.json` and `es.json` in the same PR (machine translation is fine for a first pass, mark it in the PR).
- **Email is optional.** Any feature must work with `RESEND_API_KEY` unset, and push features with the VAPID keys unset.
- **No new accounts.** Identity stays cookie + personal link. Do not add passwords or OAuth.
- **Migrations are additive.** Production applies them automatically; a migration that drops or rewrites data needs a discussion first.
- **Keep the free tiers in mind.** Sequential database queries in server components, small payloads, no polling.
- **Never interpolate a `Date` into a raw `sql` template.** Use `gt(events.startsAt, now)` and friends. PGlite accepts a raw Date, postgres-js (production, and the CI Postgres job) rejects it. Run the suite against a real Postgres before pushing anything that touches queries: `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/kicksmash_test pnpm test`.

## Reporting bugs and ideas

Use the issue templates. For anything security-related, see [SECURITY.md](SECURITY.md) instead of a public issue.

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
