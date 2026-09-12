import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { telegramChats } from "@/db/schema";
import { ApiError } from "@/lib/api/http";
import { joinAsPlayer, leaveAsPlayer, type OpContext } from "@/lib/api/operations";
import { chatLocale } from "@/lib/channels/telegram";
import { menuWord } from "@/lib/coach/menu";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl } from "@/lib/config";
import { isDomainError } from "@/lib/domain/errors";
import { getEventByCode } from "@/lib/domain/queries";
import { answerCallbackQuery, esc, sendMessage, type TgMessage, type TgUpdate } from "./api";
import { botLocale, strings, type BotLocale } from "./card";
import { GROUP_TYPES, getChat, upsertChat } from "./chats";
import { coachAssistantMessage, coachHelp, handleCoachCallback, resolveRole } from "./coach";
import { feedbackFromChat, feedbackReply } from "./handlers/feedback";
import { gamesFromChat, handleInlineQuery, rememberInlineCard } from "./handlers/games";
import { continueGuidedNew, createFromChat, handleGuidedNew, startGuidedNew } from "./handlers/new";
import { handleOwnerCallback } from "./handlers/owner";
import { handleConfirm, handleResultPrompt, handleSameTime, handleWinner, plainScore, scoreFromChat } from "./handlers/result";
import { coachCommand, ROLE_COMMANDS, roleCommand, roleEnded, startCommand } from "./handlers/start";
import { findOrCreateTelegramPlayer } from "./identity";
import { resolveZone } from "./parse";
import { postCard, syncTelegram } from "./post";
import { CODE_RE, codesInText, parseCommand } from "./text";

/**
 * The bot, quiet by design. It posts a new message only for: the match card,
 * "line-up complete", the reminder about an hour before, and the result. Joins
 * and leaves edit the card. Anything else it answers with a toast or not at all.
 *
 * This file is the router: one update in, the handler for it, a short outcome
 * string out. What a handler does lives in handlers/ (one file per thing a person
 * can do), the plumbing next to it: identity (who is talking), chats (where),
 * post (cards into chats), notices (what a player must not miss), text (reading
 * a message). The public names below are re-exported here so routes, actions,
 * the cron and the tests keep one import.
 */

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
    if (cmd.command === "feedback" || cmd.command === "idea" || cmd.command === "bug") return feedbackFromChat(db, msg, chat, from, cmd.args, locale, ctx);
    if (ROLE_COMMANDS.has(cmd.command) && isPrivate) return roleCommand(db, msg, chat, from, cmd.command);
    if (cmd.command === "coach" && isPrivate) return coachCommand(db, chat, from);
    if (cmd.command === "help" || cmd.command === "start") return startCommand(db, chat, from, cmd, isPrivate);
    return "ignored";
  }
  // "6-4 6-3" as a reply to a card or a nudge is the score; a reply to the thank-you joins the note.
  const scored = await plainScore(db, msg, chat, from, ctx);
  if (scored) return scored;
  const appended = await feedbackReply(db, msg, chat, from, locale);
  if (appended) return appended;
  // A pasted kicksma.sh link becomes a live card (in groups this needs admin rights or privacy mode off); in the private chat a bare code works too.
  const codes = codesInText(msg.text, base);
  // A bare four-letter word in the private chat may be a code; it is one only when a match answers to it.
  const bare = isPrivate && codes.length === 0 && msg.text && isValidShareCode(msg.text.trim()) ? msg.text.trim() : null;
  const player = isPrivate && codes.length === 0 ? await findOrCreateTelegramPlayer(db, from) : null;
  const resolved = player ? await resolveRole(db, player) : null;
  let bareMissed = false;
  if (player && resolved) {
    // A menu word ("Week", "Book") is the assistant's before it is a code, even when a match answers to it. Any other code-shaped word is a match first (a code that spells "busy" or "9h45" must not block a day or book a lesson), and the book reads it only when no match answers.
    if (bare && !menuWord(bare)) {
      const detail = await getEventByCode(db, bare);
      if (detail) {
        await postCard(db, detail, chat, { replyTo: msg.message_id, threadId });
        return "card";
      }
      bareMissed = true;
    }
    const assisted = await coachAssistantMessage(db, msg, from, player, resolved, { deferHelp: Boolean(bare) });
    if (assisted) return assisted;
  }
  let posted = 0;
  for (const code of [...codes, ...(bare && !bareMissed ? [bare] : [])].slice(0, 2)) {
    const detail = await getEventByCode(db, code);
    if (!detail) continue;
    await postCard(db, detail, chat, { replyTo: msg.message_id, threadId });
    posted++;
  }
  if (codes.length || posted) return "card";
  if (isPrivate && player) {
    // The book could not read the word and no match answers to it: the book's help.
    if (resolved?.kind === "coach") return coachHelp(player, chat.chatId);
    // A button left over from a role that ended (the coach archived, the student let go): the help, and the keyboard and the role's commands go with it.
    if (!resolved && msg.text && menuWord(msg.text)) return roleEnded(chat.chatId, s.privateHelp);
    await sendMessage(chat.chatId, esc(s.privateHelp), { silent: true });
    return "private_other";
  }
  return "ignored";
}

async function handleCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, ctx: OpContext): Promise<string> {
  const data = cb.data ?? "";
  if (/^(cu|cp|cs|lc|lx|lb|ld|cb):/.test(data)) {
    const handled = await handleCoachCallback(db, cb, await findOrCreateTelegramPlayer(db, cb.from));
    if (handled) return handled;
  }
  // The owner's desk: a listening draft, an outreach mail or a club claim, approved or skipped with one tap.
  const owner = await handleOwnerCallback(db, cb, data);
  if (owner) return owner;
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

// The public face of the module: the code lives where it is named.
export { chatTicket, findOrCreateTelegramPlayer, findTelegramPlayer, linkTelegram, verifyChatTicket } from "./identity";
export { postCard, postCardForTicket, postCardsForGroup, postTelegramResult, refreshStartedCards, sendTelegramReminders, syncTelegram } from "./post";
export { postTelegramNotice, telegramCreatorNote } from "./notices";
export { codesInText, parseSets } from "./text";
export { botDeepLink } from "./api";
export { BOT_COMMANDS } from "./commands";
