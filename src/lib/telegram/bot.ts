import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, telegramCards, telegramChats, telegramInlineCards, type Event, type Player, type TelegramChat } from "@/db/schema";
import { ApiError } from "@/lib/api/http";
import { joinAsPlayer, leaveAsPlayer, type OpContext } from "@/lib/api/operations";
import { baseUrl } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { isDomainError } from "@/lib/domain/errors";
import { createEvent, isOccupied } from "@/lib/domain/events";
import { DEFAULT_POINTS, formatOf } from "@/lib/domain/formats";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { applyEventLevels } from "@/lib/domain/rating";
import { saveMatchScore, type SetScore } from "@/lib/domain/scores";
import { joinEvent } from "@/lib/domain/slots";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { mergePlayers } from "@/lib/domain/merge";
import { createPlayer } from "@/lib/domain/players";
import { getEventByCode, getPlayerEvents, type EventDetail } from "@/lib/domain/queries";
import { CITIES, cityInText, cityOf, type City } from "@/lib/domain/cities";
import { getCityBoard, withCounts } from "@/lib/domain/venueBoard";
import { matchResult, WINNER_ONLY_SETS } from "@/lib/domain/result";
import { personalEventUrl, personalUrl } from "@/lib/personal";
import { isValidShareCode } from "@/lib/codes";
import { answerCallbackQuery, answerInlineQuery, editInlineMessageText, editMessageText, esc, sendMessage, sendPhoto, telegramBotUsername, telegramEnabled, telegramWebhookSecret, type InlineArticle, type InlineKeyboard, type TgChat, type TgMessage, type TgUpdate, type TgUser } from "./api";
import { botLocale, cardTitle, renderCard, strings, whenLine, whereLine, type BotLocale, type BotStrings } from "./card";
import { parseNewCommand, resolveZone, tzHintFor } from "./parse";
import { setAnswerPublished } from "@/lib/listen/answers";
import { approveItem, ownerTelegramId, skipItem } from "@/lib/listen/tick";
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
        if (res.ok || /message is not modified/i.test(res.description)) {
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
      if (res.ok || /message is not modified/i.test(res.description)) {
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

/** Once the organizer finalizes: the result picture, once per chat. Never throws. */
export async function postTelegramResult(db: Db, code: string): Promise<number> {
  if (!telegramEnabled()) return 0;
  try {
    const detail = await getEventByCode(db, code);
    if (!detail || !detail.event.scoreLockedByCreator) return 0;
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
          if (r.hasTeams && r.winner !== "draw") caption += `\n${s.winner((r.winner === "a" ? r.a : r.b).join(" & "))}`;
        }
      } else if (ev.standings?.length) {
        const names = new Map(detail.roster.filter((x) => x.playerId).map((x) => [x.playerId!, x.player?.displayName ?? "?"]));
        caption += `\n${s.winner(ev.standings.slice(0, 3).map((id, i) => `${i + 1}. ${names.get(id) ?? "?"}`).join("  "))}`;
      }
      const url = `${baseUrl()}/${ev.code}/card`;
      const photo = await sendPhoto(chat.chatId, `${baseUrl()}/${ev.code}/card/opengraph-image`, caption, { replyTo: card.messageId, keyboard: { inline_keyboard: [[{ text: s.open, url }]] } });
      const res = photo.ok ? photo : await sendMessage(chat.chatId, caption, { replyTo: card.messageId, keyboard: { inline_keyboard: [[{ text: s.open, url }]] } });
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

/** "/new tomorrow 19:00 Rawai 400฿": the match is created and its card posted, no site visit. */
async function createFromChat(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, args: string, ctx: OpContext): Promise<string> {
  const s = strings(chatLocale(chat));
  const now = new Date();
  const params = new URLSearchParams({ tg: chatTicket(chat.chatId) });
  if (chat.venueName) params.set("venue", chat.venueName);
  const form = { inline_keyboard: [[{ text: "kicksma.sh →", url: `${baseUrl()}/?${params.toString()}` }]] };
  const threadId = msg.message_thread_id ?? null;
  const say = (text: string, keyboard?: typeof form) => sendMessage(chat.chatId, esc(text), { keyboard: keyboard ?? null, replyTo: msg.message_id, threadId, silent: true });
  const tz = await chatZone(db, chat, tzHintFor(args));
  if (!tz) {
    await say(s.needTz, form);
    return "new_need_tz";
  }
  const parsed = parseNewCommand(args, { tz, now });
  if (!parsed.startsAt) {
    await say(s.newHowTo, form);
    return "new_how";
  }
  if (parsed.startsAt.getTime() < now.getTime() - DAY_MS) {
    await say(s.newPast);
    return "new_past";
  }
  const player = await findOrCreateTelegramPlayer(db, from);
  if (!(await takeRate(db, "create", player.id, LIMITS.eventsPerPlayerPerDay))) {
    await say(s.tooMany);
    return "new_too_many";
  }
  let ev: Event;
  try {
    ev = await createEvent(db, {
      creatorPlayerId: player.id,
      type: parsed.type,
      startsAt: parsed.startsAt,
      tz,
      venueName: parsed.venue ?? chat.venueName,
      court: parsed.court,
      capacity: parsed.capacity ?? undefined,
      whenFull: "waitlist",
      format: parsed.format,
      pointsPerMatch: parsed.type === "tournament" ? DEFAULT_POINTS[formatOf(parsed.format)] : null,
      levelMin: parsed.levelMin,
      levelMax: parsed.levelMax,
      cost: parsed.cost,
      publicListing: parsed.publicListing,
      groupId: chat.groupId,
    });
  } catch {
    await say(s.newHowTo, form);
    return "new_invalid";
  }
  await joinEvent(db, { eventId: ev.id, playerId: player.id }).catch(() => undefined);
  await rememberChatDefaults(db, chat, ev);
  const detail = (await getEventByCode(db, ev.code))!;
  await postCard(db, detail, chat, { replyTo: msg.message_id, threadId });
  ctx.emit("match.created", ev.code);
  return `new_created:${ev.code}`;
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
    const text = `${esc(isCreator ? s.confirmedNote(names) : s.recorded(names, player.displayName))}\n${esc(s.scoreHint(ev.code))}`;
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
  if (cb.message) await editMessageText(cb.message.chat.id, cb.message.message_id, `${esc(s.confirmedNote(names))}${r?.score ? `\n${esc(r.score)}` : ""}`, null);
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

/** The organizer's private feed: who joined, left, asked. One short line, their locale, a button to the match. Never throws. */
export async function telegramCreatorNote(db: Db, detail: EventDetail, creator: Player, kind: string, actorName: string): Promise<boolean> {
  if (!telegramEnabled() || !creator.telegramId) return false;
  try {
    const locale = botLocale(creator.locale);
    const s = strings(locale);
    const ev = detail.event;
    const n = detail.roster.filter((x) => x.position <= ev.capacity && isOccupied(x)).length;
    const token = await getOrCreatePersonalToken(db, creator.id);
    const text = `${esc(s.orgNote(kind, actorName, n, ev.capacity))}\n<i>${esc(cardTitle(detail, locale))} · ${esc(whenLine(detail, locale))} · ${esc(whereLine(detail, locale))}</i>`;
    const res = await sendMessage(creator.telegramId, text, { keyboard: { inline_keyboard: [[{ text: s.open, url: personalEventUrl(baseUrl(), token, ev.code) }]] }, silent: kind !== "left" && kind !== "declined" });
    return res.ok;
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
  if (cmd) {
    if (cmd.command === "new" && cmd.args.trim()) return createFromChat(db, msg, chat, from, cmd.args.trim(), ctx);
    if (cmd.command === "new") {
      const params = new URLSearchParams({ tg: chatTicket(chat.chatId) });
      if (chat.venueName) params.set("venue", chat.venueName);
      const url = `${base}/?${params.toString()}`;
      await sendMessage(chat.chatId, isPrivate ? esc(s.newHowTo) : s.newMatch, { keyboard: { inline_keyboard: [[{ text: "kicksma.sh →", url }]] }, threadId });
      return "new";
    }
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
    if (cmd.command === "help" || cmd.command === "start") {
      if (!isPrivate) {
        await sendMessage(chat.chatId, s.help, { silent: true });
        return "help";
      }
      // Deep links: t.me/bot?start=r_CODE asks for a result here; ?start=CODE shows a card; ?start=new explains /new.
      const payload = cmd.args.trim();
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
      const token = await getOrCreatePersonalToken(db, player.id);
      await sendMessage(chat.chatId, `${esc(s.privateStart(personalUrl(base, token)))}\n\n${esc(s.privateHelp)}`, { keyboard: payload === "new" ? null : null });
      return "private_start";
    }
    return "ignored";
  }
  // A pasted kicksma.sh link becomes a live card (in groups this needs admin rights or privacy mode off); in the private chat a bare code works too.
  const codes = codesInText(msg.text, base);
  if (isPrivate && codes.length === 0 && msg.text && isValidShareCode(msg.text.trim())) codes.push(msg.text.trim());
  for (const code of codes.slice(0, 2)) {
    const detail = await getEventByCode(db, code);
    if (detail) await postCard(db, detail, chat, { replyTo: msg.message_id, threadId });
  }
  if (codes.length) return "card";
  if (isPrivate) {
    await sendMessage(chat.chatId, esc(s.privateHelp), { silent: true });
    return "private_other";
  }
  return "ignored";
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

async function handleCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, ctx: OpContext): Promise<string> {
  const data = cb.data ?? "";
  const listen = data.match(/^(la|ls|lu):([0-9a-f-]{36})$/);
  if (listen) return handleListenCallback(db, cb, listen[1] as "la" | "ls" | "lu", listen[2]);
  const club = data.match(/^(ca|cr):([A-Za-z0-9_-]{16,40})$/);
  if (club) return handleClubCallback(db, cb, club[1] as "ca" | "cr", club[2]);
  const m = data.match(/^([jlrwkc]):([A-Za-z0-9]{4})(?::([ab]|\d\d))?$/);
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
    { command: "help", description: "What I do (very little, on purpose)" },
  ],
  ru: [
    { command: "new", description: "Создать матч: /new завтра 19:00 Равай" },
    { command: "match", description: "Показать карточку матча: /match КОД" },
    { command: "games", description: "Открытые матчи рядом: /games пхукет" },
    { command: "score", description: "Счёт после матча: /score КОД 6-3 6-4" },
    { command: "tz", description: "Часовой пояс чата, один раз: /tz пхукет" },
    { command: "lang", description: "Язык бота: /lang ru или /lang en" },
    { command: "help", description: "Что я умею (нарочно немного)" },
  ],
};

export const botDeepLink = (payload?: string) => {
  const u = telegramBotUsername();
  return u ? `https://t.me/${u}${payload ? `?start=${encodeURIComponent(payload)}` : ""}` : null;
};
