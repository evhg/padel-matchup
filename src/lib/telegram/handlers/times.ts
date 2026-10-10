import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { events, telegramCards, type TelegramChat } from "@/db/schema";
import type { OpContext } from "@/lib/api/operations";
import { chatLocale } from "@/lib/channels/telegram";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { mayPrepareFor } from "@/lib/booking/prepare";
import { BEST_TIMES, type BestTime } from "@/lib/domain/bestTimes";
import { getShownClub } from "@/lib/domain/clubs";
import { bestTimesForChat, freeAtClub } from "@/lib/domain/freeCourts";
import { parseMatchLength } from "@/lib/domain/matchLength";
import { bumpMetric } from "@/lib/domain/metrics";
import { takeRate } from "@/lib/domain/ratelimit";
import { answerCallbackQuery, deleteMessage, editMessageReplyMarkup, esc, sendMessage, setMessageReaction, type InlineKeyboard, type TgMessage, type TgUpdate, type TgUser } from "../api";
import { strings, type BotLocale } from "../card";
import { getChat, GROUP_TYPES } from "../chats";
import { findTelegramPlayer } from "../identity";
import { createMatchInChat } from "./new";
import { REACTION } from "./words";

/**
 * The best times, in a chat, only when somebody asks (DECIDING rules 5 and 34): "times?", "when can we
 * play?" or /times, in a crew's own group, a player's private chat, or (as /times) any group the bot is
 * in. The bot answers once, as a reply, with up to three free courts as buttons; a button makes the
 * match the way "who's in Thursday 7pm Rawai?" does (`createMatchInChat`), so its card appears, and the
 * answer is taken down. Nothing is sent unasked, and a word that finds nothing in a group is answered
 * with 🤷, not a message. One answer a minute in a chat: asked again at once, the bot stays quiet,
 * because the answer is right there.
 *
 * A button carries its whole state in its 64 bytes: `bt:<start, epoch minutes in base 36>:<length>:<club slug>`.
 */
export const TIMES_CALLBACK = /^bt:/;
const TIMES_DATA = /^bt:([0-9a-z]{1,8}):(60|90|120):([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const DAY_MS = 24 * 3600_000;

const metric = (db: Db, key: string) => bumpMetric(db, key).catch(() => undefined);

const label = (b: BestTime, locale: BotLocale) => `${formatEventDay(b.start, b.tz, locale)} ${formatEventTime(b.start, b.tz, locale)} · ${b.name}`.slice(0, 60);

/** Whose times the answer offers: the platforms named, and "the clubs" for a club's own feed (DECIDING rule 35). */
function sourcesOf(times: readonly BestTime[], s: ReturnType<typeof strings>): string {
  const names = [...new Set(times.map((b) => b.platform ?? s.timesTheClubs))];
  return names.length ? names.join(s.timesAnd) : s.timesTheClubs;
}

/** "times?" or /times: the free courts at the chat's clubs, as buttons, once. */
export async function timesInChat(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, via: "word" | "command", now = new Date()): Promise<string> {
  // One answer a minute in a chat, claimed before anything is read: five asks cost one answer and four upserts.
  if (!(await takeRate(db, "times", `${chat.chatId}:${Math.floor(now.getTime() / 60_000)}`, 1, "hour", now))) return "times_cooldown";
  const locale = chatLocale(chat);
  const s = strings(locale);
  const threadId = msg.message_thread_id ?? null;
  const inGroup = GROUP_TYPES.has(chat.type);
  // A crew's group asks for the crew; anywhere else, the person asking. Looked up, never created.
  const asker = chat.groupId ? null : await findTelegramPlayer(db, from.id);
  // Twice as many as the answer shows, so a club whose slug would not fit Telegram's 64 bytes (left
  // out rather than cut) leaves its place to the next one, never to a false "nothing free".
  const { times, lengthMinutes } = await bestTimesForChat(db, { groupId: chat.groupId, playerId: asker?.id ?? null, venueName: chat.venueName, tz: chat.tz }, now, BEST_TIMES.limit * 2);
  await metric(db, "tg_times_asked");
  const fit = times
    .map((b) => ({ b, button: { text: label(b, locale), callback_data: `bt:${Math.round(b.start.getTime() / 60_000).toString(36)}:${lengthMinutes}:${b.slug}` } }))
    .filter((x) => x.button.callback_data.length <= 64)
    .slice(0, BEST_TIMES.limit);
  const rows: InlineKeyboard["inline_keyboard"] = fit.map((x) => [x.button]);
  if (rows.length === 0) {
    // A word in a group that finds nothing gets a shrug, never a message (rule 5); a command or a private chat a short answer.
    if (via === "word" && inGroup) {
      await setMessageReaction(chat.chatId, msg.message_id, REACTION.none);
      return "times:none";
    }
    await sendMessage(chat.chatId, esc(s.timesNone), { replyTo: msg.message_id, threadId, silent: true });
    return "times:none";
  }
  await sendMessage(chat.chatId, esc(s.timesFree(sourcesOf(fit.map((x) => x.b), s))), { keyboard: { inline_keyboard: rows }, replyTo: msg.message_id, threadId, silent: true });
  return `times:${rows.length}`;
}

/**
 * A tap on one of those buttons: the match at that club, that hour and that length, through the same
 * creation as "who's in …?", unless it already exists here. Checked again at the tap: the button is
 * one the bot put on that message, the hour is still two hours out, and the club still shows the
 * court free. Two taps at once make one match: the first claims the hour in this chat. The answer
 * with the buttons is then taken down (or, past Telegram's 48 hours for a delete, loses its buttons):
 * the card is the answer now.
 */
export async function handleTimesCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, data: string, ctx: OpContext, now = new Date()): Promise<string> {
  const chat = cb.message ? await getChat(db, cb.message.chat.id) : null;
  const s = strings(chatLocale(chat, cb.from.language_code));
  const m = TIMES_DATA.exec(data);
  // Only a button the bot put on this very message: a payload made by hand is nobody's answer.
  const onMessage = (cb.message?.reply_markup?.inline_keyboard ?? []).flat().some((b) => b.callback_data === data);
  if (!chat || !cb.message || !m || !onMessage) {
    await answerCallbackQuery(cb.id, s.toastError);
    return "times_bad";
  }
  const startsAt = new Date(parseInt(m[1], 36) * 60_000);
  const lengthMinutes = parseMatchLength(Number(m[2]));
  if (!(startsAt.getTime() > now.getTime())) {
    await answerCallbackQuery(cb.id, s.newPast);
    return "times_past";
  }
  // A button the bot made is never further out than its week; anything else is not ours.
  if (!lengthMinutes || startsAt.getTime() > now.getTime() + BEST_TIMES.horizonMs + DAY_MS) {
    await answerCallbackQuery(cb.id, s.toastError);
    return "times_bad";
  }
  // The clubs the answer could offer: one that runs its page, or the directory's own row, with a zone.
  const club = await getShownClub(db, m[3]);
  if (!club?.tz || !mayPrepareFor(club)) {
    await answerCallbackQuery(cb.id, s.toastError);
    return "times_no_club";
  }
  // Already on here: the crew's match at that hour, or a card in this chat at that hour.
  const [made] = chat.groupId
    ? await db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.groupId, chat.groupId), eq(events.startsAt, startsAt), inArray(events.status, ["open", "full"])))
        .limit(1)
    : await db
        .select({ id: events.id })
        .from(telegramCards)
        .innerJoin(events, eq(events.id, telegramCards.eventId))
        .where(and(eq(telegramCards.chatId, chat.chatId), eq(telegramCards.kind, "card"), eq(events.startsAt, startsAt), inArray(events.status, ["open", "full"])))
        .limit(1);
  if (made) {
    await answerCallbackQuery(cb.id, s.timesExists);
    return "times_exists";
  }
  // Still reachable, and still free as far as the club's times say: a court booked since is gone.
  if (startsAt.getTime() < now.getTime() + BEST_TIMES.minLeadMs || freeAtClub(club, startsAt, lengthMinutes, now) === "busy") {
    await answerCallbackQuery(cb.id, s.timesGone, { alert: true });
    return "times_gone";
  }
  // Two taps at once both find nothing made: the first to claim this hour in this chat makes it.
  if (!(await takeRate(db, "bt", `${chat.chatId}:${m[1]}`, 1, "hour", now))) {
    await answerCallbackQuery(cb.id, s.timesExists);
    return "times_exists";
  }
  const input = { startsAt, venue: club.name, court: null, type: "match" as const, format: null, capacity: null, levelMin: null, levelMax: null, cost: null, publicListing: false, durationMinutes: lengthMinutes };
  const created = await createMatchInChat(db, chat, cb.from, input, club.tz, ctx, { threadId: cb.message.message_thread_id ?? null });
  if (!created.ok) {
    await answerCallbackQuery(cb.id, created.reason === "past" ? s.newPast : created.reason === "too_many" ? s.tooMany : s.toastError, { alert: true });
    return `times_${created.reason}`;
  }
  // A bot may delete its own message for 48 hours; after that the buttons are taken away instead.
  const deleted = await deleteMessage(chat.chatId, cb.message.message_id);
  if (!deleted.ok) await editMessageReplyMarkup(chat.chatId, cb.message.message_id, { inline_keyboard: [] });
  await answerCallbackQuery(cb.id);
  await metric(db, "tg_match_by_times");
  return `times_created:${created.ev.code}`;
}
