/**
 * What a group chat reads about a match: one line, the way a player would type it.
 *
 * Two places carry it. "Tell the group" after a join puts it in WhatsApp's share with the match link
 * under it, so the trip out of the group ends back in the group with the news (the owner, 10 October
 * 2026: "you have to leave the chat group"). And the link preview under a pasted match link names the
 * first names and the open spots, so "who is in?" is answered with no trip at all.
 *
 * Only what the public match page already shows: names as the players typed them, never a level
 * (the owner's decision E, 9 October 2026) and never a personal link — a message in a group can be
 * forwarded, so the link is always the match's own. WhatsApp makes a preview once, on the sender's
 * phone, so a preview is the line-up at that moment and never updates.
 *
 * Pure: the words come in already translated, the line goes out.
 */

/** A seat as the line reads it: a player's name, or the name a spot is held for. */
export type LineSeat = { status: string; name: string | null | undefined };

/** The names on the line-up, in seat order: the players in, then nobody else, and a held spot by the name it is held for. */
export function lineupNames(roster: readonly LineSeat[]): string[] {
  return roster
    .filter((s) => s.status === "joined" || s.status === "confirmed" || s.status === "invited")
    .map((s) => (s.name ?? "").trim())
    .filter(Boolean);
}

/** As many names as fit in `room` characters, then "+N" for the rest, so a long field never pushes the spots and the time out of sight. */
export function namesThatFit(names: readonly string[], room: number): string {
  const all = names.join(", ");
  if (all.length <= room) return all;
  for (let k = names.length - 1; k >= 1; k--) {
    const s = `${names.slice(0, k).join(", ")} +${names.length - k}`;
    if (s.length <= room) return s;
  }
  return `+${names.length}`;
}

export type LineParts = {
  /** "Sat 18:00", in the match's zone and the reader's language. */
  when: string;
  /** The club as the organiser named it, or null for a court not chosen yet. */
  venue: string | null;
  names: readonly string[];
  capacity: number;
  /** "1 spot", "2 spots", "full": already worded. Null once the match is over or off. */
  spots: string | null;
};

/** The longest line "Tell the group" sends; a field of twenty-four names is cut to "+N". */
export const TELL_MAX = 160;

/** "🎾 Sat 18:00 · Rawai · 3/4: Ana, Bo, Cy · 1 spot", then the match link on its own line. */
export function tellGroupText(p: LineParts, url: string): string {
  const head = ["🎾 " + p.when, p.venue].filter(Boolean).join(" · ");
  const count = `${p.names.length}/${p.capacity}`;
  const tail = p.spots ? ` · ${p.spots}` : "";
  const room = Math.max(20, TELL_MAX - head.length - count.length - tail.length - 5);
  const who = p.names.length ? `${count}: ${namesThatFit(p.names, room)}` : count;
  return `${head} · ${who}${tail}\n${url}`;
}

/**
 * The longest preview text, about two lines under the link in a phone's chat: our choice, not a
 * figure WhatsApp publishes. Names give way first, then the venue; the spots and the time stay.
 */
export const PREVIEW_MAX = 100;

/** "Ana, Bo, Cy · 1 spot · Sat 18:00 Rawai": the og:description of a match page. */
export function previewText(p: LineParts, max = PREVIEW_MAX): string {
  const where = [p.when, p.venue].filter(Boolean).join(" ");
  const fixed = [p.spots, where].filter(Boolean).join(" · ");
  const room = max - fixed.length - 3;
  if (p.names.length === 0 || room < 8) return fixed.length <= max ? fixed : [p.spots, p.when].filter(Boolean).join(" · ");
  return `${namesThatFit(p.names, room)} · ${fixed}`;
}
