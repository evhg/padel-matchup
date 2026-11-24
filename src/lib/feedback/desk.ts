import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { feedback, researchRuns } from "@/db/schema";
import { bumpMetric } from "@/lib/domain/metrics";

/**
 * The note desk: a note wakes a Claude Code session at once (the owner, 24 November 2026: "can we use
 * a player's mac as an always on server, to not have to check every hour and just react as feedback is
 * given?"). No machine has to stay on: the session runs in the cloud, started by the routine's API
 * trigger (https://code.claude.com/docs/en/routines#add-an-api-trigger). The routine's saved prompt
 * sends it to `.claude/skills/note-desk/SKILL.md`, which says how a note is handled.
 *
 * One session handles every open note, so a burst of notes wakes it once: a wake within `DESK.gapMs`
 * of the last one is skipped, and the hourly job wakes it again while a note is still open
 * (`wakeForOpenNotes`). The text sent with the wake is only a pointer; the session reads the notes
 * through the operator's door, as data. Off until NOTE_DESK_FIRE_URL and NOTE_DESK_TOKEN are set.
 */
export const DESK = { gapMs: 10 * 60_000, key: "note_desk", maxAgeDays: 14 } as const;

export type DeskWake = "off" | "recent" | "woken" | "failed";

export async function wakeNoteDesk(db: Db, reason: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<DeskWake> {
  const url = process.env.NOTE_DESK_FIRE_URL?.trim();
  const token = process.env.NOTE_DESK_TOKEN?.trim();
  if (!url || !token || !/^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/.test(url)) return "off";
  // The claim first, so two notes in the same second wake one session.
  const since = new Date(now.getTime() - DESK.gapMs);
  const claimed = await db
    .insert(researchRuns)
    .values({ key: DESK.key, lastRunAt: now, runs: 1 })
    .onConflictDoUpdate({ target: researchRuns.key, set: { lastRunAt: now, runs: sql`${researchRuns.runs} + 1` }, setWhere: lt(researchRuns.lastRunAt, since) })
    .returning({ key: researchRuns.key });
  if (claimed.length === 0) return "recent";
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "experimental-cc-routine-2026-04-01", "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ text: `Kicksmash: ${reason.slice(0, 200)}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`fire ${res.status}`);
    await bumpMetric(db, "note_desk_woken").catch(() => undefined);
    return "woken";
  } catch (e) {
    // The claim goes back, so the hourly job tries again.
    await db.update(researchRuns).set({ lastRunAt: new Date(0), lastError: String((e as Error)?.message ?? e).slice(0, 200) }).where(eq(researchRuns.key, DESK.key));
    await bumpMetric(db, "note_desk_failed").catch(() => undefined);
    return "failed";
  }
}

/** The hourly job's half: a note still waiting for the desk, older than the gap, wakes it again. */
export async function wakeForOpenNotes(db: Db, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<DeskWake | "none"> {
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(feedback)
    .where(and(eq(feedback.status, "acknowledged"), lt(feedback.createdAt, new Date(now.getTime() - DESK.gapMs)), gt(feedback.createdAt, new Date(now.getTime() - DESK.maxAgeDays * 86_400_000))));
  if (!open || open.n === 0) return "none";
  return wakeNoteDesk(db, `${open.n} note(s) still open`, fetchImpl, now);
}
