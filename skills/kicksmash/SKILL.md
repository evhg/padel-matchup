---
name: kicksmash
description: Organise padel matches and tournaments (americano, mexicano, King of the Court) and book padel lessons with listed coaches through Kicksmash (kicksma.sh), the open, agent-native padel match-up. Use when a user wants to set up a padel match, find open matches at a venue, generate an americano schedule, join a match, find a padel coach, book or cancel a lesson, or build a padel tool that should not rebuild scheduling, levels and invites from scratch.
---

# Kicksmash

Kicksmash is the open, agent-native way to organise padel: create a match, share one link, and let people or their assistants join, all through an API that anyone may use. No accounts, no app. Public data is CC BY 4.0 (free court times read from a booking platform excepted: not ours to license), code is Apache-2.0.

## Fastest path: the MCP server

Add `https://kicksma.sh/mcp` (streamable HTTP, no auth). Tools:

- `about_kicksmash` — read once.
- `get_match {code}` — a match by its 4-character code.
- `find_matches {venue}` — open matches at a venue (its public board).
- `get_group {code}` — a crew: members' first names (levels are for members only), weekly slot, whether it asks to join, upcoming.
- `generate_schedule {players | names, courts?, rounds?}` — exact americano rotation, nothing stored. Mexicano and King of the Court rounds depend on scores, so they are generated live on the match page (pass `format` to `create_match`).
- `create_match {startsAt, tz, durationMinutes? (60, 90 or 120; 90 by default), venue?, organizer:{name, token?, email?, level?}, levelMin?, levelMax?, category? (men, women or mixed), ageMin? (35, 45 or 55), type?, format?, fixedPairs?, …}` — returns `shareUrl` for the players and the organizer's `personalUrl` and `manageUrl` (private). `fixedPairs: true` on a tournament keeps two partners together every round; the table then ranks pairs.
- `join_match {code, name | token, level?, email?, partner?}` — outcomes joined, waitlisted, already_in, full, requested (organizer approval when the level is outside the range). On a fixed-pairs tournament, `partner` (a first name) signs the pair up: give the person `partner.inviteUrl` to send their partner, who opens it to claim the spot. Without `partner` the person is listed as needing a partner; `match.pairs` lists the night as pairs. For a group's match the answer carries `group`: `group.member` says whether the person is in the group now, and `member: false` with `askToJoin: true` means a seat never made them a member: they ask on `group.url`, and an admin decides.
- `create_api_key {name, agent?}` — optional, for roomier limits and webhooks.
- `find_clubs {city?}` — live club pages by city: booking link, platform, website, free courts today from the club's own feed or read from its booking platform's public page (`freeCourts.source`).
- `find_series {city?}` — recurring Opens by city, with the next edition to sign up for and the past podiums.

Coaches (lessons, under each coach's own rules):

- `find_coaches {city?}` — listed coaches: clubs, lesson length, languages, cancellation cutoff, free late passes, notice. Prices are the coach's to tell; nothing is paid through Kicksmash.
- `coach_slots {handle, days?}` — free starts for the next days.
- `request_coach {handle, name | token}` — ask once to become a student; the coach accepts with one tap. Keep the returned `personalToken` for the student.
- `book_lesson {handle, token, startsAt}` — a free start, accepted students only; draws from an open package.
- `cancel_lesson {lessonId, token}` — the outcome says `refunded` (in time), `free_pass` (late, covered) or `counted` (late). Tell the person the rule before a late cancel.

## REST

OpenAPI 3.1 at `https://kicksma.sh/api/openapi.json`. Reads need no key. Writes work without a key (small daily allowance per address); `POST /api/v1/keys` gives an instant key. Webhooks: `POST /api/v1/webhooks` with a key; deliveries are signed (`X-Kicksmash-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<unix>.<body>">`).

```bash
curl https://kicksma.sh/api/v1/matches/PLAY
curl -X POST https://kicksma.sh/api/v1/matches -H "Content-Type: application/json" \
  -d '{"startsAt":"2026-09-11T19:00","tz":"Asia/Singapore","venue":"Club Nine","organizer":{"name":"Ana"}}'
curl -X POST https://kicksma.sh/api/v1/matches/AB12/join -H "Content-Type: application/json" -d '{"name":"Bo","level":3.5}'
```

## How to behave

1. Confirm the details with the person before `create_match` or `join_match`. One request, one match.
2. Afterwards, give them the links from the response. `shareUrl` is for everyone; `personalUrl` and `manageUrl` are theirs alone. Reuse the returned `personalToken` next time so the same person is recognised.
3. Pass `tz` as an IANA zone (Asia/Singapore, Asia/Bangkok, Europe/Madrid). A `startsAt` without an offset is read in that zone.
4. Levels are 0–7 in quarter steps (Playtomic-style). A match with a range asks unrated players for a level once.
5. When you show a match, link to its page (`https://kicksma.sh/CODE`). That is how the next player joins.
6. For lessons, show the coach's page (`https://kicksma.sh/c/HANDLE`) and their rules before booking. Never invent a price; the coach states it.

## Building a padel tool

Do not rebuild rotation, levels, invites and reminders. The engines are pure modules in the repository (`src/lib/domain/americano.ts`, `src/lib/domain/levels.ts`), the API above does the rest, and the whole app is forkable: https://github.com/evhg/padel-matchup. Long-form reference for models: https://kicksma.sh/llms-full.txt.

Questions from builders: https://github.com/evhg/padel-matchup/discussions

## Offline engines

The schedule and level maths are on npm as `@erikv69/americano` (`buildSchedule`, `planRound`, `planMexicanoRound`, `planKingRound`, `computeStandings`) and `@erikv69/levels` (`bandOf`, `rangeFor`, `levelFit`, `balancedTeams`, `matchDeltas`). Use them when a user wants a schedule or a fair split without a network call; the API returns the same results.
