# AGENTS.md — working on Kicksmash with a coding agent

Kicksmash (kicksma.sh) is an open-source, agent-native padel match-up: create a match, share one link, people or their assistants join. Next.js 15 App Router, React 19, Drizzle + Postgres (PGlite locally), next-intl (en/ru/es), Tailwind v4, Vercel.

## Commands

```bash
pnpm install && pnpm dev          # http://localhost:3000, embedded PGlite, seeded PLAY and PAST matches
pnpm typecheck && pnpm lint       # must be clean
pnpm test                         # vitest on PGlite
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/kicksmash_test pnpm test   # the same on real Postgres; run it before pushing query changes
pnpm build && pnpm e2e            # Playwright journeys against a production build (E2E_ONLY=<suite> for one)
pnpm db:generate                  # after editing src/db/schema.ts; commit drizzle/
```

## Where things live

- `src/lib/domain/`: pure business rules, unit-tested, framework-free. New rules start here.
- `src/actions/`: server actions (validate → domain → revalidate → side effects in `after()`).
- `src/lib/api/`: the public REST API, MCP server, webhooks, OpenAPI and model-facing docs (`docs.ts`).
- `src/app/`: routes. `[code]` is a match, `g/[code]` a group, `v/[slug]` a venue board, `mcp` the MCP endpoint, `api/v1/*` the REST API.
- `messages/{en,ru,es}.json`: all copy, identical key sets (typed in `global.d.ts`).
- `tests/` vitest, `e2e/` Playwright suites.

## Rules that reviews enforce

1. **Never interpolate a `Date` into a raw `sql` template.** Use `gt(events.startsAt, now)` and friends. PGlite accepts a raw Date, postgres-js (production) does not.
2. **Every string in every locale.** Add keys to en, ru and es in the same change.
3. **Simplicity budget.** One job per screen; one primary action; anything optional goes behind the single "More options" section with a one-line summary. Nothing is offered before it can be useful.
4. **Email, push, Telegram are optional.** Everything must work with their environment variables unset.
5. **No accounts, no passwords.** Identity stays cookie + personal link (+ Telegram sign-in). Personal tokens and manage links are credentials: never log, never expose in public data.
6. **Public API shapes contain first names and levels only.** See `src/lib/api/serialize.ts`.
7. **Additive migrations.** Production applies them automatically; no drops without discussion.
8. **Sequential DB queries in server components** (the Supabase pooler stalls on pipelined bursts).
9. **Write copy from the user's side.** Active voice, short sentences, no jargon. Three languages.

## Agent-native surfaces (keep them in sync when the API changes)

`src/lib/api/openapi.ts`, `src/lib/api/docs.ts` (llms.txt, llms-full.txt, charter), `src/lib/api/mcp.ts` (tools), `src/app/developers/page.tsx`, `skills/kicksmash/SKILL.md`.
