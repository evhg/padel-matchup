import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { events, type Player, type TelegramChat } from "@/db/schema";
import type { OpContext } from "@/lib/api/operations";
import { pasteBooking, pickClubOf, type PasteResult } from "@/lib/booking/paste";
import { detectPlatform } from "@/lib/booking/platforms";
import { chatLocale } from "@/lib/channels/telegram";
import { baseUrl } from "@/lib/config";
import { formatEventDay, zonedTimeToUtc } from "@/lib/dates";
import { linksIn, readBooking, type BookingRead, type PickClub } from "@/lib/domain/bookingPaste";
import { listClubsForPicking } from "@/lib/domain/clubs";
import { isClaimable } from "@/lib/domain/events";
import { parseMatchLength } from "@/lib/domain/matchLength";
import { bumpMetric } from "@/lib/domain/metrics";
import { takeRate } from "@/lib/domain/ratelimit";
import { eventUrl } from "@/lib/share";
import { answerCallbackQuery, editMessageText, esc, sendMessage, type InlineKeyboard, type TgMessage, type TgUpdate, type TgUser } from "../api";
import { strings, type BotLocale } from "../card";
import { chatZone, getChat } from "../chats";
import { chatTicket, findOrCreateTelegramPlayer, findTelegramPlayer } from "../identity";
import { codesInText } from "../text";
import { createMatchInChat } from "./new";

/**
 * "Paste your booking" in the private chat (the owner, 11 October 2026: "how do I turn this into a
 * match and match card/link by just copy and pasting the link?"). A person who booked a court in a
 * platform's app pastes the link or the text the app gave them; the bot answers once with what it
 * read ("WAREHAUS.club, Mon, Oct 12, 18:00–19:30, court 3, with Danny and Alberto") and two buttons:
 * "Create match", which makes it, and "Edit first", the web form filled the same way.
 *
 * Only in a private chat, and only for a message that is a booking: a link of a platform in
 * `PLATFORMS` (in the words, or behind them as a `text_link`), or words that name a club, a day and a
 * time. Anything else goes on to what the chat did before, and a group never reaches this file.
 *
 * "Create match" carries nothing but its prefix (`pb:c`): the booking is read again from the
 * person's own message, which the bot's answer replies to, and only that person may tap it. The
 * second read is the same as the first (`pasteBooking`), so it opens the platform's link only when the
 * words leave something out, as the first did: one read of the link for each tap at most. A tap that
 * finds the organiser's match at that start already made answers with that match's link.
 *
 * What it costs (AGENTS.md rule 12): a private message that is no booking costs no read, because the
 * shape is checked first with no database (`readBooking` over no clubs); one with a day and a time
 * and no platform's link costs one read of the listed clubs. A booking costs what `pasteBooking`
 * costs (one counter, the clubs, at most one read of the link, at most one read of the last venue),
 * one look-up of the sender, and the chat's zone when the chat has none (one read of its last card).
 * The tap costs the same read again, the duplicate check (one read down `events_starts_at_idx`, an
 * exact start; `events_creator_idx` serves it too), one counter to claim the start, and the create.
 */
export const PASTE_CALLBACK = /^pb:/;

/** The links a message keeps behind its words: a `text_link` entity carries its own url. */
export const linkEntitiesOf = (msg: Pick<TgMessage, "entities">): string[] =>
  (msg.entities ?? [])
    .filter((e) => e.type === "text_link" && typeof e.url === "string")
    .map((e) => e.url as string)
    .slice(0, 20);

/**
 * The booking in one message, or null when the message is not one. Without a platform's link, the
 * words must give a day and a time (checked with no read) and then a club (one read of the clubs, handed
 * on, so `pasteBooking` does not read them again).
 */
async function readPaste(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, known: Player | undefined, now: Date): Promise<PasteResult | null> {
  const text = msg.text ?? "";
  const extra = linkEntitiesOf(msg);
  const links = linksIn(text, extra);
  let clubs: PickClub[] | undefined;
  if (!links.some((l) => detectPlatform(l))) {
    const guess = chat.tz ?? "UTC";
    const shape = readBooking({ text, links, clubs: [], now, tz: guess });
    if (!shape.date || !shape.time) return null;
    clubs = (await listClubsForPicking(db)).map(pickClubOf);
    const named = readBooking({ text, links, clubs, now, tz: guess });
    if (!named.club || !named.date || !named.time) return null;
  }
  // The day and the time are the club's; the chat's zone counts only when no club is found.
  const tz = (await chatZone(db, chat, null)) ?? "UTC";
  // Looked up, never created: a paste nobody taps leaves no player row behind.
  const me = known ?? (await findTelegramPlayer(db, from.id));
  const got = await pasteBooking(db, { text, links: extra, tz, rateKey: `tg:${from.id}`, playerId: me?.id ?? null, selfName: me?.displayName ?? from.first_name, now, clubs });
  return got.ok || got.reason === "limit" ? got : null;
}

const listOf = (items: readonly string[], last: string): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")}${last}${items[items.length - 1]}`);

const plusMinutes = (time: string, minutes: number): string => {
  const [h, m] = time.split(":").map(Number);
  const t = (h * 60 + m + minutes) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * What the bot read, in one short message: "📋 WAREHAUS.club, Mon, Oct 12, 18:00–19:30, court 3, with
 * Danny and Alberto", then what is missing or what to tap. The time range is the length the match will
 * take (60, 90 or 120); any other length shows the start alone. HTML-escaped. Pure.
 */
export function pasteSummary(read: BookingRead, locale: BotLocale): string {
  const s = strings(locale);
  const parts: string[] = [];
  if (read.club) parts.push(read.club.name);
  // The day as a calendar day, with no zone to move it: the date was read in the club's zone already.
  if (read.date) parts.push(formatEventDay(new Date(`${read.date}T12:00:00Z`), "UTC", locale));
  const len = parseMatchLength(read.minutes);
  if (read.time) parts.push(len ? `${read.time}–${plusMinutes(read.time, len)}` : read.time);
  if (read.court) parts.push(/^\d/.test(read.court) ? s.pasteCourt(read.court) : read.court);
  if (read.cost) parts.push(read.cost);
  if (read.names.length) parts.push(s.pasteWith(listOf(read.names, s.pasteAnd)));
  const what = parts.length ? parts.join(", ") : s.pasteLinkOf(read.platform?.name ?? "");
  const next = read.missing.length ? s.pasteMissing(listOf(read.missing.map((f) => s.pasteFields[f]), s.pasteOr)) : s.pasteReady;
  return `📋 ${esc(what)}\n${esc(next)}`;
}

/** "Edit first": the web form filled from the same read, and the chat's ticket, so the card made there comes back here. */
const editUrl = (href: string, chat: TelegramChat): string => `${baseUrl()}${href}&tg=${encodeURIComponent(chatTicket(chat.chatId))}`;

/**
 * A booking pasted in the private chat: one answer with what was read, as a reply to it (the tap reads
 * the booking back through that reply), with no link preview. Null when the message is not a booking.
 */
export async function pasteInChat(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, now = new Date()): Promise<string | null> {
  if (msg.chat.type !== "private" || !msg.text) return null;
  // A kicksma.sh match link is the card, as before.
  if (codesInText(msg.text, baseUrl()).length) return null;
  const got = await readPaste(db, msg, chat, from, undefined, now);
  if (!got) return null;
  const s = strings(chatLocale(chat));
  if (!got.ok) {
    await sendMessage(chat.chatId, esc(s.pasteLimit), { replyTo: msg.message_id, silent: true });
    return "paste_limit";
  }
  const complete = got.read.missing.length === 0;
  const keyboard: InlineKeyboard = { inline_keyboard: [[...(complete ? [{ text: s.pasteCreate, callback_data: `pb:c` }] : []), { text: s.pasteEdit, url: editUrl(got.href, chat) }]] };
  await sendMessage(chat.chatId, pasteSummary(got.read, chatLocale(chat)), { keyboard, replyTo: msg.message_id, silent: true });
  return complete ? "paste_read" : `paste_missing:${got.read.missing.join(",")}`;
}

/**
 * "Create match": the booking read again from the person's own message, the match made with the
 * club, the start in the club's zone, the length, the court, the price, the names held and the court
 * marked booked by them, and the answer turned into the match's link, with that one link's preview on
 * (our own page), ready to paste into the group where the fourth player is wanted.
 */
export async function handlePasteCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, ctx: OpContext, now = new Date()): Promise<string> {
  const chat = cb.message ? await getChat(db, cb.message.chat.id) : null;
  const s = strings(chatLocale(chat, cb.from.language_code));
  const answer = cb.message;
  const mine = answer?.reply_to_message;
  if (!chat || !answer || answer.chat.type !== "private" || !mine?.text) {
    await answerCallbackQuery(cb.id, s.pasteLost);
    return "paste_lost";
  }
  // Only the person who pasted it: anybody else's tap does nothing.
  if (mine.from?.id !== cb.from.id) {
    await answerCallbackQuery(cb.id, s.pasteNotYours, { alert: true });
    return "paste_not_yours";
  }
  const organiser = await findOrCreateTelegramPlayer(db, cb.from);
  const got = await readPaste(db, mine, chat, cb.from, organiser, now);
  if (!got || !got.ok) {
    await answerCallbackQuery(cb.id, got ? s.pasteLimit : s.pasteLost, { alert: true });
    return got ? "paste_limit" : "paste_lost";
  }
  const { read } = got;
  if (!read.club || !read.date || !read.time) {
    await answerCallbackQuery(cb.id, s.pasteIncomplete, { alert: true });
    return "paste_incomplete";
  }
  const startsAt = zonedTimeToUtc(read.date, read.time, read.tz);
  const say = async (text: string, code: string) => {
    const link = eventUrl(baseUrl(), code);
    await editMessageText(chat.chatId, answer.message_id, `${esc(text)}\n${link}`, null, { preview: link });
  };
  // A second tap, or the same booking pasted again: the organiser's match at that start is the answer.
  // One read: the planner takes events_starts_at_idx, an exact start, and checks the organiser on the few rows
  // it finds (EXPLAIN on 400 matches of 20 organisers, 11 October 2026); events_creator_idx would serve too.
  const [made] = await db
    .select({ code: events.code })
    .from(events)
    .where(and(eq(events.creatorPlayerId, organiser.id), eq(events.startsAt, startsAt), inArray(events.status, ["open", "full"])))
    .limit(1);
  if (made) {
    await say(s.pasteExists, made.code);
    await answerCallbackQuery(cb.id, s.timesExists);
    return `paste_exists:${made.code}`;
  }
  // Two taps at once both find nothing: the first to claim this start makes the match.
  if (!(await takeRate(db, "pb", `${organiser.id}:${Math.round(startsAt.getTime() / 60_000).toString(36)}`, 1, "hour", now))) {
    await answerCallbackQuery(cb.id, s.timesExists);
    return "paste_exists";
  }
  const created = await createMatchInChat(
    db,
    chat,
    cb.from,
    {
      startsAt,
      venue: read.club.name,
      court: read.court,
      type: "match",
      format: null,
      capacity: null,
      levelMin: null,
      levelMax: null,
      cost: read.cost,
      publicListing: false,
      durationMinutes: parseMatchLength(read.minutes),
      names: read.names,
      booked: true,
    },
    read.tz,
    ctx,
    { replyTo: mine.message_id },
  );
  if (!created.ok) {
    await answerCallbackQuery(cb.id, created.reason === "past" ? s.newPast : created.reason === "too_many" ? s.tooMany : s.toastError, { alert: true });
    return `paste_${created.reason}`;
  }
  await say(s.pasteMade(created.detail.roster.filter(isClaimable).length), created.ev.code);
  await answerCallbackQuery(cb.id);
  await bumpMetric(db, "tg_match_by_paste").catch(() => undefined);
  return `paste_created:${created.ev.code}`;
}
