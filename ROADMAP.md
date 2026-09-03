# Roadmap (not built in v1)

v1 is deliberately links + email only. Everything below was considered and parked.

## 1. Telegram bot + Mini App
Fully specced in the v1 draft, parked to ship tonight.
- Auto-identity from Telegram user id (no name entry).
- DM notifications to players and organizers; automated invite reminders.
- Inline confirm / decline buttons on invites.
- Mini App wrapping `/{code}` with `initData` auth.

## 2. Americano engine
Schema stubs already exist as comments in `src/db/schema.ts` (`tournament_rounds`, `tournament_scores`).
- Rotating-partner round generation for N players / M courts.
- Per-round score entry by any player, live standings, tie-breaks (games diff → head-to-head).
- Replaces the v1 "final standings" single entry.

## 3. WhatsApp Business API (Twilio) + SMS fallback
- Automated invite/reminder messages instead of one-tap forward buttons.
- Requires template approval and a verified business; not worth blocking v1 on.

## 4. Quality of life
- Recurring matches ("every Thursday 18:00") with auto-created events and rolling invites.
- Player reliability / no-show stats, surfaced in the rolodex.
- Court booking integrations (Playtomic et al.).
- Push notifications via web push once identity is stable across devices.
