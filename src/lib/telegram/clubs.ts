import type { Db } from "@/db";
import type { Club, Player } from "@/db/schema";
import { platformById } from "@/lib/booking/platforms";
import { baseUrl } from "@/lib/config";
import { cityBySlug } from "@/lib/domain/cities";
import { type ClaimReason, claimEmailForCode, setClubNotifyMessage } from "@/lib/domain/clubs";
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


/**
 * The refusal reasons as one letter each, because `callback_data` stops at 64 bytes and the manage
 * token already spends forty of them.
 */
export const REASON_CODE: Record<ClaimReason, string> = { unconfirmed: "u", taken: "t", not_a_club: "n", duplicate: "d" };
export const reasonOfCode = (c: string): ClaimReason | null => (Object.entries(REASON_CODE).find(([, v]) => v === c)?.[0] as ClaimReason | undefined) ?? null;

/** A club a player listed is live already; the owner's only tap is to take it down. */
const isListing = (club: Pick<Club, "source">) => club.source === "player";

const rejectRow = (token: string, keys: ClaimReason[], label: Record<ClaimReason, string>) => keys.map((k) => ({ text: label[k], callback_data: `cr:${token}:${REASON_CODE[k]}` }));
const REJECT_LABEL: Record<ClaimReason, string> = { unconfirmed: "❌ Not confirmed", taken: "❌ Someone else runs it", not_a_club: "❌ Not a club", duplicate: "❌ Duplicate" };

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

/** A player put a club on the map. It is listed already, so the message asks only whether it is real. */
export function clubListingMessage(club: Club, addedBy: Player): string {
  const split = [club.courtsIndoor != null ? `${club.courtsIndoor} indoor` : null, club.courtsOutdoor != null ? `${club.courtsOutdoor} outdoor` : null].filter(Boolean).join(" · ");
  return [
    `<b>Club listed by a player</b> · ${esc(club.name)}`,
    [club.province, club.country].filter(Boolean).map((v) => esc(String(v))).join(", ") || null,
    `By ${esc(addedBy.displayName)}${addedBy.telegramUsername ? ` (@${esc(addedBy.telegramUsername)})` : ""}`,
    club.courts ? `🎾 ${club.courts} courts${split ? ` (${esc(split)})` : ""}` : null,
    club.website ? `🌐 ${esc(club.website)}` : null,
    "",
    "The page is up already and says no club runs it. Tap only if it should not be there.",
  ]
    .filter((l): l is string => l != null)
    .join("\n");
}

export async function askOwnerAboutClub(db: Db, club: Club, claimant: Player): Promise<boolean> {
  const owner = ownerTelegramId();
  if (!owner || !telegramEnabled()) return false;
  const page = [{ text: "Open page", url: `${baseUrl()}/v/${club.slug}` }, ...websiteButton(club)];
  // Each refusal is its own button, so the reason is stored by the same tap that refuses. Before
  // this, one Reject stored the hour and nothing else, and the claimant heard one sentence that
  // fitted every case.
  const keyboard = isListing(club)
    ? { inline_keyboard: [rejectRow(club.manageToken, ["not_a_club", "duplicate"], REJECT_LABEL), page] }
    : {
        inline_keyboard: [
          [{ text: "✅ Approve", callback_data: `ca:${club.manageToken}` }],
          rejectRow(club.manageToken, ["unconfirmed", "taken"], REJECT_LABEL),
          rejectRow(club.manageToken, ["not_a_club", "duplicate"], REJECT_LABEL),
          page,
        ],
      };
  const res = await sendMessage(owner, isListing(club) ? clubListingMessage(club, claimant) : clubClaimMessage(club, claimant), { keyboard });
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
export function claimDecisionText(locale: string | null | undefined, club: Pick<Club, "name" | "slug" | "manageToken"> & Partial<Pick<Club, "source">>, approved: boolean, reason?: ClaimReason | null): string {
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
  // A club manager has no GitHub account and no reason to make one. The note that reaches the owner
  // is one tap away on the site, so the message points there. Each reason says a different thing to
  // do next, which is why the owner's tap now stores which one it was.
  const say = `${base}/feedback?s=clubclaim`;
  // A listing that comes down is not a claim that was refused: the person listed a club for other
  // people, and never asked to run the page.
  const listed = "source" in club && (club as { source?: string }).source === "player";
  const head = listed
    ? l === "ru"
      ? `${club.name}: страница снята`
      : l === "es"
        ? `${club.name}: la página se ha retirado`
        : `${club.name}: the page was taken down`
    : l === "ru"
      ? `${club.name}: заявка не одобрена`
      : l === "es"
        ? `${club.name}: solicitud no aprobada`
        : `${club.name}: the claim was not approved`;
  const again = l === "ru" ? `Если это ошибка, напишите нам, и мы посмотрим ещё раз: ${say}` : l === "es" ? `Si nos equivocamos, dínoslo y lo miraremos otra vez: ${say}` : `If we got that wrong, tell us and we will look at it again: ${say}`;
  const why: Record<ClaimReason, Record<"en" | "ru" | "es", string>> = {
    unconfirmed: {
      en: "We could not confirm that you work at this club. A work email at the club's own domain confirms it in one step.",
      ru: "Мы не смогли подтвердить, что вы работаете в этом клубе. Рабочая почта на домене клуба подтверждает это сразу.",
      es: "No pudimos confirmar que trabajas en este club. Un correo de trabajo en el dominio del club lo confirma al momento.",
    },
    taken: {
      en: "Somebody at the club already runs this page.",
      ru: "Страницей уже управляет кто-то из клуба.",
      es: "Alguien del club ya gestiona esta página.",
    },
    not_a_club: {
      en: "We could not find a padel club by this name.",
      ru: "Мы не нашли падел-клуб с таким названием.",
      es: "No encontramos un club de pádel con este nombre.",
    },
    duplicate: {
      en: "This club already has a page on Kicksmash under another name.",
      ru: "У этого клуба уже есть страница на Kicksmash под другим названием.",
      es: "Este club ya tiene una página en Kicksmash con otro nombre.",
    },
  };
  const line = why[reason && (reason as string) in why ? (reason as ClaimReason) : "unconfirmed"][l];
  return `${head}\n${line}\n${again}`;
}
