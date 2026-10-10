import Link from "next/link";
import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import type { Club } from "@/db/schema";
import { platformById } from "@/lib/booking/platforms";
import { freeCourtsState, isScraped, todaySlots } from "@/lib/booking/availability";
import { formatEventTime } from "@/lib/dates";
import { isClubLive, freeCourtHours } from "@/lib/domain/clubs";

/** Small server pieces shared by the club page, the city pages and the clubs index. */

export async function BookingButton({ club, size = "sm" }: { club: Pick<Club, "bookingUrl" | "bookingPlatform">; size?: "sm" | "md" }) {
  if (!club.bookingUrl) return null;
  const t = await getTranslations();
  const platform = platformById(club.bookingPlatform);
  return (
    <a href={club.bookingUrl} target="_blank" rel="noopener noreferrer" className={size === "md" ? "btn-primary" : "btn-ghost btn-sm"}>
      🎟 {platform ? t("club.bookOn", { platform: platform.name }) : t("club.book")}
    </a>
  );
}

export async function ClubBadges({ club }: { club: Pick<Club, "founding" | "courts" | "courtsIndoor" | "courtsOutdoor"> }) {
  const t = await getTranslations();
  // The split shows only when the club said: "4 courts · 3 indoor · 1 outdoor". A zero is said too.
  const split = [club.courtsIndoor !== null ? t("club.courtsIndoorCount", { count: club.courtsIndoor }) : null, club.courtsOutdoor !== null ? t("club.courtsOutdoorCount", { count: club.courtsOutdoor }) : null].filter(Boolean);
  return (
    <div className="flex flex-wrap gap-2">
      <span className="chip-muted">✓ {t("club.managedBy")}</span>
      {club.founding && <span className="chip-muted">🌱 {t("club.foundingBadge")}</span>}
      {club.courts ? <span className="chip-muted">{[t("club.courtsCount", { count: club.courts }), ...split].join(" · ")}</span> : null}
    </div>
  );
}

/**
 * Today's free courts: a row of time chips, or one honest line. From the club's own feed when it shares
 * one, else from a recent read of its booking platform's public page, and then the line under the chips
 * names the platform, because the club did not publish those times (DECIDING rule 32). A read that
 * failed or grew old says the platform's times are not available just now, never that the club must
 * share its calendar (`freeCourtsState`).
 */
export async function FreeCourts({ club, now = new Date(), whenUnconfigured }: { club: Pick<Club, "availability" | "availabilityUrl" | "availabilityKind" | "tz">; now?: Date; /** What to show while the club shares no feed; the manage page puts the way to share it here. */ whenUnconfigured?: ReactNode }) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const state = freeCourtsState(club, now);
  if (state.kind === "none") return <>{whenUnconfigured ?? <p className="text-sm text-muted">{t("club.freeUnknown")}</p>}</>;
  if (state.kind === "platformDown")
    return (
      <>
        <p className="text-sm text-muted">{t("club.freePlatformDown", { platform: state.platform })}</p>
        {whenUnconfigured}
      </>
    );
  const a = state.a;
  if (!a || a.error) return <p className="text-sm text-muted">{t("club.freeError")}</p>;
  const slots = todaySlots(a, now);
  const hours = freeCourtHours({ availability: a }, now) ?? 0;
  const updated = formatEventTime(new Date(a.fetchedAt), a.tz, locale);
  return (
    <div>
      {slots.length === 0 ? (
        <p className="text-sm text-muted">{t("club.freeNone")}</p>
      ) : (
        <>
          <p className="text-sm font-bold">{t("club.freeHours", { count: hours })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {slots.slice(0, 12).map((s) => (
              // A read from a platform keeps pieces of any length, so its chip says when the piece ends too.
              <span key={`${s.start}|${s.end}`} className="chip-muted tabular-nums">
                {formatEventTime(new Date(s.start), a.tz, locale)}
                {isScraped(a) ? `–${formatEventTime(new Date(s.end), a.tz, locale)}` : ""} · {t("club.freeSlot", { count: s.free })}
              </span>
            ))}
            {slots.length > 12 && <span className="chip-muted">…</span>}
          </div>
        </>
      )}
      <p className="mt-2 text-xs text-faint" data-testid="free-source">
        {state.kind === "platform" ? t("club.freeFromPlatform", { platform: state.platform, time: updated }) : t("club.freeUpdated", { time: updated })}
      </p>
    </div>
  );
}

/** One club in a list: name, badges, booking button, free court-hours. */
export async function ClubRow({ club, now = new Date() }: { club: Club; now?: Date }) {
  const t = await getTranslations();
  const hours = freeCourtHours(club, now);
  return (
    <li className="flex items-center gap-3 rounded-2xl border border-line px-4 py-3">
      <div className="min-w-0 flex-1">
        <Link href={`/v/${club.slug}`} prefetch={false} className="block truncate font-bold hover:underline">
          {club.name}
        </Link>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
          {club.founding && <span>🌱 {t("club.foundingBadge")}</span>}
          {/* A club nobody has claimed is shown, and says so. The reader is told who stands behind it. */}
          {!isClubLive(club) && <span className="text-faint">{t("club.notClaimed")}</span>}
          {club.province && !club.city && <span>📍 {club.province}</span>}
          {club.courts ? <span>{t("club.courtsCount", { count: club.courts })}</span> : null}
          {hours != null && <span className={hours > 0 ? "text-ok" : ""}>{hours > 0 ? t("club.freeHours", { count: hours }) : t("club.freeNone")}</span>}
        </div>
      </div>
      <BookingButton club={club} />
    </li>
  );
}
