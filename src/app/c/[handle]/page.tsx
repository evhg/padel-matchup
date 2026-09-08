import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { StudentBooking } from "@/components/coach/StudentBooking";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { dayRange, labelsFor, slotDTOs, studentLessonDTO, todayIn } from "@/lib/coach/view";
import { activePackage, availableSlots, DAY_MS, getCoachByHandle, listStudentLessons, packageLine, STUDENT_HORIZON_DAYS, studentStatus } from "@/lib/domain/coaching";
import { localeAlternates } from "@/lib/seo";
import { getSessionPlayer } from "@/lib/session";
import { whatsappShareUrl } from "@/lib/share";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ handle: string }> };

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
export default async function CoachPublicPage({ params }: Props) {
  const { handle } = await params;
  const db = await getDb();
  const coach = await getCoachByHandle(db, handle.toLowerCase());
  if (!coach) notFound();
  const [t, locale, me] = await Promise.all([getTranslations("coach"), getLocale(), getSessionPlayer(db)]);
  const now = new Date();
  const status = me ? await studentStatus(db, coach.id, me.id) : "none";
  const today = todayIn(coach.tz, now);
  const to = new Date(now.getTime() + STUDENT_HORIZON_DAYS * DAY_MS);
  const [slots, lessons, pkg] = await Promise.all([
    status === "accepted" ? availableSlots(db, coach, now, to, now) : Promise.resolve([]),
    me ? listStudentLessons(db, me.id, new Date(now.getTime() - 2 * 3_600_000)) : Promise.resolve([]),
    me ? activePackage(db, coach.id, me.id, now) : Promise.resolve(null),
  ]);
  const mine = lessons.filter((l) => l.coachId === coach.id);
  const allDays = dayRange(today, STUDENT_HORIZON_DAYS + 1);
  const labels = labelsFor(allDays, locale, today, { today: t("today"), tomorrow: t("tomorrow") });
  const slotDtos = slotDTOs(slots, coach.tz, locale);
  const days = allDays.filter((d) => slotDtos.some((s) => s.day === d));
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
          slots={slotDtos}
          days={days}
          dayLabels={labels}
          lessons={mine.map((l) => studentLessonDTO(l, locale, labels, now))}
          pkg={pkg && line ? { left: line.left, size: pkg.size, days: line.daysLeft } : null}
          cutoffHours={coach.cutoffHours}
          whatsappUrl={coach.whatsapp ? whatsappShareUrl("", coach.whatsapp) : null}
        />
      </main>
      <Footer />
    </>
  );
}
