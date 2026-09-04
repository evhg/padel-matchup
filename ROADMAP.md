# Roadmap (not built in v1)

v1 is deliberately links + email only. Everything below was considered and parked.

## 1. Telegram bot + Mini App
Fully specced in the v1 draft, parked to ship tonight.
- Auto-identity from Telegram user id (no name entry).
- DM notifications to players and organizers; automated invite reminders.
- Inline confirm / decline buttons on invites.
- Mini App wrapping `/{code}` with `initData` auth.

## 2. Americano engine — shipped
Rotating-partner rounds, fair sit-outs, per-match points by any participant, live standings, organizer finalize. Still open:
- Mexicano variant (pairings by current standing instead of rotation).
- Printable / big-screen round sheet for the club TV.
- Head-to-head tie-break beyond points → diff → wins.

## 3. WhatsApp Business API (Twilio) + SMS fallback
- Automated invite/reminder messages instead of one-tap forward buttons.
- Requires template approval and a verified business; not worth blocking v1 on.

## 4. Quality of life
- Recurring matches (quick picks already learn the organizer's usual slots) ("every Thursday 18:00") with auto-created events and rolling invites. ("Play again next week" one-tap clone is shipped.)
- Player reliability / no-show stats, surfaced in the rolodex.
- Court booking integrations (Playtomic et al.).
- Push notifications: the 1-hour reminder is shipped (Web Push, Supabase pg_cron every 5 min). Next: "a spot opened up" and "line-up complete" pushes, organizer pings when players join.
