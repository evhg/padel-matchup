import type { Db } from "@/db";
import type { Club, Player } from "@/db/schema";
import { platformById } from "@/lib/booking/platforms";
import { baseUrl } from "@/lib/config";
import { cityBySlug } from "@/lib/domain/cities";
import { setClubNotifyMessage } from "@/lib/domain/clubs";
import { ownerTelegramId } from "@/lib/listen/tick";
import { esc, sendMessage, telegramEnabled } from "./api";

/**
 * A club claim reaches the owner as one Telegram message with Approve and
 * Reject. The tap is the whole review: it guards against a stranger putting
 * a wrong booking link on a club's page, nothing more.
 */
export function clubClaimMessage(club: Club, claimant: Player): string {
  const platform = platformById(club.bookingPlatform)?.name;
  const lines = [
    `<b>Club claim</b> · ${esc(club.name)}`,
    club.city ? `📍 ${esc(cityBySlug(club.city)?.name ?? club.city)}${club.tz ? ` · ${esc(club.tz)}` : ""}` : club.tz ? `🕒 ${esc(club.tz)}` : null,
    `By ${esc(claimant.displayName)}${claimant.telegramUsername ? ` (@${esc(claimant.telegramUsername)})` : ""}${claimant.email ? ` · ${esc(claimant.email)}` : ""}`,
    club.website ? `🌐 ${esc(club.website)}` : null,
    club.bookingUrl ? `🎟 ${esc(club.bookingUrl)}${platform ? ` (${esc(platform)})` : ""}` : null,
    club.courts ? `🎾 ${club.courts} courts` : null,
    club.about ? `\n${esc(club.about)}` : null,
    "",
    "Approve makes the page live (and founding while the city has places). Reject keeps the page as it was.",
  ];
  return lines.filter((l): l is string => l != null).join("\n");
}

export async function askOwnerAboutClub(db: Db, club: Club, claimant: Player): Promise<boolean> {
  const owner = ownerTelegramId();
  if (!owner || !telegramEnabled()) return false;
  const res = await sendMessage(owner, clubClaimMessage(club, claimant), {
    keyboard: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `ca:${club.manageToken}` },
          { text: "❌ Reject", callback_data: `cr:${club.manageToken}` },
        ],
        [{ text: "Open page", url: `${baseUrl()}/v/${club.slug}` }],
      ],
    },
  });
  if (res.ok) await setClubNotifyMessage(db, club.slug, res.result.message_id);
  return res.ok;
}
