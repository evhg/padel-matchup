import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { discordCards, discordChannels, events, type DiscordCard, type DiscordChannel } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { createMessage, discordEnabled, editMessage } from "@/lib/discord/api";
import { renderDiscordCard, type DiscordCard as DiscordCardPayload } from "@/lib/discord/card";
import { botLocale, strings, type BotLocale } from "@/lib/telegram/card";
import type { Card, CardChannel, Room } from "./types";

/** Discord as a card channel: an embed with buttons, edited in place; a lost channel is remembered, a deleted card forgotten. */
export type DiscordPayload = Pick<DiscordCardPayload, "embeds" | "components">;
type DcRoom = Room<DiscordChannel>;
type DcCard = Card<DiscordCard>;

export const channelLocale = (c: DiscordChannel | null, fallback?: string | null): BotLocale => (c ? (c.locale === "ru" ? "ru" : "en") : botLocale(fallback));
export const discordRoom = (channel: DiscordChannel): DcRoom => ({ id: channel.channelId, locale: channelLocale(channel), groupId: channel.groupId, raw: channel });
const cardOf = (c: DiscordCard): DcCard => ({ id: c.id, kind: c.kind, messageId: c.messageId, rendered: c.rendered, completeNotedAt: c.completeNotedAt, raw: c });

/** A 403 / missing access means the bot cannot see the channel any more; a 404 message means the card was deleted. */
async function noteFailure(db: Db, channel: DiscordChannel, cardId: string | null, res: { ok: false; status: number; error: string }): Promise<void> {
  if (res.status === 403 || /Missing Access|Missing Permissions/i.test(res.error)) await db.update(discordChannels).set({ leftAt: new Date() }).where(eq(discordChannels.channelId, channel.channelId));
  else if (res.status === 404 && cardId) await db.delete(discordCards).where(eq(discordCards.id, cardId));
}

export const discordChannel: CardChannel<DiscordPayload, DiscordChannel, DiscordCard> = {
  name: "discord",
  enabled: discordEnabled,
  canEdit: true,
  async roomsOfGroup(db, groupId) {
    const rows = await db.select().from(discordChannels).where(and(eq(discordChannels.groupId, groupId), isNull(discordChannels.leftAt))).limit(50);
    return rows.map(discordRoom);
  },
  async cardsOf(db, eventId, kinds) {
    const rows = await db
      .select({ card: discordCards, channel: discordChannels })
      .from(discordCards)
      .innerJoin(discordChannels, eq(discordChannels.channelId, discordCards.channelId))
      .where(and(eq(discordCards.eventId, eventId), isNull(discordChannels.leftAt), ...(kinds?.length ? [inArray(discordCards.kind, kinds)] : [])));
    return rows.map(({ card, channel }) => ({ card: cardOf(card), room: discordRoom(channel) }));
  },
  render(detail, locale) {
    const card = renderDiscordCard(detail, baseUrl(), locale);
    return { payload: { embeds: card.embeds, components: card.components }, hash: card.hash, complete: card.complete };
  },
  async post(db, room, payload, o = {}) {
    const sent = await createMessage(room.raw.channelId, { embeds: payload.embeds, components: payload.components, replyTo: o.replyTo ? String(o.replyTo) : null, suppressNotifications: o.silent });
    if (!sent.ok) {
      await noteFailure(db, room.raw, null, sent);
      return { ok: false };
    }
    return { ok: true, messageId: sent.result.id };
  },
  async edit(db, room, card, payload) {
    const res = await editMessage(room.raw.channelId, String(card.messageId), { embeds: payload.embeds, components: payload.components });
    if (!res.ok) await noteFailure(db, room.raw, card.id, res);
    return res.ok;
  },
  async note(_db, room, text, o = {}) {
    const res = await createMessage(room.raw.channelId, { content: text, replyTo: o.replyTo ? String(o.replyTo) : null, suppressNotifications: o.silent });
    return res.ok;
  },
  async result(_db, room, summary, o = {}) {
    const s = strings(summary.locale);
    const lines: string[] = [];
    if (summary.score) lines.push(`**${summary.score}**`);
    if (summary.winners) lines.push(summary.winners, summary.praise ?? "");
    if (summary.podium) lines.push(summary.podium);
    const res = await createMessage(room.raw.channelId, {
      embeds: [{ title: summary.title, url: summary.url, description: lines.filter(Boolean).join("\n") || undefined, image: { url: summary.imageUrl }, color: 0x0ea5e9 }],
      components: [{ type: 1, components: [{ type: 2, style: 5, label: s.open, url: summary.url }] }],
      replyTo: o.replyTo ? String(o.replyTo) : null,
    });
    return res.ok ? { ok: true, messageId: res.result.id } : { ok: false };
  },
  async saveCard(db, eventId, room, messageId, kind, rendered) {
    await db.insert(discordCards).values({ eventId, channelId: room.raw.channelId, messageId: String(messageId), kind, rendered }).onConflictDoNothing();
  },
  async markRendered(db, card, rendered) {
    await db.update(discordCards).set({ rendered, updatedAt: new Date() }).where(eq(discordCards.id, card.id));
  },
  async markCompleteNoted(db, card) {
    await db.update(discordCards).set({ completeNotedAt: new Date() }).where(eq(discordCards.id, card.id));
  },
  async bindGroup(db, room, groupId) {
    await db.update(discordChannels).set({ groupId }).where(and(eq(discordChannels.channelId, room.raw.channelId), isNull(discordChannels.groupId)));
  },
  async remindersDue(db, now, soon) {
    return db
      .select({ id: events.id, code: events.code })
      .from(events)
      .where(and(gt(events.startsAt, now), lte(events.startsAt, soon), isNull(events.discordReminderSentAt), inArray(events.status, ["open", "full"]), sql`exists (select 1 from ${discordCards} c where c.event_id = ${events.id} and c.kind = 'card')`))
      .limit(50);
  },
  async markReminded(db, eventId, now) {
    await db.update(events).set({ discordReminderSentAt: now }).where(eq(events.id, eventId));
  },
};
