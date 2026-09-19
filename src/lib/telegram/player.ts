import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { coaches, type TelegramChat } from "@/db/schema";
import type { OpContext } from "@/lib/api/operations";
import { chatLocale } from "@/lib/channels/telegram";
import { ticketPlayerId, verifyPlayerTicket } from "@/lib/coach/link";
import { listClubsForPicking } from "@/lib/domain/clubs";
import { acceptByInvite } from "@/lib/domain/coaching";
import { claimPartnerSpot, pairSummary } from "@/lib/domain/competitions";
import { CITIES, cityBySlug, cityOf } from "@/lib/domain/cities";
import { recordWant } from "@/lib/domain/demand";
import { isDomainError } from "@/lib/domain/errors";
import { getPlayer } from "@/lib/domain/players";
import { answerCallbackQuery, esc, sendMessage, setChatCommands, type InlineKeyboard, type ReplyKeyboard, type TgMessage, type TgUpdate } from "./api";
import { strings, type BotLocale, type BotStrings } from "./card";
import { chatZone } from "./chats";
import { coachCommand } from "./handlers/start";
import { gamesFromChat } from "./handlers/games";
import { startGuidedNew } from "./handlers/new";
import { findOrCreateTelegramPlayer, linkTelegram } from "./identity";
import { sendRoleMenu } from "./coach";
import { competitionCallback, tournamentsInChat } from "./competitions";

/**
 * The plain player's side of the bot as buttons. A coach and a student had a keyboard; a player had
 * a help text with commands in it. Now every player gets six doors under the text field, the games
 * list asks for the city with buttons, "when I want to play" is a day, an hour and a place as
 * buttons, and three deep links bring people in with one tap: a coach's student invite, a
 * tournament partner's claim, and the "get this on Telegram" line in every email.
 */

export type PlayerWord = "find" | "mine" | "new" | "want" | "tournaments" | "coach" | "help";
export const PLAYER_CALLBACK = /^(pg|pw|pt|pe):/;
const LOCALES: BotLocale[] = ["en", "ru", "es"];
const strip = (label: string) => label.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();

export function playerKeyboard(s: BotStrings): ReplyKeyboard {
  return { keyboard: [[{ text: s.menuFind }, { text: s.menuMine }], [{ text: s.menuNew }, { text: s.menuWant }], [{ text: s.menuTournaments }, { text: s.menuCoach }, { text: s.menuHelp }]], is_persistent: true, resize_keyboard: true, input_field_placeholder: s.menuPlaceholderPlayer };
}

/** A tapped label, in either language, as the door it opens; null for ordinary text. */
export function playerMenuWord(text: string): PlayerWord | null {
  const t = strip(text);
  if (!t) return null;
  for (const locale of LOCALES) {
    const s = strings(locale);
    const table: [string, PlayerWord][] = [
      [s.menuFind, "find"],
      [s.menuMine, "mine"],
      [s.menuNew, "new"],
      [s.menuWant, "want"],
      [s.menuTournaments, "tournaments"],
      [s.menuCoach, "coach"],
      [s.menuHelp, "help"],
    ];
    for (const [label, word] of table) if (strip(label) === t) return word;
  }
  return null;
}

/** The player's commands for the "/" menu, in the chat's language. */
const PLAYER_COMMANDS: Record<BotLocale, { command: string; description: string }[]> = {
  en: [
    { command: "games", description: "Open matches near you" },
    { command: "new", description: "A new match" },
    { command: "want", description: "When I want to play" },
    { command: "tournaments", description: "Open tournaments" },
    { command: "coach", description: "My coach / my book" },
    { command: "help", description: "What I do" },
  ],
  ru: [
    { command: "games", description: "Открытые матчи рядом" },
    { command: "new", description: "Новый матч" },
    { command: "want", description: "Когда хочу играть" },
    { command: "tournaments", description: "Открытые турниры" },
    { command: "coach", description: "Мой тренер / моя книга" },
    { command: "help", description: "Что я умею" },
  ],
  es: [
    { command: "games", description: "Partidos abiertos cerca" },
    { command: "new", description: "Un partido nuevo" },
    { command: "want", description: "Cuándo quiero jugar" },
    { command: "tournaments", description: "Torneos abiertos" },
    { command: "coach", description: "Mi entrenador / mi agenda" },
    { command: "help", description: "Qué hago" },
  ],
};
const playerCommands = (locale: BotLocale) => PLAYER_COMMANDS[locale];

/** The keyboard and the commands for a plain player; the intro line says what the buttons do. */
export async function sendPlayerMenu(chatId: number, locale: BotLocale, o: { intro?: string } = {}): Promise<void> {
  const s = strings(locale);
  await sendMessage(chatId, esc(o.intro ?? s.menuPlayer), { silent: true, keyboard: playerKeyboard(s) });
  await setChatCommands(chatId, playerCommands(locale)).catch(() => undefined);
}

const cityKeyboard = (): InlineKeyboard => ({ inline_keyboard: CITIES.map((c) => [{ text: c.name, callback_data: `pg:${c.slug}` }]) });

/** The city a player plays in, from the chat's zone. */
async function knownCity(db: Db, chat: TelegramChat) {
  const tz = await chatZone(db, chat, null);
  return tz ? (CITIES.find((c) => c.tz === tz) ?? cityOf(tz, null)) : null;
}

/** A tapped door in the private chat. */
export async function playerMenu(db: Db, msg: TgMessage, chat: TelegramChat, from: NonNullable<TgMessage["from"]>, word: PlayerWord, ctx: OpContext): Promise<string> {
  const locale = chatLocale(chat);
  const s = strings(locale);
  void ctx;
  switch (word) {
    case "find": {
      const city = await knownCity(db, chat);
      if (!city) {
        await sendMessage(chat.chatId, esc(s.gamesPickCity), { keyboard: cityKeyboard(), silent: true });
        return "player:find:city";
      }
      return gamesFromChat(db, msg, chat, from, city.name);
    }
    case "mine":
      return gamesFromChat(db, msg, chat, from, "", { mineOnly: true });
    case "new":
      return startGuidedNew(db, msg, chat);
    case "want":
      await sendMessage(chat.chatId, esc(s.wantDay), { keyboard: dayKeyboard(locale, s), silent: true });
      return "player:want:day";
    case "tournaments":
      return tournamentsInChat(db, chat, s, locale);
    case "coach":
      return coachCommand(db, chat, from);
    case "help":
      await sendMessage(chat.chatId, esc(s.menuPlayer), { silent: true, keyboard: playerKeyboard(s) });
      return "player:help";
  }
}

// ---------------------------------------------------------------------------
// "When I want to play" as taps: pw:d:<x|0-6> → pw:t:<d>:<x|HH> → pw:p:<d>:<h>:<c:city|v:slug>
// ---------------------------------------------------------------------------

const dayLabel = (d: number, locale: string) => new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + d)));
const HOURS = [7, 9, 11, 13, 15, 17, 19, 21];

function dayKeyboard(locale: string, s: BotStrings): InlineKeyboard {
  const days = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ text: dayLabel(d, locale), callback_data: `pw:d:${d}` }));
  return { inline_keyboard: [[{ text: s.wantAnyDay, callback_data: "pw:d:x" }], days.slice(0, 4), days.slice(4)] };
}
function hourKeyboard(d: string, s: BotStrings): InlineKeyboard {
  const hours = HOURS.map((h) => ({ text: `${String(h).padStart(2, "0")}:00`, callback_data: `pw:t:${d}:${h}` }));
  return { inline_keyboard: [[{ text: s.wantAnyTime, callback_data: `pw:t:${d}:x` }], hours.slice(0, 4), hours.slice(4)] };
}
async function placeKeyboard(db: Db, chat: TelegramChat, d: string, h: string, s: BotStrings): Promise<InlineKeyboard> {
  const city = await knownCity(db, chat);
  const rows: InlineKeyboard["inline_keyboard"] = [];
  if (city) {
    rows.push([{ text: s.wantCity(city.name), callback_data: `pw:p:${d}:${h}:c:${city.slug}` }]);
    const clubs = (await listClubsForPicking(db)).filter((c) => c.city === city.slug || (c.tz ? cityOf(c.tz, c.slug)?.slug === city.slug : false)).slice(0, 6);
    for (const c of clubs) rows.push([{ text: c.name.slice(0, 40), callback_data: `pw:p:${d}:${h}:v:${c.slug.slice(0, 30)}` }]);
  } else {
    for (const c of CITIES) rows.push([{ text: s.wantCity(c.name), callback_data: `pw:p:${d}:${h}:c:${c.slug}` }]);
  }
  return { inline_keyboard: rows };
}

export async function handlePlayerCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, data: string, chat: TelegramChat): Promise<string> {
  const locale = chatLocale(chat);
  const s = strings(locale);
  const chatId = cb.message?.chat.id ?? chat.chatId;
  const ack = (text?: string) => answerCallbackQuery(cb.id, text).catch(() => undefined);
  if (data.startsWith("pt:") || data.startsWith("pe:")) return competitionCallback(db, cb, data, chat, s, locale);
  const games = data.match(/^pg:([a-z-]{2,30})$/);
  if (games) {
    const city = cityBySlug(games[1]);
    if (!city) {
      await ack();
      return "player:find:unknown_city";
    }
    await ack();
    const msg: TgMessage = { message_id: cb.message?.message_id ?? 0, date: 0, chat: { id: chatId, type: "private" }, from: cb.from, text: "" };
    return gamesFromChat(db, msg, chat, cb.from, city.name);
  }
  const day = data.match(/^pw:d:(x|[0-6])$/);
  if (day) {
    await ack();
    await sendMessage(chatId, esc(s.wantHour), { keyboard: hourKeyboard(day[1], s), silent: true });
    return "player:want:hour";
  }
  const hour = data.match(/^pw:t:(x|[0-6]):(x|\d{1,2})$/);
  if (hour) {
    await ack();
    await sendMessage(chatId, esc(s.wantPlace), { keyboard: await placeKeyboard(db, chat, hour[1], hour[2], s), silent: true });
    return "player:want:place";
  }
  const place = data.match(/^pw:p:(x|[0-6]):(x|\d{1,2}):([cv]):([a-z0-9-]{1,30})$/);
  if (place) {
    const [, d, h, kind, slug] = place;
    // A city button carries a slug we know; anything else would be a want no match could ever meet.
    if (kind === "c" && !cityBySlug(slug)) {
      await ack();
      await sendMessage(chatId, esc(s.wantUnknownPlace), { silent: true });
      return "player:want:unknown_place";
    }
    const player = await findOrCreateTelegramPlayer(db, cb.from);
    const from = h === "x" ? null : `${h.padStart(2, "0")}:00`;
    const to = h === "x" ? null : `${String(Math.min(23, Number(h) + 2)).padStart(2, "0")}:00`;
    try {
      const row = await recordWant(db, { playerId: player.id, weekday: d === "x" ? null : Number(d), onDate: null, fromTime: from, toTime: to, venueSlug: kind === "v" ? slug : null, citySlug: kind === "c" ? slug : null, source: "telegram" });
      await ack();
      const when = row.weekday === null ? s.wantAnyDay : dayLabel(row.weekday, locale);
      const window = row.fromTime && row.toTime ? ` ${row.fromTime}–${row.toTime}` : ` ${s.wantAnyTime}`;
      await sendMessage(chatId, esc(s.wantSaved(`${when}${window}`, row.venueSlug ?? row.citySlug ?? "")), { silent: true });
      return "player:want:saved";
    } catch (e) {
      if (!isDomainError(e)) throw e;
      await ack();
      await sendMessage(chatId, esc(e.code === "too_many" ? s.wantTooMany : s.wantUnknownPlace), { silent: true });
      return `player:want:${e.code}`;
    }
  }
  await ack();
  return "player:callback_unknown";
}

// ---------------------------------------------------------------------------
// Deep links: s_<invite code> (a coach's student), claim_<token> (a tournament partner), p_<ticket> (an email's "get this on Telegram")
// ---------------------------------------------------------------------------

export { bindDeepLink, claimDeepLink, studentDeepLink } from "./deepLinks";

export async function startStudentInvite(db: Db, chat: TelegramChat, from: NonNullable<TgMessage["from"]>, code: string): Promise<string> {
  const locale = chatLocale(chat);
  const s = strings(locale);
  const [found] = await db.select().from(coaches).where(eq(coaches.inviteCode, code)).limit(1);
  if (!found || found.archivedAt) {
    await sendMessage(chat.chatId, esc(s.studentLinkBad), { silent: true });
    return "student_link_bad";
  }
  const player = await findOrCreateTelegramPlayer(db, from);
  await acceptByInvite(db, found.id, player.id);
  await sendMessage(chat.chatId, esc(s.studentJoined(found.displayName)), { silent: true });
  await sendRoleMenu(db, player, chat.chatId, { pin: true });
  return "student_joined";
}

export async function startClaim(db: Db, chat: TelegramChat, from: NonNullable<TgMessage["from"]>, token: string): Promise<string> {
  const locale = chatLocale(chat);
  const s = strings(locale);
  const player = await findOrCreateTelegramPlayer(db, from);
  try {
    const pair = await claimPartnerSpot(db, { token, playerId: player.id });
    const summary = await pairSummary(db, pair.id);
    await sendMessage(chat.chatId, esc(s.claimDone(summary?.categoryName ?? "", summary?.p1Name ?? "")), { silent: true });
    await sendPlayerMenu(chat.chatId, locale);
    return "claim_done";
  } catch (e) {
    if (!isDomainError(e)) throw e;
    await sendMessage(chat.chatId, esc(s.claimBad), { silent: true });
    return "claim_bad";
  }
}

/** The email's line: the ticket names the player the email went to; the tap binds this Telegram account to them. */
export async function startBind(db: Db, chat: TelegramChat, from: NonNullable<TgMessage["from"]>, ticket: string): Promise<string> {
  const locale = chatLocale(chat);
  const s = strings(locale);
  const id = ticketPlayerId(ticket);
  const target = id ? await getPlayer(db, id) : null;
  if (!target || !verifyPlayerTicket(ticket, target) || (target.telegramId !== null && target.telegramId !== from.id)) {
    await sendMessage(chat.chatId, esc(s.bindBad), { silent: true });
    await sendPlayerMenu(chat.chatId, locale);
    return "bind_bad";
  }
  const linked = await linkTelegram(db, target.id, from);
  const menu = await sendRoleMenu(db, linked, chat.chatId, { pin: true });
  if (!menu) await sendPlayerMenu(chat.chatId, locale, { intro: s.linkedPlayer });
  else await sendMessage(chat.chatId, esc(s.linkedPlayer), { silent: true });
  return "bind_done";
}
