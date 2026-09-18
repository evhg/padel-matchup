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
  they accept, how they want to hear about it — and ends on the link they hand their students. That
  channel step is the one step a coach cannot walk past: Telegram, an email or this phone, at least one
  of whatever the deployment runs. It used to offer Telegram alone and escape through a button reading
  "Email me instead" that collected no address, so a coach could finish with nothing and run a book
  that never told them anything. Every lesson now reaches the coach's own calendar as well, as the
  same invitation the student has always had — one tap on a phone, where sharing a Google calendar
  with a service account cannot be done at all. Money is
  tracked, never processed: the student says they have paid, the coach confirms it, and unpaid warns
  rather than blocks. All of it works in Telegram as well as on the web: three taps set a book up —
  city, lesson length, when you teach — and after that it is one line at a time (`price 800`,
  `hours mornings`, `move anna fri 15`, `unpaid`, `settings`).
- **What a player wants, recorded.** "Tuesdays around two at Rawai", said once on their own page or
  as `/want tue 14 Rawai Padel` in the chat. A match that fits finds them within the hour, and a seat
  that opens goes to whoever asked for that hour before it goes to the crew or the club's regulars.
  Loose on purpose — a day or none, an hour or none, a court or a city — because a want that has to be
  exact is a booking, and bookings already work. It expires after a month and dies with the account.
- **A spot that opens finds somebody.** A dropout nobody was waiting for goes by push, once, to the
  crew's other members and to the players who play at that club — level-matched, capped, and only while
  there is still time to get to the court. A private match with no crew tells nobody.
- **What a club sees of the coaching on its courts.** Who teaches here and how many lessons they gave
  in the last seven days, on the club's own page. The club watches: no approval, no terms, no money,
  and nobody's student named. Two things had to be true first — a lesson now records where it happens,
  and a coach's clubs answer to the same slug a match and a club page use, so "warehaus" and
  "Warehaus" stopped being two different places.
- **Groups, venue boards, club pages.** A crew becomes a group with a weekly slot; a venue gets a board
  and a printable poster; a club claims its page, shows free courts from a feed it already has, and fills
  quiet hours from a weekly programme.
- **Every padel club in Thailand and Singapore, listed.** 67 clubs from public sources — 40 in Thailand
  across eight provinces, 27 in Singapore — with the indoor and outdoor court split where a source said
  it, which is also the first capacity number the app has. Where two sources disagree the club's own
  page wins, and where nothing settles it the count stays null. A listing says who a club is and nothing
  about who runs it: it is nobody's claim, it never queues for approval, and it never counts as a club
  joining. When the real owner claims it, the listing becomes theirs and the file stops being the truth
  about it. A club people already play at keeps the slug their matches carry, so claiming "WAREHAUS.club"
  takes over `warehaus` rather than opening a second page with none of the history on it. The file is
  `data/clubs.json`, re-imported by one statement that only ever touches rows nobody has claimed.
  A club that opens next month will not be on the web for a while, but the first people to play there
  type its name into a match that week, so the owner's weekly digest names every court people used
  that Kicksmash does not list. That, and a club claiming its own page, are how the list grows.
- **Picking where you play.** The list answers before it is read: the courts you have used and the
  clubs you teach at, then the clubs in your own province, then the rest of your time zone, then
  everywhere else, under a heading per country and province. Six at rest, the whole directory once a
  letter is typed. Picking a club fills the map link and offers its courts as a list of numbers. A club owner picks their club from the same list
  rather than retyping its name, and a coach names where they teach from it. Whatever is picked lands
  on the club's own page — "WAREHAUS.club" is the club at `warehaus`, not a second page made from its
  name — and that holds wherever a venue is written, the chats and the API included.

- **Leaving a coach.** A coach's door on My matches ("Book more · Ricardo") comes from their student
  list, so until now only the coach could take it away: a player who took one lesson and moved on
  carried that door for good. It is one line at the bottom of the coach's own page now. The row stays,
  so the lessons taken and anything still owed stay on the coach's book — leaving does not take a debt
  off their screen — and the coach sees "Left" rather than a student who quietly vanished. A lesson
  still to come refuses it, the same rule a coach meets when closing a book, and coming back is the
  same two taps as joining was.

- **The desk reaches the person, and the directory keeps its word.** A note from the in-app form
  carried only a player id, so the one sentence DECIDING.md promises — what changed — reached nobody:
  Erik's two notes were fixed and he never heard. The desk now reaches a player the way every lesson
  notice does, Telegram first, then email, then this device. When the assessor's daily budget is spent
  the owner's Telegram says the note is queued for the next session, which reads the desk first,
  rather than "no analysis". And a coach with no lesson in sixty days leaves the public directory and
  the club page's coach list by the same rule that took their door off a student's screen; their page
  still opens by link and stays in the sitemap, and the first lesson they book puts them back.

- **The coach can see money.** Erik's test: Alicia booked, said she paid, and the coach's screens
  showed none of it — "no package" on the lesson, "Owes 3000 THB" on the student with no tap under it,
  and the "says paid" notice already scrolled away. Every lesson with a price now carries it on the
  coach's row: not paid, says paid, or paid, with **Mark paid** beside it, and the students screen
  lists each unpaid lesson under the figure it adds up to. A student can attach the bank slip every
  Thai banking app produces; attaching it is the claim, and the coach opens it from the row. A
  student picks how many are coming when the coach has group prices, and sees what each pays. And
  "on me" over "I already paid" — the one collision that costs a friendship — is refused when the
  coach marked it paid, and asked once when the student merely says so.

- **Eight things Erik tripped on, fixed on the screen they happened on.** A no-show tapped by accident,
  or to see what the button does, or on a student who was only late, has **They came after all** on
  the same row; the lesson goes back to done and keeps its package lesson and its price. Pausing a
  student dimmed the whole row, so "Resume bookings" read as a disabled button: the dimming sits on
  the text now and the resume button is the dark one. The student's name on the book opens their row
  on the students screen. "Who runs your lessons with you" became a folded question, "Does someone
  else take your bookings?", with a lead that says who the helper is and what they can do. The one
  true sentence under "Your calendar" reads as body text, and every rem on a desk over 1280px is a
  point larger. A coach changes what a lesson or a package costs — a tip, a rounding, a weekend at
  double rate — with ✎ on the row. And "More" is gone: the three other screens are three buttons
  above the book, and the link, the share buttons and the QR live on the students screen, where a
  student is added.

- **Benji's card, in the book.** A coach's price card at the desk says 60 and 90 minutes, each with a
  price for one and for a pair; ten-lesson packages for one or for two; and 300 more for a lesson
  outside working hours. Every line of it is sayable now, in the setup walk behind three one-line
  folds and in settings, and the book charges it: a second lesson length with its own two prices,
  which a student picks with the free times of that length; an extra outside the weekly hours, added
  to a request the coach said yes to, an hour they opened, or a package lesson, which then owes just
  the extra; and up to three packages on the coach's page, which a student takes with one tap — the
  package starts unpaid at the offer's price, the coach hears, and the student sees the figure and the
  ways to pay on the same screen. A pair package books pairs. Prices stay what each person pays; the
  screen shows what the pair pays together beside it, because that is the number on the card.

- **The coach's screens say what they do.** Erik's first pass through the coach walk found match
  wording living inside it: "calendar invite on its way" and "email me when the line-up changes" on
  the channel step, "remind me 1 hour before each match" on the push switch, and "This phone" on a
  desk. Each was a shared component carrying another screen's promise. The walk now asks the notice
  hours — how close to the hour a student may still book — because that is personal and used to be
  found in settings weeks later. Settings now carry every price the walk asked, say what a second
  club does to the club page, and the calendar section leads with the one thing already true: every
  lesson reaches the coach's calendar by email. Sharing a Google calendar is a fold with its benefit
  as the title. "at Warehaus" on a coach's page is the door to the club's page, which lists its
  coaches and its open matches.

- **An hour outside the week.** The weekly template says what a normal week looks like, and a block
  already took one hour of one date back. Now a coach can add one the same way: type a time on their
  book and open it, and that Sunday evening is bookable without anybody else's Sunday moving. It
  undoes to whatever the template says. A block still wins, because taking an hour back is the
  stronger word.

- **What a lesson costs, and giving one away.** A coach sells one-off lessons or only packages, and
  says so with a switch rather than by leaving a field empty. Behind one line, "I also teach pairs and
  groups" asks three more prices: **what each person pays** at two, three and four, never the court
  total, so the book keeps one debt per student and nobody divides 1200 by three. An unset size falls
  back to the next smaller one, so a coach who set a single number keeps working. The first late
  cancellation on a package being on the house is a switch in the walk now, not a field in settings.
  And a coach can put a lesson **on me** — late, or simply warm: a package lesson goes back to the
  package, a priced one is zeroed, and the reason reaches the student, because a gift nobody is told
  about is just a number that changed.

- **The booking screen reads right.** Three faults that made correct data look like a broken page.
  Taken hours were appended after the free ones, so a booked 16:00 sat to the right of a free 19:00.
  The chosen day was stored once, and booking the last hour of a day took that day out of the list —
  leaving "Free times on" with no day after it and no hours under it. And the waiting-list button's
  label is a sentence, which ran off both edges of a phone. The coach's week now sits under their
  name as well ("Teaches 07:00–12:00, 15:00–20:00"), so a day that is not offered reads as a day that
  is closed rather than a page that failed.

- **A coach who goes quiet.** The other half of the same door. A coach rarely says "I quit": they
  stop answering, and their page and their button stay live for every student they ever taught. So
  a coach with no lesson in sixty days — none taught, none booked ahead — drops off the student's
  screen on their own. The coach's page still opens and the student keeps every lesson in their
  history: only the button that reaches nobody goes. Nothing is set and nothing is undone, so the
  first lesson the coach books brings the door straight back.

- **Getting back to your own matches.** A browser that has never seen you shows a name field, and
  under it one line: "Have you used Kicksmash before?" It opens in place to the email you gave (a
  6-digit code) or the Telegram account you signed in with. Shut by default, so it takes nothing from
  the one thing that page is for. The same block, open, is what My matches shows a signed-out visitor.

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

1. **WhatsApp, one-to-one — built, waiting on an account.** The code is in `src/lib/whatsapp/`: the
   Cloud API client, the signed webhook, the hand-off link and the conversation, all off unless the
   environment is set. What is left is not code: a Meta business portfolio, a phone number that is not
   *currently registered* on WhatsApp — a new number, or an existing one whose WhatsApp account is
   deleted first, which cannot be undone and takes that account's chat history with it — and the
   webhook pointed at `/api/whatsapp/webhook`. That is the owner's to create, and nothing reaches a
   real person until they do. A private thread carries the whole of a player's
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
2. **LINE — built, waiting on an Official Account.** `src/lib/channels/line.ts` and
   `src/lib/line/`: the card in a group chat, the two taps, a signed webhook, and the two policies a
   platform that cannot edit a message forces — re-send only when something a player would notice
   changed, and answer on the free reply token rather than a metered push. Off until
   `LINE_CHANNEL_TOKEN` and `LINE_CHANNEL_SECRET` are set, which needs a LINE Official Account: the
   owner's to create, like WhatsApp's. **It ships in English** — decided 15 September. Thai waits
   until somebody is using it, because there is nothing to translate *for* yet.

   The numbers, since they were once given wrongly as one number. The card in a chat is its own set
   of **216 strings**, and it has two languages, English and Russian — not three. The **1,456**
   strings are the website, which has three. So Thai in a LINE chat is 216 strings and Thai on the
   website is 1,456, and neither of them is what stops LINE going live: the Official Account is.
3. **The serious tournament.** What Thailand's top organisers and FIP run: pairs registered per category,
   a group stage then a knockout, a consolation draw, a qualifying draw into a main draw with seeds,
   scoring set per phase, the draw published, courts scheduled, scores live per court. This is a second
   engine beside the rotation engine, not a feature on top of it, and deserves its own decision.
4. **Courts as capacity, then a court a person can hold.** Light booking for a club with no system:
   matches and lessons occupy a court, a person holds one with a name and a cancellation rule. No payment
   passes through Kicksmash.
5. **Performance analytics by integration.** Shots, positioning and workload from smartwatch and camera
   integrations, with the player's consent. A match will carry sensor sessions.
6. **WhatsApp in a group chat**, if Meta ever lets a business into a group somebody else made. Today it does not, at any tier.

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
