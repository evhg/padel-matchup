import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { telegramChats, type TelegramChat } from "@/db/schema";
import { chatLocale } from "@/lib/channels/telegram";
import { getGroupById } from "@/lib/domain/groups";
import { bumpMetric } from "@/lib/domain/metrics";
import { createChatInviteLink, esc, getChatMember, pinChatMessage, sendMessage, setChatDescription, setMessageReaction, telegramBotId, unpinChatMessage, type TgChatMember, type TgMessage, type TgUser } from "../api";
import { strings } from "../card";
import { GROUP_TYPES } from "../chats";
import { readCrewPayload } from "../deepLinks";
import { REACTION } from "./words";

/**
 * A crew's own Telegram group, run by the bot as an admin: the owner's decision of 9 October 2026
 * (DECIDING rule 30). The crew page's link adds the bot to a group the person picks or makes, with
 * `/start crew_<ticket>`; that ties the group to the crew and records the opt-in (`notice_version`).
 * The bot starts reading only once it is an admin there and its notice is pinned (`listening_since`).
 * /quiet from a group admin, or the bot losing its admin rights or the group, stops it.
 *
 * Telegram may deliver the bot's promotion (my_chat_member) before or after the /start, so either one
 * can be the moment it starts, and both ask the same question: opted in, an admin who may pin, and
 * not yet reading.
 */

/** Bumped when the notice's words change, so a group's opt-in says which words it saw. */
export const CREW_NOTICE_VERSION = 1;

const ADMINS = new Set(["creator", "administrator"]);

/** May this person speak for the group? Its creator and its admins may; one call, made only for a crew link or /quiet. */
async function isGroupAdmin(chatId: number, userId: number): Promise<boolean> {
  const r = await getChatMember(chatId, userId);
  return r.ok && ADMINS.has(r.result.status);
}

/** An admin who may pin: without the pinned notice the bot reads nothing. */
const mayPin = (m: TgChatMember | null | undefined): m is TgChatMember => Boolean(m && m.status === "administrator" && m.can_pin_messages);

/**
 * The notice, pinned, in the description, and the invite link for the crew page; then, and only then,
 * the bot reads the group. The pin is the condition: a group whose notice could not be pinned is tied
 * to the crew and opted in, and starts the moment the bot is given the right (my_chat_member says so).
 */
async function startListening(db: Db, chat: TelegramChat, crewName: string, rights: TgChatMember): Promise<boolean> {
  const s = strings(chatLocale(chat));
  const notice = await sendMessage(chat.chatId, `${esc(s.crewNotice)}\n\n${esc(s.crewHow)}`, { silent: true });
  if (!notice.ok) return false;
  if (!(await pinChatMessage(chat.chatId, notice.result.message_id)).ok) return false;
  // One pinned notice, never a stack of them: the one from an earlier opt-in comes down.
  if (chat.noticeMessageId && chat.noticeMessageId !== notice.result.message_id) await unpinChatMessage(chat.chatId, chat.noticeMessageId);
  if (rights.can_change_info) await setChatDescription(chat.chatId, s.crewNotice);
  let invite = chat.inviteLink;
  if (!invite && rights.can_invite_users) {
    const made = await createChatInviteLink(chat.chatId, `Kicksmash · ${crewName}`);
    invite = made.ok ? made.result.invite_link : null;
  }
  await db.update(telegramChats).set({ listeningSince: new Date(), noticeVersion: CREW_NOTICE_VERSION, noticeMessageId: notice.result.message_id, inviteLink: invite }).where(eq(telegramChats.chatId, chat.chatId));
  await bumpMetric(db, "tg_groups_managed").catch(() => undefined);
  return true;
}

/** `/start crew_<ticket>` in a group: the link from the crew page, tapped by whoever added the bot. */
export async function crewStart(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, payload: string): Promise<string> {
  const s = strings(chatLocale(chat));
  const say = (text: string) => sendMessage(chat.chatId, esc(text), { replyTo: msg.message_id, threadId: msg.message_thread_id ?? null, silent: true });
  if (!GROUP_TYPES.has(chat.type)) return "ignored";
  // The ticket names the crew and is signed: a forged or two-day-old payload ties this group to nobody.
  const groupId = readCrewPayload(payload);
  const crew = groupId ? await getGroupById(db, groupId) : null;
  if (!crew || crew.archivedAt) {
    await say(s.crewLinkBad);
    return "crew_link_bad";
  }
  // Consent is the group's, so an admin of the group gives it: a member holding a crew link cannot.
  if (!(await isGroupAdmin(chat.chatId, from.id))) {
    await say(s.crewAdminOnly);
    return "crew_not_admin";
  }
  const set = { groupId: crew.id, noticeVersion: CREW_NOTICE_VERSION, tz: chat.tz ?? crew.tz, venueName: chat.venueName ?? crew.venueName };
  await db.update(telegramChats).set(set).where(eq(telegramChats.chatId, chat.chatId));
  const bound: TelegramChat = { ...chat, ...set };
  if (chat.listeningSince) return "crew_bound";
  const botId = telegramBotId();
  const me = botId ? await getChatMember(chat.chatId, Number(botId)) : null;
  if (!me?.ok || !mayPin(me.result)) {
    await say(s.crewNeedsAdmin);
    return "crew_needs_admin";
  }
  return (await startListening(db, bound, crew.name, me.result)) ? "crew_listening" : "crew_notice_failed";
}

/**
 * The bot's own rights changed in a group it stays in. Promoted with the right to pin, in a group that
 * opted in: it starts. No longer an admin: it stops reading at once and keeps the opt-in, so a group
 * admin who promotes it again need not find the crew link. Null when nothing changed for a crew.
 */
export async function crewRightsChanged(db: Db, chat: TelegramChat, member: TgChatMember): Promise<string | null> {
  if (chat.listeningSince && member.status !== "administrator") {
    await db.update(telegramChats).set({ listeningSince: null }).where(eq(telegramChats.chatId, chat.chatId));
    return "crew_quiet:demoted";
  }
  if (!chat.listeningSince && chat.noticeVersion != null && chat.groupId && mayPin(member)) {
    const crew = await getGroupById(db, chat.groupId);
    if (crew && (await startListening(db, chat, crew.name, member))) return "crew_listening";
  }
  return null;
}

/** The bot left the group, or was removed: nothing is read, the opt-in is gone, and the crew page stops offering the way in. */
export const crewLeft = { listeningSince: null, noticeVersion: null, noticeMessageId: null, inviteLink: null } as const;

/** /quiet from an admin of the group: the bot stops reading, unpins its notice, clears the description, and says so with 👌. */
export async function quietCommand(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser): Promise<string> {
  if (!GROUP_TYPES.has(chat.type) || (!chat.listeningSince && chat.noticeVersion == null)) return "ignored";
  if (!(await isGroupAdmin(chat.chatId, from.id))) {
    await setMessageReaction(chat.chatId, msg.message_id, REACTION.none);
    return "quiet_not_admin";
  }
  await db.update(telegramChats).set({ listeningSince: null, noticeVersion: null, noticeMessageId: null }).where(eq(telegramChats.chatId, chat.chatId));
  if (chat.noticeMessageId) await unpinChatMessage(chat.chatId, chat.noticeMessageId);
  await setChatDescription(chat.chatId, "");
  await setMessageReaction(chat.chatId, msg.message_id, REACTION.out);
  return "quiet";
}
