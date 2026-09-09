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
10. **Every table is locked.** Supabase serves `public` through its Data API; Kicksmash never uses it and connects as the role `kicksmash`. Every table has Row Level Security on and one policy (`app`) for that role; a new table adds the same two statements to its migration (see `drizzle/0029_rls_everywhere.sql`) or `tests/rls.test.ts` fails. Production migrations run as `postgres` through the Supabase MCP before the merge, with `GRANT ALL ON TABLE … TO kicksmash`; the API roles (`anon`, `authenticated`) hold no privileges on `public`.

## Agent-native surfaces (keep them in sync when the API changes)

`src/lib/api/openapi.ts`, `src/lib/api/docs.ts` (llms.txt, llms-full.txt, charter), `src/lib/api/mcp.ts` (tools), `src/app/developers/page.tsx`, `skills/kicksmash/SKILL.md`. Coach endpoints and tools share `src/lib/api/coachOps.ts` (find, slots, request, book, cancel), which calls the same domain functions as the coach pages and the Telegram assistant.

## Coaches

`src/lib/domain/coaching.ts` (coaches, students, packages, lessons, blocks, slots, the cancellation policy), `src/lib/coach/` (`assistant.ts`: the one-line parser for coaches and students in three languages, pure; `strings.ts`: what the assistant says, en/ru/es; `notify.ts`: DMs, offers, reminders, ICS emails; `chains.ts`: waitlists with thirty-minute offers, the reschedule chain after any cancellation, requests outside the hours, reminders, the manager link, month counts; `gcal.ts`/`ical.ts`/`sync.ts`: the coach's own calendar by sharing with the service account or an iCal link; `import.ts`: the package sheet in one paste), `src/lib/telegram/coach.ts` (the courtside assistant), `src/actions/coach.ts`, pages under `src/app/coach`, `src/app/c/[handle]` and `src/app/coaches/[city]`. Rules: DECIDING 11–17. After the match: `src/lib/afterMatch.ts` (the score nudge to every player, moments announced), `src/lib/domain/praise.ts`, `src/lib/domain/milestones.ts` (earned moments, awarded once from the central `match.result` hook in `src/lib/api/webhooks.ts`), `src/lib/domain/photos.ts` (the court photo behind the result card; the card's picture route renders it), `src/app/m/[id]` (a moment's page and picture). Rules: DECIDING 16–18. Every cancellation path ends in `afterLessonFreed`; new write paths must call it. Listing is opt-in (`isPublic`); public data never carries a phone, an email or a payment id.

## Telegram bot

`src/lib/telegram/` is the whole bot: `api.ts` (Bot API calls, Login Widget and Mini App signature checks, inline mode), `card.ts` (the one card per match, en/ru copy), `parse.ts` (the one-line `/new` grammar in both languages, pure), `login.ts` (the same-tab web sign-in), `bot.ts` (updates, the tap-through `/new`, result taps, notices, the private-chat console, inline cards, card sync, reminders, result). It is quiet by design: joins and leaves edit the card; new messages only for the card, a complete line-up, the reminder, the result, and private notes for a time change or cancellation. Every change funnels through `emitMatchEvent` in `src/lib/api/webhooks.ts`, which also refreshes the cards (group and inline), posts group matches into tied chats and sends the notices, so new write paths need no Telegram code of their own. The Mini App shell is `/tg` + `/api/telegram/miniapp`. Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`, optional `TELEGRAM_MINIAPP_SLUG`; tests stub `fetch`.

## Discord bot

`src/lib/discord/`: `api.ts` (REST calls, the Ed25519 interaction check, markdown escape), `card.ts` (the embed and buttons; copy shared with the Telegram card), `bot.ts` (slash commands, buttons, card sync, reminders, result; channel tickets for `/new`), `listen.ts` (the hourly read of new messages in the servers the bot is in, the in-server prompt, replies without a tap because it is our own community). HTTP interactions only, no gateway. Routes: `/api/discord/interactions` (signature or 401) and `/api/discord/setup` (commands, interactions URL, message-content flag, install link). Env: `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, optional `DISCORD_INVITE_URL`; tests stub `fetch`.

## Clubs and booking

`src/lib/domain/clubs.ts` (claim, approve, edit by manage token, founding badge per city, listing) and `src/lib/booking/` (`platforms.ts`: recognise a booking platform from a link; `availability.ts`: free courts from a club's own `.ics` bookings feed or JSON free-slot list, hourly refresh). Rows in `clubs` exist only for claimed clubs; unclaimed venues render from their matches as before. The owner approves each claim from Telegram (`ca:`/`cr:` callbacks in `src/lib/telegram/bot.ts`); public pages and the API show a club only while `approvedAt` is set and `rejectedAt` is not. Adding a booking platform is one entry in `PLATFORMS`; adding an availability adapter is one branch in `refreshClubAvailability` plus a pure parser with tests. Never store club credentials; feeds are public URLs the club chose to share.

## Passport

`src/lib/domain/passport.ts` is pure (WebCrypto Ed25519, canonical JSON, base64url) and ships inside `@erikv69/levels`; `src/lib/domain/profile.ts` holds the opt-in public page (`publicProfile`, `publicSlug` minted once), stats from a player's finished matches, `issuePassport` and the data export. Public pages are off by default and never listed anywhere; the export never contains tokens or manage codes. Keys: `PASSPORT_PRIVATE_KEY` and `PASSPORT_PUBLIC_KEY` (raw hex); the public key is served at `/.well-known/kicksmash-passport.json`. Other apps' level scales live in `LEVEL_SCALES` in `levels.ts` with the mapping shown on `/levels`; add a scale there, never in a component.

## Listening desk

`src/lib/listen/`: `parse.ts` (feeds → candidates, relevance gate, language guess; pure), `sources.ts` (the feeds, polite fetch), `draft.ts` (one Messages API call per candidate with a strict JSON contract and daily budgets counted in `metrics_daily`), `reddit.ts` (posting an approved comment), `tick.ts` (the hourly loop: remember, gate, draft, ask the owner on Telegram, approve, expire), `answers.ts` (approved replies become /answers pages; the Sunday digest with Unpublish buttons). The tone rules live in `SYSTEM_PROMPT` in `draft.ts` (public places) and `DISCORD_PROMPT` in `src/lib/discord/listen.ts` (our own server); the feature list both quote is `PRODUCT_FACTS`. Nothing is posted to Reddit or Hacker News without the owner's tap; keep it that way.

