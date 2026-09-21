import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { StudentBooking } from "@/components/coach/StudentBooking";
import { FeedbackInline } from "@/components/FeedbackInline";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { dayRange, labelsFor, slotDTOs, studentLessonDTO, todayIn, sameHoursEveryDay } from "@/lib/coach/view";
import { studentRequests, studentWaitlist, weekStartOf } from "@/lib/coach/chains";
import { whenLabel } from "@/lib/coach/strings";
import { acceptByInvite, activePackage, busyBetween, coachCity, DAY_MS, getCoachByHandle, getCoachForActor, inviteMatches, isFoundingCoach, listOffers, listStudentLessons, openingsBetween, openSlots, packageLine, STUDENT_HORIZON_DAYS, studentStatus , owedBy} from "@/lib/domain/coaching";
import { utcToZonedParts } from "@/lib/dates";
import { localeAlternates } from "@/lib/seo";
import { notifyStudentJoined } from "@/lib/coach/notify";
import { getSessionPlayer } from "@/lib/session";
import { whatsappShareUrl } from "@/lib/share";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ handle: string }>; searchParams: Promise<{ i?: string | string[] }> };

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
  const founding = isFoundingCoach(coach);
  const foundingCity = founding ? ((await coachCity(db, coach))?.name ?? null) : null;
  const [t, locale, me] = await Promise.all([getTranslations("coach"), getLocale(), getSessionPlayer(db)]);
  const now = new Date();
  // The coach, or one of their managers, opening their own student link: the page as students see it, never a form to join oneself.
  const own = me ? await getCoachForActor(db, me.id) : null;
  const owner = own?.coach.id === coach.id;
  // The coach's own link carries their invite code: whoever opens it is on the list, nobody asks and nobody approves.
  const invite = inviteMatches(coach, sp.i) ? coach.inviteCode : null;
  // "left" is a row that says this player took themselves off the list. To this page that is the same
  // as never having been on it: the door to ask again is what they should see.
  let status = me ? await studentStatus(db, coach.id, me.id) : "none";
  if (status === "left") status = "none";
  let justJoined = false;
  if (invite && me && !owner && status !== "accepted" && status !== "paused") {
    status = await acceptByInvite(db, coach.id, me.id);
    justJoined = status === "accepted";
    if (justJoined) await notifyStudentJoined(db, coach, me).catch(() => undefined);
  }
  const today = todayIn(coach.tz, now);
  const to = new Date(now.getTime() + STUDENT_HORIZON_DAYS * DAY_MS);
  const second = coach.secondMinutes && coach.secondMinutes !== coach.lessonMinutes ? coach.secondMinutes : null;
  const accepted = status === "accepted";
  // "Anyone can book": a visitor this coach has not accepted still needs the free hours, or the page
  // offers a booking block with no times in it. The hours only — the waitlist, the requests and what
  // somebody owes belong to a student who is already on the list.
  const canBook = accepted || (coach.openBooking && (status === "none" || status === "requested"));
  const [busy, lessons, pkg, waits, requests] = await Promise.all([
    canBook ? busyBetween(db, coach.id, now, to) : Promise.resolve([]),
    me ? listStudentLessons(db, me.id, new Date(now.getTime() - 2 * 3_600_000)) : Promise.resolve([]),
    me ? activePackage(db, coach.id, me.id, now) : Promise.resolve(null),
    accepted && me ? studentWaitlist(db, coach.id, me.id, now) : Promise.resolve([]),
    accepted && me ? studentRequests(db, coach.id, me.id, now) : Promise.resolve([]),
  ]);
  // Every slot inside the hours, minus the free ones: what a student can wait for.
  // Every hour the coach could teach, free or not: the template plus the dates they opened. Without
  // the openings an hour opened for one date would never show as taken, so nobody could wait for it.
  const openings = canBook ? await openingsBetween(db, coach.id, now, to) : [];
  const slots = canBook ? openSlots({ coach, from: now, to, busy, now, openings }) : [];
  // The second length, when the coach sells one: its own free times, because a 90-minute lesson
  // needs a 90-minute hole. Pure, from the same busy list: no second query.
  const slotsSecond = canBook && second ? openSlots({ coach, from: now, to, busy, now, openings, minutes: second }) : [];
  const everySlot = canBook ? openSlots({ coach, from: now, to, busy: [], now, openings }) : [];
  const freeIso = new Set(slots.map((d) => d.toISOString()));
  const takenSlots = everySlot.filter((d) => !freeIso.has(d.toISOString()));
  const mine = lessons.filter((l) => l.coachId === coach.id);
  const allDays = dayRange(today, STUDENT_HORIZON_DAYS + 1);
  const labels = labelsFor(allDays, locale, today, { today: t("today"), tomorrow: t("tomorrow") });
  const slotDtos = slotDTOs(slots, coach.tz, locale);
  const slotSecondDtos = slotDTOs(slotsSecond, coach.tz, locale);
  const takenDtos = slotDTOs(takenSlots, coach.tz, locale);
  const days = allDays.filter((d) => slotDtos.some((s) => s.day === d) || takenDtos.some((s) => s.day === d) || slotSecondDtos.some((s) => s.day === d));
  const weekOf = Object.fromEntries(days.map((d) => [d, weekStartOf(new Date(`${d}T12:00:00Z`), "UTC")]));
  const label = (at: Date) => whenLabel(at, coach.tz, locale);
  const offers = waits.filter((w) => w.status === "offered" && w.slotStartsAt && w.offerExpiresAt).map((w) => ({ id: w.id, label: label(w.slotStartsAt!), minutesLeft: Math.max(1, Math.round((w.offerExpiresAt!.getTime() - now.getTime()) / 60_000)) }));
  const waiting = waits.filter((w) => w.status === "waiting").map((w) => ({ id: w.id, label: w.slotStartsAt ? label(w.slotStartsAt) : w.weekStart ?? "", week: !w.slotStartsAt }));
  const asked = requests.map((r) => ({ id: r.id, label: label(r.startsAt) }));
  const minLocal = `${utcToZonedParts(now, coach.tz).date}T${utcToZonedParts(now, coach.tz).time}`;
  const line = pkg ? packageLine(pkg, now) : null;
  // What this student owes, and the ways this coach takes it. Sequential, after the rest (rule 8).
  const owed = accepted && me ? await owedBy(db, coach, me.id) : null;
  // The packages on offer: everybody sees the prices, and a student on the list can take one.
  const packageOffers = await listOffers(db, coach.id);
  const pay = { promptpay: Boolean(coach.promptpayId), link: coach.payLink || null, atClub: coach.payAtClub };
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
          {founding && <span className="chip-muted ml-2">🏅 {foundingCity ? t("page.founding", { city: foundingCity }) : t("page.foundingPlain")}</span>}
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{coach.displayName}</h1>
          <p className="mt-1 text-sm text-muted">
            {/* "at Warehaus" was a word. The club's page lists its coaches and its open matches, and nothing led there. */}
            {coach.clubNames.length > 0 && (
              <>
                {coach.clubSlugs.length === 1 ? (
                  <Link href={`/v/${coach.clubSlugs[0]}`} prefetch={false} className="link" data-testid="coach-club-link">
                    {t("page.at", { clubs: coach.clubNames.join(", ") })}
                  </Link>
                ) : (
                  t("page.at", { clubs: coach.clubNames.join(", ") })
                )}
                {" · "}
              </>
            )}
            {second ? t("page.lessonTwo", { a: coach.lessonMinutes, b: second }) : t("page.lesson", { minutes: coach.lessonMinutes })}
            {/* The setup asks what a lesson costs and then nothing showed it: a student learned the
                price only once they owed it. It is the first thing anyone wants to know. */}
            {coach.priceSingle ? ` · ${second || coach.priceTwo ? t("page.from", { amount: `${Math.min(...[coach.priceSingle, coach.priceTwo, coach.priceThree, coach.priceFour, coach.priceSecondSingle, coach.priceSecondTwo].filter((n): n is number => n != null && n > 0))} ${coach.currency}` }) : `${coach.priceSingle} ${coach.currency}`}` : ""}
          </p>
          {/* The week in one line, when every open day says the same thing. A student who opens the page
              after the last hour of the day is not offered today at all; this is what says why. */}
          {sameHoursEveryDay(coach.hours) && <p className="mt-1 text-sm text-muted">{t("page.teaches", { hours: sameHoursEveryDay(coach.hours)! })}</p>}
          {coach.bio && <p className="mt-2 text-sm">{coach.bio}</p>}
          {!coach.isPublic && status === "none" && !me && <p className="mt-2 text-xs text-faint">{t("page.private")}</p>}
        </section>
        {owner ? (
          <section className="card" data-testid="owner-note">
            <p className="text-sm text-muted">{t("page.ownerNote")}</p>
            <Link href="/coach" prefetch={false} className="btn-primary mt-3 w-full">
              {t("page.ownerOpen")}
            </Link>
          </section>
        ) : (
          <StudentBooking
            prices={{ single: coach.priceSingle, two: coach.priceTwo, three: coach.priceThree, four: coach.priceFour, currency: coach.currency, minutes: coach.lessonMinutes, second: second ? { minutes: second, single: coach.priceSecondSingle, two: coach.priceSecondTwo } : null, fee: coach.outsideHoursFee }}
            packages={packageOffers.map((o) => ({ id: o.id, size: o.size, minutes: o.minutes, heads: o.heads, price: o.price, validDays: o.validDays }))}
            slotsSecond={slotSecondDtos}
            handle={coach.handle}
            coachName={coach.displayName}
            signedIn={Boolean(me)}
            status={status}
            openBooking={coach.openBooking}
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
            pkg={pkg && line ? { left: line.left, size: pkg.size, days: line.daysLeft, heads: pkg.heads, minutes: pkg.minutes } : null}
            cutoffHours={coach.cutoffHours}
            owed={owed && owed.total > 0 ? { total: owed.total, currency: owed.currency, lessons: owed.lessons.map((l) => ({ id: l.id, label: label(l.startsAt), amount: l.amount, claimed: Boolean(l.claimedAt), hasSlip: l.hasSlip })), packages: owed.packages.map((p) => ({ id: p.id, size: p.size, amount: p.amount })) } : null}
            pay={pay}
            whatsappUrl={coach.whatsapp ? whatsappShareUrl("", coach.whatsapp) : null}
          />
        )}
        {/* Only to a visitor who is nobody here. A student mid-reschedule is not a lead. */}
        {!owner && status === "none" && (
          <p className="text-center text-xs text-faint">
            <Link href="/coaches/join?s=coachpage" prefetch={false} className="hover:text-muted" data-testid="own-book">
              {t("page.ownBook")}
            </Link>
          </p>
        )}
        <FeedbackInline variant="line" signedInVia={me?.telegramId ? "telegram" : "none"} />
      </main>
      <Footer />
    </>
  );
}
