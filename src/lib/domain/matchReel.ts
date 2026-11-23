import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, matchReels } from "@/db/schema";
import { DomainError } from "@/lib/domain/errors";

/**
 * The highlights reel of a filmed match: where it plays from, and for how long.
 *
 * The owner, 23 November 2026: a player of the match sees the reel on the match page; a reel is kept
 * for 30 days on the store. The files are on the reel host (`scripts/highlights/modal/serve.py`), under
 * a token that is the only key to them, so a reel's address is made here and nowhere else.
 */

/** The steps a reel goes through. "ready" is the only one with a reel to show. */
export const REEL_STATUS = ["asked", "received", "working", "ready", "failed"] as const;
export type ReelStatus = (typeof REEL_STATUS)[number];
/** A reel is kept this long after it is ready (the reel host's daily job deletes it, to the day). */
export const REEL_KEEP_DAYS = 30;

const TOKEN = /^[A-Za-z0-9_-]{22,64}$/;

/** The reel host's address as a row keeps it: https, a host name, no path, no slash at the end. Pure. */
export function reelHostOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  return `https://${u.host}`;
}

export const isReelToken = (raw: unknown): raw is string => typeof raw === "string" && TOKEN.test(raw);

export type ReelView = { tall: string; wide: string; saveTall: string; saveWide: string; keptUntil: Date };

/** What a screen needs of a row, or null when there is no reel to show (not ready, or past its days). Pure. */
export function reelView(row: { status: string; host: string | null; reelToken: string; readyAt: Date | null } | null | undefined, now: Date): ReelView | null {
  if (!row || row.status !== "ready" || !row.readyAt) return null;
  const host = reelHostOf(row.host);
  if (!host || !isReelToken(row.reelToken)) return null;
  const keptUntil = new Date(row.readyAt.getTime() + REEL_KEEP_DAYS * 86_400_000);
  if (keptUntil.getTime() <= now.getTime()) return null;
  const base = `${host}/r/${row.reelToken}`;
  return { tall: `${base}/tall.mp4`, wide: `${base}/wide.mp4`, saveTall: `${base}/tall.mp4?dl=1`, saveWide: `${base}/wide.mp4?dl=1`, keptUntil };
}

/** The reel of one match for its page. One read on the match's own unique index. */
export async function matchReel(db: Db, eventId: string, now = new Date()): Promise<ReelView | null> {
  const [row] = await db.select({ status: matchReels.status, host: matchReels.host, reelToken: matchReels.reelToken, readyAt: matchReels.readyAt }).from(matchReels).where(eq(matchReels.eventId, eventId)).limit(1);
  return reelView(row, now);
}

/**
 * The operator says "the reel of this match is on the store": the row is written as ready, or an older
 * row of the match is replaced. Refuses a match that has not started, a host that is not an https
 * address and a token of the wrong shape, each before any write.
 */
export async function setMatchReel(db: Db, input: { code: string; host: unknown; token: unknown; now?: Date }): Promise<{ eventId: string; replaced: boolean }> {
  const now = input.now ?? new Date();
  const host = reelHostOf(input.host);
  if (!host) throw new DomainError("invalid", "host");
  if (!isReelToken(input.token)) throw new DomainError("invalid", "token");
  const [ev] = await db.select({ id: events.id, startsAt: events.startsAt, status: events.status }).from(events).where(eq(events.code, input.code)).limit(1);
  if (!ev || ev.status === "cancelled") throw new DomainError("not_found");
  if (ev.startsAt.getTime() > now.getTime()) throw new DomainError("not_started");
  const [old] = await db.select({ id: matchReels.id }).from(matchReels).where(eq(matchReels.eventId, ev.id)).limit(1);
  const values = { status: "ready" satisfies ReelStatus, host, reelToken: input.token, readyAt: now, note: null };
  await db
    .insert(matchReels)
    .values({ eventId: ev.id, source: "operator", ...values })
    .onConflictDoUpdate({ target: matchReels.eventId, set: values });
  return { eventId: ev.id, replaced: Boolean(old) };
}

/** The operator takes a reel off the match page. The files stay on the store until their days end. */
export async function removeMatchReel(db: Db, code: string): Promise<boolean> {
  const [ev] = await db.select({ id: events.id }).from(events).where(eq(events.code, code)).limit(1);
  if (!ev) throw new DomainError("not_found");
  const gone = await db.delete(matchReels).where(eq(matchReels.eventId, ev.id)).returning({ id: matchReels.id });
  return gone.length > 0;
}
