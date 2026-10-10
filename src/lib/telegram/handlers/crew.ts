import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { telegramChats, type TelegramChat } from "@/db/schema";
import { chatLocale } from "@/lib/channels/telegram";
import { crewAdminIds, getGroupById } from "@/lib/domain/groups";
import { bumpMetric } from "@/lib/domain/metrics";
import { createChatInviteLink, deleteMessage, esc, getChatMember, pinChatMessage, sendMessage, setMessageReaction, telegramBotId, unpinChatMessage, type TgChatMember, type TgMessage, type TgUser } from "../api";
import { strings } from "../card";
import { getChat, GROUP_TYPES } from "../chats";
import { crewPayloadGroup, verifyCrewPayload } from "../deepLinks";
import { REACTION } from "./words";

/**
 * A crew's own Telegram group, run by the bot as an admin: the owner's decision of 9 October 2026
 * (DECIDING rule 30). The crew page's link, which only the crew's admins see, adds the bot to a group
 * they pick or make, with `/start crew_<ticket>`; that ties the group to the crew and records the
 * opt-in (`notice_version`). The bot starts reading only once it is an admin there and its notice is
 * pinned (`listening_since`). /quiet from a group admin, or the bot losing its admin rights or the
 * group, stops it.
 *
 * Telegram may deliver the bot's promotion (my_chat_member) before or after the /start, and a webhook
 * may handle both at once, so either one can be the moment it starts. Both claim the start in one
 * update first (`claimStart`): only the one that wins posts and pins.
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
export const mayPinNotice = (m: TgChatMember | null | undefined): m is TgChatMember => Boolean(m && m.status === "administrator" && m.can_pin_messages);

type Start = "started" | "taken" | "failed";

/**
 * Claims the start in one update, before any message: of two updates handled at once, only one gets
 * the row back, and only that one posts and pins. A start that then fails gives the claim back.
 */
async function claimStart(db: Db, chatId: number): Promise<boolean> {
  const won = await db
    .update(telegramChats)
    .set({ listeningSince: new Date() })
    .where(and(eq(telegramChats.chatId, chatId), isNull(telegramChats.listeningSince), isNotNull(telegramChats.noticeVersion), isNull(telegramChats.leftAt)))
    .returning({ chatId: telegramChats.chatId });
  return won.length > 0;
}

/**
 * The notice, pinned, and the invite link for the crew page; then, and only then, the bot reads the
 * group. The pin is the condition: a group whose notice could not be pinned is tied to the crew and
 * opted in, and starts the moment the bot is given the right (my_chat_member says so). The notice is
 * posted once per opt-in: after a demotion the one already in the group is pinned again, and a notice
 * that could not be pinned is taken down again rather than left in the chat.
 */
async function startListening(db: Db, chat: TelegramChat, crewName: string, rights: TgChatMember): Promise<Start> {
  if (!(await claimStart(db, chat.chatId))) return "taken";
  const giveBack = async () => {
    await db.update(telegramChats).set({ listeningSince: null }).where(eq(telegramChats.chatId, chat.chatId));
    return "failed" as const;
  };
  let noticeId = chat.noticeMessageId && (await pinChatMessage(chat.chatId, chat.noticeMessageId)).ok ? chat.noticeMessageId : null;
  if (!noticeId) {
    const s = strings(chatLocale(chat));
    const notice = await sendMessage(chat.chatId, `${esc(s.crewNotice)}\n\n${esc(s.crewHow)}`, { silent: true });
    if (!notice.ok) return giveBack();
    if (!(await pinChatMessage(chat.chatId, notice.result.message_id)).ok) {
      await deleteMessage(chat.chatId, notice.result.message_id);
      return giveBack();
    }
    noticeId = notice.result.message_id;
  }
  let invite = chat.inviteLink;
  if (!invite && rights.can_invite_users) {
    const made = await createChatInviteLink(chat.chatId, `Kicksmash · ${crewName}`);
    invite = made.ok ? made.result.invite_link : null;
  }
  await db.update(telegramChats).set({ noticeVersion: CREW_NOTICE_VERSION, noticeMessageId: noticeId, inviteLink: invite }).where(eq(telegramChats.chatId, chat.chatId));
  await bumpMetric(db, "tg_groups_started").catch(() => undefined);
  return "started";
}

/**
 * `/start crew_<ticket>` in a group: the link from the crew page, tapped by whoever added the bot.
 * `asGroup`: an anonymous admin, who posts as the group itself and so is an admin of it.
 */
export async function crewStart(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, payload: string, asGroup = false): Promise<string> {
  const s = strings(chatLocale(chat));
  const say = (text: string) => sendMessage(chat.chatId, esc(text), { replyTo: msg.message_id, threadId: msg.message_thread_id ?? null, silent: true });
  if (!GROUP_TYPES.has(chat.type)) return "ignored";
  // The ticket names the crew and is signed for one of its admins: a forged or two-day-old payload, or
  // one whose admin is an admin no more, ties this group to nobody.
  const groupId = crewPayloadGroup(payload);
  const crew = groupId ? await getGroupById(db, groupId) : null;
  const admins = crew && !crew.archivedAt ? await crewAdminIds(db, crew.id) : [];
  if (!crew || !admins.some((id) => verifyCrewPayload(payload, id))) {
    await say(s.crewLinkBad);
    return "crew_link_bad";
  }
  // Consent is the group's, so an admin of the group gives it: a member holding a crew link cannot.
  if (!asGroup && !(await isGroupAdmin(chat.chatId, from.id))) {
    await say(s.crewAdminOnly);
    return "crew_not_admin";
  }
  const set = { groupId: crew.id, noticeVersion: CREW_NOTICE_VERSION, tz: chat.tz ?? crew.tz, venueName: chat.venueName ?? crew.venueName };
  await db.update(telegramChats).set(set).where(eq(telegramChats.chatId, chat.chatId));
  const bound: TelegramChat = { ...chat, ...set };
  if (chat.listeningSince) return "crew_bound";
  const botId = telegramBotId();
  const me = botId ? await getChatMember(chat.chatId, Number(botId)) : null;
  if (!me?.ok || !mayPinNotice(me.result)) {
    await say(s.crewNeedsAdmin);
    return "crew_needs_admin";
  }
  const started = await startListening(db, bound, crew.name, me.result);
  return started === "started" ? "crew_listening" : started === "taken" ? "crew_bound" : "crew_notice_failed";
}

/**
 * The bot's own rights changed in a group it stays in. Promoted with the right to pin, in a group that
 * opted in: it starts. No longer an admin: it stops reading at once and keeps the opt-in and the
 * notice, so a group admin who promotes it again need not find the crew link, and the notice already
 * in the group is pinned again rather than posted again. Null when nothing changed for a crew.
 */
export async function crewRightsChanged(db: Db, chat: TelegramChat, member: TgChatMember): Promise<string | null> {
  if (chat.listeningSince && member.status !== "administrator") {
    await db.update(telegramChats).set({ listeningSince: null }).where(eq(telegramChats.chatId, chat.chatId));
    return "crew_quiet:demoted";
  }
  if (!chat.listeningSince && chat.noticeVersion != null && chat.groupId && mayPinNotice(member)) {
    const crew = await getGroupById(db, chat.groupId);
    if (crew && (await startListening(db, chat, crew.name, member)) === "started") return "crew_listening";
  }
  return null;
}

/** The bot left the group, or was removed: nothing is read, the opt-in is gone, and the crew page stops offering the way in. */
export const crewLeft = { listeningSince: null, noticeVersion: null, noticeMessageId: null, inviteLink: null } as const;

/**
 * /quiet from an admin of the group: the bot stops acting on words, unpins its notice, and says so with
 * 👌. It stays an admin, so Telegram still sends it the group's messages, which it drops unread; only
 * taking its admin rights away, or removing it, stops that. `asGroup`: an anonymous admin.
 */
export async function quietCommand(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, asGroup = false): Promise<string> {
  if (!GROUP_TYPES.has(chat.type) || (!chat.listeningSince && chat.noticeVersion == null)) return "ignored";
  if (!asGroup && !(await isGroupAdmin(chat.chatId, from.id))) {
    await setMessageReaction(chat.chatId, msg.message_id, REACTION.none);
    return "quiet_not_admin";
  }
  await db.update(telegramChats).set({ listeningSince: null, noticeVersion: null, noticeMessageId: null }).where(eq(telegramChats.chatId, chat.chatId));
  if (chat.noticeMessageId) await unpinChatMessage(chat.chatId, chat.noticeMessageId);
  await setMessageReaction(chat.chatId, msg.message_id, REACTION.out);
  return "quiet";
}

/**
 * A basic group upgraded to a supergroup lives on under a new id. The crew, the opt-in and the invite
 * link move with it; the old id is left. The new id does not read until Telegram reports the bot an
 * admin there that may pin (`crewRightsChanged`), and then pins a fresh notice: message ids do not
 * survive the move.
 */
export async function migrateChat(db: Db, oldId: number, newId: number): Promise<string> {
  const old = await getChat(db, oldId);
  if (!old) return "ignored";
  const carried = { locale: old.locale, tz: old.tz, venueName: old.venueName, groupId: old.groupId, noticeVersion: old.noticeVersion, inviteLink: old.inviteLink };
  await db
    .insert(telegramChats)
    .values({ chatId: newId, type: "supergroup", title: old.title, ...carried })
    .onConflictDoUpdate({ target: telegramChats.chatId, set: { ...carried, leftAt: null } });
  await db.update(telegramChats).set({ leftAt: new Date(), ...crewLeft }).where(eq(telegramChats.chatId, oldId));
  return "migrated";
}
