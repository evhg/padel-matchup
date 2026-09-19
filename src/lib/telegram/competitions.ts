import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { competitionPairs, type Player, type TelegramChat } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { utcToZonedParts } from "@/lib/dates";
import { competitionPage, enterPair, entriesOf, getCompetition, listOpenCompetitions, pairSummary, type CompetitionPage } from "@/lib/domain/competitions";
import { isDomainError } from "@/lib/domain/errors";
import { tellOrganizerOfEntry } from "@/lib/tournament/notify";
import { bandLabel, dayRange } from "@/lib/tournamentText";
import { answerCallbackQuery, deleteMessage, editMessageText, esc, sendMessage, telegramBotId, type InlineKeyboard, type TgMessage, type TgUpdate } from "./api";
import { type BotLocale, type BotStrings } from "./card";
import { claimDeepLink } from "./deepLinks";
import { findOrCreateTelegramPlayer } from "./identity";
import { packId, unpackId } from "./taps";

/**
 * The serious tournament inside the chat: the open competitions as buttons (pt:<packed id>), a
 * competition's card with a door per category (pe:<packed category id>), and the partner by name
 * as a reply to the prompt, whose last line carries the category (↳ tp:<packed id>). The partner
 * gets the same one-tap claim link the web entrant gets; the organiser hears as from the page.
 */

export const PARTNER_TRAILER = /↳ tp:([A-Za-z0-9_-]{22})/;
const kb = (rows: InlineKeyboard["inline_keyboard"]): InlineKeyboard => ({ inline_keyboard: rows });
const DEFAULT_TZ = "Asia/Bangkok";

/** "Tournaments": the open competitions, newest start first as the page lists them, one button each. */
export async function tournamentsInChat(db: Db, chat: TelegramChat, s: BotStrings, locale: BotLocale, editId: number | null = null): Promise<string> {
  const today = utcToZonedParts(new Date(), chat.tz ?? DEFAULT_TZ).date;
  const open = await listOpenCompetitions(db, today);
  const send = (text: string, keyboard: InlineKeyboard | null) => (editId ? editMessageText(chat.chatId, editId, text, keyboard).catch(() => undefined) : sendMessage(chat.chatId, text, { silent: true, keyboard }));
  if (open.length === 0) {
    await send(esc(s.tournamentsNone(`${baseUrl()}/t`)), null);
    return "player:tournaments:none";
  }
  const rows = open.slice(0, 10).map((c) => [{ text: `${c.name} · ${dayRange(c.startsOn, c.endsOn ?? c.startsOn, locale)}`.slice(0, 60), callback_data: `pt:${packId(c.id)}` }]);
  await send(esc(s.tournamentsPick), kb(rows));
  return `player:tournaments:${open.length}`;
}

/** The competition's card: dates, venue, the note, each category with its count, the player's own entries, a door per open category. */
async function competitionCard(db: Db, page: CompetitionPage, playerId: string, s: BotStrings, locale: BotLocale): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const c = page.competition;
  const lines = [`🏆 <b>${esc(c.name)}</b>`, `📅 ${esc(dayRange(c.startsOn, c.endsOn ?? c.startsOn, locale))}`];
  if (c.venueName || c.city) lines.push(`📍 ${esc([c.venueName, c.city].filter(Boolean).join(" · "))}`);
  if (c.entryNote) lines.push(esc(c.entryNote));
  lines.push("");
  const rows: InlineKeyboard["inline_keyboard"] = [];
  const mine: string[] = [];
  for (const { category, entered, waiting } of page.categories) {
    const band = bandLabel(category.levelMin, category.levelMax);
    const open = c.status === "open" && category.drawStatus === "none";
    lines.push(`<b>${esc(category.name)}</b>${band ? ` · ${esc(band)}` : ""} · ${esc(s.tournamentPairs(entered.length, category.maxPairs))}${waiting.length ? ` · ${esc(s.tournamentWaiting(waiting.length))}` : ""}${open ? "" : ` · ${esc(s.tournamentClosed)}`}`);
    const own = [...entered, ...waiting].find((p) => p.p1.id === playerId || p.p2.id === playerId);
    if (own) mine.push(`${category.name}: ${own.p1.name} & ${own.p2.name}`);
    else if (open) rows.push([{ text: s.tournamentEnter(category.name).slice(0, 60), callback_data: `pe:${packId(category.id)}` }]);
  }
  if (mine.length) {
    lines.push("");
    lines.push(esc(s.tournamentMine(mine.join("\n"))));
  }
  rows.push([{ text: s.open, url: `${baseUrl()}/t/${c.slug}` }]);
  return { text: lines.join("\n"), keyboard: kb(rows) };
}

/** pt: the card in place of the list; pe: the partner's name as a forced reply. */
export async function competitionCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, data: string, chat: TelegramChat, s: BotStrings, locale: BotLocale): Promise<string> {
  const ack = (text?: string) => answerCallbackQuery(cb.id, text).catch(() => undefined);
  const chatId = cb.message?.chat.id ?? chat.chatId;
  const editId = cb.message?.message_id ?? null;
  const id = unpackId(data.slice(3));
  if (!id) {
    await ack();
    return "player:tournament:unknown";
  }
  const player = await findOrCreateTelegramPlayer(db, cb.from);
  if (data.startsWith("pt:")) {
    const [c] = await db.select().from(competitionsTable()).where(eq(competitionsTable().id, id)).limit(1);
    if (!c) {
      await ack();
      return "player:tournament:unknown";
    }
    const page = await competitionPage(db, c);
    const card = await competitionCard(db, page, player.id, s, locale);
    await ack();
    if (editId) await editMessageText(chatId, editId, card.text, card.keyboard).catch(() => sendMessage(chatId, card.text, { silent: true, keyboard: card.keyboard }));
    else await sendMessage(chatId, card.text, { silent: true, keyboard: card.keyboard });
    return "player:tournament:card";
  }
  // pe: the category's door. The prompt carries the category; the reply carries the name.
  const cat = await categoryById(db, id);
  if (!cat) {
    await ack();
    return "player:tournament:unknown";
  }
  await ack();
  await sendMessage(chatId, esc(`${s.tournamentPartnerAsk(cat.name)}\n↳ tp:${packId(cat.id)}`), { silent: true, keyboard: { force_reply: true, selective: true, input_field_placeholder: s.tournamentPartnerAsk(cat.name).slice(0, 60) } });
  return "player:tournament:partner_ask";
}

/** The partner's name, typed in reply to the prompt: the pair is in, or on the waiting list, and the partner's link follows. */
export async function continuePartnerReply(db: Db, msg: TgMessage, chat: TelegramChat, player: Player): Promise<string | null> {
  const parent = msg.reply_to_message;
  const botId = telegramBotId();
  if (!parent?.text || !msg.text || !botId || String(parent.from?.id) !== botId) return null;
  const m = parent.text.match(PARTNER_TRAILER);
  const categoryId = m ? unpackId(m[1]) : null;
  if (!categoryId) return null;
  const { strings } = await import("./card");
  const locale = (await import("@/lib/channels/telegram")).chatLocale(chat);
  const s = strings(locale);
  const name = msg.text.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) return null;
  await deleteMessage(chat.chatId, parent.message_id).catch(() => undefined);
  try {
    const e = await enterPair(db, { categoryId, playerId: player.id, partner: { name }, locale });
    const count = (await db.select({ id: competitionPairs.id }).from(competitionPairs).where(eq(competitionPairs.categoryId, categoryId))).length;
    await tellOrganizerOfEntry(db, e, count).catch(() => undefined);
    const head = e.pair.status === "waiting" ? s.tournamentWaitlisted(e.category.name, e.partner.displayName, e.pair.position) : s.tournamentEntered(e.category.name, e.partner.displayName);
    const link = e.claimToken ? (claimDeepLink(e.claimToken) ?? `${baseUrl()}/t/${e.competition.slug}?claim=${e.claimToken}`) : null;
    await sendMessage(chat.chatId, esc(link ? `${head}\n${s.tournamentPartnerLink(link)}` : head), { silent: true, keyboard: kb([[{ text: s.open, url: `${baseUrl()}/t/${e.competition.slug}` }]]) });
    return e.pair.status === "waiting" ? "player:tournament:waitlisted" : "player:tournament:entered";
  } catch (err) {
    if (!isDomainError(err)) throw err;
    const code = err.code === "invalid" ? err.message : err.code;
    await sendMessage(chat.chatId, esc(s.tournamentErr(code)), { silent: true });
    return `player:tournament:${code || err.code}`;
  }
}

// The two lookups the taps need, kept here so the module reads one table each.
import { competitionCategories, competitions } from "@/db/schema";
const competitionsTable = () => competitions;
async function categoryById(db: Db, id: string) {
  const [cat] = await db.select().from(competitionCategories).where(eq(competitionCategories.id, id)).limit(1);
  return cat ?? null;
}
// The exports below are what other modules reach for; the domain's own readers stay the source of truth.
export { entriesOf, getCompetition, pairSummary };
