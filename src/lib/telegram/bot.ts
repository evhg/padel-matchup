import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import type { CreatorKind } from "@/lib/notify";
import { events, players, telegramCards, telegramChats, telegramInlineCards, type Event, type Player, type TelegramChat } from "@/db/schema";
import { ApiError } from "@/lib/api/http";
import { joinAsPlayer, leaveAsPlayer, type OpContext } from "@/lib/api/operations";
import { baseUrl } from "@/lib/config";
import { formatEventDay, formatEventTime, utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import { isDomainError } from "@/lib/domain/errors";
import { createEvent, isOccupied } from "@/lib/domain/events";
import { DEFAULT_POINTS, formatOf } from "@/lib/domain/formats";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { applyEventLevels } from "@/lib/domain/rating";
import { saveMatchScore, type SetScore } from "@/lib/domain/scores";
import { joinEvent } from "@/lib/domain/slots";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { mergePlayers } from "@/lib/domain/merge";
import { createPlayer, getPlayer } from "@/lib/domain/players";
import { getEventByCode, getPlayerEvents, getVenues, type EventDetail } from "@/lib/domain/queries";
import { CITIES, cityInText, cityOf, type City } from "@/lib/domain/cities";
import { getCityBoard, withCounts } from "@/lib/domain/venueBoard";
import { matchResult, WINNER_ONLY_SETS } from "@/lib/domain/result";
import { praiseLine } from "@/lib/domain/praise";
import { weeklyGroupFromEvent } from "@/lib/domain/groups";
import { suggestGroupName } from "@/lib/domain/groupNames";
import { personalEventUrl, personalUrl } from "@/lib/personal";
import { coachAssistantMessage, handleCoachCallback, lessonsFor, sendRoleMenu } from "./coach";
import { ticketPlayerId, verifyPlayerTicket } from "@/lib/coach/link";
import { isValidShareCode } from "@/lib/codes";
import { answerCallbackQuery, answerInlineQuery, deleteMessage, editInlineMessageText, editMessageText, editOk, esc, messageGone, sendMessage, sendPhoto, telegramBotId, telegramBotUsername, telegramEnabled, telegramWebhookSecret, type InlineArticle, type InlineKeyboard, type TgChat, type TgMessage, type TgUpdate, type TgUser } from "./api";
import { botLocale, cardTitle, renderCard, strings, whenLine, whereLine, type BotLocale, type BotStrings } from "./card";
import { parseNewCommand, resolveZone, tzHintFor, type ParsedNew } from "./parse";
import { setAnswerPublished } from "@/lib/listen/answers";
import { approveItem, ownerTelegramId, skipItem } from "@/lib/listen/tick";
import { approveOutreach, skipOutreach } from "@/lib/outreach/desk";
import { composeAck } from "@/lib/feedback/ack";
import { appendFeedbackReply, createFeedback, FEEDBACK_LIMITS, feedbackCountToday, findNoteForReply, markAcknowledged, markNotFeedback } from "@/lib/feedback/store";
import { feedbackStrings } from "@/lib/feedback/strings";
import { decideClub, getClubByToken } from "@/lib/domain/clubs";

/**
 * The bot, quiet by design. It posts a new message only for: the match card,
 * "line-up complete", the reminder about an hour before, and the result. Joins
 * and leaves edit the card. Anything else it answers with a toast or not at all.
 */

const GROUP_TYPES = new Set(["group", "supergroup"]);
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Chat tickets: /new hands out a create link that proves it came from a chat
// the bot is in, so a stranger cannot make the bot post into someone's group.
// ---------------------------------------------------------------------------
const ticketSecret = () => telegramWebhookSecret() ?? createHash("sha256").update(process.env.TELEGRAM_BOT_TOKEN ?? "").digest("hex");
const ticketSig = (chatId: number, bucket: number) => createHmac("sha256", ticketSecret()).update(`${chatId}.${bucket}`).digest("hex").slice(0, 20);

export function chatTicket(chatId: number, now = new Date()): string {
  const bucket = Math.floor(now.getTime() / DAY_MS);
  return `${chatId}.${bucket}.${ticketSig(chatId, bucket)}`;
}

/** The chat id behind a ticket issued in the last two days, or null. */
export function verifyChatTicket(ticket: string | null | undefined, now = new Date()): number | null {
  if (!ticket) return null;
  const [id, b, sig] = ticket.split(".");
  const chatId = Number(id);
  const bucket = Number(b);
  if (!Number.isInteger(chatId) || !Number.isInteger(bucket) || !sig) return null;
  const current = Math.floor(now.getTime() / DAY_MS);
  if (bucket !== current && bucket !== current - 1) return null;
  const want = ticketSig(chatId, bucket);
  if (want.length !== sig.length) return null;
  return timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? chatId : null;
}

// ---------------------------------------------------------------------------
// People and chats
// ---------------------------------------------------------------------------
export async function findTelegramPlayer(db: Db, telegramId: number): Promise<Player | null> {
  const [p] = await db.select().from(players).where(eq(players.telegramId, telegramId)).limit(1);
  return p ?? null;
}

/** The player behind a Telegram account, created on first contact with just the first name. */
export async function findOrCreateTelegramPlayer(db: Db, user: TgUser): Promise<Player> {
  const existing = await findTelegramPlayer(db, user.id);
  if (existing) {
    if ((user.username ?? null) !== existing.telegramUsername) {
      const [p] = await db.update(players).set({ telegramUsername: user.username ?? null }).where(eq(players.id, existing.id)).returning();
      return p;
    }
    return existing;
  }
  const created = await createPlayer(db, { displayName: user.first_name, locale: botLocale(user.language_code) });
  const [p] = await db.update(players).set({ telegramId: user.id, telegramUsername: user.username ?? null }).where(eq(players.id, created.id)).returning();
  return p;
}

/** Links a Telegram account to a signed-in player; a player the bot created earlier for that account merges in. */
export async function linkTelegram(db: Db, playerId: string, user: TgUser): Promise<Player> {
  const other = await findTelegramPlayer(db, user.id);
  if (other && other.id !== playerId) {
    await db.update(players).set({ telegramId: null, telegramUsername: null }).where(eq(players.id, other.id));
    await mergePlayers(db, playerId, [other.id]);
  }
  const [p] = await db.update(players).set({ telegramId: user.id, telegramUsername: user.username ?? null }).where(eq(players.id, playerId)).returning();
  return p;
}

export async function getChat(db: Db, chatId: number): Promise<TelegramChat | null> {
  const [c] = await db.select().from(telegramChats).where(eq(telegramChats.chatId, chatId)).limit(1);
  return c ?? null;
}

export async function upsertChat(db: Db, chat: TgChat, from?: TgUser | null): Promise<{ chat: TelegramChat; created: boolean }> {
  const existing = await getChat(db, chat.id);
  if (existing) {
    if (existing.title !== (chat.title ?? null) || existing.type !== chat.type || existing.leftAt) {
      const [c] = await db.update(telegramChats).set({ title: chat.title ?? null, type: chat.type, leftAt: null }).where(eq(telegramChats.chatId, chat.id)).returning();
      return { chat: c, created: false };
    }
    return { chat: existing, created: false };
  }
  const [c] = await db
    .insert(telegramChats)
    .values({ chatId: chat.id, type: chat.type, title: chat.title ?? null, locale: botLocale(from?.language_code) })
    .onConflictDoUpdate({ target: telegramChats.chatId, set: { title: chat.title ?? null, type: chat.type, leftAt: null } })
    .returning();
  return { chat: c, created: true };
}

const chatLocale = (chat: TelegramChat | null, fallback?: string | null): BotLocale => (chat ? (chat.locale === "ru" ? "ru" : "en") : botLocale(fallback));

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
const renderHash = (text: string, keyboard: unknown) => createHash("sha256").update(text).update(JSON.stringify(keyboard)).digest("hex");

/** Posts the card of a match into a chat, or refreshes the one already there. */
export async function postCard(db: Db, detail: EventDetail, chat: TelegramChat, o: { replyTo?: number | null; threadId?: number | null } = {}): Promise<"posted" | "refreshed" | "failed"> {
  const ev = detail.event;
  const [existing] = await db.select().from(telegramCards).where(and(eq(telegramCards.eventId, ev.id), eq(telegramCards.chatId, chat.chatId), eq(telegramCards.kind, "card"))).limit(1);
  const locale = chatLocale(chat);
  const { text, keyboard } = renderCard(detail, baseUrl(), locale);
  if (existing) {
    await syncTelegram(db, ev.code);
    return "refreshed";
  }
  const sent = await sendMessage(chat.chatId, text, { keyboard, replyTo: o.replyTo ?? null, threadId: o.threadId ?? null });
  if (!sent.ok) return "failed";
  await db
    .insert(telegramCards)
    .values({ eventId: ev.id, chatId: chat.chatId, messageId: sent.result.message_id, kind: "card", rendered: renderHash(text, keyboard) })
    .onConflictDoNothing();
  // The first group match carded here ties the chat to the group: from now on the group's matches arrive by themselves.
  if (ev.groupId && !chat.groupId && GROUP_TYPES.has(chat.type)) await db.update(telegramChats).set({ groupId: ev.groupId }).where(and(eq(telegramChats.chatId, chat.chatId), isNull(telegramChats.groupId)));
  return "posted";
}

/** A match of a group: its card goes into every chat tied to that group (the weekly slot, a match made on the site, one made from another chat). */
export async function postCardsForGroup(db: Db, code: string): Promise<number> {
  if (!telegramEnabled()) return 0;
  const detail = await getEventByCode(db, code);
  if (!detail?.event.groupId || detail.event.status === "cancelled") return 0;
  const chats = await db.select().from(telegramChats).where(and(eq(telegramChats.groupId, detail.event.groupId), isNull(telegramChats.leftAt))).limit(50);
  let posted = 0;
  for (const chat of chats) if ((await postCard(db, detail, chat)) === "posted") posted++;
  return posted;
}

/** Called after anything changed on a match: edits every card silently, notes a complete line-up once. Never throws. */
export async function syncTelegram(db: Db, code: string, now = new Date()): Promise<number> {
  if (!telegramEnabled()) return 0;
  try {
    const detail = await getEventByCode(db, code);
    if (!detail) return 0;
    const cards = await db
      .select({ card: telegramCards, chat: telegramChats })
      .from(telegramCards)
      .innerJoin(telegramChats, eq(telegramChats.chatId, telegramCards.chatId))
      .where(and(eq(telegramCards.eventId, detail.event.id), eq(telegramCards.kind, "card"), isNull(telegramChats.leftAt)));
    let edits = 0;
    for (const { card, chat } of cards) {
      const locale = chatLocale(chat);
      const { text, keyboard, complete } = renderCard(detail, baseUrl(), locale, now);
      const hash = renderHash(text, keyboard);
      if (hash !== card.rendered) {
        const res = await editMessageText(chat.chatId, card.messageId, text, keyboard);
        if (editOk(res)) {
          await db.update(telegramCards).set({ rendered: hash, updatedAt: new Date() }).where(eq(telegramCards.id, card.id));
          edits++;
        }
      }
      if (complete && !card.completeNotedAt && detail.event.status !== "cancelled") {
        const s = strings(locale);
        const occupied = detail.roster.filter((x) => x.position <= detail.event.capacity && isOccupied(x)).length;
        const note = await sendMessage(chat.chatId, s.completeNote(occupied, formatEventTime(detail.event.startsAt, detail.event.tz, locale)), { replyTo: card.messageId, silent: true });
        if (note.ok) await db.update(telegramCards).set({ completeNotedAt: new Date() }).where(eq(telegramCards.id, card.id));
      }
    }
    // Cards shared through inline mode: same render, edited by their inline message id.
    const inline = await db.select().from(telegramInlineCards).where(eq(telegramInlineCards.eventId, detail.event.id)).limit(200);
    for (const c of inline) {
      const { text, keyboard } = renderCard(detail, baseUrl(), c.locale === "ru" ? "ru" : "en", now);
      const hash = renderHash(text, keyboard);
      if (hash === c.rendered) continue;
      const res = await editInlineMessageText(c.inlineMessageId, text, keyboard);
      if (editOk(res)) {
        await db.update(telegramInlineCards).set({ rendered: hash, updatedAt: new Date() }).where(eq(telegramInlineCards.inlineMessageId, c.inlineMessageId));
        edits++;
      }
    }
    return edits;
  } catch {
    return 0;
  }
}

/** Posts the card into the chat behind a /new ticket, once the match exists. */
export async function postCardForTicket(db: Db, code: string, ticket: string | null | undefined): Promise<boolean> {
  const chatId = verifyChatTicket(ticket);
  if (!chatId || !telegramEnabled()) return false;
  const [chat, detail] = await Promise.all([getChat(db, chatId), getEventByCode(db, code)]);
  if (!chat || chat.leftAt || !detail) return false;
  await rememberChatDefaults(db, chat, detail.event);
  return (await postCard(db, detail, chat)) !== "failed";
}

/** Every few minutes: cards of matches that started in the last day and have no confirmed result are re-rendered, so the Result button shows up. The hash keeps it to one edit per card. */
export async function refreshStartedCards(db: Db, now = new Date()): Promise<number> {
  if (!telegramEnabled()) return 0;
  const rows = await db
    .selectDistinct({ code: events.code })
    .from(events)
    .where(
      and(
        eq(events.type, "match"),
        lte(events.startsAt, now),
        gt(events.startsAt, new Date(now.getTime() - DAY_MS)),
        eq(events.scoreLockedByCreator, false),
        inArray(events.status, ["open", "full", "past"]),
        sql`(exists (select 1 from ${telegramCards} c where c.event_id = ${events.id} and c.kind = 'card') or exists (select 1 from ${telegramInlineCards} i where i.event_id = ${events.id}))`,
      ),
    )
    .limit(100);
  let edits = 0;
  for (const r of rows) edits += await syncTelegram(db, r.code, now);
  return edits;
}

/** About an hour before: one reminder per match into each chat that carries its card. */
export async function sendTelegramReminders(db: Db, now = new Date()): Promise<number> {
  if (!telegramEnabled()) return 0;
  const soon = new Date(now.getTime() + 90 * 60 * 1000);
  const due = await db
    .select({ id: events.id, code: events.code })
    .from(events)
    .where(and(gt(events.startsAt, now), lte(events.startsAt, soon), isNull(events.telegramReminderSentAt), inArray(events.status, ["open", "full"]), sql`exists (select 1 from ${telegramCards} c where c.event_id = ${events.id} and c.kind = 'card')`))
    .limit(50);
  let sent = 0;
  for (const row of due) {
    await db.update(events).set({ telegramReminderSentAt: now }).where(eq(events.id, row.id));
    const detail = await getEventByCode(db, row.code);
    if (!detail) continue;
    const cards = await db
      .select({ card: telegramCards, chat: telegramChats })
      .from(telegramCards)
      .innerJoin(telegramChats, eq(telegramChats.chatId, telegramCards.chatId))
      .where(and(eq(telegramCards.eventId, row.id), eq(telegramCards.kind, "card"), isNull(telegramChats.leftAt)));
    for (const { card, chat } of cards) {
      const locale = chatLocale(chat);
      const s = strings(locale);
      const occupied = detail.roster.filter((x) => x.position <= detail.event.capacity && isOccupied(x)).length;
      const res = await sendMessage(chat.chatId, s.reminder(cardTitle(detail, locale), whereLine(detail, locale), occupied, detail.event.capacity), { replyTo: card.messageId });
      if (res.ok) sent++;
    }
  }
  return sent;
}

/** The first result anyone records: the picture, once per chat, with a line for the winners and "same time next week?". Never throws. */
export async function postTelegramResult(db: Db, code: string): Promise<number> {
  if (!telegramEnabled()) return 0;
  try {
    const detail = await getEventByCode(db, code);
    if (!detail) return 0;
    if (detail.event.type === "match" ? detail.scores.length === 0 : !detail.event.standings?.length) return 0;
    const ev = detail.event;
    const cards = await db
      .select({ card: telegramCards, chat: telegramChats })
      .from(telegramCards)
      .innerJoin(telegramChats, eq(telegramChats.chatId, telegramCards.chatId))
      .where(and(eq(telegramCards.eventId, ev.id), isNull(telegramChats.leftAt)));
    const done = new Set(cards.filter((c) => c.card.kind === "result").map((c) => c.chat.chatId));
    let posted = 0;
    for (const { card, chat } of cards.filter((c) => c.card.kind === "card" && !done.has(c.chat.chatId))) {
      const locale = chatLocale(chat);
      const s = strings(locale);
      let caption = `${s.result} · ${cardTitle(detail, locale)}`;
      if (ev.type === "match") {
        const r = matchResult(
          detail.scores,
          detail.roster.map((x) => ({ team: x.team, status: x.status, name: x.player?.displayName ?? x.invitedName ?? "?" })),
        );
        if (r) {
          caption += `\n${r.score}`;
          if (r.hasTeams && r.winner !== "draw") {
            const winners = (r.winner === "a" ? r.a : r.b).join(" & ");
            caption += `\n${s.winner(winners)}\n${praiseLine(locale, ev.code, winners)}`;
          }
        }
      } else if (ev.standings?.length) {
        const names = new Map(detail.roster.filter((x) => x.playerId).map((x) => [x.playerId!, x.player?.displayName ?? "?"]));
        caption += `\n${s.winner(ev.standings.slice(0, 3).map((id, i) => `${i + 1}. ${names.get(id) ?? "?"}`).join("  "))}`;
      }
      const url = `${baseUrl()}/${ev.code}/card`;
      const keyboard: InlineKeyboard = { inline_keyboard: [[{ text: s.open, url }], ...(ev.type === "match" && !ev.groupId ? [[{ text: s.sameTime, callback_data: `g:${ev.code}` }]] : [])] };
      const photo = await sendPhoto(chat.chatId, `${baseUrl()}/${ev.code}/card/opengraph-image`, caption, { replyTo: card.messageId, keyboard });
      const res = photo.ok ? photo : await sendMessage(chat.chatId, caption, { replyTo: card.messageId, keyboard });
      if (res.ok) {
        await db.insert(telegramCards).values({ eventId: ev.id, chatId: chat.chatId, messageId: res.result.message_id, kind: "result" }).onConflictDoNothing();
        posted++;
      }
    }
    return posted;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Creating from the chat, and the result from the card.
// ---------------------------------------------------------------------------
/** The zone a chat's matches live in: set with /tz, learned from the last match carried here, or read off the text (a city or an area). */
async function chatZone(db: Db, chat: TelegramChat, hint: string | null): Promise<string | null> {
  if (chat.tz) return chat.tz;
  const [row] = await db.select({ tz: events.tz }).from(telegramCards).innerJoin(events, eq(events.id, telegramCards.eventId)).where(eq(telegramCards.chatId, chat.chatId)).orderBy(desc(telegramCards.createdAt)).limit(1);
  return row?.tz ?? hint;
}

/** A chat learns its zone and its usual court from the first match made for it. */
async function rememberChatDefaults(db: Db, chat: TelegramChat, ev: Event): Promise<void> {
  const set: Partial<typeof telegramChats.$inferInsert> = {};
  if (!chat.tz) set.tz = ev.tz;
  if (!chat.venueName && ev.venueName) set.venueName = ev.venueName;
  if (Object.keys(set).length) await db.update(telegramChats).set(set).where(eq(telegramChats.chatId, chat.chatId));
}

/** "6-3 6-4", "6:3, 6:4": up to three sets. */
export function parseSets(text: string): SetScore[] {
  const out: SetScore[] = [];
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s*[-:]\s*(\d{1,2})(?!\d)/g)) {
    if (out.length === 3) break;
    out.push({ setNumber: out.length + 1, sideA: Number(m[1]), sideB: Number(m[2]) });
  }
  return out;
}

type Seat = EventDetail["roster"][number];
const seatName = (x: Seat) => x.player?.displayName ?? x.invitedName ?? "?";
const playingSeats = (detail: EventDetail): Seat[] => detail.roster.filter((x) => x.position <= detail.event.capacity && isOccupied(x) && x.playerId).sort((a, b) => a.position - b.position);
/** Both pairs, once they are known (set on the site, or by the first result tap). */
function teamsOf(detail: EventDetail): { a: Seat[]; b: Seat[] } | null {
  const seats = playingSeats(detail);
  const a = seats.filter((x) => x.team === "a");
  const b = seats.filter((x) => x.team === "b");
  return a.length === 2 && b.length === 2 ? { a, b } : null;
}
const scoreErrorText = (s: BotStrings, e: unknown) => (isDomainError(e) ? (e.code === "not_started" ? s.notYet : e.code === "locked" ? s.resultLocked : e.code === "not_participant" ? s.onlyPlayers : s.toastError) : s.toastError);

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
  await joinEvent(db, { eventId: ev.id, playerId: player.id }).catch(() => undefined);
  await rememberChatDefaults(db, chat, ev);
  const detail = (await getEventByCode(db, ev.code))!;
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

/** "/score CODE 6-3 6-4", or "/score 6-3 6-4" as a reply to the card. Needs the pairs to be known. */
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

// ---------------------------------------------------------------------------
// Finding matches: /games in the private chat, and inline mode (@bot in any chat).
// ---------------------------------------------------------------------------
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

/** A winner tap: the pairs and who won are saved; the organizer's tap confirms at once, a player's waits for the organizer. */
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

// ---------------------------------------------------------------------------
// Notices: the two things a player must not miss, and the organizer's feed.
// Players who joined from a card have no email and no push; Telegram is the
// only way to reach them. A private message when the bot may send one (the
// player pressed Start once, or signed in on the site), and a reply under the
// card mentioning them either way.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------
const CODE_RE = /(?:^|\/|\s)([A-Za-z0-9]{4})(?=$|[\s/?#])/;
const LINK_RE = /https?:\/\/[^\s/]+\/([A-Za-z0-9]{4})(?=$|[\s/?#])/g;

function parseCommand(text: string | undefined): { command: string; args: string } | null {
  if (!text || !text.startsWith("/")) return null;
  const [head, ...rest] = text.trim().split(/\s+/);
  const command = head.slice(1).split("@")[0].toLowerCase();
  return { command, args: rest.join(" ") };
}

/** Codes of kicksma.sh links in a message (own host or the short domain). */
export function codesInText(text: string | undefined, base = baseUrl()): string[] {
  if (!text) return [];
  const host = new URL(base).host;
  const out: string[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const linkHost = m[0].split("/")[2];
    if ((linkHost === host || linkHost === "kicksma.sh") && isValidShareCode(m[1])) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** /feedback and your words: stored, thanked at once; the daily session reads it and tells the person here if something gets built. */
async function feedbackFromChat(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, args: string, locale: BotLocale): Promise<string> {
  const fs = feedbackStrings(locale);
  const text = args.trim();
  const isPrivate = msg.chat.type === "private";
  if (text.length < 3) {
    await sendMessage(chat.chatId, esc(fs.how), { silent: !isPrivate, replyTo: msg.message_id });
    return "feedback:how";
  }
  if ((await feedbackCountToday(db, { telegramUserId: from.id })) >= FEEDBACK_LIMITS.perPersonPerDay) return "feedback:too_many";
  const player = await findTelegramPlayer(db, from.id);
  const row = await createFeedback(db, {
    source: "telegram",
    text,
    locale,
    name: from.first_name,
    playerId: player?.id ?? null,
    context: isPrivate ? null : ((msg.chat as { title?: string }).title ?? null),
    telegramChatId: chat.chatId,
    telegramUserId: from.id,
    telegramThreadId: msg.message_thread_id ?? null,
    telegramMessageId: msg.message_id,
  });
  const ack = await composeAck(db, { text, name: from.first_name, locale, source: "telegram" });
  const res = await sendMessage(chat.chatId, esc(ack.reply), { silent: !isPrivate, replyTo: msg.message_id });
  if (ack.kind === "not_feedback") {
    await markNotFeedback(db, row.id, ack.reply);
    return `feedback_not:${row.id}`;
  }
  if (res.ok) await markAcknowledged(db, row.id, ack.reply);
  return `feedback:${row.id}`;
}

async function handleMessage(db: Db, msg: TgMessage, ctx: OpContext): Promise<string> {
  const from = msg.from;
  if (!from || from.is_bot) return "ignored";
  const isPrivate = msg.chat.type === "private";
  if (!isPrivate && !GROUP_TYPES.has(msg.chat.type)) return "ignored";
  const cmd = parseCommand(msg.text);
  const base = baseUrl();
  // The private chat gets a row too: a card can live there and be shared onwards with 📤.
  const { chat } = await upsertChat(db, msg.chat, from);
  const locale = chatLocale(chat);
  const s = strings(locale);
  const threadId = msg.message_thread_id ?? null;
  // A reply to one of the /new prompts (another time, another place) continues that match.
  const continued = cmd ? null : await continueGuidedNew(db, msg, chat, from, ctx);
  if (continued) return continued;
  if (cmd) {
    if (cmd.command === "new" && cmd.args.trim()) return createFromChat(db, msg, chat, from, cmd.args.trim(), ctx);
    if (cmd.command === "new") return startGuidedNew(db, msg, chat);
    if (cmd.command === "score") return scoreFromChat(db, msg, chat, from, cmd.args, ctx);
    if (cmd.command === "games") return gamesFromChat(db, msg, chat, from, cmd.args);
    if (cmd.command === "tz") {
      const zone = resolveZone(cmd.args);
      if (!zone) {
        await sendMessage(chat.chatId, s.tzUnknown, { replyTo: msg.message_id, silent: true });
        return "tz_unknown";
      }
      await db.update(telegramChats).set({ tz: zone }).where(eq(telegramChats.chatId, chat.chatId));
      await sendMessage(chat.chatId, esc(s.tzSet(zone)), { silent: true });
      return "tz";
    }
    if (cmd.command === "match") {
      const code = codesInText(cmd.args, base)[0] ?? cmd.args.match(CODE_RE)?.[1];
      const detail = code && isValidShareCode(code) ? await getEventByCode(db, code) : null;
      if (!detail) {
        await sendMessage(chat.chatId, s.noMatch, { replyTo: msg.message_id, silent: true });
        return "match_unknown";
      }
      await postCard(db, detail, chat, { replyTo: msg.message_id, threadId });
      return "card";
    }
    if (cmd.command === "lang") {
      const next: BotLocale = cmd.args.trim().toLowerCase().startsWith("ru") ? "ru" : "en";
      await db.update(telegramChats).set({ locale: next }).where(eq(telegramChats.chatId, chat.chatId));
      await sendMessage(chat.chatId, strings(next).langSet, { silent: true });
      return "lang";
    }
    if (cmd.command === "feedback" || cmd.command === "idea" || cmd.command === "bug") return feedbackFromChat(db, msg, chat, from, cmd.args, locale);
    if (cmd.command === "lessons" && isPrivate) {
      const player = await findOrCreateTelegramPlayer(db, from);
      return lessonsFor(db, player, chat.chatId);
    }
    if (["today", "tomorrow", "week", "low"].includes(cmd.command) && isPrivate) {
      // The menu's commands are the same words the assistant reads.
      const player = await findOrCreateTelegramPlayer(db, from);
      const assisted = await coachAssistantMessage(db, { ...msg, text: cmd.command }, from, player);
      if (assisted) return assisted;
    }
    if (cmd.command === "coach" && isPrivate) {
      // The coach's assistant: the menu here, and the book on the web with this device signed in.
      const player = await findOrCreateTelegramPlayer(db, from);
      await sendRoleMenu(db, player, chat.chatId);
      const token = await getOrCreatePersonalToken(db, player.id);
      await sendMessage(chat.chatId, esc(s.coachLink), { keyboard: { inline_keyboard: [[{ text: s.coachOpen, url: `${personalUrl(base, token)}?next=/coach` }]] }, silent: true });
      return "coach_link";
    }
    if (cmd.command === "help" || cmd.command === "start") {
      if (!isPrivate) {
        await sendMessage(chat.chatId, s.help, { silent: true });
        return "help";
      }
      // Deep links: t.me/bot?start=r_CODE asks for a result here; ?start=CODE shows a card; ?start=new explains /new;
      // ?start=coach_TICKET comes from the setup's "open your assistant" button and binds this account to the coach.
      const payload = cmd.args.trim();
      const coachLink = payload.match(/^coach_(.+)$/);
      if (coachLink) {
        const ticketId = ticketPlayerId(coachLink[1]);
        const target = ticketId ? await getPlayer(db, ticketId) : null;
        // The ticket is salted with the player's Telegram binding: a link minted before a bind, or after two days, is dead.
        if (!target || !verifyPlayerTicket(coachLink[1], target)) {
          await sendMessage(chat.chatId, esc(s.coachLinkExpired), { silent: true });
          return "coach_link_expired";
        }
        // Once bound, the assistant stays with that account: a forwarded link does not move it and never merges a stranger in.
        if (target.telegramId !== null && target.telegramId !== from.id) {
          await sendMessage(chat.chatId, esc(s.coachLinkOther), { silent: true });
          return "coach_link_other";
        }
        const linked = await linkTelegram(db, target.id, from);
        // The assistant introduces itself with its buttons; the book stays one tap away.
        await sendRoleMenu(db, linked, chat.chatId, s.coachLinked);
        const token = await getOrCreatePersonalToken(db, linked.id);
        await sendMessage(chat.chatId, esc(s.coachOpen), { keyboard: { inline_keyboard: [[{ text: s.coachOpen, url: `${personalUrl(base, token)}?next=/coach` }]] }, silent: true });
        return "coach_linked";
      }
      const result = payload.match(/^r_([A-Za-z0-9]{4})$/);
      if (result) {
        const detail = await getEventByCode(db, result[1]);
        if (detail && detail.event.type === "match" && playingSeats(detail).length === 4 && !detail.event.scoreLockedByCreator) {
          await sendMessage(chat.chatId, esc(s.whoWon(cardTitle(detail, locale))), { keyboard: resultPromptKeyboard(detail) });
          return "private_result_prompt";
        }
      }
      if (isValidShareCode(payload)) {
        const detail = await getEventByCode(db, payload);
        if (detail) {
          await postCard(db, detail, chat);
          return "card";
        }
      }
      const player = await findOrCreateTelegramPlayer(db, from);
      // A coach or a student gets their menu, not the general help.
      const menu = await sendRoleMenu(db, player, chat.chatId);
      if (menu) return menu;
      const token = await getOrCreatePersonalToken(db, player.id);
      await sendMessage(chat.chatId, `${esc(s.privateStart(personalUrl(base, token)))}\n\n${esc(s.privateHelp)}`, { keyboard: payload === "new" ? null : null });
      return "private_start";
    }
    return "ignored";
  }
  // "6-4 6-3" as a reply to a card or a nudge is the score; a reply to the thank-you joins the note.
  const scored = await plainScore(db, msg, chat, from, ctx);
  if (scored) return scored;
  const appended = await feedbackReply(db, msg, chat, from, locale);
  if (appended) return appended;
  // A pasted kicksma.sh link becomes a live card (in groups this needs admin rights or privacy mode off); in the private chat a bare code works too.
  const codes = codesInText(msg.text, base);
  if (isPrivate && codes.length === 0 && msg.text && isValidShareCode(msg.text.trim())) codes.push(msg.text.trim());
  for (const code of codes.slice(0, 2)) {
    const detail = await getEventByCode(db, code);
    if (detail) await postCard(db, detail, chat, { replyTo: msg.message_id, threadId });
  }
  if (codes.length) return "card";
  if (isPrivate) {
    // A coach's one-liner or a student's day and time: the book answers before the generic help does.
    const player = await findOrCreateTelegramPlayer(db, from);
    const assisted = await coachAssistantMessage(db, msg, from, player);
    if (assisted) return assisted;
    await sendMessage(chat.chatId, esc(s.privateHelp), { silent: true });
    return "private_other";
  }
  return "ignored";
}

/** "Same time next week?" under a result: the crew becomes a group with the match's own weekly slot. */
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

/** A reply to the thank-you (or any of our messages) from someone with a recent note: it joins that note. */
async function feedbackReply(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, locale: BotLocale): Promise<string | null> {
  const replied = msg.reply_to_message;
  if (!replied || !msg.text || !replied.from?.is_bot) return null;
  const botId = telegramBotId();
  if (botId && String(replied.from.id) !== botId) return null;
  const note = await findNoteForReply(db, { telegramUserId: from.id, telegramChatId: chat.chatId });
  if (!note) return null;
  const updated = await appendFeedbackReply(db, note.id, msg.text);
  if (!updated) return null;
  if (updated.messagesSent < FEEDBACK_LIMITS.messagesPerItem) await sendMessage(chat.chatId, esc(strings(locale).feedbackAdded), { replyTo: msg.message_id, silent: true });
  return `feedback:added:${note.id}`;
}

async function handleListenCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, action: "la" | "ls" | "lu", id: string): Promise<string> {
  if (cb.from.id !== ownerTelegramId()) {
    await answerCallbackQuery(cb.id);
    return "listen:not_owner";
  }
  if (action === "lu") {
    const row = await setAnswerPublished(db, id, false);
    await answerCallbackQuery(cb.id, row ? "Unpublished." : "Not found.");
    if (cb.message && row) await editMessageText(cb.message.chat.id, cb.message.message_id, `🗑 <b>Unpublished</b>\n${esc(row.title)}`, { inline_keyboard: [[{ text: "Desk", url: `${baseUrl()}/admin/listen` }]] });
    return row ? "listen:unpublished" : "listen:noop";
  }
  if (action === "ls") {
    const row = await skipItem(db, id);
    await answerCallbackQuery(cb.id, row ? "Skipped." : "Already decided.");
    if (cb.message) await editMessageText(cb.message.chat.id, cb.message.message_id, `⏭ <b>Skipped</b>\n${esc(row?.title ?? "")}`, null);
    return row ? "listen:skipped" : "listen:noop";
  }
  const res = await approveItem(db, id);
  const text = res.status === "posted" ? `✅ Posted: ${res.url}` : res.status === "approved_manual" ? "✅ Approved. Copy it from the admin page." : res.status === "failed" ? `⚠️ Approved, posting failed: ${res.error}` : res.status === "already" ? "Already posted." : "Not found.";
  await answerCallbackQuery(cb.id, text.slice(0, 190), { alert: res.status === "failed" });
  if (cb.message) {
    const url = `${baseUrl()}/admin/listen?item=${id}`;
    await editMessageText(cb.message.chat.id, cb.message.message_id, `${esc(text)}`, { inline_keyboard: [[{ text: "Admin", url }]] });
  }
  return `listen:${res.status}`;
}

async function handleClubCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, action: "ca" | "cr", token: string): Promise<string> {
  if (cb.from.id !== ownerTelegramId()) {
    await answerCallbackQuery(cb.id);
    return "club:not_owner";
  }
  const club = await getClubByToken(db, token);
  const row = club ? await decideClub(db, club.slug, action === "ca") : null;
  if (!row) {
    await answerCallbackQuery(cb.id, "Not found.");
    return "club:noop";
  }
  const text = action === "ca" ? `✅ Live${row.founding ? " · founding club" : ""}: ${row.name}` : `❌ Not approved: ${row.name}`;
  await answerCallbackQuery(cb.id, text.slice(0, 190));
  if (cb.message) await editMessageText(cb.message.chat.id, cb.message.message_id, esc(text), { inline_keyboard: [[{ text: "Open page", url: `${baseUrl()}/v/${row.slug}` }]] });
  return action === "ca" ? "club:approved" : "club:rejected";
}

async function handleOutreachCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, action: "oa" | "os", id: string): Promise<string> {
  if (cb.from.id !== ownerTelegramId()) {
    await answerCallbackQuery(cb.id);
    return "outreach:not_owner";
  }
  const desk = { inline_keyboard: [[{ text: "Desk", url: `${baseUrl()}/admin/press?item=${id}` }]] };
  if (action === "os") {
    const row = await skipOutreach(db, id);
    await answerCallbackQuery(cb.id, row ? "Skipped." : "Already decided.");
    if (cb.message) await editMessageText(cb.message.chat.id, cb.message.message_id, `⏭ <b>Skipped</b>\n${esc(row?.subject ?? "")}`, desk);
    return row ? "outreach:skipped" : "outreach:noop";
  }
  const res = await approveOutreach(db, id);
  const text = res.status === "sent" ? "✅ Sent." : res.status === "already" ? "Already sent." : res.status === "disabled" ? "Email is off on this deployment." : res.status === "failed" ? `⚠️ Not sent: ${res.error}` : "Not found.";
  await answerCallbackQuery(cb.id, text.slice(0, 190), { alert: res.status === "failed" });
  if (cb.message) await editMessageText(cb.message.chat.id, cb.message.message_id, esc(text), desk);
  return `outreach:${res.status}`;
}

async function handleCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, ctx: OpContext): Promise<string> {
  const data = cb.data ?? "";
  if (/^(cu|cp|cs|lc|lx|lb|ld|cb):/.test(data)) {
    const handled = await handleCoachCallback(db, cb, await findOrCreateTelegramPlayer(db, cb.from));
    if (handled) return handled;
  }
  const listen = data.match(/^(la|ls|lu):([0-9a-f-]{36})$/);
  if (listen) return handleListenCallback(db, cb, listen[1] as "la" | "ls" | "lu", listen[2]);
  const mail = data.match(/^(oa|os):([0-9a-f-]{36})$/);
  if (mail) return handleOutreachCallback(db, cb, mail[1] as "oa" | "os", mail[2]);
  const club = data.match(/^(ca|cr):([A-Za-z0-9_-]{16,40})$/);
  if (club) return handleClubCallback(db, cb, club[1] as "ca" | "cr", club[2]);
  const guided = data.match(/^n:([zdtv]):(.+)$/);
  if (guided) return handleGuidedNew(db, cb, guided[1], guided[2], ctx);
  const m = data.match(/^([jlrwkcg]):([A-Za-z0-9]{4})(?::([ab]|\d\d))?$/);
  const chat = cb.message ? await getChat(db, cb.message.chat.id) : null;
  const locale = chatLocale(chat, cb.from.language_code);
  const s = strings(locale);
  if (!m) {
    await answerCallbackQuery(cb.id);
    return "callback_unknown";
  }
  const [, action, code, sel] = m;
  const detail = await getEventByCode(db, code);
  if (!detail) {
    await answerCallbackQuery(cb.id, s.noMatch);
    return "callback_no_match";
  }
  // A tap under a card shared through inline mode: learn its id now (inline feedback may be off), so the card can be kept live.
  if (!cb.message && cb.inline_message_id) await rememberInlineCard(db, cb.inline_message_id, code, locale);
  if (action === "c") {
    if (chat) await postCard(db, detail, chat);
    await answerCallbackQuery(cb.id);
    return "card";
  }
  if (action === "r") return handleResultPrompt(cb, detail, locale);
  if (action === "w") return handleWinner(db, cb, detail, sel ?? "", ctx, locale);
  if (action === "k") return handleConfirm(db, cb, detail, ctx, locale);
  if (action === "g") return handleSameTime(db, cb, detail, locale);
  const player = await findOrCreateTelegramPlayer(db, cb.from);
  let toast: string = s.toastError;
  let outcome = "error";
  try {
    if (action === "j") {
      const r = await joinAsPlayer(db, detail, player, ctx);
      outcome = r.outcome;
      toast = r.outcome === "joined" ? s.toastJoined : r.outcome === "waitlisted" ? s.toastWaitlisted : r.outcome === "already_in" ? s.toastAlready : r.outcome === "requested" ? s.toastRequested : s.toastClosed;
    } else {
      const r = await leaveAsPlayer(db, detail, player, ctx);
      outcome = r.outcome;
      toast = r.outcome === "left" ? s.toastLeft : s.toastNotIn;
    }
  } catch (e) {
    if (e instanceof ApiError && e.code === "level_required") toast = s.toastLevel;
    else if (isDomainError(e)) toast = e.code === "past" ? s.toastPast : e.code === "already_in" ? s.toastAlready : e.code === "full" || e.code === "closed" ? s.toastClosed : s.toastError;
    outcome = `error:${e instanceof ApiError ? e.code : isDomainError(e) ? e.code : "unknown"}`;
  }
  await answerCallbackQuery(cb.id, toast, { alert: outcome.startsWith("error:level") });
  await syncTelegram(db, code);
  return `${action === "j" ? "join" : "leave"}:${outcome}`;
}

async function handleMyChatMember(db: Db, u: NonNullable<TgUpdate["my_chat_member"]>): Promise<string> {
  if (!GROUP_TYPES.has(u.chat.type)) return "ignored";
  const status = u.new_chat_member.status;
  if (status === "left" || status === "kicked") {
    await db.update(telegramChats).set({ leftAt: new Date() }).where(eq(telegramChats.chatId, u.chat.id));
    return "left";
  }
  if (status === "member" || status === "administrator") {
    const { chat, created } = await upsertChat(db, u.chat, u.from);
    if (created) await sendMessage(chat.chatId, strings(chatLocale(chat)).welcome, { silent: true });
    return created ? "welcome" : "rejoined";
  }
  return "ignored";
}

/** One update in, a short outcome string out (for logs and tests). Never throws. */
export async function handleTelegramUpdate(db: Db, update: TgUpdate, ctx: OpContext): Promise<string> {
  try {
    if (update.callback_query) return await handleCallback(db, update.callback_query, ctx);
    if (update.message) return await handleMessage(db, update.message, ctx);
    if (update.my_chat_member) return await handleMyChatMember(db, update.my_chat_member);
    if (update.inline_query) return await handleInlineQuery(db, update.inline_query);
    if (update.chosen_inline_result) {
      const r = update.chosen_inline_result;
      if (!r.inline_message_id || !isValidShareCode(r.result_id)) return "inline_chosen_untracked";
      return (await rememberInlineCard(db, r.inline_message_id, r.result_id, botLocale(r.from.language_code))) ? "inline_chosen" : "inline_chosen_unknown";
    }
    return "ignored";
  } catch (e) {
    return `error:${e instanceof Error ? e.message : String(e)}`;
  }
}

export const BOT_COMMANDS = {
  en: [
    { command: "new", description: "Create a match: /new tomorrow 19:00 Rawai" },
    { command: "match", description: "Post the card of a match: /match CODE" },
    { command: "games", description: "Open matches near you: /games phuket" },
    { command: "score", description: "Sets after a match: /score CODE 6-3 6-4" },
    { command: "tz", description: "This chat's time zone, once: /tz phuket" },
    { command: "lang", description: "Bot language: /lang en or /lang ru" },
    { command: "feedback", description: "Tell me what should change" },
    { command: "lessons", description: "Your lessons and package with your coach (private chat)" },
    { command: "coach", description: "Your lessons book, if you coach (write to me privately)" },
    { command: "help", description: "What I do (very little, on purpose)" },
  ],
  ru: [
    { command: "new", description: "Создать матч: /new завтра 19:00 Равай" },
    { command: "match", description: "Показать карточку матча: /match КОД" },
    { command: "games", description: "Открытые матчи рядом: /games пхукет" },
    { command: "score", description: "Счёт после матча: /score КОД 6-3 6-4" },
    { command: "tz", description: "Часовой пояс чата, один раз: /tz пхукет" },
    { command: "lang", description: "Язык бота: /lang ru или /lang en" },
    { command: "feedback", description: "Что стоит изменить" },
    { command: "lessons", description: "Ваши занятия и абонемент у тренера (в личке)" },
    { command: "coach", description: "Книга занятий, если вы тренер (напишите мне в личку)" },
    { command: "help", description: "Что я умею (нарочно немного)" },
  ],
};

export const botDeepLink = (payload?: string) => {
  const u = telegramBotUsername();
  return u ? `https://t.me/${u}${payload ? `?start=${encodeURIComponent(payload)}` : ""}` : null;
};
