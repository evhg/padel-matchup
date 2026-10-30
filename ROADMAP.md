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
  city, lesson length, when you teach — and after that every flow is buttons (see "The assistant as
  taps" below); the one-line grammar (`price 800`, `move anna fri 15`, `unpaid`) still works for a
  coach who likes it.
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
  quiet hours from a weekly programme. A programme match reaches the club's recent players who switched "club matches" on, by push and
  email; the kind is off by default (decisions B and D, 9 October 2026), and everybody it was for
  finds it in their inbox (`mayEmailClubMatch` in `src/lib/notify.ts`).
- **Privacy and terms in full.** `/privacy` and `/terms` in three languages, operator "Kicksmash, Phuket,
  Thailand", the feedback form as the contact, Thailand's PDPA as the law. The figures on the page come
  from the constants that enforce them (`src/lib/legal.ts`), and `tests/legal.test.ts` checks the cookie
  names and the figures. Deleting an account now also unlinks Telegram, Discord and LINE and takes the
  public page down. Each night the backup repository's history is rebuilt with only the last sixty days,
  so a deleted account leaves the backups after about sixty days (the owner's decision of 10 October
  2026; `docs/OPERATING.md` has the guards and the way back).
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

- **The assistant as taps.** Padel players do not type `anna fri 15 90`, and the owner said so. Every
  flow in the Telegram chat is buttons now, for the coach and for the student, without leaving the
  app: book (who, how long, which day, what time, how many), cancel with one question first, move
  (which lesson, which day, which free time), block a day or one of its hours, a card per lesson
  with no-show and its undo, on me, and paid; students with a card each, a package started from the coach's own offers with one tap,
  the money with a paid button on every open figure, and the rules as buttons with the value in
  force marked. A student books, moves, cancels, pays, takes a package, waits for a spot that week,
  or asks the coach for an hour outside the grid. Stateless like the setup walk: each button carries
  what has been chosen so far, packed into Telegram's 64 bytes. Numbers are a keypad in the chat
  (the digits, ⌫, ✓), so a price, the pair price, the second length and its prices, the extra outside
  the hours, a PromptPay number and a package's price are all taps; an hour the grid does not offer
  is the hour as a button and then the quarter; the packages on the coach's page are listed, removed
  and added in the chat. The one typed thing left is a new student's name, as a forced reply whose
  prompt carries its own context. The one-line grammar stays for a coach who likes it.

- **The month as a file.** A coach's accountant wants a line per student, not a chat. The monthly
  wrap now carries `statement-<month>.csv`: each student's lessons done, no-shows, late cancellations
  counted, lessons on the house, what the lessons and the packages of the month came to and how much
  of that is paid, and a totals line, in the coach's language. The same file is on the students
  screen for this month and last month (`/coach/statement.csv?month=`), and in the chat under 💰
  Money as two buttons that send the month as text. Comped lessons count as done and owe nothing; a
  package counts in the month it was started, at the price agreed.

- **The serious tournament, step 1: entries.** The second engine beside the rotation engine, the one
  Thailand's series and FIP run. A competition (`/t/<slug>`) has days, a place, an entry note (the
  fee and the ways to pay, as text; money never moves through us) and categories: Pro, Amateur,
  Mixed, Senior, or a level band, each with a field of 8, 16 or 32 pairs. Pairs enter a category;
  a player enters at most two categories in one competition, once each; a full category takes the
  pair on its waiting list, and a withdrawal moves the first waiting pair up and tells them. A
  partner is entered by name and confirms the spot by link, signed in or by typing their name; the
  placeholder folds into their account. The organiser's desk (`/t/<slug>/manage`) opens and closes
  entries, adds categories, enters a pair by two names whatever their levels say, marks paid, and
  hears of every entry on the channel they have.

- **The serious tournament, step 2: the draw.** Made whole from the field: a qualifying knockout for
  the spots past the direct entries, groups of four or five filled snake-wise by seed with the top
  two through, a knockout seeded so the top two meet last with byes for the top seeds, and a
  consolation draw for the rest (or, in a straight knockout, for the first-round losers). Scoring is
  set per phase (one set to six with a tie-break, a super set to nine, two sets and a super tie-break,
  best of three) and a score is checked against the rule of its round. The organiser makes the draw,
  looks at it, redraws or publishes; every player hears where they start. A score comes from the
  organiser or from a player of either pair, on the page, and is correctable until the next match
  built on it has one; a walkover is one tap. Group tables (wins, head-to-head, sets, games), the
  rounds by name, the champions.

- **The serious tournament, step 3: courts and times.** The organiser names the courts and the day's
  window; one button gives every match of every drawn category a court and a time — the groups
  first, a rest between a pair's matches, a round after the round it is built on, the finals last,
  never one player on two courts across categories, played matches keeping their slot. Every player
  hears their own list on the channel they have; a match moved by the organiser tells both pairs;
  fifteen minutes before a match, both pairs hear the court (the five-minute push job). The order of
  play, by day and time with the court, is on the page for the desk and the players. On a weekend of
  more than one day, the groups and the qualifying play first and the knockout after them, main draw
  and consolation, starts on the last day (24 September 2026; before, the final fell on Saturday at
  18:00). A knockout-only category fills from the first day, and the line gives way when the last
  day has no room for the knockout. A match that finds no room is counted, and the organiser reads
  how many under the button.

- **The serious tournament, step 4: live.** The club's screen (`/t/<slug>/tv`): each court's match
  now and next in big type, the latest results, the champions, asked again every thirty seconds.
  The page itself asks again every minute during the days of play, so the tables and the brackets
  move with the scores. A player answers the "in 15 minutes" or "your match moved" notice in
  Telegram with the score, "6-4 3-6 10-8", and it lands on that match — the notice carries the
  match as its last line, read before the general score reader; a wrong score is refused with the
  round's rule, somebody else's match with "not yours". When a category's final is in, every
  player on the podium (champions, finalists, both semi-final losers) gets the moment once, with
  its own page, and hears it.

- **The serious tournament, step 5: the big-event extras.** A stream link on a match (rule 26: the
  organiser pastes YouTube, Twitch or Facebook Live; the page and the club's screen show "Watch
  live"); the desk's check-in mark on a pair; the lucky loser — a pair out of a made draw is
  replaced by the first pair waiting in every match still to play, with nobody waiting the other
  side walks through, played results stand; the results as a file (`/t/<slug>/results.csv`); and a
  ranking across the editions that share a series tag (`/t/series/<tag>`): points for the round
  reached in every finished category, both players of the pair, a bonus for the consolation winner.
  With this the serious tournament of the vision is built end to end.

- **The player's door in Telegram.** A coach and a student had buttons; a player had a help text
  with commands in it. Now every player gets six buttons under the text field on /start: find a
  match, my matches, new match, when I want to play, coach me, help. The games list asks for the
  city with buttons when the chat's city is not known; "when I want to play" is a day, an hour and
  a place as taps, and the want is on record. Three links open the bot on the right door with one
  tap: a coach's student invite (beside the web link on the students screen), a tournament
  partner's claim (under the web link the entrant gets), and a "Get this on Telegram" line at the
  foot of every email to a player who has no Telegram yet, which binds their account when tapped.
  Someone whose coach or student days are over gets the player's keyboard, not an empty one.

- **The inside of the bot, after the door.** The card in the chats speaks Spanish as well as English
  and Russian: every string of it, on Telegram, Discord and LINE, and `/lang es` sets it. A match with
  a map link carries a Map button under its card. The serious tournament is in the chat: a
  Tournaments button lists the open competitions, one tap opens the competition's card with its
  categories and counts, another opens a category's door, the partner's name typed in reply enters
  the pair, and the partner's one-tap claim link comes straight back. The coach's setup in the chat
  goes on past the hours where it used to stop: the price on the keypad, then how students pay —
  a PromptPay number on the keypad, "at the club" in one tap, or later. What a student owes comes to
  them as the coach's PromptPay QR with that sum in it, sent as a photo under the Pay tap, with
  "I paid" under it.

- **Doors for the organiser and the club.** The landing page had links for the informal organiser
  and the coach; the serious organiser and the club owner arrived and saw only the match form.
  Two more links now sit under those two: the tournaments, and the club page with the claim. The
  header carries a small More menu for everyone with Coaches, Clubs and Tournaments; the role
  doors sit outside it as before. A club sets its indoor and outdoor courts beside the total, on
  the claim and on the manage page; the club page and the API say "4 courts · 3 indoor · 1 outdoor".
  Court names and numbers wait for the courts model (item 4 below).

- **The club's walk.** The claim was one screen of eleven fields. It is three steps now, like the
  coach's: the club (name, city, map), the courts and the hours (total, indoor, outdoor, opening
  hours, a line about the club), the links (booking page, website), and the claim itself on the last
  button. Done, the screen carries what makes the page work from day one: the manage link, the
  poster to print for the courts, and the week to fill with the socials that repeat. The check by
  the owner is unchanged.

- **The courts model, first half.** A club's courts are rows now (`club_courts`, migration 0057):
  a name, a number read from the name, indoor or outdoor. The manage page has the editor: number
  them in one tap from the count, rename, mark, save as a set; the three counts on the club follow
  the rows, so the badge, the API and the picker read one column each and never join the table.
  The club page lists the courts; the API carries their names; a match created at the club picks
  a court by its real name instead of 1…n, and the club's day view names the court each match is
  on. The second half is the entry below.

- **The courts model, second half: capacity.** A club's day (`/v/<slug>`) is a grid of the club's
  own courts: one row for each court, the matches and the lessons on it, and "3 of 6 courts busy"
  above. `clubBusy` reads both kinds in one window and `courtDay` lays them out in the club's own
  order, with a last row for whatever named no court — so nothing is hidden and nothing is guessed.
  A lesson carries a court since migration 0066: the coach answers "Court you teach on" once, on
  their settings screen, and each lesson booked after that copies the answer. Only for a coach who
  names one club, which is the rule `venue_slug` already follows, because a court name without a
  club says nothing, and a club reading somebody else's court as busy is worse than a club reading
  none. The court is the coach's own answer and never an inference. A club still reads no student's
  name off its own day. What is left of item 4 is the hold.

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

- **Five walks, and what they changed (20 September 2026).** A player, a coach, a student, an
  organiser and a club owner walked in from the landing page as themselves, on a phone, against a
  production build; `docs/JOURNEYS.md` is the record — the steps, the frustrations, the moments that
  landed. Fixed the same day: the organiser's one tap that puts a match on its venue's board from the
  match page (the switch was three taps down in More options); the language toggle as one pill on a
  phone, so the brand no longer reads "Kick…"; the empty card on My matches where a phone cannot do
  push; the founding badge's city from the coach's clubs rather than the time zone (Bangkok and Phuket
  share one); "Number them" on the courts editor keeping the indoor and outdoor split typed on the
  claim; the pending club's page and poster open to its claimant rather than "not found"; desk
  entries at a tournament no longer marked "not confirmed yet"; the tournament buttons centred on a
  laptop. What the walks put on the list is item 3 under Next.

- **The claim's check, and a club anywhere (20 September 2026).** A claim used to be a name and a
  tap: anybody could ask, and the owner's Approve was the whole review, with nothing to go on but the
  links. The claim now ends on a fourth step, "You": the role at the club and a work contact. A work
  email at the club's own domain gets a 6-digit code on the spot and the claim confirms itself; a
  phone number or a public mailbox the owner checks by hand, and the Telegram message says which case
  it is. The claimant hears the decision where they are (Telegram, else email, else push). Nothing of
  a pending claim shows to anybody but its claimant. The city was a list of two; it is a place typed
  as a person there would name it, with the country beside it (guessed from the browser's zone, named
  in the reader's language), so a club in Kuala Lumpur or Moscow claims its page like one in Phuket,
  and `/clubs` lists it under its country. Also that day: the header's doors read "My matches",
  "My assistant", "My club", "My series", so "Club" beside "Clubs" stops meaning two things; the free
  courts line on the manage page says where to share the calendar and opens it; the landing page's
  four doors are tiles with a name and one line each, not four links at the foot of the page.

- **The five things the walks put on the list, built (20 September 2026, migration 0059).** The
  organiser's desk opens on "how a weekend runs": entries, the draw, courts and times, live, results,
  each a link to where it happens, the done ones ticked, the next one lit, one line under the row
  saying what it takes. A city's coach list carries "I want a coach": a level and a few words on
  when, one row per person per city (`coach_wants`), counted on the coaches' door, told to the first
  coach who lists there and telling them, expired after three months. The level sits one tap from the
  match form behind its own chip, presets still folded (rule 1), so "looking for a fourth" carries the
  one fact the fourth needs. The coach's channel step names LINE and WhatsApp as built and waiting on
  their accounts, and says an email read later works meanwhile. On a phone under 380 px with one role
  door out, the brand's mark stands alone rather than "Kick…".

- **The americano generator, end to end (20 September 2026).** "Run it live" used to hand over a
  count and nothing else: the person landed on a page headed "Set up a match in 10 seconds", which
  reads as a tap that did nothing, and the eight names they had just typed were gone. The names now
  travel with the tap and take reserved spots with invite links (`seatNames`, capped at 24 carried);
  the page says "Your americano, live" and lists who came with it; the link carries `s=gen` so the
  door can be counted at last; a pasted list is capped at 64 names, which stops a 200-name paste
  freezing the browser; and both generator pages carry the feedback door they never had.

- **The owner's nine answers (20 September 2026).** Asked one by one, with the case for and against
  each. A claim whose work email is confirmed by the code goes live at once; the owner's first message
  is edited to say so and loses its buttons, a second one carries Reject. Ten founding places in every
  city: a city with a page by its slug, any other by its country and the place as typed, so Kuala
  Lumpur and kuala lumpur are one place and Penang is another. The count on a city's coaches door
  shows from three people up. A coach want lives ninety days, one listing tells twenty, and a person
  hears about one coach every three days at most. The level presets stay folded behind the chip. The
  chat's setup-done message keeps the bare page link and adds the line that points to the invite link
  on the students screen. The public mail domains never get a code; a Facebook or Instagram website
  is named as such on the owner's message, with the website as a button. The Russian and Spanish text
  ships as written, to be read by the first coaches who use it.

- **Social tournaments score by games too (20 September 2026, migration 0060).** "First to 4 games"
  beside points per match, the owner's note: one select, "Score by", on the create form and the
  panel (free, 16/21/24/32 points, first to 4/6/8 games). A games match is a race: a side wins at N
  and the other has fewer, both sides typed, a 3–2 the bell stopped still a win; the table then ranks
  by matches won, then games difference. Editions of a series and "play again" carry it; the API
  takes `gamesTo`.

- **A player finds a coach (20 September 2026, migration 0061).** A player who wanted a lesson in
  Phuket met the coaches' own sales page at `/coaches`, three cards that read alike, and a wall that
  said "Ask to become a student". Three things changed. `/coaches` is the player's directory now, the
  visitor's city first, and the coach's front door moved to `/coaches/join`, one line at the foot.
  Each card carries what somebody chooses between: the price for one person, the first free hour, the
  levels the coach teaches, the clubs and the languages. And a coach can switch "anyone can book" on:
  the booking is the joining, so a stranger picks a free hour, types a name and is on the list from
  that moment. The coach's hours, notice and cancellation rule do not change, and a paused student is
  still refused. A whole list reads its diary in three queries, not three per coach.

- **A first booking the coach answers, and a list they will not take (21 September 2026, migration
  0062).** "Anyone can book" put a stranger on the coach's list the moment they picked an hour, which
  is right for some coaches and not for others. A second line under it now reads "I answer a first
  booking myself". With it on, somebody the coach never taught picks a time and the coach says yes or
  no; the yes books the lesson and puts them on the list. It reuses the request a time outside the
  week already makes, so the coach answers it in the same place, on the web or in the chat. Anybody
  who was on the list before books straight through, and never meets the question again. Beside it,
  the coach can block a person: no booking, no asking, and the student link stops working for them.
  The row stays, so the lessons they took and anything they owe stay on the book.

- **What a player judges a coach on (21 September 2026).** A stakeholder audit walked six people
  through the live site. Both students reached the booking button in two taps and neither could
  decide: the card said the price was on the coach's page and the page had no price, it named a free
  hour for a coach whose page showed a stranger no hours at all, and no coach had a face, a sentence
  of their own, or anything to show the three listings were not test rows. The price slot now holds
  a number or nothing, and takes the hour out of the cheapest package where that is all a coach
  sells. A free hour is named only for a coach somebody can actually book. Each card carries the
  coach's photo, their own line, and the one thing they cannot write: the day they arrived and the
  lessons they have really given, once there are enough to mean anything. The coach's settings
  screen names what is missing while they are listed without it. Reviews are deliberately not built:
  they need moderation and a dispute path, and with four lessons ever they would show nothing.
  Separately, "everything stays free for them" on the coach's door said free was for the first ten,
  which is the loudest objection in this market printed back at the reader on the page that answers
  it. Free is unconditional now; the badge is the scarce thing.

- **The clubs that were there all along, and three cuts in the organiser's way (21 September 2026).**
  The audit's club owner spent seven of his ten minutes proving an absence: no search box anywhere
  on the site, `/clubs` telling him no club had claimed a page, and every URL he guessed a 404. The
  database held sixty-six clubs with names, provinces, court counts and websites (no booking link: one
  read of production on 10 October 2026 found none; the directory's import now carries them), and every
  page hid all of it behind a claim nobody had made. A listed club now shows what we know, says
  plainly that Kicksmash listed it from public sources and that the club does not manage the page,
  and carries both doors: the one that makes it theirs and the one that says something is wrong.
  They are in the city pages and the sitemap. `/clubs/{slug}` lands on the club's page, and `/clubs`
  has a search box that works without JavaScript. For the organiser: the time zone control put the
  zones you are likely to want above the other four hundred, and the create form takes the players
  you already have, so the link that goes to the group asks for the one seat that is really open
  instead of three.

- **Migrations reach production without a session (22 September 2026).** The Migrate workflow
  applies a migration when it reaches `main`, and nobody types SQL into production any more. It took
  seven runs to prove, and `docs/MIGRATIONS.md` records what each one taught.

- **The way back in, where people land, and a club's day court by court (22–23 September 2026).**
  The restore by email or Telegram sits on the screen every shared link opens and on the landing
  page, where it was broken. A lesson names its court (`lessons.court`, copied from the
  coach), and a club's day shows matches and lessons court by court. The card the crew will see
  fills in while the match is typed. A match that never happened can say so, and `/feedback` works
  on its own in the chat.

- **A match tells everybody it can reach (23 September 2026).** Every player with an address or a
  channel hears about a match, and the tap that cancels one answers on the screen.

- **One person, one row (23 September 2026).** The rule for when two rows are one person
  (`safeToMerge`: a shared address, a shared Telegram account, or the same name where at most one
  side can be reached) and the operator's door that applies it. The owner approved each rule with
  its cost. The match page now recognises a name that is already in the match before it makes a
  second one. Four merges took production from 56 rows to 48.

- **The operator's read-only window (23 September 2026, migrations 0067 and 0068).**
  `/api/admin/sql` answers one select as a role that can read no token, manage code or push key.
  It answered "0" to every count until migration 0068, because of Row Level Security; a test now
  counts rows through it.

- **Kicksmash is built by the players on it (23 September 2026).** The feedback card says so, and
  counts the notes that became part of the app once there are three.

- **Everything rebuildable from GitHub, and a session that starts in step (23 September 2026,
  migration 0069).** The three scheduled jobs (hourly, the five-minute push, the ten-minute calendar
  sync) lived only in the database, typed by hand with the operator secret in their text. They are
  in the repository now, and each reads the secret from Supabase Vault when it runs; one operator
  call gives a new database the secret, and the same call follows a rotation. The nightly backup
  gained a loader: one night's file into a local database with every credential replaced, push
  subscriptions dropped and contacts masked, and the backup now says when a table filled its row
  cap instead of stopping there quietly. A session now opens by saying whether its copy is behind
  `main`, installing what is missing, and naming any operator variable that is not set.

- **A merge loses nothing (23 September 2026, migration 0070).** `mergePlayers` moved six tables by
  hand and let the delete take or blank the rest, so a restore by code could drop a student from a
  coach's list with their packages, and one of the day's four merges cut Erik's question off from
  him. It now moves every column that points at a player, read from the schema, and refuses two
  coach pages.

- **Ideas that became the app, a quieter coach setup, and last match's photo on the first page
  (23 September 2026, migrations 0071 and 0072).** `/built` lists what players' notes changed, one
  line each, written by whoever shipped it: never the note's words, because a note can be crude, a
  joke or malicious, and at first no name (see below). The feedback card's count links to it. The
  coach setup lost its help sentences where the choices already say it, after "too much text, I
  don't want to read all that". The card on the first page, which fills in as a match is typed, now
  sits on the photo of the viewer's last match, served from `/{code}/photo`.

- **An address that stops working stops being written to (23 September 2026, migrations 0073 and
  0074).** Resend's bounces and complaints arrive on the signed webhook that already carried mail to
  `claude@`. A hard bounce or a complaint marks the address at once, three soft bounces mark it; a
  marked address gets no more mail, the match tells its owner on Telegram or by push instead, the
  player reads it on My matches and the organiser beside the name. A code the player asks for still
  goes, and arriving clears the mark. The service board watches the two rates mail providers judge
  a sender by.

- **The switch to the app's own database role starts from a known place (23 September 2026,
  migration 0075).** The role `kicksmash` had a policy on every table, but for 50 of them the grant
  that lets it use the table existed only in production, typed in by hand. The grant is in the
  repository now, a test fails on any table the role cannot use and on any operator route that does
  work before it checks the token, and the day's steps are written down.

- **A first name beside each idea on `/built` (23 September 2026, migrations 0076 to 0078).** The
  owner asked for it the same day. The name is the player's name on Kicksmash, the one a match page
  already shows, stored when the note ships; never what the note typed. The desk can hide it for a
  test user or a name unfit for a public page. The same change stops Resend's test addresses from
  marking anything: one test bounce had turned the service board's bounce row yellow.

- **A tournament weekend rehearsed, and what a real one would have tripped on (24 September 2026).**
  26 pairs in two categories, four courts, two days, played through on phones as the organiser and
  the players. The score form now names the pair whose games come first and says who wins before
  the save: a player listed second typed his own games first and gave the match away. A player's
  own matches come first on the page, with the court, the time, the result from their side and the
  score form; they had been seven screens down. A knockout side says where it comes from ("Winner of
  group A") instead of "to be decided". The desk says "Change the score" on a match that has one,
  its pair rows are a third of the height, and the partner's link goes to WhatsApp or Telegram in
  one tap. When every category has its champions and nothing is left to play, the page and the
  club's screen lead with them. The card on the first page says it is a preview, and a page from
  before a deploy reloads once instead of showing an error.

- **The card left the first page (24 September 2026).** The owner's rule: the first page is the
  ten-second match and nothing else. The card with the court photo exists to be shared in chats and
  on socials, and the moment for that is right after the match, when every player sees it; it may
  also be shown where the features are listed, never in the create flow. It had been added on 23
  September from a note (Erik, 20 September) and sat between the name and the time, repeating the
  form; `docs/DECIDING.md` rule 1 already said no. The landing page lost a database query with it,
  and `/{code}/photo`, which only it used, is gone. The result card itself is unchanged at
  `/{code}/card`, with the photo, the share buttons and the story picture.
- **The nudge becomes the result card (24 September 2026).** The owner: "when one of the players
  enters the result, the score nudge received by all the other players changes into a result card.
  Changing is not an additional message." In Telegram the nudge is now the card still waiting for its
  score (the two pairs, or the four names, and empty sets), and the first answer, from any screen,
  swaps its picture for the result with the winners and one button to the card's page. A court photo
  added later reaches the same message, and so does a corrected score. The morning's nudge replaces
  the evening's, so a chat never holds a live "how did it go?" beside the result. Push and email get
  nothing more: neither can be edited, and a WhatsApp group gets the card by hand. For that hand, the
  match page now shows the card under the score, with the court photo button and WhatsApp, Telegram
  and the phone's own share one tap away. `docs/DECIDING.md` rules 5, 16 and 18 say it; rule 16 also
  stopped saying "exactly once", which had not been true since the morning nudge shipped.
- **Rows nobody will miss go after 14 days (24 September 2026).** Identity is a cookie, so every
  browser that types a name becomes a player row, and the 21 September walks alone left 25. The
  owner chose a daily job over a one-off purge: a row goes when it has no contact, no public
  profile, nothing pointing at it, and is 14 days old; a coach page on which no lesson was ever
  booked goes with it, a note on the feedback desk keeps it. The keep list is read from the schema,
  the same one a merge moves, so a new table keeps a row without anybody remembering to. The first
  run removes one row (Anna, 9 September), and cath's empty coach page once it is 14 days old;
  Tbone follows on 2 October and the 25 walk rows on 5 October. Five names in Jakob's tournament
  of 4 September have seats and matches, so they stay.
- **The same name, one side proved (24 September 2026).** A second browser makes a second row, and
  the matches played from it never reached the person's own list. The owner chose how far a name may
  carry a merge (option A). When somebody proves who they are, by a code from their address or by
  linking Telegram, a row of the same name that nobody can reach is folded in automatically if the
  two also share a match, an organiser or a club. Otherwise My matches asks "Are these yours?" and
  shows those matches (the day, the club, who else played), with "Yes, these are mine" and "Not me";
  "Not me" is remembered in that browser only. A row that is a member of a group that asks to join
  needs the shared context for that answer too (the owner, 10 October 2026: "Need a shared match
  first"); without it the card says so and offers only "Not me". A row that created a crew or is an
  admin of one is never merged by name, shared match or not, in any crew (the owner, 11 October 2026:
  "No admin role by name alone"; the reading with a played shared match waits for the owner). A row with an address, a phone,
  a chat account or a push subscription is never merged by name. A merge now also moves the
  person's wants, which point at a player without a foreign key and were left behind on the folded
  row until now.
- **Three players can score from Telegram (24 September 2026).** Erik's note of 15 September (match
  9wjp): with three players seated, the nudge's 🏁 said "the result needs four players", and a bare
  "6-4 6-3" in reply said "tap 🏁 on the card first", while the web took the score from three. Two of
  the three scored matches in production had three players. Where the chat cannot finish the result
  (fewer than four seated, or pairs nobody has set), the 🏁 on the nudge and those two answers in the
  player's own chat now carry one button to the match page's score form, already signed in through
  the Mini App: the direct link when the app exists in BotFather, else a web_app button on `/tg`,
  which every deployment with Telegram has. The button never carries a personal link, because a
  forwarded message keeps its buttons. A group gets the sentence alone.
- **The coach card tells the truth (25 September 2026).** The owner: "Improve the coach card." A
  coach who confirms every new student had "⚡ Book without asking" on the card; the card now says
  "New students ask first" and names no free hour. Both listed coaches had no Telegram, no email
  and no push device, and ricardo's page still promised "ricardo confirms it — usually the same
  day". A coach nobody can reach stays listed, but the card and the page say "Not taking bookings
  yet", and a new student's booking or ask is refused on every channel (web, API, MCP, Telegram).
  The coach's own invite link still works. The coach sees on their own page why, and where to add a
  channel. The student link now shares a ready message in one tap: "Book your padel lessons with me
  here…". The end of the setup used to share the message meant for other coaches.
- **Banter: the crew's own facts, where the crew already looks (25 September 2026, migrations 0079
  and 0080).** The owner: "Statistics could be fun, ie. calling out someone for pulling out last
  minute for the third time, or winning 3 matches in a row and giving them a sarcastic pat on the
  back in the group together with the result card." Option A: facts only, from the players' own
  matches. Three or more wins in a row, counting the match just scored, is one line on the group's
  result post, on the result card in each player's chat, on the card's page and on the picture itself,
  so it travels when the picture is forwarded. A third late pull-out in 90 days (leaving within 24
  hours of the start) is one line on the match's card while the spot it opened is open: an edit, never
  a new message. Several lines per fact in each of the three languages, chosen by the match code,
  first names only (`src/lib/domain/banter.ts`). Nothing reaches a profile, a board, a ranking,
  `/built`, the API or the MCP. The organiser switches it off, and on again, with one tap in the
  organiser's tools on the match page (`players.banter`, on by default). An exit now records its own
  moment and whether it came from the waitlist, and a partial index (`activity_left_idx`) keeps the
  90-day count one small read.
- **WAREHAUS.club is back on the club lists (25 September 2026, migration 0081).** The owner:
  "warehaus is where erik plays and he is using it to test the app." Erik's test claim of 20 September
  wrote over the directory's row, and the refusal twenty minutes later hid it, so the club with the
  most matches fell off `/clubs`, the Phuket page, the venue picker and the claim form. The same
  afternoon a tournament typed as "WAREHAUS.club" landed on a second slug, `warehaus-club`, because a
  refused row no longer answers to its name. A refusal about the claimant (not confirmed, somebody
  else runs it, or no reason) now hands a directory listing back exactly as `data/clubs.json` has it:
  nothing the claimant typed stays, the courts and the week the claim set go with it, and the manage
  link is new, so the refused claimant can no longer edit the page. "Not a club" and "duplicate" still
  take the page down. Migration 0081 does the same for Warehaus's row; the five indoor courts the claim
  typed go too, because no public source says so. The `warehaus-club` tournament stays where it is.
- **A free court reaches the player who asked for that hour (25 September 2026).** The club's promise in
  `docs/VISION.md` is an off-peak court hour filled from Kicksmash. A live club's feed of free courts
  and a player's want ("Tuesdays around two at Rawai") existed side by side and never met. Now, when
  the feed shows a court free two to six hours ahead at the club a want names, on its day and inside
  its hours, the player hears once on the channel they have: Telegram with one button that opens the
  match form at that club, day, hour and zone (listed on the club's board), else email, else push.
  Nothing is sent for an hour a match at the club already fills, or to somebody already playing there
  that day. A want hears at most once in six hours, the cooldown it shares with the match notices, so
  no want hears about the same court twice, and it hears about one court a day; one hourly run sends
  at most twenty. No table and no column. No club in production shares a feed on 25 September, so nobody hears anything until one
  does; one want is waiting, at Warehaus.
- **The free spot goes to past partners (25 September 2026).** The owner: "the fourth spot offered
  to past partners and to players who want that time". On 24 September ten of thirteen past matches
  never got past one or two players, and every match that filled was scored, so a match is lost at
  filling. The refill notice had reached nobody at all: it went only to a crew or a club's regulars,
  and only by push, which one player in 46 has. Now the people who played a finished match with
  somebody in the match in the last 60 days hear too, and a private match with no crew reaches them
  and nobody else. Each person hears once, on the channel they have: a private Telegram message
  whose ✅ is the card's own one-tap join, else an email with the match link, else a push. The
  window (90 minutes to 48 hours), the cap of 40, the level range and one notice per match stay as
  they were. At most ten of the 40 go by email (`REFILL_EMAIL_MAX`), because Resend's free tier sends
  a hundred a day. The hourly sweep now also finds a match that enters the window with a spot nobody ever
  took. `docs/DECIDING.md` rule 5 names the one private message. In production today the past
  partners a channel reaches are one to four per match.
- **A season table for each crew (25 September 2026).** The owner asked for "a small season table
  for each crew". Under the crew's matches, once it has two scored matches in the last 90 days: each
  member who played, by first name, with played, won and wins in a row, 🔥 from three, most wins
  first. It counts a match with a score and both pairs set. One bounded read,
  and a crew with fewer than two matches behind it never makes it. Production's one crew has one
  scored match, so nobody sees the table yet.
- **A group page shows names, not levels, and a crew can ask to join (9 October 2026, decision E,
  migration 0087).** The owner: "names visible, levels hidden, optional Ask to join", for social
  proof and privacy. On the group page's member list a visitor sees the members' first names and
  the count, and members see each other's levels; `GET /api/v1/groups/{code}` and the MCP tool
  `get_group` carry the names and the count, never a level. A match's own roster still shows the
  levels of its seated players, as every match page does. An admin switches on Ask to join in the
  group's settings (a ladies' crew, a level crew): a newcomer asks with an optional note, the admins
  hear it by Telegram, email or push, and see it on the group page, where they approve or decline;
  the person hears the answer, and a declined person may ask again after seven days. A seat in such
  a group's match is a seat, never a membership.
- **A channel the moment a player joins, and a calendar that keeps itself (25 September 2026).** The
  owner: "When a player joins a game, we need to capture a channel to contact them right away in a
  very smooth way and give something in return", WhatsApp, Telegram or email, and never push or SMS.
  Uptake of the old email-only calendar form was lukewarm, and the hurdle was "oh no, not another
  app". Where that form stood, a player with no channel now meets "Stay updated": changes, a free spot
  and the result card reach you there, and your calendar updates itself. Three choices, each
  something they already have: WhatsApp (only once a number is configured), Telegram, email. Telegram
  is one tap on the email's own signed `p_` link with the match's code on the end; the bot links the
  account and answers that /start with the match's card and a "📅 Add to calendar" button. WhatsApp
  opens with `LINK-<code>-<ticket>` typed; the ticket is the same kind, signed with Meta's app
  secret, and it links the number to the web player (folding in a row the number already had, one
  seat kept) and answers with the match and the calendar. Email is the invitation it always was.
  Once a channel is linked, the card is one quiet line ("Updates reach you on Telegram ✓") and it
  never asks again. A chat player's calendar is a feed of their own matches from thirty days back
  (`/p/<key>/calendar.ics`, a cancelled match marked, the same UID and fields as the invitation),
  offered as `webcal:` and through Google on a computer; the Android app cannot subscribe, and the
  card says so. The key is made from the personal token but is not it, so the address can sit in a
  chat or a calendar without being a way to sign in. An organiser's list of past players no longer
  shows a player's own number, only numbers the organiser typed. The settings on My matches carry the
  Telegram link and the email (`src/lib/domain/stayUpdated.ts`, `src/lib/calendarFeed.ts`). What
  WhatsApp then sends a linked player is the entry below.
- **WhatsApp carries the match (26 September 2026, migration 0082).** The owner's decision (option
  3.A): a player who links WhatsApp on the "Stay updated" card gets what the card promises there.
  Outside the 24-hour window WhatsApp delivers only a template Meta approved, so the four notices are
  four utility templates in English, Russian and Spanish (`data/whatsapp-templates.json`):
  `ks_match_update` (a change, with the match page's button), `ks_spot_open` (a free spot, whose
  "I'm in" comes back as the thread's own `wj:` join), `ks_score_ask` (the score, after the match)
  and `ks_match_result` (the result card's picture, once per player per match, ever, kept in the fact
  log as `whatsapp.result`). WhatsApp is the second channel after Telegram, and only for a notice
  that has a template (`tell()`'s `whatsapp` option, `channelFor`); a coach's notices stay off it. A
  send that fails for any reason (the day's cap, a template not approved yet, an error) goes on to
  email, then push, as before. `WHATSAPP_TEMPLATES_PER_DAY` (50 by default, 0 switches them off) is
  the cost guard, and one free spot pays for ten WhatsApp messages at most (`REFILL_WHATSAPP_MAX`).
  No button carries a personal link: a URL button's variable part must be a match code, or a code and
  `/card`. The number a player writes from is now indexed (`players_phone_idx`), because every inbound
  message looks it up. `scripts/whatsapp-templates.mjs` lists the templates Meta holds and creates the
  missing ones. The card's quiet line lists WhatsApp like the others ("Updates reach you on
  WhatsApp ✓"). Nothing reaches a person until the owner's account exists, the templates are
  approved and the WhatsApp variables are set (item 1 below).
- **No raw IP address in the rate limits (30 September 2026).** The owner's decision (option A). Every
  limit counted "per IP" (new identities, restore codes, feedback, the public API, the MCP endpoint,
  client error reports) wrote the caller's address into `metrics_daily`: about 200 rows a day, nearly
  all automated clients calling the MCP endpoint. The key is now a hash of the address keyed with
  `SESSION_SECRET` (`src/lib/ipKey.ts`), because a plain hash of an IPv4 address can be reversed by
  hashing all four billion of them. The same caller still lands on the same counter, so every limit
  works as before. The hourly job deletes rate-limit rows older than two days (`pruneRateRows`); a
  limit only ever reads today's row.
- **A match says how long it is (30 September 2026, migrations 0083 and 0084).** Erik wrote on 25
  September from his match page: "is the game 60min or 90min? I can't tell. The calendar invite sent
  out is 2h I think, but I think the booking app shows 90min". He was right: every event ended two
  hours after its start (`EVENT_DURATION_MS`), and nothing on the page said how long it was. The
  owner's decision of 30 September (option A): the organiser picks 60, 90 or 120 minutes, three taps
  under the time on the create and edit forms, 90 already chosen. `events.duration_minutes` holds it;
  existing matches became 90, and existing tournaments 120, the two hours they always had. The rule
  is `src/lib/domain/matchLength.ts` (`MATCH_LENGTHS`, `parseMatchLength`, which refuses anything
  else rather than rounding it, and `eventEnd`), and every reader of "is it over?" asks it: the match
  page, joining, the hourly sweep to past, the first score nudge (now when the match ends, rule 16),
  the past partners a free spot goes to, the current edition of a series and the club's court day.
  The match page says "until 11:00 · 90 min" beside the start; the Telegram, Discord and LINE cards,
  their notices, the WhatsApp line and the email say "09:30–11:00"; the link preview and the story
  picture carry "90 min"; the invitation, the Google link and the player's feed end at the start plus
  the length. A new length is a new end for everybody's calendar, so it bumps SEQUENCE and resends
  the invitation as a time change does. A tournament takes the same three lengths and starts at 120.
  "Play again", a group's weekly match and a series' next edition keep the length of the one before.
  The API takes `durationMinutes` on create and every match object carries it beside `endsAt`.
- **The tournament night at a glance (9 October 2026, no migration).** A competitor makes the format
  clear at a glance, and ours read "? Tournament" and "No rounds yet." Under a tournament's title the
  page now carries the night as chips: players in out of the field, the format, the score ("to 21
  points", "first to 4 games"), about how many rounds, the courts and the end. The help is named for
  the format ("How Americano works"), and before round 1 the one-line rule and a sample of the night
  ("10 players: about 2 courts, 4 per court, 2 rest each round, in turn.") are open. The create form
  says under Players what the night needs ("Needs 2 courts · 7 rounds for a full rotation · about 1h
  52m at 21 points") and warns, gently, when a full rotation runs past the booking. One pure function
  (`nightPlan` in `src/lib/domain/tournamentPlan.ts`) feeds all three, and the page computes the
  plan once (`nightField` picks the count) and hands it to the panel, so the chips and the sample
  give the same courts. Round 1 of an americano or a
  mexicano now starts with any four names or more, as the /americano generator always promised:
  whoever does not fit a court rests that round, in turn, and a rest adds no points. King of the
  Court keeps names in fours, because there the waiting players come in at the bottom court by the
  format's own rule. Rounds already drawn, and the next round of a tournament under way, are drawn
  exactly as before. The organiser's banner on a tournament names the round waiting for scores.
- **Find a game (9 October 2026, no migration).** The owner's decision C: a compact "Find a game"
  chip under the landing page's headline opens `/play`, the open games a visitor can join. It lists
  the listed matches and social tournaments of one city, soonest first, with chips kept in the URL:
  the city (the edge's city when it is one of ours, else Phuket), the day (Today, Tomorrow, This
  week, in the city's own zone), "Fits my level" for a viewer with a level, the club, and "Spots
  left only". Each game is one `EventRow` (`src/components/EventRow.tsx`): the time big and in
  tabular figures, the seats in the group rows' words, the level, the price, the format of a
  tournament, the club and the organiser's first name. It is one read (`findGames` in
  `src/lib/domain/findGame.ts`: one query with the seat counts inside it, at most 120 rows) and the
  rules are pure and tested in `tests/find-game.test.ts`. An empty city says so and offers the form.
  `/play` is in the More menu and the sitemap. Later, when a city has three or more open games, a
  strip of them above the form; and `EventRow` replaces the city page's, the venue board's and the
  group page's own rows.
- **"Who is here?" and a night that updates itself (9 October 2026, no migration).** Before round 1
  the organiser (or whoever holds the manage link) sees every name with a tick, ticked by default,
  and the waiting list unticked. "Add a walk-in" seats a name the way "Open spot" does. On a full
  night it adds that one spot: the waiting list moves back a place and nobody on it is moved up. "Generate round 1" is now "Start with N
  players" and draws only the ticked names; King of the Court says how many to tick, add or untick
  to reach a four. The unticked leave in the same write as the draw (the feed records each one,
  as "Remove player" does) and hear "We started without you" by the removal's own email, with no
  spot offered to strangers and no waiting list moved up at the moment the spots close. While the
  night runs (round 1 drawn, scores not final, the booking not over) the page asks the server
  again every twenty seconds while it is on screen, so a score typed on one phone appears on the
  others; a score box keeps what its own phone is typing. An organiser who unticks their own name
  gets no "We started without you". The club's TV view (`/t/[slug]/tv`) was skipped: it reads the
  serious tournament's competitions only (`liveBoard`), never a social night's rounds, so the match
  page's live refresh is the night's screen. `src/lib/domain/checkIn.ts`, proven in
  `tests/check-in.test.ts`.
- **Bigger text, and a dark theme that follows the phone (9 October 2026, no migration).** "Bigger
  text" is one switch on My matches and in the header's ⋯ menu, for anybody, account or not. It is a
  cookie (`km_text`, `src/lib/textSize.ts`) that the root layout reads, so the first paint is already
  the chosen size: the root goes from 16px to 18px and the chips to 13.5px. Every size is in rem, so
  the whole app grows with it. The dark theme needs no switch: `src/app/globals.css` gives the same
  colour names a dark set under `prefers-color-scheme: dark`, an ink-navy ground with the same lime.
  `tests/contrast.test.ts` holds every text colour at 4.5:1 in both themes, and fails on a new
  `bg-white` or `text-white` outside the few places white is meant (a QR code, the brand buttons).
  The club's TV page, the printed poster and the embeds stay light (`data-keep-light`), with a light
  theme-color for the browser's bar (`KEEP_LIGHT_VIEWPORT`). A switch that is off has its own knob
  colour (`knob-off`), light in the dark theme, at 3:1 or better on its track. With Bigger text on a phone the
  header shows the mark without the word, and the e-mail field never gets narrower than its placeholder.
- **Who a match is for (9 October 2026, migrations 0085 and 0086).** The owner's decision G1: a match
  can say "Men", "Women" or "Mixed", and "35+", "45+" or "55+". The tag is on the event, never on the
  player: no gender and no age is stored about a person, and nothing is checked at join. It sits behind
  the level chip on the create and edit forms ("Who is it for?"), so the form is not one line longer
  for anybody who skips it, and shows as one chip beside the level wherever the level shows: the match page, the
  club's board and day, the city pages, the group rows, the series page, the embeds and the Telegram,
  Discord and LINE cards ("🎚 Level 3.0–4.5 · Women · 45+"). `events.category` and `age_min`, with the
  same pair on `series` and `club_slots`, so a ladies' night keeps its tag on every edition and a
  club's weekly "Ladies social" on every match it makes; "Play again" and a group's weekly match keep
  the tag of the one before. The rule is `src/lib/domain/eventTags.ts`. The API and the MCP take
  `category` and `ageMin` on create (anything else is refused with a 422) and every match object and
  board row carries them. Filters on a listing come later.
- **A crew's own Telegram group (9 October 2026, migrations 0089 and 0090).** The owner's decision:
  a crew can run its own Telegram group with the bot as an admin, opted in group by group (DECIDING
  rule 31). A crew's admin finds "Run a Telegram group for this crew" on its page. A line above the
  link asks for a new group only for this crew's padel. One link picks the group and adds the bot as
  an admin with two rights (pin, invite links).
  The bot ties the group to the crew, pins its notice ("It reads messages in this group … It never
  keeps the text"), and makes the invite link the crew page then shows its members ("Join the crew's
  Telegram group"). From then on "in", "+1", "я в деле", "me apunto" take the seat of the one open
  match, "out", "can't make it", "не смогу", "no puedo" give it back, and "who's in Thursday 7pm
  Rawai?" makes the match at a court the chat already knows and posts its card as the reply (a new
  court goes through /new); the card is edited and the bot answers
  with a reaction, never a message. With two matches open it asks that person alone. In any group, a
  reply "+1" to a card now takes the seat as the ✅ button does. The `/new` line reads Spanish
  ("mañana 19:00 Rawai", "el jueves a las 20", "a las 7 de la tarde") as the Spanish welcome always
  said it did, and a place the chat already knows wins over leftover words: its usual court or the
  sender's, by name or by its area, and a listed club in its zone by the club's own words, never by
  a city or an area alone. /quiet from a group admin stops it acting on words. No message text is
  stored anywhere.
  Changed on 11 October 2026, after an audit. The first group tied stays the crew's group. The bot
  refuses a second group of the same crew, and another crew's link, until /quiet there. A session
  wrote this limit on 11 October 2026; the owner has not decided it. A first group that the bot is no longer in frees the
  crew. The bot asks Telegram about that group once, when somebody taps the crew link in a new group.
  The bot stops reading when it loses the right to pin. The invite link follows the right to invite,
  and it goes at /quiet. The pinned example asks at the crew's own court. The bot also reads the
  question asked after the match ("Let's play Thursday 7pm at Warehaus, who's in?"). A question with
  "no" and no court in it makes no match. A seat taken by a word or a tap sends that person alone the
  calendar feed's button, once. A session added this on 11 October 2026 (option A of the audit);
  the owner has not decided it. The card carries "Book this court". A /new line names a listed club only in full. A
  city, an island, a district or an everyday word such as "Asia" never names a club. The owner, 10
  October 2026: "Yes, but only on the club's own words". Outside a crew's group, such a /new match
  goes on the club's board when it sits at the club. There the club's regulars hear about a free
  spot, and the bot's answer has one tap to take it off. A session built this default on 11 October
  2026 (option A of the audit); the owner has not confirmed it. In a crew's group, only the word "public" puts a /new
  match on a board.
- **Fixed pairs (10 October 2026, decision F, migrations 0091 and 0092).** The owner: "Fixed pairs in
  social tournaments (two partners play every round together), as Phuket nights often do." The create
  form's format step has "Fixed pairs", off by default, for americano, mexicano and King of the Court,
  and the organiser can switch it in the panel until round 1. Pairs sign up together: the join takes a
  partner's name, which becomes a reserved spot with its own link that the partner opens to claim it
  (rule 24). A player alone is listed as "Ana · Partner needed", and anybody taps "Be their partner".
  One partner leaves and the other needs a partner again; a partner who is still only the name the
  leaver gave goes with them, and nobody takes a player out. The waiting list moves up by pairs, a
  single past a pair that does not fit yet, with the promotion notices that already exist. The organiser pairs two singles and splits a pair before round 1, a walk-in may bring
  a partner, and "Who is here?" ticks a pair at a time. The pair is the unit of the draw: americano
  rotates the opponents (the circle method, so every pair meets every other pair once in P − 1 rounds,
  or P with an odd field; on fewer courts each round is planned ahead, so four pairs on one court meet
  each other once in six rounds), mexicano puts the pairs on courts by the pairs' table and King of the
  Court moves pairs up and down; round 1 takes two complete pairs or more, nobody's pair rests twice
  before every pair has rested once, and the pairs lock at round 1. The table, the ranking and the
  podium rank pairs; the night's chips carry a Fixed pairs chip and count rounds and courts by pairs;
  the Telegram, Discord and LINE cards list one pair a line; and a finalised night moves each partner's
  level once by the pair's place. `events.fixed_pairs` and `slots.pair_id`, the key two seats of
  a pair share. The rules are `src/lib/domain/fixedPairs.ts` (the draw, pure) and `pairSeats.ts` (the
  seats), proven over whole nights of 2 to 8 pairs in `tests/fixed-pairs.test.ts`, on the database in
  `tests/fixed-pairs-night.test.ts`, and as six players on a phone in `e2e/pairs.mjs`. The API and the
  MCP take `fixedPairs` on create and `partner` on join, and every match object carries `pairs`.
  Later: the /americano generator with fixed pairs, and a series or a club slot that keeps them.
- **A switch for each notice kind, quiet hours, and an inbox (10 October 2026, migrations 0093 and
  0094).** The owner's decision D. "Notices" on My matches is one line that says what is set ("6 of 7
  on · quiet 22:00–08:00") and opens to seven switches with one line each (match changes, reminders,
  open spots, club matches, scores and results, the crew, lessons) and quiet hours from and to. Every
  notice to a player goes through one gate (`src/lib/domain/notices.ts`, the rules in
  `noticeKinds.ts`): its row lands in the inbox first, one insert for a whole fan-out, and it is
  delivered only when the kind is on and it is not the player's quiet hours, unless the match starts
  within three hours. A switched-off kind stays in the inbox and is never sent; what quiet hours held
  goes as one short message per channel when they end, from the hourly job. The inbox on My matches
  shows the latest twenty, newest first, in the reader's own language (the rows keep a message key
  and plain facts, never words and never a link), reads itself when opened, reads a match's notices
  when the person opens that match's page (since 15 October 2026), and counts the unread on
  the header as a bell with a number, a link of its own named "2 new updates" (since 12 October 2026:
  a bare "2" on My matches read as a count of matches), which opens the inbox, also when the tap is on
  My matches itself; while it has new notices the inbox sits first on My matches. The bell sits on the
  corner of My matches, or of the ⋯ menu when a role's door stands outside, so it takes no width on a
  phone and is never read as a count for that door. Club matches are off by default (decision B), for push as well as email.
  Every existing player keeps every other notice; the old activity-email switch keeps its meaning as
  a switch on the email channel. Ninety days, then the hourly job prunes. Proven in
  `tests/notice-kinds.test.ts` and `tests/notices.test.ts`.
- **Free court times read from the booking platforms, every 15 minutes (10 October 2026, no
  migration).** The owner's decision (DECIDING rule 35): "scraping at risk of being blocked is
  acceptable, just do it." Built: `src/lib/booking/scrape.ts` is the frame, and three readers
  (`src/lib/booking/adapters/`) read the free courts: Playtomic and MATCHi from their public club
  pages, and Book & Go, the system behind the club apps of Prime Padel, MBP Sports and Sterling, from
  the public feed those clubs' own web apps load. The Padel Society shows free courts only inside its
  app, so it has no reader. Each platform picks its own clubs, at most eight a run, by the booking
  link or, with none, a website on the platform (most directory clubs).
  Today is read every 15 minutes for every club a reader can read, and the next two days about
  hourly. (Until 11 October 2026 only a club people used was read every 15 minutes, and production had
  none on a platform, so every club was read hourly.) Each platform has its own lane at one request a
  second, the run stops before 45 seconds, and the cache keeps three days of free courts in
  `clubs.availability` (`source: "scrape:<platform>"`) as pieces that never overlap. A feed the club
  shared always wins. It rides the five-minute push job on every tick, each tick reading about a third
  of the clubs, so it costs no invocation and no migration. A 401, 403
  or 429, or a challenge, stops the platform: it rests six hours, then a day, then a week. A page
  that changed at two clubs stops its reader until a deploy of new code. A `scrape_off_<platform>`
  row switches a platform off with no deploy, and `SCRAPE_DISABLED` does it at the next redeploy. The
  service board has a line for each platform: fresh, resting until, stopped, or off, and the listed
  clubs the job never reads; a platform with no reader has a "no reader" line. It never signs
  in, never books and never pays; the player books and pays on the platform. The club page, the
  lists and the API show today and name the platform; the best times read the three days (the
  entry on the best times below).
- **The two WhatsApp pains (10 October 2026, no migration).** The owner: "you have to leave the chat
  group; you have to basically log in each and every time you click a link from within the whatsapp
  group." A link in a group opens the phone's default browser, and each browser keeps its own cookies,
  so a player in a browser that did not know them typed their name and became a new record; the
  email code and Telegram, the ways back, reached 2 of 21 players. No link can keep a player inside a
  group. What shipped:
  - **"That's me" signs in** (the owner's decision, DECIDING rule 34). On the match page a browser
    that knows nobody sees "That's me" beside each record of this line-up the rule allows, and on the
    open spot when the name typed is one of them; two taps sign in as that record (the first asks
    "Sign in as Ana?" and sends nothing, and a tap anywhere else takes the question back). A browser
    that already made its own new record folds it into the old one (`mergePlayers`, never `proved`) when
    that record is in the match or crew too, so a crew member not on this line-up joins first and is
    then offered the fold; the old record keeps the better place, and a freed seat goes to the first
    player waiting. Never the organiser or a crew admin, never a record with an address, a phone, a
    chat account, a push device, a coach's book, a claimed club or a public profile, never one that
    organises any match, crew, series or competition, never a coach's student, never a member of a
    group that asks to join, never a record with no part in this match or crew, never one of two of
    the same name ("José" typed two ways is one name). Twenty taps a day per address, three sign-ins
    a day per record. The session it starts shows no personal link until the record proves something.
    `src/lib/domain/thatsMe.ts`, proven in `tests/thats-me.test.ts`.
  - **Counters that find the jar.** Every WhatsApp button that carries a match link tags it `?s=wa`;
    each record made from a name counts its browser class (`newid_ua_*`), its source and whether its
    name was already in the match; each way a browser signs in counts itself (`signin_*`).
    docs/OPERATING.md names them all.
  - **Tell the group.** Once in, a ghost button beside Leave opens WhatsApp's share with the line-up
    ("🎾 Sat 18:00 · Rawai · 3/4: Ana, Bo, Cy · 1 spot") and the match link; never a personal link.
    The link preview under a pasted match link says the same: the names of the players who are in,
    as the page shows them, how many spots are held (no names), the open spots, day and time.
    `src/lib/domain/groupLine.ts`.
  - **Paste the names from the group.** On the organiser's panel: the replies copied from the group
    ("1. Ana 2. Bo", "+1 Cy", one name per line, copied messages, emoji, three languages) become one
    reserved spot per name in one request (`reserveManyAction`), names already in skipped, the names shown before
    anything is held. `src/lib/domain/pasteNames.ts`.
  - **The iPhone's home-screen card** says that links from WhatsApp open in the player's browser, not in
    the icon. Until 12 October 2026 it said "Safari"; the phone's default browser can be Chrome, and no
    Apple source says where a WhatsApp link opens.
  - **The WhatsApp bot, still off:** JOIN (`JOIN-7KQ2` or `JOIN 7KQ2`) takes the seat at once and
    answers with the line-up and three buttons (can't make it, who is in, add to calendar); a pasted
    match link shows the match; a ranged match asks the level with three buttons, not a link; the
    help says what the bot does. The match page offers the hand-off only where a reply can come back
    (`whatsappLinkable`). Two open faults (a second record on the first JOIN, and template buttons
    that open WhatsApp's own browser) are under "Next, in order", item 1.
  - **What was untrue, corrected:** WhatsApp's own browser does not open group links; a number is
    not proof to `foldSameNameRows`; replies inside the window are service messages, and Meta charges
    them past the first 1,000 a month for each business number (US$0.0113 each for a Thai number;
    Meta's pricing page, checked 12 October 2026). Until 12 October 2026 this line said every reply
    was charged from 1 October 2026.
- **The best times, and a court a player books (10 October 2026, migrations 0095, 0096 and 0097).** The
  owner's choice, "Best times + one-tap booking by a player" (DECIDING rule 36). The free courts clubs
  share, or that a platform shows publicly (DECIDING rule 35), are cached on the club's row;
  `src/lib/domain/bestTimes.ts` ranks them: a usual club at a usual time first, then the soonest, one
  time per club and day, at least two hours out, up to the end of the sixth day, inside every free
  stretch. A club's own feed wins over a platform's read, and a platform's read is shown for two hours as on
  the club page. Its times were named as the platform's ("on Playtomic") until 11 October 2026, when the
  owner hid the name in the chat and the chips (the entry on the three court-time decisions below). They show where people
  pick a time: on the create form the club's free times lead the row of time chips, the person's usual
  times after them (a tap fills the day, the hour and the club's zone), and a line under the time says
  whether the club shows a court free then, in the club's hour when the zones differ;
  on /play, below the games while a city has fewer than three open games, "Free courts", each row one
  link to the form; and in a crew's Telegram group or a private chat only when somebody asks ("times?"
  with its question mark in a group, "when can we play?", /times), as one reply a minute at most
  whose buttons make the match and post its card. Each read is bounded: the create form reads the
  feeds of the twelve clubs a person is likely to pick, /play thirty of the city's own clubs first, and
  every read cuts the cache to seven days in the database. On the match page the organiser and the players get,
  until the match starts, "Book this court" (Playtomic and MATCHi open on the match's day; every other platform on the club's
  page), with the court, day, time and length beside it, and "I booked it", which the page, the cards,
  the share text and the API then show as "Court booked ✓ (by Ana)" (`events.court_booked_at`,
  `court_booked_by`; any player takes it back, and a new hour clears it). The club directory gained
  booking links and platforms (Book & Go, PodPlay and The Padel Society are recognised now), which
  migration 0097 writes to the directory's own rows. Nothing books or pays: a player does, in the
  club's own app.
- **Paste your booking (11 October 2026).** The owner booked a court at Warehaus in The Padel Society's
  app and asked: "how do I turn this into a match and match card/link by just copy and pasting the
  link?" A person pastes the booking's link or its share text on the first page or to the bot. Kicksmash
  fills what the paste gives: the club, the day, the time, the length, the court, the price and the
  players, where the words, a screenshot or the link's preview carry them. A price is the cost per player
  only when the paste says so; any other price is the court's total, which the form names in one line
  (since 15 October 2026). The owner's own Padel Society
  link alone gives none of them (see the end of this entry).
  `src/lib/domain/bookingPaste.ts` is the reader. `src/lib/booking/unfurl.ts` reads a pasted link once,
  as a chat app's preview robot reads it (DECIDING rule 35). It skips a platform that rests after a
  block or that a switch holds. On the first page, "Booked already? Paste it" opens the form filled. The
  form marks what the booking left out and what to check, and keeps the match off the venue board. The
  create button holds the players and marks the court booked by the organiser ("Court booked by me").
  In a private chat, the bot says what it read. "Create match" makes the match when the person's own
  words gave the club, the day and the time. The answer then becomes the match's link, ready for the
  WhatsApp group where the fourth player is wanted. "Edit first" opens the same filled form. The Padel
  Society keeps a match's club, day and players in its app's private API, which Kicksmash never calls.
  A session wrote that limit into DECIDING rule 35 on 11 October 2026; the owner has not decided it.
  Its preview gives the match id only, so the words that the person pastes carry the rest. Since the
  audit of 11 October 2026: the WhatsApp thread answers a pasted booking with what it read and the
  filled form (`src/lib/whatsapp/paste.ts`); it does nothing until the owner's WhatsApp number is set.
  The paste box names book@ ("Or forward the confirmation to book@kicksma.sh"). No door puts UTC in the
  form's link any more: the zone is the club's, else the browser's or the chat's, else the form takes
  the person's own. A day or a time the booking did not give keeps the form's own and is marked as not
  the booking's. The bot shows "Create match" only when the paste gives a club, a day and a time. Such a
  paste always shows a booking (`showsBooking`), so the mark "court booked" is true.
- **The one working group repeats itself (11 October 2026, no migration).** The owner's decision,
  option A, "Make the one working group repeat itself", and "Yes, one message each" (DECIDING rule
  37). Production had one group of four or five in Phuket, every full match made by hand with the same
  people. The last one made before this change was EfUa (made on 4 October, played on 9 October). The
  next, TDsv for 17 October, was made by hand on 11 October, about two hours before this change shipped.
  "Play again" on the score panel now asks for the day and the
  time in one control above the button, a week on by default; everything else carries over and a
  crew's match stays the crew's. Each player who sat in the last match gets one "Ana made the next
  game: Sat, Oct 17 18:00 at Warehaus. Are you in?" (`notifyPlayAgain`, sender `playAgain`, kind `crew`):
  one insert for the whole round, the switch and quiet hours respected, the inbox keeps it, the card's
  own one-tap join in Telegram and the public match link everywhere else, and one round per old match
  (the old match's row is locked, the fact `match.play_again` is the record), and only once the match
  was played (started, not called off, scored), and only by its organiser or a player seated from
  before the start, so a stranger who takes a seat in a coming match, or a free seat after the start,
  cannot send it; once a match has started, only its organiser moves its start, so a latecomer cannot
  move it past their own seat. A second tap at the same day and time lands on the game already
  announced, and two taps at once, or a tap beside the hourly job, make one game at a crew's hour. The email
  carries no "get this on Telegram" line, because its ticket binds whoever taps it. "Same time next week?"
  moved from the card page to the score panel under it, renamed "Make it weekly" and made the quieter
  button. The two taps never make two games at one hour, in either order: "Play again" at an hour the
  weekly slot already filled lands on the crew's game and the round announces it, and the slot skips
  an hour "Play again" already filled and tells only the crew members who have not heard of the game.
  Nobody hears about one game twice (`toldOfGame`). A player who already sat in a finished, scored
  match with the organiser, from before its start (a score typed in at the court counts, and so does a
  scored americano), skips that organiser's level range on every door (`admissionAt` in
  `src/lib/domain/playAgain.ts`; rule 21); a confirmed-levels-only match still takes a confirmed level.
  A session added this waiver without a decision; the owner chose to keep it on 11 October 2026.
  No WhatsApp template carries the message yet. After the audit of 11 October 2026: the score panel
  names the next game when it exists already (the game the round announced, or the organiser's own
  game at the same club in the next 14 days, made by hand or not, in the last match's crew or with no
  crew), the control defaults to its day and time, and a tap there lands on it (`nextGameOf`,
  `organiserGameAt`). Outside Telegram the message has one line under the question, and the line
  names no button. The email has an "I'm in" button, and a tap on the push opens the same link: the
  match page at the join step (`?join=1`). A night played again keeps its named courts, and a read
  that fails after the claim takes the claim back, so the round is never spent on nobody.
- **The held place by name (11 October 2026, no migration).** The owner asked: "danny clicks on the
  generic one kicksmash doesn't know its danny and would it let confirm danny's place?" The decision
  was "Yes, two taps" (DECIDING rule 34). An organiser holds a place for a name with no record, for
  example with "Paste the names". A person who types that name on the plain match link gets "Take
  Danny's held place". The first tap asks, and the second tap confirms the place with the personal
  link's own write, so the organiser hears "Danny confirmed". The place has no email and no phone, and
  no other record of the name sits in the match (`src/lib/domain/heldByName.ts`). The personal link
  changed the same day: a viewer who is in the match already gets no "I'm in" on another person's
  place. After the audit of 11 October 2026, the offer also shows on a full match with a waiting list,
  in the name field of the waiting list, and to a browser that knows a record of the name, in place of
  its one-tap Join. A full match with a closed waiting list shows no join, so only the personal link
  fills the place there. The Go key sends no join while the offer is on the screen. The web's join
  (`joinAction`) refuses a join that puts a second record of the name beside the place. Under the
  offer, a different person of the same name reads how to get in: a last name on My matches.
  Since 12 October 2026 every other door keeps the place too, through the rule every door asks
  (`joinWithPolicy`, `tests/held-name-doors.test.ts`). `join_match` in the API and MCP refuses, as
  the web does, and writes nothing. A chat takes the place for the account's own record: the Telegram
  ✅ and "+1", the Discord and LINE buttons and the WhatsApp JOIN. A chat's link to the match page
  opens a browser that does not know the player, where a take would make a second record. The answer
  says whose place it was: "Not Danny? Tap ❌ and tell the organizer." A session chose this after a
  review; the owner has not decided it (DECIDING rule 34).
- **The held place keeps a past player's record (11 October 2026, no migration).** The owner asked
  whether a held place may keep the record of a player who played with the organiser before, after
  Danny got a second record; the answer was "Yes, keep the record" (DECIDING rule 34). The open spot
  offers "Played with you", and a held name with one past player of that name offers "Keep Danny's
  matches" (`src/lib/domain/heldRecord.ts`). The personal link signs a browser that knows nobody in as
  that record, by name, inside the "That's me" limits; a record with an email or Telegram proves
  itself first, a record with another limit is sent to the organiser, and any other record is refused. A join by the record takes its own place, and a plain join of its name from a browser that knows nobody is refused. A place with a phone keeps no record. A session by name gets no manage link. The same
  day: "That's me" signs in a record that organised only past matches, and "Are these yours?" moves
  no crew's admin role by name, shared match or not. Danny's two production records became one on 12
  October 2026: the newer record was merged into the older one, and production holds one Danny (checked
  through `/api/admin/sql` on 12 October 2026).
- **The past player's question, before and after the match is made (12 October 2026, no migration).**
  The owner asked: "As organizer before and after creating the match should be able to select from
  players they played with before, and if manually typed and it matches a previously played person it
  should ask if its this person to avoid creating dupes." The create form shows "Played with you"
  under the names, as the open spot does. A typed name that a past player carries asks "Is this Danny,
  who played with you on Sep 13 at Kross Padel?" before its place is held, on the three web doors: the
  create form, the open spot on the match page and "Paste the names". Two past players of one name ask
  "Which Danny is it?". Each answer stays on the screen with "Change" until the place is held. Only a
  Yes and a chip go to the server, as the name, the day and the club the question showed, and the
  server finds the record again (`recordForAnswer`; `src/lib/domain/pastAsk.ts`): no id reaches the
  browser. "No, someone new" holds the place by name. The Telegram bot's match from a pasted booking
  holds its names with no question yet; book@ and WhatsApp hold no names.
- **The count line and the court's undo (12 October 2026, no migration).** The line beside "3/4
  players" names the held places: "1 place held for Alberto", or "1 spot left · 1 place held for
  Jordi", and past three it counts them (`countParts` in `src/lib/domain/groupLine.ts`). The owner's
  TDsv read "FULL", "3/4 players" and "No spots left" together. Beside "Court booked ✓ (by Erik)" the
  way back is "Undo", named "Undo: mark the court as not booked" ("Снять отметку" in Russian), where
  a button that said "Not booked" read as a second status.
- **Two more doors for a booked court (11 October 2026, no migration).** The owner's decisions of
  11 October 2026 (DECIDING rule 36). A person forwards a booking confirmation to book@kicksma.sh, or
  writes the booking in a mail. One answer comes back from book@ with the club, the day, the time and
  the length that Kicksmash read, and the link to the filled match form. The court, the price and the
  players go only in the link, so a faked sender cannot make book@ repeat a stranger's words. Nothing
  else happens: no match, no held name, no sign-in link, no link of the mail opened, and nothing of the
  mail is kept. A robot, a bounce, a list, our own domain, a reply that quotes the answer and a mail
  with no booking get no answer. One address gets three answers and thirty reads a day, and book@
  sends thirty answers a day in total (`src/lib/booking/bookMail.ts`). A pasted invitation that a platform makes for strangers (a Padel
  Society invite, a Playtomic match, a MATCHi share) now goes onto the match. The match page shows
  "Join this booking on The Padel Society", so the fourth player can join the booking in the
  platform's app too. The query string goes, and a PodPlay invite or an email's link never shows
  (`madeToShare` in `src/lib/booking/platforms.ts`). The create form shows the whole link, and the
  organiser can take it off with "Don't show this link". The bot's "Create match" carries it too. "Play
  again" does not copy it to the next game.
- **A booking screenshot fills the match form (11 October 2026, no migration).** The owner's decision
  of 11 October 2026 (DECIDING rule 9). The paste box on the first page has "Add screenshot". The
  browser makes the picture smaller and sends it. The AI model reads it once, and the match form opens
  with what it read. The typed words win over the picture. Kicksmash keeps neither the picture nor the
  reply. One address gets five reads a day, and all people together get twenty. No read goes past the
  owner's monthly cost cap, or while Anthropic refuses the key. Then the box says so in one line, and
  the text still works (`src/lib/booking/screenshot.ts`). The privacy page names the screenshot under
  Anthropic.
- **Three court-time decisions (11 October 2026, no migration).** The owner answered "Which court-time
  changes do you want? Choose any." with three answers (DECIDING rules 5 and 36).
  - **Playtomic's checkout, filled in.** On the match page, "Book and pay on Playtomic" opens
    Playtomic's own checkout with the court, the start and the length filled in, when a read at most 90
    minutes old listed exactly that start and length; else the club's day page, as before. The reader
    keeps the exact starts Playtomic lists (about 1 KB a club, in the cache, read only by the match
    page), and each read of a club page checks that its script still builds the link. While it does
    not, the reader keeps no starts, so the match pages give the day page from the next read of each
    club, within 90 minutes at most, and a counter and the service board say so. The link holds only a
    court the read named, so the page always names the court beside the button. The player's browser
    opens the link; our server never does (`src/lib/booking/prepare.ts`, `offers.ts`).
  - **The weekly best times.** 24 hours before a crew's weekly slot, the bot posts up to three courts
    free near the slot in the crew's own Telegram group, once, silently, unasked. A button makes the
    match, or joins the crew's game when it is on already; a time that overlaps a game of the crew gets
    no button, so a tap never gives the crew two games at once. Nothing when no court is free or the
    court is booked; /quiet stops it (`src/lib/telegram/weeklyTimes.ts`).
  - **No platform's name in the chat or the chips.** The "times?" answer, the weekly post, the time
    chips, the line under the time and /play name no platform. The booking step and the club page's
    source line still do (`src/lib/domain/bestTimes.ts` carries no name).
- **Face ID or a fingerprint, from any browser on the phone (12 October 2026, migration 0099).** The
  owner's decision, DECIDING rule 39: "Passkeys", "Only a proved browser", "Own record only". A link in
  a WhatsApp group opens the phone's default browser, which may not be the one that knows the player,
  and six of the eight active players have an email, so "That's me" never helped them. After a join, a
  quiet card offers "Remember me on this phone"; the phone's password manager keeps a passkey, and
  every browser on the phone can use it. "Played before?" now stands open under the name field of the
  match page's join form, with "Sign in with Face ID or fingerprint" first and the email code after it,
  and a closed line under the line-up, "Played before? Sign in", opens that form and its help, so a
  player seated from another browser needs no Join. A sign-in signs in the passkey's own record and
  folds the new record that browser made into it, only when nothing proves or reaches that record and
  the names agree; a session by name never saves one.
  My matches shows the same quiet card, with its own "Not now", until the record has a passkey, then
  lists "Phones that remember you" with Remove and a small "Also remember this phone". Kicksmash keeps a
  public key, a label and two dates, never a face, a fingerprint or a password (`/privacy`), and the
  download of a player's data lists each phone by its label and dates. `src/lib/domain/passkeys.ts`,
  `src/lib/passkeys/webauthn.ts`, `src/actions/passkeys.ts`; proven with real signatures in
  `tests/passkey-ceremony.test.ts` and with Chromium's virtual authenticator in `e2e/passkeys.mjs`.
- **The AI key may name its workspace (15 October 2026).** `ANTHROPIC_WORKSPACE_ID` goes with every Messages API call as `anthropic-workspace-id`, and an answer that says the key has no workspace counts as a refused key, so its listening items stay new or come back (`anthropicHeaders`, `keyRefused`, `restoreRefusedItems` in `src/lib/ops/anthropic.ts`; `tests/anthropic-workspace.test.ts`).
- **pg_cron's run log stops growing (15 October 2026, migration 0101).** The owner's decision: "Yes,
  weekly cleanup (Recommended)". pg_cron kept one row for each run of each job, 456 a day, and nothing
  deleted them: 18,071 rows and 7.27 MB, the largest relation in the database. The job
  `kicksmash-cron-log-cleanup` now deletes the rows that ended more than 14 days ago, each Sunday at
  03:17 UTC (docs/OPERATING.md, "Cron jobs").
- **The match page on a phone, and the organiser's screens (15 October 2026, no migration).** All 11
  joins in production came through the web match page. The fixed "Join this match" now sends the open
  name form when a name is in it, through the form's own checks (the name, the held place, the level);
  before, a second tap did nothing. The venue line takes two lines before it cuts, so the court shows
  ("WAREHAUS.club · Co…" at 390 px). A match under way says "Started 1 hour ago". "Leave waitlist" asks
  "Leave the waiting list?". The score form starts empty, with 6 and 4 as placeholders, and "Save score"
  waits for typed numbers (`typedSets` in `src/lib/domain/scores.ts`), because an untouched 6-4 could be
  saved as a real result. "Book this court" goes at the start, and the club is not read for it then;
  "I booked it", the booked line and "Undo" stay until the end. After a join, "Your level?" waits while
  "Stay updated" still asks for a channel. For the organiser: a pasted price fills "Cost per player"
  only when it says it is per player ("/person", "pp", "each", or "Price per person:" before it); a
  bare price is the court's total, one
  line under the form and in the bot's and the thread's answer, and never the match's cost (it once read
  "1,600 THB per player"). Opening a match page marks the viewer's notices about that match as read
  (`markMatchNoticesRead`, one indexed update after the response), so the bell counts only what is
  unseen. The share page names the day, the time, the club and the court under "Your match is live".
- **The owner's decisions of 15 October: whom Kicksmash cannot reach, and "Sign in as Danny?" (no
  migration).** 13 of 16 past matches never filled, and the free-seat offer reaches only a past partner
  with a channel (7 records of 21). The organiser's panel now says "Kicksmash can't reach Tim and
  Adrian. Send them the link." with the match's WhatsApp share: the offer's own past partners (a match
  that ended in the last 60 days) whom it cannot reach, first names only, only for the organiser, only while a place is open and
  before the start (DECIDING rule 7, `src/lib/domain/unreached.ts`). A browser that knows nobody and
  types the name of a player seated or waiting in the match no longer makes a second one: Join asks
  "Danny is in this match. Sign in as Danny?" with "That's me", or for a record with an email or a
  passkey its own doors, and "I'm a different Danny" joins as typed; `join_match` with a name and no
  token answers 409 `name_seated` (DECIDING rule 34).
- **"Stay updated" stays on the screen after a join, says only what went, and counts its asks (15
  October 2026, no migration).** It is the one ask that makes a new player reachable. On Chromium
  (Android) the page's scroll anchoring moved the page 310 px at the join, and the card ended above the
  screen. The match page now turns anchoring off, as the share page does, except on a live night. From
  the third seat on, and on the waiting list, the card still went into the hero above the screen, on
  every phone. Now a card that appears above the screen at a join scrolls into view, and a reload never
  moves the page. The card, the invitation page's form and the email row say only what went: "Calendar
  invite sent" for a seat, "Your link is in your email" on the waiting list (the invitation follows a
  place), and no mail line for a session by name. "Send it again" refuses a session by name, because
  every invitation carries the personal link (DECIDING rule 34 already said so; this door did not ask).
  Two other doors still mail the link to an address that such a session typed ("Open, small", item 7).
  `stay_asked` and `stay_linked_email` (a save on the card itself) count the card beside
  `stay_linked_telegram` and `stay_linked_whatsapp` (docs/OPERATING.md).
- **The right day and the right time (15 October 2026, no migration).** The match page counts calendar
  days in the match's own zone: TDsv, on Saturday at 11:00 in Phuket, read "Starts tomorrow" from
  Thursday 11:00 to midnight, and now reads "Starts in 2 days" (`relativeTime` with `tz` in
  `src/lib/dates.ts`). Under one day it still counts hours. The create form opens on the organiser's
  usual time from the matches that people played, with two or more taken seats
  (`getPlayerTimePatterns`, one read of those matches' seats); before, Erik's form opened on Fri 18:00
  from three try-outs that nobody joined. An organiser with no such match keeps the chips of the whole
  history. The keyboard's Go key on the name, the venue or the court moves to the next field and never
  creates a match (`enterMovesOn` in `CreateEventForm.tsx`): 14 of the 27 matches of the 60 days before
  started exactly at the default time. Go with the venue list open picks the first suggestion, but the
  club that the field already holds is no pick (`venueGo` in `VenueCombobox.tsx`): a returning
  organiser's own club is filled in, and one Go there moves on to the court.
  Two other doors still mailed the link to an address that such a session typed; the owner's decision of
  16 October 2026 closed them (below). `stay_asked` and `stay_linked_email` (a save on the card itself)
  count the card beside `stay_linked_telegram` and `stay_linked_whatsapp` (docs/OPERATING.md).
- **The owner's four decisions of 16 October 2026 (no migration).** An address that a session by name
  types is kept only once the 6-digit code it was sent comes back, and the session is then a full one,
  so no personal link reaches an address nobody proved (D3, DECIDING rule 34; "Open, small", item 7).
  "Danny is in this match. Sign in as Danny?" shows only Danny's own doors: the email code if he has an
  address, Telegram if he linked it, Face ID if he saved a passkey, and none for a record with no proof
  (D4). A player whose join request waits gets the "Stay updated" card, and the organiser's answer and
  the move up from the waiting list reach a player with no working address on Telegram, WhatsApp or
  push, once (D5, DECIDING rule 33). On the plain link, a name on the organiser's "Kicksmash can't reach
  Tim" list asks "Played before as Tim? Sign in as Tim." and "That's me" signs that record in, so Tim
  makes no second Tim; the line says "they sign in as themselves" when that is true of every name on it
  (D6, DECIDING rules 7 and 34).
- **The privacy page names the unreached line (the owner, 16 October 2026; no migration).** Under
  "What we keep", `/privacy` now says that an organiser can see the first name of a past partner from
  the last 60 days whom Kicksmash cannot reach, and that Kicksmash cannot reach them, while their match
  has a place open (DECIDING rule 7). The 60 comes from `PARTNER_WINDOW_MS` through `legalValues`, and
  `tests/legal.test.ts` checks the line in three languages. The line says that an email counts only
  while its switch is on, because `channelOf` names a player who switched it off. The review of the
  same day found that the `km_by_name` line named only "That's me", while "I'm in" on an invitation to
  a place kept for a past player's record sets the cookie too: the line now names both, and the test
  fails when a third caller of `markSignedInByName` appears. The page's date is 16 October 2026. The
  owner also kept the reading of D5: each answer reaches a player once, by its own email where the
  address works, else on the first channel they gave.
- **The owner's decisions of 28 October 2026 on sessions (no migration).** Three answers, built in one
  change.
  - "A session by name ('That's me') can delete that player's account today, and the deletion cancels
    that player's upcoming matches. Close this gap?" The answer: "Close it (Recommended)". A session by
    name that proved nothing gets `proof_required` from `deleteMyAccountAction`, the one door that
    deletes an account (no API route, bot command or MCP tool does). My matches shows no button to it,
    only why, and the doors on the page that prove the player: the email code, Telegram.
  - "May a sign-in last one year after the last visit, and may every browser get 'Not you? Sign out'?"
    The answer: "Yes, both (Recommended)". A full sign-in gets a new year at most once in 30 days, from
    the day `km_has_id` carries, with no read (`POST /api/me/session?do=renew`, `session_renewed`). A
    sign-in by name still ends a year after it began: its mark and its restore seal carry the end, so
    the restore no longer gives it a new year. "Sign out on this browser" stands under the player's
    name on My matches and at the foot of the header's ⋯ menu ("Signed in as Tim", only while the menu
    is open). It removes the cookies, the restore seal and this browser's push subscription, stamps
    the browser (`km_signed_out`), and from then on every restore seal and manage cookie the browser
    held from before opens nothing. The personal link, and a home-screen icon that opens it, still
    sign a signed-out browser in; the confirm and the privacy page say so, and the personal-link page
    has no sign-out. The privacy page says it in three languages, and `tests/legal.test.ts` holds each
    new promise.
  - A fact of DECIDING rule 34, found in review: every notification carries the personal link, so a
    session by name that proved nothing gets no notifications (`proof_required`, no reminder switch).
  - The counters that come with them, each request's in one statement after the answer:
    `view_anon_<class>`, `view_known_<class>`, `signin_ua_<class>`, `session_dead`, `passkey_shown`,
    `passkey_not_now`, `session_renewed`, `signout` (docs/OPERATING.md, "Finding the jar").
  The other two questions of the day, the sign-in in a browser that has never seen the player and the
  saved passkey above the keyboard, are separate changes.
- **The passkey above the keyboard in the player's own name field (28 October 2026, no migration).** The
  owner's decision, DECIDING rule 39: "May the player's own name field offer a saved passkey above the
  keyboard ('Tim', then Face ID)?" — "Yes, own name field (Recommended)". In a browser that knows
  nobody, the phone shows the player's name above the keyboard, and Face ID signs the browser in as that
  record. It is not the declined design A ("Then it should be B"): a passkey and Face ID prove the
  player, and a phone model does not. The own name field carries the token, in the match page's join
  forms, the create form, a crew's join and a competition's entry; another person's field never does.
  The partner's own name on a competition's claim card carries it too. The page carries its own
  ten-minute challenge and its end, so a view costs no read and no call (`src/lib/passkeys/page.ts`,
  `src/lib/passkeys/autofill.ts`, `src/components/PasskeyAutofill.tsx`). The browser never hands the
  phone a challenge in its last 30 seconds: a tap gets new options instead. Each saved passkey tells the
  player: "A phone now signs you in: iPhone, Safari. Not you? Remove it on My matches." The inbox always
  keeps it, and the own channel gets it while "Match changes" is on; the privacy page says so.
  "Remember me on this phone" asks `getClientCapabilities()` first, because Chrome on iOS 26.2 may say
  no to the older check. Counter `signin_passkey_autofill`; kill switch `PASSKEY_AUTOFILL=off`
  (docs/OPERATING.md), which also ends the autofill on pages that were open before it. **Still owed: a
  test on a real iPhone.** Safari, Chrome on iOS, a private tab and the home-screen icon, on iOS 17, 18
  and 26. It must show that "given-name webauthn" keeps the browser's own first-name suggestion and
  shows the passkey, that Join still works, and that the button "Sign in with Face ID or fingerprint"
  works while the autofill waits. It must also show whether iOS offers the passkey on the first tap
  when the request starts after that tap (a page whose challenge ran out), and that "Remember me on
  this phone" shows in Chrome on iOS 26.2. The browser suites prove it in Chromium only.
  **The new-phone notice keeps the gate (option B).** The question "May a player switch the new-phone
  notice off?" named two sessions that are not the player's: a shared phone and a forwarded link. The
  owner's rule of the same day, "assume phones are never shared. period", settles the first: no shared
  phone needs option A. A session decided the second on 28 October 2026: the notice keeps the gate of
  "Match changes" (one gate, no new code). A personal link is a full sign-in, so whoever holds a
  forwarded one can do all that the player can do on My matches, and the way out is "Reset link". A
  reset does not remove a passkey, but My matches lists every passkey under "Phones that remember you",
  with Remove, on the same page. Option A would add a path beside the notice gate for one rare case. The
  owner can ask for option A: the own channel then always gets the notice, with quiet hours, also with
  "Match changes" off (DECIDING rule 39).
- **The device hint, part 1: the key, its table and its duties (the owner, 28 October 2026; migrations
  0102 and 0103).** The question was: "Which design do you want for the sign-in in a browser that has
  never seen the player?" The answer was: "I like A, obviously the fingerprint needs to include more than
  just iphone model… is it really just the iphone model? Then it should be B." B is the scoped device
  hint "Welcome back, Tim?". A was the automatic sign-in by fingerprint, which the owner declined because
  two iPhones of one model look the same. Part 1 keeps the key and asks nothing yet. At a join of the
  player's own record and at every sign-in into a record, the browser sends what it tells every site
  (our own few lines, no library) in the request of that act. The server checks each value and makes an
  HMAC-SHA256 key with a secret derived from `SESSION_SECRET` for the purpose `device-hint:v1`. It keeps
  the key, a label ("iPhone") and two dates in `device_hints`, three a player at most, and never the
  values. It keeps nothing for a browser in a European time zone, or while `DEVICE_HINTS` is `off`. A
  merge moves the keys, an account deletion deletes them, the disposal job ignores them, and the hourly
  job deletes a key one year after its last use. The download of a player's data lists the label and the
  two dates. My matches lists the phones under "Phones we recognise", with "Forget this phone", and the
  operator's read-only door never sees a key. `forgetDeviceHints(db, playerId, key?)` also serves
  "Sign out on this browser" (the entry "Design B on today's main" below). Counters: `hint_saved`,
  `hint_collide`, `hints_pruned`. The privacy page says what the key is, why, how long and how it goes, in three languages; "No tracking"
  now reads "No tracking across other sites", and the page's date is 28 October 2026. Its line on the
  law now names the legal basis: our agreement with the player for the app, and our legitimate interest
  for the key. The lasting objection to the key is part 3, "Don't recognise my phones".
  `src/lib/domain/hintSignals.ts`, `src/lib/domain/deviceHints.ts`, `src/lib/deviceHint.ts` and
  `src/lib/deviceSignals.ts`; proven in `tests/device-hints.test.ts`, `tests/device-hint-doors.test.ts`,
  `tests/legal.test.ts`, `tests/readonly.test.ts` and `e2e/passkeys.mjs`. Part 2, the question itself,
  is the next entry.
- **The device hint, part 2: the question "Welcome back, Tim?" (the owner, 28 October 2026; DECIDING rule
  40; no migration).** The question was: "Which design do you want for the sign-in in a browser that has
  never seen the player?" The answer was: "I like A, obviously the fingerprint needs to include more than
  just iphone model… is it really just the iphone model? Then it should be B." A browser that knows
  nobody opens a match that is not called off and has not started. The page reads one row at most: does
  a record that it shows (a seat, a waiting place, a held place that keeps a record) have a key from the
  last year? Only then does the browser send its values, once for each match in a tab. For exactly one
  record of that key, the page asks "Welcome back, Tim?". "It's me" signs in as "That's me" does, with
  the same rule, rates and session by name. A record that can prove itself gets only its own doors: the
  email code, Telegram, Face ID. "Not me" deletes the key of that phone from that record; the record's
  next join or sign-in from a phone with the same key keeps it again, so the question can come back. No
  record, two records, the organiser's unreached list, a crew member with no place and a "second Tim" (a
  record made in the last seven days that has never sat beside another person in a match that has
  already started) get no question. The answer is a first name, never an id, a key or a value. Twenty
  questions a day for one address, 100 a day for one match, and "It's me" takes both before it reads
  anything. A browser in a European time zone writes nothing to the tab and sends nothing. Counters: `hint_asked`, `hint_doors`, `hint_yes`, `hint_no`, `hint_ambiguous`, `hint_fresh`. The
  privacy page says that the browser sends its values once and that we keep nothing of them, that we ask
  only about a name the page shows, and that "Not me" deletes the key; the cookie line names "It's me".
  `src/lib/domain/deviceHintAsk.ts`, `src/actions/deviceHints.ts`, `src/components/WelcomeBack.tsx`;
  proven in `tests/device-hint-ask.test.ts`, `tests/device-hints.test.ts`, `tests/legal.test.ts` and
  `e2e/device-hints.mjs` (a join in one browser; no question in a second while the record has only a
  match to come, and none in Europe/Madrid; then a seat beside Kai in a match under way, and the
  question and "It's me" in a second browser with the same screen, language and zone; nothing in a
  third with another screen; the question in Russian and Spanish).
- **The device hint, part 3: "Don't recognise my phones", and a phone is never shared (28 October 2026;
  in migration 0102, which has not reached production).** The owner's decision of the day was: "Which
  design do you want for the sign-in in a browser that has never seen the player?" The answer was: "I
  like A, obviously the fingerprint needs to include more than just iphone model… is it really just the
  iphone model? Then it should be B." B saves the key with no tap, under our legitimate interest, so
  Thai law (PDPA s.32) gives the player a right to object for good. A session decided the switch under
  standing order 3: it is routine compliance, and it costs least before the migration ships. The column
  `players.hints_off` is in the same migration as the table (0102, made again with drizzle-kit; the
  grants of the read-only role, 0103, show the column). On My matches, under the remembered phones,
  "Don't recognise my phones" deletes every key of the player at once, keeps the moment, and counts
  `hint_objected`. The switch shows with no phone too, while the deployment keeps keys (`DEVICE_HINTS`
  not `off`), so a player can object before the first key and after "Forget this phone" took the last one.
  While it is on, the save of every door inserts nothing, inside its own one statement, with no extra
  round trip, and "Welcome back, Tim?" never offers that record. Off, the next join or sign-in keeps a
  key again. The mark covers one record. A join from another browser that knows nobody makes a new record
  with its own key, until a sign-in there joins the two records. To link them without that sign-in, we
  would have to recognise the phone, and that is what the player objected to; the privacy page says
  this limit. A session by name that proved
  nothing cannot change it either way, and the block says why and names the door below that proves the
  player. That follows the owner's answer to "A session by name ('That's me') can delete that player's
  account today, and the deletion cancels that player's upcoming matches. Close this gap?": "Close it
  (Recommended)". A merge keeps the mark when either record has it, with the earlier moment, and then
  keeps no key. An account deletion clears it. The download lists it (`player.hintsOff`). The privacy
  page names the switch where it names the key, says that it lasts until the player switches it off, and
  says it in the rights and on the short page, in three languages. The same day the owner set a standing
  design assumption: "assume phones are never shared. period" (DECIDING, "A phone is never shared"). Two
  answers of the day meet it. To "May a sign-in last one year after the last visit, and may every
  browser get 'Not you? Sign out'?" the owner said "Yes, both (Recommended)". The person who taps "Not
  you?" holds their own phone, so a key saved during that session belongs to the holder, not to the
  record. So the sign-out forgets that browser's key from the record it leaves (`forgetDeviceHints`, one
  delete; the entry "Design B on today's main" below). The personal link still signs a browser in after
  the sign-out, as before. To "May the player's own name
  field offer a saved passkey above the keyboard ('Tim', then Face ID)?" the owner said "Yes, own name
  field (Recommended)". That change left the question "May a player switch the new-phone notice off?".
  The question named a shared phone and a forwarded link. No shared phone needs option A, so the
  shared-phone half adds no reason for it. A session decided the forwarded-link half: the notice keeps
  the gate (option B; the entry "The passkey above the keyboard" gives the reasons, and the owner can ask
  for option A).
  `src/lib/domain/deviceHints.ts` (`setHintsOff`, `saveDeviceHint`, `capHintsSql`),
  `src/lib/domain/deviceHintAsk.ts` (`hintCandidates`), `src/actions/deviceHints.ts` (`hintsOffAction`),
  `src/components/MyHints.tsx`; proven in `tests/device-hints.test.ts`, `tests/device-hint-doors.test.ts`,
  `tests/device-hint-ask.test.ts`, `tests/legal.test.ts` and `e2e/passkeys.mjs`.
- **Design B on today's main: the sign-out forgets this phone's key, and the passkey above the keyboard
  keeps it (28 October 2026; no migration beyond 0102 and 0103).** Design B now stands on the two
  changes that main merged the same day, "Safer sign-in" and "The passkey above the keyboard", each with
  its own decision of the owner. "Which design do you want for the sign-in in a browser that has never
  seen the player?": "I like A, obviously the fingerprint needs to include more than just iphone model…
  is it really just the iphone model? Then it should be B." "May a sign-in last one year after the last
  visit, and may every browser get 'Not you? Sign out'?": "Yes, both (Recommended)". "May the player's
  own name field offer a saved passkey above the keyboard ('Tim', then Face ID)?": "Yes, own name field
  (Recommended)". "A session by name ('That's me') can delete that player's account today, and the
  deletion cancels that player's upcoming matches. Close this gap?": "Close it (Recommended)".
  "Sign out on this browser" sends the browser's device values (none in a European zone), and the same
  request deletes the key of this browser from the record that signs out, in one statement, counted as
  `hint_signout` in the one upsert of `signout`. It is the one exception to "The sign-out changes nothing
  else" (DECIDING rule 34), for the reason in "A phone is never shared": Bob taps "That's me" on Tim's
  seat on Bob's own phone, and Tim's record no longer keeps Bob's phone. The server finds only the key
  that the values at the tap make. A key that the phone kept under other values (another zone, other
  languages, another text size, or a European zone now) stays until "Forget this phone" or the yearly
  prune. The privacy page says so, with that limit, in three languages, and a unit test proves the limit.
  `passkeySignInAction(answer, o)` takes one options object: `o.via` ("autofill")
  names the counter, `o.hint` carries the device values, so the autofill's sign-in keeps the key as the
  button's does. Every sign-in door counts with its user agent in one statement and keeps the hint
  after it; "It's me" counts `hint_yes` in that statement, and the question's counters share one upsert.
  On My matches, the locked "Don't recognise my phones" and the refused deletion name the same doors
  that prove a session by name. The new-phone notice keeps the gate (the entry "The passkey above the
  keyboard"). `src/actions/identity.ts` (`signOutAction`), `src/lib/deviceHint.ts` (`forgetKeyOf`),
  `src/components/SignOut.tsx`, `src/actions/passkeys.ts` (`PasskeySignInOptions`); proven in
  `tests/device-hint-doors.test.ts`, `tests/legal.test.ts` and `e2e/device-hints.mjs`.
- **The device key, second version: a test picture, a 3D shape, a test sound and five settings, and a
  report in counts (the owner, 30 October 2026; DECIDING rule 40; no migration).** The decision of 28
  October 2026 stands: "Which design do you want for the sign-in in a browser that has never seen the
  player?" The answer was: "I like A, obviously the fingerprint needs to include more than just iphone
  model… is it really just the iphone model? Then it should be B." So the key still only leads to
  "Welcome back, Tim?", never to a sign-in. On 30 October a session advised against more values: they add
  little, and they change the key at every iOS update. The owner's answer was: "I want them anyway." The
  browser now also sends a short SHA-256 hash of a small fixed drawing, of the WebGL renderer with a
  small 3D drawing, and of a short sound rendered offline, never the picture or the sound. It also sends
  the contrast, inverted colours, reduced transparency, hour cycle and locale settings. Each is
  optional and "na" when the browser lacks it or a test throws. A test still running at the 150 ms
  limit makes the whole read null, so the act sends no values and no key holds a timing. Every
  platform runs the three tests, the iPhone, the iPad and Safari too. A review of 30 October found that
  Safari may add noise that differs between the browsers of one iPhone, and a session first made the
  iPhone run no test. The owner was asked: "On an iPhone, Safari may add random noise to the drawing,
  3D and sound tests, so one iPhone could give a different key in Safari, Chrome and the home-screen
  icon. What should the iPhone do with the three tests?" The owner answered: "On everywhere". The
  known risk: one iPhone can then keep several keys, and the question, "Not me" and the sign-out's
  forget can miss there. The report shows it: on `?label=iPhone`, keys near three for each player with
  almost no shared key suggest noise (DECIDING rule 40). "It's me" and "Not me"
  send exactly the question's values. A European browser still runs nothing. The key is `v2|…`;
  production held no key, so none had to match. The read is asynchronous now, and every door waits
  for it. The owner also asked: "check the digital footprints
  for all current users, how many uniques and how many are indistinguishable?" On 30 October production
  held 0 keys for 21 players, so the answer was "none yet". `GET /api/admin/hints-stats` answers it from
  now on, in counts only: players, keys, distinct keys, unique and shared keys, the players who share a
  key, and the group sizes, with `?label=iPhone` for one label. Its counts are exact: with few keys,
  they and the read-only door together show which named players share a key, so the two are never
  joined, and hiding small groups is the owner's decision. The privacy page names the test picture,
  the 3D shape and its graphics chip, the test sound and the clock settings, says that they never
  leave the browser, that every browser outside Europe runs the tests, an iPhone too, and none in a
  European time zone, and that an update of the phone's system or browser can change the key; its date is 30 October 2026. `src/lib/deviceSignals.ts`, `src/lib/domain/hintSignals.ts`,
  `src/lib/domain/deviceHints.ts` (`hintKeyStats`), `src/app/api/admin/hints-stats/route.ts`; proven in
  `tests/device-hints.test.ts`, `tests/hints-stats.test.ts`, `tests/legal.test.ts` and
  `e2e/device-hints.mjs` (an iPhone's words in Chromium send three hashes, the same in a second browser).

## The finish line

Proposed to the owner on 24 September 2026: Kicksmash is finished when each stakeholder in
`docs/VISION.md` is won for real, and again after that, by the vision's own test. Code alone does not
reach it; people using the app do.

| Stakeholder | Won when | On 24 September 2026 | On 11 October 2026 (production) | On 15 October 2026 (production) |
|---|---|---|---|---|
| Player | the match is played | 13 past matches: 3 filled, 3 of 3 scored; 10 never filled | 16 past matches: 3 filled, 5 with a score | 16 past matches: 3 filled, 5 with a score |
| Coach | a student books, moves or cancels, and the coach typed nothing | 2 lessons | 2 lessons, both from the web; none since | 2 lessons, both from the web; none since 14 September |
| Organiser | a weekend of 200 players runs from a phone | a rehearsal only | a rehearsal only: no serious tournament in production | a rehearsal only: no serious tournament in production |
| Club | an off-peak court hour is filled from Kicksmash | 0 live, 66 listed, 1 refused test claim | 0 live, 67 listed, none refused (the test claim was handed back to the directory) | 0 live, 67 listed, none refused |

None of the four is won yet. What stands between here and there, in order: real use through each loop (a tournament weekend, a
coach whose students book themselves, a club, crews that enter scores); reach (7 of 21 player records
have a channel on 15 October 2026, and WhatsApp one-to-one waits on the owner's Meta account and number); the
security steps at 100 real players (`docs/OPERATING.md`). Recommended with it: no new large feature
until real use asks for one.

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
   environment is set. What is left: the two faults in the code (below), and the owner's account
   steps, which are a Meta business portfolio, a phone number that is not
   *currently registered* on WhatsApp — a new number, or an existing one whose WhatsApp account is
   deleted first, which cannot be undone and takes that account's chat history with it — and the
   webhook pointed at `/api/whatsapp/webhook`. That is the owner's to create, and nothing reaches a
   real person until they do. A private thread carries the whole of a player's
   loop: reply buttons to take or give up a spot, a list message to pick a time, Flows for a form the
   Mini App cannot match, the court as a map pin, a template for a reminder outside the window. The
   group part is carried by a person rather than a bot — the organiser pastes a link into the crew's
   chat, and each tap opens a conversation the player started, which costs nothing to receive, opens
   a 24-hour window, and is not counted against the 250-a-day limit, because that limit rations only
   the messages we start. Our replies in that window are service messages: the first 1,000 a month for each business number are free, then US$0.0113 each for a Thai (+66) number (Meta's pricing page, checked 12 October 2026; docs/OPERATING.md). Since 10 October 2026 the JOIN message takes the seat at once. That first message also hands over the phone number with permission, so nothing has to be
   collected in advance. The thread is not a card channel. A chat that the crew already has never
   gets a bot. Meta's Groups API makes only the business's own groups, and players join them by an
   invite link. Such a group holds eight people at most, needs an Official Business Account, and
   allows no edit of a message ("Next, in order", item 6). What the thread loses is real and worth
   saying: nobody sees "three of four" without tapping, and the group cannot
   enter a score. A separate adapter: the `CardChannel` interface does not fit the thread and must not
   be bent to it.
   The piece of code found missing on 25 September 2026 is built (26 September, under Built): the
   match's changes, a free spot, the score ask and the result card now reach a WhatsApp player as four
   utility templates, and a send that cannot go falls through to email and push. Beside the two faults
   below, what remains is the owner's, in this order: create the four templates in the three languages, with
   `node scripts/whatsapp-templates.mjs --create --yes` (`WHATSAPP_WABA_ID` and `WHATSAPP_TOKEN` set;
   the result card's picture header needs `--header-handle`, or `--sample` with `--app-id`) or by hand
   in WhatsApp Manager; wait until `--list` shows each one `APPROVED` and `UTILITY`; then set the
   WhatsApp variables in Vercel. Until then the card's promise is true for Telegram and email only,
   and the WhatsApp choice appears only once the number is set.

   Two open faults in the bot, written down on 12 October 2026 so they are not lost. The bot is off,
   so neither reaches a player today, and neither is fixed. Fix both before the bot goes on:
   - **The first JOIN from a current player makes a second record.** `handleWhatsappMessage` in
     `src/lib/whatsapp/bot.ts` finds the sender by number only (`findOrCreateWhatsappPlayer`). A
     player who already has a record on the web, and whose number we do not hold yet, gets a new
     record named by their WhatsApp profile: a duplicate. Only the "Stay updated" hand-off
     (`LINK-<code>-<ticket>`, `linkWhatsapp`) gives the number to the existing record today.
   - **The template buttons open a browser that does not know the player.** "Open match", "Enter the
     score" and "See the card" are URL buttons (`data/whatsapp-templates.json`). Since November 2025
     WhatsApp opens them in its own browser, which holds no Kicksmash cookie, so the player meets the
     match page as a stranger. The fix is a one-time sign-in link in the message text.
2. **LINE — built, waiting on an Official Account.** `src/lib/channels/line.ts` and
   `src/lib/line/`: the card in a group chat, the two taps, a signed webhook, and the two policies a
   platform that cannot edit a message forces — re-send only when something a player would notice
   changed, and answer on the free reply token rather than a metered push. Off until
   `LINE_CHANNEL_TOKEN` and `LINE_CHANNEL_SECRET` are set, which needs a LINE Official Account: the
   owner's to create, like WhatsApp's. **It ships in English** — decided 15 September. Thai waits
   until somebody is using it, because there is nothing to translate *for* yet.

   The numbers, since they were once given wrongly as one number (counted again on 25 September 2026,
   and the website's again on 15 October 2026: the leaves of `messages/en.json`).
   The card in a chat is its own set of **153 strings** in `src/lib/telegram/card.ts`, in three
   languages since 19 September 2026 (Spanish came with the inside of the bot, above); the coach's
   assistant has its own set, also in three. The **2,502** strings are the website, which has three.
   So Thai in a LINE chat is 153 strings and Thai on the website is 2,502, and neither of them is what
   stops LINE going live: the Official
   Account is.
3. **The serious tournament: run one for real.** All five steps are under Built. What is left is
   not code: an organiser (the Thai Padel Series, or Erik's next Open) runs a weekend on it, and what
   they trip on comes back here. Formerly listed here: the big-event extras — a stream link on a match or a
   court ("Watch live"; the organiser streams on YouTube or Twitch, we link), check-in by QR, a
   lucky loser, a results file, a ranking across editions.
4. **A court a person can hold.** The rows exist, a match names a court, a lesson names one, and the
   club's day shows which courts are busy — all under Built. What is left is the hold itself: a
   court held in somebody's name for a time, and the rule that says who may give it back and by
   when. No payment passes through Kicksmash. This one waits for the owner, because a hold is a
   promise to a person about a physical thing, and the cancellation rule is the club's policy rather
   than ours to invent.
5. **Performance analytics by integration.** Shots, positioning and workload from smartwatch and camera
   integrations, with the player's consent. A match will carry sensor sessions.
6. **A crew's own WhatsApp group (Meta's Groups API).** The owner's decision of 9 October 2026 was
   "Telegram crew group now, Meta clock starts today". A business cannot join a group that somebody
   else made. Meta's Groups API lets the business make its own group, and players join it by an
   invite link. The API needs an Official Business Account. It allows 8 people at most and no edit
   of a message (Meta's Groups API page, read 11 October 2026). So the card would be a new
   message at each change that matters, as on LINE (`canEdit: false`). This waits for the owner: the
   Meta business portfolio, the number, and the request for an Official Business Account. Nothing in
   the repository or in production shows that these steps started.

## Open, small, and ready for the next session

Written 23 September 2026 for a clean hand-over, and checked against the code and production on 11
October 2026. The desk notes are in
`GET /api/admin/feedback?status=acknowledged`; the first eight characters of each id are given here.
Standing order 5 in CLAUDE.md applies to every one that becomes a change: mark it `shipped`, thank
the player, and invite them to try it.

1. **Security, at 100 real players.** Decided 23 September: no rotation and no hardening before that.
   Then: move the app's own connection onto the role `kicksmash` (production connects as `postgres`
   today, which bypasses Row Level Security), rotate `CRON_SECRET`, `RESEND_API_KEY` and
   `VERCEL_TOKEN`, and decide who may call `/api/admin/*`. The steps, in order, are in
   `docs/OPERATING.md` under "Security at a hundred real players". What can hold until then is held
   by `tests/security.test.ts`: every operator route checks the token first, and `kicksmash` can use
   every table. Still open on 11 October 2026: production has 21 player records, and the app still
   connects as `postgres` (`pg_stat_activity`).
2. **The desk's order after entries close.** Still open on 11 October 2026: the manage page shows the
   entries, then the courts, then each category's draw settings, whatever the entries' status. The
   strip at the top (`WeekendStrip`) links to each part, but once entries close the draw's settings
   still belong above the pairs.
3. **React error 418 on My matches.** Open on 11 October 2026. When hydration starts before the page's
   rows arrive, React replays the suspended `<main>`, meets the "My matches" `<h1>`, throws 418 and
   renders the page again in the browser. The screen comes out right, so nobody sees it, but the page
   renders twice. Each page now gives the browser only its own messages (`withClientMessages`), which
   cuts the HTML before `/me` can hydrate from 176,867 to 60,377 bytes in English. That makes the race
   rarer. It does not remove it: a proxy that sends the first 30,000 bytes of the document, waits
   1.5 s and then trickles the rest still gives 418 on both builds (main 3 in 20 loads, the lean build
   1 in 15). Start the root cause there, at the `<h1>` under `<main>` on `/me`. Do not relax a browser
   check that already reads order from the elements (`headingOrder` in `e2e/core.mjs`).
4. **Four more ways to bring in a booked court: not built.** The owner asked "Some other ideas?" on
   11 October 2026, and a session named four. None is built, and none is decided. To build one is
   the owner's decision.
   - **Web Share Target**: "Share" in a platform's app lists Kicksmash, and the share opens the
     filled form. The web manifest has no `share_target` today.
   - **An `.ics` file**: a booking's calendar file, read into the form. Kicksmash writes `.ics`
     files, and reads iCal feeds for two things only: a coach's own calendar
     (`src/lib/coach/ical.ts`) and a club's bookings feed for its free times
     (`src/lib/booking/availability.ts`). It reads no booking's `.ics` into the form.
   - **A slot check**: the paste compares its day and time with the club's free court times, and
     says when the court shows free. The paste does not read the free-times cache.
   - **`/booked` in a group**: a command in a crew's Telegram group that pastes a booking there. The
     paste works in a private chat only.
5. **The paste doors wait on two outside facts.** No mail has reached book@ (`book_mail_answered`
   and `book_mail_skipped` are empty on 11 October 2026): one test mail from the owner shows whether
   Resend routes it. The screenshot read and the other AI features wait on a working
   `ANTHROPIC_API_KEY`. Since 14 October 2026 every model call answers "This API key is not scoped
   to a workspace, so this request must include the anthropic-workspace-id header with the ID of the
   workspace to use. Add the header, or use an API key that is scoped to a workspace." On 15 October
   2026 production held 41 listening items failed with that text. The key of 14 October 2026 has no
   workspace, so they also wait on `ANTHROPIC_WORKSPACE_ID` in Vercel and a deploy.
6. **Decision B: a second organiser in Phuket.** The owner chose "A now + B this week" on 11 October
   2026. B is the owner's action: one other Phuket organiser runs a weekly game for 4 weeks. On 11
   October 2026 one organiser had made matches since 10 October. The next session counts the
   organisers with a match since 11 October and reports it to the owner (DECIDING rule 37).
7. **A session by name got the personal link by email: closed on 16 October 2026.** A review found on
   15 October 2026 that a session by name could save an address on the card, then tap Leave and Join, and
   the join's invitation carried the personal link to an address nobody had proved; every later match
   email to it carried the link too. The owner chose option A, "Code first (Recommended)" (DECIDING rule
   34, "An address from a session by name"). Every door that saves an address for the session's own
   record now sends the existing 6-digit code and keeps nothing; the right code saves the address as
   proved and makes the session a full one (`askForProof` in `src/actions/emailProof.ts`, `proveMyEmail`).
   An address saved by such a session before that day keeps no proof; production held none.

Decided 24 September: `kicksmash_agent` keeps its login, and the backup of 23 September is not
compared with production (rows the old merge dropped that morning stay dropped).

## Deliberately not

- **No accounts, no passwords**, for players, coaches or clubs. A coach is a player with a role.
- **No money through Kicksmash.** No payments, no commissions, no marketplace. A player books and pays
  a court in the club's own app. Kicksmash opens the club's booking page, on the match's day where the
  platform's page takes a day, and never signs in as anybody.
- **No paid tiers** while the free plans hold. Free for every stakeholder, for good.
- **No loud bots.** No bumps, no nags, nothing about Kicksmash beyond the card's footer.
- **Nothing closed.** The API, the data and the code stay open, and every crawler is welcome.

## Parked

- **WhatsApp Channels**, which need a person on a phone to post, and there is no staff.
- **Twilio and SMS**, which need template approval and a verified business.
- **Court booking integrations** with the platforms: booking, reserving or paying for a player, or
  signing in to a platform as a player (DECIDING rule 35). Reading the free court times a platform
  shows publicly is built; the player books and pays on the platform. Whether Kicksmash may read The
  Padel Society with the owner's own sign-in (the owner's offer of 10 October 2026) waits for the
  owner's decision.
- **Player reliability and no-show stats**, which would rank people by their worst days. Still parked as
  a stat. What changed on 25 September 2026 (banter, `docs/DECIDING.md` rule 18): a third late pull-out
  in 90 days is one playful line on the crew's own card while the spot it opened is open, and a win
  streak is one line on the crew's own result. No count is shown anywhere, nothing reaches a public page,
  and nobody is ranked by their worst days.
