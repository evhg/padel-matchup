import { and, desc, gte, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { facts, type Fact } from "@/db/schema";

/**
 * The fact log: one append-only row per thing that happened, whoever did it and through whichever
 * channel. The padel graph, demand by hour, coach retention and the funnel are queries over it.
 * A fact names its subject by id and code and its actor by player id; `data` holds outcomes and
 * numbers, never a name, an email or a token.
 */
export const CHANNELS = ["web", "telegram", "discord", "line", "api", "mcp", "cron", "email", "calendar"] as const;
export type Channel = (typeof CHANNELS)[number];
export type FactSubject = "match" | "lesson" | "club" | "coach" | "group" | "series" | "player";

export type FactInput = {
  /** Dotted, subject first: match.joined, lesson.cancelled. */
  kind: string;
  channel?: Channel | null;
  actorPlayerId?: string | null;
  subject: { type: FactSubject; id: string };
  /** The public handle of the subject: a match code, a coach handle, a club or series slug. */
  code?: string | null;
  city?: string | null;
  venueSlug?: string | null;
  data?: Record<string, unknown>;
  at?: Date;
};

/** Where a booking came from, as the callers name it, mapped onto a channel; anything else was the web. */
export function channelOf(source: string | null | undefined): Channel {
  if (source === "gcal" || source === "ical") return "calendar";
  return (CHANNELS as readonly string[]).includes(source ?? "") ? (source as Channel) : "web";
}

/** Appends one fact. Never throws: no write path may fail because its record did. */
export async function recordFact(db: Db, f: FactInput): Promise<boolean> {
  try {
    await db.insert(facts).values({
      kind: f.kind,
      channel: f.channel ?? "web",
      actorPlayerId: f.actorPlayerId ?? null,
      subjectType: f.subject.type,
      subjectId: f.subject.id,
      code: f.code ?? null,
      city: f.city ?? null,
      venueSlug: f.venueSlug ?? null,
      data: f.data ?? {},
      ...(f.at ? { at: f.at } : {}),
    });
    return true;
  } catch (e) {
    console.warn("[facts] record failed", f.kind, e instanceof Error ? e.message : e);
    return false;
  }
}

/** The facts since an instant, newest first, optionally of some kinds only. */
export async function factsSince(db: Db, since: Date, o: { kinds?: string[]; limit?: number } = {}): Promise<Fact[]> {
  const where = o.kinds?.length ? and(gte(facts.at, since), inArray(facts.kind, o.kinds)) : gte(facts.at, since);
  return db.select().from(facts).where(where).orderBy(desc(facts.at)).limit(o.limit ?? 500);
}
