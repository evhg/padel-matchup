import { calendarTitle } from "@/lib/calendar";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { isOccupied } from "@/lib/domain/events";
import { formatLevel, formatRange, hasRange } from "@/lib/domain/levels";
import type { EventDetail } from "@/lib/domain/queries";
import { lineupComplete } from "@/lib/lineup";
import { esc, type InlineKeyboard } from "./api";

export type BotLocale = "en" | "ru";
export const botLocale = (languageCode: string | null | undefined): BotLocale => (languageCode?.toLowerCase().startsWith("ru") ? "ru" : "en");

/** Bot copy lives here on purpose: short, two languages, no framework. */
const STRINGS = {
  en: {
    match: "Padel match",
    tournament: "Padel tournament",
    formatMexicano: "Mexicano",
    formatKing: "King of the court",
    formatAmericano: "Americano",
    courtTbd: "Court TBD",
    court: (n: string) => `Court ${n}`,
    level: "Level",
    players: "Players",
    reserved: "reserved",
    organizer: "org",
    waitlist: (n: number) => `Waitlist: ${n}`,
    spots: (n: number) => (n === 1 ? "1 spot left" : `${n} spots left`),
    full: "Full · waitlist open",
    closed: "Full",
    complete: "Line-up complete ✓",
    cancelled: "Cancelled",
    past: "Played",
    in: "✅ I'm in",
    out: "❌ Can't make it",
    open: "Open",
    toastJoined: "You're in ✅",
    toastWaitlisted: "Full for now. You're on the waitlist.",
    toastAlready: "You're already in.",
    toastLeft: "Taken you out of the match.",
    toastNotIn: "You weren't in this match.",
    toastLevel: "This match has a level range. Open it once to set your level.",
    toastRequested: "Outside the level range: the organizer will approve.",
    toastClosed: "The match is full and closed.",
    toastPast: "This match is over.",
    toastError: "Something went wrong. Open the match instead.",
    welcome: "Hi. I keep one card per match here and stay quiet otherwise: people join with one tap, the card updates itself. /new creates a match in ten seconds; paste a kicksma.sh link and I turn it into a card.",
    newMatch: "Create the match here (ten seconds). The card lands in this chat:",
    help: "/new creates a match for this chat\n/match CODE posts the card of an existing match\n/lang en|ru switches my language\nEverything else: one tap on the card.",
    completeNote: (n: number, time: string) => `Line-up complete ✓ ${n} players. See you at ${time}.`,
    reminder: (title: string, where: string, n: number, cap: number) => `⏰ In about an hour: ${title} · ${where}. ${n}/${cap} players.`,
    result: "🏁 Result",
    winner: (names: string) => `🏆 ${names}`,
    privateStart: (url: string) => `Your personal page: ${url}\nIt lists your matches and signs you in on any device.`,
    langSet: "Language: English",
    notHere: "I only work inside group chats and via the buttons. Add me to your padel chat.",
    noMatch: "No match with that code.",
  },
  ru: {
    match: "Падел-матч",
    tournament: "Падел-турнир",
    formatMexicano: "Мексикано",
    formatKing: "Король корта",
    formatAmericano: "Американо",
    courtTbd: "Корт уточняется",
    court: (n: string) => `Корт ${n}`,
    level: "Уровень",
    players: "Игроки",
    reserved: "бронь",
    organizer: "орг",
    waitlist: (n: number) => `Лист ожидания: ${n}`,
    spots: (n: number) => `Свободно: ${n}`,
    full: "Мест нет · лист ожидания открыт",
    closed: "Мест нет",
    complete: "Состав собран ✓",
    cancelled: "Отменён",
    past: "Сыгран",
    in: "✅ Играю",
    out: "❌ Не смогу",
    open: "Открыть",
    toastJoined: "Вы в игре ✅",
    toastWaitlisted: "Пока мест нет. Вы в листе ожидания.",
    toastAlready: "Вы уже записаны.",
    toastLeft: "Вы вышли из матча.",
    toastNotIn: "Вы не были записаны.",
    toastLevel: "У матча есть диапазон уровней. Откройте его один раз и укажите свой уровень.",
    toastRequested: "Вне диапазона уровней: организатор подтвердит.",
    toastClosed: "Матч заполнен и закрыт.",
    toastPast: "Матч уже прошёл.",
    toastError: "Что-то пошло не так. Откройте матч.",
    welcome: "Привет. Я веду одну карточку на матч и больше не пишу: люди записываются одним нажатием, карточка обновляется сама. /new создаёт матч за десять секунд; вставьте ссылку kicksma.sh, и я превращу её в карточку.",
    newMatch: "Создайте матч здесь (десять секунд). Карточка появится в этом чате:",
    help: "/new создаёт матч для этого чата\n/match КОД публикует карточку существующего матча\n/lang en|ru меняет язык\nВсё остальное: одно нажатие на карточке.",
    completeNote: (n: number, time: string) => `Состав собран ✓ ${n} игроков. До встречи в ${time}.`,
    reminder: (title: string, where: string, n: number, cap: number) => `⏰ Примерно через час: ${title} · ${where}. Игроков: ${n}/${cap}.`,
    result: "🏁 Результат",
    winner: (names: string) => `🏆 ${names}`,
    privateStart: (url: string) => `Ваша личная страница: ${url}\nТам все ваши матчи, и она же вход с любого устройства.`,
    langSet: "Язык: русский",
    notHere: "Я работаю в групповых чатах и через кнопки. Добавьте меня в чат вашей падел-компании.",
    noMatch: "Матча с таким кодом нет.",
  },
} as const;

export type BotStrings = (typeof STRINGS)[BotLocale];
export const strings = (locale: BotLocale): BotStrings => STRINGS[locale];

const MAX_LINES = 16;

export function cardTitle(detail: EventDetail, locale: BotLocale): string {
  const ev = detail.event;
  const s = strings(locale);
  const fallback = ev.type === "tournament" ? (ev.format === "mexicano" ? s.formatMexicano : ev.format === "king" ? s.formatKing : s.tournament) : s.match;
  return calendarTitle(ev, fallback);
}

export function whereLine(detail: EventDetail, locale: BotLocale): string {
  const ev = detail.event;
  const s = strings(locale);
  const venue = ev.venueName ?? s.courtTbd;
  return ev.court ? `${venue} · ${s.court(ev.court)}` : venue;
}

/** The one message per match the bot keeps edited. HTML parse mode. */
export function renderCard(detail: EventDetail, base: string, locale: BotLocale): { text: string; keyboard: InlineKeyboard; complete: boolean } {
  const ev = detail.event;
  const s = strings(locale);
  const url = `${base}/${ev.code}`;
  const seats = detail.roster.filter((x) => x.position <= ev.capacity).sort((a, b) => a.position - b.position);
  const occupied = seats.filter(isOccupied).length;
  const complete = lineupComplete(detail.roster, ev.capacity);
  const cancelled = ev.status === "cancelled";
  const past = ev.status === "past";
  const lines: string[] = [];
  lines.push(`🎾 <b>${esc(cardTitle(detail, locale))}</b>`);
  lines.push(`📅 ${esc(formatEventDay(ev.startsAt, ev.tz, locale))} · ${esc(formatEventTime(ev.startsAt, ev.tz, locale))}`);
  lines.push(`📍 ${esc(whereLine(detail, locale))}`);
  const range = { min: ev.levelMin, max: ev.levelMax };
  if (hasRange(range)) lines.push(`🎚 ${s.level} ${esc(formatRange(range, { between: (a, b) => `${a}–${b}`, plus: (a) => `${a}+`, upTo: (b) => `≤ ${b}` }))}`);
  lines.push("");
  lines.push(`<b>${s.players} ${occupied}/${ev.capacity}</b>`);
  const shown = seats.slice(0, MAX_LINES);
  for (const seat of shown) {
    if (isOccupied(seat)) {
      const name = seat.player?.displayName ?? seat.invitedName ?? "?";
      const level = seat.player?.level != null ? ` <i>${formatLevel(seat.player.level)}</i>` : "";
      const org = seat.playerId === ev.creatorPlayerId ? ` · ${s.organizer}` : "";
      lines.push(`${seat.position}. ${esc(name)}${level}${org}`);
    } else if (seat.status === "invited") {
      lines.push(`${seat.position}. ${esc(seat.invitedName ?? "?")} <i>(${s.reserved})</i>`);
    } else {
      lines.push(`${seat.position}. —`);
    }
  }
  if (seats.length > shown.length) lines.push(`… +${seats.length - shown.length}`);
  if (detail.waitlist.length > 0) lines.push(s.waitlist(detail.waitlist.length));
  lines.push("");
  const spotsLeft = Math.max(0, ev.capacity - occupied - seats.filter((x) => x.status === "invited").length);
  const status = cancelled ? `❌ <b>${s.cancelled}</b>` : past ? s.past : complete ? `<b>${s.complete}</b>` : spotsLeft > 0 ? `<b>${s.spots(spotsLeft)}</b>` : ev.whenFull === "waitlist" ? s.full : s.closed;
  lines.push(status);
  const keyboard: InlineKeyboard =
    cancelled || past
      ? { inline_keyboard: [[{ text: s.open, url }]] }
      : {
          inline_keyboard: [
            [
              { text: s.in, callback_data: `j:${ev.code}` },
              { text: s.out, callback_data: `l:${ev.code}` },
            ],
            [{ text: s.open, url }],
          ],
        };
  return { text: lines.join("\n"), keyboard, complete };
}
