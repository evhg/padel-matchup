import type { Db } from "@/db";
import type { Club, Player } from "@/db/schema";
import { platformById } from "@/lib/booking/platforms";
import { baseUrl } from "@/lib/config";
import { cityBySlug } from "@/lib/domain/cities";
import { claimEmailForCode, setClubNotifyMessage } from "@/lib/domain/clubs";
import { ownerTelegramId } from "@/lib/listen/tick";
import { esc, sendMessage, telegramEnabled } from "./api";

/**
 * A club claim reaches the owner as one Telegram message with Approve and Reject. The message
 * carries the check: who the claimant says they are, the contact they gave, and whether a code to
 * a work email at the club's own domain came back right. A confirmed work email makes the tap a
 * formality; a phone number or a public mailbox means the owner checks by hand first.
 */
const ROLE_WORD: Record<string, string> = { owner: "Owner", manager: "Manager", staff: "Staff", coach: "Coach" };

/** One line on the check, for the owner. */
export function claimCheckLine(club: Pick<Club, "claimRole" | "claimContact" | "claimVerifiedAt" | "website" | "bookingUrl" | "bookingPlatform">): string {
  if (!club.claimRole && !club.claimContact) return "👤 No role or contact given (claimed before the check existed): check by hand.";
  const who = [club.claimRole ? ROLE_WORD[club.claimRole] ?? club.claimRole : null, club.claimContact ? esc(club.claimContact) : null].filter(Boolean).join(" · ");
  const proof = club.claimVerifiedAt ? "✅ work email at the club's domain confirmed" : claimEmailForCode(club) ? "✉️ code sent to the work email, not confirmed yet" : "⚠️ not verifiable by mail: check by hand (call the club, or its public page)";
  return `👤 ${who}\n${proof}`;
}

export function clubClaimMessage(club: Club, claimant: Player): string {
  const platform = platformById(club.bookingPlatform)?.name;
  const lines = [
    `<b>Club claim</b> · ${esc(club.name)}`,
    club.city ? `📍 ${esc(cityBySlug(club.city)?.name ?? club.city)}${club.tz ? ` · ${esc(club.tz)}` : ""}` : club.tz ? `🕒 ${esc(club.tz)}` : null,
    `By ${esc(claimant.displayName)}${claimant.telegramUsername ? ` (@${esc(claimant.telegramUsername)})` : ""}${claimant.email ? ` · ${esc(claimant.email)}` : ""}`,
    claimCheckLine(club),
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

/** The code came back right after the first message went out: one more line for the owner. */
export async function tellOwnerClaimVerified(club: Club, email: string): Promise<void> {
  const owner = ownerTelegramId();
  if (!owner || !telegramEnabled()) return;
  await sendMessage(owner, `✅ <b>Work email confirmed</b> · ${esc(club.name)}\n${esc(email)} is at the club's own domain. Approve on the claim message above.`).catch(() => undefined);
}

/** What the claimant hears when the owner decides, in their language. */
export function claimDecisionText(locale: string | null | undefined, club: Pick<Club, "name" | "slug" | "manageToken">, approved: boolean): string {
  const base = baseUrl();
  const page = `${base}/v/${club.slug}`;
  const manage = `${base}/v/${club.slug}/manage/${club.manageToken}`;
  const l = locale === "ru" ? "ru" : locale === "es" ? "es" : "en";
  if (approved) {
    return l === "ru"
      ? `${club.name} теперь на Kicksmash\nСтраница клуба в эфире: ${page}\nУправление: ${manage}`
      : l === "es"
        ? `${club.name} ya está en Kicksmash\nLa página del club está publicada: ${page}\nGestión: ${manage}`
        : `${club.name} is live on Kicksmash\nThe club page is up: ${page}\nManage it: ${manage}`;
  }
  return l === "ru"
    ? `${club.name}: заявка не одобрена\nМы не смогли подтвердить, что вы работаете в клубе. Если это ошибка, напишите нам в GitHub Discussions.`
    : l === "es"
      ? `${club.name}: solicitud no aprobada\nNo pudimos confirmar que trabajas en el club. Si es un error, escríbenos en GitHub Discussions.`
      : `${club.name}: the claim was not approved\nWe could not confirm that you work at the club. If that is wrong, write to us in GitHub Discussions.`;
}
