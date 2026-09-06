import { calendarTitle } from "@/lib/calendar";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { isOccupied } from "@/lib/domain/events";
import { formatLevel, formatRange, hasRange } from "@/lib/domain/levels";
import type { EventDetail } from "@/lib/domain/queries";
import { lineupComplete } from "@/lib/lineup";
import { esc, miniAppUrl, type InlineKeyboard } from "./api";

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
    help: "/new tomorrow 19:00 Rawai creates a match right here (or /new alone for the form)\n/match CODE posts the card of an existing match\n/score CODE 6-3 6-4 adds the sets after a match\n/tz phuket sets the chat's time zone once\n/lang en|ru switches my language\nEverything else: one tap on the card.",
    completeNote: (n: number, time: string) => `Line-up complete ✓ ${n} players. See you at ${time}.`,
    reminder: (title: string, where: string, n: number, cap: number) => `⏰ In about an hour: ${title} · ${where}. ${n}/${cap} players.`,
    result: "🏁 Result",
    winner: (names: string) => `🏆 ${names}`,
    privateStart: (url: string) => `Your personal page: ${url}\nIt lists your matches and signs you in on any device.`,
    langSet: "Language: English",
    notHere: "I only work inside group chats and via the buttons. Add me to your padel chat.",
    noMatch: "No match with that code.",
    discordHelp: "/new creates a match for this channel\n/match CODE posts the card of an existing match\n/ask a padel or Kicksmash question\n/lang switches my language\nEverything else: one tap on the card. I also answer questions people ask here, about once an hour.",
    posted: "Card posted.",
    thinking: "Thinking…",
    noAnswer: "I don't have a good answer to that one. Try asking in more detail, or open kicksma.sh/answers.",
    changedNote: (title: string, when: string, where: string) => `🔁 ${title}: now ${when} · ${where}.`,
    cancelledNote: (title: string, when: string) => `❌ ${title} on ${when} is cancelled.`,
    newHowTo: "Tell me when and where, in one line:\n/new tomorrow 19:00 Rawai 400฿\n/new sat 10:00 americano 8 Bangtao\nOr use the form:",
    needTz: "Which time zone is this chat in? Once: /tz phuket (a city or a zone name). Or use the form:",
    tzSet: (tz: string) => `Time zone for this chat: ${tz}.`,
    tzUnknown: "I don't know that zone. Try a city (/tz phuket) or a zone name (/tz Asia/Bangkok).",
    newPast: "That was more than a day ago. For a match you already played, give today's or yesterday's date.",
    tooMany: "That is a lot of matches for one day. Try again tomorrow.",
    resultBtn: "🏁 Result",
    whoWon: (title: string) => `${title}: who won?`,
    notYet: "The match hasn't started yet.",
    needFour: "The result needs four players in the line-up.",
    onlyPlayers: "Only players in this match can enter the result.",
    onlyOrganizer: "Only the organizer can confirm.",
    resultLocked: "The organizer already confirmed the result.",
    recorded: (winners: string, by: string) => `🏆 ${winners}\nRecorded by ${by}. Organizer: confirm below, or tap again to correct.`,
    confirmBtn: "✔ Confirm",
    confirmedNote: (winners: string) => `🏆 ${winners} · confirmed ✓`,
    scoreHint: (code: string) => `Sets, if you like: /score ${code} 6-3 6-4`,
    scoreHow: "Like this: /score CODE 6-3 6-4 (or reply to the card with /score 6-3 6-4).",
    scoreNoTeams: "Tap 🏁 Result on the card first, so I know the teams.",
    scoreSaved: (score: string) => `Saved: ${score}`,
    toastSaved: "Saved ✅",
    share: "📤 Share",
    privateHelp: "Here you can also:\n/new tomorrow 19:00 Rawai creates a match; share its card into any chat with 📤\n/games shows open matches near you (add a city: /games phuket)\nPaste a kicksma.sh link or a code and I show the card.",
    gamesTitle: (city: string) => `Open matches · ${city}`,
    gamesMine: "Your upcoming matches",
    gamesNone: (city: string) => `No open matches listed in ${city} right now. Create one: /new tomorrow 19:00 <club>.`,
    gamesWhichCity: "Which city? /games phuket or /games singapore.",
    inlineNothing: "No matches to share yet. Create one in a chat with me: /new tomorrow 19:00 <club>.",
    inlineHint: "Create a match",
    spotsShort: (n: number, cap: number) => `${n}/${cap}`,
    orgNote: (kind: string, name: string, n: number, cap: number) =>
      kind === "joined" ? `✅ ${name} is in · ${n}/${cap}` : kind === "waitlisted" ? `⏳ ${name} joined the waitlist` : kind === "left" ? `↩️ ${name} left · ${n}/${cap}` : kind === "requested" ? `🙋 ${name} asks to join (outside the level range)` : kind === "confirmed" ? `✅ ${name} confirmed · ${n}/${cap}` : kind === "declined" ? `❌ ${name} declined` : `⬆️ ${name} moved in from the waitlist · ${n}/${cap}`,
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
    help: "/new завтра 19:00 Равай создаёт матч прямо здесь (или просто /new для формы)\n/match КОД публикует карточку существующего матча\n/score КОД 6-3 6-4 добавляет счёт после матча\n/tz пхукет один раз задаёт часовой пояс чата\n/lang en|ru меняет язык\nВсё остальное: одно нажатие на карточке.",
    completeNote: (n: number, time: string) => `Состав собран ✓ ${n} игроков. До встречи в ${time}.`,
    reminder: (title: string, where: string, n: number, cap: number) => `⏰ Примерно через час: ${title} · ${where}. Игроков: ${n}/${cap}.`,
    result: "🏁 Результат",
    winner: (names: string) => `🏆 ${names}`,
    privateStart: (url: string) => `Ваша личная страница: ${url}\nТам все ваши матчи, и она же вход с любого устройства.`,
    langSet: "Язык: русский",
    notHere: "Я работаю в групповых чатах и через кнопки. Добавьте меня в чат вашей падел-компании.",
    noMatch: "Матча с таким кодом нет.",
    discordHelp: "/new создаёт матч для этого канала\n/match КОД публикует карточку существующего матча\n/ask вопрос о паделе или Kicksmash\n/lang меняет язык\nВсё остальное: одно нажатие на карточке. Я также отвечаю на вопросы в канале, примерно раз в час.",
    posted: "Карточка опубликована.",
    thinking: "Думаю…",
    noAnswer: "Хорошего ответа у меня нет. Спросите подробнее или загляните на kicksma.sh/answers.",
    changedNote: (title: string, when: string, where: string) => `🔁 ${title}: теперь ${when} · ${where}.`,
    cancelledNote: (title: string, when: string) => `❌ ${title} ${when} отменён.`,
    newHowTo: "Напишите когда и где, одной строкой:\n/new завтра 19:00 Равай 400฿\n/new сб 10:00 американо 8 Бангтао\nИли через форму:",
    needTz: "В каком часовом поясе этот чат? Один раз: /tz пхукет (город или название зоны). Или через форму:",
    tzSet: (tz: string) => `Часовой пояс чата: ${tz}.`,
    tzUnknown: "Не знаю такой зоны. Попробуйте город (/tz пхукет) или название зоны (/tz Asia/Bangkok).",
    newPast: "Это больше суток назад. Для уже сыгранного матча укажите сегодняшнюю или вчерашнюю дату.",
    tooMany: "Слишком много матчей за день. Попробуйте завтра.",
    resultBtn: "🏁 Результат",
    whoWon: (title: string) => `${title}: кто выиграл?`,
    notYet: "Матч ещё не начался.",
    needFour: "Для результата нужны четыре игрока в составе.",
    onlyPlayers: "Результат могут вносить только участники матча.",
    onlyOrganizer: "Подтвердить может только организатор.",
    resultLocked: "Организатор уже подтвердил результат.",
    recorded: (winners: string, by: string) => `🏆 ${winners}\nВнёс(ла): ${by}. Организатор: подтвердите ниже или нажмите ещё раз, чтобы исправить.`,
    confirmBtn: "✔ Подтвердить",
    confirmedNote: (winners: string) => `🏆 ${winners} · подтверждено ✓`,
    scoreHint: (code: string) => `Счёт по сетам, если хотите: /score ${code} 6-3 6-4`,
    scoreHow: "Вот так: /score КОД 6-3 6-4 (или ответом на карточку: /score 6-3 6-4).",
    scoreNoTeams: "Сначала нажмите 🏁 Результат на карточке, чтобы я знал составы пар.",
    scoreSaved: (score: string) => `Сохранено: ${score}`,
    toastSaved: "Сохранено ✅",
    share: "📤 Поделиться",
    privateHelp: "Здесь тоже можно:\n/new завтра 19:00 Равай создаёт матч; карточку можно отправить в любой чат через 📤\n/games показывает открытые матчи рядом (с городом: /games пхукет)\nВставьте ссылку kicksma.sh или код, и я покажу карточку.",
    gamesTitle: (city: string) => `Открытые матчи · ${city}`,
    gamesMine: "Ваши ближайшие матчи",
    gamesNone: (city: string) => `Сейчас в ${city} нет открытых матчей. Создайте: /new завтра 19:00 <клуб>.`,
    gamesWhichCity: "Какой город? /games пхукет или /games сингапур.",
    inlineNothing: "Пока нечего отправлять. Создайте матч в чате со мной: /new завтра 19:00 <клуб>.",
    inlineHint: "Создать матч",
    spotsShort: (n: number, cap: number) => `${n}/${cap}`,
    orgNote: (kind: string, name: string, n: number, cap: number) =>
      kind === "joined" ? `✅ ${name} играет · ${n}/${cap}` : kind === "waitlisted" ? `⏳ ${name} в листе ожидания` : kind === "left" ? `↩️ ${name} больше не играет · ${n}/${cap}` : kind === "requested" ? `🙋 ${name} просится в матч (вне диапазона уровней)` : kind === "confirmed" ? `✅ ${name}: участие подтверждено · ${n}/${cap}` : kind === "declined" ? `❌ ${name}: отказ` : `⬆️ ${name} из листа ожидания в состав · ${n}/${cap}`,
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

export function whenLine(detail: EventDetail, locale: BotLocale): string {
  const ev = detail.event;
  return `${formatEventDay(ev.startsAt, ev.tz, locale)} · ${formatEventTime(ev.startsAt, ev.tz, locale)}`;
}

/** The one message per match the bot keeps edited. HTML parse mode. */
export function renderCard(detail: EventDetail, base: string, locale: BotLocale, now = new Date()): { text: string; keyboard: InlineKeyboard; complete: boolean } {
  const ev = detail.event;
  const s = strings(locale);
  // Inside Telegram the match opens in the Mini App (signed in, no browser) once the owner has created it; the web page otherwise.
  const url = miniAppUrl(ev.code) ?? `${base}/${ev.code}`;
  const seats = detail.roster.filter((x) => x.position <= ev.capacity).sort((a, b) => a.position - b.position);
  const occupied = seats.filter(isOccupied).length;
  const complete = lineupComplete(detail.roster, ev.capacity);
  const cancelled = ev.status === "cancelled";
  const started = now.getTime() >= ev.startsAt.getTime();
  const past = ev.status === "past" || started;
  // After the start a match takes its result from the card; once the organizer confirmed, the button goes.
  const resultOpen = ev.type === "match" && !cancelled && started && !ev.scoreLockedByCreator;
  const lines: string[] = [];
  lines.push(`🎾 <b>${esc(cardTitle(detail, locale))}</b>`);
  lines.push(`📅 ${esc(formatEventDay(ev.startsAt, ev.tz, locale))} · ${esc(formatEventTime(ev.startsAt, ev.tz, locale))}`);
  lines.push(`📍 ${esc(whereLine(detail, locale))}`);
  const range = { min: ev.levelMin, max: ev.levelMax };
  if (hasRange(range)) lines.push(`🎚 ${s.level} ${esc(formatRange(range, { between: (a, b) => `${a}–${b}`, plus: (a) => `${a}+`, upTo: (b) => `≤ ${b}` }))}`);
  if (ev.cost) lines.push(`💸 ${esc(ev.cost)}${ev.payNote ? ` · ${esc(ev.payNote)}` : ""}`);
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
      ? { inline_keyboard: resultOpen ? [[{ text: s.resultBtn, callback_data: `r:${ev.code}` }], [{ text: s.open, url }]] : [[{ text: s.open, url }]] }
      : {
          inline_keyboard: [
            [
              { text: s.in, callback_data: `j:${ev.code}` },
              { text: s.out, callback_data: `l:${ev.code}` },
            ],
            [
              { text: s.open, url },
              { text: s.share, switch_inline_query: ev.code },
            ],
          ],
        };
  return { text: lines.join("\n"), keyboard, complete };
}
