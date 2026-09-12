import type { Db } from "@/db";
import { baseUrl } from "@/lib/config";
import { decideClub, getClubByToken } from "@/lib/domain/clubs";
import { setAnswerPublished } from "@/lib/listen/answers";
import { approveItem, ownerTelegramId, skipItem } from "@/lib/listen/tick";
import { approveOutreach, skipOutreach } from "@/lib/outreach/desk";
import { answerCallbackQuery, editMessageText, esc, type TgUpdate } from "../api";

/** The owner's desk in their private chat: a listening draft, an outreach mail or a club claim, approved or skipped with one tap. */

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

/** The owner's taps, or null when the data is not one of them. */
export async function handleOwnerCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, data: string): Promise<string | null> {
  const listen = data.match(/^(la|ls|lu):([0-9a-f-]{36})$/);
  if (listen) return handleListenCallback(db, cb, listen[1] as "la" | "ls" | "lu", listen[2]);
  const mail = data.match(/^(oa|os):([0-9a-f-]{36})$/);
  if (mail) return handleOutreachCallback(db, cb, mail[1] as "oa" | "os", mail[2]);
  const club = data.match(/^(ca|cr):([A-Za-z0-9_-]{16,40})$/);
  if (club) return handleClubCallback(db, cb, club[1] as "ca" | "cr", club[2]);
  return null;
}
