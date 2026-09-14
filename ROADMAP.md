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
  moving and cancelling under the coach's own cutoff and late-pass rules, packages that count themselves,
  waitlists that refill a freed slot, the coach's own calendar and sheet. Setup is six taps — where they
  teach, how long a lesson runs, mornings or afternoons, the price and which of PromptPay and pay-at-the-club
  they accept, how they want to hear about it — and ends on the link they hand their students. Money is
  tracked, never processed: the student says they have paid, the coach confirms it, and unpaid warns
  rather than blocks.
- **A spot that opens finds somebody.** A dropout nobody was waiting for goes by push, once, to the
  crew's other members and to the players who play at that club — level-matched, capped, and only while
  there is still time to get to the court. A private match with no crew tells nobody.
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
whose experience was measurably broken is the first one in the vision. The coach's three pieces — a
setup that leaves a working assistant, the messages still reaching the coach's phone, and the events
that told nobody — landed that day, and drop-out refill the same afternoon. All four are under Built
above.

Reordered 14 September 2026, after two corrections. WhatsApp was written down as a coach's assistant
and nothing more; that conclusion came from proving the bot cannot sit in a group somebody else made,
which is true and says nothing about reaching a player one-to-one, which works. And demand signals
moved ahead of both remaining channels: finding a fourth is the thing a player cannot do in the app
today, and the counts say the channels are ahead of their audience — of 26 players, one has Telegram
linked and four have an email address.

1. **Finish Telegram: the coach's setup and settings.** Where they teach, how long a lesson runs, the
   hours, the price, the cutoff and late passes, who manages the page. These are the last things that
   force a coach out of the chat and onto the web, and a new coach meets them before anything else.
   Two of this item's original four parts are done: moving a lesson and payment status both work in
   the chat now. The third was never true — `/new tomorrow 19:00 Rawai` has always created the match
   outright, and a bare `/new` is three taps; the web form is an escape hatch beside them, not the
   path. Checked against the handler, not against this file.
2. **Demand signals.** "I want to play Tuesday at 14:00 near Rawai", recorded as a fact and matched to
   open matches and quiet courts. Demand has to be recorded, not only supply. It waited on the refill,
   which is now built: a signal with nobody to match it against records nothing.
3. **WhatsApp, one-to-one, for players and coaches.** A private thread carries the whole of a player's
   loop: reply buttons to take or give up a spot, a list message to pick a time, Flows for a form the
   Mini App cannot match, the court as a map pin, a template for a reminder outside the window. The
   group part is carried by a person rather than a bot — the organiser pastes a link into the crew's
   chat, and each tap opens a conversation the player started, which is free, opens a 24-hour window,
   and is not counted against the 250-a-day limit, because that limit rations only the messages we
   start. That first message also hands over the phone number with permission, so nothing has to be
   collected in advance. Explicitly **never** a card channel: Meta's Groups API only makes its own
   groups, invite-only, capped at eight, and needs an Official Business Account. What is lost is real
   and worth saying: nobody sees "three of four" without tapping, and the group cannot enter a score.
   A separate adapter — the `CardChannel` interface does not fit and must not be bent to it.
4. **LINE, with LINE sign-in and Thai copy.** Thailand first, so the channel Thai players actually use.
   The card algorithm is already shaped for it: a platform that cannot edit a sent message re-sends only
   when the roster changes, and a reply is free where a push is metered. See "Adding a channel" in
   [AGENTS.md](AGENTS.md).
5. **The club's view of its coaches.** Lessons per week on its courts and who teaches there. The club sees
   and does not control: no approval, no terms. Needs a coach's clubs to be venue slugs rather than free
   text, and needs a lesson to carry a venue at all, which it does not today.
6. **The serious tournament.** What Thailand's top organisers and FIP run: pairs registered per category,
   a group stage then a knockout, a consolation draw, a qualifying draw into a main draw with seeds,
   scoring set per phase, the draw published, courts scheduled, scores live per court. This is a second
   engine beside the rotation engine, not a feature on top of it, and deserves its own decision.
7. **Courts as capacity, then a court a person can hold.** Light booking for a club with no system:
   matches and lessons occupy a court, a person holds one with a name and a cancellation rule. No payment
   passes through Kicksmash.
8. **Performance analytics by integration.** Shots, positioning and workload from smartwatch and camera
   integrations, with the player's consent. A match will carry sensor sessions.
9. **WhatsApp in a group chat**, if Meta ever lets a business into a group somebody else made. Today it does not, at any tier.

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
