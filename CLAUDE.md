# Kicksmash

**Read [AGENTS.md](AGENTS.md) before changing anything.** It has the code map, the twelve rules that
reviews enforce, and the two recipes ("Adding a feature", "Adding a channel"). Then:
`docs/DECIDING.md` says whether a request should be built at all, `docs/VISION.md` says who it is for,
`ROADMAP.md` says what is built and what is next, `docs/OPERATING.md` has the ceilings we live under,
`docs/JOURNEYS.md` says what each stakeholder meets on the way in.

**Load the `ship` skill** (`.claude/skills/ship/`) before the first commit of any change. It is the
sequence from branch to merged — the gate, the suite map, the migration rule, what only the owner can
decide — and it carries the list of things this project has already paid to learn. Read that list
rather than rediscovering it.

## The owner's standing orders

1. **Wall clock first, credits second.** They are usually the same thing: what wastes time is rework.
2. **Every change improves how the app scales, or leaves it alone.** Never the other way (rule 12).
3. **One shot means they are not involved until it is finished.** Decide the routine things, say what
   you assumed, and stop only for what is genuinely theirs: a migration, identity or personal data,
   behaviour people rely on, anything outward-facing or hard to undo.
4. **Write to the owner in Simplified Technical English (ASD-STE100).** Use the active voice. Use the
   simple present, the simple past or the simple future. Keep an instruction to 20 words or fewer, and
   a description to 25. Give one idea to each sentence, and six sentences or fewer to each paragraph.
   Do not put a gerund or a participle where a noun or an adjective belongs. Do not drop an article.
   Give one meaning to each word. File names, table names, column names and code identifiers are
   technical names, so keep them as they are. No internal shorthand, no drifting pull request numbers,
   no codenames. Give every time in Thailand time (Asia/Bangkok, UTC+7), never in UTC: the owner, 24
   November 2026, "dont use utc time, we are in thailand".
5. **A player whose note became a change hears about it, every time.** Mark the note `shipped`, thank
   the player, say what changed, and invite them to try it. Give it its one line for `/built`
   (`publicSummary`: the change in our words, never theirs). The player's first name shows beside
   it; send `publicName: ""` for a test user or a name unfit for a public page. Do not ask the owner first.
   Where the change is visible, add a picture of it (`publicImage`). Take the picture from the test
   database, put the file in `public/built/` in the pull request of the change, and mark the note after
   the deploy. The thank-you and `/built` then show the picture.
6. **Ask production through `/api/admin/sql`, never through the Supabase MCP**, and put the questions in
   one query. Every MCP call waits for the owner's approval, and that breaks rule 3.
7. **A question for the owner is a decision, set out in full.** Name each option, give its pros and
   cons, and say which one you recommend and why. A fact is not a decision: report it, do not ask
   about it. And ask only what is theirs: for anything else, decide and say what you assumed.
8. **No privacy step unless the owner asks for one.** Kicksmash is a game for Erik and his friends, a
   hobby project. A player plays and sees the score on the leaderboard, as in a computer game. Every
   stat is kept for every player by default, and rankings are on by default; a player can leave them.
   Do not add a consent step, an opt-in, a switch or a rule to protect privacy by yourself. The owner,
   23 November 2026: "Never ever add steps or rules to protect privacy unless I explicitly ask you."
9. **Compliance never worsens the UI or the UX.** What the law needs goes where it costs the player no
   tap and is not in the player's face: the privacy page, a default, a line behind a fold. The owner:
   "This is how apps die."
10. **Only A+ content, and a reel that meets the v8 standard may go public with its match sound.** A
    reel that does not meet the v8 standard is not shown even to the players. A reel that meets it may
    go to a public place (Instagram, TikTok, the site) with the players' own match sound. The owner,
    25 November 2026: "It's erik's friends, remember?" This replaces the old rule that the match sound
    never goes public.
11. **Instagram and TikTok (@kicksma.sh): the official APIs; Claude approves each post, the owner gets
    a summary each day.** No password and no browser bot: a token from each platform's developer app,
    put in through the secure form, never in the chat. Claude looks at each post before it goes out and
    posts only A+ content (order 10). The owner gets one summary a day: what was posted, where, and what
    waits. The owner, 25 November 2026: "A, you approve each post at first but send me a daily summary."

## The one habit underneath all of it

**Check what the thing does, not what the description of it says.** Every expensive mistake here has
been a config, a document, or a claim that read correctly beside behaviour that did not match it:
18 MB of the test database in every deployed function while `next.config.ts` looked right; a roadmap
listing shipped work as upcoming; a notification whose text was the name of its own message key. The
build output, the screenshot, the database and the gate's own `EXIT=` line are the evidence. Look at
them first, and when one finally comes out right, write the rule down before moving on.
