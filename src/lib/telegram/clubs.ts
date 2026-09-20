import type { Db } from "@/db";
import type { Club, Player } from "@/db/schema";
import { platformById } from "@/lib/booking/platforms";
import { baseUrl } from "@/lib/config";
import { cityBySlug } from "@/lib/domain/cities";
import { claimEmailForCode, setClubNotifyMessage } from "@/lib/domain/clubs";
import { ownerTelegramId } from "@/lib/listen/tick";
import { editMessageText, esc, sendMessage, telegramEnabled } from "./api";

/**
 * A club claim reaches the owner as one Telegram message with Approve and Reject. The message
 * carries the check: who the claimant says they are, the contact they gave, and whether a code to
 * a work email at the club's own domain came back right. A confirmed work email makes the tap a
 * formality; a phone number or a public mailbox means the owner checks by hand first.
 */
const ROLE_WORD: Record<string, string> = { owner: "Owner", manager: "Manager", staff: "Staff", coach: "Coach" };
const hostOf = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};
/** The website as a button when it is a link Telegram accepts, so the hand-check is one tap. */
const websiteButton = (club: Pick<Club, "website">) => (club.website && /^https?:\/\//i.test(club.website) ? [{ text: "Website", url: club.website }] : []);

/** One line on the check, for the owner. */
export function claimCheckLine(club: Pick<Club, "claimRole" | "claimContact" | "claimVerifiedAt" | "website" | "bookingUrl" | "bookingPlatform">): string {
  if (!club.claimRole && !club.claimContact) return "👤 No role or contact given (claimed before the check existed): check by hand.";
  const who = [club.claimRole ? ROLE_WORD[club.claimRole] ?? club.claimRole : null, club.claimContact ? esc(club.claimContact) : null].filter(Boolean).join(" · ");
  const social = /(^|\.)(facebook\.com|fb\.com|instagram\.com)$/i.test(hostOf(club.website) ?? "");
  const proof = club.claimVerifiedAt ? "✅ work email at the club's domain confirmed" : claimEmailForCode(club) ? "✉️ code sent to the work email, not confirmed yet" : social ? "⚠️ not verifiable by mail: the website is a Facebook or Instagram page — open it (button below) and check by hand" : "⚠️ not verifiable by mail: check by hand (call the club, or its public page)";
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
        [{ text: "Open page", url: `${baseUrl()}/v/${club.slug}` }, ...websiteButton(club)],
      ],
    },
  });
  if (res.ok) await setClubNotifyMessage(db, club.slug, res.result.message_id);
  return res.ok;
}

/**
 * The code came back right and the page went live by itself. The first message is edited to say so
 * and loses its buttons (a stale Approve reads as a choice); a second message buzzes the owner and
 * carries Reject, one tap to take the page down. Both, by the owner's decision.
 */
export async function tellOwnerClaimLive(club: Club, email: string): Promise<void> {
  const owner = ownerTelegramId();
  if (!owner || !telegramEnabled()) return;
  const page = { text: "Open page", url: `${baseUrl()}/v/${club.slug}` };
  if (club.notifyMessageId) await editMessageText(owner, club.notifyMessageId, `✅ <b>Live by its work email</b> · ${esc(club.name)}${club.founding ? " · founding club" : ""}\n${esc(email)} is at the club's own domain.`, { inline_keyboard: [[page]] }).catch(() => undefined);
  const res = await sendMessage(owner, `✅ <b>Live by its work email</b> · ${esc(club.name)}${club.founding ? " · founding club" : ""}\n${esc(email)} is at the club's own domain, so the page went live without a tap. Reject takes it down.`, {
    keyboard: { inline_keyboard: [[{ text: "❌ Reject", callback_data: `cr:${club.manageToken}` }], [page]] },
  }).catch(() => null);
  void res;
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
