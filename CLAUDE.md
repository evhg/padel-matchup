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
   no codenames.
5. **A player whose note became a change hears about it, every time.** Mark the note `shipped`, thank
   the player, say what changed, and invite them to try it. Give it its one line for `/built`
   (`publicSummary`: the change in our words, never theirs, no name). Do not ask the owner first.
6. **Ask production through `/api/admin/sql`, never through the Supabase MCP**, and put the questions in
   one query. Every MCP call waits for the owner's approval, and that breaks rule 3.

## The one habit underneath all of it

**Check what the thing does, not what the description of it says.** Every expensive mistake here has
been a config, a document, or a claim that read correctly beside behaviour that did not match it:
18 MB of the test database in every deployed function while `next.config.ts` looked right; a roadmap
listing shipped work as upcoming; a notification whose text was the name of its own message key. The
build output, the screenshot, the database and the gate's own `EXIT=` line are the evidence. Look at
them first, and when one finally comes out right, write the rule down before moving on.
