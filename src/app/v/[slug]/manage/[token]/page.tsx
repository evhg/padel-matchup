import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FreeCourts } from "@/components/ClubBits";
import { ClubManageForm } from "@/components/ClubManageForm";
import { ClubWeekEditor } from "@/components/ClubWeekEditor";
import { CLUB_WEEK, clubDay, listClubSlots, upcomingBySlot } from "@/lib/domain/clubWeek";
import { formatEventTime } from "@/lib/dates";
import { rangeChip } from "@/lib/levelText";
import { calendarTitle } from "@/lib/calendar";
import { getLocale } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { CITIES } from "@/lib/domain/cities";
import { clubStatus, getClubByToken } from "@/lib/domain/clubs";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string; token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations();
  return { title: t("club.manageTitle", { club: slug }), robots: { index: false, follow: false } };
}

/** The club's private page: status of the claim, every field, the feed, free courts as players will see them. */
export default async function ClubManagePage({ params }: Props) {
  const { slug, token } = await params;
  const db = await getDb();
  const club = await getClubByToken(db, token);
  if (!club || club.slug !== slug) notFound();
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const status = clubStatus(club);
  const now = new Date();
  // The day as staff need it, and the week as the club set it. Sequential reads (rule 8).
  const day = await clubDay(db, club, now);
  const slots = await listClubSlots(db, club.slug);
  const nextBySlot = await upcomingBySlot(db, club.slug, now);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🏟 {t("club.eyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("club.manageTitle", { club: club.name })}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className={`chip-muted ${status === "live" ? "text-ok" : status === "rejected" ? "text-warn" : ""}`}>{status === "live" ? `✓ ${t("club.statusLive")}` : status === "rejected" ? t("club.statusRejected") : `⏳ ${t("club.statusPending")}`}</span>
            {club.founding && <span className="chip-muted">🌱 {t("club.foundingBadge")}</span>}
            <Link href={`/v/${club.slug}`} prefetch={false} className="link text-sm">
              {t("club.openPage")} →
            </Link>
          </div>
          {status === "rejected" && <p className="mt-2 text-sm text-muted">{t("club.statusRejectedHelp")}</p>}
          {status === "pending" && <p className="mt-2 text-sm text-muted">{t("club.claimedHelp")}</p>}
        </section>
        <ClubManageForm
          token={token}
          cities={CITIES.map((c) => ({ slug: c.slug, name: c.name }))}
          initial={{
            website: club.website ?? "",
            bookingUrl: club.bookingUrl ?? "",
            mapUrl: club.mapUrl ?? "",
            courts: club.courts ? String(club.courts) : "",
            about: club.about ?? "",
            city: club.city ?? "",
            opensAt: club.opensAt ?? "",
            closesAt: club.closesAt ?? "",
            availabilityUrl: club.availabilityUrl ?? "",
            availabilityKind: club.availabilityKind ?? "ics_bookings",
          }}
        />
        <section className="card" data-testid="club-day">
          <h2 className="text-lg font-extrabold">{t("club.week.todayTitle", { club: club.name })}</h2>
          {day.events.length === 0 ? (
            <p className="mt-1 text-sm text-muted">{t("club.week.todayEmpty")}</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {day.events.map(({ event: ev, occupied, spotsLeft, names, waiting }) => {
                const level = rangeChip(t, { min: ev.levelMin, max: ev.levelMax });
                return (
                  <li key={ev.id} className="rounded-2xl border border-line bg-white px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-extrabold tabular-nums">{formatEventTime(ev.startsAt, ev.tz, locale)}</span>
                      <Link href={`/${ev.code}`} prefetch={false} className="truncate font-bold hover:underline">
                        {calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament"))}
                      </Link>
                      {level && <span className="chip-muted">{level}</span>}
                      <span className={`ml-auto shrink-0 text-sm font-bold tabular-nums ${spotsLeft > 0 ? "text-ok" : "text-warn"}`}>
                        {occupied}/{ev.capacity}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      {names.length ? names.join(", ") : t("club.week.nobodyYet")}
                      {waiting > 0 ? ` · ${t("club.week.waiting", { count: waiting })}` : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          <Link href={`/v/${club.slug}`} prefetch={false} className="mt-3 block text-sm link">
            {t("club.week.seePublic")}
          </Link>
        </section>
        <ClubWeekEditor
          token={token}
          leadDays={CLUB_WEEK.leadDaysDefault}
          slots={slots.map((s) => {
            const next = nextBySlot.get(s.id);
            return { id: s.id, dow: s.dow, time: s.time, type: s.type, format: s.format, capacity: s.capacity, levelMin: s.levelMin, levelMax: s.levelMax, title: s.title, active: s.active, leadDays: s.leadDays, next: next ? { code: next.code, startsAt: next.startsAt.toISOString() } : null };
          })}
        />
        <section className="card">
          <h2 className="text-lg font-extrabold">{t("club.freeToday")}</h2>
          <div className="mt-2">
            <FreeCourts club={club} />
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
