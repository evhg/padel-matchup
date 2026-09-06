import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Thin Telegram Bot API client. No SDK: one fetch per call, HTML parse mode,
 * errors returned rather than thrown so callers can stay quiet on failure.
 * Tests stub globalThis.fetch.
 */
export const telegramEnabled = () => Boolean(process.env.TELEGRAM_BOT_TOKEN);
export const telegramBotUsername = () => process.env.TELEGRAM_BOT_USERNAME ?? null;
export const telegramWebhookSecret = () => process.env.TELEGRAM_WEBHOOK_SECRET ?? null;
const token = () => process.env.TELEGRAM_BOT_TOKEN ?? "";
/** The numeric bot id (the part of the token before the colon): the sign-in URL needs it, the token never leaves the server. */
export const telegramBotId = () => {
  const id = token().split(":")[0] ?? "";
  return /^\d+$/.test(id) ? id : null;
};

export type TgResult<T> = { ok: true; result: T } | { ok: false; error_code: number; description: string };
export type InlineKeyboard = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };
export type TgUser = { id: number; is_bot?: boolean; first_name: string; last_name?: string; username?: string; language_code?: string };
export type TgChat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string; username?: string };
export type TgMessage = { message_id: number; date: number; chat: TgChat; from?: TgUser; text?: string; message_thread_id?: number; reply_to_message?: TgMessage; entities?: { type: string; offset: number; length: number; url?: string }[] };
export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
  my_chat_member?: { chat: TgChat; from: TgUser; old_chat_member: { status: string }; new_chat_member: { status: string } };
};

export async function tg<T = unknown>(method: string, body: Record<string, unknown>): Promise<TgResult<T>> {
  if (!telegramEnabled()) return { ok: false, error_code: 0, description: "telegram disabled" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => null)) as TgResult<T> | null;
    if (!json) return { ok: false, error_code: res.status, description: `telegram ${method}: bad response` };
    return json;
  } catch (e) {
    return { ok: false, error_code: 0, description: e instanceof Error ? e.message : String(e) };
  }
}

/** Escape for parse_mode=HTML. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type SendOptions = { keyboard?: InlineKeyboard | null; replyTo?: number | null; threadId?: number | null; silent?: boolean };

export function sendMessage(chatId: number, text: string, o: SendOptions = {}) {
  return tg<TgMessage>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    disable_notification: o.silent ?? false,
    ...(o.keyboard ? { reply_markup: o.keyboard } : {}),
    ...(o.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
    ...(o.threadId ? { message_thread_id: o.threadId } : {}),
  });
}

export function editMessageText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard | null) {
  return tg<TgMessage | true>("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard ?? { inline_keyboard: [] },
  });
}

export function sendPhoto(chatId: number, photo: string, caption: string, o: SendOptions = {}) {
  return tg<TgMessage>("sendPhoto", {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: "HTML",
    ...(o.keyboard ? { reply_markup: o.keyboard } : {}),
    ...(o.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
    ...(o.threadId ? { message_thread_id: o.threadId } : {}),
  });
}

export function answerCallbackQuery(id: string, text?: string, o: { alert?: boolean; url?: string } = {}) {
  return tg<true>("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}), show_alert: o.alert ?? false, ...(o.url ? { url: o.url } : {}) });
}

export function setWebhook(url: string, secret: string) {
  return tg<true>("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query", "my_chat_member"], drop_pending_updates: true });
}

export const getWebhookInfo = () => tg<{ url: string; pending_update_count: number; last_error_message?: string }>("getWebhookInfo", {});

export function setMyCommands(commands: { command: string; description: string }[], languageCode?: string) {
  return tg<true>("setMyCommands", { commands, ...(languageCode ? { language_code: languageCode } : {}) });
}

// ---------------------------------------------------------------------------
// Sign-in checks. Login Widget: secret = sha256(bot token). Mini App initData:
// secret = HMAC_SHA256(key "WebAppData", bot token). Both sign the sorted
// key=value lines joined by "\n" and compare hex digests.
// ---------------------------------------------------------------------------
const safeEqualHex = (a: string, b: string) => {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
};
const checkString = (fields: Record<string, string>) =>
  Object.keys(fields)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");

export function verifyLoginWidget(fields: Record<string, string>, now = new Date(), maxAgeSec = 24 * 3600, botToken = token()): boolean {
  if (!botToken || !fields.hash || !fields.auth_date || !fields.id) return false;
  const age = now.getTime() / 1000 - Number(fields.auth_date);
  if (!Number.isFinite(age) || age < -300 || age > maxAgeSec) return false;
  const secret = createHash("sha256").update(botToken).digest();
  const mac = createHmac("sha256", secret).update(checkString(fields)).digest("hex");
  return safeEqualHex(mac, fields.hash);
}

/** Returns the parsed fields (with `user` still a JSON string) when the Mini App initData is authentic. */
export function verifyInitData(initData: string, now = new Date(), maxAgeSec = 24 * 3600, botToken = token()): Record<string, string> | null {
  if (!botToken || !initData) return null;
  const fields: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(initData)) fields[k] = v;
  if (!fields.hash || !fields.auth_date) return null;
  const age = now.getTime() / 1000 - Number(fields.auth_date);
  if (!Number.isFinite(age) || age < -300 || age > maxAgeSec) return null;
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const mac = createHmac("sha256", secret).update(checkString(fields)).digest("hex");
  return safeEqualHex(mac, fields.hash) ? fields : null;
}

/** The user inside verified initData, or null. */
export function initDataUser(fields: Record<string, string>): TgUser | null {
  try {
    const u = JSON.parse(fields.user ?? "null") as TgUser | null;
    return u && typeof u.id === "number" && typeof u.first_name === "string" ? u : null;
  } catch {
    return null;
  }
}
