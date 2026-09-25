import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, lineCards, lineRooms, type LineCard, type LineRoom } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { lineEnabled, push, reply, type LineMessage } from "@/lib/line/api";
import { renderLineCard } from "@/lib/line/card";
import { botLocale, strings, type BotLocale } from "@/lib/telegram/card";
import type { Card, CardChannel, Room } from "./types";

/**
 * LINE as a card channel, with the one difference that changes the rules: a sent message cannot be
 * edited. `canEdit: false` makes the algorithm key on `materialKey(detail)` instead of a render hash,
 * so a fresh card goes out only when something a player would notice actually changed.
 *
 * And a reply is free where a push is metered, so `post` uses the reply token when the router hands
 * one over — anything answering a person — and pushes only for what the app starts by itself.
 */
export type LinePayload = { messages: LineMessage[] };
type LnRoom = Room<LineRoom>;
type LnCard = Card<LineCard>;

export const roomLocale = (r: LineRoom | null, fallback?: string | null): BotLocale => botLocale(r ? r.locale : fallback);
export const lineRoomOf = (room: LineRoom): LnRoom => ({ id: room.roomId, locale: roomLocale(room), groupId: room.groupId, raw: room });
const cardOf = (c: LineCard): LnCard => ({ id: c.id, kind: c.kind, messageId: c.messageId, rendered: c.rendered, completeNotedAt: c.completeNotedAt, raw: c });

/** The bot was removed, or the room is gone: keep the row, stop pushing into it. */
async function noteGone(db: Db, room: LineRoom, res: { ok: false; status: number; error: string }): Promise<void> {
  if (res.status === 403 || res.status === 404) await db.update(lineRooms).set({ leftAt: new Date() }).where(eq(lineRooms.roomId, room.roomId));
}

async function send(db: Db, room: LineRoom, messages: LineMessage[], replyToken?: string | null): Promise<{ ok: boolean }> {
  const res = replyToken ? await reply(String(replyToken), messages) : await push(room.roomId, messages);
  if (!res.ok) await noteGone(db, room, res);
  return { ok: res.ok };
}

export const lineChannel: CardChannel<LinePayload, LineRoom, LineCard> = {
  name: "line",
  enabled: lineEnabled,
  canEdit: false,
  async roomsOfGroup(db, groupId) {
    const rows = await db.select().from(lineRooms).where(and(eq(lineRooms.groupId, groupId), isNull(lineRooms.leftAt))).limit(50);
    return rows.map(lineRoomOf);
  },
  async cardsOf(db, eventId, kinds) {
    const rows = await db
      .select({ card: lineCards, room: lineRooms })
      .from(lineCards)
      .innerJoin(lineRooms, eq(lineRooms.roomId, lineCards.roomId))
      .where(and(eq(lineCards.eventId, eventId), isNull(lineRooms.leftAt), ...(kinds?.length ? [inArray(lineCards.kind, kinds)] : [])));
    return rows.map(({ card, room }) => ({ card: cardOf(card), room: lineRoomOf(room) }));
  },
  render(detail, locale) {
    const card = renderLineCard(detail, baseUrl(), locale);
    return { payload: { messages: card.messages }, hash: card.hash, complete: card.complete };
  },
  async post(db, room, payload, o = {}) {
    const sent = await send(db, room.raw, payload.messages, o.replyTo ? String(o.replyTo) : null);
    // LINE's reply and push both answer with an empty body: there is no message id to keep. The room
    // and the material key are what the algorithm actually needs, so the id is the moment it was sent.
    return sent.ok ? { ok: true, messageId: `sent-${Date.now()}` } : { ok: false };
  },
  async edit() {
    // Never reached: `canEdit` is false, so the algorithm posts a fresh card instead of editing. It
    // is false here rather than absent because the interface asks for it, and because a channel that
    // silently "succeeded" at editing would leave every card in every chat permanently stale.
    return false;
  },
  async note(db, room, text) {
    // A note is a push, and on this channel a push is money. The complete-line-up note is the only
    // one the algorithm sends, once per card, which is a price worth paying.
    const sent = await send(db, room.raw, [{ type: "text", text }]);
    return sent.ok;
  },
  async result(db, room, summary) {
    const s = strings(summary.locale);
    const lines = [summary.score, summary.winners, summary.praise, summary.banter, summary.podium].filter(Boolean) as string[];
    const messages: LineMessage[] = [
      { type: "text", text: [summary.title, ...lines, `${s.open}: ${summary.url}`].join("\n") },
      { type: "image", originalContentUrl: summary.imageUrl, previewImageUrl: summary.imageUrl },
    ];
    const sent = await send(db, room.raw, messages);
    return sent.ok ? { ok: true, messageId: `result-${Date.now()}` } : { ok: false };
  },
  async saveCard(db, eventId, room, messageId, kind, rendered) {
    // An upsert, not a do-nothing. On a channel that cannot edit, every sync posts a *new* card and
    // lands here again for the same (event, room, kind); if the row kept its old material key the
    // algorithm would decide the card was stale and push another one, on every tick, forever. That
    // is the whole monthly budget spent on one match.
    await db
      .insert(lineCards)
      .values({ eventId, roomId: room.raw.roomId, messageId: String(messageId), kind, rendered })
      .onConflictDoUpdate({ target: [lineCards.eventId, lineCards.roomId, lineCards.kind], set: { messageId: String(messageId), rendered, updatedAt: new Date() } });
  },
  async markRendered(db, card, rendered) {
    await db.update(lineCards).set({ rendered, updatedAt: new Date() }).where(eq(lineCards.id, card.id));
  },
  async markCompleteNoted(db, card) {
    await db.update(lineCards).set({ completeNotedAt: new Date() }).where(eq(lineCards.id, card.id));
  },
  async bindGroup(db, room, groupId) {
    await db.update(lineRooms).set({ groupId }).where(and(eq(lineRooms.roomId, room.raw.roomId), isNull(lineRooms.groupId)));
  },
  async remindersDue(db, now, soon) {
    return db
      .select({ id: events.id, code: events.code })
      .from(events)
      .where(and(gt(events.startsAt, now), lte(events.startsAt, soon), isNull(events.lineReminderSentAt), inArray(events.status, ["open", "full"]), sql`exists (select 1 from ${lineCards} c where c.event_id = ${events.id} and c.kind = 'card')`))
      .limit(50);
  },
  async markReminded(db, eventId, now) {
    await db.update(events).set({ lineReminderSentAt: now }).where(eq(events.id, eventId));
  },
};
