import { and, asc, eq, gt, gte, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { events, facts, slots, telegramCards, type TelegramChat } from "@/db/schema";
import { ApiError } from "@/lib/api/http";
import { joinAsPlayer, leaveAsPlayer, type OpContext } from "@/lib/api/operations";
import { chatLocale } from "@/lib/channels/telegram";
import { formatEventDay, formatEventTime, utcToZonedParts } from "@/lib/dates";
import { isDomainError } from "@/lib/domain/errors";
import { recordFact } from "@/lib/domain/facts";
import { bumpMetric } from "@/lib/domain/metrics";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { esc, sendMessage, setMessageReaction, telegramBotId, type InlineKeyboard, type TgMessage, type TgUser } from "../api";
import { strings } from "../card";
import { chatZone, GROUP_TYPES } from "../chats";
import { findOrCreateTelegramPlayer, findTelegramPlayer } from "../identity";
import { namesAPlace, parseNewCommand, tzHintFor } from "../parse";
import { syncTelegram } from "../post";
import { readWords, type Word } from "../words";
import { createMatchInChat, knownVenues } from "./new";
import { timesInChat } from "./times";

/**
 * A seat by a word: "+1" in reply to a card in any group, and in a crew's own group (DECIDING rule 31)
 * a plain "in", "out" or "who's in Thursday 7pm Rawai?". The seat goes through the same calls as the
 * card's buttons, the card is edited in place, and the bot answers with one reaction on the person's
 * message: never a message of its own (rule 5). The exceptions go to that person alone as an ephemeral
 * message, or not at all: a question only they can answer (two matches open, which one?), and why a
 * word could not take the seat outright (a level to set, the organiser to accept), which the button's
 * toast would have said. No message text is kept: a word is read, acted on and dropped.
 */

/** 👍 a seat taken, 👌 a seat given back, 🤷 nothing changed for you. Telegram allows bots only its own list, without 👋 or ✋. */
export const REACTION = { in: "👍", out: "👌", none: "🤷" } as const;

/** A seat change worth counting: a seat taken, a waitlist place taken, a seat given back. */
const CHANGED = new Set(["joined", "waitlisted", "left"]);
/** How soon a seat taken by a word and given back again counts as a misread. */
const UNDO_MS = 10 * 60 * 1000;
/** The most matches one ephemeral question offers. */
const MAX_CHOICES = 4;

const metric = (db: Db, key: string) => bumpMetric(db, key).catch(() => undefined);

/** True where the bot reads plain messages: a crew's group that opted in, with the bot still in it. */
export const isListening = (chat: Pick<TelegramChat, "listeningSince" | "leftAt">): boolean => Boolean(chat.listeningSince && !chat.leftAt);

/** Telegram's own account: it forwards a linked channel's posts into the group. */
const TELEGRAM_SERVICE_ID = 777000;

/**
 * The sender's own words, typed here: not a forward, not a channel's post copied in, not a message
 * posted as a chat (an anonymous admin, a channel). Only those can take or free somebody's seat.
 */
export const ownWords = (msg: TgMessage): boolean => !msg.sender_chat && !msg.is_automatic_forward && !msg.forward_origin && !msg.forward_date && msg.from?.id !== TELEGRAM_SERVICE_ID;

/**
 * What a plain line (no reply) means in a crew's group, or null: a join that is not a catch-all answer
 * ("me", "+"), a leave, or a question with a time. Pure, so the router can drop every other line before
 * it reads the database (rule 12).
 */
export function heardInGroup(msg: TgMessage): Exclude<Word, { kind: "score" }> | null {
  if (!msg.text || !ownWords(msg)) return null;
  const said = readWords(msg.text);
  if (!said || said.kind === "score" || (said.kind === "join" && said.onlyAsReply)) return null;
  // In a group, "times?" is a question only with its question mark: "free courts" or "hay pistas" says
  // something to the others and asks the bot nothing (rule 5). A private chat stays lenient.
  if (said.kind === "times" && !/[?¿]/.test(msg.text)) return null;
  return said;
}

/** The message this one answers, or null. In a forum topic every message "answers" the topic's first message, which is not a reply to anyone. */
export function repliedTo(msg: TgMessage): TgMessage | null {
  const parent = msg.reply_to_message;
  return parent && parent.message_id !== msg.message_thread_id ? parent : null;
}

/**
 * The day's counters for a seat changed by a word or a tap, and the one sign of a misread: a seat a
 * word took and the same person gave back within ten minutes. One indexed read on the fact log
 * (`facts_actor_idx`), only for a seat given back, and nothing per row.
 */
export async function countSeat(db: Db, via: "word" | "tap", outcome: string, playerId: string, ev: { id: string; code: string }, now = new Date()): Promise<void> {
  if (!CHANGED.has(outcome)) return;
  await metric(db, via === "word" ? "tg_seat_by_word" : "tg_seat_by_tap");
  if (via === "word" && outcome !== "left") {
    await recordFact(db, { kind: "match.seat_by_word", channel: "telegram", actorPlayerId: playerId, subject: { type: "match", id: ev.id }, code: ev.code, at: now });
    return;
  }
  if (outcome !== "left") return;
  const [taken] = await db
    .select({ id: facts.id })
    .from(facts)
    .where(and(eq(facts.actorPlayerId, playerId), gte(facts.at, new Date(now.getTime() - UNDO_MS)), eq(facts.kind, "match.seat_by_word"), eq(facts.subjectId, ev.id)))
    .limit(1);
  if (taken) await metric(db, "tg_seat_undone_10min");
}

/** Takes or frees the sender's seat as the card's ✅ and ❌ do, edits the card, and reacts once. */
export async function seatByWord(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, detail: EventDetail, kind: "join" | "leave", ctx: OpContext): Promise<string> {
  // A join finds or creates the player as the ✅ button does; a leave never creates anybody.
  const player = kind === "join" ? await findOrCreateTelegramPlayer(db, from) : await findTelegramPlayer(db, from.id);
  let outcome = "not_in";
  if (player) {
    try {
      outcome = kind === "join" ? (await joinAsPlayer(db, detail, player, ctx)).outcome : (await leaveAsPlayer(db, detail, player, ctx)).outcome;
    } catch (e) {
      outcome = `error:${e instanceof ApiError ? e.code : isDomainError(e) ? e.code : "unknown"}`;
    }
  }
  if (CHANGED.has(outcome)) await syncTelegram(db, detail.event.code);
  // A waitlist place is not a seat: 🤷 says so, and the card's waitlist line says the rest.
  const emoji = outcome === "joined" || outcome === "already_in" ? REACTION.in : outcome === "left" ? REACTION.out : REACTION.none;
  await setMessageReaction(chat.chatId, msg.message_id, emoji);
  // A level to set, or a request the organiser must accept: the button's toast, to that person alone (or nobody).
  if (outcome === "requested" || outcome === "error:level_required") {
    const s = strings(chatLocale(chat));
    await sendMessage(chat.chatId, esc(outcome === "requested" ? s.toastRequested : s.toastLevel), { onlyFor: from.id, threadId: msg.message_thread_id ?? null, silent: true });
  }
  if (player) await countSeat(db, "word", outcome, player.id, detail.event);
  return `word_${kind}:${outcome}`;
}

/** Step A: "+1" or "can't make it" in reply to a match card, in any group the bot is in. */
export async function replyToCard(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, ctx: OpContext): Promise<string | null> {
  if (!GROUP_TYPES.has(msg.chat.type) || !msg.text || !ownWords(msg)) return null;
  const parent = repliedTo(msg);
  const botId = telegramBotId();
  if (!parent || (botId && String(parent.from?.id ?? "") !== botId)) return null;
  // The words first: a reply that is not a seat word costs no read at all.
  const said = readWords(msg.text)?.kind;
  if (said !== "join" && said !== "leave") return null;
  const [card] = await db
    .select({ code: events.code })
    .from(telegramCards)
    .innerJoin(events, eq(events.id, telegramCards.eventId))
    .where(and(eq(telegramCards.chatId, chat.chatId), eq(telegramCards.messageId, parent.message_id), eq(telegramCards.kind, "card")))
    .limit(1);
  const detail = card ? await getEventByCode(db, card.code) : null;
  if (!detail) return null;
  return seatByWord(db, msg, chat, from, detail, said, ctx);
}

type OpenCard = { id: string; code: string; startsAt: Date; tz: string; venueName: string | null };

/** The matches with a live card in this chat that have not started, soonest first: one indexed read, a handful of rows. */
async function openCards(db: Db, chatId: number, now: Date): Promise<OpenCard[]> {
  return db
    .select({ id: events.id, code: events.code, startsAt: events.startsAt, tz: events.tz, venueName: events.venueName })
    .from(telegramCards)
    .innerJoin(events, eq(events.id, telegramCards.eventId))
    .where(and(eq(telegramCards.chatId, chatId), eq(telegramCards.kind, "card"), inArray(events.status, ["open", "full"]), gt(events.startsAt, now)))
    .orderBy(asc(events.startsAt))
    .limit(MAX_CHOICES + 1);
}

/** Step B: a plain message in a crew's own group. Anything the word reader does not know is ignored, here and everywhere. */
export async function listenInGroup(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, ctx: OpContext, now = new Date()): Promise<string | null> {
  if (!isListening(chat) || !GROUP_TYPES.has(msg.chat.type) || repliedTo(msg)) return null;
  // A bare score belongs to the score reader, which takes it as a reply to the card or the nudge; "me"
  // and "+" take a seat only as a reply to a card; a forward is somebody else's words.
  const said = heardInGroup(msg);
  if (!said) return null;
  // "times?": the free courts, asked for, so answered once (DECIDING rule 34).
  if (said.kind === "times") return timesInChat(db, msg, chat, from, "word", now);
  const open = await openCards(db, chat.chatId, now);
  if (said.kind === "ask") return askForMatch(db, msg, chat, from, said.text, open, ctx, now);
  let targets = open;
  // "Out" can only mean a match the person is in: with several open, the ones they hold a place in.
  if (said.kind === "leave" && open.length > 1) {
    const me = await findTelegramPlayer(db, from.id);
    const held = me
      ? await db
          .select({ eventId: slots.eventId })
          .from(slots)
          .where(and(eq(slots.playerId, me.id), inArray(slots.eventId, open.map((o) => o.id)), inArray(slots.status, ["joined", "confirmed"])))
          .limit(MAX_CHOICES + 1)
      : [];
    const ids = new Set(held.map((h) => h.eventId));
    targets = open.filter((o) => ids.has(o.id));
  }
  if (targets.length === 0) {
    await metric(db, "tg_word_unsure");
    return `word_${said.kind}:no_match`;
  }
  if (targets.length === 1) {
    const detail = await getEventByCode(db, targets[0].code);
    return detail ? seatByWord(db, msg, chat, from, detail, said.kind, ctx) : null;
  }
  // Two or more: one question to that person alone, a button per match (the card's own j:/l: taps).
  // Telegram does not promise an ephemeral message arrives; when it does not, the group hears nothing.
  await metric(db, "tg_word_unsure");
  const locale = chatLocale(chat);
  const s = strings(locale);
  const label = (o: OpenCard) => `${said.kind === "join" ? "✅" : "❌"} ${formatEventDay(o.startsAt, o.tz, locale)} ${formatEventTime(o.startsAt, o.tz, locale)} · ${o.venueName ?? s.courtTbd}`.slice(0, 60);
  const keyboard: InlineKeyboard = { inline_keyboard: targets.slice(0, MAX_CHOICES).map((o) => [{ text: label(o), callback_data: `${said.kind === "join" ? "j" : "l"}:${o.code}` }]) };
  const asked = await sendMessage(chat.chatId, esc(s.whichMatch), { keyboard, onlyFor: from.id, threadId: msg.message_thread_id ?? null, silent: true });
  return asked.ok ? `word_${said.kind}:asked` : `word_${said.kind}:unasked`;
}

/** Words that move the day where the parser cannot follow ("next week", "в выходные"), and a month: the question is not one we can read. */
const UNCLEAR =
  /\d|(?<!\p{L})(?:next|weeks?|weekends?|tonite|january|february|march|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|semanas?|finde|pr[óo]xim\p{L}*|следующ\p{L}*|недел\p{L}*|выходн\p{L}*|январ\p{L}*|феврал\p{L}*|март\p{L}*|апрел\p{L}*|ма[йя]|июн\p{L}*|июл\p{L}*|август\p{L}*|сентябр\p{L}*|октябр\p{L}*|ноябр\p{L}*|декабр\p{L}*)(?!\p{L})/iu;

/**
 * "who's in Thursday 7pm Rawai?": the match through the /new path, its card as the reply. Ordinary chat
 * must never become a match, so a question makes one only when everything in it is read: an hour named
 * outright ("7pm", "19:00", "at 19", never a stray number), and a place that is a court the chat knows
 * (its usual court, the sender's, a listed club named in full), or no place at all and a usual court.
 * The match takes the day, the hour and the court, nothing else: no listing, price, level or size from
 * a chat line. A new court goes through /new. Anything short of a match is silence.
 */
async function askForMatch(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, text: string, open: OpenCard[], ctx: OpContext, now: Date): Promise<string> {
  const unsure = async (why: string) => {
    await metric(db, "tg_word_unsure");
    return `word_ask:${why}`;
  };
  const tz = await chatZone(db, chat, tzHintFor(text));
  if (!tz) return unsure("no_zone");
  const parsed = parseNewCommand(text, { tz, now, ...(await knownVenues(db, chat, from, tz)) });
  // A question asks about a match still to come, at an hour it names.
  if (!parsed.startsAt || parsed.timeFrom !== "clock" || parsed.startsAt.getTime() <= now.getTime()) return unsure("no_time");
  const startsAt = parsed.startsAt;
  // A tournament, a court that is not a number, a date or a word the parser cannot place: not ours to guess.
  if (parsed.type !== "match" || (parsed.court && !/^\d{1,2}$/.test(parsed.court)) || (parsed.place && UNCLEAR.test(parsed.place))) return unsure("unclear");
  // The place is a court the chat knows, or the crew's usual court when none was named; never the words as typed.
  const venue = parsed.venueKnown ? parsed.venue : namesAPlace(parsed.place) ? null : chat.venueName;
  if (!venue) return unsure("no_place");
  // The card already there answers the question: same hour, or twelve hours on when no am/pm was typed
  // ("who's in Thursday at 7?" is the 19:00 card), on the same day, or any day when none was typed.
  const asked = utcToZonedParts(startsAt, tz);
  const [hour, minute] = asked.time.split(":").map(Number);
  const hours = parsed.meridiem || hour >= 12 ? [hour] : [hour, hour + 12];
  const answered = open.some((o) => {
    const at = utcToZonedParts(o.startsAt, o.tz);
    const [h, m] = at.time.split(":").map(Number);
    return m === minute && hours.includes(h) && (!parsed.dayTyped || at.date === asked.date);
  });
  if (answered) return unsure("exists");
  // Two people asking for the same hour at once: the match the first one is still carding answers the second.
  if (chat.groupId) {
    const [made] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.groupId, chat.groupId), eq(events.startsAt, startsAt), inArray(events.status, ["open", "full"])))
      .limit(1);
    if (made) return unsure("exists");
  }
  const input = { startsAt, venue, court: parsed.court, type: "match" as const, format: null, capacity: null, levelMin: null, levelMax: null, cost: null, publicListing: false };
  const created = await createMatchInChat(db, chat, from, input, tz, ctx, { replyTo: msg.message_id, threadId: msg.message_thread_id ?? null });
  if (!created.ok) return unsure(created.reason);
  await metric(db, "tg_match_by_word");
  return `word_ask:created:${created.ev.code}`;
}
