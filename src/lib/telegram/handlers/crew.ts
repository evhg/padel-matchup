import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
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
 * (DECIDING rule 31). The crew page's link, which only the crew's admins see, adds the bot to a group
 * they pick or make, with `/start crew_<ticket>`; that ties the group to the crew and records the
 * opt-in (`notice_version`). The bot starts reading only once it is an admin there and its notice is
 * pinned (`listening_since`). /quiet from a group admin, or the bot losing its admin rights or the
 * group, stops it.
 *
 * Telegram may deliver the bot's promotion (my_chat_member) before or after the /start, and a webhook
 * may handle both at once, so either one can be the moment it starts. Both claim the start in one
 * update first (`claimStart`): only the one that wins posts and pins.
 */

/** Bumped when the notice's words change, so a group's opt-in says which words it saw. 2: the example names the crew's own court (11 October 2026). */
export const CREW_NOTICE_VERSION = 2;

const ADMINS = new Set(["creator", "administrator"]);

/** May this person speak for the group? Its creator and its admins may; one call, made only for a crew link or /quiet. */
async function isGroupAdmin(chatId: number, userId: number): Promise<boolean> {
  const r = await getChatMember(chatId, userId);
  return r.ok && ADMINS.has(r.result.status);
}

/** An admin who may pin: without the pinned notice the bot reads nothing. */
export const mayPinNotice = (m: TgChatMember | null | undefined): m is TgChatMember => Boolean(m && m.status === "administrator" && m.can_pin_messages);

/** An admin who may make invite links. A link the bot made is a door it holds only while it keeps that right. */
const mayInvite = (m: TgChatMember | null | undefined): boolean => Boolean(m && m.status === "administrator" && m.can_invite_users);

/** The crew page's way into the group: a link the bot makes now, or null when Telegram refuses one. */
async function freshInvite(chatId: number, crewName: string): Promise<string | null> {
  const made = await createChatInviteLink(chatId, `Kicksmash · ${crewName}`);
  return made.ok ? made.result.invite_link : null;
}

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
    const notice = await sendMessage(chat.chatId, `${esc(s.crewNotice)}\n\n${esc(s.crewHow(chat.venueName))}`, { silent: true });
    if (!notice.ok) return giveBack();
    if (!(await pinChatMessage(chat.chatId, notice.result.message_id)).ok) {
      await deleteMessage(chat.chatId, notice.result.message_id);
      return giveBack();
    }
    noticeId = notice.result.message_id;
  }
  // The link goes with the right to invite: kept while the bot holds it (a supergroup carries a basic
  // group's link along), made when it has none, and dropped when the bot may not invite here.
  const invite = mayInvite(rights) ? (chat.inviteLink ?? (await freshInvite(chat.chatId, crewName))) : null;
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
  // A group that runs matches for one crew stays that crew's: another crew's link does not move it. A
  // group admin there types /quiet first, which ends the opt-in, and then any crew may tie it.
  if (chat.groupId && chat.groupId !== crew.id && chat.noticeVersion != null) {
    await say(s.crewOther);
    return "crew_other";
  }
  // The first group tied stays the crew's group (rule 31): while another group opted in for this crew,
  // a second one is not tied. /quiet there, or the bot's removal, frees the crew for a new group.
  if (await otherCrewGroup(db, crew.id, chat.chatId)) {
    await say(s.crewTaken);
    return "crew_taken";
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
 * Another group that opted in for this crew and still has the bot in it, or null. One read down
 * `telegram_chats_group_idx`; a crew has one such group at most, because a second is never tied.
 */
async function otherCrewGroup(db: Db, groupId: string, chatId: number): Promise<number | null> {
  const [row] = await db
    .select({ chatId: telegramChats.chatId })
    .from(telegramChats)
    .where(and(eq(telegramChats.groupId, groupId), ne(telegramChats.chatId, chatId), isNotNull(telegramChats.noticeVersion), isNull(telegramChats.leftAt)))
    .limit(1);
  return row?.chatId ?? null;
}

/**
 * The bot's own rights changed in a group it stays in (rule 31: it reads only as an admin that may pin
 * its notice). Promoted with the right to pin, in a group that opted in: it starts. No longer an
 * admin, or an admin that may no longer pin: it stops reading at once and keeps the opt-in and the
 * notice, so a group admin who gives the right back need not find the crew link, and the notice already
 * in the group is pinned again rather than posted again. The invite link follows the right to invite:
 * made when the right arrives while the bot reads, dropped when the right goes (the link stops being a
 * door the bot holds). Null when nothing changed for a crew.
 */
export async function crewRightsChanged(db: Db, chat: TelegramChat, member: TgChatMember): Promise<string | null> {
  const set: Partial<typeof telegramChats.$inferInsert> = {};
  if (chat.inviteLink && !mayInvite(member)) set.inviteLink = null;
  if (chat.listeningSince && !mayPinNotice(member)) set.listeningSince = null;
  if (Object.keys(set).length) await db.update(telegramChats).set(set).where(eq(telegramChats.chatId, chat.chatId));
  if ("listeningSince" in set) return member.status === "administrator" ? "crew_quiet:no_pin" : "crew_quiet:demoted";
  if (chat.listeningSince) {
    if (!chat.inviteLink && mayInvite(member) && chat.groupId) {
      const crew = await getGroupById(db, chat.groupId);
      const invite = crew ? await freshInvite(chat.chatId, crew.name) : null;
      if (invite) {
        await db.update(telegramChats).set({ inviteLink: invite }).where(eq(telegramChats.chatId, chat.chatId));
        return "crew_invite";
      }
    }
    return "inviteLink" in set ? "crew_invite_gone" : null;
  }
  if (chat.noticeVersion != null && chat.groupId && mayPinNotice(member)) {
    const crew = await getGroupById(db, chat.groupId);
    if (crew && (await startListening(db, { ...chat, ...set }, crew.name, member)) === "started") return "crew_listening";
  }
  return "inviteLink" in set ? "crew_invite_gone" : null;
}

/** The bot left the group, or was removed: nothing is read, the opt-in is gone, and the crew page stops offering the way in. */
export const crewLeft = { listeningSince: null, noticeVersion: null, noticeMessageId: null, inviteLink: null } as const;

/**
 * /quiet from an admin of the group: the bot stops acting on words, unpins its notice, and says so with
 * 👌. The crew page stops handing out the invite link (the group is no longer the crew's run group),
 * and the crew may tie another group. The bot stays an admin, so Telegram still sends it the group's
 * messages, which it does not act on; only taking its admin rights away, or removing it, stops that.
 * `asGroup`: an anonymous admin.
 */
export async function quietCommand(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, asGroup = false): Promise<string> {
  if (!GROUP_TYPES.has(chat.type) || (!chat.listeningSince && chat.noticeVersion == null)) return "ignored";
  if (!asGroup && !(await isGroupAdmin(chat.chatId, from.id))) {
    await setMessageReaction(chat.chatId, msg.message_id, REACTION.none);
    return "quiet_not_admin";
  }
  await db.update(telegramChats).set({ listeningSince: null, noticeVersion: null, noticeMessageId: null, inviteLink: null }).where(eq(telegramChats.chatId, chat.chatId));
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
