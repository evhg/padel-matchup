import type { Db } from "@/db";
import type { TelegramChat } from "@/db/schema";
import { chatLocale } from "@/lib/channels/telegram";
import { ticketPlayerId, verifyPlayerTicket } from "@/lib/coach/link";
import { coachBotLocale, coachStrings } from "@/lib/coach/strings";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl } from "@/lib/config";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { getPlayer } from "@/lib/domain/players";
import { getEventByCode } from "@/lib/domain/queries";
import { personalUrl } from "@/lib/personal";
import { deleteChatCommands, esc, sendMessage, type TgMessage, type TgUser } from "../api";
import { cardTitle, strings } from "../card";
import { coachAssistantMessage, lessonsFor, resolveRole, sendRoleMenu } from "../coach";
import { findOrCreateTelegramPlayer, linkTelegram } from "../identity";
import { postCard } from "../post";
import { playingSeats, resultPromptKeyboard } from "./result";

/** The private chat's doors: /start and its deep links, /help, /coach, and the commands a role adds to the menu. */
export const ROLE_COMMANDS = new Set(["lessons", "today", "tomorrow", "week", "low"]);

/** A role's button or command from someone who has no role (any more): the message, and the role's keyboard and chat commands go with it; both calls are no-ops where nothing was set. */
export
async function roleEnded(chatId: number, text: string, outcome = "private_role_ended"): Promise<string> {
  await sendMessage(chatId, esc(text), { keyboard: { remove_keyboard: true }, silent: true });
  await deleteChatCommands(chatId).catch(() => undefined);
  return outcome;
}

/** /lessons is the student's list; /today, /tomorrow, /week and /low are the same words the coach's assistant reads. */
export async function roleCommand(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, command: string): Promise<string> {
  const s = strings(chatLocale(chat));
  // The role's commands: /lessons is the student's list, the others are the same words the assistant reads.
  const player = await findOrCreateTelegramPlayer(db, from);
  const resolved = await resolveRole(db, player);
  // From someone without the role (any more): /lessons sits in everyone's menu, so it gets the student's line about being accepted first; the coach's commands get the general help. Either way the role's keyboard and commands go with it.
  if (!resolved && command === "lessons") return roleEnded(chat.chatId, coachStrings(coachBotLocale(player.locale)).notStudent, "student:none");
  if (!resolved) return roleEnded(chat.chatId, s.privateHelp);
  if (command === "lessons" && (resolved.kind === "coach" || resolved.coaches.some((c) => c.status === "accepted"))) return lessonsFor(db, player, chat.chatId);
  const assisted = await coachAssistantMessage(db, { ...msg, text: command }, from, player, resolved);
  if (assisted) return assisted;
  await sendMessage(chat.chatId, esc(s.privateHelp), { silent: true });
  return "private_other";
}

/** /coach: the assistant's menu here, and the book on the web with this device signed in. */
export async function coachCommand(db: Db, chat: TelegramChat, from: TgUser): Promise<string> {
  const s = strings(chatLocale(chat));
  const base = baseUrl();
  // The coach's assistant: the menu here, and the book on the web with this device signed in.
  const player = await findOrCreateTelegramPlayer(db, from);
  await sendRoleMenu(db, player, chat.chatId, { pin: false });
  const token = await getOrCreatePersonalToken(db, player.id);
  await sendMessage(chat.chatId, esc(s.coachLink), { keyboard: { inline_keyboard: [[{ text: s.coachOpen, url: `${personalUrl(base, token)}?next=/coach` }]] }, silent: true });
  return "coach_link";
}

/** /start and /help. In a group: the help line. In the private chat: a deep link's door, or the menu for the role, or the general start. */
export async function startCommand(db: Db, chat: TelegramChat, from: TgUser, cmd: { command: string; args: string }, isPrivate: boolean): Promise<string> {
  const { command, args } = cmd;
  const locale = chatLocale(chat);
  const s = strings(locale);
  const base = baseUrl();
  if (!isPrivate) {
    await sendMessage(chat.chatId, s.help, { silent: true });
    return "help";
  }
  // Deep links: t.me/bot?start=r_CODE asks for a result here; ?start=CODE shows a card; ?start=new explains /new;
  // ?start=coach_TICKET comes from the setup's "open your assistant" button and binds this account to the coach.
  const payload = args.trim();
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
    // One language, the coach's own, through the whole sequence: the confirmation with the way to the book, then the menu with its buttons, pinned.
    const ls = coachStrings(coachBotLocale(linked.locale));
    const token = await getOrCreatePersonalToken(db, linked.id);
    await sendMessage(chat.chatId, esc(ls.coachLinked), { keyboard: { inline_keyboard: [[{ text: ls.coachOpen, url: `${personalUrl(base, token)}?next=/coach` }]] }, silent: true });
    await sendRoleMenu(db, linked, chat.chatId, { pin: true });
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
  // A coach or a student gets their menu, not the general help; /start pins it, /help only repeats it.
  const menu = await sendRoleMenu(db, player, chat.chatId, { pin: command === "start" });
  const token = await getOrCreatePersonalToken(db, player.id);
  if (menu === "student_menu") {
    // A student still gets the link that signs their browser in for My matches.
    await sendMessage(chat.chatId, esc(s.privateStart(personalUrl(base, token))), { silent: true });
  }
  if (menu) return menu;
  // A plain player, or one whose coach or student days are over: the general start, and no role keyboard or commands left behind.
  await sendMessage(chat.chatId, `${esc(s.privateStart(personalUrl(base, token)))}\n\n${esc(s.privateHelp)}`, { keyboard: { remove_keyboard: true } });
  await deleteChatCommands(chat.chatId).catch(() => undefined);
  return "private_start";
}
