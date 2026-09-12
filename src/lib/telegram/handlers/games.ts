import type { Db } from "@/db";
import { telegramInlineCards, type Event, type TelegramChat } from "@/db/schema";
import { chatLocale, renderHash } from "@/lib/channels/telegram";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { CITIES, cityInText, cityOf, type City } from "@/lib/domain/cities";
import { isOccupied } from "@/lib/domain/events";
import { getEventByCode, getPlayerEvents } from "@/lib/domain/queries";
import { getCityBoard, withCounts } from "@/lib/domain/venueBoard";
import { answerInlineQuery, esc, sendMessage, type InlineArticle, type InlineKeyboard, type TgMessage, type TgUpdate, type TgUser } from "../api";
import { botLocale, cardTitle, renderCard, strings, whenLine, whereLine, type BotLocale } from "../card";
import { findOrCreateTelegramPlayer } from "../identity";
import { codesInText } from "../text";

/** Finding matches: /games in the private chat, and inline mode (@bot in any chat), each result the live card. */

/** The city a player plays in: the chat's zone, their last match, or the only city in that zone. */
async function playerCity(db: Db, playerId: string, chat: TelegramChat | null): Promise<City | null> {
  const { upcoming, past } = await getPlayerEvents(db, playerId);
  for (const m of [...upcoming, ...past]) {
    const c = cityOf(m.event.tz, m.event.venueSlug);
    if (c) return c;
  }
  const tz = chat?.tz ?? upcoming[0]?.event.tz ?? past[0]?.event.tz ?? null;
  return tz ? (CITIES.find((c) => c.tz === tz) ?? null) : null;
}

const shortLine = (ev: Event, locale: BotLocale, occupied: number) => `${formatEventDay(ev.startsAt, ev.tz, locale)} · ${formatEventTime(ev.startsAt, ev.tz, locale)} · ${ev.venueName ?? strings(locale).courtTbd} · ${occupied}/${ev.capacity}`;

/** /games [city]: the player's own upcoming matches, then the open ones listed in their city, each one tap from its card. */
export
async function gamesFromChat(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, args: string): Promise<string> {
  const locale = chatLocale(chat);
  const s = strings(locale);
  const base = baseUrl();
  const player = await findOrCreateTelegramPlayer(db, from);
  const city = cityInText(args) ?? (await playerCity(db, player.id, chat));
  const { upcoming } = await getPlayerEvents(db, player.id);
  const mine = await withCounts(db, upcoming.map((m) => m.event).filter((e) => e.status !== "cancelled").slice(0, 5));
  const board = city ? (await getCityBoard(db, city)).events.filter((b) => !mine.some((m) => m.event.id === b.event.id)).slice(0, 10) : [];
  const lines: string[] = [];
  if (mine.length) {
    lines.push(`<b>${esc(s.gamesMine)}</b>`);
    for (const m of mine) lines.push(`• <a href="${base}/${m.event.code}">${esc(shortLine(m.event, locale, m.occupied))}</a>`);
    lines.push("");
  }
  if (!city) lines.push(esc(s.gamesWhichCity));
  else if (board.length === 0) lines.push(esc(s.gamesNone(city.name)));
  else {
    lines.push(`<b>${esc(s.gamesTitle(city.name))}</b>`);
    for (const b of board) lines.push(`• ${esc(shortLine(b.event, locale, b.occupied))}${b.event.cost ? ` · ${esc(b.event.cost)}` : ""}`);
  }
  const keyboard: InlineKeyboard = { inline_keyboard: board.map((b) => [{ text: shortLine(b.event, locale, b.occupied).slice(0, 60), callback_data: `c:${b.event.code}` }]) };
  await sendMessage(chat.chatId, lines.join("\n"), { keyboard: board.length ? keyboard : null, replyTo: msg.message_id, silent: true, threadId: msg.message_thread_id ?? null });
  return `games:${mine.length}+${board.length}`;
}

/** "@bot" in any chat: the player's matches, the open ones in their city, one exact code, or a search. Each result is the live card. */
export
async function handleInlineQuery(db: Db, q: NonNullable<TgUpdate["inline_query"]>): Promise<string> {
  const locale = botLocale(q.from.language_code);
  const s = strings(locale);
  const base = baseUrl();
  const player = await findOrCreateTelegramPlayer(db, q.from);
  const query = q.query.trim();
  const code = codesInText(query, base)[0] ?? (isValidShareCode(query) ? query : null);
  let candidates: Event[] = [];
  if (code) {
    const d = await getEventByCode(db, code);
    if (d && d.event.status !== "cancelled") candidates = [d.event];
  } else {
    const { upcoming } = await getPlayerEvents(db, player.id);
    candidates = upcoming.map((m) => m.event).filter((e) => e.status !== "cancelled");
    const cityNamed = cityInText(query);
    const city = cityNamed ?? (await playerCity(db, player.id, null));
    if (city) for (const b of (await getCityBoard(db, city)).events) if (!candidates.some((c) => c.id === b.event.id)) candidates.push(b.event);
    if (query && !cityNamed) {
      const needle = query.toLowerCase();
      candidates = candidates.filter((e) => `${e.venueName ?? ""} ${e.title ?? ""}`.toLowerCase().includes(needle));
    }
  }
  const articles: InlineArticle[] = [];
  for (const ev of candidates.slice(0, 10)) {
    const detail = await getEventByCode(db, ev.code);
    if (!detail) continue;
    const { text, keyboard } = renderCard(detail, base, locale);
    const occupied = detail.roster.filter((x) => x.position <= ev.capacity && isOccupied(x)).length;
    articles.push({ id: ev.code, title: `${cardTitle(detail, locale)} · ${whenLine(detail, locale)}`, description: `${whereLine(detail, locale)} · ${s.spotsShort(occupied, ev.capacity)}${ev.cost ? ` · ${ev.cost}` : ""}`, text, keyboard });
  }
  await answerInlineQuery(q.id, articles, articles.length ? {} : { switchPmText: s.inlineHint, switchPmParameter: "new" });
  return `inline:${articles.length}`;
}

/** The user sent one of our inline results somewhere: remember the message so the card stays live. */
export
async function rememberInlineCard(db: Db, inlineMessageId: string, code: string, locale: BotLocale): Promise<boolean> {
  const detail = await getEventByCode(db, code);
  if (!detail) return false;
  const { text, keyboard } = renderCard(detail, baseUrl(), locale);
  await db
    .insert(telegramInlineCards)
    .values({ inlineMessageId, eventId: detail.event.id, locale, rendered: renderHash(text, keyboard) })
    .onConflictDoNothing();
  return true;
}
