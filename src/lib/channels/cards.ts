import { createHash } from "node:crypto";
import type { Db } from "@/db";
import { baseUrl } from "@/lib/config";
import { formatEventTime } from "@/lib/dates";
import { isOccupied } from "@/lib/domain/events";
import { praiseLine } from "@/lib/domain/praise";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { matchResult } from "@/lib/domain/result";
import { cardTitle, strings, whereLine, type BotLocale } from "@/lib/telegram/card";
import type { CardChannel, PostOptions, ResultSummary, Room } from "./types";

/**
 * The one card per match, on any channel: posted once, edited in place, a complete line-up noted once,
 * a reminder about an hour before, the result once. Every function takes the channel it works for and
 * never throws: a chat that cannot be reached is not a failed match.
 */

const occupiedOf = (detail: EventDetail) => detail.roster.filter((x) => x.position <= detail.event.capacity && isOccupied(x)).length;

/** What a card says that matters: when a channel cannot edit, a new card goes out only when this changes. */
export function materialKey(detail: EventDetail): string {
  const ev = detail.event;
  const result = ev.type === "match" ? detail.scores.length : (ev.standings?.length ?? 0);
  return createHash("sha256").update([ev.status, ev.startsAt.toISOString(), ev.venueSlug ?? "", ev.capacity, occupiedOf(detail), result].join("|")).digest("hex");
}

/** Posts the card of a match into a room, or refreshes the one already there. */
export async function postCard<P, R, C>(ch: CardChannel<P, R, C>, db: Db, detail: EventDetail, room: Room<R>, o: PostOptions = {}, now = new Date()): Promise<"posted" | "refreshed" | "failed"> {
  const ev = detail.event;
  const existing = (await ch.cardsOf(db, ev.id, ["card"])).find((c) => c.room.id === room.id);
  if (existing) {
    await syncCards(ch, db, ev.code, now);
    return "refreshed";
  }
  const r = ch.render(detail, room.locale, now);
  const sent = await ch.post(db, room, r.payload, o);
  if (!sent.ok) return "failed";
  await ch.saveCard(db, ev.id, room, sent.messageId, "card", ch.canEdit ? r.hash : materialKey(detail));
  // The first group match carded here ties the room to the group: from now on the group's matches arrive by themselves.
  if (ev.groupId && !room.groupId) await ch.bindGroup(db, room, ev.groupId);
  return "posted";
}

/** A match of a group: its card goes into every room tied to that group. */
export async function postCardsForGroup<P, R, C>(ch: CardChannel<P, R, C>, db: Db, code: string, now = new Date()): Promise<number> {
  if (!ch.enabled()) return 0;
  const detail = await getEventByCode(db, code);
  if (!detail?.event.groupId || detail.event.status === "cancelled") return 0;
  let posted = 0;
  for (const room of await ch.roomsOfGroup(db, detail.event.groupId)) if ((await postCard(ch, db, detail, room, {}, now)) === "posted") posted++;
  return posted;
}

/** After anything changed on a match: edits every card silently, notes a complete line-up once. Never throws. */
export async function syncCards<P, R, C>(ch: CardChannel<P, R, C>, db: Db, code: string, now = new Date()): Promise<number> {
  if (!ch.enabled()) return 0;
  try {
    const detail = await getEventByCode(db, code);
    if (!detail) return 0;
    let edits = 0;
    for (const { card, room } of await ch.cardsOf(db, detail.event.id, ["card"])) {
      const r = ch.render(detail, room.locale, now);
      const key = ch.canEdit ? r.hash : materialKey(detail);
      if (key !== card.rendered) {
        if (ch.canEdit) {
          if (!(await ch.edit(db, room, card, r.payload))) continue;
          await ch.markRendered(db, card, key);
        } else {
          const sent = await ch.post(db, room, r.payload, {});
          if (!sent.ok) continue;
          await ch.saveCard(db, detail.event.id, room, sent.messageId, "card", key);
        }
        edits++;
      }
      if (r.complete && !card.completeNotedAt && detail.event.status !== "cancelled") {
        const s = strings(room.locale);
        const noted = await ch.note(db, room, s.completeNote(occupiedOf(detail), formatEventTime(detail.event.startsAt, detail.event.tz, room.locale)), { replyTo: card.messageId, silent: true });
        if (noted) await ch.markCompleteNoted(db, card);
      }
    }
    if (ch.syncExtra) edits += await ch.syncExtra(db, detail, now);
    return edits;
  } catch {
    return 0;
  }
}

/** About an hour before: one reminder per match into each room that carries its card. */
export async function sendReminders<P, R, C>(ch: CardChannel<P, R, C>, db: Db, now = new Date()): Promise<number> {
  if (!ch.enabled()) return 0;
  const soon = new Date(now.getTime() + 90 * 60 * 1000);
  let sent = 0;
  for (const row of await ch.remindersDue(db, now, soon)) {
    await ch.markReminded(db, row.id, now);
    const detail = await getEventByCode(db, row.code);
    if (!detail) continue;
    for (const { card, room } of await ch.cardsOf(db, row.id, ["card"])) {
      const s = strings(room.locale);
      if (await ch.note(db, room, s.reminder(cardTitle(detail, room.locale), whereLine(detail, room.locale), occupiedOf(detail), detail.event.capacity), { replyTo: card.messageId })) sent++;
    }
  }
  return sent;
}

/** The result of a match as one summary the channel lays out; null while there is nothing to show. */
export function resultSummary(detail: EventDetail, locale: BotLocale, base = baseUrl()): ResultSummary | null {
  const ev = detail.event;
  if (ev.type === "match" ? detail.scores.length === 0 : !ev.standings?.length) return null;
  const s = strings(locale);
  const summary: ResultSummary = { locale, title: `${s.result} · ${cardTitle(detail, locale)}`, score: null, winners: null, praise: null, podium: null, url: `${base}/${ev.code}/card`, imageUrl: `${base}/${ev.code}/card/opengraph-image`, sameTimeCode: ev.type === "match" && !ev.groupId ? ev.code : null };
  if (ev.type === "match") {
    const r = matchResult(
      detail.scores,
      detail.roster.map((x) => ({ team: x.team, status: x.status, name: x.player?.displayName ?? x.invitedName ?? "?" })),
    );
    if (r) {
      summary.score = r.score || null;
      if (r.hasTeams && r.winner !== "draw") {
        const winners = (r.winner === "a" ? r.a : r.b).join(" & ");
        summary.winners = s.winner(winners);
        summary.praise = praiseLine(locale, ev.code, winners);
      }
    }
  } else if (ev.standings?.length) {
    const names = new Map(detail.roster.filter((x) => x.playerId).map((x) => [x.playerId!, x.player?.displayName ?? "?"]));
    summary.podium = s.winner(ev.standings.slice(0, 3).map((id, i) => `${i + 1}. ${names.get(id) ?? "?"}`).join("  "));
  }
  return summary;
}

/** The first result anyone records: once per room, under the card. Never throws. */
export async function postResult<P, R, C>(ch: CardChannel<P, R, C>, db: Db, code: string): Promise<number> {
  if (!ch.enabled()) return 0;
  try {
    const detail = await getEventByCode(db, code);
    if (!detail) return 0;
    const cards = await ch.cardsOf(db, detail.event.id);
    const done = new Set(cards.filter((c) => c.card.kind === "result").map((c) => c.room.id));
    let posted = 0;
    for (const { card, room } of cards.filter((c) => c.card.kind === "card" && !done.has(c.room.id))) {
      const summary = resultSummary(detail, room.locale);
      if (!summary) return 0;
      const res = await ch.result(db, room, summary, { replyTo: card.messageId });
      if (res.ok) {
        await ch.saveCard(db, detail.event.id, room, res.messageId, "result", null);
        posted++;
      }
    }
    return posted;
  } catch {
    return 0;
  }
}
