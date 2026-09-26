import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { emailEnabled } from "@/lib/config";
import { playerHasPush } from "@/lib/domain/push";
import { pushEnabled } from "@/lib/push";
import { telegramEnabled } from "@/lib/telegram/api";
import { whatsappNotices } from "@/lib/whatsapp/templates";

/**
 * Whether the assistant can reach this coach at all, channel by channel.
 *
 * `channelFor` in ./notify.ts answers a narrower question — which channel a notice should take — and
 * it says "push" whenever push is configured, whether or not this person has a device. That is right
 * for a notice, which fails quietly. It is wrong for a gate, which has to know the truth, so this one
 * asks the database whether a device is actually registered.
 *
 * A coach with none of the three has a book nobody can hear: Ricardo took two lessons and was never
 * told about either. What is required is a way to be reached, not any particular one — an email is
 * still optional for anybody who picks Telegram or push instead.
 */
export type Reach = { telegram: boolean; email: boolean; push: boolean; any: boolean };

export async function reachFor(db: Db, player: Pick<Player, "id" | "telegramId" | "email">): Promise<Reach> {
  const telegram = telegramEnabled() && Boolean(player.telegramId);
  // An address alone, not the activity switch: a lesson's calendar mail goes out either way, which is
  // the convention `tell` already follows. A coach who muted activity mail is still reachable.
  const email = emailEnabled() && Boolean(player.email);
  const push = pushEnabled() ? await playerHasPush(db, player.id) : false;
  return { telegram, email, push, any: telegram || email || push };
}

/**
 * Which channels this deployment can offer at all. A channel with no environment is never shown (rule 4).
 * WhatsApp counts only while its templates may be sent: `WHATSAPP_TEMPLATES_PER_DAY=0` takes it out.
 */
export const channelsOffered = (): { telegram: boolean; whatsapp: boolean; email: boolean; push: boolean } => ({ telegram: telegramEnabled(), whatsapp: whatsappNotices(), email: emailEnabled(), push: pushEnabled() });
