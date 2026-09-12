import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { telegramCards, telegramChats, type Player } from "@/db/schema";
import { chatLocale } from "@/lib/channels/telegram";
import { baseUrl } from "@/lib/config";
import { isOccupied } from "@/lib/domain/events";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import type { CreatorKind } from "@/lib/notify";
import { personalEventUrl } from "@/lib/personal";
import { editMessageText, editOk, esc, messageGone, sendMessage, telegramEnabled } from "./api";
import { botLocale, cardTitle, strings, whenLine, whereLine, type BotLocale } from "./card";

/**
 * Notices: the two things a player must not miss, and the organizer's feed.
 * Players who joined from a card have no email and no push; Telegram is the
 * only way to reach them. A private message when the bot may send one (the
 * player pressed Start once, or signed in on the site), and a reply under the
 * card mentioning them either way.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

type TgPerson = { playerId: string; telegramId: number; username: string | null; name: string; locale: BotLocale };

/** Telegram-linked people in the line-up, minus one (whoever caused the change). */
function telegramPeople(detail: EventDetail, except?: string | null): TgPerson[] {
  const out: TgPerson[] = [];
  for (const s of detail.roster) {
    const p = s.player;
    if (!isOccupied(s) || !p?.telegramId || s.playerId === except) continue;
    out.push({ playerId: p.id, telegramId: p.telegramId, username: p.telegramUsername, name: p.displayName, locale: botLocale(p.locale) });
  }
  return out;
}

const mention = (p: TgPerson) => (p.username ? `@${esc(p.username)}` : `<a href="tg://user?id=${p.telegramId}">${esc(p.name)}</a>`);

/** A time or venue change, or a cancellation: one reply under each card, one private message per Telegram player. Never throws. */
export async function postTelegramNotice(db: Db, code: string, kind: "updated" | "cancelled"): Promise<{ notes: number; dms: number }> {
  const none = { notes: 0, dms: 0 };
  if (!telegramEnabled()) return none;
  try {
    const detail = await getEventByCode(db, code);
    if (!detail) return none;
    const ev = detail.event;
    if (kind === "updated" && (ev.status === "cancelled" || ev.status === "past")) return none;
    const text = (locale: BotLocale) => {
      const s = strings(locale);
      const title = cardTitle(detail, locale);
      return kind === "cancelled" ? s.cancelledNote(title, whenLine(detail, locale)) : s.changedNote(title, whenLine(detail, locale), whereLine(detail, locale));
    };
    const people = telegramPeople(detail, ev.creatorPlayerId);
    const cards = await db
      .select({ card: telegramCards, chat: telegramChats })
      .from(telegramCards)
      .innerJoin(telegramChats, eq(telegramChats.chatId, telegramCards.chatId))
      .where(and(eq(telegramCards.eventId, ev.id), eq(telegramCards.kind, "card"), isNull(telegramChats.leftAt)));
    let notes = 0;
    for (const { card, chat } of cards) {
      const tags = people.slice(0, 16).map(mention).join(" ");
      const res = await sendMessage(chat.chatId, tags ? `${esc(text(chatLocale(chat)))}\n${tags}` : esc(text(chatLocale(chat))), { replyTo: card.messageId });
      if (res.ok) notes++;
    }
    let dms = 0;
    const base = baseUrl();
    for (const p of people) {
      const token = await getOrCreatePersonalToken(db, p.playerId);
      const res = await sendMessage(p.telegramId, esc(text(p.locale)), { keyboard: { inline_keyboard: [[{ text: strings(p.locale).open, url: personalEventUrl(base, token, ev.code) }]] } });
      if (res.ok) dms++;
    }
    return { notes, dms };
  } catch {
    return none;
  }
}

/** The organizer's running message keeps this many lines and lives a day from the moment it was sent; after that a new one starts. */
const FEED_LINES = 8;
const FEED_WINDOW_MS = DAY_MS;
/** Changes that quietly update the running message. */
const FEED_QUIET: ReadonlySet<CreatorKind> = new Set<CreatorKind>(["joined", "waitlisted", "confirmed", "promoted"]);
/** Changes that speak up in a new message, with a sound: a leave, a decline, an ask the organizer has to answer. */
const FEED_LOUD: ReadonlySet<CreatorKind> = new Set<CreatorKind>(["left", "declined", "requested"]);
const FEED_RETRY_MS = 1200;
const feedLines = (raw: string | null): string[] => {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/**
 * The organizer's private feed: one running message per match, edited as people join
 * (padel chats have message fatigue; the fewer messages the better), a new message only
 * when someone leaves, declines or asks. The feed row in telegram_cards (kind "feed") is
 * the source of truth: a line is appended there first, atomically, and the message follows
 * it, so two joins in the same second both show and a hiccup at Telegram loses nothing.
 */
export async function telegramCreatorNote(db: Db, detail: EventDetail, creator: Player, kind: CreatorKind, actorName: string, now = new Date()): Promise<boolean> {
  if (!telegramEnabled() || !creator.telegramId) return false;
  try {
    const locale = botLocale(creator.locale);
    const s = strings(locale);
    const ev = detail.event;
    const chatId = creator.telegramId;
    const n = detail.roster.filter((x) => x.position <= ev.capacity && isOccupied(x)).length;
    const token = await getOrCreatePersonalToken(db, creator.id);
    const line = s.orgNote(kind, actorName, n, ev.capacity);
    const footer = `<i>${esc(cardTitle(detail, locale))} · ${esc(whenLine(detail, locale))} · ${esc(whereLine(detail, locale))}</i>`;
    const keyboard = { inline_keyboard: [[{ text: s.open, url: personalEventUrl(baseUrl(), token, ev.code) }]] };
    const render = (lines: string[]) => `${lines.map(esc).join("\n")}\n${footer}`;
    const feedWhere = and(eq(telegramCards.eventId, ev.id), eq(telegramCards.chatId, chatId), eq(telegramCards.kind, "feed"));
    if (FEED_QUIET.has(kind)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const [feed] = await db.select().from(telegramCards).where(feedWhere).limit(1);
        if (!feed || now.getTime() - feed.createdAt.getTime() >= FEED_WINDOW_MS) break;
        const lines = [...feedLines(feed.rendered), line].slice(-FEED_LINES);
        // Compare-and-set on the lines: a neighbour who appended first wins, and we add ours after theirs on the next pass.
        const [claimed] = await db
          .update(telegramCards)
          .set({ rendered: JSON.stringify(lines), updatedAt: now })
          .where(and(eq(telegramCards.id, feed.id), sql`${telegramCards.rendered} is not distinct from ${feed.rendered}`))
          .returning({ id: telegramCards.id });
        if (!claimed) continue;
        let edited = await editMessageText(chatId, feed.messageId, render(lines), keyboard);
        if (!editOk(edited) && !messageGone(edited)) {
          await new Promise((r) => setTimeout(r, FEED_RETRY_MS));
          edited = await editMessageText(chatId, feed.messageId, render(lines), keyboard);
        }
        if (editOk(edited)) {
          // Someone may have appended while we edited: show the latest lines, once more.
          const [latest] = await db.select({ rendered: telegramCards.rendered }).from(telegramCards).where(eq(telegramCards.id, feed.id)).limit(1);
          if (latest && latest.rendered !== JSON.stringify(lines)) await editMessageText(chatId, feed.messageId, render(feedLines(latest.rendered)), keyboard);
          return true;
        }
        // Still failing after the retry but the line is stored: the next edit carries it. Only a message that is gone starts a new one.
        if (!messageGone(edited)) return true;
        break;
      }
    }
    const res = await sendMessage(chatId, render([line]), { keyboard, silent: !FEED_LOUD.has(kind) });
    if (!res.ok) return false;
    // The private chat may be new to us (the organizer linked through the web): the feed row needs its chat row.
    await db.insert(telegramChats).values({ chatId, type: "private", locale }).onConflictDoNothing();
    await db
      .insert(telegramCards)
      .values({ eventId: ev.id, chatId, messageId: res.result.message_id, kind: "feed", rendered: JSON.stringify([line]), createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [telegramCards.eventId, telegramCards.chatId, telegramCards.kind], set: { messageId: res.result.message_id, rendered: JSON.stringify([line]), createdAt: now, updatedAt: now } });
    return true;
  } catch {
    return false;
  }
}
