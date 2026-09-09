import "server-only";
import type { Player } from "@/db/schema";
import { emailEnabled } from "@/lib/config";
import { sendEmail } from "@/lib/email/send";
import { layout } from "@/lib/email/templates";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";
import type { WrapNote } from "./wrap";

/** The wrap reaches the person on the channels they have: email when there is an address, Telegram when linked. Quiet on both. */
export async function deliverWrap(p: Player, n: WrapNote): Promise<void> {
  if (emailEnabled() && p.email) {
    const { html, text } = layout({ heading: n.heading, body: n.body, cta: { label: n.open, url: n.url }, footer: n.footer, eventUrl: n.url, openLabel: n.open });
    await sendEmail({ to: p.email, subject: n.subject, html, text }).catch(() => undefined);
  }
  if (telegramEnabled() && p.telegramId) {
    await sendMessage(p.telegramId, `<b>${esc(n.heading)}</b>\n${esc(n.body)}`, { silent: true, keyboard: { inline_keyboard: [[{ text: n.open, url: n.url }]] } }).catch(() => undefined);
  }
}
