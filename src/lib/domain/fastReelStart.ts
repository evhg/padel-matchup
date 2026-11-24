import { and, asc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, scores, slots } from "@/db/schema";
import { firstName } from "@/lib/domain/result";
import { pairName } from "@/lib/domain/reelChoices";
import { signReelReport } from "@/lib/domain/matchReel";

/**
 * What the fast reel's job needs to start, with no person (`scripts/highlights/modal/fastreel.py`, "Start"): the
 * matches in the clips, their players and pairs, the score, the camera place, and the key it reports with. Kicksmash
 * gives it in its answer to the reel host when the clips are here (`/api/reel/upload`), and the host starts the job.
 *
 * The clips of one booking can hold more than one match of the same people: on 24 November 2026 the third set was a
 * match of its own, with other pairs (the owner: "it's two matches"). So the start names every match that shares
 * three of the four players and starts within three hours of the uploaded one; the job finds each clip's match from
 * its near pair. The uploaded match is first: the team names the player chose are for it.
 */
export type FastReelMatch = { code: string; title_a: string; title_b: string; score: string; players: { id: string; name: string; team: 1 | 2 }[] };
export type FastReelStart = { matches: FastReelMatch[]; place: string | null; report: string };

const NEAR_MS = 3 * 3600 * 1000;
const SHARED = 3;

type Seat = { eventId: string; playerId: string | null; team: "a" | "b" | null; name: string | null };

async function seatsOf(db: Db, eventIds: string[]): Promise<Seat[]> {
  if (eventIds.length === 0) return [];
  return db
    .select({ eventId: slots.eventId, playerId: slots.playerId, team: slots.team, name: players.displayName })
    .from(slots)
    .leftJoin(players, eq(players.id, slots.playerId))
    .where(and(inArray(slots.eventId, eventIds), inArray(slots.status, ["joined", "confirmed"])))
    .orderBy(asc(slots.position));
}

/** The match as the job reads it, or null when it has no two pairs of two to make a reel of. Pure. */
export function fastReelMatch(code: string, seats: readonly Seat[], sets: readonly { a: number; b: number }[]): FastReelMatch | null {
  const seated = seats.filter((s): s is Seat & { playerId: string; team: "a" | "b" } => Boolean(s.playerId) && (s.team === "a" || s.team === "b"));
  const side = (t: "a" | "b") => seated.filter((s) => s.team === t);
  if (side("a").length !== 2 || side("b").length !== 2) return null;
  const names = (t: "a" | "b") => side(t).map((s) => firstName(s.name));
  return {
    code,
    title_a: pairName(names("a"), "Team A"),
    title_b: pairName(names("b"), "Team B"),
    score: sets.map((s) => `${s.a}-${s.b}`).join(" "),
    players: seated.map((s) => ({ id: s.playerId, name: firstName(s.name), team: s.team === "a" ? 1 : 2 })),
  };
}

/** Five reads on indexed keys: the match, its seats, the near matches of its players, their seats, their scores. */
export async function fastReelStart(db: Db, code: string, keys: { priv: string; pub: string }, now: Date): Promise<FastReelStart | null> {
  const [ev] = await db.select({ id: events.id, code: events.code, startsAt: events.startsAt, venueSlug: events.venueSlug }).from(events).where(eq(events.code, code)).limit(1);
  if (!ev) return null;
  const own = await seatsOf(db, [ev.id]);
  const ids = own.flatMap((s) => (s.playerId ? [s.playerId] : []));
  if (ids.length === 0) return null;
  const near = await db
    .select({ id: events.id, code: events.code, startsAt: events.startsAt, playerId: slots.playerId })
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .where(
      and(
        inArray(slots.playerId, ids),
        inArray(slots.status, ["joined", "confirmed"]),
        ne(events.id, ev.id),
        ne(events.status, "cancelled"),
        gte(events.startsAt, new Date(ev.startsAt.getTime() - NEAR_MS)),
        lte(events.startsAt, new Date(Math.min(ev.startsAt.getTime() + NEAR_MS, now.getTime()))),
      ),
    );
  const shared = new Map<string, { code: string; startsAt: Date; n: number }>();
  for (const r of near) shared.set(r.id, { code: r.code, startsAt: r.startsAt, n: (shared.get(r.id)?.n ?? 0) + 1 });
  const others = [...shared.entries()].filter(([, m]) => m.n >= SHARED).sort((a, b) => a[1].startsAt.getTime() - b[1].startsAt.getTime());
  const all = [{ id: ev.id, code: ev.code }, ...others.map(([id, m]) => ({ id, code: m.code }))];
  const [seats, sets] = await Promise.all([
    seatsOf(
      db,
      others.map(([id]) => id),
    ),
    db
      .select({ eventId: scores.eventId, a: scores.sideA, b: scores.sideB })
      .from(scores)
      .where(
        inArray(
          scores.eventId,
          all.map((m) => m.id),
        ),
      )
      .orderBy(asc(scores.setNumber)),
  ]);
  const matches = all.flatMap((m) => {
    const made = fastReelMatch(
      m.code,
      m.id === ev.id ? own : seats.filter((s) => s.eventId === m.id),
      sets.filter((s) => s.eventId === m.id),
    );
    return made ? [made] : [];
  });
  if (matches.length === 0 || matches[0].code !== ev.code) return null;
  return { matches, place: ev.venueSlug, report: await signReelReport(matches.map((m) => m.code), keys, now) };
}
