import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, telegramCards, type TelegramChat } from "@/db/schema";
import type { OpContext } from "@/lib/api/operations";
import { chatLocale } from "@/lib/channels/telegram";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { isDomainError } from "@/lib/domain/errors";
import { isOccupied } from "@/lib/domain/events";
import { suggestGroupName } from "@/lib/domain/groupNames";
import { weeklyGroupFromEvent } from "@/lib/domain/groups";
import { praiseLine } from "@/lib/domain/praise";
import { getEventByCode, getPlayerEvents, type EventDetail } from "@/lib/domain/queries";
import { applyEventLevels } from "@/lib/domain/rating";
import { matchResult, WINNER_ONLY_SETS } from "@/lib/domain/result";
import { saveMatchScore, type SetScore } from "@/lib/domain/scores";
import { answerCallbackQuery, botDeepLink, editMessageText, esc, sendMessage, type InlineKeyboard, type TgMessage, type TgUpdate, type TgUser } from "../api";
import { cardTitle, strings, type BotLocale, type BotStrings } from "../card";
import { findOrCreateTelegramPlayer } from "../identity";
import { CODE_RE, codesInText, parseSets } from "../text";

/** The result: a score typed in the chat, the 🏁 tap on the card and the winners' pair, the organizer's confirmation, "same time next week?". */

type Seat = EventDetail["roster"][number];
const seatName = (x: Seat) => x.player?.displayName ?? x.invitedName ?? "?";
export
const playingSeats = (detail: EventDetail): Seat[] => detail.roster.filter((x) => x.position <= detail.event.capacity && isOccupied(x) && x.playerId).sort((a, b) => a.position - b.position);
/** Both pairs, once they are known (set on the site, or by the first result tap). */
function teamsOf(detail: EventDetail): { a: Seat[]; b: Seat[] } | null {
  const seats = playingSeats(detail);
  const a = seats.filter((x) => x.team === "a");
  const b = seats.filter((x) => x.team === "b");
  return a.length === 2 && b.length === 2 ? { a, b } : null;
}
const scoreErrorText = (s: BotStrings, e: unknown) => (isDomainError(e) ? (e.code === "not_started" ? s.notYet : e.code === "locked" ? s.resultLocked : e.code === "not_participant" ? s.onlyPlayers : s.toastError) : s.toastError);

/** "/score CODE 6-3 6-4", or "/score 6-3 6-4" as a reply to the card. Needs the pairs to be known. */
export
async function scoreFromChat(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, args: string, ctx: OpContext): Promise<string> {
  const s = strings(chatLocale(chat));
  const say = (text: string) => sendMessage(chat.chatId, esc(text), { replyTo: msg.message_id, threadId: msg.message_thread_id ?? null, silent: true });
  const sets = parseSets(args);
  const base = baseUrl();
  let code: string | null = codesInText(args, base)[0] ?? args.replace(/\d{1,2}\s*[-:]\s*\d{1,2}/g, " ").match(CODE_RE)?.[1] ?? null;
  if (!code && msg.reply_to_message) {
    const [row] = await db.select({ code: events.code }).from(telegramCards).innerJoin(events, eq(events.id, telegramCards.eventId)).where(and(eq(telegramCards.chatId, chat.chatId), eq(telegramCards.messageId, msg.reply_to_message.message_id))).limit(1);
    code = row?.code ?? null;
  }
  const detail = code && isValidShareCode(code) ? await getEventByCode(db, code) : null;
  if (!detail || detail.event.type !== "match" || sets.length === 0) {
    await say(s.scoreHow);
    return "score_how";
  }
  if (!teamsOf(detail)) {
    await say(s.scoreNoTeams);
    return "score_no_teams";
  }
  const player = await findOrCreateTelegramPlayer(db, from);
  const isCreator = player.id === detail.event.creatorPlayerId;
  try {
    await saveMatchScore(db, { eventId: detail.event.id, playerId: player.id, isCreator, sets });
  } catch (e) {
    await say(scoreErrorText(s, e));
    return `score_error:${isDomainError(e) ? e.code : "unknown"}`;
  }
  if (isCreator) await applyEventLevels(db, detail.event.id).catch(() => undefined);
  ctx.emit("match.result", detail.event.code, { confirmed: isCreator });
  await say(s.scoreSaved(sets.map((x) => `${x.sideA}-${x.sideB}`).join(" ")));
  return "score_saved";
}

/** 🏁 on the card: "who won?", one tap per possible pair (or per known pair). */
export
async function handleResultPrompt(cb: NonNullable<TgUpdate["callback_query"]>, detail: EventDetail, locale: BotLocale): Promise<string> {
  const s = strings(locale);
  const ev = detail.event;
  if (ev.type !== "match" || ev.status === "cancelled") {
    await answerCallbackQuery(cb.id, s.toastError);
    return "result:not_match";
  }
  if (Date.now() < ev.startsAt.getTime()) {
    await answerCallbackQuery(cb.id, s.notYet);
    return "result:not_yet";
  }
  if (ev.scoreLockedByCreator) {
    await answerCallbackQuery(cb.id, s.resultLocked);
    return "result:locked";
  }
  const seats = playingSeats(detail);
  if (seats.length !== 4) {
    await answerCallbackQuery(cb.id, s.needFour, { alert: true });
    return "result:need_four";
  }
  const keyboard = resultPromptKeyboard(detail);
  const text = esc(s.whoWon(cardTitle(detail, locale)));
  if (cb.message) {
    await sendMessage(cb.message.chat.id, text, { keyboard, replyTo: cb.message.message_id, silent: true });
    await answerCallbackQuery(cb.id);
    return "result:prompt";
  }
  // Under a card shared through inline mode there is no chat to reply into: the question goes to the tapper privately,
  // or the tap opens our chat with the same question when they never started the bot.
  const dm = await sendMessage(cb.from.id, text, { keyboard, silent: true });
  if (dm.ok) {
    await answerCallbackQuery(cb.id);
    return "result:prompt_dm";
  }
  await answerCallbackQuery(cb.id, undefined, { url: botDeepLink(`r_${ev.code}`) ?? undefined });
  return "result:prompt_deeplink";
}

export
function resultPromptKeyboard(detail: EventDetail): InlineKeyboard {
  const ev = detail.event;
  const seats = playingSeats(detail);
  const label = (w: Seat[]) => `🏆 ${w.map(seatName).join(" & ")}`.slice(0, 60);
  const teams = teamsOf(detail);
  const rows = teams
    ? [[{ text: label(teams.a), callback_data: `w:${ev.code}:a` }], [{ text: label(teams.b), callback_data: `w:${ev.code}:b` }]]
    : [
        [0, 1, 2, 3],
        [0, 2, 1, 3],
        [0, 3, 1, 2],
      ].map(([i, j, k, l]) => [
        { text: label([seats[i], seats[j]]), callback_data: `w:${ev.code}:${seats[i].position}${seats[j].position}` },
        { text: label([seats[k], seats[l]]), callback_data: `w:${ev.code}:${seats[k].position}${seats[l].position}` },
      ]);
  return { inline_keyboard: rows };
}

/** A winner tap: the pairs and who won are saved; the organizer's tap confirms at once, a player's waits for the organizer. */
export
async function handleWinner(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, detail: EventDetail, sel: string, ctx: OpContext, locale: BotLocale): Promise<string> {
  const s = strings(locale);
  const ev = detail.event;
  const player = await findOrCreateTelegramPlayer(db, cb.from);
  const isCreator = player.id === ev.creatorPlayerId;
  let winners: Seat[];
  let teamA: string[] | undefined;
  let sets: SetScore[];
  if (sel === "a" || sel === "b") {
    const teams = teamsOf(detail);
    if (!teams) {
      await answerCallbackQuery(cb.id, s.toastError);
      return "result:no_teams";
    }
    winners = teams[sel];
    sets = [...WINNER_ONLY_SETS[sel]];
  } else {
    const positions = sel.split("").map(Number);
    winners = playingSeats(detail).filter((x) => positions.includes(x.position));
    if (winners.length !== 2) {
      await answerCallbackQuery(cb.id, s.toastError);
      return "result:bad_pick";
    }
    teamA = winners.map((x) => x.playerId!);
    sets = [...WINNER_ONLY_SETS.a];
  }
  try {
    await saveMatchScore(db, { eventId: ev.id, playerId: player.id, isCreator, sets, teamA });
  } catch (e) {
    await answerCallbackQuery(cb.id, scoreErrorText(s, e), { alert: true });
    return `result:error:${isDomainError(e) ? e.code : "unknown"}`;
  }
  if (isCreator) await applyEventLevels(db, ev.id).catch(() => undefined);
  const names = winners.map(seatName).join(" & ");
  if (cb.message) {
    const text = `${esc(isCreator ? s.confirmedNote(names) : s.recorded(names, player.displayName))}\n${esc(praiseLine(locale, ev.code, names))}\n${esc(s.scoreHint(ev.code))}`;
    await editMessageText(cb.message.chat.id, cb.message.message_id, text, isCreator ? null : { inline_keyboard: [[{ text: s.confirmBtn, callback_data: `k:${ev.code}` }]] });
  }
  ctx.emit("match.result", ev.code, { confirmed: isCreator });
  await answerCallbackQuery(cb.id, s.toastSaved);
  return isCreator ? "result:confirmed" : "result:recorded";
}

/** The organizer confirms what a player recorded: the result locks, levels move, the picture is posted. */
export
async function handleConfirm(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, detail: EventDetail, ctx: OpContext, locale: BotLocale): Promise<string> {
  const s = strings(locale);
  const ev = detail.event;
  const player = await findOrCreateTelegramPlayer(db, cb.from);
  if (player.id !== ev.creatorPlayerId) {
    await answerCallbackQuery(cb.id, s.onlyOrganizer);
    return "result:not_organizer";
  }
  const sets = [...detail.scores].sort((x, y) => x.setNumber - y.setNumber).map((x) => ({ setNumber: x.setNumber, sideA: x.sideA, sideB: x.sideB }));
  const teams = teamsOf(detail);
  if (sets.length === 0 || !teams) {
    await answerCallbackQuery(cb.id, s.toastError);
    return "result:nothing";
  }
  try {
    await saveMatchScore(db, { eventId: ev.id, playerId: player.id, isCreator: true, sets });
  } catch (e) {
    await answerCallbackQuery(cb.id, scoreErrorText(s, e), { alert: true });
    return `result:error:${isDomainError(e) ? e.code : "unknown"}`;
  }
  await applyEventLevels(db, ev.id).catch(() => undefined);
  const r = matchResult(
    detail.scores,
    detail.roster.map((x) => ({ team: x.team, status: x.status, name: seatName(x) })),
  );
  const names = r && r.winner !== "draw" ? (r.winner === "a" ? r.a : r.b).join(" & ") : `${teams.a.map(seatName).join(" & ")} · ${teams.b.map(seatName).join(" & ")}`;
  if (cb.message) await editMessageText(cb.message.chat.id, cb.message.message_id, `${esc(s.confirmedNote(names))}${r?.score ? `\n${esc(r.score)}` : ""}\n${esc(praiseLine(locale, ev.code, names))}`, null);
  ctx.emit("match.result", ev.code, { confirmed: true });
  await answerCallbackQuery(cb.id, s.toastSaved);
  return "result:confirmed";
}

/** "Same time next week?" under a result: the crew becomes a group with the match's own weekly slot. */
export
async function handleSameTime(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, detail: EventDetail, locale: BotLocale): Promise<string> {
  const s = strings(locale);
  const ev = detail.event;
  const player = await findOrCreateTelegramPlayer(db, cb.from);
  try {
    const { group, created } = await weeklyGroupFromEvent(db, { eventId: ev.id, actorPlayerId: player.id, fallbackName: suggestGroupName(locale, ev.code) });
    const when = `${formatEventDay(ev.startsAt, ev.tz, locale).split(" ")[0]} ${formatEventTime(ev.startsAt, ev.tz, locale)}`;
    const text = created ? s.groupMade(group.name, when) : s.groupExists(group.name);
    const keyboard: InlineKeyboard = { inline_keyboard: [[{ text: s.open, url: `${baseUrl()}/g/${group.code}` }]] };
    if (cb.message) await sendMessage(cb.message.chat.id, esc(text), { replyTo: cb.message.message_id, keyboard, silent: true });
    else await sendMessage(cb.from.id, esc(text), { keyboard, silent: true });
    await answerCallbackQuery(cb.id);
    return created ? "group:made" : "group:exists";
  } catch (e) {
    await answerCallbackQuery(cb.id, isDomainError(e) && e.code === "forbidden" ? s.onlyPlayersGroup : s.toastError, { alert: true });
    return `group:error:${isDomainError(e) ? e.code : "unknown"}`;
  }
}

const SETS_ONLY_RE = /^\s*\d{1,2}\s*[-:]\s*\d{1,2}(?:[\s,;/]+\d{1,2}\s*[-:]\s*\d{1,2}){0,2}\s*$/;

/** A bare "6-4 6-3": as a reply it scores the card or nudge it answers; in the private chat, the player's freshest finished match. */
export
async function plainScore(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, ctx: OpContext): Promise<string | null> {
  if (!msg.text || !SETS_ONLY_RE.test(msg.text)) return null;
  if (msg.reply_to_message) return scoreFromChat(db, msg, chat, from, msg.text, ctx);
  if (msg.chat.type !== "private") return null;
  const player = await findOrCreateTelegramPlayer(db, from);
  const { past, upcoming } = await getPlayerEvents(db, player.id);
  // The freshest match that has started in the last day and a half; saveMatchScore decides who may still write.
  const fresh = [...past, ...upcoming]
    .filter((m) => m.event.type === "match" && m.event.status !== "cancelled" && m.event.startsAt.getTime() < Date.now() && Date.now() - m.event.startsAt.getTime() < 36 * 3600 * 1000)
    .sort((x, y) => y.event.startsAt.getTime() - x.event.startsAt.getTime())[0];
  if (!fresh) return null;
  return scoreFromChat(db, msg, chat, from, `${fresh.event.code} ${msg.text}`, ctx);
}
