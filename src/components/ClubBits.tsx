import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Club } from "@/db/schema";
import { platformById } from "@/lib/booking/platforms";
import { formatEventTime } from "@/lib/dates";
import { freeCourtHours } from "@/lib/domain/clubs";

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

export async function ClubBadges({ club }: { club: Pick<Club, "founding" | "courts"> }) {
  const t = await getTranslations();
  return (
    <div className="flex flex-wrap gap-2">
      <span className="chip-muted">✓ {t("club.managedBy")}</span>
      {club.founding && <span className="chip-muted">🌱 {t("club.foundingBadge")}</span>}
      {club.courts ? <span className="chip-muted">{t("club.courtsCount", { count: club.courts })}</span> : null}
    </div>
  );
}

/** Today's free courts from the club's own feed: a row of time chips, or one honest line. */
export async function FreeCourts({ club, now = new Date() }: { club: Pick<Club, "availability" | "availabilityUrl" | "availabilityKind" | "tz">; now?: Date }) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const a = club.availability;
  const configured = Boolean(club.availabilityUrl && club.availabilityKind);
  if (!configured) return <p className="text-sm text-muted">{t("club.freeUnknown")}</p>;
  if (!a || a.error) return <p className="text-sm text-muted">{t("club.freeError")}</p>;
  const slots = a.slots.filter((s) => new Date(s.end) > now);
  const hours = freeCourtHours(club, now) ?? 0;
  return (
    <div>
      {slots.length === 0 ? (
        <p className="text-sm text-muted">{t("club.freeNone")}</p>
      ) : (
        <>
          <p className="text-sm font-bold">{t("club.freeHours", { count: hours })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {slots.slice(0, 12).map((s) => (
              <span key={s.start} className="chip-muted tabular-nums">
                {formatEventTime(new Date(s.start), a.tz, locale)} · {t("club.freeSlot", { count: s.free })}
              </span>
            ))}
            {slots.length > 12 && <span className="chip-muted">…</span>}
          </div>
        </>
      )}
      <p className="mt-2 text-xs text-faint">{t("club.freeUpdated", { time: formatEventTime(new Date(a.fetchedAt), a.tz, locale) })}</p>
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
          {club.courts ? <span>{t("club.courtsCount", { count: club.courts })}</span> : null}
          {hours != null && <span className={hours > 0 ? "text-ok" : ""}>{hours > 0 ? t("club.freeHours", { count: hours }) : t("club.freeNone")}</span>}
        </div>
      </div>
      <BookingButton club={club} />
    </li>
  );
}
