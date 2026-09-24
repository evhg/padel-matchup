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
  database held sixty-six clubs with names, provinces, court counts and booking links, and every
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
  "Not me" is remembered in that browser only. A row with an address, a phone, a chat account or a
  push subscription is never merged by name. A merge now also moves the person's wants, which point
  at a player without a foreign key and were left behind on the folded row until now.
- **Three players can score from Telegram (24 September 2026).** Erik's note of 15 September (match
  9wjp): with three players seated, the nudge's 🏁 said "the result needs four players", and a bare
  "6-4 6-3" in reply said "tap 🏁 on the card first", while the web took the score from three. Two of
  the three scored matches in production had three players. Where the chat cannot finish the result
  (fewer than four seated, or pairs nobody has set), the 🏁 on the nudge and those two answers in the
  player's own chat now carry one button to the match page's score form, already signed in through
  the Mini App: the direct link when the app exists in BotFather, else a web_app button on `/tg`,
  which every deployment with Telegram has. The button never carries a personal link, because a
  forwarded message keeps its buttons. A group gets the sentence alone.

## The finish line

Proposed to the owner on 24 September 2026: Kicksmash is finished when each stakeholder in
`docs/VISION.md` is won for real, and again after that, by the vision's own test. Code alone does not
reach it; people using the app do.

| Stakeholder | Won when | On 24 September 2026 |
|---|---|---|
| Player | the match is played | 13 past matches: 3 filled, 3 of 3 scored; 10 never filled |
| Coach | a student books, moves or cancels, and the coach typed nothing | 2 lessons |
| Organiser | a weekend of 200 players runs from a phone | a rehearsal only |
| Club | an off-peak court hour is filled from Kicksmash | 0 live, 66 listed, 1 refused test claim |

What stands between here and there, in order: real use through each loop (a tournament weekend, a
coach whose students book themselves, a club, crews that enter scores); reach (6 of about 18 people
can get a message, and WhatsApp one-to-one waits on the owner's Meta account and number); the
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
   of **151 strings** in `src/lib/telegram/card.ts`, in three languages since 19 September 2026
   (Spanish came with the inside of the bot, above); the coach's assistant has its own set, also in
   three. The **1,456** strings are the website, which has three. So Thai in a LINE chat is 151 strings
   and Thai on the website is 1,456, and neither of them is what stops LINE going live: the Official
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
6. **WhatsApp in a group chat**, if Meta ever lets a business into a group somebody else made. Today it does not, at any tier.

## Open, small, and ready for the next session

Written 23 September 2026 for a clean hand-over. The desk notes are in
`GET /api/admin/feedback?status=acknowledged`; the first eight characters of each id are given here.
Standing order 5 in CLAUDE.md applies to every one that becomes a change: mark it `shipped`, thank
the player, and invite them to try it.

1. **Security, at 100 real players.** Decided 23 September: no rotation and no hardening before that.
   Then: move the app's own connection onto the role `kicksmash` (production connects as `postgres`
   today, which bypasses Row Level Security), rotate `CRON_SECRET`, `RESEND_API_KEY` and
   `VERCEL_TOKEN`, and decide who may call `/api/admin/*`. The steps, in order, are in
   `docs/OPERATING.md` under "Security at a hundred real players". What can hold until then is held
   by `tests/security.test.ts`: every operator route checks the token first, and `kicksmash` can use
   every table.
2. **Match times for a player with no channel.** A player who entered on the web without Telegram or
   an email hears nothing about their court and time; "Your matches" should offer the channel.
3. **The desk's order after entries close.** The draw's settings sit under every pair; once entries
   close they belong above them.
Decided 24 September: `kicksmash_agent` keeps its login, and the backup of 23 September is not
compared with production (rows the old merge dropped that morning stay dropped).

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
