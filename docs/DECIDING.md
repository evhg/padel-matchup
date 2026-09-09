# How Kicksmash decides what to build

The daily checklist that goes with this yardstick is in `docs/OPERATING.md` (the service board, the weekly domain check). This is the yardstick for every idea, bug report and wish that reaches us, whoever brings it: a player on Telegram, a club by email, a developer in Discussions, or the daily session reading `/api/admin/feedback`. It is short on purpose. If a request fails a rule here, we say so kindly and honestly; if it passes, we ship it, usually within a day, and we tell the person what changed because of them.

## What we are

The first global padel match-up layer: one link that works in any chat, a card that lives in Telegram and Discord, three languages, an open API that people and their assistants use alike, and a level that belongs to the player. No app to install, no account to create, no staff, no paid tiers yet. We never name a competitor.

## The rules, in order

1. **One job per screen.** A screen does one thing. Anything extra lives behind one "More" line that summarises what is set. A request that adds a visible control to a screen already at its budget (one primary action, at most two secondary, at most seven controls above the fold on a phone) must move something else behind "More" or be declined.
2. **Defaults that need no decision.** Cost is optional, level is optional, listing is off, waitlist is on. New options ship with a default good enough that most people never open them.
3. **Discovery through use.** Groups appear after two matches with the same people; rankings after results; boards when a venue is typed. We do not offer a feature before it can be useful to that person.
4. **Words over widgets.** A sentence that explains beats a toggle that confuses. Copy ships in English, Russian and Spanish at once, with identical keys.
5. **The bots stay quiet.** One card per match, edited in place; new messages only for the card, "full", the reminder and the result. No bumps, no nags, no explanations, nothing about Kicksmash beyond the card's footer. A request that makes a bot talk more is declined unless the person explicitly asked to be talked to.
6. **Open and agent-native.** Everything public stays readable and CC BY 4.0; the API and MCP server are one key away for anyone; every crawler is welcome. A request that closes something is declined.
7. **Privacy by default.** First names only, no phone numbers or emails shown, public profiles off until switched on, nothing personal in Telegram cards beyond what the person typed there. Personal tokens and manage links never appear in public data.
8. **Free tiers first.** No feature may require a paid plan (Vercel, Supabase, Resend, Telegram, Discord) below fifty emails a day. A request that needs one is "later", not "no".
9. **Small and finished.** A change ships with a unit test, passes typecheck, lint, the browser suites and a production check. Anything that needs a migration, touches sessions, authentication or personal data, or changes behaviour people rely on, is a design decision: it is recorded as planned and reviewed by a person, not shipped by the daily session.
10. **Honest answers.** We tell people what we did, what we did not do, and why, in their language, in one message. We never promise a date. We say thank you when their note changed the product, and we name the change.

## Verdicts

- **adopt**: passes the rules, fits in a day, has a test. Ship, verify in production, then tell the person exactly what changed and thank them.
- **later**: valid, but bigger than a day or blocked by rule 8 or 9. Record it as planned, tell the person it is on the list and why it waits. When it ships, tell them again.
- **decline**: fails a rule, or asks for something we deliberately do not do. Say which rule, kindly, in one or two sentences, and what they can do today instead.
- **ask**: unclear. One question back, nothing else. Never more than one.

## Voice

Warm, brief, European. First person singular is fine ("I read every note"). No hype, no sales language, no exclamation marks in a row. Names of other products never appear. Messages fit on a phone screen.

## Coaches

A coach's book is the first thing a coach uses that is not their own memory, so a coach's note weighs more than a cosmetic one. The rules above still apply; these add to them.

11. **Coach notes first.** A note whose author runs a book (the row carries `role: coach`) is read before the others and answered the same day. A "how does this work" question is answered in the product's words, and if the answer was not obvious on the screen, the copy on that screen changes too. Nobody is ever told to talk to a person.
12. **A preference becomes a setting when three coaches ask.** Until then it is a default. Coach screens keep the budget: today's lessons and one action; a student sees the next lesson, the package line and one action; everything else behind "More". A request that adds a visible control for one coach's habit is "later" with that sentence.
13. **Their calendar, their sheet, their money.** We read and write the coach's own Google Calendar and package sheet where they share them; we never ask them to move. No payment passes through Kicksmash: the coach's PromptPay QR or payment link is shown, "paid" is a note the coach makes. A request for payments, commissions or a marketplace is declined with rule 6 and this one.
14. **Students are answered while the coach teaches.** Booking, cancelling, "how many lessons do I have left" and questions about the rules are answered at once, inside the coach's settings, in the student's language. The coach receives decisions only: a new student to accept, a time outside the hours. A request that makes the coach the bottleneck again is declined.
15. **Between lessons, nobody types.** A cancelled or blocked lesson comes back to the student as the nearest free times to tap; the freed slot goes to the first student waiting for it (then for that week), theirs for thirty minutes, then the next in line; a time outside the hours is one yes/no tap for the coach; the evening-before reminder and the "nearly out" note are sent once each. A request to make any of these a chat message, an approval or a setting is measured against rule 14 first.
16. **After the final point, everyone hears once.** The score nudge goes to every player on the channel they have (Telegram, push, email), not only to the organizer, and exactly once per match. Any player may answer with a bare score ("6-4 6-3") in reply; the organizer's confirmation is a courtesy, not a gate: the first recorded result posts the card into the chat the match came from, with one line for the winners written per language and "same time next week?", which makes the crew a group with that match's own slot in one tap. A request for a second nudge, a leaderboard of who enters scores, or a share prompt after every match is declined.
17. **A reply is part of the note.** When a person answers our thank-you (Telegram reply, an email "Re:"), the text joins their note, dated, and the note goes back on the desk, even when it was shipped or declined. Nobody is asked to start over, and the three-message cap still holds: the "added to your note" line counts.
18. **Earned moments only, and the photo is theirs.** A moment card exists for a first win, the tenth and fiftieth match, three wins in a row, ten different partners, a level that moved up a band, and a podium; each once per player, announced once, shareable by choice. The court photo behind a result is added by a participant, once, never asked for twice, and removed by whoever added it or the organizer. A request for streak counters on every card, badges for showing up, or a share prompt after every match is declined with this rule.
