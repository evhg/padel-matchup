import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { StudentBooking } from "@/components/coach/StudentBooking";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { dayRange, labelsFor, slotDTOs, studentLessonDTO, todayIn } from "@/lib/coach/view";
import { studentRequests, studentWaitlist, weekStartOf } from "@/lib/coach/chains";
import { whenLabel } from "@/lib/coach/strings";
import { acceptByInvite, activePackage, availableSlots, DAY_MS, foundingRank, getCoachByHandle, inviteMatches, isFoundingCoach, listStudentLessons, openSlots, packageLine, STUDENT_HORIZON_DAYS, studentStatus } from "@/lib/domain/coaching";
import { CITIES } from "@/lib/domain/cities";
import { utcToZonedParts } from "@/lib/dates";
import { localeAlternates } from "@/lib/seo";
import { getSessionPlayer } from "@/lib/session";
import { whatsappShareUrl } from "@/lib/share";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ handle: string }>; searchParams: Promise<{ i?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const db = await getDb();
  const coach = await getCoachByHandle(db, handle.toLowerCase());
  const [t, locale] = await Promise.all([getTranslations("coach"), getLocale()]);
  if (!coach) return { title: t("page.coach"), robots: { index: false, follow: false } };
  const title = `${coach.displayName} · ${t("page.coach")}`;
  const description = [coach.clubNames.length ? t("page.at", { clubs: coach.clubNames.join(", ") }) : null, t("page.lesson", { minutes: coach.lessonMinutes })].filter(Boolean).join(" · ");
  return {
    title,
    description,
    alternates: localeAlternates(`/c/${coach.handle}`, locale),
    robots: coach.isPublic ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, type: "profile", url: `${baseUrl()}/c/${coach.handle}` },
  };
}

/** A coach's public page: who, where, and the booking that answers students while the coach is on court. */
export default async function CoachPublicPage({ params, searchParams }: Props) {
  const [{ handle }, sp] = await Promise.all([params, searchParams]);
  const db = await getDb();
  const coach = await getCoachByHandle(db, handle.toLowerCase());
  if (!coach) notFound();
  const foundingCity = isFoundingCoach(await foundingRank(db, coach)) ? (CITIES.find((c) => c.tz === coach.tz)?.name ?? null) : null;
  const [t, locale, me] = await Promise.all([getTranslations("coach"), getLocale(), getSessionPlayer(db)]);
  const now = new Date();
  // The coach's own link carries their invite code: whoever opens it is on the list, nobody asks and nobody approves.
  const invite = inviteMatches(coach, sp.i) ? coach.inviteCode : null;
  let status = me ? await studentStatus(db, coach.id, me.id) : "none";
  let justJoined = false;
  if (invite && me && status !== "accepted" && status !== "paused") {
    status = await acceptByInvite(db, coach.id, me.id);
    justJoined = status === "accepted";
  }
  const today = todayIn(coach.tz, now);
  const to = new Date(now.getTime() + STUDENT_HORIZON_DAYS * DAY_MS);
  const accepted = status === "accepted";
  const [slots, lessons, pkg, waits, requests] = await Promise.all([
    accepted ? availableSlots(db, coach, now, to, now) : Promise.resolve([]),
    me ? listStudentLessons(db, me.id, new Date(now.getTime() - 2 * 3_600_000)) : Promise.resolve([]),
    me ? activePackage(db, coach.id, me.id, now) : Promise.resolve(null),
    accepted && me ? studentWaitlist(db, coach.id, me.id, now) : Promise.resolve([]),
    accepted && me ? studentRequests(db, coach.id, me.id, now) : Promise.resolve([]),
  ]);
  // Every slot inside the hours, minus the free ones: what a student can wait for.
  const everySlot = accepted ? openSlots({ coach, from: now, to, busy: [], now }) : [];
  const freeIso = new Set(slots.map((d) => d.toISOString()));
  const takenSlots = everySlot.filter((d) => !freeIso.has(d.toISOString()));
  const mine = lessons.filter((l) => l.coachId === coach.id);
  const allDays = dayRange(today, STUDENT_HORIZON_DAYS + 1);
  const labels = labelsFor(allDays, locale, today, { today: t("today"), tomorrow: t("tomorrow") });
  const slotDtos = slotDTOs(slots, coach.tz, locale);
  const takenDtos = slotDTOs(takenSlots, coach.tz, locale);
  const days = allDays.filter((d) => slotDtos.some((s) => s.day === d) || takenDtos.some((s) => s.day === d));
  const weekOf = Object.fromEntries(days.map((d) => [d, weekStartOf(new Date(`${d}T12:00:00Z`), "UTC")]));
  const label = (at: Date) => whenLabel(at, coach.tz, locale);
  const offers = waits.filter((w) => w.status === "offered" && w.slotStartsAt && w.offerExpiresAt).map((w) => ({ id: w.id, label: label(w.slotStartsAt!), minutesLeft: Math.max(1, Math.round((w.offerExpiresAt!.getTime() - now.getTime()) / 60_000)) }));
  const waiting = waits.filter((w) => w.status === "waiting").map((w) => ({ id: w.id, label: w.slotStartsAt ? label(w.slotStartsAt) : w.weekStart ?? "", week: !w.slotStartsAt }));
  const asked = requests.map((r) => ({ id: r.id, label: label(r.startsAt) }));
  const minLocal = `${utcToZonedParts(now, coach.tz).date}T${utcToZonedParts(now, coach.tz).time}`;
  const line = pkg ? packageLine(pkg, now) : null;
  const url = `${baseUrl()}/c/${coach.handle}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: coach.displayName,
    jobTitle: t("page.coach"),
    url,
    knowsLanguage: coach.languages,
    ...(coach.clubNames.length ? { worksFor: coach.clubNames.map((name) => ({ "@type": "SportsActivityLocation", name })) } : {}),
    makesOffer: { "@type": "Offer", url, itemOffered: { "@type": "Service", name: t("page.lesson", { minutes: coach.lessonMinutes }), serviceType: "Padel coaching", provider: { "@type": "Person", name: coach.displayName }, ...(coach.clubNames.length ? { areaServed: coach.clubNames } : {}) } },
  };

  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        {coach.isPublic && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />}
        <section className="card">
          <span className="chip-muted">🎾 {t("page.coach")}</span>
          {foundingCity && <span className="chip-muted ml-2">🏅 {t("page.founding", { city: foundingCity })}</span>}
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{coach.displayName}</h1>
          <p className="mt-1 text-sm text-muted">
            {coach.clubNames.length ? `${t("page.at", { clubs: coach.clubNames.join(", ") })} · ` : ""}
            {t("page.lesson", { minutes: coach.lessonMinutes })}
          </p>
          {coach.bio && <p className="mt-2 text-sm">{coach.bio}</p>}
          {!coach.isPublic && status === "none" && !me && <p className="mt-2 text-xs text-faint">{t("page.private")}</p>}
        </section>
        <StudentBooking
          handle={coach.handle}
          coachName={coach.displayName}
          signedIn={Boolean(me)}
          status={status}
          invite={invite}
          justJoined={justJoined}
          slots={slotDtos}
          taken={takenDtos}
          days={days}
          dayLabels={labels}
          weekOf={weekOf}
          waits={waiting}
          offers={offers}
          requests={asked}
          minLocal={minLocal}
          lessons={mine.map((l) => studentLessonDTO(l, locale, labels, now))}
          pkg={pkg && line ? { left: line.left, size: pkg.size, days: line.daysLeft } : null}
          cutoffHours={coach.cutoffHours}
          whatsappUrl={coach.whatsapp ? whatsappShareUrl("", coach.whatsapp) : null}
        />
        <p className="text-center text-xs text-faint">
          <Link href="/coaches?s=coachpage" prefetch={false} className="hover:text-muted" data-testid="own-book">
            {t("page.ownBook")}
          </Link>
        </p>
      </main>
      <Footer />
    </>
  );
}
