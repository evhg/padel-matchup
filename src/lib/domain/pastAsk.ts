import { normalName } from "./dupes";

/**
 * "Is this Danny, who played with you on Sep 13 at Kross Padel?" (the owner, 12 October 2026: "if
 * manually typed and it matches a previously played person it should ask if its this person to avoid
 * creating dupes"). The question a held name gets on the create form, in the open spot and in "Paste
 * the names", before the place is held. Pure and safe in a browser: it reads only what the browser may
 * know of a past player, which is a name, a day and a club, never a record's id (`pastViews` in
 * `heldRecord.ts` makes the list; `recordForAnswer` there finds the record again on the server).
 */

/** What a browser may know of a past player: the name, the day of the last match together in that match's own zone, and its club. */
export type PastView = { name: string; day: string; club: string | null };

/**
 * The organiser's answer for one typed name: a chip from "Played with you" (`true`, the one record of
 * that name), "Yes, that's Danny" with the day and the club it was shown, or "No, someone new".
 */
export type PastAnswer = true | "new" | { day: string; club: string | null };

/** What the browser sends for a name it has an answer for: never "No" (a place held by name needs none), never an id. */
export type PastPick = { name: string; day?: string; club?: string | null };

/** At most this many past players of one name in a question; the latest first. */
export const ASK_OPTIONS_MAX = 4;

/**
 * The past players a typed name asks about, latest first: the records of that name the browser can
 * tell apart. Two of one name, one day and one club cannot be told apart by what the browser sees, so
 * neither is offered: the server could not find one of them again either. Empty: no question.
 */
export function askFor(views: readonly PastView[], typed: string): PastView[] {
  const key = normalName(typed);
  if (!key) return [];
  const same = views.filter((v) => normalName(v.name) === key);
  const sig = (v: PastView) => `${v.day}|${v.club ?? ""}`;
  const seen = new Map<string, number>();
  for (const v of same) seen.set(sig(v), (seen.get(sig(v)) ?? 0) + 1);
  return same.filter((v) => seen.get(sig(v)) === 1).slice(0, ASK_OPTIONS_MAX);
}

/** The names in the create form's box, as the form sends them: one a line, trimmed, blank lines dropped. */
export const namesTyped = (text: string): string[] =>
  text
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);

/** The pick the browser sends for an answer, or null for "No, someone new" (held by name, as with no answer). */
export function pickOf(name: string, answer: PastAnswer | undefined): PastPick | null {
  if (answer === undefined || answer === "new") return null;
  return answer === true ? { name } : { name, day: answer.day, club: answer.club };
}

/** The answer a typed name has, if any: answers are kept by the name as the server compares it. */
export const answerFor = (answers: Readonly<Record<string, PastAnswer>>, name: string): PastAnswer | undefined => answers[normalName(name)];

/** The key an answer is kept under. */
export const answerKey = (name: string): string => normalName(name);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** At most this many picks in one request: the create form's names (`createSchema`'s 64). */
export const PICKS_MAX = 64;

/**
 * The picks a request carries, held to their shape: a name of 60 characters at most, a day as
 * YYYY-MM-DD, a club of 80 at most or none. Anything else in a pick (an id, a player id) is dropped,
 * and a pick of another shape is dropped whole. A server action is a public endpoint.
 */
export function cleanPicks(raw: unknown): PastPick[] {
  if (!Array.isArray(raw)) return [];
  const out: PastPick[] = [];
  for (const p of raw.slice(0, PICKS_MAX)) {
    if (!p || typeof p !== "object") continue;
    const { name, day, club } = p as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || name.length > 60) continue;
    if (day === undefined) {
      out.push({ name });
      continue;
    }
    if (typeof day !== "string" || !DAY_RE.test(day)) continue;
    if (club !== undefined && club !== null && (typeof club !== "string" || club.length > 80)) continue;
    out.push({ name, day, club: typeof club === "string" ? club : null });
  }
  return out;
}

/** The answer a pick stands for: a day means "Yes, that's Danny" with that day and club; none means a chip. */
export const answerOfPick = (p: PastPick): PastAnswer => (p.day ? { day: p.day, club: p.club ?? null } : true);
