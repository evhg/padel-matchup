import { and, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, players, scores, slots } from "@/db/schema";
import { fnv1a } from "@/lib/hash";
import { isOccupied } from "./events";
import { winStreak } from "./milestones";
import { praiseLocale } from "./praise";
import type { EventDetail } from "./queries";
import { matchResult } from "./result";
import { outcomeForTeam, type Outcome } from "./scores";

/**
 * Banter: one playful line about the crew's own facts, said where the crew already looks. The owner,
 * 25 September 2026: "calling out someone for pulling out last minute for the third time, or winning
 * 3 matches in a row and giving them a sarcastic pat on the back in the group together with the
 * result card." Option A: facts only, from the players' own matches, shown only in the crew's card
 * and chat and on the result card picture, never on a public page (`docs/DECIDING.md` rule 18).
 *
 * Two facts, each a pure rule plus one bounded read:
 * - a win streak: three or more wins in a row, counting the match that just got its result;
 * - a late pull-out: leaving within 24 hours of the start, for the third time or more in 90 days,
 *   counting the exit that just happened, while the spot it opened is still open.
 *
 * The organiser of a match switches it off for their matches with one tap (`players.banter`).
 * Lines are chosen by the match code, like the praise line, so every channel says the same thing.
 */

export const STREAK_FROM = 3;
/** How many of a player's scored matches a streak is read from; a longer streak is told as this. */
export const STREAK_LOOKBACK = 30;
export const LATE_MS = 24 * 60 * 60 * 1000;
export const LATE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const LATE_FROM = 3;
/** At most this many exits are read for one count: far more than anybody makes in 90 days. */
const LATE_READ_MAX = 100;

export type Streak = { names: string[]; count: number };
export type LateExit = { name: string; count: number };

/** On unless the organiser switched it off. */
export const banterOn = (detail: { creator?: { banter?: boolean } | null }) => detail.creator?.banter !== false;

/**
 * The organiser's one tap, for every match they organise. Every line drawn after it follows: the
 * cards, the result posts still to come, the card's page and its picture. A result already posted
 * into a group keeps its words; the result card in each player's chat is edited when it is next closed.
 */
export async function setBanter(db: Db, playerId: string, on: boolean): Promise<void> {
  await db.update(players).set({ banter: on }).where(eq(players.id, playerId));
}

/** The first word of a name: a line names people the way the crew calls them (rule 7). */
export const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0]?.slice(0, 24) || "?";

/** Left before the start, and at most 24 hours before it. */
export const isLateExit = (at: Date, startsAt: Date) => at.getTime() < startsAt.getTime() && startsAt.getTime() - at.getTime() <= LATE_MS;

/** How many of these exits were late, in the 90 days up to `at` (the exit that just happened counts). An exit from the waitlist opened no spot and never counts. */
export function countLateExits(exits: { at: Date; startsAt: Date; waitlist?: boolean }[], at: Date): number {
  const from = at.getTime() - LATE_WINDOW_MS;
  return exits.filter((x) => !x.waitlist && x.at.getTime() > from && x.at.getTime() <= at.getTime() && isLateExit(x.at, x.startsAt)).length;
}

/** The verbs that change who holds a seat. An organiser's edit, a score or a request changes none. */
const SEAT_VERBS = new Set(["joined", "left", "confirmed", "declined", "promoted", "removed", "invited", "approved"]);

/**
 * The exit a card may call out, decided from the rows the card already has: banter on, the match
 * still ahead, a spot open, and the last change to the seats is a late exit by somebody who is not
 * back in. The line lives from that exit until the next change to the seats. Null otherwise.
 */
export function lastLateExit(detail: Pick<EventDetail, "event" | "creator" | "roster" | "waitlist" | "activity">, now: Date): { playerId: string; name: string; at: Date } | null {
  const ev = detail.event;
  if (!banterOn(detail) || ev.status === "cancelled" || ev.status === "past" || now.getTime() >= ev.startsAt.getTime()) return null;
  const seats = detail.roster.filter((s) => s.position <= ev.capacity);
  const open = ev.capacity - seats.filter(isOccupied).length - seats.filter((s) => s.status === "invited").length;
  if (open <= 0) return null;
  const last = [...detail.activity].filter((a) => SEAT_VERBS.has(a.verb) && !a.meta?.waitlist).sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0];
  if (!last || last.verb !== "left" || !last.actorPlayerId || !isLateExit(last.createdAt, ev.startsAt)) return null;
  if ([...detail.roster, ...detail.waitlist].some((s) => s.playerId === last.actorPlayerId)) return null;
  return { playerId: last.actorPlayerId, name: last.actor?.displayName ?? "?", at: last.createdAt };
}

/**
 * The late pull-out fact for a card: the exit above, and how many late exits that player made in the
 * 90 days before it. One read over the player's own exits (`activity_left_idx`), and only when the
 * rows the card already has point at a late exit — a card sync after any other change costs nothing.
 */
export async function lateExitFor(db: Db, detail: EventDetail, now = new Date()): Promise<LateExit | null> {
  const exit = lastLateExit(detail, now);
  if (!exit) return null;
  const rows = await db
    .select({ at: activity.createdAt, startsAt: events.startsAt, meta: activity.meta })
    .from(activity)
    .innerJoin(events, eq(events.id, activity.eventId))
    .where(and(eq(activity.actorPlayerId, exit.playerId), eq(activity.verb, "left"), gt(activity.createdAt, new Date(exit.at.getTime() - LATE_WINDOW_MS)), lte(activity.createdAt, exit.at)))
    .orderBy(desc(activity.createdAt))
    .limit(LATE_READ_MAX);
  const count = countLateExits(
    rows.map((r) => ({ at: r.at, startsAt: r.startsAt, waitlist: Boolean(r.meta?.waitlist) })),
    exit.at,
  );
  return count >= LATE_FROM ? { name: firstName(exit.name), count } : null;
}

/** The winners of a scored match who have a player row, read from the score the way every screen reads it. */
export function winnersOf(detail: Pick<EventDetail, "event" | "scores" | "roster">): { id: string; name: string }[] {
  if (detail.event.type !== "match") return [];
  const r = matchResult(
    detail.scores,
    detail.roster.map((s) => ({ team: s.team, status: s.status, name: s.player?.displayName ?? s.invitedName ?? "?" })),
  );
  if (!r || !r.hasTeams || r.winner === "draw") return [];
  return detail.roster
    .filter((s) => s.playerId && s.team === r.winner && (isOccupied(s) || s.status === "invited"))
    .map((s) => ({ id: s.playerId!, name: s.player?.displayName ?? s.invitedName ?? "?" }));
}

/** The longest streak among the winners, from each one's outcomes newest first; null below three. Partners on the same streak are named together, two at most. */
export function streakOf(winners: { id: string; name: string }[], history: Map<string, (Outcome | null)[]>): Streak | null {
  let best = 0;
  let names: string[] = [];
  for (const w of winners) {
    const n = winStreak(history.get(w.id) ?? []);
    if (n > best) {
      best = n;
      names = [firstName(w.name)];
    } else if (n === best && n > 0) names.push(firstName(w.name));
  }
  return best >= STREAK_FROM ? { names: names.slice(0, 2), count: best } : null;
}

/**
 * The win streak a result earns, as of that match: every winner's last scored matches up to and
 * including this one. One read, bounded to STREAK_LOOKBACK matches per winner and two or three
 * winners, on `slots_player_idx`; the outcome of each is `outcomeForTeam`, the rule the moments use.
 */
export async function winStreakFor(db: Db, detail: EventDetail): Promise<Streak | null> {
  if (!banterOn(detail)) return null;
  const winners = winnersOf(detail);
  if (winners.length === 0) return null;
  const ranked = db
    .select({
      playerId: slots.playerId,
      team: slots.team,
      sets: sql<{ sideA: number; sideB: number }[] | null>`(select json_agg(json_build_object('sideA', sc.side_a, 'sideB', sc.side_b)) from ${scores} sc where sc.event_id = ${events.id})`.as("sets"),
      rn: sql<number>`row_number() over (partition by ${slots.playerId} order by ${events.startsAt} desc, ${events.id} desc)`.as("rn"),
    })
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .where(
      and(
        inArray(
          slots.playerId,
          winners.map((w) => w.id),
        ),
        inArray(slots.status, ["joined", "confirmed", "invited"]),
        eq(events.type, "match"),
        ne(events.status, "cancelled"),
        lte(events.startsAt, detail.event.startsAt),
        sql`${slots.position} <= ${events.capacity}`,
        sql`exists (select 1 from ${scores} sc where sc.event_id = ${events.id})`,
      ),
    )
    .as("ranked");
  const rows = await db.select({ playerId: ranked.playerId, team: ranked.team, sets: ranked.sets }).from(ranked).where(lte(ranked.rn, STREAK_LOOKBACK)).orderBy(ranked.playerId, ranked.rn);
  const history = new Map<string, (Outcome | null)[]>();
  for (const r of rows) {
    if (!r.playerId) continue;
    const list = history.get(r.playerId) ?? [];
    list.push(outcomeForTeam(r.sets ?? [], r.team));
    history.set(r.playerId, list);
  }
  return streakOf(winners, history);
}

// ---------------------------------------------------------------------------------------------
// The lines. Written per language, never translated word for word, and never cruel: a pat on the
// back for a streak, a wink and the open spot for a pull-out. Names stand alone (in Russian always
// first, in the nominative) so no language has to decline or gender a name it has never seen.
// ---------------------------------------------------------------------------------------------

type Fact = { who: string; n: number };
type Pools = Record<"en" | "ru" | "es", ((f: Fact) => string)[]>;

const ordinalEn = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
const winsRu = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "победа" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "победы" : "побед");

const STREAK: Pools = {
  en: [
    ({ who, n }) => `${n} wins in a row for ${who}. Somebody stop this 🔥`,
    ({ who, n }) => `${who}: ${n} straight wins. The rest of us need a plan 🔥`,
    ({ who, n }) => `${n} in a row for ${who}. Suspiciously good 🔥`,
    ({ who, n }) => `${who} again. That makes ${n} wins in a row, who dares next? 🔥`,
    ({ who, n }) => `Win number ${n} in a row for ${who}. Bring a better lob next time 🔥`,
    ({ who, n }) => `${who}: ${n} wins on the trot. Leave some for the rest of us 🔥`,
  ],
  ru: [
    ({ who, n }) => `${who}: ${n} ${winsRu(n)} подряд. Кто-нибудь, остановите это 🔥`,
    ({ who, n }) => `${who} — ${n} ${winsRu(n)} подряд. Остальным нужен план 🔥`,
    ({ who, n }) => `${n} ${winsRu(n)} подряд: ${who}. Подозрительно хорошо 🔥`,
    ({ who, n }) => `Снова ${who}. Уже ${n} ${winsRu(n)} подряд, кто следующий рискнёт? 🔥`,
    ({ who, n }) => `${who}: ${n} ${winsRu(n)} подряд. В следующий раз нужна свеча получше 🔥`,
    ({ who, n }) => `${who}: ${n} ${winsRu(n)} подряд. Оставьте что-нибудь остальным 🔥`,
  ],
  es: [
    ({ who, n }) => `${n} victorias seguidas para ${who}. Que alguien pare esto 🔥`,
    ({ who, n }) => `${who}: ${n} victorias seguidas. Los demás necesitamos un plan 🔥`,
    ({ who, n }) => `${n} seguidas para ${who}. Sospechosamente bien 🔥`,
    ({ who, n }) => `Otra vez ${who}: ${n} victorias seguidas. ¿Quién se atreve ahora? 🔥`,
    ({ who, n }) => `Victoria número ${n} seguida para ${who}. La próxima, un globo mejor 🔥`,
    ({ who, n }) => `${who}: ${n} victorias seguidas. Algo habrá que dejar para los demás 🔥`,
  ],
};

const LATE: Pools = {
  en: [
    ({ who, n }) => `${who} pulled out late for the ${ordinalEn(n)} time 🙃 The spot is open.`,
    ({ who, n }) => `Late exit number ${n} in 90 days for ${who} 🙃 Somebody grab the spot.`,
    ({ who, n }) => `${who} and the last minute: ${n} times in 90 days 🙃 Who takes the spot?`,
    ({ who, n }) => `${who}'s ${ordinalEn(n)} late pull-out in 90 days 🙃 The spot is up for grabs.`,
    ({ who, n }) => `${who} bowed out late again, ${n} times in 90 days 🙃 Free spot, first tap wins.`,
  ],
  ru: [
    ({ who, n }) => `${who}: ${n}-й поздний отказ за 90 дней 🙃 Место свободно.`,
    ({ who, n }) => `${who} снова в последний момент, ${n}-й раз за 90 дней 🙃 Место свободно, кто в игре?`,
    ({ who, n }) => `${who} и последний момент: уже ${n}-й раз за 90 дней 🙃 Кто займёт место?`,
    ({ who, n }) => `${who}: отказ в последний момент, ${n}-й за 90 дней 🙃 Свободное место, кто первый?`,
    ({ who, n }) => `${who}: ${n}-й поздний отказ за 90 дней 🙃 Место ждёт героя.`,
  ],
  es: [
    ({ who, n }) => `${who} se bajó a última hora por ${n}.ª vez 🙃 La plaza está libre.`,
    ({ who, n }) => `${who} y la última hora: ${n} veces en 90 días 🙃 Plaza libre, ¿quién se apunta?`,
    ({ who, n }) => `${who} se bajó tarde otra vez, ${n} en 90 días 🙃 La plaza espera.`,
    ({ who, n }) => `${n}.ª baja de última hora de ${who} en 90 días 🙃 Plaza libre para quien llegue primero.`,
    ({ who, n }) => `Baja de última hora número ${n} de ${who} en 90 días 🙃 ¿Quién se apunta?`,
  ],
};

const pick = (pools: Pools, locale: string | null | undefined, seed: string, f: Fact) => {
  const pool = pools[praiseLocale(locale)];
  return pool[parseInt(fnv1a(seed), 16) % pool.length](f);
};

/** The streak line for a match: same code, same line, in the reader's language. */
export const streakLine = (locale: string | null | undefined, code: string, s: Streak) => pick(STREAK, locale, `${code}:streak`, { who: s.names.join(" & "), n: s.count });

/** The late pull-out line for a match's card. */
export const lateExitLine = (locale: string | null | undefined, code: string, l: LateExit) => pick(LATE, locale, `${code}:late`, { who: l.name, n: l.count });

/** A line for the picture: the same words without the emoji, which the picture's renderer would fetch from a CDN on every render. */
export const plainLine = (line: string) =>
  line
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
