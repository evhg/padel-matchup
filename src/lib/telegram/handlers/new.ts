import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { telegramChats, type Event, type TelegramChat } from "@/db/schema";
import type { OpContext } from "@/lib/api/operations";
import { chatLocale } from "@/lib/channels/telegram";
import { baseUrl } from "@/lib/config";
import { utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import { createEvent } from "@/lib/domain/events";
import { DEFAULT_POINTS, formatOf } from "@/lib/domain/formats";
import { getEventByCode, getVenues } from "@/lib/domain/queries";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { joinEvent } from "@/lib/domain/slots";
import { sendCalendarInvite } from "@/lib/notify";
import { answerCallbackQuery, deleteMessage, editMessageText, esc, sendMessage, telegramBotId, type InlineKeyboard, type TgMessage, type TgUpdate, type TgUser } from "../api";
import { strings, type BotLocale, type BotStrings } from "../card";
import { chatZone, getChat, rememberChatDefaults } from "../chats";
import { chatTicket, findOrCreateTelegramPlayer } from "../identity";
import { parseNewCommand, resolveZone, tzHintFor, type ParsedNew } from "../parse";
import { postCard } from "../post";

/** Creating from the chat: "/new tomorrow 19:00 Rawai" in one line, the three taps of a bare /new, and a reply to one of its prompts. */
const DAY_MS = 24 * 60 * 60 * 1000;

type ChatMatchInput = Pick<ParsedNew, "startsAt" | "venue" | "court" | "type" | "format" | "capacity" | "levelMin" | "levelMax" | "cost" | "publicListing">;

/** The creation itself, shared by the one-line command, the tap-through and the reply steps: rate limit, event, organizer in, chat defaults, card, webhook. */
async function createMatchInChat(db: Db, chat: TelegramChat, from: TgUser, input: ChatMatchInput & { startsAt: Date }, tz: string, ctx: OpContext, o: { replyTo?: number | null; threadId?: number | null } = {}): Promise<{ ok: true; ev: Event } | { ok: false; reason: "past" | "too_many" | "invalid" }> {
  const now = new Date();
  if (input.startsAt.getTime() < now.getTime() - DAY_MS) return { ok: false, reason: "past" };
  const player = await findOrCreateTelegramPlayer(db, from);
  if (!(await takeRate(db, "create", player.id, LIMITS.eventsPerPlayerPerDay))) return { ok: false, reason: "too_many" };
  let ev: Event;
  try {
    ev = await createEvent(db, {
      creatorPlayerId: player.id,
      type: input.type,
      startsAt: input.startsAt,
      tz,
      venueName: input.venue ?? chat.venueName,
      court: input.court,
      capacity: input.capacity ?? undefined,
      whenFull: "waitlist",
      format: input.format,
      pointsPerMatch: input.type === "tournament" ? DEFAULT_POINTS[formatOf(input.format)] : null,
      levelMin: input.levelMin,
      levelMax: input.levelMax,
      cost: input.cost,
      publicListing: input.publicListing,
      groupId: chat.groupId,
    });
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const seated = await joinEvent(db, { eventId: ev.id, playerId: player.id }).catch(() => null);
  await rememberChatDefaults(db, chat, ev);
  const detail = (await getEventByCode(db, ev.code))!;
  // The organizer's own calendar invitation, as from the web form (the match page says it was sent, so it is): after the reply, only when they hold a seat.
  if (seated?.outcome === "joined") {
    ctx.afterwards(async () => {
      await sendCalendarInvite(db, ev, player, "joined", detail).catch(() => undefined);
    });
  }
  await postCard(db, detail, chat, o);
  ctx.emit("match.created", ev.code);
  return { ok: true, ev };
}

const formKeyboard = (chat: TelegramChat, s: BotStrings): InlineKeyboard => {
  const params = new URLSearchParams({ tg: chatTicket(chat.chatId) });
  if (chat.venueName) params.set("venue", chat.venueName);
  return { inline_keyboard: [[{ text: s.formBtn, url: `${baseUrl()}/?${params.toString()}` }]] };
};

/** "/new tomorrow 19:00 Rawai 400฿": the match is created and its card posted, no site visit. */
export
async function createFromChat(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, args: string, ctx: OpContext): Promise<string> {
  const s = strings(chatLocale(chat));
  const threadId = msg.message_thread_id ?? null;
  const say = (text: string, keyboard?: InlineKeyboard) => sendMessage(chat.chatId, esc(text), { keyboard: keyboard ?? null, replyTo: msg.message_id, threadId, silent: true });
  const tz = await chatZone(db, chat, tzHintFor(args));
  if (!tz) {
    await sendMessage(chat.chatId, esc(s.newZone), { keyboard: zoneKeyboard(), replyTo: msg.message_id, threadId, silent: true });
    return "new_zone";
  }
  const parsed = parseNewCommand(args, { tz, now: new Date() });
  if (!parsed.startsAt) {
    await say(s.newHowTo, formKeyboard(chat, s));
    return "new_how";
  }
  const r = await createMatchInChat(db, chat, from, { ...parsed, startsAt: parsed.startsAt }, tz, ctx, { replyTo: msg.message_id, threadId });
  if (!r.ok) {
    await say(r.reason === "past" ? s.newPast : r.reason === "too_many" ? s.tooMany : s.newHowTo, r.reason === "invalid" ? formKeyboard(chat, s) : undefined);
    return `new_${r.reason}`;
  }
  return `new_created:${r.ev.code}`;
}

// ---------------------------------------------------------------------------
// /new without words: three taps (day, time, place). Stateless: every button carries what was chosen so far,
// and a prompt ends with the one-line command it stands for, so a reply to it (another time, another place)
// can be read back with the same parser. That trailer also teaches the one-line form.
// ---------------------------------------------------------------------------
const GUIDED_ZONES: [string, string][] = [
  ["phuket", "Phuket"],
  ["singapore", "Singapore"],
  ["bali", "Bali"],
  ["dubai", "Dubai"],
  ["moscow", "Moscow"],
  ["madrid", "Madrid"],
  ["cyprus", "Cyprus"],
  ["tbilisi", "Tbilisi"],
];
const GUIDED_TIMES = ["07:00", "08:00", "09:00", "10:00", "17:00", "18:00", "19:00", "20:00", "21:00"];
const zoneKeyboard = (): InlineKeyboard => ({ inline_keyboard: chunk(GUIDED_ZONES.map(([key, label]) => ({ text: label, callback_data: `n:z:${key}` })), 4) });
const chunk = <T,>(xs: T[], n: number): T[][] => xs.reduce<T[][]>((rows, x, i) => ((i % n ? rows[rows.length - 1].push(x) : rows.push([x])), rows), []);
const compactDate = (iso: string) => iso.replace(/-/g, "");
const isoDate = (compact: string) => `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
const compactTime = (t: string) => t.replace(":", "");
const clockTime = (compact: string) => `${compact.slice(0, 2)}:${compact.slice(2, 4)}`;
/** The one-line command a prompt stands for: "/new 12.09" or "/new 12.09 19:00". Read back when someone replies to the prompt. */
const trailerFor = (date: string, time?: string | null) => `/new ${date.slice(8, 10)}.${date.slice(5, 7)}${time ? ` ${time}` : ""}`;

function dayLabel(date: string, today: string, tz: string, locale: BotLocale, s: BotStrings): string {
  if (date === today) return s.today;
  if (date === dateStr(shiftDate(today, 1))) return s.tomorrow;
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}
const shiftDate = (date: string, days: number) => new Date(`${date}T12:00:00Z`).getTime() + days * 86_400_000;
const dateStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function whenPrompt(chat: TelegramChat, tz: string, s: BotStrings, locale: BotLocale): { text: string; keyboard: InlineKeyboard } {
  const today = utcToZonedParts(new Date(), tz).date;
  const days = Array.from({ length: 7 }, (_, i) => dateStr(shiftDate(today, i)));
  const rows: InlineKeyboard["inline_keyboard"] = chunk(days.map((d) => ({ text: dayLabel(d, today, tz, locale, s), callback_data: `n:d:${compactDate(d)}` })), 3);
  rows.push(formKeyboard(chat, s).inline_keyboard[0]);
  return { text: `${esc(s.newWhen)}\n<i>${esc(s.newTip)}</i>`, keyboard: { inline_keyboard: rows } };
}

function timePrompt(date: string, tz: string, s: BotStrings, locale: BotLocale): { text: string; keyboard: InlineKeyboard } {
  const today = utcToZonedParts(new Date(), tz).date;
  const rows = chunk(GUIDED_TIMES.map((t) => ({ text: t, callback_data: `n:t:${compactDate(date)}:${compactTime(t)}` })), 3);
  return { text: `📅 ${esc(dayLabel(date, today, tz, locale, s))}\n${esc(s.newTime)}\n<i>${esc(s.newReplyTime)}</i>\n<code>${trailerFor(date)}</code>`, keyboard: { inline_keyboard: rows } };
}

/** Places to offer: the chat's usual court, then the organizer's recent ones. Recomputed on the tap; the button carries only an index. */
async function placeOptions(db: Db, chat: TelegramChat, playerId: string): Promise<string[]> {
  const out: string[] = [];
  if (chat.venueName) out.push(chat.venueName);
  for (const v of await getVenues(db, playerId)) if (!out.includes(v.name) && out.length < 4) out.push(v.name);
  return out;
}

async function wherePrompt(db: Db, chat: TelegramChat, playerId: string, date: string, time: string, tz: string, s: BotStrings, locale: BotLocale): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const today = utcToZonedParts(new Date(), tz).date;
  const places = await placeOptions(db, chat, playerId);
  const key = `${compactDate(date)}:${compactTime(time)}`;
  const rows = places.map((name, i) => [{ text: name.slice(0, 40), callback_data: `n:v:${key}:${i}` }]);
  rows.push([{ text: s.courtTbd, callback_data: `n:v:${key}:x` }]);
  return { text: `📅 ${esc(dayLabel(date, today, tz, locale, s))} · ${time}\n${esc(s.newWhere)}\n<i>${esc(s.newReplyPlace)}</i>\n<code>${trailerFor(date, time)}</code>`, keyboard: { inline_keyboard: rows } };
}

/** Bare /new: the zone once, then the day. */
export
async function startGuidedNew(db: Db, msg: TgMessage, chat: TelegramChat): Promise<string> {
  const locale = chatLocale(chat);
  const s = strings(locale);
  const threadId = msg.message_thread_id ?? null;
  const tz = await chatZone(db, chat, null);
  if (!tz) {
    await sendMessage(chat.chatId, esc(s.newZone), { keyboard: zoneKeyboard(), replyTo: msg.message_id, threadId, silent: true });
    return "new_zone";
  }
  const p = whenPrompt(chat, tz, s, locale);
  await sendMessage(chat.chatId, p.text, { keyboard: p.keyboard, replyTo: msg.message_id, threadId, silent: true });
  return "new_when";
}

/** The taps: n:z:<city>, n:d:<date>, n:t:<date>:<time>, n:v:<date>:<time>:<place index or x>. The prompt edits itself forward and disappears at the end. */
export
async function handleGuidedNew(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, step: string, rest: string, ctx: OpContext): Promise<string> {
  const chat = cb.message ? await getChat(db, cb.message.chat.id) : null;
  if (!chat || !cb.message) {
    await answerCallbackQuery(cb.id);
    return "new_lost";
  }
  const locale = chatLocale(chat);
  const s = strings(locale);
  const edit = (p: { text: string; keyboard: InlineKeyboard }) => editMessageText(chat.chatId, cb.message!.message_id, p.text, p.keyboard);
  if (step === "z") {
    const zone = resolveZone(rest);
    if (!zone) {
      await answerCallbackQuery(cb.id, s.tzUnknown);
      return "new_zone_unknown";
    }
    await db.update(telegramChats).set({ tz: zone }).where(eq(telegramChats.chatId, chat.chatId));
    await edit(whenPrompt({ ...chat, tz: zone }, zone, s, locale));
    await answerCallbackQuery(cb.id, s.tzSet(zone));
    return "new_when";
  }
  const tz = await chatZone(db, chat, null);
  if (!tz) {
    await edit({ text: esc(s.newZone), keyboard: zoneKeyboard() });
    await answerCallbackQuery(cb.id);
    return "new_zone";
  }
  const [d, t, v] = rest.split(":");
  if (!/^\d{8}$/.test(d ?? "")) {
    await answerCallbackQuery(cb.id, s.toastError);
    return "new_bad";
  }
  const date = isoDate(d);
  if (step === "d") {
    await edit(timePrompt(date, tz, s, locale));
    await answerCallbackQuery(cb.id);
    return "new_time";
  }
  if (!/^\d{4}$/.test(t ?? "")) {
    await answerCallbackQuery(cb.id, s.toastError);
    return "new_bad";
  }
  const time = clockTime(t);
  const player = await findOrCreateTelegramPlayer(db, cb.from);
  if (step === "t") {
    await edit(await wherePrompt(db, chat, player.id, date, time, tz, s, locale));
    await answerCallbackQuery(cb.id);
    return "new_where";
  }
  // step v: the match.
  const places = await placeOptions(db, chat, player.id);
  const venue = v === "x" ? null : (places[Number(v)] ?? null);
  const r = await createMatchInChat(db, chat, cb.from, { startsAt: zonedTimeToUtc(date, time, tz), venue, court: null, type: "match", format: null, capacity: null, levelMin: null, levelMax: null, cost: null, publicListing: false }, tz, ctx, { threadId: cb.message.message_thread_id ?? null });
  if (!r.ok) {
    await answerCallbackQuery(cb.id, r.reason === "past" ? s.newPast : r.reason === "too_many" ? s.tooMany : s.toastError, { alert: true });
    return `new_${r.reason}`;
  }
  await deleteMessage(chat.chatId, cb.message.message_id);
  await answerCallbackQuery(cb.id);
  return `new_created:${r.ev.code}`;
}

/** A reply to one of our prompts: its trailer ("/new 12.09" or "/new 12.09 19:00") plus the reply is the one-line command. */
export
async function continueGuidedNew(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, ctx: OpContext): Promise<string | null> {
  const parent = msg.reply_to_message;
  const botId = telegramBotId();
  if (!parent?.text || !msg.text || !botId || String(parent.from?.id) !== botId) return null;
  const trailer = parent.text.match(/\/new (\d{2}\.\d{2})(?: (\d{2}:\d{2}))?\s*$/);
  if (!trailer) return null;
  const locale = chatLocale(chat);
  const s = strings(locale);
  const tz = await chatZone(db, chat, null);
  if (!tz) return null;
  const parsed = parseNewCommand(`${trailer[1]} ${trailer[2] ?? ""} ${msg.text}`, { tz, now: new Date() });
  if (!parsed.startsAt || !parsed.date || !parsed.time) {
    await sendMessage(chat.chatId, esc(s.newHowTo), { replyTo: msg.message_id, threadId: msg.message_thread_id ?? null, silent: true });
    return "new_how";
  }
  // Only a time so far: move the prompt to the place step. (A place cannot be told from a stray word here, so the trailer decides.)
  if (!trailer[2] && !parsed.venue) {
    const player = await findOrCreateTelegramPlayer(db, from);
    const p = await wherePrompt(db, chat, player.id, parsed.date, parsed.time, tz, s, locale);
    await editMessageText(chat.chatId, parent.message_id, p.text, p.keyboard);
    return "new_where";
  }
  const r = await createMatchInChat(db, chat, from, { ...parsed, startsAt: parsed.startsAt }, tz, ctx, { replyTo: msg.message_id, threadId: msg.message_thread_id ?? null });
  if (!r.ok) {
    await sendMessage(chat.chatId, esc(r.reason === "past" ? s.newPast : r.reason === "too_many" ? s.tooMany : s.newHowTo), { replyTo: msg.message_id, silent: true });
    return `new_${r.reason}`;
  }
  await deleteMessage(chat.chatId, parent.message_id);
  return `new_created:${r.ev.code}`;
}
