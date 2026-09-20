# Five walks: what each stakeholder meets on the way in

On 20 September 2026 five people walked into kicksma.sh as themselves: a player, a coach, a student, a
tournament organiser and a club owner. Each was researched first (who they are, what they want, where
they already talk), then played against a production build on a throwaway database — four on an
iPhone, the organiser on a laptop — clicking what that person would click, from the landing page or
from a link somebody forwarded. Every step was screenshotted; every stop was written down as a
frustration, every "oh" as a moment. This is the record, and the plan that came out of it. What the
walks fixed the same day is marked **fixed**; what they put on the list is under *Next* at the end.

The rule that made the walks worth doing is the one in `CLAUDE.md`: check what the thing does, not
what the description says. Every frustration below was a screen that looked finished from the code.

## Tom, the player

British, 34, in Rawai since 2023, works remotely, plays three times a week at about 3.5. Lives in the
"Padel Phuket" Facebook group and his club's WhatsApp group, books on Playtomic. His problem is four
people free at the same hour at the same level, and the "who's in?" thread that dies. A friend pastes
a Kicksmash link into the group; he opens it on an iPhone, in English.

**The walk.** Landing page → the match form is the page → tonight 19:00 at Rawai Padel Club, court 2
→ Create → the link, in about ten seconds → the match page → looks for a way to find a fourth → My
matches → the Phuket page → the club's board → the Telegram door.

**Frustrations.**

- The header read "Kick…" beside his door and the three language pills. **Fixed:** on a phone the
  language toggle is one pill, the current language; a tap opens the other two.
- His match sat at Rawai Padel Club and nobody at the club could see it: the "Show on the venue
  board" switch was three taps down in More options on the edit form, and he never opened it.
  **Fixed:** the organiser's match page carries one tap, "Show on the Rawai Padel Club board", beside
  the status chips while the match is not listed; the switch stays for taking it off again.
- The level range, the one thing that would have made "looking for a 4th" mean something, is under
  More options. *Next.*
- My matches showed an empty white card between the feedback line and his personal link: the push
  reminder's card, drawn even where the phone cannot do push. **Fixed:** the toggle draws its own card,
  so a phone that cannot do push sees nothing there.

**Moments.** The link in ten seconds with nothing asked but a name. The Phuket page: every open match
in the city, on one screen, no group to join. The club's own board and its poster. The Telegram door:
the whole loop in the chat he already has open.

## Nok, the coach

Thai, 29, ex-tennis coach at a Bangkok club with MATCHi booking, twenty regulars split between LINE
(Thai) and WhatsApp (expats), 1,500 THB an hour, ten-lesson packages, PromptPay. Her evenings are
reschedules by chat at 22:00 and "how many lessons do I have left". A student's Instagram story brings
her in, on Android, in English.

**The walk.** Landing page → "Padel coach? Your students book themselves" → the coaches page → her
name → where she coaches → lesson length → hours (mornings and afternoons, 12 hours' notice) → 1,500
THB and PromptPay → how she hears about bookings → the link for her students → her assistant's home →
her public page as a student sees it → the students screen.

**Frustrations.**

- The channel step would not let her finish: Done wants Telegram or an email, and she has neither
  open on her phone — she has LINE. She typed an email to get past it. LINE for a coach waits on the
  Official Account (ROADMAP, Next 2); until then the step should say what it is waiting for. *Next.*
- Her page said "Founding coach · Phuket". She coaches in Bangkok. The badge took the city from the
  time zone, and Asia/Bangkok is Bangkok's zone as much as Phuket's. **Fixed:** the city comes from
  her clubs — a slug the city knows, or the city on the club's own row — and when nothing says, the
  badge names no city.
- The welcome message shows her bare page link, not the invite link that seats a student without
  asking. Left as it is: the bare link is the one to put on Instagram; the invite link is for the
  students she already has, and the students screen carries it.

**Moments.** Six screens, one question each, and a working assistant at the end. Her page as her
students will see it, before anyone has seen it. The price and PromptPay asked in the walk, not found
later in settings.

## Ana, the student

Spanish, 41, marketing manager in Singapore, three months into padel at about 1.5, wants a coach to
fix her backhand before the company tournament. Two ways in: a coach forwards a Kicksmash link on
WhatsApp, or she searches "padel coach Singapore". iPhone, Spanish.

**The walk, path 1.** The forwarded link → her name → on the coach's list → a day → a time → booked
→ her lessons, from the header. Four taps from a WhatsApp message to a lesson.

**The walk, path 2.** The landing page in Spanish → the coach link → coaches in Singapore → an empty
list.

**Frustrations.**

- Path 2 ends on "no coaches listed in Singapore yet" and nothing to do about it. She would have
  typed her name and "beginner, evenings" if anything had asked. *Next:* an "I want a coach" line on
  a city's coach list that records the want (`demand` already knows a city and a level) and tells the
  first coach who lists there.

**Moments.** Path 1, all of it: no account, no app, the coach's free times as buttons, her lesson in
her calendar. Spanish end to end, including the coach's page.

## Erik, the organiser

Swedish, 45, runs the Phuket Open twice a year: 48 pairs, three categories, entries by Instagram and a
broadcast list, the draw in a spreadsheet at 23:00, a WhatsApp group per category for "when do I
play". Types kicksma.sh on a laptop after the owner tells him about it.

**The walk.** Landing page → "Running a tournament with categories and a draw?" → New tournament →
Phuket Open, two days, Rawai Padel, the fee → the Gold category → four pairs entered at the desk →
the draw, made and published → courts and a schedule → the public page players get → the club's
screen.

**Frustrations.**

- On the laptop the tournament buttons sat off-centre: `.btn` is a flex box and the anchors added
  `inline-block` on top. **Fixed:** the class alone.
- The pairs he typed at the desk were marked "not confirmed yet" on the poster, with a claim link
  nobody would ever open: the desk vouches for both names. **Fixed:** a desk entry carries no claim
  token.
- The desk is the right tools in the right order, but nothing says the order: entries, then the
  draw, then courts and times, then live. He found it by trying. *Next:* a "how a weekend runs"
  strip at the top of the desk, each stage a link, the done ones ticked.

**Moments.** The draw in one tap from the entrants. The order of play with courts and times, the
thing his spreadsheet was for. The club's screen: big type, no header, refreshing on its own.

## Pim, the club owner

Thai, 38, owns a six-court club in Chiang Mai — four indoor, two outdoor — on Playtomic, with a
Facebook page and a LINE Official Account. Her courts are empty 09:00–16:00 on weekdays; she has no
view of which coaches teach there. Another owner tells her the club page is free. Phone, English.

**The walk.** Landing page → "Run a club? Claim your page" → Claim your club → her name and the club
→ six courts, four indoor, 07:00 to 22:00 → Playtomic, then claim → her club page, before the check
→ the week, from the done screen's link → the courts one by one → a Tuesday morning social on the
week → the poster → the owner approves in one tap in Telegram → a match at her club offers her
courts by name.

**Frustrations.**

- Her club page and its poster were "not found" until the owner had approved the claim, though the
  done screen had just linked to both. **Fixed:** while the check is pending the page and the poster
  open for her, with the courts and the map; the claim row shows only to a visitor of a club nobody
  has claimed.
- "Number them" gave her six courts with no kind, though she had just typed four indoor and two
  outdoor on the claim. **Fixed:** numbering marks the first four indoor and the next two outdoor.
- The Tuesday social step failed in the script, not on the screen: the week editor's weekday is a
  row of chips, not a select. Nothing to change.

**Moments.** The court chips on her page, and "Centre" instead of "Court 1" a minute later. The
match form at her club offering her courts by name. The approval: one tap by the owner in Telegram,
and the badge on her page.

## Next, in the order they matter

1. **The desk's "how a weekend runs" strip** (Erik). Entries → draw → courts and times → live →
   results, each a link, the done ones ticked, the next one lit. The organiser then has the order
   without a manual, and the desk stops being a set of tools.
2. **"I want a coach" on a city's coach list** (Ana). One line under the list, empty or not: a name,
   a level, when. It records a want and tells the first coach who lists in that city. The demand
   table already carries a city and a level; this is a door onto it.
3. **The level out of More options** (Tom). A level chip on the create form ("any level ▾"), one tap
   to a range, so "looking for a 4th" carries the one fact the fourth needs.
4. **The coach's channel step says what it waits for** (Nok). Where neither Telegram nor an email is
   there, the step names LINE and WhatsApp as the channels that are built and waiting on their
   accounts, and lets her pass with the email she will read later.
5. **The brand under two doors.** A coach with two doors still pushes "Kicksmash" to a word on a
   narrow phone. The mark alone under 360 px is the likely answer; not decided.
