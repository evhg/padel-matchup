# Roadmap

What is built, and what comes next. The order follows the stakeholders in [docs/VISION.md](docs/VISION.md):
coaches, then players, then tournament organisers, then club operators. Every item here is a decision
for the owner before it is built, measured against [docs/DECIDING.md](docs/DECIDING.md).

The one number that says it works: **matches played per week**, across every channel and city.

## Built

Everything in this list is live. The README describes each in detail.

- **A match in one link.** `kicksma.sh/{code}`, no app, no account, no password. Four players, waitlist
  or hard close, atomic joins, reserved invites, activity feed, calendar invitations that update
  themselves, push reminders an hour before.
- **Cards in the chats where padel lives.** Telegram and Discord bots keep one card per match, edited in
  place, quiet by design: the card, a full line-up, the reminder, the result. One card algorithm with an
  adapter per channel (`src/lib/channels/`).
- **Tournaments.** Americano, mexicano and King of the Court, with live standings and an organiser who
  finalises. An Open repeats itself as a series.
- **Levels.** 0 to 7 in quarter steps, nudged by results, confirmed by whoever saw you play, drawn over
  time on a public passport and signed so it travels.
- **The coach's book.** A courtside assistant that answers students while the coach teaches: booking,
  cancelling under the coach's own cutoff and late-pass rules, packages that count themselves,
  waitlists that refill a freed slot, the coach's own calendar and sheet, their own payment link.
  Moving a lesson is **not** built: the only path today is cancel and book again. It is next.
- **Groups, venue boards, club pages.** A crew becomes a group with a weekly slot; a venue gets a board
  and a printable poster; a club claims its page, shows free courts from a feed it already has, and fills
  quiet hours from a weekly programme.
- **Open by default.** A public REST API with OpenAPI, an MCP server any assistant adds by URL, instant
  keys, signed webhooks, `llms.txt`, calendar feeds, npm packages, embeds and oEmbed. Data CC BY 4.0.
- **Three languages** with their own URLs, and pages that rank.
- **It runs itself.** A fact log behind every view, a listening desk, answer pages, a feedback door that
  reaches the owner with a verdict, production errors reported at first sight, nightly backups, an uptime
  probe and a service board against the free-tier ceilings.

## Next, in order

Decided 13 September 2026: **every stakeholder's experience made world class before a sixth channel.**
A new way to reach the same screens is worth less than making the screens right, and the stakeholder
whose experience is measurably broken is the first one in the vision. So the coach's book comes before
everything that was on this list, and LINE moves behind it.

1. **The coach's first week.** Setup that leaves a working assistant: hour presets instead of a grid
   pre-filled eight to eight six days a week, a price and the payment methods the coach accepts, the
   sheet import inside the walk, blocking time from the coach's own grid, and a walk that ends on the
   link they hand their students. The Google Calendar step leaves setup: it cannot be completed in the
   Google Calendar phone apps at all, so most coaches were never going to finish it.
2. **The three messages still reaching the coach's phone.** Moving a lesson, which does not exist today;
   what a student owes and how to pay it, with the coach confirming; and one door instead of two for a
   new student. Plus a notice that reaches a coach who never bound the Telegram bot, since today every
   student-initiated event reaches them there or nowhere.
3. **Nobody is told.** A club's programme match is created and announced to no one, unlike the group
   matches made in the same cron tick. A missing score gets exactly one nudge, ever, and a match without
   one moves no level, enters no ranking and records no podium.
4. **Drop-out refill.** A spot that opens goes by push to level-matched players who play with that crew or
   at that club. The highest-value item on this list — it answers a player pain and two club pains with
   one mechanism, and every ingredient already exists unjoined. It waits only because it needs players
   with push enabled, which the coach work helps build.
5. **LINE, with LINE sign-in and Thai copy.** Thailand first, so the channel Thai players actually use.
   The card algorithm is already shaped for it: a platform that cannot edit a sent message re-sends only
   when the roster changes, and a reply is free where a push is metered. See "Adding a channel" in
   [AGENTS.md](AGENTS.md).
6. **Demand signals.** "I want to play Tuesday at 14:00 near Rawai", recorded as a fact and matched to
   open matches and quiet courts. Demand has to be recorded, not only supply. Behind the refill above,
   because a signal with nobody to match it against records nothing.
7. **The club's view of its coaches.** Lessons per week on its courts and who teaches there. The club sees
   and does not control: no approval, no terms. Needs a coach's clubs to be venue slugs rather than free
   text, and needs a lesson to carry a venue at all, which it does not today.
8. **The serious tournament.** What Thailand's top organisers and FIP run: pairs registered per category,
   a group stage then a knockout, a consolation draw, a qualifying draw into a main draw with seeds,
   scoring set per phase, the draw published, courts scheduled, scores live per court. This is a second
   engine beside the rotation engine, not a feature on top of it, and deserves its own decision.
9. **Courts as capacity, then a court a person can hold.** Light booking for a club with no system:
   matches and lessons occupy a court, a person holds one with a name and a cancellation rule. No payment
   passes through Kicksmash.
10. **Performance analytics by integration.** Shots, positioning and workload from smartwatch and camera
    integrations, with the player's consent. A match will carry sensor sessions.
11. **WhatsApp**, when WhatsApp allows more than links and previews.

## Deliberately not

- **No accounts, no passwords**, for players, coaches or clubs. A coach is a player with a role.
- **No money through Kicksmash.** No payments, no commissions, no marketplace.
- **No paid tiers** while the free plans hold. Free for every stakeholder, for good.
- **No loud bots.** No bumps, no nags, nothing about Kicksmash beyond the card's footer.
- **Nothing closed.** The API, the data and the code stay open, and every crawler is welcome.

## Parked

- **WhatsApp Channels**, which need a person on a phone to post, and there is no staff.
- **Twilio and SMS**, which need template approval and a verified business.
- **Court booking integrations** with the platforms, beyond recognising the link and reading a feed a club
  chose to share.
- **Player reliability and no-show stats**, which would rank people by their worst days.
