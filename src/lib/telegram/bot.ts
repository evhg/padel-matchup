import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, telegramCards, telegramChats, type Player, type TelegramChat } from "@/db/schema";
import { ApiError } from "@/lib/api/http";
import { joinAsPlayer, leaveAsPlayer, type OpContext } from "@/lib/api/operations";
import { baseUrl } from "@/lib/config";
import { formatEventTime } from "@/lib/dates";
import { isDomainError } from "@/lib/domain/errors";
import { isOccupied } from "@/lib/domain/events";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { mergePlayers } from "@/lib/domain/merge";
import { createPlayer } from "@/lib/domain/players";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { matchResult } from "@/lib/domain/result";
import { personalUrl } from "@/lib/personal";
import { isValidShareCode } from "@/lib/codes";
import { answerCallbackQuery, editMessageText, esc, sendMessage, sendPhoto, telegramBotUsername, telegramEnabled, telegramWebhookSecret, type TgChat, type TgMessage, type TgUpdate, type TgUser } from "./api";
import { botLocale, cardTitle, renderCard, strings, whereLine, type BotLocale } from "./card";
import { approveItem, ownerTelegramId, skipItem } from "@/lib/listen/tick";

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
  return "posted";
}

/** Called after anything changed on a match: edits every card silently, notes a complete line-up once. Never throws. */
export async function syncTelegram(db: Db, code: string): Promise<number> {
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
      const { text, keyboard, complete } = renderCard(detail, baseUrl(), locale);
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
  return (await postCard(db, detail, chat)) !== "failed";
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
  const cmd = parseCommand(msg.text);
  const base = baseUrl();
  if (msg.chat.type === "private") {
    const s = strings(botLocale(from.language_code));
    if (cmd?.command === "start" || cmd?.command === "help") {
      const player = await findOrCreateTelegramPlayer(db, from);
      const token = await getOrCreatePersonalToken(db, player.id);
      await sendMessage(msg.chat.id, s.privateStart(personalUrl(base, token)));
      return "private_start";
    }
    await sendMessage(msg.chat.id, s.notHere);
    return "private_other";
  }
  if (!GROUP_TYPES.has(msg.chat.type)) return "ignored";
  const { chat } = await upsertChat(db, msg.chat, from);
  const locale = chatLocale(chat);
  const s = strings(locale);
  if (cmd) {
    if (cmd.command === "new") {
      const params = new URLSearchParams({ tg: chatTicket(chat.chatId) });
      if (chat.venueName) params.set("venue", chat.venueName);
      const url = `${base}/?${params.toString()}`;
      await sendMessage(chat.chatId, s.newMatch, { keyboard: { inline_keyboard: [[{ text: "kicksma.sh →", url }]] }, threadId: msg.message_thread_id ?? null });
      return "new";
    }
    if (cmd.command === "match") {
      const code = codesInText(cmd.args, base)[0] ?? cmd.args.match(CODE_RE)?.[1];
      const detail = code && isValidShareCode(code) ? await getEventByCode(db, code) : null;
      if (!detail) {
        await sendMessage(chat.chatId, s.noMatch, { replyTo: msg.message_id, silent: true });
        return "match_unknown";
      }
      await postCard(db, detail, chat, { replyTo: msg.message_id, threadId: msg.message_thread_id ?? null });
      return "card";
    }
    if (cmd.command === "lang") {
      const next: BotLocale = cmd.args.trim().toLowerCase().startsWith("ru") ? "ru" : "en";
      await db.update(telegramChats).set({ locale: next }).where(eq(telegramChats.chatId, chat.chatId));
      await sendMessage(chat.chatId, strings(next).langSet, { silent: true });
      return "lang";
    }
    if (cmd.command === "help" || cmd.command === "start") {
      await sendMessage(chat.chatId, s.help, { silent: true });
      return "help";
    }
    return "ignored";
  }
  // A pasted kicksma.sh link becomes a live card (needs admin rights or privacy mode off to be seen).
  const codes = codesInText(msg.text, base);
  for (const code of codes.slice(0, 2)) {
    const detail = await getEventByCode(db, code);
    if (detail) await postCard(db, detail, chat, { replyTo: msg.message_id, threadId: msg.message_thread_id ?? null });
  }
  void ctx;
  return codes.length ? "card" : "ignored";
}

async function handleListenCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, action: "la" | "ls", id: string): Promise<string> {
  if (cb.from.id !== ownerTelegramId()) {
    await answerCallbackQuery(cb.id);
    return "listen:not_owner";
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

async function handleCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, ctx: OpContext): Promise<string> {
  const data = cb.data ?? "";
  const listen = data.match(/^(la|ls):([0-9a-f-]{36})$/);
  if (listen) return handleListenCallback(db, cb, listen[1] as "la" | "ls", listen[2]);
  const m = data.match(/^([jl]):([A-Za-z0-9]{4})$/);
  const chat = cb.message ? await getChat(db, cb.message.chat.id) : null;
  const locale = chatLocale(chat, cb.from.language_code);
  const s = strings(locale);
  if (!m) {
    await answerCallbackQuery(cb.id);
    return "callback_unknown";
  }
  const [, action, code] = m;
  const detail = await getEventByCode(db, code);
  if (!detail) {
    await answerCallbackQuery(cb.id, s.noMatch);
    return "callback_no_match";
  }
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
    return "ignored";
  } catch (e) {
    return `error:${e instanceof Error ? e.message : String(e)}`;
  }
}

export const BOT_COMMANDS = {
  en: [
    { command: "new", description: "Create a match for this chat" },
    { command: "match", description: "Post the card of a match: /match CODE" },
    { command: "lang", description: "Bot language: /lang en or /lang ru" },
    { command: "help", description: "What I do (very little, on purpose)" },
  ],
  ru: [
    { command: "new", description: "Создать матч для этого чата" },
    { command: "match", description: "Показать карточку матча: /match КОД" },
    { command: "lang", description: "Язык бота: /lang ru или /lang en" },
    { command: "help", description: "Что я умею (нарочно немного)" },
  ],
};

export const botDeepLink = (payload?: string) => {
  const u = telegramBotUsername();
  return u ? `https://t.me/${u}${payload ? `?start=${encodeURIComponent(payload)}` : ""}` : null;
};
