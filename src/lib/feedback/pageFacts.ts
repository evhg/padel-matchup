import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { events, matchReels, players, scores, slots } from "@/db/schema";

/**
 * What the page a note came from shows, in plain sentences for the model that answers the note and
 * for the owner's summary (the owner, 24 November 2026: a player wrote "the video is here? I dont see
 * it" from a match page, and the summary answered "No video feature exists in Kicksmash today",
 * because nothing told it what the page showed). Today a match page: when and where, who played on
 * which side, the score, and the state of its reel, with times in the match's own zone.
 *
 * Three reads on indexed keys, and only for a note sent from a match page. Null for any other page.
 */
const CODE = /^\/([A-Za-z0-9]{4})(?:\/|$)/;

export async function pageFacts(db: Db, context: string | null | undefined, now = new Date()): Promise<string | null> {
  const code = CODE.exec(context ?? "")?.[1];
  if (!code) return null;
  const [ev] = await db.select().from(events).where(eq(events.code, code)).limit(1);
  if (!ev) return null;
  const at = (d: Date, withDay = false) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: ev.tz, ...(withDay ? { weekday: "short", day: "numeric", month: "short" } : {}), hour: "2-digit", minute: "2-digit" }).format(d);
  const seats = await db
    .select({ name: players.displayName, team: slots.team, status: slots.status, invited: slots.invitedName })
    .from(slots)
    .leftJoin(players, eq(players.id, slots.playerId))
    .where(and(eq(slots.eventId, ev.id), inArray(slots.status, ["joined", "confirmed", "invited"])))
    .orderBy(asc(slots.position));
  const [sets, [reel]] = await Promise.all([
    db.select({ a: scores.sideA, b: scores.sideB }).from(scores).where(eq(scores.eventId, ev.id)).orderBy(asc(scores.setNumber)),
    db.select({ status: matchReels.status, source: matchReels.source, createdAt: matchReels.createdAt, readyAt: matchReels.readyAt }).from(matchReels).where(eq(matchReels.eventId, ev.id)).limit(1),
  ]);
  const named = (team: "a" | "b") => seats.filter((s) => s.team === team && s.status !== "invited").map((s) => s.name ?? s.invited ?? "?");
  const line = [named("a"), named("b")].every((t) => t.length > 0) ? `${named("a").join(" and ")} against ${named("b").join(" and ")}` : seats.map((s) => (s.status === "invited" ? `${s.name ?? s.invited} (a held place)` : s.name)).join(", ");
  const over = ev.startsAt.getTime() + ev.durationMinutes * 60_000 <= now.getTime();
  const reelLine = !reel
    ? over
      ? "Reel: nobody has sent the video yet."
      : "Reel: the match is not over yet."
    : reel.status === "ready" && reel.readyAt
      ? `Reel: ready since ${at(reel.readyAt)}; the players of the match see it on this page.`
      : reel.status === "asked"
        ? `Reel: a player started sending the ${reel.source === "clips" ? "clips of a fast reel" : "video"} at ${at(reel.createdAt)}; it has not all arrived.`
        : reel.status === "received" || reel.status === "working"
          ? `Reel: the ${reel.source === "clips" ? "clips of a fast reel" : "video"} arrived (sending began at ${at(reel.createdAt)}). The reel is made from it on the reel host and is not ready yet.`
          : `Reel: the last attempt failed (${reel.status}).`;
  return [
    `The note was sent from the page of match ${ev.code}: ${at(ev.startsAt, true)}, ${ev.durationMinutes} minutes${ev.venueName ? `, at ${ev.venueName}` : ""}; times are in ${ev.tz}, now ${at(now)}.`,
    `Players: ${line || "nobody yet"}.`,
    sets.length ? `Score: ${sets.map((s) => `${s.a}-${s.b}`).join(" ")}${ev.scoreLockedByCreator ? ", confirmed by the organiser" : ""} (pair A first).` : over ? "Score: not entered yet." : "",
    reelLine,
  ]
    .filter(Boolean)
    .join("\n");
}
