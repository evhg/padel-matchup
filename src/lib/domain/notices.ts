import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, notices, players, type Notice } from "@/db/schema";
import { cleanParams, INBOX_DAYS, noticeKey, releaseOf, SENDERS, type NoticeParams, type NoticeSettings, type Release, type Sender } from "./noticeKinds";

/**
 * The gate every notice to a player passes, and the inbox it leaves behind (the owner's decision D,
 * 9 October 2026). The rules are pure, in `noticeKinds.ts`; this is the rows.
 *
 * The order is the point. The row is written first, for everybody the notice is for, in one insert
 * however many people a fan-out reaches (rule 12); only then does the sender deliver, and only to
 * the people the gate released. So a kind switched off is kept and never sent, a notice inside quiet
 * hours waits for the hourly job's summary, and a player with no channel at all still finds it on
 * My matches, which until now meant nothing at all reached them.
 */

/** One notice to one person. `startsAt` is the match it is about: inside three hours of it, quiet hours do not hold it. */
export type NoticeInput = { playerId: string; sender: Sender; eventId?: string | null; params?: NoticeParams; startsAt?: Date | null; tz?: string | null };

/** The fields of a match every notice about one carries: its start and zone, so the inbox writes the day in the reader's language, and its place. */
export const matchParams = (ev: { startsAt: Date; tz: string; venueName?: string | null }): NoticeParams => ({ at: ev.startsAt.toISOString(), tz: ev.tz, venue: ev.venueName ?? undefined });

async function settingsOf(db: Db, ids: readonly string[]): Promise<Map<string, NoticeSettings>> {
  const out = new Map<string, NoticeSettings>();
  if (ids.length === 0) return out;
  const rows = await db.select({ id: players.id, kinds: players.noticeKinds, quietFrom: players.quietFrom, quietTo: players.quietTo, quietTz: players.quietTz }).from(players).where(inArray(players.id, [...ids]));
  for (const r of rows) out.set(r.id, { kinds: r.kinds, quietFrom: r.quietFrom, quietTo: r.quietTo, quietTz: r.quietTz });
  return out;
}

/**
 * Writes the notices, one insert for all of them, and says for each person whether to deliver it now.
 * Never throws into a sender: if the rows cannot be written the notice still goes as it always did,
 * because a notice lost to a hiccup in its own bookkeeping is the one failure this exists to prevent.
 */
export async function recordNotices(db: Db, items: readonly NoticeInput[], now = new Date()): Promise<Map<string, Release>> {
  const out = new Map<string, Release>();
  if (items.length === 0) return out;
  try {
    const settings = await settingsOf(db, [...new Set(items.map((i) => i.playerId))]);
    const rows: (typeof notices.$inferInsert)[] = [];
    for (const it of items) {
      const s = settings.get(it.playerId);
      if (!s) continue;
      const kind = SENDERS[it.sender];
      const { release, dueAt } = releaseOf(s, kind, now, { startsAt: it.startsAt, tz: it.tz });
      out.set(it.playerId, release);
      rows.push({ playerId: it.playerId, kind, eventId: it.eventId ?? null, key: noticeKey(it.sender), params: cleanParams(it.params ?? {}), createdAt: now, deliveredAt: release === "now" ? now : null, dueAt });
    }
    if (rows.length) await db.insert(notices).values(rows);
  } catch (e) {
    console.warn("[notices] could not record", e);
    for (const it of items) if (!out.has(it.playerId)) out.set(it.playerId, "now");
  }
  return out;
}

/** The same gate for one person. */
export async function recordNotice(db: Db, item: NoticeInput, now = new Date()): Promise<Release> {
  return (await recordNotices(db, [item], now)).get(item.playerId) ?? "off";
}

/**
 * The gate without the row, for the second channel of a notice whose row another path wrote: the
 * Telegram note beside a match's email (`postTelegramNotice`). One read for everybody.
 */
export async function releasesFor(db: Db, playerIds: readonly string[], sender: Sender, about: { startsAt?: Date | null; tz?: string | null } = {}, now = new Date()): Promise<Map<string, Release>> {
  const out = new Map<string, Release>();
  try {
    const settings = await settingsOf(db, [...new Set(playerIds)]);
    for (const [id, s] of settings) out.set(id, releaseOf(s, SENDERS[sender], now, about).release);
  } catch (e) {
    console.warn("[notices] could not read settings", e);
    for (const id of playerIds) out.set(id, "now");
  }
  return out;
}

/** The inbox on My matches: the latest notices, newest first, and how many are unread. Two indexed reads, run one after the other (rule 8). */
export const INBOX_SHOWN = 20;
export type InboxRow = Notice & { code: string | null };
export async function inboxOf(db: Db, playerId: string, limit = INBOX_SHOWN): Promise<{ rows: InboxRow[]; unread: number }> {
  // The match's public code, so a line opens its match: the public page, never a personal link.
  const rows = await db.select({ n: notices, code: events.code }).from(notices).leftJoin(events, eq(events.id, notices.eventId)).where(eq(notices.playerId, playerId)).orderBy(desc(notices.createdAt)).limit(limit);
  const unread = await unreadCount(db, playerId);
  return { rows: rows.map((r) => ({ ...r.n, code: r.code })), unread };
}

/** Unread, counted up to a ceiling: the header says "9+", never a scan of ninety days. */
export const UNREAD_CAP = 9;
export async function unreadCount(db: Db, playerId: string): Promise<number> {
  const rows = await db.select({ id: notices.id }).from(notices).where(and(eq(notices.playerId, playerId), isNull(notices.readAt))).limit(UNREAD_CAP + 1);
  return rows.length;
}

/** Opening the inbox reads it all. */
export async function markInboxRead(db: Db, playerId: string, now = new Date()): Promise<number> {
  const r = await db.update(notices).set({ readAt: now }).where(and(eq(notices.playerId, playerId), isNull(notices.readAt))).returning({ id: notices.id });
  return r.length;
}

/**
 * The people whose quiet hours have ended with notices waiting, and how many each. Bounded, and read
 * on the partial index `notices_due_idx`; a person past the bound is answered next hour.
 */
export async function quietSummariesDue(db: Db, now = new Date(), limit = 200): Promise<{ playerId: string; count: number }[]> {
  const rows = await db
    .select({ playerId: notices.playerId, count: sql<number>`count(*)::int` })
    .from(notices)
    .where(and(isNull(notices.deliveredAt), isNotNull(notices.dueAt), lte(notices.dueAt, now)))
    .groupBy(notices.playerId)
    .limit(limit);
  return rows.map((r) => ({ playerId: r.playerId, count: Number(r.count) }));
}

/** After the summary went: the held notices count as delivered, so the next hour does not send it again. */
export async function markHeldDelivered(db: Db, playerIds: readonly string[], now = new Date()): Promise<number> {
  if (playerIds.length === 0) return 0;
  const r = await db
    .update(notices)
    .set({ deliveredAt: now })
    .where(and(inArray(notices.playerId, [...playerIds]), isNull(notices.deliveredAt), isNotNull(notices.dueAt), lte(notices.dueAt, now)))
    .returning({ id: notices.id });
  return r.length;
}

/** Rows older than the inbox keeps, a bounded batch an hour (the `notices_created_idx` range), so one tick never deletes for long. */
export async function pruneNotices(db: Db, now = new Date(), max = 5000): Promise<number> {
  const before = new Date(now.getTime() - INBOX_DAYS * 24 * 3600_000);
  const old = db.select({ id: notices.id }).from(notices).where(lt(notices.createdAt, before)).limit(max);
  const r = await db.delete(notices).where(inArray(notices.id, old)).returning({ id: notices.id });
  return r.length;
}

/** A deleted account takes its inbox: the rows name other people and places (`anonymizePlayer`). */
export async function dropNoticesFor(db: Db, playerId: string): Promise<void> {
  await db.delete(notices).where(eq(notices.playerId, playerId));
}

/** The settings as the /me screen and the gate read them. */
export async function noticeSettingsOf(db: Db, playerId: string): Promise<NoticeSettings | null> {
  return (await settingsOf(db, [playerId])).get(playerId) ?? null;
}

export async function saveNoticeSettings(db: Db, playerId: string, s: { kinds: NoticeSettings["kinds"]; quietFrom: number | null; quietTo: number | null; quietTz: string | null }): Promise<void> {
  await db.update(players).set({ noticeKinds: s.kinds ?? {}, quietFrom: s.quietFrom, quietTo: s.quietTo, quietTz: s.quietTz }).where(eq(players.id, playerId));
}
