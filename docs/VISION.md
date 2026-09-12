# Kicksmash: the vision by stakeholder

Kicksmash is the padel layer that lives inside the chats where padel already happens. One link organises a match; a card does it in Telegram, LINE or Discord; a coach's book runs itself; a club's quiet hours fill. No app to install, no account, nothing paid through us. Decided with the owner on 12 September 2026; this file is the yardstick for the roadmap, and `docs/DECIDING.md` is the yardstick for each request.

## Who it serves, in order

When two needs conflict, the earlier one wins.

1. **Coaches.** The pain is the messages: cancelling, rescheduling, "how many lessons do I have left". The promise is a book that answers students while the coach teaches and moves lessons without anyone typing. A coach is won when a student books, moves or cancels a lesson and the coach typed nothing.
2. **Players.** The pain is organising: who is in, when, where, at what level, who fills the spot that opened. The promise is a match organised in under ten seconds, inside the group chat, with the app complementing the messenger and never replacing it. A player is won when the match is played.
3. **Tournament organisers.** The promise is a free, world-class tool that looks great and runs an americano, a mexicano or a King of the Court from a phone, smoothly for the organiser and for every player. An organiser is won when the standings are live and nobody asked for a spreadsheet.
4. **Club operators.** The pains are quiet courts at off-peak hours, no view of the coaches teaching on their courts, a community that lives in other people's chats, newcomers with nobody at their level, last-minute drop-outs, and booking systems and channels that do not talk to each other. The promise is a page and a programme that fill the quiet hours, a view of the coaches, level-matched newcomers, drop-outs absorbed, and one place that links to whatever booking system the club has. A club is won when an off-peak court hour is filled by a match or a lesson from Kicksmash.

## The bet

Free for every stakeholder, for good. The value is the data and the channels: Kicksmash owns the way to reach players, coaches, clubs and organisers, and it owns the record of what happens on the courts.

## The data Kicksmash owns

- **The level.** A dynamic skill rating moved by results and opponent quality, confirmed by people who saw you play. It is the single most important number for retention: it prevents mismatched games. It exists today (0 to 7, Elo-style nudges, verified levels) and stays the centre.
- **The padel graph.** Who plays with whom, where, when, in which crews. Clusters of friends are how empty spots get filled.
- **Court demand and utilisation.** When people want to play, where courts sit empty, by day and hour. Demand must be recorded, not only supply.
- **Coach books and retention.** Lessons, packages, cancellations, reschedules, and how long a student stays with a coach.
- **Behaviour.** How often a person plays, when a previously active player stops, what is spent where a cost is named (court, lesson package, tournament entry). Read as churn risk and lifetime value, never shown as such to the person.
- **Performance analytics.** Shots, positioning, workload, from smartwatch and camera integrations, within twelve months, with the player's consent. Not built now; the data model leaves room for a match to carry sensor sessions.

The architecture that serves all six: one append-only log of facts (what happened, who did it, through which channel, about which match, lesson, club or coach, in which city). Every view above is a query over it. Nothing personal leaves it: public data stays first names and levels.

## The channels Kicksmash owns

- **Bots inside messengers.** Telegram and Discord today, LINE first among the next, WhatsApp when WhatsApp allows more than links and previews. One card per match, edited in place where the platform allows, quiet by design.
- **Push and email to every stakeholder.** Reminders, offers, wraps and digests from Kicksmash itself, each with the person's own switch.
- **The API and the MCP server.** Any assistant can create, join and book; every crawler is welcome; the surfaces are kept in sync by tests.
- **Pages that rank.** City, club, coach and series pages that bring a searching player to Kicksmash rather than to a platform. Recommended and kept: the pages exist, the cost is a little SEO per page type.

## Where first

Thailand, then Singapore. Thai joins English, Russian and Spanish; LINE is the first new channel; PromptPay stays the way a coach is paid, outside Kicksmash.

## Rules that stay

- No accounts and no passwords for anyone: a coach or a club is a player with a role, reached by their links and by chat sign-in.
- Nothing is paid through Kicksmash. A coach's PromptPay or link is shown; "paid" is a note.
- Bots stay quiet: one card, edited in place, new messages only for the card, a full line-up, the reminder and the result.
- The club sees its coaches and does not control them: lessons per week on its courts, who teaches there, no approval and no terms.
- Light booking for a club with no system: courts as capacity, matches and lessons occupy a court, and a person may hold a court with a name and a cancellation rule. No payment.

## The north star

**Matches played per week**, across every channel and city, the first line of the Sunday digest. Behind it, one number per stakeholder: lessons booked without a message, tournaments finalised, off-peak court hours filled.

## What this changes in the build

- A fact log is added before the channel work, so every channel records what it did from day one.
- The channel adapter is shaped for LINE: a card that cannot be edited is re-sent only when the roster changes, replies are free and pushes are budgeted, LINE sign-in joins Telegram sign-in.
- A coach's clubs become venue slugs instead of free text, so a club can see its coaches without guessing.
- The schema leaves room for court capacity, court holds and sensor sessions; none is built until the owner says so.
- Thai becomes the fourth locale when the LINE channel ships.

## After the restructure

Candidates, each a decision for the owner, in the order the stakeholders above suggest:

1. LINE channel with LINE sign-in, and Thai copy.
2. Demand signals: "I want to play Tuesday at 14:00 near Rawai", recorded as facts and matched to open matches and quiet courts.
3. Drop-out refill: a spot that opens goes by push to level-matched players who play with that crew or at that club.
4. The club's view of its coaches.
5. Courts as capacity, then a court a person can take.
6. Performance analytics by integration, with consent.
7. WhatsApp, when it allows more than links and previews.
