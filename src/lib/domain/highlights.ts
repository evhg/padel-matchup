import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { events, slots } from "@/db/schema";
import { DomainError } from "@/lib/domain/errors";
import { linksIn } from "@/lib/domain/bookingLink";

/**
 * "Watch highlights": the match video on YouTube, which a player of the match adds after it starts.
 * Kicksmash keeps the link and nothing else: no video passes through it (the owner, 10 November 2026:
 * "Definitely not paying for hosting").
 */

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The one spelling a match keeps, from whatever was pasted: a bare link, or YouTube's share text with
 * the link in it. youtube.com/watch, youtu.be, /shorts/ and /live/ links, on the www and m hosts;
 * anything else is `null`, so the button only ever opens YouTube. Pure, and safe in a browser.
 */
export function highlightsLinkOf(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  const candidates = /\s/.test(text) ? linksIn(text) : [/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`];
  for (const c of candidates) {
    let u: URL;
    try {
      u = new URL(c);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
    let id: string | null = null;
    if (host === "youtu.be") id = u.pathname.split("/")[1] ?? null;
    else if (host === "youtube.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] === "watch") id = u.searchParams.get("v");
      else if (parts[0] === "shorts" || parts[0] === "live") id = parts[1] ?? null;
    }
    if (id && YOUTUBE_ID.test(id)) return `https://www.youtube.com/watch?v=${id}`;
  }
  return null;
}

/** Adds or replaces the link. The organiser or a player seated in the match, once the match has started. */
export async function setHighlights(db: Db, input: { eventId: string; playerId: string; text: string }, now = new Date()): Promise<string> {
  const url = highlightsLinkOf(input.text);
  if (!url) throw new DomainError("invalid", "youtube");
  const [ev] = await db.select({ id: events.id, startsAt: events.startsAt, creatorPlayerId: events.creatorPlayerId }).from(events).where(eq(events.id, input.eventId)).limit(1);
  if (!ev) throw new DomainError("not_found");
  if (ev.startsAt.getTime() > now.getTime()) throw new DomainError("not_started");
  if (ev.creatorPlayerId !== input.playerId && !(await isSeated(db, ev.id, input.playerId))) throw new DomainError("forbidden");
  await db.update(events).set({ highlightsUrl: url, highlightsBy: input.playerId }).where(eq(events.id, ev.id));
  return url;
}

/** Takes the link down: the person who added it, or the organiser. */
export async function removeHighlights(db: Db, eventId: string, playerId: string): Promise<void> {
  const [ev] = await db.select({ creatorPlayerId: events.creatorPlayerId, highlightsUrl: events.highlightsUrl, highlightsBy: events.highlightsBy }).from(events).where(eq(events.id, eventId)).limit(1);
  if (!ev || !ev.highlightsUrl) return;
  if (ev.highlightsBy !== playerId && ev.creatorPlayerId !== playerId) throw new DomainError("forbidden");
  await db.update(events).set({ highlightsUrl: null, highlightsBy: null }).where(eq(events.id, eventId));
}

async function isSeated(db: Db, eventId: string, playerId: string): Promise<boolean> {
  const [seat] = await db.select({ id: slots.id }).from(slots).where(and(eq(slots.eventId, eventId), eq(slots.playerId, playerId), inArray(slots.status, ["joined", "confirmed"]))).limit(1);
  return Boolean(seat);
}
